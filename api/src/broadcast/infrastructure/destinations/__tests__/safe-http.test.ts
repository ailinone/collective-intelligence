// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for safe-http — the SSRF egress guard.
 *
 * The IP classifier is pure and deterministic — we test it exhaustively.
 * The live-fetch path is covered indirectly via the webhook-adapter tests
 * (which stand up a local http.Server).
 */

import { describe, it, expect } from 'vitest';

import { EgressBlockedError, isForbiddenIp, safeFetch } from '../safe-http';

describe('isForbiddenIp — IPv4', () => {
  it.each([
    ['10.0.0.1'],
    ['10.255.255.254'],
    ['127.0.0.1'],
    ['127.5.5.5'],
    ['169.254.169.254'], // AWS/GCP metadata
    ['169.254.0.1'], // link-local
    ['172.16.0.1'],
    ['172.31.255.254'],
    ['192.168.1.1'],
    ['0.0.0.0'],
    ['100.64.0.1'], // CGNAT
    ['198.18.0.1'],
    ['224.0.0.1'], // multicast
    ['240.0.0.1'], // reserved
    ['255.255.255.255'],
  ])('blocks %s', (ip) => {
    expect(isForbiddenIp(ip)).toBe(true);
  });

  it.each([
    ['1.1.1.1'],
    ['8.8.8.8'],
    ['104.16.0.1'],
    ['172.15.255.254'], // just below private range
    ['172.32.0.0'], // just above
    ['192.167.255.254'],
    ['192.169.0.1'],
    ['100.63.255.254'],
    ['100.128.0.1'],
  ])('allows %s', (ip) => {
    expect(isForbiddenIp(ip)).toBe(false);
  });

  it('rejects malformed IPv4 as forbidden (fail closed)', () => {
    expect(isForbiddenIp('999.999.999.999')).toBe(true);
    expect(isForbiddenIp('1.2.3')).toBe(true);
    expect(isForbiddenIp('not-an-ip')).toBe(true);
  });
});

describe('isForbiddenIp — IPv6', () => {
  it.each([
    ['::1'], // loopback
    ['::'], // unspecified
    ['fe80::1'], // link-local
    ['fc00::1'], // ULA
    ['fd00::1'], // ULA
    ['ff00::1'], // multicast
    ['::ffff:127.0.0.1'], // v4-mapped loopback
    ['::ffff:10.0.0.1'], // v4-mapped private
    ['::ffff:169.254.169.254'], // v4-mapped metadata
    ['fd00:ec2::254'], // EC2 IPv6 metadata
  ])('blocks %s', (ip) => {
    expect(isForbiddenIp(ip)).toBe(true);
  });

  it.each([
    ['2001:4860:4860::8888'], // Google DNS
    ['2606:4700:4700::1111'], // Cloudflare
    ['::ffff:1.1.1.1'], // v4-mapped public
    ['::ffff:101:101'], // v4-mapped public, hex form (1.1.1.1)
  ])('allows %s', (ip) => {
    expect(isForbiddenIp(ip)).toBe(false);
  });

  // SSRF regression: the WHATWG URL parser canonicalizes
  // `http://[::ffff:169.254.169.254]/` to hostname `[::ffff:a9fe:a9fe]`, so the
  // literal-IP and redirect-hop paths see the HEX form, never the dotted one.
  it.each([
    ['::ffff:7f00:1'], // 127.0.0.1
    ['::ffff:a9fe:a9fe'], // 169.254.169.254 (cloud metadata)
    ['::ffff:a00:5'], // 10.0.0.5
    ['::ffff:c0a8:101'], // 192.168.1.1
    ['0:0:0:0:0:ffff:7f00:1'], // uncompressed
    ['0000:0000:0000:0000:0000:ffff:7f00:0001'], // leading zeros
    ['::ffff:0:7f00:1'], // IPv4-translated
    ['::7f00:1'], // deprecated IPv4-compatible
    ['64:ff9b::a9fe:a9fe'], // NAT64 well-known prefix -> metadata
    ['fe90::1'], // link-local is fe80::/10, not only fe80:
    ['febf::1'],
    ['fec0::1'], // deprecated site-local
    ['fe80::1%eth0'], // zone id
    ['1:2:3'], // malformed -> fail closed
    ['1::2::3'],
  ])('blocks %s', (ip) => {
    expect(isForbiddenIp(ip)).toBe(true);
  });

  it('does not over-block a public prefix that merely starts with fc/fd hex digits', () => {
    expect(isForbiddenIp('fc::1')).toBe(false); // 00fc::/16, not ULA
  });
});

describe('safeFetch: literal IPv4-mapped IPv6 URL', () => {
  it.each([
    ['http://[::ffff:169.254.169.254]/latest/meta-data'],
    ['http://[::ffff:127.0.0.1]:6379/'],
    ['http://[0:0:0:0:0:ffff:a00:5]/'],
  ])('refuses %s before connecting', async (url) => {
    const err = await safeFetch(url, { method: 'GET', timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressBlockedError);
    expect((err as EgressBlockedError).reason).toBe('ip_blocked');
  });
});
