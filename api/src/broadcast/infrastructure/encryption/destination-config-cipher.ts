// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Destination Config Cipher — envelope encryption for destination credentials.
 *
 * See ADR-017 (Destination Config uses KMS-backed Envelope Encryption).
 *
 * Each destination row carries:
 *   - a per-row DEK (32-byte random AES-256 key), wrapped by a KEK
 *   - AES-256-GCM ciphertext of the JSON config, keyed by the DEK
 *   - Additional Authenticated Data (AAD) binding ciphertext to
 *     (tenantType, tenantId, destinationId) — swap-resistance
 *
 * Decrypted configs are cached per-process (LRU + TTL) to avoid hitting
 * KMS on every send. Cache is invalidated automatically when the wrapped
 * DEK changes (e.g., admin rotation).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { LRUCache } from 'lru-cache';

import { narrowAs } from '@/utils/type-guards';
import type { KekProvider } from './kek-provider';

// ─── Types ──────────────────────────────────────────────────────────────

export interface EncryptedBlob {
  /** Ciphertext of the JSON-serialized config. */
  ciphertext: Buffer;
  /** 12-byte GCM IV. */
  iv: Buffer;
  /** 16-byte GCM auth tag. */
  authTag: Buffer;
  /** Additional Authenticated Data (bound at encrypt; verified at decrypt). */
  aad: string;
  /** DEK encrypted by the KEK. */
  dekWrapped: Buffer;
  /** KEK resource identifier at encrypt time (for audit + rotation tracking). */
  kekResource: string;
}

export interface TenantRef {
  readonly tenantType: 'organization' | 'user';
  readonly tenantId: string;
  readonly destinationId: string;
}

// ─── AAD construction ────────────────────────────────────────────────────

/**
 * AAD binds the ciphertext to its tenant + destination.
 *
 * Versioned string so future changes (e.g., adding chatroom scope) stay
 * backward-compatible: old blobs decrypt with v1 AAD; new blobs encrypt
 * with v2 AAD. The AAD itself is stored with the blob for verification.
 */
export const AAD_VERSION = 'broadcast-destination:v1';

export function buildAad(ref: TenantRef): string {
  return `${AAD_VERSION}|tenant=${ref.tenantType}:${ref.tenantId}|dest=${ref.destinationId}`;
}

// ─── Cipher ─────────────────────────────────────────────────────────────

const IV_LEN = 12;
const _TAG_LEN = 16;
const DEK_LEN = 32;

export interface DestinationConfigCipherOptions {
  kek: KekProvider;
  /** LRU max entries for decrypted configs. Default 500. */
  cacheMaxEntries?: number;
  /** Cache TTL in ms. Default 5 minutes (matches ADR-017). */
  cacheTtlMs?: number;
}

export class DestinationConfigCipher {
  private readonly kek: KekProvider;
  private readonly cache: LRUCache<string, object>;

  constructor(opts: DestinationConfigCipherOptions) {
    this.kek = opts.kek;
    this.cache = new LRUCache<string, object>({
      max: opts.cacheMaxEntries ?? 500,
      ttl: opts.cacheTtlMs ?? 5 * 60 * 1000,
      allowStale: false,
      updateAgeOnGet: false,
    });
  }

  /**
   * Encrypt a config object.
   *
   * Generates a fresh DEK per call (do NOT reuse across calls — reuse breaks
   * GCM security if the same IV happens twice). Wraps the DEK with the KEK.
   */
  async encrypt(plaintext: object, ref: TenantRef): Promise<EncryptedBlob> {
    const dek = randomBytes(DEK_LEN);
    const iv = randomBytes(IV_LEN);
    const aad = buildAad(ref);

    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(plaintext), 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    const dekWrapped = await this.kek.wrap(dek);
    // Best-effort wipe: overwrite the DEK buffer so it's not left lying in memory.
    // Not a guarantee (V8 can relocate buffers), but reduces window of exposure.
    dek.fill(0);

    return {
      ciphertext,
      iv,
      authTag,
      aad,
      dekWrapped,
      kekResource: this.kek.resource,
    };
  }

  /**
   * Decrypt a blob. Returns the parsed JSON config.
   *
   * Verifies AAD matches the provided ref — if a blob from a different
   * tenant/destination is handed in, decryption fails (swap resistance).
   */
  async decrypt<T extends object = object>(blob: EncryptedBlob, ref: TenantRef): Promise<T> {
    const expectedAad = buildAad(ref);
    if (!constantTimeStringEq(blob.aad, expectedAad)) {
      // Do not reveal which half differs.
      throw new Error('Destination config AAD mismatch');
    }

    const cacheKey = buildCacheKey(ref, blob.dekWrapped);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached as T;

    const dek = await this.kek.unwrap(blob.dekWrapped);
    try {
      const decipher = createDecipheriv('aes-256-gcm', dek, blob.iv);
      decipher.setAAD(Buffer.from(blob.aad, 'utf8'));
      decipher.setAuthTag(blob.authTag);
      const plaintext = Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
      const parsed = JSON.parse(plaintext.toString('utf8')) as T;
      this.cache.set(cacheKey, narrowAs<object>(parsed));
      return parsed;
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Force cache invalidation for a destination (after admin edits or
   * DEK rotation).
   */
  invalidate(ref: TenantRef): void {
    const prefix = cacheKeyPrefix(ref);
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /**
   * Rotate the DEK for an existing blob: decrypts with the old DEK, generates
   * a new DEK, re-encrypts. Ciphertext of the plaintext stays bound to the
   * same AAD. Caller is responsible for persisting the new blob.
   */
  async rotateDek(blob: EncryptedBlob, ref: TenantRef): Promise<EncryptedBlob> {
    const plaintext = await this.decrypt(blob, ref);
    this.invalidate(ref);
    return this.encrypt(plaintext, ref);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function cacheKeyPrefix(ref: TenantRef): string {
  return `${ref.tenantType}:${ref.tenantId}:${ref.destinationId}:`;
}

function buildCacheKey(ref: TenantRef, dekWrapped: Buffer): string {
  // Hash the wrapped DEK so rotation naturally invalidates (different wrap → different key).
  const fingerprint = createHash('sha256').update(dekWrapped).digest('hex').slice(0, 16);
  return `${cacheKeyPrefix(ref)}${fingerprint}`;
}

/**
 * Length-independent constant-time equality on strings. Length comparison
 * itself is NOT constant-time but that's acceptable here: the AAD is a
 * structured, known-format string — its length isn't secret.
 */
function constantTimeStringEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return timingSafeEqual(ab, bb);
}
