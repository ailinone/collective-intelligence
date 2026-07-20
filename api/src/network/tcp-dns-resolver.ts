// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Minimal TCP-only DNS client.
 *
 * Background (2026-05-11 canary #3 failure):
 *   Docker Desktop's bridge network blocks UDP/53 outbound from the
 *   container. The embedded resolver at 127.0.0.11 cannot forward
 *   queries upstream (returns SERVFAIL), and Node's c-ares queries
 *   directly to 8.8.8.8 time out (same UDP block). However TCP/53
 *   to 8.8.8.8 works fine — verified live.
 *
 *   Node `fetch` resolves through `dns.lookup` (OS getaddrinfo →
 *   /etc/resolv.conf → 127.0.0.11 → SERVFAIL) and CANNOT be redirected
 *   by `dns.setServers` (which only affects `dns.resolve*`). This
 *   module provides a TCP-DNS implementation that the network bootstrap
 *   plugs into undici's Agent so global `fetch` works again.
 *
 *   This is intentionally hand-rolled (no deps) — the DNS message
 *   format is small and we only need A/AAAA records. Keeps the
 *   bootstrap surface minimal and observable.
 *
 *   We are NOT introducing this as a permanent runtime concern in
 *   production. The path is gated on `DNS_TCP_FALLBACK_SERVERS` env
 *   so a healthy host with working UDP/53 (production) doesn't
 *   activate it. Dev/local containers that lack UDP/53 enable it via
 *   compose env.
 */

import net from 'node:net';
import dnsModule from 'node:dns';
import { logger } from '@/utils/logger';
import { narrowAs } from '@/utils/type-guards';

const log = logger.child({ component: 'tcp-dns-resolver' });

interface DNSAnswer {
  type: number; // 1=A, 28=AAAA, 5=CNAME
  rdata: Buffer;
}

interface DNSResponse {
  rcode: number;
  answers: DNSAnswer[];
}

// ─── Wire format helpers ─────────────────────────────────────────────────

function encodeName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split('.')) {
    if (label.length === 0) continue;
    if (label.length > 63) throw new Error(`label too long: ${label}`);
    parts.push(Buffer.from([label.length]));
    parts.push(Buffer.from(label, 'ascii'));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function encodeQuery(name: string, qtype: number, id: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // standard query, RD=1
  header.writeUInt16BE(1, 4); // QDCOUNT
  const qname = encodeName(name);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);
  tail.writeUInt16BE(1, 2); // CLASS=IN
  return Buffer.concat([header, qname, tail]);
}

/**
 * Skip a DNS name (which may use compression pointers).
 * Returns the byte offset right after the name.
 */
function skipName(msg: Buffer, offset: number): number {
  while (offset < msg.length) {
    const len = msg[offset]!;
    if (len === 0) return offset + 1;
    if ((len & 0xc0) === 0xc0) return offset + 2; // pointer (2 bytes total)
    offset += len + 1;
  }
  return offset;
}

function parseResponse(msg: Buffer): DNSResponse {
  if (msg.length < 12) return { rcode: 2, answers: [] }; // SERVFAIL
  const flags = msg.readUInt16BE(2);
  const rcode = flags & 0x0f;
  const ancount = msg.readUInt16BE(6);
  // Skip header + question
  let off = 12;
  off = skipName(msg, off);
  off += 4; // qtype + qclass
  const answers: DNSAnswer[] = [];
  for (let i = 0; i < ancount && off < msg.length; i++) {
    off = skipName(msg, off);
    if (off + 10 > msg.length) break;
    const type = msg.readUInt16BE(off);
    const rdlen = msg.readUInt16BE(off + 8);
    off += 10;
    const rdata = msg.slice(off, off + rdlen);
    off += rdlen;
    answers.push({ type, rdata });
  }
  return { rcode, answers };
}

// ─── TCP client ──────────────────────────────────────────────────────────

interface TcpDnsConfig {
  servers: string[];
  /** Per-server timeout (ms) before failing over to the next server. */
  timeoutMs?: number;
  /** Total tries across all servers before giving up. */
  tries?: number;
}

let nextQueryId = 1;

function tryServer(server: string, packet: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: server, port: 53, timeout: timeoutMs });
    let chunks: Buffer[] = [];
    let totalLen = -1;
    let received = 0;
    const done = (err: Error | null, result?: Buffer) => {
      sock.destroy();
      if (err) reject(err);
      else if (result) resolve(result);
    };
    sock.on('connect', () => {
      sock.write(packet);
    });
    sock.on('data', (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (totalLen < 0 && received >= 2) {
        const buf = Buffer.concat(chunks);
        totalLen = buf.readUInt16BE(0);
      }
      if (totalLen > 0 && received >= 2 + totalLen) {
        const buf = Buffer.concat(chunks);
        done(null, buf.slice(2, 2 + totalLen));
      }
    });
    sock.on('error', (e) => done(e));
    sock.on('timeout', () => done(new Error(`TCP DNS timeout (${server})`)));
    sock.on('close', (hadError) => {
      if (!hadError && totalLen <= 0) {
        done(new Error(`TCP DNS connection closed before response (${server})`));
      }
    });
  });
}

export class TcpDnsResolver {
  private servers: string[];
  private timeoutMs: number;
  private tries: number;
  // Simple positive cache so we don't hammer 8.8.8.8 on every fetch.
  private cache = new Map<string, { addresses: { address: string; family: 4 | 6 }[]; expiresAt: number }>();

  constructor(cfg: TcpDnsConfig) {
    this.servers = cfg.servers;
    this.timeoutMs = cfg.timeoutMs ?? 5000;
    this.tries = cfg.tries ?? 2;
  }

  /**
   * Resolve `hostname` to one or more A/AAAA addresses. Tries each
   * configured server in order, with up to `tries` total attempts.
   */
  async lookup(hostname: string): Promise<{ address: string; family: 4 | 6 }[]> {
    // Cache hit?
    const cached = this.cache.get(hostname);
    if (cached && cached.expiresAt > Date.now()) return cached.addresses;

    const addresses: { address: string; family: 4 | 6 }[] = [];
    let attempts = 0;
    let lastErr: Error | null = null;
    for (const qtype of [1, 28] as const) {
      if (attempts >= this.tries) break;
      for (const server of this.servers) {
        if (attempts >= this.tries) break;
        attempts += 1;
        const id = (nextQueryId++) & 0xffff;
        const packet = (() => {
          const q = encodeQuery(hostname, qtype, id);
          const len = Buffer.alloc(2);
          len.writeUInt16BE(q.length, 0);
          return Buffer.concat([len, q]);
        })();
        try {
          const msg = await tryServer(server, packet, this.timeoutMs);
          const resp = parseResponse(msg);
          if (resp.rcode === 0) {
            for (const ans of resp.answers) {
              if (qtype === 1 && ans.type === 1 && ans.rdata.length === 4) {
                addresses.push({
                  address: `${ans.rdata[0]}.${ans.rdata[1]}.${ans.rdata[2]}.${ans.rdata[3]}`,
                  family: 4,
                });
              } else if (qtype === 28 && ans.type === 28 && ans.rdata.length === 16) {
                const parts: string[] = [];
                for (let k = 0; k < 16; k += 2) {
                  parts.push(ans.rdata.readUInt16BE(k).toString(16));
                }
                addresses.push({ address: parts.join(':'), family: 6 });
              }
            }
            break; // got a successful response from this server; try next qtype
          } else if (resp.rcode === 3) {
            // NXDOMAIN — definitive, no point trying other servers
            break;
          }
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          log.debug({ server, hostname, err: lastErr.message }, 'TCP DNS server failed; trying next');
        }
      }
    }

    if (addresses.length === 0) {
      const err = new Error(`TCP DNS: no addresses for ${hostname}${lastErr ? ` (${lastErr.message})` : ''}`);
      // Mark as ENOTFOUND so undici/clients treat it like a normal DNS failure
      (err as NodeJS.ErrnoException).code = 'ENOTFOUND';
      throw err;
    }

    // Cache for 60s — short enough that real DNS changes propagate.
    this.cache.set(hostname, { addresses, expiresAt: Date.now() + 60_000 });
    return addresses;
  }

  /**
   * undici/dns-compatible lookup signature.
   *
   * Matches Node's `dns.lookup` overload that undici's LookupFunction
   * expects: callback may be passed as the 2nd or 3rd argument; options
   * carry `family` (number | 'IPv4' | 'IPv6') and `all` (boolean).
   *
   * Local-name fast path:
   *   When hostname is `localhost`, an IP literal, or matches a Docker
   *   internal name (`postgres`, `redis`, container-id-style hex), we
   *   skip TCP-DNS and resolve directly. TCP-DNS to 8.8.8.8 doesn't
   *   know about /etc/hosts or container internal DNS, so without this
   *   the experiment-runner's `fetch('http://localhost:3000/...')` would
   *   fail with ENOTFOUND. The original Node dns.lookup is preserved
   *   under a Symbol so we can defer to it here.
   */
  lookupCb = (
    hostname: string,
    optionsOrCallback: unknown,
    maybeCallback?: unknown,
  ): void => {
    // 1. IP literal — no DNS needed.
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.includes(':')) {
      const family = hostname.includes(':') ? 6 : 4;
      const cb = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as (
        e: NodeJS.ErrnoException | null,
        a?: string | { address: string; family: 4 | 6 }[],
        f?: number,
      ) => void;
      const opts = typeof optionsOrCallback === 'object' && optionsOrCallback !== null
        ? optionsOrCallback as { all?: boolean }
        : {};
      if (opts.all) cb(null, [{ address: hostname, family }]);
      else cb(null, hostname, family);
      return;
    }
    // 2. Local hostnames + internal docker bridge names — defer to
    //    the original dns.lookup which honours /etc/hosts and Docker's
    //    embedded resolver. Without this fallback, localhost / redis /
    //    postgres / ci-api etc. would all hit TCP-DNS-to-8.8.8.8 and
    //    either NXDOMAIN or get the public-internet record (wrong).
    const isLocalName = (
      hostname === 'localhost'
      || hostname === 'localhost.localdomain'
      || /^[a-z0-9_-]+$/i.test(hostname) // single-label name (no dots)
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
    );
    if (isLocalName) {
      const ORIG = Symbol.for('ailin.network.original-dns-lookup');
      const dnsAny = narrowAs<{ [k: symbol]: unknown }>(dnsModule);
      const original = dnsAny[ORIG] as ((...args: unknown[]) => void) | undefined;
      if (original) {
        return original(hostname, optionsOrCallback as never, maybeCallback as never);
      }
    }

    const cb = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as (
      err: NodeJS.ErrnoException | null,
      address?: string | { address: string; family: 4 | 6 }[],
      family?: number,
    ) => void;
    const optsRaw = typeof optionsOrCallback === 'object' && optionsOrCallback !== null
      ? optionsOrCallback as { family?: number | string; all?: boolean }
      : {};

    let wantFamily: 4 | 6 | undefined;
    if (optsRaw.family === 4 || optsRaw.family === 'IPv4') wantFamily = 4;
    else if (optsRaw.family === 6 || optsRaw.family === 'IPv6') wantFamily = 6;

    this.lookup(hostname)
      .then((addresses) => {
        const filtered = wantFamily ? addresses.filter((a) => a.family === wantFamily) : addresses;
        if (filtered.length === 0) {
          const err = new Error(`No address (family=${optsRaw.family ?? 'any'})`) as NodeJS.ErrnoException;
          err.code = 'ENOTFOUND';
          cb(err);
          return;
        }
        if (optsRaw.all) {
          cb(null, filtered);
        } else {
          cb(null, filtered[0]!.address, filtered[0]!.family);
        }
      })
      .catch((err) => cb(err as NodeJS.ErrnoException));
  };
}
