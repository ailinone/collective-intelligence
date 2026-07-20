// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.3 — generic `GET /v1/models` non-billable probe.
 *
 * Many OpenAI-compatible providers expose `GET /v1/models` to list
 * available models. The endpoint requires auth but doesn't generate
 * tokens — it's the standard "is my key valid + what can I run"
 * check used by SDKs at boot.
 *
 * Providers known to support this safely: OpenAI, Anthropic (via
 * `/v1/models`), AIHubMix, CometAPI, Mistral, Together, Fireworks,
 * Groq, DeepInfra, OpenAI-compatible hub adapters generally.
 *
 * Probe contract:
 *   - 200 + non-empty list → auth_ok + has_credits
 *     (we infer has_credits because most providers return 401 when
 *      keys are revoked AND 402 when account has no balance — so if
 *      models list returns 200, account is in good standing.)
 *   - 200 + empty list     → auth_ok + unknown credits (rare; some
 *                            providers list models even for revoked
 *                            keys at certain tiers)
 *   - 401 / 403            → auth_failed
 *   - 402                  → no_credits
 *   - 429                  → rate_limited
 *   - other                → unknown
 */
import type { ProviderProbe } from '../provider-probe-registry';

export interface GenericListModelsProbeOptions {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Custom auth header name if not `Authorization: Bearer ...`. */
  readonly authHeaderName?: string;
  /** Custom auth header value formatter. Default: `Bearer ${apiKey}`. */
  readonly authHeaderValue?: (apiKey: string) => string;
  readonly modelsPath?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createGenericListModelsProbe(
  opts: GenericListModelsProbeOptions,
): ProviderProbe {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const headerName = opts.authHeaderName ?? 'Authorization';
  const headerValue = opts.authHeaderValue ?? ((k: string) => `Bearer ${k}`);
  const modelsPath = opts.modelsPath ?? '/v1/models';
  return {
    providerId: opts.providerId,
    endpointType: 'models',
    billableRisk: 'none',
    async probe({ timeoutMs }) {
      const t0 = Date.now();
      if (!opts.apiKey) {
        return {
          liveOperabilityState: 'auth_failed',
          observedAt: Date.now(),
          latencyMs: 0,
          error: `${opts.providerId} probe: api key missing`,
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${opts.baseUrl.replace(/\/+$/, '')}${modelsPath}`, {
          method: 'GET',
          headers: { [headerName]: headerValue(opts.apiKey) },
          signal: controller.signal,
        });
        const latencyMs = Date.now() - t0;
        if (res.status === 401 || res.status === 403) {
          return {
            liveOperabilityState: 'auth_failed',
            observedAt: Date.now(),
            latencyMs,
            error: `HTTP ${res.status}`,
          };
        }
        if (res.status === 402) {
          return {
            liveOperabilityState: 'no_credits',
            liveBalanceStatus: 'no_credits',
            observedAt: Date.now(),
            latencyMs,
            error: 'HTTP 402',
          };
        }
        if (res.status === 429) {
          return {
            liveOperabilityState: 'rate_limited',
            liveRateState: 'rate_limited',
            observedAt: Date.now(),
            latencyMs,
            error: 'HTTP 429',
          };
        }
        if (!res.ok) {
          return {
            liveOperabilityState: 'unknown',
            observedAt: Date.now(),
            latencyMs,
            error: `HTTP ${res.status}`,
          };
        }
        let count = 0;
        try {
          const body = (await res.json()) as { data?: unknown[] };
          count = Array.isArray(body.data) ? body.data.length : 0;
        } catch {
          // Some providers return non-JSON. Treat 200 as auth_ok regardless.
          count = 0;
        }
        return {
          liveOperabilityState: 'healthy',
          // 200 indicates auth is valid; most providers refuse list-models
          // with no balance via 402. Listing OK = credits OK (best-effort).
          liveBalanceStatus: count > 0 ? 'has_credits' : 'unknown',
          liveRateState: 'ok',
          observedAt: Date.now(),
          latencyMs,
        };
      } catch (err) {
        return {
          liveOperabilityState: 'unknown',
          observedAt: Date.now(),
          latencyMs: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
