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
  /**
   * Per-provider discovery probe latency (2026-09-04, LOTE AK).
   *
   * `PROVIDER_DISCOVERY_DURATION_MS` above is the WHOLE-RUN wall clock with
   * no labels, so it could answer "was the sweep slow?" but never "which
   * provider made it slow?". `probeLatencyMs` was already computed per
   * provider and surfaced on the admin endpoint — it just never reached
   * Prometheus, so no dashboard or alert could see it.
   */
  PROVIDER_DISCOVERY_PROBE_LATENCY_MS: 'provider_discovery_probe_latency_ms',
  PROVIDER_CREDENTIAL_VALID_TOTAL: 'provider_credential_valid_total',
  PROVIDER_CREDIT_STATUS_TOTAL: 'provider_credit_status_total',
  PROVIDER_BALANCE: 'provider_balance',
  PROVIDER_BALANCE_CHECKED_AT: 'provider_balance_checked_at_timestamp_seconds',
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
  /**
   * Latency of ONE embedding computation against TEI (2026-09-04, LOTE AK).
   *
   * The embedding cache used to record this under
   * `PROVIDER_DISCOVERY_DURATION_MS`, which is a different subsystem
   * entirely — every cache miss polluted the discovery-duration histogram
   * with a TEI round-trip, so neither series meant what its name said.
   */
  EMBEDDING_COMPUTE_DURATION_MS: 'embedding_compute_duration_ms',
  /**
   * kNN search time inside the SemanticIndex, isolated from the embedding
   * round-trip and the pool filter around it (2026-09-04, LOTE AK).
   * `CANDIDATE_RESOLUTION_LATENCY_MS` times the whole resolve, so a slow
   * TEI and a slow index were indistinguishable in it.
   */
  SEMANTIC_INDEX_SEARCH_LATENCY_MS: 'semantic_index_search_latency_ms',
  CANDIDATE_RESOLUTION_LATENCY_MS: 'candidate_resolution_latency_ms',
  /**
   * Capability probes (2026-09-04, LOTE AK) — the lazy function-calling
   * probe and any future capability probe on the same pattern. It kept
   * process-local counters reachable only via `getProbeStats()` plus log
   * lines, so probe volume, verdict mix and cost were invisible to
   * Prometheus. `outcome` distinguishes a real capability verdict
   * (supported/unsupported) from a non-verdict (inconclusive/provider-dead),
   * which matters because only the first two are cached long-term.
   */
  CAPABILITY_PROBE_TOTAL: 'capability_probe_total',
  CAPABILITY_PROBE_LATENCY_MS: 'capability_probe_latency_ms',
  /**
   * Capability assertions written by the LIVE discovery path (2026-09-05,
   * GAP-A12). Before this, `writeAssertions()` was reachable only from
   * one-shot backfill scripts, so `capability_uris` silently went stale for
   * every provider onboarded after the last manual run — and nothing emitted
   * a signal that it had. These two make the write observable: `outcome`
   * separates a real write from a no-op (`empty`), an operator kill-switch
   * (`disabled`) and a swallowed failure (`failed`), which matters precisely
   * because the failure path is deliberately non-fatal to discovery.
   */
  CAPABILITY_ASSERTION_WRITE_TOTAL: 'capability_assertion_write_total',
  CAPABILITY_ASSERTION_WRITE_LATENCY_MS: 'capability_assertion_write_latency_ms',
  /** Assertion ROWS inserted, so drift can be watched as a rate, not a count of calls. */
  CAPABILITY_ASSERTION_ROWS_TOTAL: 'capability_assertion_rows_total',
  /**
   * Persistence of an EMPIRICAL capability verdict (2026-09-05, GAP-A13).
   * `model-not-found` is the expected, benign outcome when the probe fires for
   * a model this deployment's discovery has not materialised — it is broken
   * out rather than folded into `failed` because a rising rate means probe and
   * discovery disagree about provider/model identity, which is a real problem
   * that a generic failure counter would hide.
   */
  CAPABILITY_PROBE_ASSERTION_TOTAL: 'capability_probe_assertion_total',
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
  // ─── Retrieval + rerank (LOTE AP, 2026-09-05) ──────────────────────────
  /**
   * Two-stage retrieval executions. `outcome` separates a retrieval that
   * returned chunks from one that found none — an empty corpus and a broken
   * embedder look identical in a plain request counter, and `reranked` says
   * whether the cross-encoder second stage actually ran. Because reranking is
   * deliberately FAIL-SOFT, a rising `reranked="false"` rate on requests that
   * asked for it is the ONLY externally visible symptom of a reranker outage.
   */
  RETRIEVAL_REQUEST_TOTAL: 'retrieval_request_total',
  RETRIEVAL_LATENCY_MS: 'retrieval_latency_ms',
  /**
   * PDF understanding by extraction path (LOTE AP). `path` distinguishes a
   * document answered from its native text layer from one that needed page
   * rasterization + a vision model (the OCR fallback), and `hybrid` from
   * both. The two cost and take wildly different amounts of time, so a shift
   * in the mix is the first sign that either the text extractor regressed or
   * the incoming document population changed.
   */
  PDF_ANALYSIS_TOTAL: 'pdf_analysis_total',
  PDF_ANALYSIS_LATENCY_MS: 'pdf_analysis_latency_ms',
  /** Pages rasterized for the vision-OCR fallback, so its cost is countable. */
  PDF_OCR_PAGES_TOTAL: 'pdf_ocr_pages_total',
  // ─── Agentic sandbox (ADR-024, LOTE AV, 2026-09-06) ────────────────────
  /**
   * Every `execInSandbox` terminal outcome (ok/blocked/timeout/error/oom),
   * labeled by the network mode actually in force. `computer_use`, `mcp`
   * tool calls, and every step of the bounded agent loop all funnel through
   * this one counter, so an operator can see the capability's real traffic
   * and failure mix even while it sits behind a default-off flag.
   */
  SANDBOX_EXEC_TOTAL: 'sandbox_exec_total',
  SANDBOX_EXEC_DURATION_MS: 'sandbox_exec_duration_ms',
  /** A command or argument refused by the policy gate BEFORE anything spawned. */
  SANDBOX_POLICY_VIOLATION_TOTAL: 'sandbox_policy_violation_total',
  /** One bounded agent-loop run, labeled by its terminal stop reason. */
  AGENT_RUN_TOTAL: 'agent_run_total',
  /** One step within an agent run (one model turn + at most one tool call). */
  AGENT_STEP_TOTAL: 'agent_step_total',
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
  // providerId cardinality here is not a new class: PROVIDER_DISCOVERED_TOTAL
  // and PROVIDER_HEALTH_STATE already carry the same label.
  [METRIC_NAMES.PROVIDER_DISCOVERY_PROBE_LATENCY_MS]: {
    kind: 'histogram',
    help: 'Latency of the discovery probe for one provider, by outcome',
    labels: ['providerId', 'status'],
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
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
  [METRIC_NAMES.PROVIDER_BALANCE]: {
    kind: 'gauge',
    help: 'Last known account balance reported by the provider billing API (NaN = unknown)',
    labels: ['providerId', 'currency'],
  },
  [METRIC_NAMES.PROVIDER_BALANCE_CHECKED_AT]: {
    kind: 'gauge',
    help: 'Unix timestamp of the last successful balance probe per provider',
    labels: ['providerId'],
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
  [METRIC_NAMES.EMBEDDING_COMPUTE_DURATION_MS]: {
    kind: 'histogram',
    help: 'Latency of one TEI embedding computation (cache miss path)',
    labels: [],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  },
  [METRIC_NAMES.SEMANTIC_INDEX_SEARCH_LATENCY_MS]: {
    kind: 'histogram',
    help: 'SemanticIndex kNN search latency, isolated from embedding + filtering',
    labels: [],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 500],
  },
  [METRIC_NAMES.CANDIDATE_RESOLUTION_LATENCY_MS]: {
    kind: 'histogram',
    help: 'resolveSemanticCandidates wall-clock duration',
    labels: ['outcome'],
    buckets: [0.5, 1, 2, 5, 10, 50, 100, 500],
  },
  [METRIC_NAMES.CAPABILITY_PROBE_TOTAL]: {
    kind: 'counter',
    help: 'Capability probe outcomes (supported/unsupported/inconclusive/provider-dead)',
    labels: ['capability', 'providerId', 'outcome'],
  },
  [METRIC_NAMES.CAPABILITY_ASSERTION_WRITE_TOTAL]: {
    kind: 'counter',
    help: 'Discovery capability-assertion write outcomes (written/empty/failed/disabled)',
    labels: ['providerId', 'outcome'],
  },
  [METRIC_NAMES.CAPABILITY_ASSERTION_WRITE_LATENCY_MS]: {
    kind: 'histogram',
    help: 'Wall-clock latency of one discovery capability-assertion write, by outcome',
    labels: ['outcome'],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  },
  [METRIC_NAMES.CAPABILITY_ASSERTION_ROWS_TOTAL]: {
    kind: 'counter',
    help: 'Capability assertion rows inserted by the live discovery path',
    labels: ['providerId'],
  },
  [METRIC_NAMES.CAPABILITY_PROBE_ASSERTION_TOTAL]: {
    kind: 'counter',
    help: 'Runtime probe verdicts persisted as assertions (written/disabled/model-not-found/unmapped-capability/failed)',
    labels: ['capability', 'outcome'],
  },
  [METRIC_NAMES.CAPABILITY_PROBE_LATENCY_MS]: {
    kind: 'histogram',
    help: 'Wall-clock latency of one capability probe, by outcome',
    labels: ['capability', 'outcome'],
    buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
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
  [METRIC_NAMES.RETRIEVAL_REQUEST_TOTAL]: {
    kind: 'counter',
    help: 'Two-stage retrieval executions by outcome and whether rerank applied',
    labels: ['outcome', 'reranked'],
  },
  [METRIC_NAMES.RETRIEVAL_LATENCY_MS]: {
    kind: 'histogram',
    help: 'Wall-clock latency of a retrieval execution, by rerank participation',
    labels: ['reranked'],
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  },
  [METRIC_NAMES.PDF_ANALYSIS_TOTAL]: {
    kind: 'counter',
    help: 'PDF analyses by extraction path (native_text/vision_ocr/hybrid) and outcome',
    labels: ['path', 'outcome'],
  },
  [METRIC_NAMES.PDF_ANALYSIS_LATENCY_MS]: {
    kind: 'histogram',
    help: 'Wall-clock latency of a PDF analysis, by extraction path',
    labels: ['path'],
    buckets: [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000],
  },
  [METRIC_NAMES.PDF_OCR_PAGES_TOTAL]: {
    kind: 'counter',
    help: 'PDF pages rasterized and sent through the vision pipeline as OCR fallback',
    labels: ['outcome'],
  },
  [METRIC_NAMES.SANDBOX_EXEC_TOTAL]: {
    kind: 'counter',
    help: 'Agentic sandbox (ADR-024) container executions by outcome and network mode',
    labels: ['outcome', 'networkMode'],
  },
  [METRIC_NAMES.SANDBOX_EXEC_DURATION_MS]: {
    kind: 'histogram',
    help: 'Wall-clock latency of one agentic sandbox container execution, by outcome',
    labels: ['outcome'],
    buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
  },
  [METRIC_NAMES.SANDBOX_POLICY_VIOLATION_TOTAL]: {
    kind: 'counter',
    help: 'Commands or arguments refused by the sandbox policy gate before execution, by violation type',
    labels: ['violation'],
  },
  [METRIC_NAMES.AGENT_RUN_TOTAL]: {
    kind: 'counter',
    help: 'Bounded agent-loop runs by terminal stop reason',
    labels: ['stopReason'],
  },
  [METRIC_NAMES.AGENT_STEP_TOTAL]: {
    kind: 'counter',
    help: 'Bounded agent-loop steps by outcome',
    labels: ['outcome'],
  },
};

// ─── Prom-client lazy registration ────────────────────────────────────────

/**
 * Cached prom-client metric instances. Keyed by metric name. Created on
 * first use to avoid eager registration costs and to keep the module
 * import side-effect-free.
 */
const promCache = new Map<
  string,
  Counter<string> | Histogram<string> | Gauge<string> | undefined
>();

/**
 * Used for tests that want to swap a temporary registry. Defaults to the
 * global `prom-client` `register` exported by the library.
 */
let activeRegistry: Registry = register;

export function setActiveRegistryForTesting(registry: Registry | null): void {
  activeRegistry = registry ?? register;
  promCache.clear();
}

function getOrCreatePromMetric(
  name: MetricName
): Counter<string> | Histogram<string> | Gauge<string> | undefined {
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
    log.warn(
      { name, err: String(err) },
      'Failed to create prom-client metric — falling back to logs only'
    );
    promCache.set(name, undefined);
    return undefined;
  }
}

// ─── In-memory counters (testing + diagnostics) ────────────────────────────

const counters = new Map<string, number>();

function counterKey(
  metric: MetricName,
  labels: Readonly<Record<string, string | number | boolean>>
): string {
  const sortedKeys = Object.keys(labels).sort();
  const parts = sortedKeys.map((k) => `${k}=${String(labels[k])}`);
  return `${metric}{${parts.join(',')}}`;
}

function bumpCounter(
  metric: MetricName,
  labels: Readonly<Record<string, string | number | boolean>>,
  by = 1
): void {
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
  labels: Readonly<Record<string, string | number | boolean>>
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
  options: CounterIncrementOptions = {}
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
  labels: Readonly<Record<string, string | number | boolean>> = {}
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
  labels: Readonly<Record<string, string | number | boolean>> = {}
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
  labels: Readonly<Record<string, string | number | boolean>> = {}
): number {
  return counters.get(counterKey(metric, labels)) ?? 0;
}

export function getAllCountersForTesting(): ReadonlyMap<string, number> {
  return new Map(counters);
}

export function resetMetricCountersForTesting(): void {
  counters.clear();
}
