// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Operability metrics — structured logs + Prometheus client.
 *
 * Phase 1.6 (2026-05-08): bridge to `prom-client`. Each emitter still emits
 * a structured log line (forward-compatible diagnostic) AND updates a
 * Prometheus counter/histogram/gauge registered against the same global
 * `register` used by `observability/ci-metrics.ts`. The `/metrics`
 * endpoint scraped by Prometheus picks them up automatically.
 *
 * Why both:
 *   - Logs are durable (debugging history) and accessible without
 *     Prometheus wired up (local dev, smoke tests).
 *   - Prom-client is the production observability surface and powers
 *     Grafana dashboards + CI gates.
 *   - In-memory counters are for unit tests asserting "X was called N
 *     times" without spinning up a registry.
 *
 * Lazy registration: prom-client metrics are created on first emission
 * for that label set. This keeps the module import-cycle clean —
 * importing `operability/metrics` does NOT eagerly register dozens of
 * metrics that may never fire in this process.
 */

import { Counter, Histogram, Gauge, register, type Registry } from 'prom-client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'operability-metrics' });

// ─── Metric names (exported so callers and tests share a single source) ────

export const METRIC_NAMES = Object.freeze({
  PROVIDER_CONFIGURED_TOTAL: 'provider_configured_total',
  PROVIDER_DISCOVERED_TOTAL: 'provider_discovered_total',
  PROVIDER_DISCOVERY_DURATION_MS: 'provider_discovery_duration_ms',
  PROVIDER_CREDENTIAL_VALID_TOTAL: 'provider_credential_valid_total',
  PROVIDER_CREDIT_STATUS_TOTAL: 'provider_credit_status_total',
  PROVIDER_CONFIGURED_BUT_NOT_DISCOVERED_TOTAL: 'provider_configured_but_not_discovered_total',
  PROVIDER_WITH_CREDIT_NOT_CONSIDERED_TOTAL: 'provider_with_credit_not_considered_total',
  CANDIDATE_TRACE_TOTAL: 'candidate_trace_total',
  PROVIDER_HEALTH_STATE: 'provider_health_state',
  PROVIDER_MODEL_HEALTH_STATE: 'provider_model_health_state',
  KNOWN_BAD_SKIP_TOTAL: 'known_bad_skip_total',
  KNOWN_BAD_SKIP_LATENCY_MS: 'known_bad_skip_latency_ms',
  DEAD_PROVIDER_HTTP_ATTEMPT_TOTAL: 'dead_provider_http_attempt_total',
  PROVIDER_ERROR_CLASS_TOTAL: 'provider_error_class_total',
  SERIAL_DEAD_PROVIDER_LATENCY_MS: 'serial_dead_provider_latency_ms',
  TIMEOUT_WASTE_LATENCY_MS: 'timeout_waste_latency_ms',
  EMBEDDING_PIPELINE_RUN_TOTAL: 'embedding_pipeline_run_total',
  EMBEDDING_PIPELINE_DURATION_MS: 'embedding_pipeline_duration_ms',
  EMBEDDING_PIPELINE_MODELS_EMBEDDED_TOTAL: 'embedding_pipeline_models_embedded_total',
  EMBEDDING_PIPELINE_FAILED_TOTAL: 'embedding_pipeline_failed_total',
  SEMANTIC_INDEX_SIZE: 'semantic_index_size',
  SEMANTIC_INDEX_LAST_REBUILD_AT: 'semantic_index_last_rebuild_at',
  TEI_HEALTH_STATE: 'tei_health_state',
  EMBEDDING_CACHE_HIT_RATE: 'embedding_cache_hit_rate',
  CANDIDATE_RESOLUTION_LATENCY_MS: 'candidate_resolution_latency_ms',
  SEMANTIC_RETRY_USED_TOTAL: 'semantic_retry_used_total',
  SEMANTIC_RETRY_FALLBACK_TOTAL: 'semantic_retry_fallback_total',
  // ─── LLM-judge observability (LLMJudgeEvaluator path) ───────────────────
  // Emitted by ProviderLLMJudgeClient so the rubric-based judge is as
  // observable as the consensus/experiment judges. `parseClass` records how
  // the raw judge output was recovered (ok=clean JSON, salvaged=regex-salvage
  // of truncated/malformed JSON, or a failure class) so ops can see how often
  // the judge drifts and how much the tolerant salvage recovers.
  LLM_JUDGE_RESULT_TOTAL: 'llm_judge_result_total',
  LLM_JUDGE_LATENCY_MS: 'llm_judge_latency_ms',
  LLM_JUDGE_SCORE: 'llm_judge_score',
} as const);

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

// ─── Prometheus registration metadata ─────────────────────────────────────

/**
 * Maps metric names to their Prometheus type + help text + label set.
 * Histograms get default buckets; counters/gauges declare label names.
 *
 * Adding a new label requires updating this map AND the type signature
 * of `incrementCounter` callers — labels not declared here are silently
 * dropped by prom-client (lossy), but the in-memory counter still records
 * them, so unit tests asserting on labels keep working.
 */
const METRIC_DEFS: Record<
  MetricName,
  | { kind: 'counter'; help: string; labels: readonly string[] }
  | { kind: 'histogram'; help: string; labels: readonly string[]; buckets?: readonly number[] }
  | { kind: 'gauge'; help: string; labels: readonly string[] }
> = {
  [METRIC_NAMES.PROVIDER_CONFIGURED_TOTAL]: {
    kind: 'counter',
    help: 'Number of providers in the configured list at discovery time',
    labels: ['providerId'],
  },
  [METRIC_NAMES.PROVIDER_DISCOVERED_TOTAL]: {
    kind: 'counter',
    help: 'Discovery probe outcomes per provider',
    labels: ['providerId', 'status'],
  },
  [METRIC_NAMES.PROVIDER_DISCOVERY_DURATION_MS]: {
    kind: 'histogram',
    help: 'Total wall-clock duration of a discovery run',
    labels: [],
    buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  },
  [METRIC_NAMES.PROVIDER_CREDENTIAL_VALID_TOTAL]: {
    kind: 'counter',
    help: 'Credential probe outcomes per provider',
    labels: ['providerId', 'status'],
  },
  [METRIC_NAMES.PROVIDER_CREDIT_STATUS_TOTAL]: {
    kind: 'counter',
    help: 'Credit/balance probe outcomes',
    labels: ['providerId', 'status'],
  },
  [METRIC_NAMES.PROVIDER_CONFIGURED_BUT_NOT_DISCOVERED_TOTAL]: {
    kind: 'counter',
    help: 'Providers configured that did not enter the operational pool',
    labels: ['providerId', 'reason'],
  },
  [METRIC_NAMES.PROVIDER_WITH_CREDIT_NOT_CONSIDERED_TOTAL]: {
    kind: 'counter',
    help: 'Providers that have credit but were not considered for execution',
    labels: ['providerId', 'reason'],
  },
  [METRIC_NAMES.CANDIDATE_TRACE_TOTAL]: {
    kind: 'counter',
    help: 'CandidateTrace events emitted per stage',
    labels: ['stage', 'included', 'reason'],
  },
  [METRIC_NAMES.PROVIDER_HEALTH_STATE]: {
    kind: 'gauge',
    help: 'Provider-level health state numeric value (1=healthy, 0=disabled)',
    labels: ['providerId', 'state'],
  },
  [METRIC_NAMES.PROVIDER_MODEL_HEALTH_STATE]: {
    kind: 'gauge',
    help: 'Provider+model health state numeric value',
    labels: ['providerId', 'modelId', 'state'],
  },
  [METRIC_NAMES.KNOWN_BAD_SKIP_TOTAL]: {
    kind: 'counter',
    help: 'Number of times shouldSkipNearZero returned skip=true',
    labels: ['providerId', 'reason'],
  },
  [METRIC_NAMES.KNOWN_BAD_SKIP_LATENCY_MS]: {
    kind: 'histogram',
    help: 'Latency of the shouldSkipNearZero predicate',
    labels: ['outcome', 'state'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 50, 100],
  },
  [METRIC_NAMES.DEAD_PROVIDER_HTTP_ATTEMPT_TOTAL]: {
    kind: 'counter',
    help: 'HTTP attempts that bypassed shouldSkipNearZero — must stay ~0',
    labels: ['providerId', 'modelId', 'reason'],
  },
  [METRIC_NAMES.PROVIDER_ERROR_CLASS_TOTAL]: {
    kind: 'counter',
    help: 'Provider errors classified by ProviderErrorClass',
    labels: ['providerId', 'errorClass'],
  },
  [METRIC_NAMES.SERIAL_DEAD_PROVIDER_LATENCY_MS]: {
    kind: 'histogram',
    help: 'Wall-clock spent traversing dead providers in serial fallback',
    labels: [],
    buckets: [1, 5, 10, 50, 100, 500, 1000, 5000],
  },
  [METRIC_NAMES.TIMEOUT_WASTE_LATENCY_MS]: {
    kind: 'histogram',
    help: 'Wall-clock spent waiting on provider timeouts that produced no usable response',
    labels: [],
    buckets: [10, 100, 500, 1000, 5000, 10000, 30000, 60000],
  },
  [METRIC_NAMES.EMBEDDING_PIPELINE_RUN_TOTAL]: {
    kind: 'counter',
    help: 'Number of embedding pipeline runs',
    labels: ['result'],
  },
  [METRIC_NAMES.EMBEDDING_PIPELINE_DURATION_MS]: {
    kind: 'histogram',
    help: 'Wall-clock duration of an embedding pipeline run',
    labels: [],
    buckets: [100, 500, 1000, 5000, 10000, 30000, 60000, 120000],
  },
  [METRIC_NAMES.EMBEDDING_PIPELINE_MODELS_EMBEDDED_TOTAL]: {
    kind: 'counter',
    help: 'Total candidates embedded across all pipeline runs',
    labels: [],
  },
  [METRIC_NAMES.EMBEDDING_PIPELINE_FAILED_TOTAL]: {
    kind: 'counter',
    help: 'Embedding pipeline failures by reason',
    labels: ['reason'],
  },
  [METRIC_NAMES.SEMANTIC_INDEX_SIZE]: {
    kind: 'gauge',
    help: 'Current SemanticIndex size',
    labels: [],
  },
  [METRIC_NAMES.SEMANTIC_INDEX_LAST_REBUILD_AT]: {
    kind: 'gauge',
    help: 'Unix timestamp of the last successful index rebuild',
    labels: [],
  },
  [METRIC_NAMES.TEI_HEALTH_STATE]: {
    kind: 'gauge',
    help: 'TEI embedder health (1=healthy, 0=unhealthy)',
    labels: [],
  },
  [METRIC_NAMES.EMBEDDING_CACHE_HIT_RATE]: {
    kind: 'gauge',
    help: 'Embedding cache hit rate (0.0 to 1.0)',
    labels: [],
  },
  [METRIC_NAMES.CANDIDATE_RESOLUTION_LATENCY_MS]: {
    kind: 'histogram',
    help: 'resolveSemanticCandidates wall-clock duration',
    labels: ['outcome'],
    buckets: [0.5, 1, 2, 5, 10, 50, 100, 500],
  },
  [METRIC_NAMES.SEMANTIC_RETRY_USED_TOTAL]: {
    kind: 'counter',
    help: 'Cross-provider retry path that used semantic re-ranking',
    labels: ['result'],
  },
  [METRIC_NAMES.SEMANTIC_RETRY_FALLBACK_TOTAL]: {
    kind: 'counter',
    help: 'Cross-provider retry path that fell back to legacy ranking',
    labels: ['reason'],
  },
  [METRIC_NAMES.LLM_JUDGE_RESULT_TOTAL]: {
    kind: 'counter',
    help: 'LLM-judge outcomes by verdict and how the output was parsed/salvaged',
    labels: ['verdict', 'parseClass'],
  },
  [METRIC_NAMES.LLM_JUDGE_LATENCY_MS]: {
    kind: 'histogram',
    help: 'Wall-clock latency of an LLM-judge call, by verdict',
    labels: ['verdict'],
    buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 30000, 60000],
  },
  [METRIC_NAMES.LLM_JUDGE_SCORE]: {
    kind: 'histogram',
    help: 'Distribution of LLM-judge scores in [0,1], by verdict',
    labels: ['verdict'],
    buckets: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
  },
};

// ─── Prom-client lazy registration ────────────────────────────────────────

/**
 * Cached prom-client metric instances. Keyed by metric name. Created on
 * first use to avoid eager registration costs and to keep the module
 * import side-effect-free.
 */
const promCache = new Map<string, Counter<string> | Histogram<string> | Gauge<string> | undefined>();

/**
 * Used for tests that want to swap a temporary registry. Defaults to the
 * global `prom-client` `register` exported by the library.
 */
let activeRegistry: Registry = register;

export function setActiveRegistryForTesting(registry: Registry | null): void {
  activeRegistry = registry ?? register;
  promCache.clear();
}

function getOrCreatePromMetric(name: MetricName): Counter<string> | Histogram<string> | Gauge<string> | undefined {
  const cached = promCache.get(name);
  if (cached) return cached;

  const def = METRIC_DEFS[name];
  if (!def) return undefined;

  // Reuse if already registered (e.g., another module declared this name)
  const existing = activeRegistry.getSingleMetric(name);
  if (existing) {
    promCache.set(name, existing as Counter<string> | Histogram<string> | Gauge<string>);
    return existing as Counter<string> | Histogram<string> | Gauge<string>;
  }

  try {
    let created: Counter<string> | Histogram<string> | Gauge<string>;
    if (def.kind === 'counter') {
      created = new Counter({
        name,
        help: def.help,
        labelNames: [...def.labels],
        registers: [activeRegistry],
      });
    } else if (def.kind === 'histogram') {
      created = new Histogram({
        name,
        help: def.help,
        labelNames: [...def.labels],
        buckets: def.buckets ? [...def.buckets] : undefined,
        registers: [activeRegistry],
      });
    } else {
      created = new Gauge({
        name,
        help: def.help,
        labelNames: [...def.labels],
        registers: [activeRegistry],
      });
    }
    promCache.set(name, created);
    return created;
  } catch (err) {
    // Registration failure (rare — usually duplicate name with mismatched
    // labels). Log once and disable prom for this metric to keep the
    // logs+tests path working.
    log.warn({ name, err: String(err) }, 'Failed to create prom-client metric — falling back to logs only');
    promCache.set(name, undefined);
    return undefined;
  }
}

// ─── In-memory counters (testing + diagnostics) ────────────────────────────

const counters = new Map<string, number>();

function counterKey(metric: MetricName, labels: Readonly<Record<string, string | number | boolean>>): string {
  const sortedKeys = Object.keys(labels).sort();
  const parts = sortedKeys.map((k) => `${k}=${String(labels[k])}`);
  return `${metric}{${parts.join(',')}}`;
}

function bumpCounter(metric: MetricName, labels: Readonly<Record<string, string | number | boolean>>, by = 1): void {
  const key = counterKey(metric, labels);
  counters.set(key, (counters.get(key) ?? 0) + by);
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface CounterIncrementOptions {
  by?: number;
  /** Emit a log line in addition to bumping the counter. Default true. */
  log?: boolean;
}

/**
 * Restricts the labels object to only those declared in METRIC_DEFS.
 * Labels not in the spec are silently dropped from the prom-client
 * call (prom-client throws on unknown labels otherwise) but kept in
 * the in-memory counter for test introspection.
 */
function projectLabels(
  metric: MetricName,
  labels: Readonly<Record<string, string | number | boolean>>,
): Record<string, string> {
  const def = METRIC_DEFS[metric];
  if (!def) return {};
  const result: Record<string, string> = {};
  for (const declared of def.labels) {
    if (declared in labels) {
      result[declared] = String(labels[declared]);
    }
  }
  return result;
}

export function incrementCounter(
  metric: MetricName,
  labels: Readonly<Record<string, string | number | boolean>> = {},
  options: CounterIncrementOptions = {},
): void {
  const by = options.by ?? 1;
  bumpCounter(metric, labels, by);

  const promMetric = getOrCreatePromMetric(metric);
  if (promMetric && 'inc' in promMetric) {
    try {
      (promMetric as Counter<string>).inc(projectLabels(metric, labels), by);
    } catch (err) {
      // E.g. label cardinality mismatch. Don't crash the caller.
      log.debug({ metric, err: String(err) }, 'prom-client inc failed');
    }
  }

  if (options.log !== false) {
    log.debug({ metric, type: 'counter', labels, value: by }, 'metric.counter');
  }
}

export function observeHistogram(
  metric: MetricName,
  valueMs: number,
  labels: Readonly<Record<string, string | number | boolean>> = {},
): void {
  const promMetric = getOrCreatePromMetric(metric);
  if (promMetric && 'observe' in promMetric) {
    try {
      (promMetric as Histogram<string>).observe(projectLabels(metric, labels), valueMs);
    } catch (err) {
      log.debug({ metric, err: String(err) }, 'prom-client observe failed');
    }
  }
  log.debug({ metric, type: 'histogram', labels, value_ms: valueMs }, 'metric.histogram');
}

export function setGauge(
  metric: MetricName,
  value: number,
  labels: Readonly<Record<string, string | number | boolean>> = {},
): void {
  const key = counterKey(metric, labels);
  counters.set(key, value);

  const promMetric = getOrCreatePromMetric(metric);
  if (promMetric && 'set' in promMetric) {
    try {
      (promMetric as Gauge<string>).set(projectLabels(metric, labels), value);
    } catch (err) {
      log.debug({ metric, err: String(err) }, 'prom-client set failed');
    }
  }

  log.debug({ metric, type: 'gauge', labels, value }, 'metric.gauge');
}

// ─── Test helpers ──────────────────────────────────────────────────────────

export function getCounterValueForTesting(
  metric: MetricName,
  labels: Readonly<Record<string, string | number | boolean>> = {},
): number {
  return counters.get(counterKey(metric, labels)) ?? 0;
}

export function getAllCountersForTesting(): ReadonlyMap<string, number> {
  return new Map(counters);
}

export function resetMetricCountersForTesting(): void {
  counters.clear();
}
