// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.3 — Ollama non-billable probe.
 *
 * Ollama runs locally. The `GET /api/tags` endpoint lists installed
 * models and is:
 *   - non-billable (local)
 *   - no auth required (default)
 *   - returns 200 + models JSON when running
 *   - returns connection-refused / ENOTFOUND when not running
 *
 * No tokens generated. No request charged. Safe to probe at any time.
 *
 * Probe contract:
 *   - `200 + non-empty list` → healthy, has_credits (local = effectively
 *     unlimited as long as the daemon runs)
 *   - `200 + empty list`     → healthy but no models pulled
 *   - any non-2xx / network error → auth_failed (interpreted as
 *     "endpoint unreachable" — provider not usable right now)
 */
import type { ProviderProbe } from '../provider-probe-registry';

export interface OllamaProbeOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createOllamaProbe(opts: OllamaProbeOptions = {}): ProviderProbe {
  const baseUrl = opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  return {
    providerId: 'ollama',
    endpointType: 'models',
    billableRisk: 'none',
    async probe({ timeoutMs }) {
      const t0 = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
          method: 'GET',
          signal: controller.signal,
        });
        const latencyMs = Date.now() - t0;
        if (!res.ok) {
          return {
            liveOperabilityState: 'auth_failed',
            observedAt: Date.now(),
            latencyMs,
            error: `HTTP ${res.status}`,
          };
        }
        // 200 — Ollama is reachable. Parse to check if any models exist.
        let modelCount = 0;
        try {
          const body = (await res.json()) as { models?: unknown[] };
          modelCount = Array.isArray(body.models) ? body.models.length : 0;
        } catch {
          // Body parse failure — treat as unhealthy
          return {
            liveOperabilityState: 'unknown',
            observedAt: Date.now(),
            latencyMs,
            error: 'response_not_parseable',
          };
        }
        return {
          liveOperabilityState: 'healthy',
          liveBalanceStatus: modelCount > 0 ? 'has_credits' : 'unknown',
          liveRateState: 'ok',
          observedAt: Date.now(),
          latencyMs,
        };
      } catch (err) {
        return {
          liveOperabilityState: 'auth_failed',
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
