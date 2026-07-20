// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Key Encryption Key (KEK) provider — wraps/unwraps per-row DEKs.
 *
 * See ADR-017 (Destination Config uses KMS-backed Envelope Encryption).
 *
 * Architectural contract (cloud-agnostic core)
 * -------------------------------------------
 * This file defines the abstract `KekProvider` interface and the
 * cloud-agnostic `LocalKekProvider` (dev/test). Cloud-specific providers live
 * in sibling files and are imported here only by the factory:
 *
 *   - `./gcp-kms-kek-provider.ts`  → GCP Cloud KMS (optional dep: @google-cloud/kms)
 *   - `./aws-kms-kek-provider.ts`  → AWS KMS (future; optional dep: @aws-sdk/client-kms)
 *   - `./azure-keyvault-kek-provider.ts` → Azure Key Vault (future; optional dep: @azure/keyvault-keys)
 *
 * The core application depends *only* on this file. It never touches cloud
 * SDKs directly — that keeps a deployment targeting AWS from pulling in GCP
 * libraries, and vice versa. See `KekProviderConfig` for the config surface
 * that flows in from env / Terraform / IaC.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { logger } from '@/utils/logger';

import { CircuitBreakerKekProvider } from './kek-circuit-breaker';
import { GcpKmsKekProvider as GcpKmsKekProviderImpl } from './gcp-kms-kek-provider';

const log = logger.child({ component: 'broadcast-kek' });

// ─── Interface ───────────────────────────────────────────────────────────

/**
 * A KEK provider wraps 32-byte DEKs with a managed KEK and unwraps them later.
 *
 * Invariants:
 *   - `wrap(dek)` output is opaque to callers; includes any metadata the
 *      provider needs to unwrap (version, IV, auth tag, etc.).
 *   - `unwrap(wrapped)` returns exactly 32 bytes.
 *   - `resource` is a stable identifier for the specific KEK version used
 *      to wrap; used for audit logging + future rotation.
 */
export interface KekProvider {
  /** Opaque identifier of the KEK version (e.g., GCP CryptoKeyVersion name). */
  readonly resource: string;

  /** Encrypt a 32-byte DEK with the KEK. */
  wrap(dek: Buffer): Promise<Buffer>;

  /** Decrypt a previously-wrapped DEK. */
  unwrap(wrappedDek: Buffer): Promise<Buffer>;
}

// ─── Config surface (cloud-agnostic; consumed by the factory) ────────────

/**
 * Discriminated union of KEK backend configurations.
 *
 * This is the contract between the runtime and IaC (Terraform). Each variant
 * names the minimal set of inputs the runtime must receive in order to bind
 * to a cloud-managed KEK:
 *
 *   - `backend`     — the discriminator that picks the implementation
 *   - `keyResource` — the cloud-managed KEK identifier (opaque to the core)
 *
 * Cloud-specific fields (region, project, vault URL) are *only* present on
 * the relevant variant; they never leak into the core's call sites.
 *
 * Terraform responsibility:
 *   - provision the KEK resource in the target cloud (IaC module)
 *   - write the resulting identifier into the deployment's env/secret store
 *     under the abstract names below
 *
 * Runtime responsibility:
 *   - parse env into `KekProviderConfig` via `parseKekConfigFromEnv()`
 *   - call `resolveKekProviderFromConfig(config)` to get a provider instance
 *   - never touch cloud SDK symbols directly
 */
export type KekProviderConfig =
  | {
      readonly backend: 'local';
      /** Base64-encoded master secret (>= 32 bytes after decoding). */
      readonly masterSecretB64: string;
      /** Optional stable identifier (defaults to `local://env:BROADCAST_LOCAL_KEK_B64`). */
      readonly resourceId?: string;
    }
  | {
      readonly backend: 'gcp-kms';
      /** Full GCP KMS CryptoKey resource name. */
      readonly keyResource: string;
    }
  | {
      readonly backend: 'aws-kms';
      /** AWS KMS key ARN or alias (e.g., arn:aws:kms:us-east-1:…:key/…). */
      readonly keyResource: string;
      /** Optional AWS region override (falls back to SDK default-chain). */
      readonly region?: string;
    }
  | {
      readonly backend: 'azure-keyvault';
      /** Vault DNS name (e.g., https://my-vault.vault.azure.net). */
      readonly vaultUrl: string;
      /** Key name inside the vault. */
      readonly keyName: string;
      /** Optional key version (falls back to the vault's latest). */
      readonly keyVersion?: string;
    };

/** All known backends, in `KekProviderConfig['backend']` form. */
export const KEK_BACKENDS = ['local', 'gcp-kms', 'aws-kms', 'azure-keyvault'] as const;
export type KekBackend = (typeof KEK_BACKENDS)[number];

// ─── Local implementation (dev / test) ───────────────────────────────────

/**
 * LocalKekProvider derives a stable AES-256 KEK from a master secret using
 * HKDF-SHA256, then wraps DEKs with AES-256-GCM.
 *
 * Wire format of a wrapped DEK:
 *   [0]     version byte (0x01)
 *   [1..12] IV (12 bytes)
 *   [13..28] auth tag (16 bytes)
 *   [29..]  ciphertext (exactly 32 bytes for a DEK)
 *
 * NOT suitable for production: the master secret lives in env; losing it =
 * losing all configs. For production use a cloud-managed KEK (GCP / AWS /
 * Azure) via the factory.
 */
export class LocalKekProvider implements KekProvider {
  private static readonly VERSION = 0x01;
  private static readonly IV_LEN = 12;
  private static readonly TAG_LEN = 16;
  private static readonly HKDF_INFO = Buffer.from('broadcast-destination-kek-v1', 'utf8');

  private readonly kek: Buffer;

  constructor(masterSecret: Buffer, public readonly resource: string) {
    if (masterSecret.length < 32) {
      throw new Error(
        `LocalKekProvider master secret must be >= 32 bytes (got ${masterSecret.length})`,
      );
    }
    // Derive a 32-byte KEK via HKDF. Salt is empty (the master secret is already
    // a random high-entropy value in practice; HKDF info tag binds domain).
    const derived = hkdfSync('sha256', masterSecret, Buffer.alloc(0), LocalKekProvider.HKDF_INFO, 32);
    this.kek = Buffer.from(derived);
  }

  async wrap(dek: Buffer): Promise<Buffer> {
    if (dek.length !== 32) {
      throw new Error(`DEK must be 32 bytes, got ${dek.length}`);
    }
    const iv = randomBytes(LocalKekProvider.IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([LocalKekProvider.VERSION]), iv, authTag, ciphertext]);
  }

  async unwrap(wrappedDek: Buffer): Promise<Buffer> {
    if (wrappedDek.length < 1 + LocalKekProvider.IV_LEN + LocalKekProvider.TAG_LEN + 32) {
      throw new Error('wrapped DEK too short');
    }
    const version = wrappedDek[0];
    if (version !== LocalKekProvider.VERSION) {
      throw new Error(`Unsupported LocalKek wrap version: ${version}`);
    }
    const iv = wrappedDek.subarray(1, 1 + LocalKekProvider.IV_LEN);
    const authTag = wrappedDek.subarray(1 + LocalKekProvider.IV_LEN, 1 + LocalKekProvider.IV_LEN + LocalKekProvider.TAG_LEN);
    const ciphertext = wrappedDek.subarray(1 + LocalKekProvider.IV_LEN + LocalKekProvider.TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', this.kek, iv);
    decipher.setAuthTag(authTag);
    const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (dek.length !== 32) {
      throw new Error(`Unwrapped DEK has wrong length: ${dek.length}`);
    }
    return dek;
  }
}

// ─── Cloud backend re-exports ────────────────────────────────────────────
//
// The concrete cloud providers live in sibling modules. Re-exporting here
// keeps the barrel (`./index.ts`) stable for external callers while the core
// stays cloud-SDK-free.

export { GcpKmsKekProvider } from './gcp-kms-kek-provider';

// Placeholders — uncomment as each cloud backend lands:
// export { AwsKmsKekProvider } from './aws-kms-kek-provider';
// export { AzureKeyVaultKekProvider } from './azure-keyvault-kek-provider';

// ─── Factory (config-driven) ─────────────────────────────────────────────

/**
 * Build a KEK provider from an explicit config object.
 *
 * This is the single entry point the rest of the application calls — the
 * discriminator `config.backend` picks the implementation, and each branch
 * only loads its cloud SDK when that branch fires.
 *
 * The returned provider is wrapped in `CircuitBreakerKekProvider` unless the
 * caller opts out (see `resolveKekProvider` for env-driven opt-out).
 *
 * @throws if a cloud backend is named but the cloud's optional SDK is absent.
 *         The error is raised by the provider itself (lazy via dynamic import)
 *         on first `wrap`/`unwrap`, with a message telling the operator what
 *         to install or switch.
 */
export function resolveKekProviderFromConfig(config: KekProviderConfig): KekProvider {
  switch (config.backend) {
    case 'local': {
      const secret = Buffer.from(config.masterSecretB64, 'base64');
      return new LocalKekProvider(
        secret,
        config.resourceId ?? 'local://env:BROADCAST_LOCAL_KEK_B64',
      );
    }

    case 'gcp-kms': {
      // The static import of `GcpKmsKekProviderImpl` at the top of this file
      // is safe in non-GCP deployments: the GCP adapter module itself has NO
      // top-level dependency on `@google-cloud/kms`. The package is loaded
      // via a typed dynamic import inside the provider's `getClient()` and
      // only fires when `wrap()` / `unwrap()` are first invoked. See
      // `./gcp-kms-kek-provider.ts` for the Option-B loader contract.
      return new GcpKmsKekProviderImpl(config.keyResource);
    }

    case 'aws-kms': {
      throw new Error(
        "BROADCAST_KEK_PROVIDER='aws-kms' is not yet implemented in this build. " +
          'A future release will ship `AwsKmsKekProvider` with `@aws-sdk/client-kms` ' +
          'as an optional dependency, mirroring the GCP adapter. ' +
          'Track the multi-cloud roadmap item before enabling.',
      );
    }

    case 'azure-keyvault': {
      throw new Error(
        "BROADCAST_KEK_PROVIDER='azure-keyvault' is not yet implemented in this build. " +
          'A future release will ship `AzureKeyVaultKekProvider` with ' +
          '`@azure/keyvault-keys` as an optional dependency.',
      );
    }

    default: {
      // Exhaustiveness guard — if a new backend is added to the union but
      // this switch isn't updated, tsc will flag the `never` assignment.
      const _exhaustive: never = config;
      void _exhaustive;
      throw new Error(
        `resolveKekProviderFromConfig: unknown backend in config (${JSON.stringify(config)})`,
      );
    }
  }
}

// ─── Env-driven entry point (backward-compat shim) ───────────────────────

/**
 * Parse env vars into a `KekProviderConfig`.
 *
 * Selection (controlled by `BROADCAST_KEK_PROVIDER`):
 *   - `"local"`            → local + BROADCAST_LOCAL_KEK_B64
 *   - `"gcp-kms"`          → gcp-kms + BROADCAST_KMS_KEK_RESOURCE
 *   - `"aws-kms"`          → aws-kms + BROADCAST_KMS_KEK_RESOURCE [+ BROADCAST_KMS_REGION]
 *   - `"azure-keyvault"`   → azure-keyvault + BROADCAST_KV_VAULT_URL + BROADCAST_KV_KEY_NAME
 *                             [+ BROADCAST_KV_KEY_VERSION]
 *   - unset in non-prod    → local (dev convenience)
 *   - unset in prod        → throws (no silent fallback)
 */
export function parseKekConfigFromEnv(env: NodeJS.ProcessEnv = process.env): KekProviderConfig {
  const selected = (env.BROADCAST_KEK_PROVIDER ?? '').toLowerCase();
  const isProduction = env.NODE_ENV === 'production';

  switch (selected) {
    case 'gcp-kms': {
      const keyResource = env.BROADCAST_KMS_KEK_RESOURCE;
      if (!keyResource) {
        throw new Error(
          "BROADCAST_KEK_PROVIDER='gcp-kms' requires BROADCAST_KMS_KEK_RESOURCE " +
            '(full CryptoKey resource name).',
        );
      }
      return { backend: 'gcp-kms', keyResource };
    }

    case 'aws-kms': {
      const keyResource = env.BROADCAST_KMS_KEK_RESOURCE;
      if (!keyResource) {
        throw new Error(
          "BROADCAST_KEK_PROVIDER='aws-kms' requires BROADCAST_KMS_KEK_RESOURCE " +
            '(KMS key ARN or alias).',
        );
      }
      return { backend: 'aws-kms', keyResource, region: env.BROADCAST_KMS_REGION };
    }

    case 'azure-keyvault': {
      const vaultUrl = env.BROADCAST_KV_VAULT_URL;
      const keyName = env.BROADCAST_KV_KEY_NAME;
      if (!vaultUrl || !keyName) {
        throw new Error(
          "BROADCAST_KEK_PROVIDER='azure-keyvault' requires both BROADCAST_KV_VAULT_URL " +
            'and BROADCAST_KV_KEY_NAME.',
        );
      }
      return {
        backend: 'azure-keyvault',
        vaultUrl,
        keyName,
        keyVersion: env.BROADCAST_KV_KEY_VERSION,
      };
    }

    case 'local':
    case '': {
      if (selected === '' && isProduction) {
        throw new Error(
          'BROADCAST_KEK_PROVIDER is unset in a production environment. Explicit ' +
            'configuration is required in production (no implicit local backend).',
        );
      }
      const masterSecretB64 = env.BROADCAST_LOCAL_KEK_B64;
      if (!masterSecretB64) {
        throw new Error(
          'LocalKekProvider requires BROADCAST_LOCAL_KEK_B64 (>= 32 base64-encoded bytes).',
        );
      }
      return { backend: 'local', masterSecretB64 };
    }

    default: {
      throw new Error(
        `Unknown BROADCAST_KEK_PROVIDER="${selected}" (NODE_ENV=${env.NODE_ENV ?? 'unset'}). ` +
          `Expected one of: ${KEK_BACKENDS.join(', ')}.`,
      );
    }
  }
}

/**
 * Resolve a KEK provider from environment variables (convenience wrapper).
 *
 * Parses env → `KekProviderConfig` via `parseKekConfigFromEnv`, then delegates
 * to `resolveKekProviderFromConfig`. The chosen provider is wrapped in
 * `CircuitBreakerKekProvider` so a KMS outage fast-fails `unwrap()` instead
 * of blocking the poller on every delivery's decrypt timeout.
 *
 * Opt out of the breaker with `BROADCAST_KEK_BREAKER_DISABLED="true"`
 * (intended for the test suite, NOT production — wrapping is free on the
 * success path and pays for itself after the first outage).
 */
export function resolveKekProvider(env: NodeJS.ProcessEnv = process.env): KekProvider {
  const config = parseKekConfigFromEnv(env);
  const inner = resolveKekProviderFromConfig(config);
  if (env.BROADCAST_KEK_BREAKER_DISABLED === 'true') {
    log.debug({ backend: config.backend }, 'KEK circuit breaker disabled by env');
    return inner;
  }
  return new CircuitBreakerKekProvider(inner);
}
