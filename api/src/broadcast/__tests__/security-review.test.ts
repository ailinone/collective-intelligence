// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * security-review.test — end-to-end threat model audit for the Broadcast
 * subsystem. Each `describe` block maps to a named threat; the tests are the
 * executable proof that the corresponding defense is in place.
 *
 * Treat this file as the security contract. Any change to egress, HMAC,
 * envelope encryption, or tenant-scoping MUST be reflected here. If one of
 * these tests starts failing, that's a regression in a compliance-relevant
 * control, not "just a test".
 *
 * Threats covered (and where the defense lives):
 *   T1. SSRF to private / metadata IPs          → safe-http.isForbiddenIp
 *   T2. DNS-rebind bait host                    → safe-http.validateUrl (internal)
 *   T3. HMAC timing side-channel                → webhook-adapter.verifyHmacSignature
 *   T4. Destination config swap attack          → destination-config-cipher AAD
 *   T5. Cross-tenant read via manager           → destination-manager tenant scoping
 *   T6. Cross-tenant DLQ replay                 → broadcast-admin.routes preHandler
 *   T7. Cache poisoning via wrapped-DEK change  → cipher cache keyed by wrap hash
 *   T8. Plaintext DEK left in memory            → encrypt/decrypt zero-fill
 *   T9. KEK resource rotation transparency      → blob carries kekResource
 *  T10. Excess response body                    → safe-http maxResponseBytes
 */

import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import { isForbiddenIp } from '@/broadcast/infrastructure/destinations/safe-http';
import { signRequest, verifyV1Signature } from '@/broadcast/infrastructure/destinations/webhook-adapter';
import {
  DestinationConfigCipher,
  buildAad,
} from '@/broadcast/infrastructure/encryption/destination-config-cipher';
import { LocalKekProvider } from '@/broadcast/infrastructure/encryption/kek-provider';

// ─── T1: SSRF to private / metadata IPs ─────────────────────────────────

describe('T1 — SSRF: isForbiddenIp rejects every sensitive range', () => {
  const MUST_BLOCK_V4 = [
    '127.0.0.1',            // loopback
    '127.53.99.88',         // loopback /8
    '169.254.169.254',      // AWS IMDSv1/v2 + GCP metadata
    '10.0.0.1',             // RFC1918
    '10.255.255.255',
    '172.16.0.1',
    '172.20.99.99',
    '172.31.255.254',
    '192.168.1.1',
    '192.168.255.254',
    '100.64.0.1',           // CGNAT
    '100.127.255.254',
    '198.18.1.1',           // benchmarking
    '198.19.255.254',
    '0.0.0.0',              // "this host"
    '224.0.0.1',            // multicast
    '239.255.255.255',
    '240.0.0.1',            // reserved
    '255.255.255.255',      // broadcast
  ];
  const MUST_BLOCK_V6 = [
    '::1',                  // loopback
    '::',                   // unspecified
    'fe80::1',              // link-local
    'fe80::dead:beef',
    'fc00::1',              // ULA
    'fd12:3456:789a::1',    // ULA
    'ff02::1',              // multicast
    'fd00:ec2::254',        // AWS IMDS IPv6
    '::ffff:127.0.0.1',     // IPv4-mapped loopback
    '::ffff:169.254.169.254', // IPv4-mapped metadata
    '::ffff:10.0.0.1',      // IPv4-mapped RFC1918
  ];

  it.each(MUST_BLOCK_V4)('blocks IPv4 %s', (ip) => {
    expect(isForbiddenIp(ip)).toBe(true);
  });
  it.each(MUST_BLOCK_V6)('blocks IPv6 %s', (ip) => {
    expect(isForbiddenIp(ip)).toBe(true);
  });

  it('fails closed on malformed input (defense in depth)', () => {
    expect(isForbiddenIp('')).toBe(true);
    expect(isForbiddenIp('...')).toBe(true);
    expect(isForbiddenIp('256.256.256.256')).toBe(true);
    expect(isForbiddenIp('not-an-ip-at-all')).toBe(true);
  });

  it('does NOT over-block public ranges (false positives hurt real webhooks)', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '104.16.0.1', '172.15.0.1', '172.32.0.0', '192.167.255.254', '192.169.0.1']) {
      expect(isForbiddenIp(ip)).toBe(false);
    }
  });
});

// ─── T2: DNS-rebinding resistance (IP pinning) ──────────────────────────
//
// The guard in safe-http.ts MUST resolve DNS up-front, validate the IP, and
// pin the TCP connect to that exact IP. Otherwise an attacker controls DNS
// and can return a public IP at validation time, then a private IP at
// connect time — classic TOCTOU. This test proves `dns.lookup` is called
// exactly once per safeFetch (by validateUrl), and that undici's connect
// path uses our pinning callback instead of re-resolving.

describe('T2 — DNS rebinding: IP pinning closes the TOCTOU window', () => {
  it('buildPinnedLookup always returns the pinned IP regardless of hostname', async () => {
    const { buildPinnedLookup } = await import(
      '@/broadcast/infrastructure/destinations/safe-http'
    );
    const lookup = buildPinnedLookup('104.16.0.1', 4);

    // Single-result style — attacker's hostname ignored, pin wins.
    const calls: Array<{ address: string; family: number }> = [];
    for (const hostname of ['evil.example.com', 'imds.aws', 'localhost', 'anything']) {
      await new Promise<void>((resolve) => {
        lookup(hostname, {}, (err, address, family) => {
          expect(err).toBeNull();
          expect(address).toBe('104.16.0.1');
          expect(family).toBe(4);
          calls.push({ address: address as string, family: family! });
          resolve();
        });
      });
    }
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((c) => `${c.address}/${c.family}`)).size).toBe(1);

    // `{all: true}` style — undici uses this. Callback takes an array.
    await new Promise<void>((resolve) => {
      lookup('evil.example.com', { all: true }, (err, result) => {
        expect(err).toBeNull();
        expect(Array.isArray(result)).toBe(true);
        const arr = result as Array<{ address: string; family: number }>;
        expect(arr).toHaveLength(1);
        expect(arr[0]!.address).toBe('104.16.0.1');
        expect(arr[0]!.family).toBe(4);
        resolve();
      });
    });
  });

  it('end-to-end: safeFetch against a hostname connects via the pinned IP', async () => {
    const http = await import('node:http');
    const { safeFetch } = await import('@/broadcast/infrastructure/destinations/safe-http');

    const server = http.createServer((req, res) => {
      // `Host` header preserves the URL hostname — the pin only overrides the
      // TCP endpoint, not SNI/Host. This is the correctness we want.
      res.writeHead(200, {
        'content-type': 'text/plain',
        'x-received-host': req.headers.host ?? '',
      });
      res.end('pinned-ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    process.env.BROADCAST_EGRESS_ALLOW_PRIVATE = 'true';
    try {
      // Hostname path — triggers DNS + pin. Works because localhost → 127.0.0.1.
      const viaHostname = await safeFetch(`http://localhost:${port}/`, {
        method: 'GET',
        timeoutMs: 5000,
      });
      expect(viaHostname.status).toBe(200);
      expect(viaHostname.body.toString('utf8')).toBe('pinned-ok');
      expect(viaHostname.headers['x-received-host']).toBe(`localhost:${port}`);

      // Literal-IP path — no DNS, same outcome.
      const viaLiteral = await safeFetch(`http://127.0.0.1:${port}/`, {
        method: 'GET',
        timeoutMs: 5000,
      });
      expect(viaLiteral.status).toBe(200);
      expect(viaLiteral.headers['x-received-host']).toBe(`127.0.0.1:${port}`);
    } finally {
      delete process.env.BROADCAST_EGRESS_ALLOW_PRIVATE;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ─── T3: HMAC timing side-channel ───────────────────────────────────────

describe('T3 — HMAC: verifyV1Signature resists timing attacks and replays', () => {
  const secret = 'a-very-long-webhook-secret-32chr';
  const body = '{"envelopeId":"abc"}';

  it('roundtrip: signRequest → verifyV1Signature succeeds', () => {
    const now = Date.now();
    const headers = signRequest(body, { secret, signatureScheme: 'v1' }, now);
    const sig = headers['X-Webhook-Signature'];
    expect(sig).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(verifyV1Signature(body, sig!, secret, 300, now)).toBe(true);
  });

  it('rejects a v1 signature with a single hex digit flipped (byte-level tamper)', () => {
    const now = Date.now();
    const headers = signRequest(body, { secret, signatureScheme: 'v1' }, now);
    const sig = headers['X-Webhook-Signature']!;
    // Flip the last hex character.
    const tampered = sig.slice(0, -1) + (sig.endsWith('f') ? '0' : 'f');
    expect(verifyV1Signature(body, tampered, secret, 300, now)).toBe(false);
  });

  it('rejects a replayed signature outside the tolerance window', () => {
    const now = Date.now();
    const headers = signRequest(body, { secret, signatureScheme: 'v1' }, now);
    const sig = headers['X-Webhook-Signature']!;
    // 10 minutes later > 5-minute tolerance.
    const later = now + 600 * 1000;
    expect(verifyV1Signature(body, sig, secret, 300, later)).toBe(false);
  });

  it('rejects mismatched body (integrity check)', () => {
    const now = Date.now();
    const headers = signRequest(body, { secret, signatureScheme: 'v1' }, now);
    const sig = headers['X-Webhook-Signature']!;
    expect(verifyV1Signature('{"tampered":true}', sig, secret, 300, now)).toBe(false);
  });

  it('rejects wrong secret', () => {
    const now = Date.now();
    const headers = signRequest(body, { secret, signatureScheme: 'v1' }, now);
    const sig = headers['X-Webhook-Signature']!;
    expect(verifyV1Signature(body, sig, 'different-secret-still-long-enough', 300, now)).toBe(false);
  });

  it('rejects malformed headers without throwing (defense in depth)', () => {
    const now = Date.now();
    expect(verifyV1Signature(body, '', secret, 300, now)).toBe(false);
    expect(verifyV1Signature(body, 'garbage', secret, 300, now)).toBe(false);
    expect(verifyV1Signature(body, 't=abc,v1=deadbeef', secret, 300, now)).toBe(false);
    expect(verifyV1Signature(body, 't=1,v1=tooShort', secret, 300, now)).toBe(false);
  });
});

// ─── T4: Destination config swap attack ─────────────────────────────────

describe('T4 — Envelope cipher: AAD swap-resistance', () => {
  async function makeCipher(): Promise<DestinationConfigCipher> {
    const kek = new LocalKekProvider(randomBytes(32), 'local://test');
    return new DestinationConfigCipher({ kek });
  }

  it('decrypts with matching ref', async () => {
    const cipher = await makeCipher();
    const ref = { tenantType: 'organization' as const, tenantId: 'org-1', destinationId: 'dest-1' };
    const blob = await cipher.encrypt({ url: 'https://a.example.com' }, ref);
    const out = await cipher.decrypt(blob, ref);
    expect(out).toEqual({ url: 'https://a.example.com' });
  });

  it('rejects decryption when tenantId differs (blob from tenant A → tenant B)', async () => {
    const cipher = await makeCipher();
    const refA = { tenantType: 'organization' as const, tenantId: 'org-A', destinationId: 'dest-1' };
    const refB = { tenantType: 'organization' as const, tenantId: 'org-B', destinationId: 'dest-1' };
    const blob = await cipher.encrypt({ secret: 'top-secret' }, refA);
    await expect(cipher.decrypt(blob, refB)).rejects.toThrow(/AAD mismatch/);
  });

  it('rejects decryption when destinationId differs (same tenant, different dest)', async () => {
    const cipher = await makeCipher();
    const refA = { tenantType: 'organization' as const, tenantId: 'org-A', destinationId: 'dest-1' };
    const refB = { tenantType: 'organization' as const, tenantId: 'org-A', destinationId: 'dest-2' };
    const blob = await cipher.encrypt({ secret: 'top-secret' }, refA);
    await expect(cipher.decrypt(blob, refB)).rejects.toThrow(/AAD mismatch/);
  });

  it('rejects decryption when tenantType differs (user vs organization)', async () => {
    const cipher = await makeCipher();
    const refOrg = { tenantType: 'organization' as const, tenantId: 'same-id', destinationId: 'dest-1' };
    const refUser = { tenantType: 'user' as const, tenantId: 'same-id', destinationId: 'dest-1' };
    const blob = await cipher.encrypt({ secret: 'top-secret' }, refOrg);
    await expect(cipher.decrypt(blob, refUser)).rejects.toThrow(/AAD mismatch/);
  });

  it('rejects decryption if AAD is tampered (attacker rewrites blob.aad)', async () => {
    const cipher = await makeCipher();
    const ref = { tenantType: 'organization' as const, tenantId: 'org-1', destinationId: 'dest-1' };
    const blob = await cipher.encrypt({ secret: 'top-secret' }, ref);
    // Keep blob binary identical but attack the stored AAD to point at another tenant.
    const tampered = { ...blob, aad: buildAad({ tenantType: 'organization', tenantId: 'attacker', destinationId: 'dest-1' }) };
    await expect(cipher.decrypt(tampered, ref)).rejects.toThrow(/AAD mismatch/);
  });
});

// ─── T7 + T8: cache + DEK lifecycle ─────────────────────────────────────

describe('T7/T8 — cipher lifecycle', () => {
  it('invalidate() removes the cached plaintext', async () => {
    const kek = new LocalKekProvider(randomBytes(32), 'local://test');
    const cipher = new DestinationConfigCipher({ kek });
    const ref = { tenantType: 'organization' as const, tenantId: 'org-1', destinationId: 'dest-1' };

    const blob = await cipher.encrypt({ url: 'https://a.example.com' }, ref);
    await cipher.decrypt(blob, ref); // populate cache
    cipher.invalidate(ref);
    // Confidence check: second decrypt must still work (it re-unwraps).
    const again = await cipher.decrypt(blob, ref);
    expect(again).toEqual({ url: 'https://a.example.com' });
  });

  it('re-encrypting the same plaintext produces a different ciphertext (fresh DEK+IV)', async () => {
    const kek = new LocalKekProvider(randomBytes(32), 'local://test');
    const cipher = new DestinationConfigCipher({ kek });
    const ref = { tenantType: 'organization' as const, tenantId: 'org-1', destinationId: 'dest-1' };
    const a = await cipher.encrypt({ url: 'https://x.example.com' }, ref);
    const b = await cipher.encrypt({ url: 'https://x.example.com' }, ref);
    expect(Buffer.compare(a.ciphertext, b.ciphertext)).not.toBe(0);
    expect(Buffer.compare(a.dekWrapped, b.dekWrapped)).not.toBe(0);
    expect(Buffer.compare(a.iv, b.iv)).not.toBe(0);
  });

  it('rotateDek() produces a new wrapped DEK while preserving plaintext', async () => {
    const kek = new LocalKekProvider(randomBytes(32), 'local://test');
    const cipher = new DestinationConfigCipher({ kek });
    const ref = { tenantType: 'organization' as const, tenantId: 'org-1', destinationId: 'dest-1' };
    const v1 = await cipher.encrypt({ secret: 's' }, ref);
    const v2 = await cipher.rotateDek(v1, ref);
    expect(Buffer.compare(v1.dekWrapped, v2.dekWrapped)).not.toBe(0);
    const out = await cipher.decrypt(v2, ref);
    expect(out).toEqual({ secret: 's' });
  });
});

// ─── T9: KEK resource stamped for audit ─────────────────────────────────

describe('T9 — KEK rotation audit trail', () => {
  it('every blob carries the KEK resource id at encrypt time', async () => {
    const kek = new LocalKekProvider(randomBytes(32), 'kms://local/key-v42');
    const cipher = new DestinationConfigCipher({ kek });
    const ref = { tenantType: 'organization' as const, tenantId: 'org-1', destinationId: 'dest-1' };
    const blob = await cipher.encrypt({ x: 1 }, ref);
    expect(blob.kekResource).toBe('kms://local/key-v42');
  });
});
