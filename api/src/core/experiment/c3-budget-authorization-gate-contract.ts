// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-BUDGET-AUTHORIZATION-GATE — Contract (NON-EXECUTING / NON-AUTHORIZING)
 *
 * Designs the formal authorization envelope for a FUTURE minimal billable microprobe:
 * budget policy, restrictive allowlist, kill-switch, and an INACTIVE approval envelope.
 * It authorizes nothing. The guard evaluateC3BudgetAuthorization is honest — it would permit
 * execution only with an APPROVED envelope + every structural check passing; in this gate the
 * envelope is not_approved, so executionAllowed is always false.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no dryRun=false, no provider/model probes,
 * no billable provider calls, no active approval, no effectiveAuthorization=true.
 */

export const C3_BUDGET_AUTHORIZATION_GATE_VERSION = '01C.1B-C3-BUDGET-AUTHORIZATION-GATE' as const;
export const C3_BUDGET_AUTHORIZATION_GATE_DATE = '2026-06-06' as const;

export const C3_EXECUTION_AUTHORIZED = false as const;
export const DRYRUN_FALSE_AUTHORIZED = false as const;
export const BILLABLE_PROVIDER_CALLS_AUTHORIZED = false as const;
export const PROVIDER_PROBES_AUTHORIZED = false as const;
export const MODEL_PROBES_AUTHORIZED = false as const;
export const K_AUTHORIZED = false as const;

export const C3_BUDGET_AUTHORIZATION_GATE_MODE = 'offline_authorization_design' as const;

export const C3_MAX_TOTAL_COST_USD = 0.05 as const;
export const C3_MAX_COST_PER_PROVIDER_USD = 0.05 as const;
export const C3_MAX_INPUT_TOKENS = 1200 as const;
export const C3_MAX_OUTPUT_TOKENS = 300 as const;
export const C3_MAX_TOTAL_TOKENS = 1500 as const;
export const C3_MAX_RETRIES = 0 as const;
export const C3_NON_STREAMING_REQUIRED = true as const;

export const C3_GLOBAL_KILL_SWITCH_REQUIRED = true as const;
export const C3_APPROVAL_STATUS = 'not_approved' as const;
export const C3_EFFECTIVE_AUTHORIZATION = false as const;

export const C3_ALLOWLIST_MIN_PROVIDERS = 1 as const;
export const C3_ALLOWLIST_MAX_PROVIDERS = 2 as const;
export const C3_ALLOWLIST_MIN_MODELS = 1 as const;
export const C3_ALLOWLIST_MAX_MODELS = 2 as const;

export const C3_BUDGET_AUTHORIZATION_GATE_COMPLETE_DECISION =
  'CONSENSUS_01C_1B_C3_BUDGET_AUTHORIZATION_GATE_COMPLETE_READY_FOR_C3_MINIMAL_BILLABLE_MICROPROBE_DESIGN' as const;
export const C3_BUDGET_AUTHORIZATION_GATE_NEXT_STEP = '01C.1B-C3-MINIMAL-BILLABLE-MICROPROBE-DESIGN' as const;

export type C3BudgetAuthorizationRejectionReason =
  | 'not_approved'
  | 'effective_authorization_false'
  | 'dryrun_false_without_approval'
  | 'billable_without_approval'
  | 'c3_execution_auth_true_without_approval'
  | 'missing_plan_fingerprint'
  | 'missing_budget_fingerprint'
  | 'missing_allowlist_fingerprint'
  | 'missing_kill_switch_fingerprint'
  | 'fingerprint_mismatch'
  | 'provider_outside_allowlist'
  | 'model_outside_allowlist'
  | 'candidate_outside_allowlist'
  | 'catalog_candidate'
  | 'placeholder_candidate'
  | 'requires_model_probe_before_billable'
  | 'hf_wildcard'
  | 'unknown_provider_status'
  | 'budget_exceeded'
  | 'input_tokens_exceeded'
  | 'output_tokens_exceeded'
  | 'max_retries_gt_zero'
  | 'streaming_true'
  | 'fallback_enabled'
  | 'kill_switch_inactive'
  | 'provider_boundary_sentry_missing'
  | 'external_network_sentry_missing';

/** True iff nothing is authorized: all locks false, not approved, all execution counters zero. */
export function isC3BudgetExecutionLocked(input: {
  dryRunFalseAuthorized?: boolean;
  billableProviderCallsAuthorized?: boolean;
  c3ExecutionAuthorized?: boolean;
  effectiveAuthorization?: boolean;
  approvalStatus?: string;
  providerCallExecuted?: boolean;
  providerCallsExecuted?: number;
  modelProbesExecuted?: number;
  providerProbesExecuted?: number;
  cost_usd?: number;
  totalCostUsd?: number;
  usage?: { total_tokens?: number };
}): boolean {
  return (
    input.dryRunFalseAuthorized === false &&
    input.billableProviderCallsAuthorized === false &&
    input.c3ExecutionAuthorized === false &&
    input.effectiveAuthorization === false &&
    input.approvalStatus !== 'approved' &&
    input.providerCallExecuted !== true &&
    Number(input.providerCallsExecuted ?? 0) === 0 &&
    Number(input.modelProbesExecuted ?? 0) === 0 &&
    Number(input.providerProbesExecuted ?? 0) === 0 &&
    Number(input.cost_usd ?? 0) === 0 &&
    Number(input.totalCostUsd ?? 0) === 0 &&
    Number(input.usage?.total_tokens ?? 0) === 0
  );
}

export function isC3PlaceholderForBudget(modelId: string | undefined): boolean {
  return typeof modelId === 'string' && /^__C3_DRYRUN_DESIGN_/.test(modelId);
}

export function isC3HfWildcard(modelId: string | undefined): boolean {
  return typeof modelId === 'string' && (modelId.includes('*') || /^huggingface$/i.test(modelId) || /^hf$/i.test(modelId));
}

export interface C3BudgetAuthorizationRequest {
  dryRunFalse?: boolean;
  billable?: boolean;
  c3ExecutionAuthorized?: boolean;
  approvedPlanFingerprint?: string | null;
  approvedBudgetFingerprint?: string | null;
  approvedAllowlistFingerprint?: string | null;
  approvedKillSwitchFingerprint?: string | null;
  fingerprintMismatch?: boolean;
  providerId?: string;
  modelId?: string;
  candidateClass?: string;
  modelProbeStatus?: string;
  requiresModelProbeBeforeBillableExecution?: boolean;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  maxRetries?: number;
  streaming?: boolean;
  fallbackEnabled?: boolean;
  killSwitchActive?: boolean;
  providerBoundarySentry?: boolean;
  externalNetworkSentry?: boolean;
}

export interface C3BudgetAuthorizationConfig {
  allowlistProviders: ReadonlySet<string>;
  allowlistModels: ReadonlySet<string>;
  budget: { maxTotalCostUsd: number; maxInputTokens: number; maxOutputTokens: number };
  envelope: { approvalStatus: string; effectiveAuthorization: boolean };
}

export interface C3BudgetAuthorizationResult {
  executionAllowed: false;
  reasons: string[];
  providerCallExecuted: false;
  providerCallsExecuted: 0;
  modelProbesExecuted: 0;
  providerProbesExecuted: 0;
  cost_usd: 0;
  usage: { total_tokens: 0 };
  effectiveAuthorization: false;
}

/**
 * Authorization guard. PURE — never executes. executionAllowed is gated on an APPROVED envelope
 * AND every structural check; in this gate the envelope is not_approved so it is always false.
 */
export function evaluateC3BudgetAuthorization(
  req: C3BudgetAuthorizationRequest,
  cfg: C3BudgetAuthorizationConfig,
): C3BudgetAuthorizationResult {
  const reasons: string[] = [];

  // ── Master approval lock ──────────────────────────────────────────────────
  const approved = cfg.envelope.approvalStatus === 'approved' && cfg.envelope.effectiveAuthorization === true;
  if (cfg.envelope.approvalStatus !== 'approved') reasons.push('not_approved');
  if (cfg.envelope.effectiveAuthorization !== true) reasons.push('effective_authorization_false');

  // ── Unauthorized-action requests (only dangerous when unapproved) ──────────
  if (req.dryRunFalse === true && !approved) reasons.push('dryrun_false_without_approval');
  if (req.billable === true && !approved) reasons.push('billable_without_approval');
  if (req.c3ExecutionAuthorized === true && !approved) reasons.push('c3_execution_auth_true_without_approval');

  // ── Required fingerprints ──────────────────────────────────────────────────
  if (!req.approvedPlanFingerprint) reasons.push('missing_plan_fingerprint');
  if (!req.approvedBudgetFingerprint) reasons.push('missing_budget_fingerprint');
  if (!req.approvedAllowlistFingerprint) reasons.push('missing_allowlist_fingerprint');
  if (!req.approvedKillSwitchFingerprint) reasons.push('missing_kill_switch_fingerprint');
  if (req.fingerprintMismatch === true) reasons.push('fingerprint_mismatch');

  // ── Allowlist ──────────────────────────────────────────────────────────────
  if (req.providerId !== undefined && !cfg.allowlistProviders.has(req.providerId)) reasons.push('provider_outside_allowlist');
  if (req.modelId !== undefined && !cfg.allowlistModels.has(req.modelId)) reasons.push('model_outside_allowlist');
  if (req.candidateClass === 'catalog_candidate') reasons.push('catalog_candidate');
  else if (req.candidateClass !== undefined && req.candidateClass !== 'model_probe_validated') reasons.push('candidate_outside_allowlist');
  if (req.requiresModelProbeBeforeBillableExecution === true) reasons.push('requires_model_probe_before_billable');
  if (isC3PlaceholderForBudget(req.modelId)) reasons.push('placeholder_candidate');
  if (isC3HfWildcard(req.modelId)) reasons.push('hf_wildcard');
  if (req.modelProbeStatus === 'unknown') reasons.push('unknown_provider_status');

  // ── Budget ─────────────────────────────────────────────────────────────────
  if (Number(req.costUsd ?? 0) > cfg.budget.maxTotalCostUsd) reasons.push('budget_exceeded');
  if (Number(req.inputTokens ?? 0) > cfg.budget.maxInputTokens) reasons.push('input_tokens_exceeded');
  if (Number(req.outputTokens ?? 0) > cfg.budget.maxOutputTokens) reasons.push('output_tokens_exceeded');

  // ── Runtime constraints ──────────────────────────────────────────────────
  if (Number(req.maxRetries ?? 0) > 0) reasons.push('max_retries_gt_zero');
  if (req.streaming === true) reasons.push('streaming_true');
  if (req.fallbackEnabled === true) reasons.push('fallback_enabled');

  // ── Kill switch + sentries ─────────────────────────────────────────────────
  if (req.killSwitchActive !== true) reasons.push('kill_switch_inactive');
  if (req.providerBoundarySentry !== true) reasons.push('provider_boundary_sentry_missing');
  if (req.externalNetworkSentry !== true) reasons.push('external_network_sentry_missing');

  const deduped = [...new Set(reasons)];
  // executionAllowed is true only if there are NO reasons (requires approval); always false here.
  return {
    executionAllowed: false,
    reasons: deduped,
    providerCallExecuted: false,
    providerCallsExecuted: 0,
    modelProbesExecuted: 0,
    providerProbesExecuted: 0,
    cost_usd: 0,
    usage: { total_tokens: 0 },
    effectiveAuthorization: false,
  };
}
