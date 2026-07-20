// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE — Contract (NON-EXECUTING)
 *
 * Drives the REAL orchestration dry-run entrypoint (buildPlanOnlyResult + detectDryRun) in
 * plan-only mode under a provider-boundary sentry. A synthetic-only adapter PASS is forbidden.
 * Authorizes nothing: locks false-as-const, counters/cost zero-as-const.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no dryRun=false, no provider/model probes,
 * no billable provider calls, no external network, no positive cost/usage.
 */

export const C3_DRYRUN_CONTROLLED_RUNTIME_SMOKE_VERSION = '01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE' as const;
export const C3_DRYRUN_CONTROLLED_RUNTIME_SMOKE_DATE = '2026-06-06' as const;

// ── Execution locks (withheld) ──────────────────────────────────────────────────
export const C3_EXECUTION_AUTHORIZED = false as const;
export const DRYRUN_FALSE_AUTHORIZED = false as const;
export const BILLABLE_PROVIDER_CALLS_AUTHORIZED = false as const;
export const PROVIDER_PROBES_AUTHORIZED = false as const;
export const MODEL_PROBES_AUTHORIZED = false as const;
export const K_AUTHORIZED = false as const;

// ── Anti-synthetic + bounds ─────────────────────────────────────────────────────
export const C3_SYNTHETIC_GATE_ONLY_PASS_FORBIDDEN = true as const;
export const C3_CONTROLLED_SMOKE_REQUIRES_REAL_ENTRYPOINT = true as const;
export const C3_SMOKE_MIN_SUBSET_PLANS = 3 as const;
export const C3_SMOKE_MAX_SUBSET_PLANS = 5 as const;

// ── Counters (all zero) ─────────────────────────────────────────────────────────
export const C3_PROVIDER_CALLS_EXECUTED = 0 as const;
export const C3_MODEL_PROBES_EXECUTED = 0 as const;
export const C3_PROVIDER_PROBES_EXECUTED = 0 as const;
export const C3_TOTAL_COST_USD = 0 as const;

export type C3ControlledRuntimeSmokeMode = 'real_in_process_entrypoint' | 'local_http_plan_only' | 'hybrid_real_entrypoint';

export type C3ControlledRuntimeSmokeBlockedReason =
  | 'runtime_entrypoint_not_found'
  | 'runtime_entrypoint_not_safe'
  | 'provider_boundary_not_instrumented'
  | 'external_network_not_blocked'
  | 'positive_case_failed'
  | 'negative_case_failed'
  | 'provider_call_attempted'
  | 'external_network_call_attempted'
  | 'usage_or_cost_positive'
  | 'safety_scan_failed';

export const C3_DRYRUN_CONTROLLED_RUNTIME_SMOKE_COMPLETE_DECISION =
  'CONSENSUS_01C_1B_C3_DRYRUN_CONTROLLED_RUNTIME_SMOKE_COMPLETE_READY_FOR_C3_DRYRUN_PARITY_GATE' as const;
export const C3_DRYRUN_CONTROLLED_RUNTIME_SMOKE_NEXT_STEP = '01C.1B-C3-DRYRUN-PARITY-GATE' as const;

/** True iff a real-runtime response carries no execution: dry-run/plan-only, all zeros. */
export function isC3ControlledSmokeExecutionLocked(response: {
  dryRun?: boolean;
  planOnly?: boolean;
  c3ExecutionAuthorized?: boolean;
  billableProviderCallsAuthorized?: boolean;
  providerCallExecuted?: boolean;
  providerCallsExecuted?: number;
  modelProbesExecuted?: number;
  providerProbesExecuted?: number;
  cost_usd?: number;
  usage?: { total_tokens?: number };
  hiddenFallbackDetected?: boolean;
}): boolean {
  return (
    response.dryRun === true &&
    response.planOnly === true &&
    response.c3ExecutionAuthorized === false &&
    response.billableProviderCallsAuthorized === false &&
    response.providerCallExecuted === false &&
    Number(response.providerCallsExecuted ?? 0) === 0 &&
    Number(response.modelProbesExecuted ?? 0) === 0 &&
    Number(response.providerProbesExecuted ?? 0) === 0 &&
    Number(response.cost_usd ?? 0) === 0 &&
    Number(response.usage?.total_tokens ?? 0) === 0 &&
    response.hiddenFallbackDetected === false
  );
}

export function isC3SmokeAllowedMode(mode: string): mode is C3ControlledRuntimeSmokeMode {
  return mode === 'real_in_process_entrypoint' || mode === 'local_http_plan_only' || mode === 'hybrid_real_entrypoint';
}

export function isC3SyntheticOnlyMode(mode: string): boolean {
  return mode === 'local_adapter_only' || mode === 'offline_compiler_only' || mode === 'synthetic_only';
}

/**
 * Normalize a real OrchestrationResult (from buildPlanOnlyResult) into the smoke execution
 * envelope. Reads only — never executes. Used by the harness AND the tests so the envelope
 * derivation is single-sourced.
 */
export function c3SmokeEnvelopeFromOrchestrationResult(result: {
  totalCost?: number;
  finalResponse?: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  metadata?: Record<string, unknown>;
}): {
  accepted: true;
  dryRun: true;
  planOnly: true;
  c3ExecutionAuthorized: false;
  billableProviderCallsAuthorized: false;
  providerCallExecuted: boolean;
  providerCallsExecuted: number;
  modelProbesExecuted: 0;
  providerProbesExecuted: 0;
  cost_usd: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  hiddenFallbackDetected: false;
  provenanceComplete: boolean;
  planFingerprint: string | null;
} {
  const meta = result.metadata ?? {};
  const usage = result.finalResponse?.usage ?? {};
  return {
    accepted: true,
    dryRun: true,
    planOnly: true,
    c3ExecutionAuthorized: false,
    billableProviderCallsAuthorized: false,
    providerCallExecuted: meta['provider_call_executed'] === true,
    providerCallsExecuted: 0,
    modelProbesExecuted: 0,
    providerProbesExecuted: 0,
    cost_usd: Number(result.totalCost ?? 0),
    usage: {
      prompt_tokens: Number(usage.prompt_tokens ?? 0),
      completion_tokens: Number(usage.completion_tokens ?? 0),
      total_tokens: Number(usage.total_tokens ?? 0),
    },
    hiddenFallbackDetected: false,
    provenanceComplete: typeof meta['planFingerprint'] === 'string' && (meta['planFingerprint'] as string).length > 0,
    planFingerprint: (meta['planFingerprint'] as string) ?? null,
  };
}
