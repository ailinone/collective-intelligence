// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GCP Cloud KMS KEK provider (ADR-017).
 *
 * This module is the ONLY place in the codebase that touches `@google-cloud/kms`.
 * That package is declared as an **optional dependency** — it is required ONLY
 * when the deployment's `BROADCAST_KEK_PROVIDER=gcp-kms`. Deployments targeting
 * AWS, Azure, or self-hosted infrastructure MUST NOT need it installed.
 *
 * Architectural intent
 * --------------------
 * - The core (`kek-provider.ts`) is cloud-agnostic. It imports this file only
 *   to construct GCP instances; a future `aws-kms-kek-provider.ts` and
 *   `azure-keyvault-kek-provider.ts` will sit alongside as siblings.
 * - The `@google-cloud/kms` module type surface is modelled *locally* in this
 *   file (see `KmsClient`, `KmsModuleShape` below). The TypeScript compiler
 *   does not need the package installed to type-check the rest of the app —
 *   only the validation at the runtime import boundary sees it.
 * - The runtime validation re-throws `ERR_MODULE_NOT_FOUND` with a clear
 *   operator-facing message: "backend configured but optional dep missing".
 *
 * Why a dynamic import and not a regular `import` with optional dep?
 * ------------------------------------------------------------------
 * A static `import ... from '@google-cloud/kms'` at module top would:
 *   (a) force tsc to resolve the package at compile time, which only works
 *       when the package is installed (defeats the optional-dep intent), and
 *   (b) crash the Node runtime at module load for non-GCP deployments, even
 *       when the code path is never reached.
 * The `await import(...)` keeps both properties (compile-time independence
 * and runtime lazy loading) without resorting to `@ts-expect-error`.
 */

import { logger } from '@/utils/logger';

import type { KekProvider } from './kek-provider';

const log = logger.child({ component: 'broadcast-kek-gcp' });

// ─── Minimal surface of @google-cloud/kms we actually consume ────────────
//
// We model ONLY the two operations GcpKmsKekProvider calls. Intentional — if
// the upstream SDK changes in a way that breaks this surface, we want the
// compile error to surface *here*, inside the GCP adapter, not silently at
// runtime as a missing-method crash in production.

interface KmsEncryptRequest {
  readonly name: string;
  readonly plaintext: Buffer;
}

interface KmsDecryptRequest {
  readonly name: string;
  readonly ciphertext: Buffer;
}

interface KmsEncryptResponse {
  readonly ciphertext: Buffer | Uint8Array;
}

interface KmsDecryptResponse {
  readonly plaintext: Buffer | Uint8Array;
}

interface KmsClient {
  encrypt(req: KmsEncryptRequest): Promise<[KmsEncryptResponse]>;
  decrypt(req: KmsDecryptRequest): Promise<[KmsDecryptResponse]>;
}

interface KmsModuleShape {
  readonly KeyManagementServiceClient: new () => KmsClient;
}

// ─── Module resolver ─────────────────────────────────────────────────────

/**
 * Dynamically load `@google-cloud/kms`. Validates the shape of the loaded
 * module before returning it — a missing `KeyManagementServiceClient` export
 * counts as a hard failure just like a missing package.
 *
 * If the package isn't installed, the thrown error *explicitly* tells the
 * operator what is wrong and what to do (install the optional dep OR switch
 * backends). This is the whole point of Option B: the absence of the package
 * is a *configuration mismatch*, not a code bug.
 */
/**
 * Does this error indicate "the package is not installed on disk"?
 *
 * Different runtimes wrap the same underlying failure in different shapes:
 *
 *   - Node.js ESM:      `err.code === 'ERR_MODULE_NOT_FOUND'`
 *   - Node.js CJS:      `err.code === 'MODULE_NOT_FOUND'`
 *   - Vite / Vitest:    no code, but the message starts with
 *                       `"Failed to load url @google-cloud/kms"`.
 *   - tsx / ts-node:    varies, but the message always *contains* the
 *                       package specifier and one of the "cannot find / not
 *                       installed / does not exist" phrasings.
 *
 * We intentionally detect via a *broad* set of signals: the architectural
 * promise is "Option B surfaces a single operator-readable error across any
 * reasonable Node runtime" — not "we only support the Node CJS error code".
 * False positives here are harmless because the fallback `throw err` on the
 * bottom still preserves unexpected shapes.
 */
function isPackageMissingError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;

  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return false;

  // Vite / Vitest resolver message.
  if (/Failed to load url @google-cloud\/kms/i.test(message)) return true;

  // Generic "cannot find module" / "not installed" patterns that mention our
  // specifier. Scoped to the package name so other random errors that happen
  // to say "cannot find" don't get mis-classified.
  if (
    /@google-cloud\/kms/i.test(message) &&
    /(cannot find|not installed|cannot resolve|does(n't| not) exist|unable to resolve)/i.test(message)
  ) {
    return true;
  }

  return false;
}

/**
 * Testing seam — lets test suites stub the dynamic import call without
 * uninstalling the optional dep. Spy on `__testing.doImport` to simulate a
 * missing package; `loadKmsModule` still runs its error-wrapping so the
 * operator-readable message is generated by the real production path.
 */
export const __testing = {
  doImport: (): Promise<unknown> => {
    const specifier = '@google-cloud/kms';
    return import(specifier);
  },
};

async function loadKmsModule(): Promise<KmsModuleShape> {
  try {
    const mod: unknown = await __testing.doImport();

    if (
      !mod ||
      typeof (mod as { KeyManagementServiceClient?: unknown }).KeyManagementServiceClient !==
        'function'
    ) {
      throw new Error(
        "@google-cloud/kms loaded, but its 'KeyManagementServiceClient' export is " +
          'missing or not a constructor. The installed version may be incompatible ' +
          'with this adapter.',
      );
    }
    return mod as KmsModuleShape;
  } catch (err) {
    if (isPackageMissingError(err)) {
      throw new Error(
        "BROADCAST_KEK_PROVIDER='gcp-kms' is configured, but the optional dependency " +
          "'@google-cloud/kms' is not installed in this deployment.\n" +
          "Resolution:\n" +
          "  - Install the dependency: `pnpm add @google-cloud/kms`, OR\n" +
          "  - Switch the backend (e.g., BROADCAST_KEK_PROVIDER=local, aws-kms, " +
          "azure-keyvault) and set the corresponding resource env vars.",
      );
    }
    throw err;
  }
}

// ─── Provider ────────────────────────────────────────────────────────────

/**
 * `GcpKmsKekProvider` delegates wrap/unwrap to GCP Cloud KMS.
 *
 * The KEK resource is a full CryptoKey resource name:
 *   projects/{project}/locations/{loc}/keyRings/{ring}/cryptoKeys/{key}
 *
 * KMS is called with the primary version; the actual version used is logged
 * by Cloud Audit Logs and retrievable from the ciphertext for rotation.
 */
export class GcpKmsKekProvider implements KekProvider {
  private clientReady: Promise<KmsClient> | null = null;

  constructor(public readonly resource: string) {
    if (!resource || !resource.startsWith('projects/')) {
      throw new Error(
        `GcpKmsKekProvider: invalid KEK resource "${resource}" — must be a full ` +
          'KMS CryptoKey resource name (projects/{project}/locations/{location}/' +
          'keyRings/{ring}/cryptoKeys/{key})',
      );
    }
  }

  private async getClient(): Promise<KmsClient> {
    if (!this.clientReady) {
      this.clientReady = (async () => {
        const mod = await loadKmsModule();
        const client = new mod.KeyManagementServiceClient();
        log.info({ resource: this.resource }, 'GCP KMS client initialized');
        return client;
      })();
    }
    return this.clientReady;
  }

  async wrap(dek: Buffer): Promise<Buffer> {
    if (dek.length !== 32) {
      throw new Error(`DEK must be 32 bytes, got ${dek.length}`);
    }
    const client = await this.getClient();
    const [resp] = await client.encrypt({ name: this.resource, plaintext: dek });
    return Buffer.from(resp.ciphertext);
  }

  async unwrap(wrappedDek: Buffer): Promise<Buffer> {
    const client = await this.getClient();
    const [resp] = await client.decrypt({ name: this.resource, ciphertext: wrappedDek });
    const dek = Buffer.from(resp.plaintext);
    if (dek.length !== 32) {
      throw new Error(`KMS returned DEK with wrong length: ${dek.length}`);
    }
    return dek;
  }
}

