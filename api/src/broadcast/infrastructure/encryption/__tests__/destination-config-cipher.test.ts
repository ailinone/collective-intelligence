// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the envelope encryption cipher (ADR-017).
 *
 * Cryptographic invariants:
 *   1. Round-trip: decrypt(encrypt(p, ref), ref) === p
 *   2. AAD binding: decrypt fails if ref differs from encrypt ref
 *   3. Tampering: decrypt fails on any ciphertext / iv / tag bit flip
 *   4. DEK freshness: two encrypts of the same plaintext differ (fresh IV+DEK)
 *   5. KEK rotation: rotateDek preserves plaintext but changes wrapped DEK
 *   6. Cache invalidation: invalidate() forces re-decrypt
 *   7. LocalKekProvider: wrap/unwrap round-trip
 */

import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  DestinationConfigCipher,
  buildAad,
  type TenantRef,
} from '../destination-config-cipher';
import { LocalKekProvider } from '../kek-provider';

function makeCipher(): DestinationConfigCipher {
  const master = randomBytes(32);
  const kek = new LocalKekProvider(master, 'local://test');
  return new DestinationConfigCipher({ kek, cacheTtlMs: 1000 });
}

function makeRef(overrides: Partial<TenantRef> = {}): TenantRef {
  return {
    tenantType: 'organization',
    tenantId: '00000000-0000-0000-0000-000000000001',
    destinationId: '00000000-0000-0000-0000-0000000000aa',
    ...overrides,
  };
}

describe('DestinationConfigCipher — round-trip', () => {
  let cipher: DestinationConfigCipher;
  beforeEach(() => {
    cipher = makeCipher();
  });

  it('decrypt(encrypt(p, ref), ref) === p', async () => {
    const plaintext = { apiKey: 'sk-abc-123', endpoint: 'https://api.example.com' };
    const ref = makeRef();
    const blob = await cipher.encrypt(plaintext, ref);
    const decrypted = await cipher.decrypt(blob, ref);
    expect(decrypted).toEqual(plaintext);
  });

  it('ciphertext embeds no plaintext', async () => {
    const plaintext = { secret: 'very-secret-token' };
    const blob = await cipher.encrypt(plaintext, makeRef());
    expect(blob.ciphertext.toString('utf8')).not.toContain('very-secret-token');
  });

  it('IV is 12 bytes and auth tag is 16 bytes (AES-GCM standard)', async () => {
    const blob = await cipher.encrypt({ a: 1 }, makeRef());
    expect(blob.iv.length).toBe(12);
    expect(blob.authTag.length).toBe(16);
  });
});

describe('DestinationConfigCipher — AAD binding (swap resistance)', () => {
  it('fails if tenantId changes between encrypt and decrypt', async () => {
    const cipher = makeCipher();
    const plaintext = { apiKey: 'sk-abc' };
    const refA = makeRef({ tenantId: '00000000-0000-0000-0000-000000000001' });
    const refB = makeRef({ tenantId: '00000000-0000-0000-0000-000000000002' });
    const blob = await cipher.encrypt(plaintext, refA);
    await expect(cipher.decrypt(blob, refB)).rejects.toThrow(/AAD mismatch/i);
  });

  it('fails if destinationId changes', async () => {
    const cipher = makeCipher();
    const blob = await cipher.encrypt({ x: 1 }, makeRef({ destinationId: 'a' }));
    await expect(cipher.decrypt(blob, makeRef({ destinationId: 'b' }))).rejects.toThrow();
  });

  it('fails if tenantType switches organization ↔ user', async () => {
    const cipher = makeCipher();
    const blob = await cipher.encrypt({ x: 1 }, makeRef({ tenantType: 'organization' }));
    await expect(cipher.decrypt(blob, makeRef({ tenantType: 'user' }))).rejects.toThrow();
  });

  it('AAD string format is versioned and deterministic', () => {
    const ref: TenantRef = {
      tenantType: 'user',
      tenantId: 'u-1',
      destinationId: 'd-2',
    };
    expect(buildAad(ref)).toBe('broadcast-destination:v1|tenant=user:u-1|dest=d-2');
  });
});

describe('DestinationConfigCipher — tamper detection', () => {
  it('rejects ciphertext bit flips', async () => {
    const cipher = makeCipher();
    const ref = makeRef();
    const blob = await cipher.encrypt({ a: 'b' }, ref);
    // Flip one bit in ciphertext; GCM must fail auth.
    const tampered = {
      ...blob,
      ciphertext: Buffer.from(blob.ciphertext),
    };
    tampered.ciphertext[0] ^= 0x01;
    await expect(cipher.decrypt(tampered, ref)).rejects.toThrow();
  });

  it('rejects auth tag bit flips', async () => {
    const cipher = makeCipher();
    const ref = makeRef();
    const blob = await cipher.encrypt({ a: 'b' }, ref);
    const tampered = { ...blob, authTag: Buffer.from(blob.authTag) };
    tampered.authTag[0] ^= 0x01;
    await expect(cipher.decrypt(tampered, ref)).rejects.toThrow();
  });

  it('rejects IV changes', async () => {
    const cipher = makeCipher();
    const ref = makeRef();
    const blob = await cipher.encrypt({ a: 'b' }, ref);
    const tampered = { ...blob, iv: Buffer.from(blob.iv) };
    tampered.iv[0] ^= 0x01;
    await expect(cipher.decrypt(tampered, ref)).rejects.toThrow();
  });
});

describe('DestinationConfigCipher — DEK freshness', () => {
  it('two encrypts of the same plaintext produce different ciphertexts', async () => {
    const cipher = makeCipher();
    const ref = makeRef();
    const a = await cipher.encrypt({ x: 1 }, ref);
    const b = await cipher.encrypt({ x: 1 }, ref);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.dekWrapped.equals(b.dekWrapped)).toBe(false);
  });
});

describe('DestinationConfigCipher — rotateDek', () => {
  it('preserves plaintext, changes wrapped DEK and ciphertext', async () => {
    const cipher = makeCipher();
    const ref = makeRef();
    const plaintext = { apiKey: 'sk-abc' };
    const original = await cipher.encrypt(plaintext, ref);
    const rotated = await cipher.rotateDek(original, ref);

    expect(rotated.dekWrapped.equals(original.dekWrapped)).toBe(false);
    expect(rotated.ciphertext.equals(original.ciphertext)).toBe(false);

    const decrypted = await cipher.decrypt(rotated, ref);
    expect(decrypted).toEqual(plaintext);
  });
});

describe('DestinationConfigCipher — cache', () => {
  it('caches decrypted values (second decrypt does not invoke KEK)', async () => {
    const master = randomBytes(32);
    const kek = new LocalKekProvider(master, 'local://test');
    let unwrapCalls = 0;
    const spiedKek = {
      resource: kek.resource,
      wrap: kek.wrap.bind(kek),
      unwrap: async (w: Buffer) => {
        unwrapCalls++;
        return kek.unwrap(w);
      },
    };
    const cipher = new DestinationConfigCipher({ kek: spiedKek });
    const ref = makeRef();
    const blob = await cipher.encrypt({ a: 1 }, ref);

    await cipher.decrypt(blob, ref);
    await cipher.decrypt(blob, ref);

    expect(unwrapCalls).toBe(1);
  });

  it('invalidate() clears the cache for a destination', async () => {
    const master = randomBytes(32);
    const kek = new LocalKekProvider(master, 'local://test');
    let unwrapCalls = 0;
    const spiedKek = {
      resource: kek.resource,
      wrap: kek.wrap.bind(kek),
      unwrap: async (w: Buffer) => {
        unwrapCalls++;
        return kek.unwrap(w);
      },
    };
    const cipher = new DestinationConfigCipher({ kek: spiedKek });
    const ref = makeRef();
    const blob = await cipher.encrypt({ a: 1 }, ref);

    await cipher.decrypt(blob, ref);
    cipher.invalidate(ref);
    await cipher.decrypt(blob, ref);

    expect(unwrapCalls).toBe(2);
  });
});

describe('LocalKekProvider', () => {
  it('wrap/unwrap round-trip', async () => {
    const master = randomBytes(32);
    const kek = new LocalKekProvider(master, 'local://test');
    const dek = randomBytes(32);
    const wrapped = await kek.wrap(dek);
    const unwrapped = await kek.unwrap(wrapped);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it('rejects short master secrets', () => {
    expect(() => new LocalKekProvider(randomBytes(16), 'local://short')).toThrow(
      />= 32 bytes/,
    );
  });

  it('rejects non-32-byte DEKs', async () => {
    const kek = new LocalKekProvider(randomBytes(32), 'local://test');
    await expect(kek.wrap(randomBytes(16))).rejects.toThrow(/32 bytes/);
  });

  it('rejects tampered wrapped DEKs', async () => {
    const kek = new LocalKekProvider(randomBytes(32), 'local://test');
    const wrapped = await kek.wrap(randomBytes(32));
    wrapped[1] ^= 0x01; // flip a bit in IV
    await expect(kek.unwrap(wrapped)).rejects.toThrow();
  });
});
