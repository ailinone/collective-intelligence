// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Network bootstrap — wires the TCP-DNS resolver into the global undici
 * dispatcher so `fetch` (which uses undici under the hood) resolves
 * hostnames via TCP/53 when UDP/53 is blocked.
 *
 * Activation: requires `DNS_TCP_FALLBACK_SERVERS` env to be set. Without
 * the env, this module is a no-op — production runs with normal UDP/53.
 *
 * Why this is gated:
 *   - TCP DNS adds latency (~50-200ms per lookup, vs <10ms UDP cached).
 *   - Production hosts have working UDP/53.
 *   - Only dev/local Docker Desktop containers with the UDP-block issue
 *     need this fallback.
 */

import { logger } from '@/utils/logger';
import { narrowAs } from '@/utils/type-guards';
import { TcpDnsResolver } from './tcp-dns-resolver';

const log = logger.child({ component: 'dns-bootstrap' });

let installed = false;
let resolver: TcpDnsResolver | null = null;

export interface DnsBootstrapResult {
  installed: boolean;
  reason: string;
  servers?: string[];
}

/**
 * Install TCP-DNS resolver as the global undici dispatcher lookup.
 * Idempotent — second invocation is a no-op.
 *
 * Call from index.ts boot BEFORE any HTTP traffic so the first fetch
 * uses the right resolver.
 */
export async function installTcpDnsFallback(): Promise<DnsBootstrapResult> {
  if (installed) {
    return { installed: true, reason: 'already_installed' };
  }
  const env = process.env.DNS_TCP_FALLBACK_SERVERS;
  if (!env) {
    // C3 dev fix (2026-06-09): even without a custom TCP-DNS resolver, install a global undici
    // dispatcher with a LONG keep-alive window + a real connection pool so EVERY provider fetch
    // reuses TCP+TLS. undici's default keepAliveTimeout is only ~4s, so idle sockets close between
    // calls and each request re-pays the TLS handshake (~50-200ms) — and provider calls dominate
    // orchestration latency. Idempotent via the module `installed` flag.
    try {
      const { Agent, setGlobalDispatcher } = await import('undici');
      setGlobalDispatcher(
        new Agent({
          keepAliveTimeout: 30_000,
          keepAliveMaxTimeout: 60_000,
          connections: Number(process.env.HTTP_POOL_CONNECTIONS) || 128,
          pipelining: 1,
        }),
      );
      installed = true;
      logger.info({ keepAliveTimeoutMs: 30_000, connections: Number(process.env.HTTP_POOL_CONNECTIONS) || 128 }, 'Installed global keep-alive HTTP dispatcher (no custom TCP-DNS)');
      return { installed: true, reason: 'keepalive_dispatcher_no_custom_dns' };
    } catch {
      return { installed: false, reason: 'env_DNS_TCP_FALLBACK_SERVERS_not_set' };
    }
  }
  const servers = env.split(',').map((s) => s.trim()).filter(Boolean);
  if (servers.length === 0) {
    return { installed: false, reason: 'env_empty_after_parse' };
  }

  resolver = new TcpDnsResolver({ servers, timeoutMs: 5000, tries: servers.length * 2 });

  try {
    // Wire into undici's global dispatcher so fetch uses it. We do this
    // at boot, before any fetch fires.
    const { Agent, setGlobalDispatcher } = await import('undici');
    const agent = new Agent({
      connect: {
        // The undici `connect.lookup` accepts a Node `dns.lookup`-shaped
        // function. Cast through unknown — the LookupFunction type in
        // undici uses NodeJS's looser dns LookupOptions (with
        // `family?: number | 'IPv4' | 'IPv6'`) and our normalized
        // wrapper accepts that broader shape internally.
        lookup: narrowAs<ConstructorParameters<typeof Agent>[0] extends { connect?: { lookup?: infer L } } ? L : never>(resolver.lookupCb),
      },
      // Keep idle sockets warm so subsequent fetches reuse TCP without
      // re-resolving (the cache in TcpDnsResolver also helps, but
      // connection reuse skips the lookup entirely).
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      // C3 dev fix (2026-06-09): bound the per-origin connection pool so the
      // selection/collective fan-out reuses warm sockets instead of opening many.
      connections: Number(process.env.HTTP_POOL_CONNECTIONS) || 128,
      pipelining: 1,
    });
    setGlobalDispatcher(agent);

    // Provider SDKs (OpenAI, Anthropic, etc.) typically use Node's stdlib
    // `http`/`https`, NOT undici. Setting the lookup on `globalAgent`
    // makes those connections route through our TCP-DNS resolver too.
    // This is critical when UDP/53 is blocked: without it, undici's
    // fetch works (preflight passes) but SDK calls still fail with
    // `fetch failed` from the SDK's internal http.request.
    try {
      const http = await import('node:http');
      const https = await import('node:https');
      // The Agent constructor stores options; many SDKs construct their
      // own agent. We patch BOTH the existing globalAgent options and
      // the default Agent prototype option fallback.
      // http/https Agent doesn't type-expose `options`, but the runtime
      // object has it (carried over from constructor). Cast through unknown.
      const httpAny = narrowAs<{ options?: { lookup?: unknown } }>(http.globalAgent);
      const httpsAny = narrowAs<{ options?: { lookup?: unknown } }>(https.globalAgent);
      if (httpAny && httpAny.options) httpAny.options.lookup = resolver.lookupCb;
      if (httpsAny && httpsAny.options) httpsAny.options.lookup = resolver.lookupCb;
      // Monkey-patch `dns.lookup` directly as a final safety net. Some
      // SDKs read `require('dns').lookup` per-call instead of via Agent
      // options. The original lookup is preserved on a hidden symbol so
      // we can restore in shutdown/tests if needed.
      const dns = await import('node:dns');
      const ORIG = Symbol.for('ailin.network.original-dns-lookup');
      const dnsAny = narrowAs<{ lookup: unknown; [k: symbol]: unknown }>(dns);
      if (!dnsAny[ORIG]) {
        dnsAny[ORIG] = dns.lookup;
        // Replace the lookup function on the module exports object. ES
        // module re-exports may keep a stale ref but most callers do
        // `dns.lookup(...)` dynamically.
        Object.defineProperty(dns, 'lookup', {
          value: resolver.lookupCb,
          writable: true,
          configurable: true,
        });
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) },
        'http/https globalAgent or dns.lookup patch failed (undici-only fallback in effect)');
    }

    installed = true;
    log.info({ servers }, '✅ TCP-DNS fallback installed (undici + http/https + dns.lookup)');
    return { installed: true, reason: 'env_DNS_TCP_FALLBACK_SERVERS_set', servers };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'TCP-DNS fallback install failed');
    return { installed: false, reason: `install_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Exposed so the preflight endpoint and other callers can resolve with the same path. */
export function getTcpDnsResolver(): TcpDnsResolver | null {
  return resolver;
}
