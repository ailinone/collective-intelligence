// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.3 — OpenRouter non-billable probe.
 *
 * OpenRouter exposes `GET /api/v1/credits` (alias `/api/v1/auth/key`)
 * that returns the API key's remaining credits without consuming any
 * tokens. The endpoint is documented as non-billable (no charge per
 * call). Response shape:
 *
 *   { data: { total_credits: number, total_usage: number, ... } }
 *
 * Probe contract:
 *   - 200 + balance > 0  → auth_ok + has_credits
 *   - 200 + balance <= 0 → auth_ok + no_credits
 *   - 401                → auth_failed
 *   - 429                → rate_limited
 *   - other / network    → unknown
 *
 * No tokens generated. No chat completions. Safe.
 */
import type { ProviderProbe } from '../provider-probe-registry';

export interface OpenRouterProbeOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createOpenRouterProbe(opts: OpenRouterProbeOptions = {}): ProviderProbe {
  const baseUrl = opts.baseUrl ?? 'https://openrouter.ai';
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  return {
    providerId: 'openrouter',
    endpointType: 'balance',
    billableRisk: 'none',
    async probe({ timeoutMs }) {
      const t0 = Date.now();
      if (!apiKey) {
        return {
          liveOperabilityState: 'auth_failed',
          observedAt: Date.now(),
          latencyMs: 0,
          error: 'OPENROUTER_API_KEY not configured',
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/v1/credits`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
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
        let totalCredits = 0;
        let totalUsage = 0;
        try {
          const body = (await res.json()) as {
            data?: { total_credits?: number; total_usage?: number };
          };
          totalCredits = Number(body.data?.total_credits ?? 0);
          totalUsage = Number(body.data?.total_usage ?? 0);
        } catch {
          return {
            liveOperabilityState: 'unknown',
            observedAt: Date.now(),
            latencyMs,
            error: 'response_not_parseable',
          };
        }
        const balanceUsd = totalCredits - totalUsage;
        return {
          liveOperabilityState: 'healthy',
          liveBalanceStatus: balanceUsd > 0 ? 'has_credits' : 'no_credits',
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
