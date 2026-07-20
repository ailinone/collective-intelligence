// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Coordination Metrics
 *
 * Prometheus metrics for the coordination layer.
 * Follows the same pattern as ci-metrics.ts using prom-client.
 * Each metric is emitted at a real point in the coordination flow.
 */

import { Counter, Histogram, Gauge, Registry, register } from 'prom-client';

// Reuse the same registry as ci-metrics
let registry: Registry;
try {
  registry = register;
} catch {
  registry = new Registry();
}

type CounterConfig = ConstructorParameters<typeof Counter>[0];
type HistogramConfig = ConstructorParameters<typeof Histogram>[0];
type GaugeConfig = ConstructorParameters<typeof Gauge>[0];

function createCounter(config: CounterConfig): Counter<string> {
  const existing = registry.getSingleMetric(config.name);
  if (existing) return existing as Counter<string>;
  return new Counter({ ...config, registers: [registry] });
}

function createHistogram(config: HistogramConfig): Histogram<string> {
  const existing = registry.getSingleMetric(config.name);
  if (existing) return existing as Histogram<string>;
  return new Histogram({ ...config, registers: [registry] });
}

function createGauge(config: GaugeConfig): Gauge<string> {
  const existing = registry.getSingleMetric(config.name);
  if (existing) return existing as Gauge<string>;
  return new Gauge({ ...config, registers: [registry] });
}

// ============================================
// Round metrics
// ============================================

export const coordinationRoundCount = createHistogram({
  name: 'ci_coordination_round_count',
  help: 'Number of rounds per coordination run',
  labelNames: ['strategy', 'task_type'],
  buckets: [1, 2, 3, 4, 5],
});

export const coordinationRoundDurationMs = createHistogram({
  name: 'ci_coordination_round_duration_ms',
  help: 'Duration of each coordination round',
  labelNames: ['strategy', 'round'],
  buckets: [1000, 5000, 10000, 30000, 60000],
});

// ============================================
// Signal metrics
// ============================================

export const coordinationSignalTotal = createCounter({
  name: 'ci_coordination_signal_total',
  help: 'Total coordination signals generated',
  labelNames: ['strategy', 'model', 'valid'],
});

export const coordinationSignalParseFailures = createCounter({
  name: 'ci_coordination_signal_parse_failures_total',
  help: 'Total signal parse failures',
  labelNames: ['strategy', 'model'],
});

export const coordinationSignalConflictRate = createGauge({
  name: 'ci_coordination_signal_conflict_rate',
  help: 'Rate of conflicting signals per run',
  labelNames: ['strategy'],
});

export const coordinationSignalConfidenceAvg = createGauge({
  name: 'ci_coordination_signal_confidence_avg',
  help: 'Average confidence of signals',
  labelNames: ['strategy', 'round'],
});

// ============================================
// Convergence metrics
// ============================================

export const coordinationConvergenceScore = createGauge({
  name: 'ci_coordination_convergence_score',
  help: 'Convergence score at run completion',
  labelNames: ['strategy'],
});

export const coordinationDecisionFlipRate = createGauge({
  name: 'ci_coordination_decision_flip_rate',
  help: 'Decision flip rate between rounds',
  labelNames: ['strategy', 'round'],
});

export const coordinationModelDisagreement = createGauge({
  name: 'ci_coordination_model_disagreement',
  help: 'Inter-model disagreement at run end',
  labelNames: ['strategy'],
});

// ============================================
// State metrics
// ============================================

export const coordinationVariableCount = createGauge({
  name: 'ci_coordination_state_variable_count',
  help: 'Number of tracked variables',
  labelNames: ['strategy'],
});

export const coordinationVariableStability = createGauge({
  name: 'ci_coordination_state_variable_stability_avg',
  help: 'Average variable stability at run end',
  labelNames: ['strategy'],
});

// ============================================
// Cost & performance metrics
// ============================================

export const coordinationCostTotal = createHistogram({
  name: 'ci_coordination_cost_total_usd',
  help: 'Total cost per coordination run',
  labelNames: ['strategy'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1.0],
});

export const coordinationLatencyTotal = createHistogram({
  name: 'ci_coordination_latency_total_ms',
  help: 'Total latency per coordination run',
  labelNames: ['strategy'],
  buckets: [5000, 15000, 30000, 60000, 120000],
});

export const coordinationTokensTotal = createHistogram({
  name: 'ci_coordination_tokens_total',
  help: 'Total tokens consumed per coordination run',
  labelNames: ['strategy'],
  buckets: [1000, 5000, 10000, 25000, 50000, 100000],
});

// ============================================
// Outcome metrics
// ============================================

export const coordinationStopReason = createCounter({
  name: 'ci_coordination_stop_reason_total',
  help: 'Distribution of stop reasons',
  labelNames: ['strategy', 'reason'],
});

export const coordinationCriticalRiskCount = createCounter({
  name: 'ci_coordination_critical_risk_total',
  help: 'Total critical risks detected',
  labelNames: ['strategy'],
});

export const coordinationFallbackUsed = createCounter({
  name: 'ci_coordination_fallback_total',
  help: 'Times fallback strategy was used',
  labelNames: ['strategy', 'fallback_to'],
});

export const coordinationFinalQuality = createHistogram({
  name: 'ci_coordination_final_quality_score',
  help: 'Quality score of final coordination output',
  labelNames: ['strategy'],
  buckets: [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0],
});

// ============================================
// Trace metrics (F2.11)
// ============================================

/**
 * Spans emitted per coordination run. One sample per (strategy, phase,
 * status) bucket on every recorded run. Cardinality is bounded by the
 * fixed `CollectiveSpanPhase` enum × {ok, error, cancelled}.
 */
export const coordinationTraceSpansTotal = createCounter({
  name: 'ci_coordination_trace_spans_total',
  help: 'CollectiveTrace spans emitted, partitioned by phase + status',
  labelNames: ['strategy', 'phase', 'status'],
});

/**
 * Per-run span count distribution. Useful to alert on traces that
 * exceed the bounded `maxSpans` cap (256 by default) or that are
 * unexpectedly truncated.
 */
export const coordinationTraceSpansPerRun = createHistogram({
  name: 'ci_coordination_trace_spans_per_run',
  help: 'Number of spans recorded per coordination run',
  labelNames: ['strategy'],
  buckets: [1, 4, 8, 16, 32, 64, 128, 256],
});

/**
 * Counts traces whose `markComplete()` was reached vs traces that
 * exited via an exception path (some spans still open). When the
 * incomplete-trace ratio rises, it signals an upstream regression in
 * strategy error handling.
 */
export const coordinationTraceCompletionTotal = createCounter({
  name: 'ci_coordination_trace_completion_total',
  help: 'CollectiveTrace completion outcomes (`completed` vs `aborted`)',
  labelNames: ['strategy', 'outcome'],
});

// ============================================
// Recording helpers
// ============================================

export interface CoordinationRunMetrics {
  strategy: string;
  taskType: string;
  rounds: number;
  convergenceScore: number;
  stopReason: string;
  totalCostUsd: number;
  totalLatencyMs: number;
  totalTokens: number;
  signalCount: number;
  validSignalCount: number;
  parseFailureCount: number;
  conflictCount: number;
  finalQuality: number;
  modelDisagreement: number;
  variableCount: number;
  variableStabilityAvg: number;
}

/**
 * Record all metrics for a completed coordination run.
 * Called once at the end of a coordination execution.
 */
export function recordCoordinationRun(m: CoordinationRunMetrics): void {
  const { strategy } = m;

  coordinationRoundCount.observe({ strategy, task_type: m.taskType }, m.rounds);
  coordinationConvergenceScore.set({ strategy }, m.convergenceScore);
  coordinationStopReason.inc({ strategy, reason: m.stopReason });
  coordinationCostTotal.observe({ strategy }, m.totalCostUsd);
  coordinationLatencyTotal.observe({ strategy }, m.totalLatencyMs);
  coordinationTokensTotal.observe({ strategy }, m.totalTokens);
  coordinationSignalTotal.inc({ strategy, model: 'all', valid: 'true' }, m.validSignalCount);
  if (m.parseFailureCount > 0) {
    coordinationSignalTotal.inc({ strategy, model: 'all', valid: 'false' }, m.parseFailureCount);
  }
  if (m.conflictCount > 0) {
    coordinationSignalConflictRate.set({ strategy }, m.conflictCount / m.signalCount);
  }
  coordinationModelDisagreement.set({ strategy }, m.modelDisagreement);
  coordinationVariableCount.set({ strategy }, m.variableCount);
  coordinationVariableStability.set({ strategy }, m.variableStabilityAvg);
  coordinationFinalQuality.observe({ strategy }, m.finalQuality);
}

/**
 * Record a per-round signal parse failure.
 */
export function recordSignalParseFailure(strategy: string, model: string): void {
  coordinationSignalParseFailures.inc({ strategy, model });
}

// ============================================
// Trace recorder (F2.11)
// ============================================

/**
 * Aggregate stats produced by `CollectiveTrace.describe()`. Defined
 * here as a structural interface so this module does not import the
 * trace class — keeps `coordination-metrics.ts` pure-data and
 * dependency-free apart from prom-client.
 */
export interface CollectiveTraceStats {
  runId: string;
  spanCount: number;
  completed: boolean;
  statusCounts: Record<string, number>;
  phaseCounts: Record<string, number>;
}

/**
 * Record one trace's structural metrics. Called once per coordination
 * run after the trace has reached its terminal state (`markComplete()`
 * called and the run is about to return to the caller).
 *
 * Defensive: silently no-ops on malformed input so a metrics failure
 * never breaks the response path.
 */
export function recordCollectiveTrace(strategy: string, stats: CollectiveTraceStats): void {
  try {
    if (!stats || typeof stats !== 'object') return;
    if (!Number.isFinite(stats.spanCount)) return;

    coordinationTraceSpansPerRun.observe({ strategy }, stats.spanCount);

    coordinationTraceCompletionTotal.inc({
      strategy,
      outcome: stats.completed ? 'completed' : 'aborted',
    });

    // For each (phase, status) we cannot reconstruct the exact pairing
    // from `describe()` alone (it splits the totals by phase and by
    // status independently). The most useful approximation is to
    // treat phase counts as "ok" by default, since aborted/error
    // spans are surfaced via the completion counter above. Operators
    // who need per-(phase, status) granularity should consume the
    // raw spans via the persistence path.
    for (const [phase, count] of Object.entries(stats.phaseCounts)) {
      if (typeof count !== 'number' || count <= 0) continue;
      coordinationTraceSpansTotal.inc({ strategy, phase, status: 'ok' }, count);
    }
    // Surface error/cancelled tallies separately under a synthetic
    // phase='aggregate-status' so dashboards can still alert on rising
    // failure rates without dropping the per-phase view above.
    for (const [status, count] of Object.entries(stats.statusCounts)) {
      if (status === 'ok') continue;
      if (typeof count !== 'number' || count <= 0) continue;
      coordinationTraceSpansTotal.inc(
        { strategy, phase: 'aggregate-status', status },
        count,
      );
    }
  } catch {
    /* metrics failure must not break the response path */
  }
}
