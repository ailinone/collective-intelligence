// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Collective Intelligence Metrics
 *
 * Prometheus metrics for monitoring the CI system performance,
 * quality, and costs.
 *
 * Metrics Categories:
 * - Strategy metrics (usage, duration, quality)
 * - Model selection metrics (decisions, scores)
 * - Memory metrics (store, search, hits)
 * - Cache metrics (hits, misses, size)
 * - Quality metrics (scores, thresholds)
 * - Cost metrics (per strategy, per model)
 */

import { Counter, Histogram, Gauge, Registry, register } from 'prom-client';

// Use existing registry or create new one
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
  if (existing) {
    return existing as Counter<string>;
  }

  return new Counter({
    ...config,
    registers: [registry],
  });
}

function createHistogram(config: HistogramConfig): Histogram<string> {
  const existing = registry.getSingleMetric(config.name);
  if (existing) {
    return existing as Histogram<string>;
  }

  return new Histogram({
    ...config,
    registers: [registry],
  });
}

function createGauge(config: GaugeConfig): Gauge<string> {
  const existing = registry.getSingleMetric(config.name);
  if (existing) {
    return existing as Gauge<string>;
  }

  return new Gauge({
    ...config,
    registers: [registry],
  });
}

// ============================================
// Strategy Metrics
// ============================================

export const strategyExecutionTotal = createCounter({
  name: 'ci_strategy_execution_total',
  help: 'Total number of strategy executions',
  labelNames: ['strategy', 'task_type', 'status'],
  registers: [registry],
});

export const strategyExecutionDuration = createHistogram({
  name: 'ci_strategy_execution_duration_ms',
  help: 'Strategy execution duration in milliseconds',
  labelNames: ['strategy', 'task_type'],
  buckets: [100, 250, 500, 1000, 2000, 5000, 10000, 30000],
  registers: [registry],
});

export const strategyQualityScore = createHistogram({
  name: 'ci_strategy_quality_score',
  help: 'Quality scores by strategy',
  labelNames: ['strategy', 'task_type'],
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [registry],
});

export const strategyCostUsd = createHistogram({
  name: 'ci_strategy_cost_usd',
  help: 'Strategy execution cost in USD',
  labelNames: ['strategy', 'task_type'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0],
  registers: [registry],
});

// ============================================
// Model Selection Metrics
// ============================================

export const modelSelectionTotal = createCounter({
  name: 'ci_model_selection_total',
  help: 'Total number of model selections',
  labelNames: ['model', 'task_type', 'selection_reason'],
  registers: [registry],
});

export const modelSelectionDuration = createHistogram({
  name: 'ci_model_selection_duration_ms',
  help: 'Time to select model in milliseconds',
  labelNames: ['task_type'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
  registers: [registry],
});

export const modelSelectionScore = createHistogram({
  name: 'ci_model_selection_score',
  help: 'Model selection scores',
  labelNames: ['model'],
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [registry],
});

// ============================================
// Semantic Memory Metrics
// ============================================

export const memoryStoreTotal = createCounter({
  name: 'ci_memory_store_total',
  help: 'Total memories stored',
  labelNames: ['type', 'organization_id'],
  registers: [registry],
});

export const memorySearchTotal = createCounter({
  name: 'ci_memory_search_total',
  help: 'Total memory searches',
  labelNames: ['type', 'organization_id'],
  registers: [registry],
});

export const memorySearchResultsCount = createHistogram({
  name: 'ci_memory_search_results',
  help: 'Number of results per memory search',
  labelNames: ['type'],
  buckets: [0, 1, 2, 5, 10, 20, 50],
  registers: [registry],
});

export const memorySearchDuration = createHistogram({
  name: 'ci_memory_search_duration_ms',
  help: 'Memory search duration in milliseconds',
  labelNames: ['type'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
  registers: [registry],
});

export const memoryTotalGauge = createGauge({
  name: 'ci_memory_total',
  help: 'Total memories stored per organization',
  labelNames: ['organization_id', 'type'],
  registers: [registry],
});

// ============================================
// Semantic Cache Metrics
// ============================================

export const cacheHitsTotal = createCounter({
  name: 'ci_cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['match_type', 'organization_id'],
  registers: [registry],
});

export const cacheMissesTotal = createCounter({
  name: 'ci_cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['organization_id'],
  registers: [registry],
});

export const cacheLookupDuration = createHistogram({
  name: 'ci_cache_lookup_duration_ms',
  help: 'Cache lookup duration in milliseconds',
  labelNames: ['result'],
  buckets: [1, 5, 10, 25, 50, 100, 250],
  registers: [registry],
});

export const cacheStoreTotal = createCounter({
  name: 'ci_cache_store_total',
  help: 'Total cache stores',
  labelNames: ['organization_id'],
  registers: [registry],
});

export const cacheSizeGauge = createGauge({
  name: 'ci_cache_size',
  help: 'Current cache size per organization',
  labelNames: ['organization_id'],
  registers: [registry],
});

export const cacheCostSavedUsd = createCounter({
  name: 'ci_cache_cost_saved_usd',
  help: 'Estimated cost saved by cache in USD',
  labelNames: ['organization_id'],
  registers: [registry],
});

// ============================================
// Reasoning Transparency Metrics
// ============================================

export const reasoningTracesTotal = createCounter({
  name: 'ci_reasoning_traces_total',
  help: 'Total reasoning traces created',
  labelNames: ['status'],
  registers: [registry],
});

export const reasoningExplanationsTotal = createCounter({
  name: 'ci_reasoning_explanations_total',
  help: 'Total explanations generated',
  labelNames: [],
  registers: [registry],
});

// ============================================
// Self-Critique Metrics
// ============================================

export const critiqueTotal = createCounter({
  name: 'ci_critique_total',
  help: 'Total self-critiques performed',
  labelNames: ['mode', 'improved'],
  registers: [registry],
});

export const critiqueQualityBefore = createHistogram({
  name: 'ci_critique_quality_before',
  help: 'Quality score before critique',
  labelNames: ['task_type'],
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [registry],
});

export const critiqueQualityImprovement = createHistogram({
  name: 'ci_critique_quality_improvement',
  help: 'Quality improvement from critique (delta)',
  labelNames: ['task_type'],
  buckets: [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5],
  registers: [registry],
});

export const critiqueIterations = createHistogram({
  name: 'ci_critique_iterations',
  help: 'Number of critique iterations',
  labelNames: ['task_type'],
  buckets: [1, 2, 3, 4, 5],
  registers: [registry],
});

// ============================================
// Agentic Workflow Metrics
// ============================================

export const workflowExecutionTotal = createCounter({
  name: 'ci_workflow_execution_total',
  help: 'Total workflow executions',
  labelNames: ['workflow_id', 'status'],
  registers: [registry],
});

export const workflowDuration = createHistogram({
  name: 'ci_workflow_duration_ms',
  help: 'Workflow execution duration in milliseconds',
  labelNames: ['workflow_id'],
  buckets: [100, 500, 1000, 5000, 10000, 30000, 60000, 300000],
  registers: [registry],
});

export const workflowStepsExecuted = createHistogram({
  name: 'ci_workflow_steps_executed',
  help: 'Number of steps executed per workflow',
  labelNames: ['workflow_id'],
  buckets: [1, 2, 3, 5, 10, 20, 50],
  registers: [registry],
});

export const workflowCostUsd = createHistogram({
  name: 'ci_workflow_cost_usd',
  help: 'Workflow total cost in USD',
  labelNames: ['workflow_id'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0],
  registers: [registry],
});

// ============================================
// Debate Strategy Metrics
// ============================================

export const debateRoundsTotal = createCounter({
  name: 'ci_debate_rounds_total',
  help: 'Total debate rounds executed',
  labelNames: ['task_type'],
  registers: [registry],
});

export const debateParticipants = createHistogram({
  name: 'ci_debate_participants',
  help: 'Number of debate participants',
  labelNames: ['task_type'],
  buckets: [2, 3, 4, 5],
  registers: [registry],
});

export const debateDuration = createHistogram({
  name: 'ci_debate_duration_ms',
  help: 'Debate duration in milliseconds',
  labelNames: ['task_type'],
  buckets: [1000, 2000, 5000, 10000, 20000, 30000, 60000],
  registers: [registry],
});

// ============================================
// Triage Metrics
// ============================================

export const triageTotal = createCounter({
  name: 'ci_triage_total',
  help: 'Total triage operations',
  labelNames: ['intent', 'complexity'],
  registers: [registry],
});

export const triageConfidence = createHistogram({
  name: 'ci_triage_confidence',
  help: 'Triage confidence scores',
  labelNames: ['intent'],
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [registry],
});

export const triageDuration = createHistogram({
  name: 'ci_triage_duration_ms',
  help: 'Triage duration in milliseconds',
  labelNames: ['source'],
  buckets: [10, 25, 50, 100, 250, 500, 1000],
  registers: [registry],
});

// ============================================
// Helper Functions
// ============================================

/**
 * Record strategy execution metrics
 */
export function recordStrategyExecution(params: {
  strategy: string;
  taskType: string;
  status: 'success' | 'failed' | 'timeout';
  durationMs: number;
  qualityScore?: number;
  costUsd?: number;
}): void {
  const { strategy, taskType, status, durationMs, qualityScore, costUsd } = params;

  strategyExecutionTotal.inc({ strategy, task_type: taskType, status });
  strategyExecutionDuration.observe({ strategy, task_type: taskType }, durationMs);

  if (qualityScore !== undefined) {
    strategyQualityScore.observe({ strategy, task_type: taskType }, qualityScore);
  }

  if (costUsd !== undefined) {
    strategyCostUsd.observe({ strategy, task_type: taskType }, costUsd);
  }
}

/**
 * Record model selection metrics.
 *
 * `model`, `taskType` and `selectionReason` (the bounded decision source, e.g.
 * `heuristic` / `triage` / `bandit`) must always be provided so the
 * `ci_model_selection_total` decision counter is meaningful. `durationMs` and
 * `score` are optional: the selection-latency and selection-score histograms
 * are only observed at call sites where those values are actually computed
 * (e.g. the model selector), so post-hoc callers that only know which model
 * was chosen and why can still record the decision counter without fabricating
 * a latency/score.
 */
export function recordModelSelection(params: {
  model: string;
  taskType: string;
  selectionReason: string;
  durationMs?: number;
  score?: number;
}): void {
  const { model, taskType, selectionReason, durationMs, score } = params;

  modelSelectionTotal.inc({ model, task_type: taskType, selection_reason: selectionReason });

  if (durationMs !== undefined) {
    modelSelectionDuration.observe({ task_type: taskType }, durationMs);
  }

  if (score !== undefined) {
    modelSelectionScore.observe({ model }, score);
  }
}

/**
 * Record memory operation metrics
 */
export function recordMemoryOperation(params: {
  operation: 'store' | 'search' | 'delete';
  type: string;
  organizationId: string;
  durationMs?: number;
  resultsCount?: number;
}): void {
  const { operation, type, organizationId, durationMs, resultsCount } = params;

  if (operation === 'store') {
    memoryStoreTotal.inc({ type, organization_id: organizationId });
  } else if (operation === 'search') {
    memorySearchTotal.inc({ type, organization_id: organizationId });
    if (durationMs !== undefined) {
      memorySearchDuration.observe({ type }, durationMs);
    }
    if (resultsCount !== undefined) {
      memorySearchResultsCount.observe({ type }, resultsCount);
    }
  }
}

/**
 * Record cache metrics
 */
export function recordCacheOperation(params: {
  operation: 'hit' | 'miss' | 'store';
  organizationId: string;
  matchType?: 'exact' | 'semantic';
  durationMs?: number;
  costSaved?: number;
}): void {
  const { operation, organizationId, matchType, durationMs, costSaved } = params;

  if (operation === 'hit' && matchType) {
    cacheHitsTotal.inc({ match_type: matchType, organization_id: organizationId });
    if (costSaved) {
      cacheCostSavedUsd.inc({ organization_id: organizationId }, costSaved);
    }
    if (durationMs !== undefined) {
      cacheLookupDuration.observe({ result: 'hit' }, durationMs);
    }
  } else if (operation === 'miss') {
    cacheMissesTotal.inc({ organization_id: organizationId });
    if (durationMs !== undefined) {
      cacheLookupDuration.observe({ result: 'miss' }, durationMs);
    }
  } else if (operation === 'store') {
    cacheStoreTotal.inc({ organization_id: organizationId });
  }
}

/**
 * Record workflow metrics
 */
export function recordWorkflowExecution(params: {
  workflowId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  durationMs: number;
  stepsExecuted: number;
  costUsd: number;
}): void {
  const { workflowId, status, durationMs, stepsExecuted, costUsd } = params;

  workflowExecutionTotal.inc({ workflow_id: workflowId, status });
  workflowDuration.observe({ workflow_id: workflowId }, durationMs);
  workflowStepsExecuted.observe({ workflow_id: workflowId }, stepsExecuted);
  workflowCostUsd.observe({ workflow_id: workflowId }, costUsd);
}

/**
 * Record triage metrics
 */
export function recordTriage(params: {
  intent: string;
  complexity: string;
  confidence: number;
  durationMs: number;
  source: 'llm' | 'heuristic';
}): void {
  const { intent, complexity, confidence, durationMs, source } = params;

  triageTotal.inc({ intent, complexity });
  triageConfidence.observe({ intent }, confidence);
  triageDuration.observe({ source }, durationMs);
}

// ============================================
// Speculative Selection Metrics (2026-07-14)
// ============================================

/**
 * Tracks how often `executeStream()`'s speculative model selection (run
 * concurrently with the triage LLM call) is actually reused vs discarded —
 * lets a canary rollout confirm the assumed "most auto traffic is
 * single-model" rate against real production traffic before enabling the
 * kill-switch (`ORCHESTRATION_SPECULATIVE_SELECTION`) broadly.
 */
export const speculativeSelectionTotal = createCounter({
  name: 'ci_orchestration_speculative_selection_total',
  help: 'Speculative streaming model selection outcomes',
  labelNames: ['outcome'],
  registers: [registry],
});

export function recordSpeculativeSelectionOutcome(
  outcome: 'reused' | 'repinned' | 'discarded_collective' | 'discarded_error'
): void {
  speculativeSelectionTotal.inc({ outcome });
}

// ============================================
// Per-Model Execution Metrics (BL-03)
// ============================================

export const modelExecutionQualityScore = createHistogram({
  name: 'ci_model_quality_score',
  help: 'Quality score per model execution',
  labelNames: ['model_id', 'provider', 'task_type'],
  buckets: [0.1, 0.3, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0],
  registers: [registry],
});

export const modelExecutionDurationMs = createHistogram({
  name: 'ci_model_execution_duration_ms',
  help: 'Model execution duration in milliseconds',
  labelNames: ['model_id', 'provider'],
  buckets: [100, 250, 500, 1000, 2000, 5000, 10000, 30000],
  registers: [registry],
});

export const modelExecutionCostUsd = createHistogram({
  name: 'ci_model_execution_cost_usd',
  help: 'Model execution cost in USD',
  labelNames: ['model_id', 'provider'],
  buckets: [0.0001, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0],
  registers: [registry],
});

export const modelExecutionTotal = createCounter({
  name: 'ci_model_execution_total',
  help: 'Total model executions by result',
  labelNames: ['model_id', 'provider', 'success'],
  registers: [registry],
});

// ============================================
// Circuit Breaker State Metrics (BL-03)
// ============================================

/**
 * Circuit breaker state gauge.
 * Values: 0 = CLOSED (healthy), 1 = OPEN (failing), 2 = HALF_OPEN (recovering)
 */
export const circuitBreakerState = createGauge({
  name: 'ci_circuit_breaker_state',
  help: 'Circuit breaker state per provider (0=closed, 1=open, 2=half_open)',
  labelNames: ['provider'],
  registers: [registry],
});

// ============================================
// Distributed Bulkhead Metrics (scale-to-100k Phase 2)
// ============================================

/**
 * Active concurrent bulkhead leases per provider — fleet-wide (Redis-backed),
 * not per-process. Should stay at or below the configured cap regardless of
 * replica count; if it tracks replica count instead, the distributed lease
 * store has silently fallen back to local-only mode (see mode label on
 * bulkheadMode below).
 */
export const bulkheadActiveLeases = createGauge({
  name: 'ci_bulkhead_active_leases',
  help: 'Active concurrent provider bulkhead leases (fleet-wide when distributed)',
  labelNames: ['provider'],
  registers: [registry],
});

export const bulkheadRejectedTotal = createCounter({
  name: 'ci_bulkhead_rejected_total',
  help: 'Requests rejected by the provider bulkhead because it was at capacity',
  labelNames: ['provider'],
  registers: [registry],
});

/**
 * 0 = distributed (Redis-backed, fleet-wide cap), 1 = local fallback
 * (in-process only — Redis was unavailable). Local fallback means the
 * concurrency cap is once again per-replica, not fleet-wide.
 */
export const bulkheadMode = createGauge({
  name: 'ci_bulkhead_mode',
  help: 'Bulkhead operating mode per provider (0=distributed, 1=local_fallback)',
  labelNames: ['provider'],
  registers: [registry],
});

/**
 * Requests rejected by the per-provider TPM/RPM token bucket (scale-to-100k
 * Phase 2 follow-up, issue #152) — distinct from bulkheadRejectedTotal
 * (concurrency cap): this fires when a provider's estimated token-per-minute
 * budget is exhausted, even if a concurrency slot was available.
 */
export const providerTpmRejectedTotal = createCounter({
  name: 'ci_provider_tpm_rejected_total',
  help: 'Requests rejected by the provider TPM/RPM token bucket (budget exhausted)',
  labelNames: ['provider'],
  registers: [registry],
});

// ============================================
// Learning System Metrics (BL-03)
// ============================================

export const strategyWeightAge = createGauge({
  name: 'ci_strategy_weight_age_days',
  help: 'Days since strategy weight was last updated',
  labelNames: ['task_type', 'complexity', 'strategy'],
  registers: [registry],
});

export const learningBanditsAlpha = createGauge({
  name: 'ci_bandit_alpha',
  help: 'Thompson Sampling alpha (successes+1) per strategy',
  labelNames: ['task_type', 'complexity', 'strategy'],
  registers: [registry],
});

export const learningBanditsBeta = createGauge({
  name: 'ci_bandit_beta',
  help: 'Thompson Sampling beta (failures+1) per strategy',
  labelNames: ['task_type', 'complexity', 'strategy'],
  registers: [registry],
});

// ============================================
// Helper: Record model execution metrics
// ============================================

export function recordModelExecution(params: {
  modelId: string;
  provider: string;
  taskType: string;
  durationMs: number;
  costUsd: number;
  qualityScore?: number;
  success: boolean;
}): void {
  const { modelId, provider, taskType, durationMs, costUsd, qualityScore, success } = params;

  modelExecutionTotal.inc({ model_id: modelId, provider, success: String(success) });
  modelExecutionDurationMs.observe({ model_id: modelId, provider }, durationMs);
  modelExecutionCostUsd.observe({ model_id: modelId, provider }, costUsd);

  if (qualityScore !== undefined) {
    modelExecutionQualityScore.observe({ model_id: modelId, provider, task_type: taskType }, qualityScore);
  }
}

// ============================================
// Champion / Challenger Metrics
// ============================================

export const championChallengerPromotions = createCounter({
  name: 'ci_champion_challenger_promotions_total',
  help: 'Total strategy weight promotions via champion/challenger',
  labelNames: ['task_type', 'complexity', 'strategy'],
  registers: [registry],
});

export const championChallengerRejections = createCounter({
  name: 'ci_champion_challenger_rejections_total',
  help: 'Total strategy weight rejections via champion/challenger',
  labelNames: ['task_type', 'complexity', 'strategy', 'reason'],
  registers: [registry],
});

export const championChallengerQualityDelta = createHistogram({
  name: 'ci_champion_challenger_quality_delta',
  help: 'Quality delta between challenger and champion',
  labelNames: ['task_type', 'strategy'],
  buckets: [-0.2, -0.1, -0.05, 0, 0.03, 0.05, 0.1, 0.2, 0.3],
  registers: [registry],
});

// ============================================
// Benchmark Harness Metrics (OI-01 / OI-02)
// ============================================

export const benchmarkRunsTotal = createCounter({
  name: 'ci_benchmark_runs_total',
  help: 'Total benchmark runs executed',
  labelNames: ['verdict'],
  registers: [registry],
});

export const benchmarkRunDurationMs = createHistogram({
  name: 'ci_benchmark_run_duration_ms',
  help: 'Full benchmark run duration in milliseconds',
  labelNames: [],
  buckets: [30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000],
  registers: [registry],
});

export const benchmarkTaskQualityScore = createHistogram({
  name: 'ci_benchmark_task_quality_score',
  help: 'Per-task quality score (heuristic)',
  labelNames: ['category', 'difficulty', 'strategy'],
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [registry],
});

export const benchmarkTaskDurationMs = createHistogram({
  name: 'ci_benchmark_task_duration_ms',
  help: 'Per-task execution duration in milliseconds',
  labelNames: ['category', 'strategy'],
  buckets: [500, 1000, 2000, 5000, 10_000, 30_000, 60_000],
  registers: [registry],
});

export const benchmarkTaskCostUsd = createHistogram({
  name: 'ci_benchmark_task_cost_usd',
  help: 'Per-task cost in USD',
  labelNames: ['category', 'strategy'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0],
  registers: [registry],
});

export const benchmarkRewardCorrelation = createGauge({
  name: 'ci_benchmark_reward_correlation',
  help: 'Pearson correlation between heuristic and LLM judge scores (reward integrity)',
  labelNames: [],
  registers: [registry],
});

export const benchmarkRewardDriftDetected = createGauge({
  name: 'ci_benchmark_reward_drift_detected',
  help: 'Whether reward drift was detected in the last run (0=no, 1=yes)',
  labelNames: [],
  registers: [registry],
});

export const benchmarkGamingSignalsTotal = createCounter({
  name: 'ci_benchmark_gaming_signals_total',
  help: 'Gaming signals detected by type',
  labelNames: ['type', 'severity'],
  registers: [registry],
});

export const benchmarkOverallScore = createGauge({
  name: 'ci_benchmark_overall_score',
  help: 'Overall benchmark score from the latest run',
  labelNames: [],
  registers: [registry],
});

export const benchmarkCategoryScore = createGauge({
  name: 'ci_benchmark_category_score',
  help: 'Average score per benchmark category',
  labelNames: ['category'],
  registers: [registry],
});

export const benchmarkBudgetUsedUsd = createGauge({
  name: 'ci_benchmark_budget_used_usd',
  help: 'Budget consumed in the latest benchmark run',
  labelNames: [],
  registers: [registry],
});

// Success-Story Rollback Metrics (OI-03)
export const banditRollbacksTotal = createCounter({
  name: 'ci_bandit_rollbacks_total',
  help: 'Total Success-Story auto-rollbacks executed',
  labelNames: [],
  registers: [registry],
});

export const banditRewardRate = createGauge({
  name: 'ci_bandit_reward_rate',
  help: 'Current reward rate (quality/latency) for bandit rollback monitoring',
  labelNames: [],
  registers: [registry],
});

export const banditSnapshotCount = createGauge({
  name: 'ci_bandit_snapshot_count',
  help: 'Number of stored Success-Story snapshots',
  labelNames: [],
  registers: [registry],
});

// ============================================
// Configuration Archive Metrics (OI-06)
// ============================================

export const archiveCellCount = createGauge({
  name: 'ci_archive_cell_count',
  help: 'Total cells occupied in the quality-diversity configuration archive',
  labelNames: [],
  registers: [registry],
});

export const archiveEliteInsertions = createCounter({
  name: 'ci_archive_elite_insertions_total',
  help: 'Total elite insertions/replacements in the configuration archive',
  labelNames: ['dimension', 'source'],
  registers: [registry],
});

export const archiveRecommendations = createCounter({
  name: 'ci_archive_recommendations_total',
  help: 'Total strategy recommendations served from the configuration archive',
  labelNames: ['dimension', 'accepted'],
  registers: [registry],
});

export const archiveAvgFitness = createGauge({
  name: 'ci_archive_avg_fitness',
  help: 'Average fitness across all archive elites',
  labelNames: [],
  registers: [registry],
});

// ============================================
// Triage Calibrator Metrics (OI-07)
// ============================================

export const triageCalibrationScore = createGauge({
  name: 'ci_triage_calibration_score',
  help: 'Overall triage calibration score (0-1, higher = better alignment)',
  labelNames: [],
  registers: [registry],
});

export const triageCorrectionsApplied = createCounter({
  name: 'ci_triage_corrections_applied_total',
  help: 'Total triage corrections applied by the calibrator',
  labelNames: ['field', 'from', 'to'],
  registers: [registry],
});

export const triageComplexityAccuracy = createGauge({
  name: 'ci_triage_complexity_accuracy',
  help: 'Accuracy of triage complexity predictions (0-1)',
  labelNames: [],
  registers: [registry],
});

export const triageActiveRules = createGauge({
  name: 'ci_triage_active_rules',
  help: 'Number of active triage correction rules',
  labelNames: [],
  registers: [registry],
});

export const triageUnderestimationRate = createGauge({
  name: 'ci_triage_underestimation_rate',
  help: 'Rate at which triage underestimates complexity',
  labelNames: [],
  registers: [registry],
});

/**
 * Record configuration archive state for monitoring.
 */
export function recordArchiveState(params: {
  cellCount: number;
  avgFitness: number;
}): void {
  archiveCellCount.set(params.cellCount);
  archiveAvgFitness.set(params.avgFitness);
}

/**
 * Record triage calibration results.
 */
export function recordTriageCalibration(params: {
  overall: number;
  complexityAccuracy: number;
  underestimationRate: number;
  activeRuleCount: number;
}): void {
  triageCalibrationScore.set(params.overall);
  triageComplexityAccuracy.set(params.complexityAccuracy);
  triageUnderestimationRate.set(params.underestimationRate);
  triageActiveRules.set(params.activeRuleCount);
}

// ============================================
// Adaptive Quality Targets Metrics (OI-08)
// ============================================

export const adaptiveQualityTargetValue = createGauge({
  name: 'ci_adaptive_quality_target',
  help: 'Current adaptive quality target value',
  labelNames: ['task_type', 'complexity', 'source'],
  registers: [registry],
});

export const adaptiveQualityTargetConfidence = createGauge({
  name: 'ci_adaptive_quality_target_confidence',
  help: 'Confidence level of the adaptive quality target',
  labelNames: ['task_type', 'complexity'],
  registers: [registry],
});

export const adaptiveQualityProfileCount = createGauge({
  name: 'ci_adaptive_quality_profile_count',
  help: 'Number of cached adaptive quality profiles',
  labelNames: [],
  registers: [registry],
});

// ============================================
// Pareto Champion/Challenger Metrics (OI-09)
// ============================================

export const paretoFrontierSize = createGauge({
  name: 'ci_pareto_frontier_size',
  help: 'Number of strategies on the Pareto frontier per niche',
  labelNames: ['task_type', 'complexity'],
  registers: [registry],
});

export const paretoEvaluationsTotal = createCounter({
  name: 'ci_pareto_evaluations_total',
  help: 'Total Pareto frontier evaluations completed',
  labelNames: [],
  registers: [registry],
});

export const paretoFrontierChanges = createCounter({
  name: 'ci_pareto_frontier_changes_total',
  help: 'Total strategies entering or leaving the Pareto frontier',
  labelNames: ['change_type'], // 'entered' | 'dropped'
  registers: [registry],
});

export const paretoDominatedCount = createGauge({
  name: 'ci_pareto_dominated_count',
  help: 'Total dominated strategies across all niches',
  labelNames: [],
  registers: [registry],
});

// ============================================
// Intelligent Feedback Loop Metrics (OI-10)
// ============================================

export const feedbackEscalationsTotal = createCounter({
  name: 'ci_feedback_escalations_total',
  help: 'Total feedback loop escalations to alternative strategies',
  labelNames: ['escalation_result'], // 'success' | 'partial' | 'failed'
  registers: [registry],
});

export const feedbackEscalationQualityDelta = createHistogram({
  name: 'ci_feedback_escalation_quality_delta',
  help: 'Quality improvement from feedback escalation (escalation - original)',
  labelNames: [],
  buckets: [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.3],
  registers: [registry],
});

// ============================================
// Knowledge Graph Unification Metrics (OI-11)
// ============================================

export const knowledgeGraphEdges = createGauge({
  name: 'ci_knowledge_graph_edges_total',
  help: 'Total edges in the knowledge graph',
  labelNames: ['edge_type'],
  registers: [registry],
});

export const knowledgeGraphNodes = createGauge({
  name: 'ci_knowledge_graph_nodes_total',
  help: 'Total unique nodes in the knowledge graph',
  labelNames: [],
  registers: [registry],
});

export const knowledgeGraphBenchmarkIngestions = createCounter({
  name: 'ci_knowledge_graph_benchmark_ingestions_total',
  help: 'Total benchmark result batches ingested into knowledge graph',
  labelNames: [],
  registers: [registry],
});

export const knowledgeGraphArchiveIngestions = createCounter({
  name: 'ci_knowledge_graph_archive_ingestions_total',
  help: 'Total archive elite batches ingested into knowledge graph',
  labelNames: [],
  registers: [registry],
});

// ─── OI-08/09/10/11 Helper Functions ───────────────────────────────────────

/**
 * Record adaptive quality target metrics (OI-08).
 */
export function recordAdaptiveQualityTarget(params: {
  taskType: string;
  complexity: string;
  target: number;
  confidence: number;
  source: string;
  profileCount: number;
}): void {
  adaptiveQualityTargetValue.set(
    { task_type: params.taskType, complexity: params.complexity, source: params.source },
    params.target,
  );
  adaptiveQualityTargetConfidence.set(
    { task_type: params.taskType, complexity: params.complexity },
    params.confidence,
  );
  adaptiveQualityProfileCount.set(params.profileCount);
}

/**
 * Record Pareto evaluation results (OI-09).
 */
export function recordParetoEvaluation(params: {
  frontiers: Array<{ taskType: string; complexity: string; frontierSize: number }>;
  newEntries: number;
  dropped: number;
  totalDominated: number;
}): void {
  paretoEvaluationsTotal.inc();

  for (const f of params.frontiers) {
    paretoFrontierSize.set({ task_type: f.taskType, complexity: f.complexity }, f.frontierSize);
  }

  if (params.newEntries > 0) {
    paretoFrontierChanges.inc({ change_type: 'entered' }, params.newEntries);
  }
  if (params.dropped > 0) {
    paretoFrontierChanges.inc({ change_type: 'dropped' }, params.dropped);
  }

  paretoDominatedCount.set(params.totalDominated);
}

/**
 * Record feedback escalation result (OI-10).
 */
export function recordFeedbackEscalation(params: {
  result: 'success' | 'partial' | 'failed';
  qualityDelta: number;
}): void {
  feedbackEscalationsTotal.inc({ escalation_result: params.result });
  feedbackEscalationQualityDelta.observe(params.qualityDelta);
}

/**
 * Record knowledge graph state (OI-11).
 */
export function recordKnowledgeGraphState(params: {
  edgesByType: Record<string, number>;
  uniqueNodes: number;
}): void {
  for (const [edgeType, count] of Object.entries(params.edgesByType)) {
    knowledgeGraphEdges.set({ edge_type: edgeType }, count);
  }
  knowledgeGraphNodes.set(params.uniqueNodes);
}

// ─── Benchmark Helper Functions ─────────────────────────────────────────────

/**
 * Record metrics for a completed benchmark run.
 */
export function recordBenchmarkRun(params: {
  verdict: string;
  overallScore: number;
  durationMs: number;
  totalCostUsd: number;
  categoryScores: Array<{ category: string; averageScore: number }>;
  rewardCorrelation?: number;
  driftDetected?: boolean;
  gamingSignals?: Array<{ type: string; severity: string }>;
}): void {
  const {
    verdict, overallScore, durationMs, totalCostUsd,
    categoryScores, rewardCorrelation, driftDetected, gamingSignals,
  } = params;

  benchmarkRunsTotal.inc({ verdict });
  benchmarkRunDurationMs.observe(durationMs);
  benchmarkOverallScore.set(overallScore);
  benchmarkBudgetUsedUsd.set(totalCostUsd);

  for (const cs of categoryScores) {
    benchmarkCategoryScore.set({ category: cs.category }, cs.averageScore);
  }

  if (rewardCorrelation !== undefined) {
    benchmarkRewardCorrelation.set(rewardCorrelation);
  }

  benchmarkRewardDriftDetected.set(driftDetected ? 1 : 0);

  if (gamingSignals) {
    for (const sig of gamingSignals) {
      benchmarkGamingSignalsTotal.inc({ type: sig.type, severity: sig.severity });
    }
  }
}

/**
 * Record metrics for a single benchmark task execution.
 */
export function recordBenchmarkTask(params: {
  category: string;
  difficulty: string;
  strategy: string;
  qualityScore: number;
  durationMs: number;
  costUsd: number;
}): void {
  const { category, difficulty, strategy, qualityScore, durationMs, costUsd } = params;
  benchmarkTaskQualityScore.observe({ category, difficulty, strategy }, qualityScore);
  benchmarkTaskDurationMs.observe({ category, strategy }, durationMs);
  benchmarkTaskCostUsd.observe({ category, strategy }, costUsd);
}

/**
 * Record current bandit Success-Story state for monitoring.
 */
export function recordBanditSuccessStoryState(params: {
  rewardRate: number | null;
  snapshotCount: number;
}): void {
  if (params.rewardRate !== null) {
    banditRewardRate.set(params.rewardRate);
  }
  banditSnapshotCount.set(params.snapshotCount);
}

// ============================================
// Aggregated ciMetrics facade
// ============================================

export const ciMetrics = {
  championChallengerPromotions,
  championChallengerRejections,
  championChallengerQualityDelta,
  // Benchmark
  benchmarkRunsTotal,
  benchmarkOverallScore,
  benchmarkRewardCorrelation,
  benchmarkRewardDriftDetected,
  benchmarkGamingSignalsTotal,
  banditRollbacksTotal,
  // OI-08: Adaptive Quality Targets
  adaptiveQualityTargetValue,
  adaptiveQualityTargetConfidence,
  adaptiveQualityProfileCount,
  // OI-09: Pareto Champion/Challenger
  paretoFrontierSize,
  paretoEvaluationsTotal,
  paretoFrontierChanges,
  paretoDominatedCount,
  // OI-10: Intelligent Feedback Loop
  feedbackEscalationsTotal,
  feedbackEscalationQualityDelta,
  // OI-11: Knowledge Graph Unification
  knowledgeGraphEdges,
  knowledgeGraphNodes,
  knowledgeGraphBenchmarkIngestions,
  knowledgeGraphArchiveIngestions,
};

export { registry as ciMetricsRegistry };

