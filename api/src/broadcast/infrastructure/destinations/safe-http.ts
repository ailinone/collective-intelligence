// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SSRF-safe HTTP fetch — resolves the target hostname and refuses to connect
 * if the IP is private, loopback, link-local, or in a metadata range.
 *
 * This is the egress guard every user-supplied URL in the Broadcast pipeline
 * MUST pass through (webhook adapter, Langfuse self-hosted, OTLP collector,
 * custom Datadog site). OpenRouter's equivalent is "broadcast_url_validator".
 *
 * Threat model:
 *   A tenant configures a destination URL. They could try to:
 *     1. Pivot to internal services (http://10.0.0.5/admin)
 *     2. Read cloud metadata (http://169.254.169.254/latest/meta-data)
 *     3. Read localhost (http://127.0.0.1/debug)
 *     4. Read IPv6 metadata (http://[fd00:ec2::254]/)
 *     5. Use a DNS-rebinding payload (resolve public IP on first lookup,
 *        private IP on second) — a.k.a. TOCTOU attack
 *
 * Defenses (DNS-pinned):
 *   - DNS is resolved ONCE, up front. The resolved IP is validated against
 *     the denylist.
 *   - That IP is then HARD-PINNED into undici's connect path via a custom
 *     `lookup` callback on a per-request Agent: the TCP connect goes to
 *     the pre-validated IP, not to whatever DNS returns at connect time.
 *     TLS SNI + cert validation remain bound to the original hostname.
 *     This closes the rebinding window.
 *   - All resolved addresses are validated (multi-homed hosts can't slip
 *     through via a public+private mix).
 *   - Redirects are followed manually: each hop re-resolves + re-pins.
 *   - Max response body size is bounded.
 *
 * Escape hatch:
 *   `BROADCAST_EGRESS_ALLOW_PRIVATE=true` skips the IP check. Intended ONLY
 *   for local testing against a self-hosted service. NEVER set in production.
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { promisify } from 'node:util';
import { Agent, fetch as undiciFetch } from 'undici';

import { broadcastMetrics } from '@/broadcast/infrastructure/metrics/broadcast-metrics';

const dnsLookupAsync = promisify(dnsLookup) as (
  hostname: string,
  options?: { all: true },
) => Promise<LookupAddress[]>;

// ─── Config ─────────────────────────────────────────────────────────────

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1 * 1024 * 1024; // 1 MiB
export const DEFAULT_MAX_REDIRECTS = 3;

// ─── Errors ─────────────────────────────────────────────────────────────

export class EgressBlockedError extends Error {
  constructor(
    public readonly reason:
      | 'scheme_blocked'
      | 'host_resolution_failed'
      | 'ip_blocked'
      | 'too_many_redirects'
      | 'body_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'EgressBlockedError';
    // Bump the counter at construction time — this is the moment the guard
    // fires, regardless of where we eventually throw/rethrow.
    try {
      broadcastMetrics.egressBlocked.inc({ reason });
    } catch {
      /* metric emission must never break the guard flow */
    }
  }
}

// ─── IP classification ──────────────────────────────────────────────────

/**
 * Returns true if the given IP address is a "forbidden" destination — private,
 * loopback, link-local, unspecified, multicast, or a known cloud-metadata
 * address. The check runs on both IPv4 and IPv6.
 */
export function isForbiddenIp(ip: string): boolean {
  // IPv6 — handle first because IPv4-mapped addresses come as ::ffff:1.2.3.4
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true; // unspecified, loopback
    if (lower.startsWith('fe80:')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('ff')) return true; // multicast
    // IPv4-mapped: ::ffff:a.b.c.d — extract and re-check
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isForbiddenIp(mapped[1]!);
    // Known cloud metadata over IPv6 (GCP + AWS IMDSv2 IPv6)
    if (lower === 'fd00:ec2::254') return true;
    return false;
  }

  // IPv4
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    // Malformed — fail closed.
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local + metadata (AWS/GCP)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224 && a <= 239) return true; // multicast /4 (224.0.0.0/4)
  if (a >= 240) return true; // reserved + broadcast
  return false;
}

// ─── URL validation ─────────────────────────────────────────────────────

interface ValidatedTarget {
  /** Original URL (hostname preserved for TLS SNI and Host header). */
  url: URL;
  /** Pre-resolved, denylist-validated IP to pin the TCP connect to. */
  ip: string;
  /** Numeric IP family for the `lookup` callback contract (4 or 6). */
  family: 4 | 6;
}

async function validateUrl(rawUrl: string): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressBlockedError('scheme_blocked', `invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EgressBlockedError('scheme_blocked', `scheme not allowed: ${url.protocol}`);
  }

  const allowPrivate = process.env.BROADCAST_EGRESS_ALLOW_PRIVATE === 'true';

  // If the URL already carries a literal IP (bracketed IPv6 or dotted IPv4),
  // no DNS call is needed. This is also the path that prevents DNS from being
  // a side-channel at all.
  const literalIp = tryParseLiteralIp(url.hostname);
  if (literalIp) {
    if (!allowPrivate && isForbiddenIp(literalIp.ip)) {
      throw new EgressBlockedError(
        'ip_blocked',
        `hostname ${url.hostname} is forbidden literal IP`,
      );
    }
    return { url, ip: literalIp.ip, family: literalIp.family };
  }

  // Resolve ALL addresses — multi-homed hosts shouldn't slip through.
  let addrs: LookupAddress[];
  try {
    addrs = await dnsLookupAsync(url.hostname, { all: true });
  } catch (e) {
    throw new EgressBlockedError(
      'host_resolution_failed',
      `DNS lookup failed for ${url.hostname}: ${(e as Error).message}`,
    );
  }
  if (addrs.length === 0) {
    throw new EgressBlockedError('host_resolution_failed', `no addresses for ${url.hostname}`);
  }

  if (!allowPrivate) {
    for (const addr of addrs) {
      if (isForbiddenIp(addr.address)) {
        throw new EgressBlockedError(
          'ip_blocked',
          `hostname ${url.hostname} resolves to forbidden address ${addr.address}`,
        );
      }
    }
  }

  // Prefer IPv4 for connection — it's what most webhook receivers expect.
  const pick = addrs.find((a) => a.family === 4) ?? addrs[0]!;
  return {
    url,
    ip: pick.address,
    family: (pick.family === 6 ? 6 : 4) as 4 | 6,
  };
}

function tryParseLiteralIp(hostname: string): { ip: string; family: 4 | 6 } | null {
  // URL wraps IPv6 literals in brackets.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return { ip: hostname.slice(1, -1), family: 6 };
  }
  // Dotted-quad IPv4.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return { ip: hostname, family: 4 };
  }
  return null;
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface SafeFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  /** Total redirects followed. */
  redirects: number;
}

/**
 * The lookup callback shape Node's net.connect / undici's connect expects.
 * When `options.all === true`, the callback takes an ARRAY of LookupAddress;
 * otherwise a single (address, family) pair. Both styles are supported — we
 * detect the flag and respond correctly. Exposed for tests.
 */
export type PinnedLookup = (
  hostname: string,
  options: { all?: boolean } | unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

/**
 * Build the lookup callback that ALWAYS returns the pre-validated IP,
 * regardless of what hostname undici's internal resolver would pass in.
 * This is the heart of the rebinding defense — exported so tests can assert
 * the invariant directly without needing a DNS spy.
 */
export function buildPinnedLookup(ip: string, family: 4 | 6): PinnedLookup {
  return (_hostname, options, callback) => {
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (all) {
      callback(null, [{ address: ip, family } as LookupAddress]);
    } else {
      callback(null, ip, family);
    }
  };
}

/**
 * Build a per-request undici Agent that pins the TCP connect to the
 * pre-validated IP. The hostname on the URL is preserved so TLS SNI,
 * the `Host` header, and certificate validation all target the original
 * hostname — only the IP the socket connects to is overridden.
 */
function buildPinnedAgent(target: ValidatedTarget): Agent {
  return new Agent({
    connect: {
      lookup: buildPinnedLookup(target.ip, target.family),
    },
  });
}

/**
 * Fetch with SSRF guards, timeout, bounded body, and bounded redirects.
 *
 * Callers that already have the raw URL classified safe (e.g., an internal
 * URL from config that's never user-supplied) should use `fetch` directly.
 * Everything that comes from tenant config MUST go through this.
 */
export async function safeFetch(
  rawUrl: string,
  init: SafeFetchInit = {},
): Promise<SafeFetchResponse> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxResponseBytes = init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = init.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let currentUrl = rawUrl;
  let redirectCount = 0;

  // Bounded redirect-following loop. The body throws on
  // `redirectCount > maxRedirects`, so `redirectCount <= maxRedirects` is
  // a real loop condition (lint considers it non-constant).
  while (redirectCount <= maxRedirects) {
    const target = await validateUrl(currentUrl);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    init.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const agent = buildPinnedAgent(target);
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(target.url, {
        method: init.method ?? 'POST',
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
        // `redirect: 'manual'` is the key — we control redirect policy.
        redirect: 'manual',
        // Pins TCP connect to the pre-validated IP. Closes DNS TOCTOU.
        dispatcher: agent,
      });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
    }

    try {
      // 3xx with Location: follow manually after re-validating.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          // Degenerate redirect — return the status as-is.
          return await finalizeResponse(response, redirectCount, maxResponseBytes);
        }
        // Drain body to release the connection before we move on.
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        redirectCount += 1;
        if (redirectCount > maxRedirects) {
          throw new EgressBlockedError(
            'too_many_redirects',
            `exceeded ${maxRedirects} redirects starting at ${rawUrl}`,
          );
        }
        currentUrl = new URL(location, target.url).toString();
        continue;
      }

      return await finalizeResponse(response, redirectCount, maxResponseBytes);
    } finally {
      // Close the per-request agent. Fire-and-forget — we do not want a
      // slow close to block the hot path.
      void agent.close().catch(() => undefined);
    }
  }

  // Loop fell through without returning/throwing — should be unreachable
  // because the redirect-count guard inside the loop is identical, but
  // TypeScript and ESLint both want a definite termination.
  throw new EgressBlockedError(
    'too_many_redirects',
    `exceeded ${maxRedirects} redirects starting at ${rawUrl}`,
  );
}

async function finalizeResponse(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  redirects: number,
  maxBytes: number,
): Promise<SafeFetchResponse> {
  // Stream the body with a byte cap. `response.arrayBuffer()` can't be
  // bounded, so read via the stream.
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    let streamDone = false;
    while (!streamDone) {
      const result = await reader.read();
      streamDone = result.done;
      if (streamDone) break;
      const value: unknown = result.value;
      if (value instanceof Uint8Array) {
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw new EgressBlockedError(
            'body_too_large',
            `response body exceeded ${maxBytes} bytes`,
          );
        }
        chunks.push(value);
      }
    }
  }
  const body = Buffer.concat(chunks.map((c) => Buffer.from(c)));

  const headers: Record<string, string> = {};
  response.headers.forEach((v: string, k: string) => {
    headers[k] = v;
  });

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    redirects,
  };
}
