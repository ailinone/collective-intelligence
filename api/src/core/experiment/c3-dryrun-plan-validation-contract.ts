// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-PLAN-VALIDATION — Plan Validation Contract (NON-EXECUTING)
 *
 * Typed, CI-safe source of truth proving the 49 design payload templates compile into 49
 * safe dry-run plans. Authorizes NOTHING: all execution locks are `false as const` and all
 * execution counters are `0 as const`. tmp plan artifacts are gitignored; tests bind here.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no dryRun=false, no provider/model probes,
 * no billable provider calls, no placeholder→executable promotion, no hidden fallback.
 */

export const C3_DRYRUN_PLAN_VALIDATION_VERSION = '01C.1B-C3-DRYRUN-PLAN-VALIDATION' as const;
export const C3_DRYRUN_PLAN_VALIDATION_DATE = '2026-06-06' as const;

// ── Execution locks (withheld) ──────────────────────────────────────────────────
export const C3_EXECUTION_AUTHORIZED = false as const;
export const DRYRUN_FALSE_AUTHORIZED = false as const;
export const BILLABLE_PROVIDER_CALLS_AUTHORIZED = false as const;
export const PROVIDER_PROBES_AUTHORIZED = false as const;
export const MODEL_PROBES_AUTHORIZED = false as const;
export const K_AUTHORIZED = false as const;

// ── Counts (design → plans, 1:1) ────────────────────────────────────────────────
export const C3_PAYLOAD_TEMPLATE_COUNT = 49 as const;
export const C3_PLAN_ARTIFACT_COUNT = 49 as const;
export const C3_PLAN_VALIDATION_MODE = 'offline_compiler' as const;

// ── Execution counters (all zero) ───────────────────────────────────────────────
export const C3_PROVIDER_CALLS_EXECUTED = 0 as const;
export const C3_MODEL_PROBES_EXECUTED = 0 as const;
export const C3_PROVIDER_PROBES_EXECUTED = 0 as const;
export const C3_TOTAL_COST_USD = 0 as const;

export type C3DryrunPlanValidationMode = 'offline_compiler' | 'http_plan_only' | 'hybrid';

export type C3PlanValidationGate =
  | 'input_lock'
  | 'payload_precheck'
  | 'manifest_boundary'
  | 'fanout'
  | 'placeholder'
  | 'hidden_fallback'
  | 'judge_synthesizer'
  | 'provenance'
  | 'anti_execution'
  | 'final';

export const C3_PLAN_VALIDATION_GATES: readonly C3PlanValidationGate[] = [
  'input_lock',
  'payload_precheck',
  'manifest_boundary',
  'fanout',
  'placeholder',
  'hidden_fallback',
  'judge_synthesizer',
  'provenance',
  'anti_execution',
  'final',
] as const;

/** Sentinel prefix used for non-resolvable catalog placeholders. Must never be callable. */
export const C3_PLACEHOLDER_MODEL_PREFIX = '__C3_DRYRUN_DESIGN_PLACEHOLDER_MODEL_' as const;

/**
 * Broader prefix covering EVERY design-time sentinel modelId — both catalog placeholders
 * (`__C3_DRYRUN_DESIGN_PLACEHOLDER_MODEL_*`) and the model-probe-validated sentinels
 * (`__C3_DRYRUN_DESIGN_MODEL_PROBE_VALIDATED_*` for inworld/infermatic). None of these
 * resolve to a real callable model; the runtime gate must refuse to call any of them.
 */
export const C3_NON_RESOLVABLE_SENTINEL_PREFIX = '__C3_DRYRUN_DESIGN_' as const;

export const C3_DRYRUN_PLAN_VALIDATION_COMPLETE_DECISION =
  'CONSENSUS_01C_1B_C3_DRYRUN_PLAN_VALIDATION_COMPLETE_READY_FOR_C3_DRYRUN_RUNTIME_GATE' as const;
export const C3_DRYRUN_PLAN_VALIDATION_NEXT_STEP = '01C.1B-C3-DRYRUN-RUNTIME-GATE' as const;

/**
 * Pure guard: a compiled plan is execution-safe iff it is dry-run/plan-only, withholds all
 * execution authorization, executed no provider call, and incurred zero cost. NON-EXECUTING.
 */
export function assertC3PlanExecutionLocks(plan: {
  dryRun?: boolean;
  planOnly?: boolean;
  c3ExecutionAuthorized?: boolean;
  billableProviderCallsAuthorized?: boolean;
  providerCallExecuted?: boolean;
  cost_usd?: number;
}): boolean {
  return (
    plan.dryRun === true &&
    plan.planOnly === true &&
    plan.c3ExecutionAuthorized === false &&
    plan.billableProviderCallsAuthorized === false &&
    plan.providerCallExecuted === false &&
    Number(plan.cost_usd ?? 0) === 0
  );
}

/**
 * True iff a modelId is an unresolved CATALOG placeholder (requires model probe before any
 * billable execution). This is a classification predicate — NOT the safety predicate. For
 * "is this string safe to call?", use isC3NonResolvableSentinel below.
 */
export function isC3PlaceholderModel(modelId: string): boolean {
  return modelId.startsWith(C3_PLACEHOLDER_MODEL_PREFIX);
}

/**
 * True iff a modelId is ANY design-time sentinel (catalog placeholder OR model-probe-validated
 * sentinel) and therefore does not resolve to a real callable model. The runtime gate must
 * never attempt a provider call against a string for which this returns true.
 */
export function isC3NonResolvableSentinel(modelId: string): boolean {
  return modelId.startsWith(C3_NON_RESOLVABLE_SENTINEL_PREFIX);
}
