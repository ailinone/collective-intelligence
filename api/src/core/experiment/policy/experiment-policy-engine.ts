// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Experiment Policy Engine — applies ArmEvaluationPolicy to runtime decisions.
 *
 * The engine is PURE: it takes classified candidates and arm definitions as
 * input and returns deterministic verdicts. Side effects (probing, DB writes,
 * audit logging) live in callers.
 *
 * Public surface:
 *   - resolveArmPolicy(arm)
 *   - isCandidateAllowed(arm, classified, ctx)
 *   - isFallbackAllowed(arm, from, to, ctx)
 *   - isParallelAttemptAllowed(arm, attempts)
 *   - classifyAttempt(arm, attempt)
 *   - computeSubstitutionLevel(declared, classified)
 *
 * No model lists. No catalog hardcoding. The engine receives ClassifiedModel
 * (already resolved by model-classification.ts from DB+catalog) and reasons
 * structurally about identity, family, capability, locality.
 */

import type {
  ResolvedExperimentArm,
  ArmEvaluationPolicy,
  SubstitutionLevel,
  AttemptRoleInStrategy,
  ModelAttemptRecord,
} from './arm-evaluation-policy';
import {
  isOllamaProviderId,
  isSubstitutionLevelAllowed,
} from './arm-evaluation-policy';
import type { ClassifiedModel, CapabilityTier } from './model-classification';

// ─── Verdicts ──────────────────────────────────────────────────────────────

export interface CandidateVerdict {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly substitutionLevel?: SubstitutionLevel;
}

export interface FallbackVerdict {
  readonly allowed: boolean;
  readonly substitutionLevel: SubstitutionLevel;
  readonly reason?: string;
}

export interface ParallelVerdict {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface AttemptClassification {
  readonly substitutionLevel: SubstitutionLevel;
  readonly allowedByPolicy: boolean;
  readonly violationReason?: string;
}

// ─── Selection / fallback context ──────────────────────────────────────────

export interface SelectionContext {
  /** Role this candidate is being considered for. */
  readonly roleInStrategy: AttemptRoleInStrategy;
}

export interface FallbackContext {
  /** Number of attempts already executed BEFORE this fallback. */
  readonly fallbackDepth: number;
  /** Total cost spent so far on this arm (USD). */
  readonly budgetSpentUsd: number;
  /** Wall-clock elapsed since arm started (ms). */
  readonly elapsedMs: number;
  /** Whether this fallback is for a strategy-required role. */
  readonly forRequiredRole: boolean;
}

// ─── Substitution level computation ────────────────────────────────────────

/**
 * Compute structural distance between the arm's declaration and an actual
 * candidate. Pure function; no I/O.
 *
 * Algorithm:
 *   1. If providerId == declared and modelId == declared → exact_provider_model
 *   2. Else if providerId == declared → same_provider_equivalent_model
 *   3. Else if modelFamily == declared family → same_family_different_provider
 *   4. Else if same capability tier (frontier↔frontier, etc.) → same_capability_tier
 *   5. Else if candidate is local (Ollama) → local_degraded_fallback
 *   6. Else → degraded_answer_mode (forbidden in experiments)
 */
export function computeSubstitutionLevel(
  declared: {
    readonly providerId: string | null;
    readonly modelId: string | null;
    readonly modelFamily: string | null;
    readonly capabilityTier: CapabilityTier | null;
  },
  candidate: ClassifiedModel,
): SubstitutionLevel {
  // Special case: when nothing is declared (all null), the arm has not
  // committed to any identity. Any candidate trivially satisfies the
  // declaration — return Level 0. The arm's policy still applies through
  // its identity-enforcement flags and Ollama gates downstream.
  if (
    declared.providerId === null &&
    declared.modelId === null &&
    declared.modelFamily === null &&
    declared.capabilityTier === null
  ) {
    return 'exact_provider_model';
  }

  // Level 0: exact match
  if (
    declared.providerId !== null &&
    declared.modelId !== null &&
    candidate.providerId === declared.providerId &&
    candidate.modelId === declared.modelId
  ) {
    return 'exact_provider_model';
  }

  // Level 1: same provider, different model
  if (declared.providerId !== null && candidate.providerId === declared.providerId) {
    return 'same_provider_equivalent_model';
  }

  // Level 2: same family, different provider
  if (
    declared.modelFamily !== null &&
    candidate.modelFamily === declared.modelFamily
  ) {
    return 'same_family_different_provider';
  }

  // Level 3: same capability tier (cross-family within tier)
  if (
    declared.capabilityTier !== null &&
    candidate.capabilityTier === declared.capabilityTier
  ) {
    return 'same_capability_tier';
  }

  // Level 4: local fallback (Ollama)
  if (candidate.isLocal) {
    return 'local_degraded_fallback';
  }

  // Level 5: anything else
  return 'degraded_answer_mode';
}

// ─── Public engine surface ─────────────────────────────────────────────────

export interface ExperimentPolicyEngine {
  /** Look up the canonical policy for an arm. */
  resolveArmPolicy(arm: ResolvedExperimentArm): ArmEvaluationPolicy;

  /**
   * Whether a candidate may be CONSIDERED for an arm. Used as a filter
   * before ranking — does NOT execute anything.
   */
  isCandidateAllowed(
    arm: ResolvedExperimentArm,
    candidate: ClassifiedModel,
    ctx: SelectionContext,
  ): CandidateVerdict;

  /**
   * Whether a fallback transition is allowed at this depth/budget/time.
   * Called when the orchestrator decides whether to try the next alternate.
   */
  isFallbackAllowed(
    arm: ResolvedExperimentArm,
    from: ClassifiedModel,
    to: ClassifiedModel,
    ctx: FallbackContext,
  ): FallbackVerdict;

  /**
   * Whether a set of parallel attempts (hedge or strategy-fanout) is
   * allowed under the arm's policy.
   */
  isParallelAttemptAllowed(
    arm: ResolvedExperimentArm,
    attempts: ReadonlyArray<ClassifiedModel>,
  ): ParallelVerdict;

  /**
   * Classify a single attempt: compute its substitution level vs the arm
   * declaration and report whether it satisfied the policy.
   */
  classifyAttempt(
    arm: ResolvedExperimentArm,
    attempt: ModelAttemptRecord,
    classified: ClassifiedModel,
  ): AttemptClassification;
}

// ─── Default implementation ────────────────────────────────────────────────

export class DefaultExperimentPolicyEngine implements ExperimentPolicyEngine {
  resolveArmPolicy(arm: ResolvedExperimentArm): ArmEvaluationPolicy {
    return arm.policy;
  }

  isCandidateAllowed(
    arm: ResolvedExperimentArm,
    candidate: ClassifiedModel,
    ctx: SelectionContext,
  ): CandidateVerdict {
    const policy = arm.policy;

    // Hard identity gates first
    if (
      policy.enforceProviderIdentity &&
      arm.declaredProviderId !== null &&
      candidate.providerId !== arm.declaredProviderId
    ) {
      return {
        allowed: false,
        reason: `provider_identity_violation: declared=${arm.declaredProviderId}, candidate=${candidate.providerId}`,
      };
    }

    if (
      policy.enforceFamilyIdentity &&
      arm.declaredModelFamily !== null &&
      candidate.modelFamily !== arm.declaredModelFamily
    ) {
      return {
        allowed: false,
        reason: `family_identity_violation: declared=${arm.declaredModelFamily}, candidate=${candidate.modelFamily}`,
      };
    }

    if (
      policy.enforceCapabilityIdentity &&
      arm.declaredCapabilityClass !== null &&
      candidate.capabilityTier !== arm.declaredCapabilityClass
    ) {
      return {
        allowed: false,
        reason: `capability_identity_violation: declared=${arm.declaredCapabilityClass}, candidate=${candidate.capabilityTier}`,
      };
    }

    // Ollama gates (independent of identity)
    if (candidate.isLocal || isOllamaProviderId(candidate.providerId)) {
      if (ctx.roleInStrategy === 'primary' && !policy.allowOllamaPrimary) {
        return {
          allowed: false,
          reason: 'ollama_primary_not_allowed',
        };
      }
      if (
        (ctx.roleInStrategy === 'fallback' || ctx.roleInStrategy === 'hedged') &&
        !policy.allowOllamaFallback
      ) {
        return {
          allowed: false,
          reason: 'ollama_fallback_not_allowed',
        };
      }
    }

    // Substitution level check
    const declaredView = {
      providerId: arm.declaredProviderId,
      modelId: arm.declaredModelId,
      modelFamily: arm.declaredModelFamily,
      capabilityTier: (arm.declaredCapabilityClass ?? null) as CapabilityTier | null,
    };
    const level = computeSubstitutionLevel(declaredView, candidate);

    if (!isSubstitutionLevelAllowed(level, policy.maxSubstitutionLevel)) {
      return {
        allowed: false,
        substitutionLevel: level,
        reason: `substitution_level_${level}_exceeds_max_${policy.maxSubstitutionLevel}`,
      };
    }

    // degraded_answer_mode is forbidden in all experiment policies (always)
    if (level === 'degraded_answer_mode') {
      return {
        allowed: false,
        substitutionLevel: level,
        reason: 'degraded_answer_mode_forbidden',
      };
    }

    return { allowed: true, substitutionLevel: level };
  }

  isFallbackAllowed(
    arm: ResolvedExperimentArm,
    from: ClassifiedModel,
    to: ClassifiedModel,
    ctx: FallbackContext,
  ): FallbackVerdict {
    const policy = arm.policy;

    const declaredView = {
      providerId: arm.declaredProviderId,
      modelId: arm.declaredModelId,
      modelFamily: arm.declaredModelFamily,
      capabilityTier: (arm.declaredCapabilityClass ?? null) as CapabilityTier | null,
    };
    const level = computeSubstitutionLevel(declaredView, to);

    if (!isSubstitutionLevelAllowed(level, policy.maxSubstitutionLevel)) {
      return {
        allowed: false,
        substitutionLevel: level,
        reason: `substitution_level_${level}_exceeds_max_${policy.maxSubstitutionLevel}`,
      };
    }

    if (level === 'degraded_answer_mode') {
      return {
        allowed: false,
        substitutionLevel: level,
        reason: 'degraded_answer_mode_forbidden',
      };
    }

    if (
      policy.enforceProviderIdentity &&
      arm.declaredProviderId !== null &&
      to.providerId !== arm.declaredProviderId
    ) {
      return {
        allowed: false,
        substitutionLevel: level,
        reason: 'enforce_provider_identity',
      };
    }

    if (
      policy.enforceFamilyIdentity &&
      arm.declaredModelFamily !== null &&
      to.modelFamily !== arm.declaredModelFamily
    ) {
      return {
        allowed: false,
        substitutionLevel: level,
        reason: 'enforce_family_identity',
      };
    }

    if ((to.isLocal || isOllamaProviderId(to.providerId)) && !policy.allowOllamaFallback) {
      return {
        allowed: false,
        substitutionLevel: level,
        reason: 'ollama_fallback_not_allowed',
      };
    }

    if (ctx.fallbackDepth >= policy.maxFallbackDepth) {
      return {
        allowed: false,
        substitutionLevel: level,
        reason: `max_fallback_depth_${policy.maxFallbackDepth}_reached`,
      };
    }

    if (ctx.budgetSpentUsd >= policy.totalArmBudgetUsd) {
      return {
        allowed: false,
        substitutionLevel: level,
        reason: `arm_budget_${policy.totalArmBudgetUsd}_exhausted`,
      };
    }

    if (ctx.elapsedMs >= policy.totalArmTimeoutMs) {
      return {
        allowed: false,
        substitutionLevel: level,
        reason: `arm_timeout_${policy.totalArmTimeoutMs}_exceeded`,
      };
    }

    return { allowed: true, substitutionLevel: level };
  }

  isParallelAttemptAllowed(
    arm: ResolvedExperimentArm,
    attempts: ReadonlyArray<ClassifiedModel>,
  ): ParallelVerdict {
    const policy = arm.policy;

    if (attempts.length > policy.maxConcurrentInferences) {
      return {
        allowed: false,
        reason: `concurrent_inferences_${attempts.length}_exceeds_max_${policy.maxConcurrentInferences}`,
      };
    }

    // Hedged: parallel inferences > 1 to the same logical request
    if (attempts.length > 1) {
      if (policy.allowHedgedRequests === false) {
        return {
          allowed: false,
          reason: 'hedging_not_allowed_by_policy',
        };
      }
      // 'budget_guarded' and 'strategy_declared_only' allowed at engine level;
      // higher layers (orchestrator) are responsible for enforcing the budget
      // / strategy declaration constraints.
    }

    // For collective: count of UNIQUE strategy roles allowed equals
    // policy.maxConcurrentInferences. Caller passes attempts where each
    // candidate is for a distinct role.
    return { allowed: true };
  }

  classifyAttempt(
    arm: ResolvedExperimentArm,
    attempt: ModelAttemptRecord,
    classified: ClassifiedModel,
  ): AttemptClassification {
    const policy = arm.policy;

    const declaredView = {
      providerId: arm.declaredProviderId,
      modelId: arm.declaredModelId,
      modelFamily: arm.declaredModelFamily,
      capabilityTier: (arm.declaredCapabilityClass ?? null) as CapabilityTier | null,
    };
    const level = computeSubstitutionLevel(declaredView, classified);

    if (!isSubstitutionLevelAllowed(level, policy.maxSubstitutionLevel)) {
      return {
        substitutionLevel: level,
        allowedByPolicy: false,
        violationReason: `substitution_level_${level}_exceeds_max_${policy.maxSubstitutionLevel}`,
      };
    }

    if (level === 'degraded_answer_mode') {
      return {
        substitutionLevel: level,
        allowedByPolicy: false,
        violationReason: 'degraded_answer_mode_forbidden',
      };
    }

    // Role-specific validation
    if (
      attempt.roleInStrategy === 'primary' &&
      classified.isLocal &&
      !policy.allowOllamaPrimary
    ) {
      return {
        substitutionLevel: level,
        allowedByPolicy: false,
        violationReason: 'ollama_primary_not_allowed',
      };
    }

    if (
      (attempt.roleInStrategy === 'fallback' || attempt.roleInStrategy === 'hedged') &&
      classified.isLocal &&
      !policy.allowOllamaFallback
    ) {
      return {
        substitutionLevel: level,
        allowedByPolicy: false,
        violationReason: 'ollama_fallback_not_allowed',
      };
    }

    if (attempt.roleInStrategy === 'hedged' && policy.allowHedgedRequests === false) {
      return {
        substitutionLevel: level,
        allowedByPolicy: false,
        violationReason: 'hedging_not_allowed',
      };
    }

    return {
      substitutionLevel: level,
      allowedByPolicy: true,
    };
  }
}

// ─── Module-level singleton (cheap; engine is stateless) ────────────────────

let defaultEngine: ExperimentPolicyEngine | null = null;

export function getDefaultPolicyEngine(): ExperimentPolicyEngine {
  if (defaultEngine === null) {
    defaultEngine = new DefaultExperimentPolicyEngine();
  }
  return defaultEngine;
}

/** Reset the singleton. Test-only. */
export function _resetPolicyEngineForTests(): void {
  defaultEngine = null;
}
