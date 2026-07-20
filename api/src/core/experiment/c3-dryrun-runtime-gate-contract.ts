// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-RUNTIME-GATE — Runtime Gate Contract (NON-EXECUTING)
 *
 * Authoritative, CI-safe gate logic for the local plan-only runtime boundary. The gate is a
 * PURE function: it accepts plan-only/dry-run plans and rejects ANY execution attempt
 * (dryRun=false, exec auth, billable, provider call, positive cost/usage, manifest escape,
 * placeholder→executable, hidden fallback, fanout-over-cap, missing fingerprint/provenance).
 * It NEVER calls a provider, runs a probe, or incurs cost — accept or reject, all execution
 * fields are zero. The tmp .mjs runner ports this logic to emit evidence; validators catch drift.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no dryRun=false, no provider/model probes,
 * no billable provider calls, no positive cost/usage, no placeholder→executable promotion.
 */

export const C3_DRYRUN_RUNTIME_GATE_VERSION = '01C.1B-C3-DRYRUN-RUNTIME-GATE' as const;
export const C3_DRYRUN_RUNTIME_GATE_DATE = '2026-06-06' as const;

// ── Execution locks (withheld) ──────────────────────────────────────────────────
export const C3_EXECUTION_AUTHORIZED = false as const;
export const DRYRUN_FALSE_AUTHORIZED = false as const;
export const BILLABLE_PROVIDER_CALLS_AUTHORIZED = false as const;
export const PROVIDER_PROBES_AUTHORIZED = false as const;
export const MODEL_PROBES_AUTHORIZED = false as const;
export const K_AUTHORIZED = false as const;

// ── Mode + bounds ───────────────────────────────────────────────────────────────
export const C3_RUNTIME_GATE_MODE = 'local_adapter_only' as const;
export const C3_SOURCE_PLAN_ARTIFACT_COUNT = 49 as const;
export const C3_RUNTIME_GATE_MIN_SUBSET_PLANS = 6 as const;
export const C3_RUNTIME_GATE_MAX_SUBSET_PLANS = 12 as const;

// ── Execution counters (all zero) ───────────────────────────────────────────────
export const C3_PROVIDER_CALLS_EXECUTED = 0 as const;
export const C3_MODEL_PROBES_EXECUTED = 0 as const;
export const C3_PROVIDER_PROBES_EXECUTED = 0 as const;
export const C3_TOTAL_COST_USD = 0 as const;

export type C3DryrunRuntimeGateMode = 'local_adapter_only' | 'local_http_plan_only' | 'hybrid_local';

export const C3_DRYRUN_RUNTIME_GATE_COMPLETE_DECISION =
  'CONSENSUS_01C_1B_C3_DRYRUN_RUNTIME_GATE_COMPLETE_READY_FOR_C3_DRYRUN_CONTROLLED_RUNTIME_SMOKE' as const;
export const C3_DRYRUN_RUNTIME_GATE_NEXT_STEP = '01C.1B-C3-DRYRUN-CONTROLLED-RUNTIME-SMOKE' as const;

/** True iff a runtime response carries no execution: dry-run/plan-only, all locks/counters zero. */
export function isC3RuntimeExecutionLocked(response: {
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
    Number(response.usage?.total_tokens ?? 0) === 0
  );
}

/** True iff a modelId is ANY design-time sentinel (catalog placeholder OR probe-validated). */
export function isC3NonResolvableRuntimeSentinel(modelId: string): boolean {
  return /^__C3_DRYRUN_DESIGN_(PLACEHOLDER_MODEL|MODEL_PROBE_VALIDATED)_/.test(modelId);
}

// ── Runtime gate request/response shapes ────────────────────────────────────────
export interface C3RuntimeGateCandidate {
  candidateId: string;
  providerId: string;
  modelId: string;
  selectedExecutableModel?: boolean;
}

export interface C3RuntimeGateRequest {
  dryRun?: boolean;
  planOnly?: boolean;
  c3ExecutionAuthorized?: boolean;
  billableProviderCallsAuthorized?: boolean;
  providerCallExecuted?: boolean;
  cost_usd?: number;
  usage?: { total_tokens?: number };
  selectedCandidates?: C3RuntimeGateCandidate[];
  hiddenFallbackDetected?: boolean;
  fanout?: number;
  fanoutCap?: number;
  planFingerprint?: string;
  promptFingerprint?: string;
  provenance?: { complete?: boolean };
}

export interface C3RuntimeGateResponse {
  accepted: boolean;
  rejected: boolean;
  rejectionReasons: string[];
  dryRun: true;
  planOnly: true;
  c3ExecutionAuthorized: false;
  billableProviderCallsAuthorized: false;
  providerCallExecuted: false;
  providerCallsExecuted: 0;
  modelProbesExecuted: 0;
  providerProbesExecuted: 0;
  cost_usd: 0;
  usage: { prompt_tokens: 0; completion_tokens: 0; total_tokens: 0 };
  hiddenFallbackDetected: false;
  placeholderExecutionAttempted: false;
  provenanceComplete: boolean;
  planFingerprint: string | null;
  promptFingerprint: string | null;
}

/**
 * The local runtime gate. PURE — never executes anything. Returns a fully-zeroed execution
 * envelope whether it accepts or rejects, plus the list of rejection reasons (empty = accepted).
 */
export function evaluateC3RuntimeGate(
  req: C3RuntimeGateRequest,
  allowedCandidateIds: ReadonlySet<string>,
  allowedProviderIds: ReadonlySet<string>,
): C3RuntimeGateResponse {
  const reasons: string[] = [];

  if (req.dryRun !== true) reasons.push('dryrun_false');
  if (req.planOnly !== true) reasons.push('planonly_false');
  if (req.c3ExecutionAuthorized === true) reasons.push('c3_execution_authorized_true');
  if (req.billableProviderCallsAuthorized === true) reasons.push('billable_provider_calls_true');
  if (req.providerCallExecuted === true) reasons.push('provider_call_executed_true');
  if (Number(req.cost_usd ?? 0) > 0) reasons.push('cost_positive');
  if (Number(req.usage?.total_tokens ?? 0) > 0) reasons.push('usage_tokens_positive');

  for (const c of req.selectedCandidates ?? []) {
    if (!allowedCandidateIds.has(c.candidateId)) reasons.push('candidate_outside_manifest');
    if (!allowedProviderIds.has(c.providerId)) reasons.push('provider_outside_manifest');
    if (isC3NonResolvableRuntimeSentinel(c.modelId) && c.selectedExecutableModel === true) {
      reasons.push('placeholder_executable');
    }
  }

  if (req.hiddenFallbackDetected === true) reasons.push('hidden_fallback');
  if (Number(req.fanout ?? 0) > Number(req.fanoutCap ?? 0)) reasons.push('fanout_over_cap');
  // Bound the ACTUAL candidate-array length, not just the self-declared scalar — otherwise a
  // plan could declare fanout:1 while listing N>1 candidates and slip past the scalar check.
  if (
    Array.isArray(req.selectedCandidates) &&
    req.fanoutCap != null &&
    req.selectedCandidates.length > Number(req.fanoutCap)
  ) {
    reasons.push('fanout_over_cap');
  }
  if (!req.planFingerprint || !req.promptFingerprint) reasons.push('invalid_fingerprint');
  if (req.provenance?.complete !== true) reasons.push('provenance_incomplete');

  const accepted = reasons.length === 0;
  return {
    accepted,
    rejected: !accepted,
    rejectionReasons: [...new Set(reasons)],
    // Execution envelope is ALWAYS zeroed — the gate never executes, accept or reject.
    dryRun: true,
    planOnly: true,
    c3ExecutionAuthorized: false,
    billableProviderCallsAuthorized: false,
    providerCallExecuted: false,
    providerCallsExecuted: 0,
    modelProbesExecuted: 0,
    providerProbesExecuted: 0,
    cost_usd: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    hiddenFallbackDetected: false,
    placeholderExecutionAttempted: false,
    provenanceComplete: accepted ? req.provenance?.complete === true : false,
    planFingerprint: req.planFingerprint ?? null,
    promptFingerprint: req.promptFingerprint ?? null,
  };
}
