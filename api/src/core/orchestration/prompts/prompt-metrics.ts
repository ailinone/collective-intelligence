// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Structured metrics for the prompts pipeline (O-Obs).
 *
 * This module is the single place where prompt-layer signals are counted and
 * read. It replaces ad-hoc `logger.warn` calls that made it hard to answer
 * operational questions like "how many requests hit the Ailin¹ fallback last
 * hour" or "how many triage responses failed Zod validation this week".
 *
 * Design choices:
 * - Counters are plain in-memory integers keyed by a string. No external
 *   dependencies so the module is safe to import from anywhere (including
 *   files that predate observability infra).
 * - Each increment also emits a structured `logger.info` line so existing log
 *   shipping pipelines see the event without a separate integration step.
 * - `getPromptMetricSnapshot()` returns a defensive copy so tests can assert
 *   on counter deltas without racing the module.
 * - `resetPromptMetrics()` exists only to keep tests deterministic. It is
 *   never called by production code.
 *
 * The counter NAMES are the stable contract and should not be renamed without
 * updating every consumer. They follow `ailin_<subsystem>_<event>` to stay
 * compatible with a future Prometheus exporter.
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'prompt-metrics' });

/**
 * Canonical counter names. Adding a new counter is cheap; renaming or removing
 * one is a breaking change for any dashboard that already queries it.
 */
export const PROMPT_METRIC_NAMES = {
  FALLBACK_ACTIVATIONS: 'ailin_fallback_prompt_activations_total',
  PEER_REVIEW_INJECTIONS: 'ailin_peer_review_injections_total',
  PEER_REVIEW_SKIPPED: 'ailin_peer_review_skipped_total',
  TRIAGE_PARSE_FAILURES: 'ailin_triage_parse_failures_total',
  TRIAGE_DRIFT_DETECTED: 'ailin_triage_drift_detected_total',
  JUDGE_NORMALIZATIONS: 'ailin_judge_normalizations_total',
  JUDGE_NORMALIZATION_FAILURES: 'ailin_judge_normalization_failures_total',
} as const;

export type PromptMetricName =
  (typeof PROMPT_METRIC_NAMES)[keyof typeof PROMPT_METRIC_NAMES];

/**
 * Two-level counter store (Lote 5 — O1):
 *
 *   - `counters`       — unlabelled rollups, used for quick total reads.
 *   - `labelledCounters` — per-label-combination counts, for Prometheus
 *     label-aware scraping.
 *
 * The label key is a deterministic string built from sorted `<k>=<v>` pairs
 * so the same attribute set always hashes to the same key. This preserves
 * Prometheus cardinality semantics without requiring a dedicated map per
 * counter name.
 */
const counters = new Map<string, number>();
const labelledCounters = new Map<string, Map<string, number>>();

/** Structured attributes attached to each metric increment for observability backends. */
export type PromptMetricAttributes = Record<string, string | number | boolean | undefined>;

/**
 * Subset of attribute values that are safe to use as Prometheus label values.
 * Numbers and booleans are coerced to strings. Undefined drops the label
 * (Prometheus has no null concept). The keys `count` and `value` are NEVER
 * promoted to labels — they are reserved for the counter value itself.
 */
function attributesToLabelMap(
  attributes: PromptMetricAttributes,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (v === undefined) continue;
    if (k === 'count' || k === 'value') continue;
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

/**
 * Build a deterministic key for a label set. `{reason: 'off', where: 'x'}`
 * and `{where: 'x', reason: 'off'}` produce the same key.
 */
function canonicalLabelKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

/**
 * Increment a counter by 1 and emit a structured log line.
 *
 * @param name       One of `PROMPT_METRIC_NAMES`. Passing an arbitrary string
 *                   is allowed but discouraged — the exported constants are
 *                   the stable observability contract.
 * @param attributes Optional structured attributes (e.g. `{ where, reason }`).
 *                   Non-reserved string/number/boolean attributes become
 *                   Prometheus labels in the exporter.
 */
export function incrementPromptMetric(
  name: PromptMetricName | string,
  attributes: PromptMetricAttributes = {},
): void {
  // Unlabelled rollup
  const current = counters.get(name) ?? 0;
  counters.set(name, current + 1);

  // Labelled series (O1)
  const labels = attributesToLabelMap(attributes);
  const labelKey = canonicalLabelKey(labels);
  let perLabel = labelledCounters.get(name);
  if (!perLabel) {
    perLabel = new Map<string, number>();
    labelledCounters.set(name, perLabel);
  }
  perLabel.set(labelKey, (perLabel.get(labelKey) ?? 0) + 1);

  log.info({ metric: name, value: current + 1, ...attributes }, `prompt-metric ${name}`);
}

/**
 * Read the current value of a counter. Returns 0 if the counter has never
 * been touched. Used by tests and operator debug tooling.
 */
export function getPromptMetric(name: PromptMetricName | string): number {
  return counters.get(name) ?? 0;
}

/**
 * Read the labelled-series state for a metric name. Returns a map keyed by
 * the canonical label key (`"reason=off,where=x"`). Used by the Prometheus
 * exporter to emit one series per label combination.
 */
export function getLabelledSeries(
  name: PromptMetricName | string,
): ReadonlyMap<string, number> {
  return labelledCounters.get(name) ?? new Map();
}

/**
 * Return a defensive snapshot of all prompt-layer counters. Intended for
 * debug endpoints and test assertions.
 */
export function getPromptMetricSnapshot(): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [k, v] of counters) out[k] = v;
  return out;
}

/**
 * Reset all counters. ONLY for tests. Production code should never call this.
 */
export function resetPromptMetrics(): void {
  counters.clear();
  labelledCounters.clear();
}
