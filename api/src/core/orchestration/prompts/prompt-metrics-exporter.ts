// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Prometheus text-format exporter for prompt metrics (M-Export).
 *
 * The Lote 3 `prompt-metrics` module introduced a stable in-memory counter
 * vocabulary (`ailin_fallback_prompt_activations_total`, etc.) with a
 * deliberate Prometheus-compatible naming convention. M-Export turns that
 * in-memory state into a real scrape endpoint so dashboards and alerts can
 * finally query it.
 *
 * Design:
 *
 * - Pure formatter. This module does NOT start an HTTP server — it produces
 *   the text body, and the API's existing route layer serves it. That keeps
 *   the metrics exposure idiomatic to whatever web framework the process is
 *   already using and avoids introducing a second listener / port / auth
 *   boundary.
 *
 * - Zero runtime dependencies. The Prometheus text format is trivially
 *   serializable; pulling in `prom-client` to expose seven counters would be
 *   overkill and would fight our existing `incrementPromptMetric` API.
 *
 * - Every metric is emitted with a `# TYPE <name> counter` header and a
 *   short `# HELP <name> <doc>` line — both required by the text-format
 *   spec and consumed by Prometheus / Grafana for human-readable tooltips.
 *
 * - Metrics that have never been incremented are still emitted with value
 *   0. Silent metrics are harder to alert on than zero-valued ones because
 *   "no series present" is indistinguishable from "scrape is broken".
 *
 * Usage from a route handler:
 *
 *   import { exportPromptMetricsAsPrometheus } from '@/core/orchestration/prompts/prompt-metrics-exporter';
 *
 *   app.get('/metrics/prompts', (req, res) => {
 *     res.setHeader('Content-Type', 'text/plain; version=0.0.4');
 *     res.send(exportPromptMetricsAsPrometheus());
 *   });
 *
 * The text-format content type (`text/plain; version=0.0.4`) is the stable
 * Prometheus scrape contract.
 */

import {
  PROMPT_METRIC_NAMES,
  getPromptMetric,
  getLabelledSeries,
  type PromptMetricName,
} from './prompt-metrics';

/**
 * Additional counter names the exporter knows about. These live in the
 * selection-metrics / benchmark-judge-config modules and are registered here
 * so operators see a single `/metrics/prompts` endpoint. Missing any entry
 * here just means the metric emits with its raw counter name but no HELP
 * docstring — not a functional regression, just a documentation gap.
 */
const EXTRA_METRIC_HELP: Record<string, string> = {
  ailin_selection_candidates_returned_total:
    'Total times the DynamicModelSelector returned a non-empty candidate pool.',
  ailin_selection_candidates_rejected_total:
    'Total candidates rejected by the selector, tagged with reason label.',
  ailin_selection_no_eligible_model_total:
    'Total times the selector produced zero eligible candidates.',
  ailin_selection_fallback_to_ranked_total:
    'Total times the selector fell back from stableCandidates to rankedCandidates.',
  ailin_selection_native_preferred_total:
    'Total times a native provider was selected over a hub equivalent (same model id).',
  ailin_selection_hub_chosen_over_native_total:
    'Total times a hub provider was selected over a native equivalent (same model id).',
  ailin_selection_provider_selected_total:
    'Total provider selections, labelled by provider, providerKind, strategy, taskType.',
  ailin_runtime_model_execution_failed_total:
    'Total model execution failures, labelled by cause (provider-auth|balance|timeout|...).',
  ailin_runtime_provider_registry_state_total:
    'Provider registry state events, labelled by state.',
  ailin_benchmark_judge_path_failure_total:
    'Total judge-path failures during benchmark runs, labelled by cause.',
  // Lote 6 — slot/variant/augmentation metrics
  ailin_prompt_slot_injections_total:
    'Total times validated prompt slots were injected into a catalog prompt.',
  ailin_prompt_slot_validation_failures_total:
    'Total times prompt slot validation failed (Zod schema, token budget).',
  ailin_prompt_slot_token_budget_exceeded_total:
    'Total times rendered slot augmentation exceeded the 500-token budget.',
  ailin_prompt_variant_selected_total:
    'Total times a prompt variant was selected by the LinUCB bandit, labelled by promptKey and variantId.',
  ailin_prompt_augmentation_accepted_total:
    'Total times the augmentation sandbox was accepted (passed deny-pattern validation).',
  ailin_prompt_augmentation_rejected_total:
    'Total times the augmentation sandbox was rejected by deny patterns.',
};

/** Prometheus content type. Use this on the HTTP response header. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4';

/**
 * Human-readable `HELP` strings for each counter. These land verbatim in
 * Prometheus and are shown as tooltips in Grafana. Keep them one line.
 */
const METRIC_HELP: Record<PromptMetricName, string> = {
  [PROMPT_METRIC_NAMES.FALLBACK_ACTIVATIONS]:
    'Total times the Ailin¹ fallback system prompt was activated because no catalog or builder prompt was available.',
  [PROMPT_METRIC_NAMES.PEER_REVIEW_INJECTIONS]:
    'Total times the peer-review (social-facilitation) system message was injected into a collective-strategy request.',
  [PROMPT_METRIC_NAMES.PEER_REVIEW_SKIPPED]:
    'Total times the peer-review prepend was skipped (reason in attribute: single-strategy | mode-off | already-present).',
  [PROMPT_METRIC_NAMES.TRIAGE_PARSE_FAILURES]:
    'Total triage responses that failed to parse (stage attribute: json | zod).',
  [PROMPT_METRIC_NAMES.TRIAGE_DRIFT_DETECTED]:
    'Total unknown top-level keys detected in triage responses (one increment per key).',
  [PROMPT_METRIC_NAMES.JUDGE_NORMALIZATIONS]:
    'Total times a judge output was routed through the unified JudgeVerdict normalizer.',
  [PROMPT_METRIC_NAMES.JUDGE_NORMALIZATION_FAILURES]:
    'Total times the JudgeVerdict normalizer could not recognize the input shape.',
};

/**
 * Serialize all prompt metrics as Prometheus text format. The output is a
 * complete scrape body — no trailing newline is required (Prometheus is
 * tolerant) but we emit one for consistency with other scrapers.
 *
 * Metrics are emitted in a deterministic order (the order of declaration in
 * `PROMPT_METRIC_NAMES`) so text diffs between scrapes stay stable.
 */
export function exportPromptMetricsAsPrometheus(): string {
  const lines: string[] = [];

  // Pass 1: canonical prompt counters (always emitted, even if 0)
  for (const name of Object.values(PROMPT_METRIC_NAMES) as PromptMetricName[]) {
    const help = METRIC_HELP[name];
    emitCounter(lines, name, help);
  }

  // Pass 2: extra counters (selection, runtime, benchmark). We only emit the
  // ones that have been touched at least once — this avoids polluting the
  // scrape with dozens of zero-valued selection-metric rows on cold start.
  for (const [name, help] of Object.entries(EXTRA_METRIC_HELP)) {
    const hasSeries = getLabelledSeries(name).size > 0 || getPromptMetric(name) > 0;
    if (!hasSeries) continue;
    emitCounter(lines, name, help);
  }

  return lines.join('\n') + '\n';
}

/**
 * Emit a single counter as Prometheus text. When labelled series exist for
 * the counter, one line per label combination is emitted; otherwise a single
 * rolled-up line is emitted.
 */
function emitCounter(lines: string[], name: string, help: string | undefined): void {
  const resolvedHelp = help ?? `Ailin¹ metric ${name}`;
  lines.push(`# HELP ${name} ${resolvedHelp}`);
  lines.push(`# TYPE ${name} counter`);

  const series = getLabelledSeries(name);
  if (series.size === 0) {
    lines.push(`${name} ${getPromptMetric(name)}`);
    return;
  }

  for (const [labelKey, value] of series) {
    if (!labelKey) {
      lines.push(`${name} ${value}`);
    } else {
      lines.push(`${name}{${formatPromLabels(labelKey)}} ${value}`);
    }
  }
}

/**
 * Convert our canonical label key (`"reason=off,where=x"`) into a valid
 * Prometheus label string (`reason="off",where="x"`). Escapes per the
 * Prometheus text format: backslash, double-quote, and newline.
 */
function formatPromLabels(canonicalLabelKey: string): string {
  return canonicalLabelKey
    .split(',')
    .map((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx < 0) return '';
      const k = pair.slice(0, eqIdx);
      const v = pair.slice(eqIdx + 1);
      const escaped = v
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');
      return `${k}="${escaped}"`;
    })
    .filter((s) => s.length > 0)
    .join(',');
}

/**
 * Produce the same metrics as a structured JSON snapshot. Useful for
 * operators who want a machine-readable view without a Prometheus scraper,
 * or for a `/debug/metrics` endpoint that complements `/metrics/prompts`.
 */
export interface PromptMetricsJsonSnapshot {
  metrics: Array<{
    name: PromptMetricName;
    help: string;
    type: 'counter';
    value: number;
  }>;
}

export function exportPromptMetricsAsJson(): PromptMetricsJsonSnapshot {
  return {
    metrics: (Object.values(PROMPT_METRIC_NAMES) as PromptMetricName[]).map((name) => ({
      name,
      help: METRIC_HELP[name],
      type: 'counter' as const,
      value: getPromptMetric(name),
    })),
  };
}
