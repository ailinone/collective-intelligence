// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Arm Evaluation Policy — type-safe policy taxonomy for experiment arms
 *
 * Substitutes the previous "global strictProviderIsolation" rule by a per-arm
 * policy that lets the experiment frame each arm with the integrity it needs:
 *
 *   - top_tier_baseline    → strict identity (provider+model exact)
 *   - family_baseline      → family identity (any silo of same family OK)
 *   - dynamic_router       → semantic + capability identity (free routing)
 *   - collective_strategy  → role identity per strategy
 *   - resilience_strategy  → recovery is the object measured
 *
 * Models are NEVER hardcoded here. Candidate generation happens in the
 * SemanticModelRouter; this module only describes what each arm allows
 * the router to do, and validates after-the-fact that the trajectory
 * respected the declared policy.
 */

import type { CollectiveStrategy, ModeConfig } from '../experiment-types';

/**
 * Discriminant type extracted from ModeConfig variants. We use this rather
 * than the broader `ExecutionMode` because `ExecutionMode` includes literal
 * values (e.g. `'collective-tier1'`) that have no corresponding ModeConfig
 * variant in the discriminated union — using ModeConfig['mode'] keeps the
 * resolver totally exhaustive.
 */
export type ResolvedExperimentMode = ModeConfig['mode'];

// ─── Roles, identity levels, substitution ──────────────────────────────────

/**
 * The experimental role of an arm — what is being measured.
 *
 * These map onto distinct evaluation policies. An arm's role is the
 * primary input to `resolveArmEvaluationPolicy()`.
 */
export type ArmRole =
  | 'top_tier_baseline'      // measure exact provider+model (reference)
  | 'family_baseline'         // measure family via any equivalent silo
  | 'dynamic_router'          // measure the semantic/dynamic router
  | 'collective_strategy'     // measure multi-model composition
  | 'resilience_strategy'     // measure behavior under failure
  | 'local_baseline'          // measure local (Ollama) standalone — strict subgroup
  | 'ablation';               // measure component-isolated variant — inherits parent role

/**
 * Granularity at which arm identity is enforced.
 *
 *  - provider_model    : exact (providerId, modelId) — strict baselines
 *  - model_family      : same modelFamily, any silo — family baselines
 *  - capability_class  : same capability tier, any family — dynamic+
 */
export type IdentityLevel = 'provider_model' | 'model_family' | 'capability_class';

/**
 * Structural distance between declared arm and actual model used.
 *
 * Higher = farther from declared. Each policy declares a `maxSubstitutionLevel`;
 * any attempt at a higher level is a policy violation.
 *
 * Order is fixed (lower index = closer to declared):
 *   0: exact_provider_model
 *   1: same_provider_equivalent_model
 *   2: same_family_different_provider
 *   3: same_capability_tier
 *   4: local_degraded_fallback
 *   5: degraded_answer_mode (NEVER allowed in experiments)
 */
export type SubstitutionLevel =
  | 'exact_provider_model'
  | 'same_provider_equivalent_model'
  | 'same_family_different_provider'
  | 'same_capability_tier'
  | 'local_degraded_fallback'
  | 'degraded_answer_mode';

export const SUBSTITUTION_LEVEL_ORDER: readonly SubstitutionLevel[] = Object.freeze([
  'exact_provider_model',
  'same_provider_equivalent_model',
  'same_family_different_provider',
  'same_capability_tier',
  'local_degraded_fallback',
  'degraded_answer_mode',
] as const);

/** Compare two substitution levels. Returns true if `actual <= max`. */
export function isSubstitutionLevelAllowed(
  actual: SubstitutionLevel,
  max: SubstitutionLevel,
): boolean {
  return SUBSTITUTION_LEVEL_ORDER.indexOf(actual) <= SUBSTITUTION_LEVEL_ORDER.indexOf(max);
}

// ─── Fallback scope, parallelism, learning ─────────────────────────────────

/** Scope of fallback explored when primary fails. */
export type FallbackScope =
  | 'none'                              // strict baseline: no fallback
  | 'same_provider'                     // intra-silo only (model alternates)
  | 'same_family'                       // family baseline: distinct silos same family
  | 'same_capability_tier'              // dynamic: capability-equivalent across families
  | 'any_semantically_valid'            // dynamic+: maximum freedom under policy
  | 'strategy_declared_only';           // collective: only declared strategy roles

/** Parallel inference policy. */
export type HedgedRequestPolicy =
  | false                               // strict baselines forbid hedging
  | 'budget_guarded'                    // hedge allowed if total spend < budget
  | 'strategy_declared_only';           // hedge allowed only when strategy declares it

/** Adaptive learning behavior during this arm's execution. */
export type AdaptiveLearningPolicy =
  | 'frozen'                            // bandits/feedback don't update
  | 'frozen_during_eval'                // frozen for this experiment only
  | 'updates_globally'                  // dynamic_router: update real production state
  | 'updates_within_arm';               // resilience: update arm-local state only

/** Origin role of an attempt within a strategy. */
export type AttemptRoleInStrategy =
  | 'primary'
  | 'fallback'
  | 'judge'
  | 'expert'
  | 'critic'
  | 'aggregator'
  | 'hedged'
  | 'probe';

/** Reason an attempt was selected. Auditable, not derived from heuristics. */
export type SelectionReason =
  | 'semantic_top_ranked'
  | 'health_reroute'
  | 'latency_optimized'
  | 'cost_optimized'
  | 'fallback_after_error'
  | 'ollama_local_preference'
  | 'strategy_required_role'
  | 'hedged_request'
  | 'budget_guarded_swap'
  | 'capability_match';

// ─── The policy itself ─────────────────────────────────────────────────────

/**
 * The full evaluation policy of an arm. Five canonical instances declared
 * below cover the experiment taxonomy; arms can override individual fields
 * via `policyOverrides` on the arm config.
 */
export interface ArmEvaluationPolicy {
  /** Discriminator. Maps 1:1 to the canonical policy constants. */
  readonly kind:
    | 'strict_baseline_identity'
    | 'family_baseline_identity'
    | 'dynamic_router'
    | 'collective_strategy'
    | 'resilience_strategy';

  readonly description: string;

  // Fallback permissions
  readonly fallbackScope: FallbackScope;
  readonly maxFallbackDepth: number;
  readonly allowOllamaPrimary: boolean;
  readonly allowOllamaFallback: boolean;

  // Substitution permissions
  readonly maxSubstitutionLevel: SubstitutionLevel;

  // Parallelism permissions
  readonly allowHedgedRequests: HedgedRequestPolicy;
  readonly maxConcurrentInferences: number;

  // Learning behavior
  readonly adaptiveLearning: AdaptiveLearningPolicy;

  // Identity enforcement (each is independent — combinable)
  readonly enforceProviderIdentity: boolean;
  readonly enforceFamilyIdentity: boolean;
  readonly enforceCapabilityIdentity: boolean;

  // Budget bounds
  readonly perAttemptBudgetUsd: number;
  readonly totalArmBudgetUsd: number;

  // Time bounds
  readonly perAttemptTimeoutMs: number;
  readonly totalArmTimeoutMs: number;
}

// ─── Five canonical policies ───────────────────────────────────────────────

export const POLICY_STRICT_BASELINE: ArmEvaluationPolicy = Object.freeze({
  kind: 'strict_baseline_identity',
  description: 'Mede exatamente o (providerId, modelId) declarado; nenhuma substituição',
  fallbackScope: 'none',
  maxFallbackDepth: 1,
  allowOllamaPrimary: false,
  allowOllamaFallback: false,
  maxSubstitutionLevel: 'exact_provider_model',
  allowHedgedRequests: false,
  maxConcurrentInferences: 1,
  adaptiveLearning: 'frozen',
  enforceProviderIdentity: true,
  enforceFamilyIdentity: true,
  enforceCapabilityIdentity: true,
  perAttemptBudgetUsd: 0.05,
  totalArmBudgetUsd: 0.05,
  perAttemptTimeoutMs: 20_000,
  totalArmTimeoutMs: 20_000,
});

export const POLICY_FAMILY_BASELINE: ArmEvaluationPolicy = Object.freeze({
  kind: 'family_baseline_identity',
  description: 'Mede a família semântica via qualquer silo equivalente; cross-silo intra-família OK',
  fallbackScope: 'same_family',
  maxFallbackDepth: 3,
  allowOllamaPrimary: false,
  allowOllamaFallback: false, // configurable when family has declared local equivalent
  maxSubstitutionLevel: 'same_family_different_provider',
  allowHedgedRequests: false,
  maxConcurrentInferences: 1,
  adaptiveLearning: 'frozen_during_eval',
  enforceProviderIdentity: false,
  enforceFamilyIdentity: true,
  enforceCapabilityIdentity: true,
  perAttemptBudgetUsd: 0.05,
  totalArmBudgetUsd: 0.10,
  perAttemptTimeoutMs: 15_000,
  totalArmTimeoutMs: 30_000,
});

export const POLICY_DYNAMIC_ROUTER: ArmEvaluationPolicy = Object.freeze({
  kind: 'dynamic_router',
  description: 'Mede o roteador semântico/dinâmico; liberdade auditada; Ollama+frontier+health-aware',
  fallbackScope: 'any_semantically_valid',
  maxFallbackDepth: 4,
  allowOllamaPrimary: true,
  allowOllamaFallback: true,
  maxSubstitutionLevel: 'same_capability_tier',
  allowHedgedRequests: 'budget_guarded',
  maxConcurrentInferences: 2,
  adaptiveLearning: 'updates_globally',
  enforceProviderIdentity: false,
  enforceFamilyIdentity: false,
  enforceCapabilityIdentity: true,
  perAttemptBudgetUsd: 0.10,
  totalArmBudgetUsd: 0.30,
  perAttemptTimeoutMs: 15_000,
  totalArmTimeoutMs: 45_000,
});

export const POLICY_COLLECTIVE_STRATEGY: ArmEvaluationPolicy = Object.freeze({
  kind: 'collective_strategy',
  description: 'Mede composição N>1 com diversidade desejada; substituição por papel/capability',
  fallbackScope: 'strategy_declared_only',
  maxFallbackDepth: 2,
  allowOllamaPrimary: true,
  allowOllamaFallback: true,
  maxSubstitutionLevel: 'same_capability_tier',
  allowHedgedRequests: 'strategy_declared_only',
  maxConcurrentInferences: 5,
  adaptiveLearning: 'frozen_during_eval',
  enforceProviderIdentity: false,
  enforceFamilyIdentity: false,
  enforceCapabilityIdentity: true,
  perAttemptBudgetUsd: 0.10,
  totalArmBudgetUsd: 0.50,
  perAttemptTimeoutMs: 20_000,
  totalArmTimeoutMs: 90_000,
});

export const POLICY_RESILIENCE_STRATEGY: ArmEvaluationPolicy = Object.freeze({
  kind: 'resilience_strategy',
  description: 'Mede recuperação sob falha; fallback obrigatório; Ollama como rede de segurança',
  fallbackScope: 'any_semantically_valid',
  maxFallbackDepth: 5,
  allowOllamaPrimary: true,
  allowOllamaFallback: true,
  maxSubstitutionLevel: 'local_degraded_fallback',
  allowHedgedRequests: 'budget_guarded',
  maxConcurrentInferences: 3,
  adaptiveLearning: 'updates_within_arm',
  enforceProviderIdentity: false,
  enforceFamilyIdentity: false,
  enforceCapabilityIdentity: false,
  perAttemptBudgetUsd: 0.10,
  totalArmBudgetUsd: 0.40,
  perAttemptTimeoutMs: 15_000,
  totalArmTimeoutMs: 60_000,
});

/** All canonical policies, indexable by `kind`. */
export const POLICIES_BY_KIND: Readonly<Record<ArmEvaluationPolicy['kind'], ArmEvaluationPolicy>> = Object.freeze({
  strict_baseline_identity: POLICY_STRICT_BASELINE,
  family_baseline_identity: POLICY_FAMILY_BASELINE,
  dynamic_router: POLICY_DYNAMIC_ROUTER,
  collective_strategy: POLICY_COLLECTIVE_STRATEGY,
  resilience_strategy: POLICY_RESILIENCE_STRATEGY,
});

// ─── Arm declaration extensions ────────────────────────────────────────────

/**
 * Optional policy hints that can be embedded in any ModeConfig under
 * `policyHints`. When absent, the engine derives the role/policy from the
 * `mode` discriminator (preserves backwards compat with existing arms).
 *
 * IMPORTANT: this never embeds a model list. Models are produced by the
 * SemanticModelRouter; the hints only declare what the arm IS measuring.
 */
export interface ArmPolicyHints {
  /** Explicit experimental role. If absent, derived from `mode`. */
  readonly role?: ArmRole;

  /** Identity granularity. If absent, derived from role. */
  readonly identityLevel?: IdentityLevel;

  /** Declared family (only for `model_family` identity). */
  readonly declaredModelFamily?: string;

  /** Declared capability tier (only for `capability_class` identity). */
  readonly declaredCapabilityClass?: 'frontier' | 'mid' | 'budget' | 'local-frontier';

  /**
   * Selective field overrides on the resolved policy. Use sparingly —
   * a custom override breaks comparability across arms. Audited.
   */
  readonly policyOverrides?: Partial<{
    [K in keyof ArmEvaluationPolicy]: ArmEvaluationPolicy[K];
  }>;

  /**
   * For collective strategies declaring required roles. Used by the
   * readiness validator to decide if degradation is allowed.
   */
  readonly requiredRoles?: ReadonlyArray<AttemptRoleInStrategy>;

  /** Strategy declares its own intra-strategy fallback OK. */
  readonly allowIntraProviderFallback?: boolean;

  /** Strategy explicitly allows degradation (e.g., 3→2 experts). */
  readonly allowDegradation?: boolean;
}

// ─── Resolved arm view ─────────────────────────────────────────────────────

/**
 * Concrete experimental arm AFTER policy resolution. Built by the policy
 * engine from a `ModeConfig` + `ArmPolicyHints`. Carries everything the
 * orchestrator and integrity guard need.
 */
export interface ResolvedExperimentArm {
  readonly armId: string;
  readonly mode: ResolvedExperimentMode;
  readonly strategy: CollectiveStrategy | 'single' | 'auto' | null;

  readonly role: ArmRole;
  readonly identityLevel: IdentityLevel;
  readonly policy: ArmEvaluationPolicy;

  // Identity slots — populated according to identityLevel
  readonly declaredProviderId: string | null;
  readonly declaredModelId: string | null;
  readonly declaredModelFamily: string | null;
  readonly declaredCapabilityClass: ArmPolicyHints['declaredCapabilityClass'] | null;

  // Strategy details (collective only)
  readonly requiredRoles: ReadonlyArray<AttemptRoleInStrategy>;
  readonly allowDegradation: boolean;
  readonly allowIntraProviderFallback: boolean;

  /** Display label for reports. */
  readonly displayName: string;
}

// ─── Attempt and execution records (input to integrity guard) ──────────────

/**
 * A single model attempt within an execution. The orchestrator MUST record
 * one of these per invocation, including skipped/cancelled ones. The
 * IntegrityGuard validates the full trajectory against the arm's policy.
 */
export interface ModelAttemptRecord {
  readonly attemptIndex: number;

  readonly providerId: string;
  readonly modelId: string;
  readonly modelFamily: string;

  readonly roleInStrategy: AttemptRoleInStrategy;
  readonly selectionReason: SelectionReason;

  readonly status: 'selected' | 'attempted' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

  readonly errorClass?: string;
  readonly latencyMs?: number;
  readonly costUsd?: number;
  readonly timestampMs: number;
}

// ─── Integrity result ──────────────────────────────────────────────────────

export type PolicyViolationKind =
  | 'substitution_level_exceeded'
  | 'provider_identity_violation'
  | 'family_identity_violation'
  | 'capability_identity_violation'
  | 'ollama_primary_not_allowed'
  | 'ollama_fallback_not_allowed'
  | 'hedging_not_allowed'
  | 'fallback_depth_exceeded'
  | 'arm_budget_exceeded'
  | 'arm_timeout_exceeded'
  | 'concurrent_inferences_exceeded'
  | 'degraded_answer_mode_forbidden';

export interface PolicyViolation {
  readonly kind: PolicyViolationKind;
  readonly attemptIndex?: number;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly actualLevel?: SubstitutionLevel;
  readonly maxAllowed?: SubstitutionLevel;
  readonly actualValue?: number;
  readonly maxValue?: number;
  readonly message: string;
}

export interface IntegrityResult {
  readonly valid: boolean;
  readonly violations: ReadonlyArray<PolicyViolation>;
  readonly armId: string;
  readonly policyKind: ArmEvaluationPolicy['kind'];
  readonly checkedAttempts: number;
  readonly totalCostUsd: number;
  readonly totalDurationMs: number;
}

// ─── Type narrowing helpers ────────────────────────────────────────────────

/** Provider IDs reserved for Ollama / local hosts. Identifying ONLY by prefix. */
export function isOllamaProviderId(providerId: string): boolean {
  // Ollama silos are opaque; they all start with `ollama-` by convention.
  // We don't look up names — just structural prefix.
  return providerId === 'ollama-local' || providerId.startsWith('ollama-');
}

/** Frozen lookup of canonical policies by role (default mapping). */
export const ROLE_TO_DEFAULT_POLICY: Readonly<Record<ArmRole, ArmEvaluationPolicy>> = Object.freeze({
  top_tier_baseline: POLICY_STRICT_BASELINE,
  family_baseline: POLICY_FAMILY_BASELINE,
  dynamic_router: POLICY_DYNAMIC_ROUTER,
  collective_strategy: POLICY_COLLECTIVE_STRATEGY,
  resilience_strategy: POLICY_RESILIENCE_STRATEGY,
  local_baseline: POLICY_STRICT_BASELINE,
  ablation: POLICY_COLLECTIVE_STRATEGY, // ablation inherits parent default; resolved engine fixes it
});
