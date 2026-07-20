// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-PARITY-GATE — Contract (NON-EXECUTING)
 *
 * Proves the offline-approved plan and the real runtime-interpreted plan are semantically
 * identical on critical fields, with canonical fingerprint lock and drift rejection. The
 * canonical snapshot merges offline-authoritative fields (candidates, roles, provenance) with
 * runtime-confirmed fields (resolved strategy/task, execution locks, runtime fingerprint).
 * Parity has two dimensions: DETERMINISM (two real-entrypoint invocations A≡B) and CONSISTENCY
 * (runtime-resolved values match the approved plan). The comparator diffs two snapshots into the
 * 18 drift reasons. Authorizes nothing: locks false-as-const, counters/cost zero-as-const.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no dryRun=false, no provider/model probes,
 * no billable provider calls, no external network, no positive cost/usage, no silent drift.
 */

export const C3_DRYRUN_PARITY_GATE_VERSION = '01C.1B-C3-DRYRUN-PARITY-GATE' as const;
export const C3_DRYRUN_PARITY_GATE_DATE = '2026-06-06' as const;

export const C3_EXECUTION_AUTHORIZED = false as const;
export const DRYRUN_FALSE_AUTHORIZED = false as const;
export const BILLABLE_PROVIDER_CALLS_AUTHORIZED = false as const;
export const PROVIDER_PROBES_AUTHORIZED = false as const;
export const MODEL_PROBES_AUTHORIZED = false as const;
export const K_AUTHORIZED = false as const;

export const C3_RUNTIME_PLAN_DRIFT_FORBIDDEN = true as const;
export const C3_FINGERPRINT_MISMATCH_FORBIDDEN = true as const;
export const C3_SILENT_PLAN_MUTATION_FORBIDDEN = true as const;
export const C3_PARITY_MIN_SUBSET_PLANS = 3 as const;
export const C3_PARITY_MAX_SUBSET_PLANS = 5 as const;

export const C3_PROVIDER_CALLS_EXECUTED = 0 as const;
export const C3_MODEL_PROBES_EXECUTED = 0 as const;
export const C3_PROVIDER_PROBES_EXECUTED = 0 as const;
export const C3_TOTAL_COST_USD = 0 as const;

export const C3_DRYRUN_PARITY_GATE_COMPLETE_DECISION =
  'CONSENSUS_01C_1B_C3_DRYRUN_PARITY_GATE_COMPLETE_READY_FOR_C3_BUDGET_AUTHORIZATION_GATE' as const;
export const C3_DRYRUN_PARITY_GATE_NEXT_STEP = '01C.1B-C3-BUDGET-AUTHORIZATION-GATE' as const;

export type C3DryrunParityGateMode =
  | 'real_in_process_entrypoint_parity'
  | 'local_http_plan_only_parity'
  | 'hybrid_real_entrypoint_parity';

export type C3ParityDriftReason =
  | 'candidate_added'
  | 'candidate_removed'
  | 'provider_changed'
  | 'model_changed'
  | 'candidate_class_changed'
  | 'model_probe_status_changed'
  | 'fanout_changed'
  | 'fanout_cap_changed'
  | 'role_changed'
  | 'budget_policy_changed'
  | 'fallback_inserted'
  | 'provenance_required_field_removed'
  | 'provenance_complete_false'
  | 'plan_fingerprint_mismatch'
  | 'prompt_fingerprint_mismatch'
  | 'approved_plan_fingerprint_mismatch'
  | 'selected_executable_model_true'
  | 'provider_route_created_true';

export function isC3ParityExecutionLocked(response: {
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

export function isC3ParityAllowedMode(mode: string): mode is C3DryrunParityGateMode {
  return (
    mode === 'real_in_process_entrypoint_parity' ||
    mode === 'local_http_plan_only_parity' ||
    mode === 'hybrid_real_entrypoint_parity'
  );
}

export function isC3ParityForbiddenMode(mode: string): boolean {
  return (
    mode === 'offline_only_parity' ||
    mode === 'synthetic_only_parity' ||
    mode === 'local_adapter_only_parity' ||
    mode === 'fingerprint_only_without_structural_parity' ||
    mode === 'structural_only_without_fingerprint_parity'
  );
}

// ── Canonical snapshot ──────────────────────────────────────────────────────────
export interface C3ParityCandidate {
  candidateId: string;
  providerId: string;
  modelId: string;
  candidateClass: string;
  modelProbeStatus: string;
  requiresModelProbeBeforeBillableExecution: boolean;
  selectedExecutableModel: boolean;
  providerRouteCreated: boolean;
}

export interface C3ParityCanonicalSnapshot {
  planId: string;
  taskId: string;
  strategyId: string;
  baselineId: string | null;
  candidates: C3ParityCandidate[];
  unresolvedCatalogCandidates: string[];
  fanout: number;
  fanoutCap: number;
  roles: Array<{ role: string | null; candidateRef: string | null; phase: string | null }>;
  budgetPolicyKey: string;
  provenanceRequiredFields: string[];
  provenanceComplete: boolean;
  hiddenFallbackDetected: boolean;
  planFingerprint: string;
  promptFingerprint: string;
  // Runtime-confirmed (determinism) fields:
  runtimeResolvedStrategy: string;
  runtimeTaskType: string;
  runtimePlanFingerprint: string;
  runtimeProviderCallExecuted: boolean;
  runtimeCostUsd: number;
  runtimeUsageTotalTokens: number;
}

/** Deterministic canonical fingerprint over the critical (non-volatile) snapshot fields. */
export function c3ParityCanonicalFingerprint(s: C3ParityCanonicalSnapshot): string {
  const canonical = {
    planId: s.planId,
    taskId: s.taskId,
    strategyId: s.strategyId,
    baselineId: s.baselineId,
    candidates: s.candidates,
    unresolvedCatalogCandidates: s.unresolvedCatalogCandidates,
    fanout: s.fanout,
    fanoutCap: s.fanoutCap,
    roles: s.roles,
    budgetPolicyKey: s.budgetPolicyKey,
    provenanceRequiredFields: s.provenanceRequiredFields,
    provenanceComplete: s.provenanceComplete,
    hiddenFallbackDetected: s.hiddenFallbackDetected,
    planFingerprint: s.planFingerprint,
    promptFingerprint: s.promptFingerprint,
    runtimeResolvedStrategy: s.runtimeResolvedStrategy,
    runtimeTaskType: s.runtimeTaskType,
    runtimePlanFingerprint: s.runtimePlanFingerprint,
  };
  const input = JSON.stringify(canonical);
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(h, 33) + input.charCodeAt(i)) | 0;
  }
  return `cpf_${(h >>> 0).toString(16)}`;
}

export interface C3ParityComparisonResult {
  pass: boolean;
  diffs: string[];
  driftReasons: C3ParityDriftReason[];
}

/**
 * Compare an approved canonical snapshot against a runtime canonical snapshot, emitting the
 * specific drift reasons. Pure — no execution. Returns pass=true with empty drift on parity.
 */
export function compareC3ParitySnapshots(
  approved: C3ParityCanonicalSnapshot,
  runtime: C3ParityCanonicalSnapshot,
): C3ParityComparisonResult {
  const diffs: string[] = [];
  const drift: C3ParityDriftReason[] = [];
  const add = (reason: C3ParityDriftReason, detail: string) => {
    drift.push(reason);
    diffs.push(`${reason}: ${detail}`);
  };

  // Candidate count → added / removed
  if (runtime.candidates.length > approved.candidates.length) {
    add('candidate_added', `${approved.candidates.length} -> ${runtime.candidates.length}`);
  }
  if (runtime.candidates.length < approved.candidates.length) {
    add('candidate_removed', `${approved.candidates.length} -> ${runtime.candidates.length}`);
  }

  // Per-candidate (matched by index up to the shorter length)
  const n = Math.min(approved.candidates.length, runtime.candidates.length);
  for (let i = 0; i < n; i++) {
    const a = approved.candidates[i]!;
    const r = runtime.candidates[i]!;
    if (a.providerId !== r.providerId) add('provider_changed', `[${i}] ${a.providerId} -> ${r.providerId}`);
    if (a.modelId !== r.modelId) add('model_changed', `[${i}] ${a.modelId} -> ${r.modelId}`);
    if (a.candidateClass !== r.candidateClass) add('candidate_class_changed', `[${i}] ${a.candidateClass} -> ${r.candidateClass}`);
    if (a.modelProbeStatus !== r.modelProbeStatus) add('model_probe_status_changed', `[${i}] ${a.modelProbeStatus} -> ${r.modelProbeStatus}`);
    if (r.selectedExecutableModel === true && a.selectedExecutableModel !== true) add('selected_executable_model_true', `[${i}] ${r.candidateId}`);
    if (r.providerRouteCreated === true && a.providerRouteCreated !== true) add('provider_route_created_true', `[${i}] ${r.candidateId}`);
  }

  if (approved.fanout !== runtime.fanout) add('fanout_changed', `${approved.fanout} -> ${runtime.fanout}`);
  if (approved.fanoutCap !== runtime.fanoutCap) add('fanout_cap_changed', `${approved.fanoutCap} -> ${runtime.fanoutCap}`);

  if (JSON.stringify(approved.roles) !== JSON.stringify(runtime.roles)) add('role_changed', 'roles differ');
  if (approved.budgetPolicyKey !== runtime.budgetPolicyKey) add('budget_policy_changed', `${approved.budgetPolicyKey} -> ${runtime.budgetPolicyKey}`);

  // Fallback insertion: runtime flags a hidden fallback the approved plan did not.
  if (runtime.hiddenFallbackDetected === true && approved.hiddenFallbackDetected !== true) {
    add('fallback_inserted', 'runtime hiddenFallbackDetected=true');
  }

  // Provenance: a required field present in approved but missing in runtime.
  for (const f of approved.provenanceRequiredFields) {
    if (!runtime.provenanceRequiredFields.includes(f)) add('provenance_required_field_removed', f);
  }
  if (runtime.provenanceComplete !== true) add('provenance_complete_false', 'runtime provenanceComplete!=true');

  if (approved.planFingerprint !== runtime.planFingerprint) add('plan_fingerprint_mismatch', `${approved.planFingerprint} -> ${runtime.planFingerprint}`);
  if (approved.promptFingerprint !== runtime.promptFingerprint) add('prompt_fingerprint_mismatch', `${approved.promptFingerprint} -> ${runtime.promptFingerprint}`);

  const approvedCanon = c3ParityCanonicalFingerprint(approved);
  const runtimeCanon = c3ParityCanonicalFingerprint(runtime);
  if (approvedCanon !== runtimeCanon) add('approved_plan_fingerprint_mismatch', `${approvedCanon} -> ${runtimeCanon}`);

  return { pass: drift.length === 0, diffs, driftReasons: [...new Set(drift)] };
}
