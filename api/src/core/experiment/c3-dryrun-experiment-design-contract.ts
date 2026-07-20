// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-EXPERIMENT-DESIGN — Design Contract (NON-EXECUTING)
 *
 * This contract is the typed, CI-safe source of truth for the C3 dry-run experiment
 * DESIGN. It does NOT authorize execution of anything. Every execution lock below is
 * `false as const` so that any accidental flip to `true` is a compile-time error at the
 * point of mutation and a test failure here.
 *
 * Entry state is the locked output of 01C.1B-C3-SCOPE-R4-INTEGRITY-LOCK:
 *   - 82 registered providers, bucket sum 82, 0 unknowns
 *   - 23 chat-ready providers
 *   - 13808 canonical candidate pool
 *   - HuggingFace = provider_probe_validated (NOT all-models-callable)
 *
 * ABSOLUTE PROHIBITIONS (encoded as locks):
 *   - No C3 execution, no dryRun=false, no K, no real consensus.
 *   - No provider probes, no model probes, no billable provider calls.
 *   - catalog_candidate is NOT model_probe_validated.
 *   - HuggingFace catalog models are NOT assumed callable.
 */

export const C3_DRYRUN_DESIGN_VERSION = '01C.1B-C3-DRYRUN-EXPERIMENT-DESIGN' as const;
export const C3_DRYRUN_DESIGN_DATE = '2026-06-06' as const;

// ── Execution locks (all false as const — withheld authorization) ───────────────
export const C3_EXECUTION_AUTHORIZED = false as const;
export const DRYRUN_FALSE_AUTHORIZED = false as const;
export const BILLABLE_PROVIDER_CALLS_AUTHORIZED = false as const;
export const PROVIDER_PROBES_AUTHORIZED = false as const;
export const MODEL_PROBES_AUTHORIZED = false as const;
export const K_AUTHORIZED = false as const;

// ── Locked R4 entry-state inputs ────────────────────────────────────────────────
export const C3_SOURCE_CANDIDATE_POOL_TOTAL = 13808 as const;
export const C3_REGISTERED_PROVIDER_TOTAL = 82 as const;
export const C3_CHAT_READY_PROVIDER_COUNT = 23 as const;

// ── Sampling policy parameters ──────────────────────────────────────────────────
export const C3_TARGET_SELECTED_MODELS = 36 as const;
export const C3_MINIMUM_PROVIDERS = 8 as const;
export const C3_MAX_MODELS_PER_PROVIDER = 4 as const;
export const C3_MAX_HUGGINGFACE_MODELS = 4 as const;
export const C3_MINIMUM_MODEL_PROBE_VALIDATED = 3 as const;
export const C3_MINIMUM_CATALOG_GUARDED_CANDIDATES = 12 as const;

// ── HuggingFace guard (carried forward from R4) ─────────────────────────────────
export const HF_ALL_MODELS_CALLABLE_ASSUMED = false as const;
export const HF_CONFIRMED_MODEL = 'Qwen/Qwen2.5-7B-Instruct' as const;

// ── Candidate classification (semantic hierarchy) ───────────────────────────────
export type C3CandidateClass =
  | 'catalog_candidate'
  | 'provider_probe_validated'
  | 'model_probe_validated'
  | 'c3_sampling_eligible';

// ── Strategies ──────────────────────────────────────────────────────────────────
export const C3_APPROVED_STRATEGIES = [
  'single',
  'consensus',
  'debate',
  'expert-panel',
  'cost-cascade',
  'critique-repair',
  'quality-multipass',
] as const;
export type C3ApprovedStrategy = (typeof C3_APPROVED_STRATEGIES)[number];

/** `fast` is a proxy/alias excluded from C3 (FAST_STATUS = proxy_alias_excluded_from_c3). */
export const C3_EXCLUDED_STRATEGIES = ['fast'] as const;

// ── Baselines ───────────────────────────────────────────────────────────────────
export const C3_BASELINES = [
  'single_tier1_quality_baseline',
  'single_balanced_baseline',
  'single_cheapest_acceptable_baseline',
] as const;
export type C3Baseline = (typeof C3_BASELINES)[number];

// ── Task set ────────────────────────────────────────────────────────────────────
export const C3_TASK_IDS = [
  'T1_simple_factual',
  'T2_summarization_precision',
  'T3_code_reasoning',
  'T4_business_strategy',
  'T5_legal_policy_analysis',
  'T6_multi_perspective_decision',
  'T7_critique_repair',
  'T8_quality_multipass',
] as const;
export type C3TaskId = (typeof C3_TASK_IDS)[number];

// ── Sampling stratification keys ────────────────────────────────────────────────
export const C3_STRATIFICATION_KEYS = [
  'providerId',
  'candidateClass',
  'modelFamily',
  'costTier',
  'qualityPriorTier',
  'latencyPriorTier',
  'contextWindowTier',
  'openWeightClass',
  'benchmarkConfidenceTier',
  'providerMaturityTier',
  'modelProbeStatus',
  'capabilityTag',
] as const;

// ── Budget / fanout policy ──────────────────────────────────────────────────────
export const C3_MAX_FANOUT_BY_STRATEGY: Readonly<Record<C3ApprovedStrategy, number>> = {
  single: 1,
  consensus: 4,
  debate: 4,
  'expert-panel': 4,
  'cost-cascade': 3,
  'critique-repair': 3,
  'quality-multipass': 4,
} as const;
export const C3_MAX_RETRIES_PER_CELL = 0 as const;
export const C3_NO_UNBOUNDED_FANOUT = true as const;
export const C3_NO_UNBOUNDED_RETRY = true as const;
export const C3_GLOBAL_MAX_ESTIMATED_COST_USD_PER_DRYRUN_PLAN = 0.0 as const;

// ── Payload template invariants ─────────────────────────────────────────────────
export const C3_PAYLOAD_TEMPLATE_INVARIANTS = {
  dryRun: true,
  planOnly: true,
  c3ExecutionAuthorized: false,
  billableProviderCallsAuthorized: false,
  providerProbesAuthorized: false,
  modelProbesAuthorized: false,
} as const;

// ── Primary success metric (the C3 thesis) ──────────────────────────────────────
// Quality equal-or-better, total cost strictly lower, robustness preserved, provenance complete.
export const C3_PRIMARY_SUCCESS_METRIC = {
  metricId: 'c3_primary_success_metric_v1',
  qualityTolerance: 0.02,
  failureTolerance: 0.01,
  requiresQualityDelta: true,
  requiresCostDelta: true,
  requiresFailureRate: true,
  requiresProvenanceCompleteness: true,
} as const;

export const C3_SECONDARY_METRICS = [
  'quality_per_dollar',
  'quality_per_second',
  'latency_delta_vs_baseline',
  'fallback_count',
  'provider_failure_rate',
  'judge_agreement',
  'synthesizer_stability',
  'sampling_diversity_score',
] as const;

// ── Judge / synthesizer policy ──────────────────────────────────────────────────
export const C3_FIXED_JUDGE_FORBIDDEN = true as const;
export const C3_FIXED_SYNTHESIZER_FORBIDDEN_WITHOUT_JUSTIFICATION = true as const;
export const C3_JUDGE_REQUIRED_FOR = [
  'consensus',
  'debate',
  'expert-panel',
  'quality-multipass',
  'critique-repair',
] as const;

// ── Provenance required fields ──────────────────────────────────────────────────
export const C3_PROVENANCE_REQUIRED_FIELDS = [
  'taskId',
  'strategyId',
  'baselineId',
  'candidateSelectionRef',
  'candidateClass',
  'providerId',
  'modelId',
  'providerRouteRef',
  'modelEligibilityTrace',
  'providerRouteTrace',
  'samplingTrace',
  'budgetTrace',
  'judgeSelectionTrace',
  'synthesizerSelectionTrace',
  'fallbackTrace',
  'waiverTrace',
  'planFingerprint',
  'promptFingerprint',
  'strategySemantics',
  'dryRun',
  'planOnly',
  'c3ExecutionAuthorized',
] as const;

// ── Decision phrases ────────────────────────────────────────────────────────────
export const C3_DRYRUN_DESIGN_COMPLETE_DECISION =
  'CONSENSUS_01C_1B_C3_DRYRUN_EXPERIMENT_DESIGN_COMPLETE_READY_FOR_C3_DRYRUN_PLAN_VALIDATION' as const;
export const C3_DRYRUN_DESIGN_NEXT_STEP = '01C.1B-C3-DRYRUN-PLAN-VALIDATION' as const;

/**
 * Pure guard: returns the list of execution-authorization violations found in a record.
 * Used both by tests and by any future plan-validation consumer. A clean design record
 * returns []. NON-EXECUTING — this only inspects shape, it never calls anything.
 */
export function detectC3ExecutionViolations(record: Record<string, unknown>): string[] {
  const violations: string[] = [];
  if (record.dryRun === false) violations.push('dryRun_false');
  if (record.providerCallExecuted === true) violations.push('providerCallExecuted_true');
  if (record.c3ExecutionAuthorized === true) violations.push('c3ExecutionAuthorized_true');
  if (record.billableProviderCallsAuthorized === true)
    violations.push('billableProviderCallsAuthorized_true');
  if (record.providerProbesAuthorized === true) violations.push('providerProbesAuthorized_true');
  if (record.modelProbesAuthorized === true) violations.push('modelProbesAuthorized_true');
  return violations;
}
