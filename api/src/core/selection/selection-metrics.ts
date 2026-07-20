// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Selection / runtime metrics (Lote 5 — S2).
 *
 * Extends the prompt-metrics vocabulary introduced in Lote 3 with a second
 * bank of counters for the `DynamicModelSelector` and provider runtime. Uses
 * the same `incrementPromptMetric` backend so all metrics flow through one
 * exporter and one log format.
 *
 * The counters here answer the operational questions that were impossible to
 * answer during the Lote 4 benchmark post-mortem:
 *
 *   - How many candidates did the selector return?
 *   - How many were rejected, and by which filter?
 *   - How many times did the selector end up with zero eligible models?
 *   - When did we prefer a native provider over a hub equivalent — or vice versa?
 *   - Which provider was actually chosen, per task type?
 *   - Which providers failed, and for what reason (auth / balance / timeout / ...)?
 *   - How many providers are currently registered / disabled / unhealthy?
 *
 * Every counter is labelled and named `ailin_selection_*` so a Prometheus
 * scraper can discover them via the existing `/metrics/prompts` exporter
 * (the Lote 5 exporter upgrade now propagates attribute labels).
 */

import {
  incrementPromptMetric,
} from '@/core/orchestration/prompts/prompt-metrics';

/**
 * Stable counter names. Adding a new counter is cheap; renaming is a breaking
 * change for any dashboard that already queries it.
 */
export const SELECTION_METRIC_NAMES = {
  CANDIDATES_RETURNED: 'ailin_selection_candidates_returned_total',
  CANDIDATES_REJECTED: 'ailin_selection_candidates_rejected_total',
  NO_ELIGIBLE_MODEL: 'ailin_selection_no_eligible_model_total',
  FALLBACK_TO_RANKED: 'ailin_selection_fallback_to_ranked_total',
  NATIVE_PREFERRED: 'ailin_selection_native_preferred_total',
  HUB_CHOSEN_OVER_NATIVE: 'ailin_selection_hub_chosen_over_native_total',
  PROVIDER_SELECTED: 'ailin_selection_provider_selected_total',
  MODEL_EXECUTION_FAILED: 'ailin_runtime_model_execution_failed_total',
  PROVIDER_REGISTRY_STATE: 'ailin_runtime_provider_registry_state_total',
} as const;

export type SelectionMetricName =
  (typeof SELECTION_METRIC_NAMES)[keyof typeof SELECTION_METRIC_NAMES];

/**
 * Reasons a candidate can be rejected during selection. Closed enum so the
 * label space is bounded — operators can build alerts like
 * `sum(rate(ailin_selection_candidates_rejected_total{reason="balance"}[5m]))`.
 */
export type RejectionReason =
  | 'capability-mismatch'
  | 'health'
  | 'balance'
  | 'stability'
  | 'cost-gate'
  | 'score-below-threshold'
  | 'provider-disabled'
  | 'provider-no-credential'
  | 'excluded-by-runtime-constraint'
  | 'context-window-too-small';

/**
 * Reasons a runtime model execution can fail. Closed enum, each tagged with
 * the HTTP status or exception class it most often corresponds to.
 */
export type ExecutionFailureCause =
  | 'provider-auth'         // 401 / 403
  | 'balance'               // 402 / insufficient credit
  | 'rate-limit'            // 429
  | 'timeout'               // wall-clock exceeded
  | 'provider-error'        // 5xx
  | 'schema-error'          // response shape invalid
  | 'adapter-not-found'     // provider registry missing adapter
  | 'unknown';

/** Kinds a provider can be in from the registry's perspective. */
export type ProviderRegistryState =
  | 'enabled'
  | 'disabled-no-credential'
  | 'disabled-config'
  | 'unhealthy'
  | 'circuit-open';

// ──────────────────────────────────────────────────────────────────────────
// Emitter helpers — kept small and typed so call sites stay readable.
// ──────────────────────────────────────────────────────────────────────────

export function recordSelectionCandidates(count: number, attributes: Record<string, string | number> = {}): void {
  incrementPromptMetric(SELECTION_METRIC_NAMES.CANDIDATES_RETURNED, {
    ...attributes,
    count,
  });
}

export function recordSelectionRejection(
  reason: RejectionReason,
  count: number,
  attributes: Record<string, string | number> = {},
): void {
  if (count <= 0) return;
  incrementPromptMetric(SELECTION_METRIC_NAMES.CANDIDATES_REJECTED, {
    ...attributes,
    reason,
    count,
  });
}

export function recordNoEligibleModel(attributes: Record<string, string | number> = {}): void {
  incrementPromptMetric(SELECTION_METRIC_NAMES.NO_ELIGIBLE_MODEL, attributes);
}

export function recordFallbackToRanked(attributes: Record<string, string | number> = {}): void {
  incrementPromptMetric(SELECTION_METRIC_NAMES.FALLBACK_TO_RANKED, attributes);
}

export function recordNativePreferred(attributes: {
  modelId: string;
  nativeProvider: string;
  displacedHubProvider?: string;
}): void {
  incrementPromptMetric(SELECTION_METRIC_NAMES.NATIVE_PREFERRED, attributes);
}

export function recordHubChosenOverNative(attributes: {
  modelId: string;
  hubProvider: string;
  skippedNativeProvider: string;
  reason: string;
}): void {
  incrementPromptMetric(SELECTION_METRIC_NAMES.HUB_CHOSEN_OVER_NATIVE, attributes);
}

export function recordProviderSelected(attributes: {
  provider: string;
  providerKind: 'native' | 'hub' | 'local' | 'unknown';
  strategy?: string;
  taskType?: string;
}): void {
  incrementPromptMetric(SELECTION_METRIC_NAMES.PROVIDER_SELECTED, attributes);
}

export function recordExecutionFailure(
  cause: ExecutionFailureCause,
  attributes: { provider: string; modelId: string; strategy?: string },
): void {
  incrementPromptMetric(SELECTION_METRIC_NAMES.MODEL_EXECUTION_FAILED, {
    ...attributes,
    cause,
  });
}

export function recordProviderRegistryState(
  state: ProviderRegistryState,
  provider: string,
): void {
  incrementPromptMetric(SELECTION_METRIC_NAMES.PROVIDER_REGISTRY_STATE, {
    state,
    provider,
  });
}
