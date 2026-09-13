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

/**
 * Degraded synthesis emissions (Workstream F, 2026-08-17): responses served
 * as the fallback placeholder ("All available models were unavailable...") or
 * another degraded marker. These are HTTP 200 to the client but are NOT
 * semantic successes — request-level success metrics must not count them.
 */
export const degradedSynthesisTotal = createCounter({
  name: 'ci_orchestration_degraded_synthesis_total',
  help: 'Total responses served as degraded synthesis (fallback placeholder, no provider succeeded)',
  labelNames: ['strategy', 'reason'],
  registers: [registry],
});

/**
 * Requests where the client PINNED a model and a different one answered
 * (2026-09). These are HTTP 200 with `degraded: false` — correctly so, since a
 * real answer was produced — but the caller did not get what it asked for, and
 * until this counter existed a provider-wide circuit-breaker trip that shifted
 * traffic to another vendor was invisible in aggregate.
 */
export const modelSubstitutionTotal = createCounter({
  name: 'ci_model_substitution_total',
  help: 'Total responses where a client-pinned model was replaced by a different model',
  labelNames: ['strategy', 'served_provider'],
  registers: [registry],
});

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
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
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
// Streaming Latency Metrics
// ============================================
// ADDED (2026-08-03): the streaming request path (chat-routes.ts
// handleStreamingRequest -> executeStream/createStreamingPlan) had ZERO
// latency observability despite being the dominant path in production —
// neither this Prometheus registry nor OTel tracing covered it, so the
// "Selection time exceeded threshold" alerts (see modelSelectionDuration
// above) could only ever explain the selection PHASE, not what the client
// actually experienced end-to-end. time_to_first_byte_ms is measured from
// request start to the first SSE chunk written to the response (the
// `firstChunkSent` transition in chat-routes.ts), independent of whether
// that first chunk came from the single-model streaming path or the
// collective-strategy path.

export const streamingTimeToFirstByte = createHistogram({
  name: 'ci_streaming_time_to_first_byte_ms',
  help: 'Time from request start to first SSE chunk written, in milliseconds',
  labelNames: ['strategy', 'result'],
  buckets: [100, 250, 500, 1000, 2000, 3000, 5000, 8000, 15000, 30000],
  registers: [registry],
});

/**
 * Streaming strategy-throw recovery (2026-08-16 follow-up).
 *
 * The streaming throw guard (orchestration-engine.ts) catches a strategy that
 * threw before emitting any answer content and recovers it into a normal 200
 * SSE response. That is the right client behavior, but it made a TOTAL OUTAGE
 * invisible to every dashboard: `streamingTimeToFirstByte` above already
 * recorded result='success' on the observer's "request received" chunk — which
 * is emitted BEFORE the strategy even runs — and the old chat-routes error log
 * line plus the SSE error frame that alerting keyed on both went silent by
 * design once the guard started swallowing the throw.
 *
 * This counter is the replacement signal, incremented at the exact point of
 * recovery so the outage class is observable without inspecting wire content:
 *   outcome='recovered' — a fallback provider produced a REAL answer (the
 *     strategy failed, the request did not: elevated rate = strategy/pool
 *     misconfiguration, not a user-visible outage);
 *   outcome='degraded'  — every fallback also failed and the client got the
 *     `[DEGRADED]` placeholder. ANY sustained non-zero rate here is a real
 *     user-facing outage delivered as an HTTP 200. Alert on it.
 */
export const streamingStrategyRecoveryTotal = createCounter({
  name: 'ci_streaming_strategy_recovery_total',
  help: 'Streaming strategy threw before any content and was recovered by the engine throw guard',
  labelNames: ['strategy', 'outcome'],
  registers: [registry],
});

export function recordStreamingStrategyRecovery(params: {
  strategy: string;
  outcome: 'recovered' | 'degraded';
}): void {
  streamingStrategyRecoveryTotal.inc({ strategy: params.strategy, outcome: params.outcome });
}

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

/**
 * Current row count of the `models` table per provider_id, refreshed at the
 * end of every discovery cycle. A silent regression in any provider's
 * discovery path (a fetcher's pagination/filtering logic breaking, a WAF
 * block returning fewer results than expected, etc.) surfaces here as a
 * count drop without needing a manual DB check — see
 * ci-alert-provider-model-count-drop in ci-alert-rules.yml, which compares
 * this against its own 24h-ago value rather than a hardcoded floor, since
 * "how many models a provider should have" varies per provider and drifts
 * over time as upstream catalogs grow or shrink.
 */
export const providerDiscoveredModelsTotal = createGauge({
  name: 'ci_provider_discovered_models_total',
  help: 'Current models table row count per provider_id, refreshed after each discovery cycle',
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
 * Inbound admission control (Track 1 §2.1, CAPACITY-SCALING-PLAN-10K-USERS.md).
 *
 * Unlike `bulkheadActiveLeases` above (fleet-wide, Redis-leased, OUTBOUND
 * provider concurrency), these three are deliberately PER-PROCESS — there is
 * no distributed-bulkhead equivalent for inbound admission yet. With 2
 * `ci_api` replicas, `ci_admission_control_in_flight_requests` summed across
 * both replicas' `/metrics` scrapes is the real fleet-wide in-flight count;
 * neither this gauge nor the enforcing cap it can drive (see
 * `middleware/admission-control.ts`) is aware of the other replica. See that
 * file's module comment for the full reasoning and the same footgun
 * `distributed-bulkhead.ts` already solved on the outbound side.
 */
export const admissionControlInFlightRequests = createGauge({
  name: 'ci_admission_control_in_flight_requests',
  help: 'Current in-flight requests to expensive routes (per-process — see module comment on multiplying with replica count)',
  labelNames: ['route'],
  registers: [registry],
});

/**
 * Fires every time `@fastify/under-pressure`'s pressureHandler observes a
 * configured resource axis over threshold (heapUsedBytes, rssBytes, and —
 * once measured and configured — eventLoopDelay/eventLoopUtilization). In
 * shadow mode (ADMISSION_CONTROL_ENFORCE=false, the default) this fires
 * without any request being rejected; it is the signal to watch to decide
 * when enforcement is safe to turn on.
 */
export const admissionControlPressureEventsTotal = createCounter({
  name: 'ci_admission_control_pressure_events_total',
  help: 'Total resource-pressure events observed by the inbound admission-control layer',
  labelNames: ['metric'],
  registers: [registry],
});

/**
 * Requests actually rejected (503 + Retry-After) by admission control.
 * Always zero unless ADMISSION_CONTROL_ENFORCE=true — shadow mode logs and
 * increments `admissionControlPressureEventsTotal` but never this counter.
 */
export const admissionControlRejectedTotal = createCounter({
  name: 'ci_admission_control_rejected_total',
  help: 'Total requests rejected by inbound admission control (only non-zero when enforce mode is on)',
  labelNames: ['route', 'reason'],
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
// SAB Candidate Index Metrics (ADR-027,
// SELECTION_USE_SAB_CANDIDATE_INDEX — default OFF)
// ============================================
// `getSabCandidateIndexStatus()` (core/selection/sab-candidate-index/
// manager.ts) is a synchronous, per-process observability snapshot with no
// natural "scrape" hook of its own. Rather than poll it from a `collect()`
// callback, these are pushed at the exact call sites in manager.ts where
// each field already changes (worker 'rebuilt'/'rebuild-failed'/'exit'
// messages) — the same push-model convention this file already uses for
// circuitBreakerState/bulkheadActiveLeases/providerDiscoveredModelsTotal.
// All per-process (no distributed-bulkhead equivalent — SAB is explicitly
// single-replica scope, see ADR-027), so summing across replicas' /metrics
// scrapes is meaningless for `sabCandidateIndexActiveGen`/`ready`/`version`
// (each replica runs its own independent worker + generation); it IS
// meaningful for the two `_total` counters.

export const sabCandidateIndexReady = createGauge({
  name: 'ci_sab_candidate_index_ready',
  help: 'SAB candidate index readiness per process (1 = at least one generation built and serving reads, 0 = not ready or not started)',
  registers: [registry],
});

export const sabCandidateIndexActiveGen = createGauge({
  name: 'ci_sab_candidate_index_active_gen',
  help: 'SAB candidate index active double-buffer slot per process (-1 = none built yet, 0 or 1 = the generation currently serving reads)',
  registers: [registry],
});

export const sabCandidateIndexVersion = createGauge({
  name: 'ci_sab_candidate_index_version',
  help: 'SAB candidate index generation version per process (increments by 1 on every successful rebuild since worker start)',
  registers: [registry],
});

export const sabCandidateIndexBuildsTotal = createCounter({
  name: 'ci_sab_candidate_index_builds_total',
  help: 'Total successful SAB candidate index rebuilds per process since worker start',
  registers: [registry],
});

export const sabCandidateIndexCrashesTotal = createCounter({
  name: 'ci_sab_candidate_index_crashes_total',
  help: 'Total SAB candidate index worker crashes/unexpected exits per process (each triggers an automatic respawn; reads keep serving the last-good generation throughout, so this is a health signal, not a user-facing failure)',
  registers: [registry],
});

export const sabCandidateIndexLastBuildMs = createGauge({
  name: 'ci_sab_candidate_index_last_build_ms',
  help: 'Wall-clock duration of the most recent successful SAB candidate index rebuild, in milliseconds',
  registers: [registry],
});

/**
 * 0 = redis (fleet-wide snapshot, the cheap/expected path), 1 = postgres
 * (direct fallback query — expected on a cold boot or when Redis is
 * unreachable/empty; persistently 1 is worth investigating, same posture as
 * the `sab-candidate-index: generation built from the Postgres fallback`
 * warn log in manager.ts).
 */
export const sabCandidateIndexLastBuildSource = createGauge({
  name: 'ci_sab_candidate_index_last_build_source',
  help: 'Data source of the most recent successful SAB candidate index rebuild (0 = redis fleet-wide snapshot, 1 = postgres fallback)',
  registers: [registry],
});

// The 2026-09-11 canary (ADR-027, "Canary 2") failed every rebuild on a
// capacity error and NOTHING below changed: builds_total stayed 0,
// crashes_total stayed 0 (a failed build is not a crash; the worker stays
// alive), ready stayed 0 — indistinguishable from a process that had just
// booted. The only evidence was the worker's log line. These four exist so
// the next canary is diagnosable from Prometheus alone.
export const sabCandidateIndexBuildFailuresTotal = createCounter({
  name: 'ci_sab_candidate_index_build_failures_total',
  help: 'Total failed SAB candidate index rebuilds per process (worker alive, last-good generation kept; ready stays 0 if no generation was ever built). reason: capacity | fetch | other',
  labelNames: ['reason'],
  registers: [registry],
});

export const sabCandidateIndexDistinctCapabilities = createGauge({
  name: 'ci_sab_candidate_index_distinct_capabilities',
  help: 'Distinct legacy capability strings encoded in the most recent successful SAB candidate index generation (hard limit: MAX_CAPABILITIES in capacity.ts, currently 128)',
  registers: [registry],
});

export const sabCandidateIndexMetadataBlobUsedBytes = createGauge({
  name: 'ci_sab_candidate_index_metadata_blob_used_bytes',
  help: 'Bytes of per-model metadata JSON written into the most recent successful SAB candidate index generation',
  registers: [registry],
});

export const sabCandidateIndexMetadataBlobCapacityBytes = createGauge({
  name: 'ci_sab_candidate_index_metadata_blob_capacity_bytes',
  help: 'Fixed capacity of the SAB candidate index metadata blob per generation (METADATA_BLOB_BYTES; override via SAB_CANDIDATE_METADATA_BLOB_BYTES)',
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
    modelExecutionQualityScore.observe(
      { model_id: modelId, provider, task_type: taskType },
      qualityScore
    );
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
export function recordArchiveState(params: { cellCount: number; avgFitness: number }): void {
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
    params.target
  );
  adaptiveQualityTargetConfidence.set(
    { task_type: params.taskType, complexity: params.complexity },
    params.confidence
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
    verdict,
    overallScore,
    durationMs,
    totalCostUsd,
    categoryScores,
    rewardCorrelation,
    driftDetected,
    gamingSignals,
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
// Provider-Native Prompt Cache Observability (ADR-025 follow-up, 2026-09)
// ============================================

/**
 * Provider-native prompt/context cache tokens actually reported back by a
 * vendor's own response `usage` payload, split hit vs miss.
 *
 * This is a DIFFERENT concept from `cacheHitsTotal`/`cacheMissesTotal` above
 * (ci's own semantic response cache, keyed by `organization_id` +
 * `match_type`): this counter is provider-side prefix/context caching —
 * Bedrock's `cachePoint`, Vertex AI's `cachedContentTokenCount`, Cohere's
 * `cached_tokens`, DeepSeek's `prompt_cache_hit_tokens`/
 * `prompt_cache_miss_tokens`, Moonshot's `cached_tokens`, Gemini's
 * `cachedContentTokenCount`, xAI's `prompt_tokens_details.cached_tokens`,
 * and the OpenAI-compatible-ecosystem's nested
 * `prompt_tokens_details.cached_tokens` (Groq, Azure, Cerebras, SambaNova,
 * Databricks) — none of which touch ci's own response cache at all. See
 * ADR-025 (`api/docs/adr/ADR-025-prompt-caching-scope-across-providers.md`)
 * for the full per-provider inventory this closes the observability gap for.
 *
 * Deliberately NOT folded into the shared `Usage` type
 * (`api/src/types/index.ts`) — ADR-025's own "Alternatives considered"
 * rejected that as scope creep shared by every provider, not something to
 * fix piecemeal per adapter. This counter is the additive, non-breaking
 * alternative: adapters record it as a side effect without changing the
 * `ChatResponse`/`Usage` contract any caller already depends on.
 */
export const providerPromptCacheTokensTotal = createCounter({
  name: 'ci_provider_prompt_cache_tokens_total',
  help: 'Provider-native prompt/context cache tokens reported in response usage, by hit/miss',
  labelNames: ['provider', 'outcome'], // outcome: 'hit' | 'miss'
  registers: [registry],
});

/**
 * Record provider-native cache hit/miss tokens for one response. Call sites
 * pass whichever of `hitTokens`/`missTokens` their vendor's response
 * actually reported — a provider that only reports a hit count (e.g.
 * Vertex AI's `cachedContentTokenCount`, Cohere's `cached_tokens`, Gemini's
 * `cachedContentTokenCount`, Moonshot's `cached_tokens`) can derive
 * `missTokens` as `promptTokens - hitTokens` at the call site, while one that
 * reports both directly (DeepSeek) passes both verbatim. Either field being
 * `undefined` or `0` is silently skipped — this only increments counters for
 * values a vendor actually sent, never a fabricated zero.
 */
export function recordProviderPromptCacheUsage(params: {
  provider: string;
  hitTokens?: number;
  missTokens?: number;
}): void {
  const { provider, hitTokens, missTokens } = params;
  if (typeof hitTokens === 'number' && hitTokens > 0) {
    providerPromptCacheTokensTotal.inc({ provider, outcome: 'hit' }, hitTokens);
  }
  if (typeof missTokens === 'number' && missTokens > 0) {
    providerPromptCacheTokensTotal.inc({ provider, outcome: 'miss' }, missTokens);
  }
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
