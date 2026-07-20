// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * KEK provider factory — multi-cloud resolution tests.
 *
 * Exercises the three pieces that make ADR-017's cloud-agnostic contract work:
 *
 *   1. `resolveKekProviderFromConfig(config)` — dispatches on the discriminator
 *      `config.backend` to the right provider class. The local branch works
 *      without any cloud SDK installed; the gcp-kms branch wraps `GcpKmsKekProvider`
 *      whose KMS client is lazy (constructor doesn't load the optional dep).
 *      The aws-kms / azure-keyvault branches throw a clear "not yet implemented"
 *      message so ops teams discover the seam when they wire the env var.
 *
 *   2. `parseKekConfigFromEnv(env)` — takes a `NODE_ENV`/-style process env bag
 *      and returns the discriminated-union config. Covers: each backend's
 *      required vars, missing-var failures, prod safety (no implicit local).
 *
 *   3. `resolveKekProvider(env)` — end-to-end wrapper that composes 2 + 1 and
 *      decorates with `CircuitBreakerKekProvider` unless the breaker-disable
 *      escape hatch is set.
 *
 *   4. `GcpKmsKekProvider` error surface — when `@google-cloud/kms` is not
 *      installed, the first wrap/unwrap MUST throw an operator-readable error,
 *      NOT the raw `ERR_MODULE_NOT_FOUND`. This is the whole point of Option B
 *      (optional-dep + friendly boundary). We exercise the `__testing` hook to
 *      stub module resolution independent of whether the package is really on
 *      disk, so this test is robust across CI environments.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  LocalKekProvider,
  resolveKekProviderFromConfig,
  parseKekConfigFromEnv,
  resolveKekProvider,
  type KekProviderConfig,
} from '../kek-provider';
import { CircuitBreakerKekProvider } from '../kek-circuit-breaker';
import { GcpKmsKekProvider, __testing as kmsSeam } from '../gcp-kms-kek-provider';

// ─── Shared fixtures ─────────────────────────────────────────────────────

/** 32+ bytes of pseudo-entropy encoded once; reused across tests. */
const MASTER_SECRET_B64 = Buffer.alloc(48, 0x7a).toString('base64');

/** A full KMS CryptoKey resource — parsed structurally, never called. */
const GCP_KEY_RESOURCE =
  'projects/demo-proj/locations/global/keyRings/demo-ring/cryptoKeys/demo-key';

// ─── resolveKekProviderFromConfig ────────────────────────────────────────

describe('resolveKekProviderFromConfig', () => {
  it('returns a LocalKekProvider for backend=local and preserves the resource id', () => {
    const cfg: KekProviderConfig = {
      backend: 'local',
      masterSecretB64: MASTER_SECRET_B64,
      resourceId: 'local://test',
    };
    const provider = resolveKekProviderFromConfig(cfg);
    expect(provider).toBeInstanceOf(LocalKekProvider);
    expect(provider.resource).toBe('local://test');
  });

  it('falls back to a default resource id when none is supplied', () => {
    const cfg: KekProviderConfig = {
      backend: 'local',
      masterSecretB64: MASTER_SECRET_B64,
    };
    const provider = resolveKekProviderFromConfig(cfg);
    expect(provider.resource).toBe('local://env:BROADCAST_LOCAL_KEK_B64');
  });

  it('returns a GcpKmsKekProvider for backend=gcp-kms without loading the SDK eagerly', () => {
    // The GcpKmsKekProvider constructor validates the resource-name shape
    // but does NOT touch `@google-cloud/kms`. This is critical: in non-GCP
    // deployments where the optional dep is absent, merely constructing the
    // adapter must not crash the process — only calls to wrap/unwrap do.
    const cfg: KekProviderConfig = {
      backend: 'gcp-kms',
      keyResource: GCP_KEY_RESOURCE,
    };
    const provider = resolveKekProviderFromConfig(cfg);
    expect(provider).toBeInstanceOf(GcpKmsKekProvider);
    expect(provider.resource).toBe(GCP_KEY_RESOURCE);
  });

  it('rejects a malformed GCP resource at construction time', () => {
    expect(() =>
      resolveKekProviderFromConfig({
        backend: 'gcp-kms',
        keyResource: 'not-a-kms-resource',
      }),
    ).toThrow(/invalid KEK resource.*projects\//);
  });

  it('throws a clear "not yet implemented" for backend=aws-kms', () => {
    expect(() =>
      resolveKekProviderFromConfig({
        backend: 'aws-kms',
        keyResource: 'arn:aws:kms:us-east-1:000000000000:key/demo',
      }),
    ).toThrow(/aws-kms.*not yet implemented/i);
  });

  it('throws a clear "not yet implemented" for backend=azure-keyvault', () => {
    expect(() =>
      resolveKekProviderFromConfig({
        backend: 'azure-keyvault',
        vaultUrl: 'https://demo.vault.azure.net',
        keyName: 'demo-key',
      }),
    ).toThrow(/azure-keyvault.*not yet implemented/i);
  });
});

// ─── parseKekConfigFromEnv ───────────────────────────────────────────────

describe('parseKekConfigFromEnv', () => {
  it('defaults to local when BROADCAST_KEK_PROVIDER is unset in non-prod', () => {
    const cfg = parseKekConfigFromEnv({
      NODE_ENV: 'development',
      BROADCAST_LOCAL_KEK_B64: MASTER_SECRET_B64,
    });
    expect(cfg.backend).toBe('local');
    if (cfg.backend === 'local') {
      expect(cfg.masterSecretB64).toBe(MASTER_SECRET_B64);
    }
  });

  it('refuses to implicitly fall back to local in production', () => {
    expect(() =>
      parseKekConfigFromEnv({
        NODE_ENV: 'production',
        BROADCAST_LOCAL_KEK_B64: MASTER_SECRET_B64,
      }),
    ).toThrow(/unset.*production.*explicit configuration/i);
  });

  it('requires BROADCAST_LOCAL_KEK_B64 for the explicit local backend', () => {
    expect(() =>
      parseKekConfigFromEnv({
        NODE_ENV: 'development',
        BROADCAST_KEK_PROVIDER: 'local',
      }),
    ).toThrow(/BROADCAST_LOCAL_KEK_B64/);
  });

  it('parses the gcp-kms backend into the right discriminated variant', () => {
    const cfg = parseKekConfigFromEnv({
      BROADCAST_KEK_PROVIDER: 'gcp-kms',
      BROADCAST_KMS_KEK_RESOURCE: GCP_KEY_RESOURCE,
    });
    expect(cfg).toEqual({ backend: 'gcp-kms', keyResource: GCP_KEY_RESOURCE });
  });

  it('requires BROADCAST_KMS_KEK_RESOURCE when backend is gcp-kms', () => {
    expect(() =>
      parseKekConfigFromEnv({ BROADCAST_KEK_PROVIDER: 'gcp-kms' }),
    ).toThrow(/gcp-kms.*BROADCAST_KMS_KEK_RESOURCE/);
  });

  it('parses the aws-kms backend and threads the optional region through', () => {
    const cfg = parseKekConfigFromEnv({
      BROADCAST_KEK_PROVIDER: 'aws-kms',
      BROADCAST_KMS_KEK_RESOURCE: 'arn:aws:kms:us-east-1:000:key/demo',
      BROADCAST_KMS_REGION: 'us-east-1',
    });
    expect(cfg).toEqual({
      backend: 'aws-kms',
      keyResource: 'arn:aws:kms:us-east-1:000:key/demo',
      region: 'us-east-1',
    });
  });

  it('parses the azure-keyvault backend with and without an explicit version', () => {
    const cfg = parseKekConfigFromEnv({
      BROADCAST_KEK_PROVIDER: 'azure-keyvault',
      BROADCAST_KV_VAULT_URL: 'https://demo.vault.azure.net',
      BROADCAST_KV_KEY_NAME: 'demo-key',
      BROADCAST_KV_KEY_VERSION: 'abc123',
    });
    expect(cfg).toEqual({
      backend: 'azure-keyvault',
      vaultUrl: 'https://demo.vault.azure.net',
      keyName: 'demo-key',
      keyVersion: 'abc123',
    });
  });

  it('requires both vault URL and key name for azure-keyvault', () => {
    expect(() =>
      parseKekConfigFromEnv({
        BROADCAST_KEK_PROVIDER: 'azure-keyvault',
        BROADCAST_KV_VAULT_URL: 'https://demo.vault.azure.net',
      }),
    ).toThrow(/azure-keyvault.*BROADCAST_KV_VAULT_URL.*BROADCAST_KV_KEY_NAME/);
  });

  it('rejects an unknown backend name with the full list of valid choices', () => {
    expect(() =>
      parseKekConfigFromEnv({ BROADCAST_KEK_PROVIDER: 'hashicorp-vault' }),
    ).toThrow(/Unknown BROADCAST_KEK_PROVIDER="hashicorp-vault".*local.*gcp-kms.*aws-kms.*azure-keyvault/);
  });
});

// ─── resolveKekProvider (breaker composition) ────────────────────────────

describe('resolveKekProvider', () => {
  it('wraps the resolved provider in CircuitBreakerKekProvider by default', () => {
    const provider = resolveKekProvider({
      NODE_ENV: 'development',
      BROADCAST_LOCAL_KEK_B64: MASTER_SECRET_B64,
    });
    expect(provider).toBeInstanceOf(CircuitBreakerKekProvider);
  });

  it('honors the BROADCAST_KEK_BREAKER_DISABLED escape hatch', () => {
    const provider = resolveKekProvider({
      NODE_ENV: 'development',
      BROADCAST_LOCAL_KEK_B64: MASTER_SECRET_B64,
      BROADCAST_KEK_BREAKER_DISABLED: 'true',
    });
    expect(provider).toBeInstanceOf(LocalKekProvider);
  });
});

// ─── Option B: friendly error when @google-cloud/kms is missing ──────────

describe('GcpKmsKekProvider without @google-cloud/kms installed', () => {
  // Spy on the dynamic import seam so the test is robust regardless of
  // whether @google-cloud/kms is installed. The spy simulates a missing package
  // at the import() boundary; loadKmsModule() still runs its error-wrapping
  // logic, so we exercise the real "BROADCAST_KEK_PROVIDER configured but dep
  // absent" code path.
  const missingPkgError = Object.assign(
    new Error('Failed to load url @google-cloud/kms (module not found)'),
    { code: 'ERR_MODULE_NOT_FOUND' },
  );

  beforeEach(() => {
    vi.spyOn(kmsSeam, 'doImport').mockRejectedValue(missingPkgError);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws an operator-readable error on first wrap(), telling them how to fix it', async () => {
    const provider = new GcpKmsKekProvider(GCP_KEY_RESOURCE);
    await expect(provider.wrap(Buffer.alloc(32, 0x11))).rejects.toThrow(
      /gcp-kms.*is configured.*optional dependency.*@google-cloud\/kms.*not installed/is,
    );
  });

  it('rejects wrap() for a non-32-byte DEK before ever touching the KMS client', async () => {
    const provider = new GcpKmsKekProvider(GCP_KEY_RESOURCE);
    await expect(provider.wrap(Buffer.alloc(16, 0x11))).rejects.toThrow(
      /DEK must be 32 bytes/,
    );
  });
});
