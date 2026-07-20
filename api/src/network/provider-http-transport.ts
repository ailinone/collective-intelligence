// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderHttpTransport — the single transport that every provider
 * adapter / SDK should consume.
 *
 * Background (2026-05-11):
 *   The TCP-DNS fallback (`installTcpDnsFallback`) successfully patched:
 *     - undici `setGlobalDispatcher` (covers `globalThis.fetch`)
 *     - http/https `globalAgent.options.lookup`
 *     - `dns.lookup` (best-effort monkey-patch)
 *   That made `fetch('https://...')` work from the API process (preflight
 *   passes 5/5 hosts). BUT the Anthropic SDK (`@anthropic-ai/sdk@0.18`) and
 *   OpenAI SDK (`openai@4.x`) bring their own HTTP machinery — even when
 *   they internally call `fetch`, the SDK captures a reference at module
 *   load time, and some helpers (like file uploads) use Node's stdlib
 *   `https.request` directly with a default Agent that DOESN'T inherit
 *   our patched lookup.
 *
 *   The fix: hand each SDK that supports it an explicit `fetch` function
 *   that we know respects the global dispatcher. The SDKs accept a
 *   `fetch?: Fetch` option in their constructors — we just need to wire
 *   it through the adapter chain.
 *
 *   This module is the ONE place that builds that fetch. Adapters import
 *   `getProviderHttpTransport()` and pass `transport.fetch` to their SDK.
 */

/**
 * Minimal fetch type. Matches Node's `globalThis.fetch` and what the
 * OpenAI/Anthropic SDKs declare for their `fetch?` option.
 */
export type ProviderFetch = typeof fetch;

export interface ProviderHttpTransport {
  /** A fetch function guaranteed to use the patched global dispatcher. */
  fetch: ProviderFetch;
  /** Free-form description so logs / preflight can report which transport an adapter used. */
  description: string;
}

/**
 * Build a transport bound to whatever global fetch was when this module
 * loaded — important because we capture `globalThis.fetch` AFTER the
 * bootstrap has run `setGlobalDispatcher`. Adapters that take this
 * transport in their constructor will keep using it even if a later
 * caller mutates `globalThis.fetch` (rare, but defensive).
 */
function buildTransport(): ProviderHttpTransport {
  // Capture global fetch (already wired to TCP-DNS dispatcher by
  // dns-bootstrap.ts when DNS_TCP_FALLBACK_SERVERS is set).
  // We wrap it so every call goes through the same surface, which
  // makes a future swap (e.g. injecting metrics or per-provider
  // timeout overrides) trivial.
  const captured = globalThis.fetch.bind(globalThis);
  const wrapped: ProviderFetch = ((input, init) => captured(input, init)) as ProviderFetch;
  return {
    fetch: wrapped,
    description: 'global_undici_dispatcher_with_tcp_dns_fallback',
  };
}

let instance: ProviderHttpTransport | null = null;

export function getProviderHttpTransport(): ProviderHttpTransport {
  if (!instance) instance = buildTransport();
  return instance;
}

/**
 * Test-only: reset the captured transport. Don't call this from
 * production code.
 */
export function _resetProviderHttpTransportForTesting(): void {
  instance = null;
}
