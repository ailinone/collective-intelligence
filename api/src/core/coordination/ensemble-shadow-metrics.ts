// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Prometheus metrics for the Phase 2c shadow-ensemble wire.
 *
 * Why a dedicated module instead of inline `Counter.inc()` calls in the
 * shadow runner: keeps the metric-name namespace centralized, makes the
 * dashboard query targets explicit, and gives `resetMetrics()` (used in
 * tests) a single place to scope.
 *
 * Metrics emitted:
 *
 *   coord_ensemble_shadow_calls_total{strategy, decisionType, kind}
 *     Count of shadow calls. `kind` is one of:
 *       success | disabled | timeout | error
 *     Use this to alert on `kind=error` rate spikes (coord-serving down)
 *     or `kind=timeout` (coord-serving slow).
 *
 *   coord_ensemble_shadow_role_match_total{strategy, decisionType, match}
 *     Count of shadow vs heuristic role agreement. `match` is "true" or
 *     "false". Only incremented for kind=success calls — the others have
 *     no shadow role to compare. Use the rate ratio as the live
 *     "ensemble-vs-heuristic accuracy" SLI.
 *
 *   coord_ensemble_shadow_latency_seconds{strategy, decisionType}
 *     Histogram of end-to-end shadow latency (fetch + parse + log).
 *     Bucket boundaries cover the typical mock-cascade range (<10ms)
 *     and the tail when coord-serving is under load (~5s timeout cap).
 *
 *   coord_ensemble_shadow_confidence
 *     Histogram of the ensemble's winner-share confidence per success
 *     call. Shape of this distribution tells us whether the cascade is
 *     short-circuiting too aggressively (left-skewed at 1.0) or never
 *     converging (centered around 0.5).
 *
 * Naming: prefix `coord_ensemble_shadow_` so a single Grafana panel
 * query (`coord_ensemble_shadow_*`) brings everything related into one
 * dashboard row.
 */

import promClient from 'prom-client';
import type { ShadowEnsembleSnapshot } from './ensemble-coordinator-shadow';

function getOrCreate<T extends promClient.Metric>(name: string, createFn: () => T): T {
  const existing = promClient.register.getSingleMetric(name);
  if (existing) return existing as T;
  return createFn();
}

const shadowCallsTotal = getOrCreate(
  'coord_ensemble_shadow_calls_total',
  () =>
    new promClient.Counter({
      name: 'coord_ensemble_shadow_calls_total',
      help: 'Total Phase 2c shadow-ensemble calls, labeled by outcome kind.',
      labelNames: ['strategy', 'decisionType', 'kind'],
    }),
);

const shadowRoleMatchTotal = getOrCreate(
  'coord_ensemble_shadow_role_match_total',
  () =>
    new promClient.Counter({
      name: 'coord_ensemble_shadow_role_match_total',
      help: 'Shadow vs heuristic role agreement (success calls only).',
      labelNames: ['strategy', 'decisionType', 'match'],
    }),
);

const shadowLatencySeconds = getOrCreate(
  'coord_ensemble_shadow_latency_seconds',
  () =>
    new promClient.Histogram({
      name: 'coord_ensemble_shadow_latency_seconds',
      help: 'End-to-end shadow call latency.',
      labelNames: ['strategy', 'decisionType'],
      // Mock-cascade hits <10ms in steady-state; teacher-proxy hits 1-3s.
      // Keep the long tail bucket below the 5s default timeoutMs.
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0],
    }),
);

const shadowConfidence = getOrCreate(
  'coord_ensemble_shadow_confidence',
  () =>
    new promClient.Histogram({
      name: 'coord_ensemble_shadow_confidence',
      help: 'Winner-share confidence distribution from successful shadow calls.',
      labelNames: ['strategy', 'decisionType'],
      buckets: [0.1, 0.25, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99],
    }),
);

/**
 * Single entry point — strategies pass the snapshot from
 * `onShadowResult`, this module records every relevant metric. Pure
 * function: no side effects beyond the prom-client global registry.
 */
export function recordShadowMetrics(
  strategy: string,
  decisionType: string,
  snapshot: ShadowEnsembleSnapshot,
): void {
  const labels = { strategy, decisionType };

  shadowCallsTotal.inc({ ...labels, kind: snapshot.kind });

  // Latency is meaningful for success/timeout/error; disabled records
  // a 0ms which is noise. Skip those to keep the histogram clean.
  if (snapshot.kind !== 'disabled') {
    shadowLatencySeconds.observe(labels, snapshot.latencyMs / 1000);
  }

  if (snapshot.kind === 'success') {
    if (snapshot.confidence !== undefined) {
      shadowConfidence.observe(labels, snapshot.confidence);
    }
    if (snapshot.divergence) {
      shadowRoleMatchTotal.inc({
        ...labels,
        match: snapshot.divergence.sameRole ? 'true' : 'false',
      });
    }
  }
}
