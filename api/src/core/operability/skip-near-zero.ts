// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Near-zero skip — the hot-path predicate that prevents HTTP calls to
 * known-bad providers/models within their cooldown window.
 *
 * Performance contract:
 *   - O(1) lookup (Map.get on the registry).
 *   - No I/O, no async, no allocation in the negative path.
 *   - Target p99 latency: < 1ms. Worst-case: <5ms (verified by test).
 *
 * Decision logic:
 *
 *   1. Look up the (providerId, modelId) tuple. If absent, fall back to
 *      provider-level record. If neither exists → skip=false (unknown,
 *      let the request proceed and learn from the outcome).
 *
 *   2. If state is "fatal" (auth_failed, insufficient_credit,
 *      endpoint_not_found, model_not_found, permanently_disabled) AND
 *      `Date.now() < nextProbeAfter` → skip=true.
 *
 *   3. If state is `rate_limited` AND within cooldown → skip=true with
 *      `nextProbeAfter` so the caller can wait or fall back.
 *
 *   4. If state is `timeout_suspected` and within short cooldown →
 *      skip=true (penalize transient outages briefly).
 *
 *   5. After `nextProbeAfter` has elapsed, return skip=false even if the
 *      record is still in a fatal state — this allows reprobe. The caller
 *      that triggers the reprobe is responsible for updating the record
 *      via `recordExecution()` so a successful retry transitions the
 *      record back to `healthy`.
 */

import {
  type HealthKey,
  type ProviderHealthState,
  type SkipDecision,
} from './types';
import {
  getProviderHealthRegistry,
  type ProviderHealthRegistry,
} from './provider-health-registry';
import {
  METRIC_NAMES,
  incrementCounter,
  observeHistogram,
} from './metrics';

// ─── State classification ──────────────────────────────────────────────────

/**
 * States that always trigger skip while within the cooldown window.
 * These represent failures that won't clear without operator action
 * (auth, credit, config) or are inherently model-specific.
 */
const FATAL_STATES: ReadonlySet<ProviderHealthState> = new Set([
  'auth_failed',
  'insufficient_credit',
  'endpoint_not_found',
  'model_not_found',
  'permanently_disabled',
] as ProviderHealthState[]);

/**
 * States that trigger skip with a shorter cooldown — provider may recover
 * naturally without operator action.
 */
const TRANSIENT_SKIP_STATES: ReadonlySet<ProviderHealthState> = new Set([
  'rate_limited',
  'timeout_suspected',
  'temporarily_disabled',
] as ProviderHealthState[]);

// ─── Decision function ─────────────────────────────────────────────────────

export interface ShouldSkipNearZeroOptions {
  /** Override the registry (used by tests). */
  registry?: ProviderHealthRegistry;
  /** Override Date.now(). */
  now?: number;
  /** Skip telemetry emission. Default false. */
  silent?: boolean;
}

/**
 * Determines whether a provider/model tuple should be skipped without
 * making an HTTP call. Pure decision, side-effect = telemetry only.
 */
export function shouldSkipNearZero(
  key: HealthKey,
  options: ShouldSkipNearZeroOptions = {},
): SkipDecision {
  const t0 = performance.now();
  const registry = options.registry ?? getProviderHealthRegistry();
  const now = options.now ?? Date.now();

  const record = registry.lookup(key);
  if (!record) {
    if (!options.silent) {
      observeHistogram(METRIC_NAMES.KNOWN_BAD_SKIP_LATENCY_MS, performance.now() - t0, {
        outcome: 'unknown',
      });
    }
    return { skip: false, reason: 'unknown_health', latencyClass: 'near_zero' };
  }

  const isFatal = FATAL_STATES.has(record.state);
  const isTransientSkip = TRANSIENT_SKIP_STATES.has(record.state);

  if (!isFatal && !isTransientSkip) {
    if (!options.silent) {
      observeHistogram(METRIC_NAMES.KNOWN_BAD_SKIP_LATENCY_MS, performance.now() - t0, {
        outcome: 'allowed',
        state: record.state,
      });
    }
    return { skip: false, latencyClass: 'near_zero' };
  }

  const nextProbeMs = record.nextProbeAfter ? Date.parse(record.nextProbeAfter) : 0;
  const withinCooldown = nextProbeMs > now;

  if (!withinCooldown) {
    // Cooldown elapsed — allow reprobe.
    if (!options.silent) {
      observeHistogram(METRIC_NAMES.KNOWN_BAD_SKIP_LATENCY_MS, performance.now() - t0, {
        outcome: 'cooldown_elapsed',
        state: record.state,
      });
    }
    return { skip: false, reason: `cooldown_elapsed:${record.state}`, latencyClass: 'near_zero' };
  }

  if (!options.silent) {
    incrementCounter(METRIC_NAMES.KNOWN_BAD_SKIP_TOTAL, {
      providerId: key.providerId,
      reason: record.state,
    });
    observeHistogram(METRIC_NAMES.KNOWN_BAD_SKIP_LATENCY_MS, performance.now() - t0, {
      outcome: 'skipped',
      state: record.state,
    });
  }

  return {
    skip: true,
    reason: record.state,
    cachedAt: record.lastFailureAt ?? record.lastProbeAt,
    nextProbeAfter: record.nextProbeAfter,
    latencyClass: 'near_zero',
  };
}

/**
 * Telemetry-only helper: records that an HTTP call was made for a key.
 * Used to detect the `dead_provider_http_attempt_total` regression — this
 * counter MUST stay near zero in steady state. If it climbs, near-zero skip
 * is being bypassed somewhere in the pipeline.
 */
export function recordDeadProviderHttpAttempt(key: HealthKey, reason: string): void {
  incrementCounter(METRIC_NAMES.DEAD_PROVIDER_HTTP_ATTEMPT_TOTAL, {
    providerId: key.providerId,
    modelId: key.modelId ?? '',
    reason,
  });
}
