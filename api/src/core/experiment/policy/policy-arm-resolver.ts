// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Policy Arm Resolver — converts a ModeConfig (existing experiment arm shape)
 * into a ResolvedExperimentArm (policy-aware shape) without breaking
 * backwards compatibility.
 *
 * Resolution rules:
 *   1. If `policyHints.role` is present, use it.
 *   2. Otherwise, derive role from ModeConfig discriminator + heuristics.
 *   3. Identity level falls out of role, with overrides from hints.
 *   4. Declared identity slots populated according to identity level.
 *   5. Final policy = ROLE_TO_DEFAULT_POLICY[role] merged with policyOverrides.
 *
 * NEVER hardcodes model IDs or provider lists. All identity resolution is
 * structural — slots come from the arm declaration, not from a registry of
 * "known top-tier models".
 */

import type { CollectiveStrategy, ModeConfig } from '../experiment-types';

import {
  type ArmRole,
  type IdentityLevel,
  type ArmEvaluationPolicy,
  type ArmPolicyHints,
  type ResolvedExperimentArm,
  type ResolvedExperimentMode,
  type AttemptRoleInStrategy,
  POLICIES_BY_KIND,
  POLICY_STRICT_BASELINE,
  POLICY_FAMILY_BASELINE,
  POLICY_DYNAMIC_ROUTER,
  POLICY_COLLECTIVE_STRATEGY,
  POLICY_RESILIENCE_STRATEGY,
} from './arm-evaluation-policy';

// ─── Optional policy hints extension on ModeConfig ─────────────────────────
//
// Hints live as an OPTIONAL `policyHints` field on any ModeConfig variant.
// Existing arms without hints continue to work — the resolver derives a
// sensible default role and policy.

/**
 * Augmented ModeConfig variant carrying optional policy hints. When the
 * extension is absent, the arm role is derived from the mode discriminator.
 */
export type ModeConfigWithHints = ModeConfig & { readonly policyHints?: ArmPolicyHints };

// ─── Default role derivation ───────────────────────────────────────────────

/**
 * Derive ArmRole from ModeConfig discriminator when no hint is provided.
 *
 * Rules (preserves current C3 main-comparison semantics):
 *   - 'single-model'              → top_tier_baseline (strict identity)
 *   - 'single-budget'             → top_tier_baseline (strict identity)
 *   - 'collective'                → collective_strategy
 *   - 'forced-pool-collective'    → collective_strategy
 *   - 'adaptive'                  → dynamic_router
 *   - 'ablation'                  → ablation (inherits collective_strategy policy)
 */
export function deriveDefaultRole(mode: ResolvedExperimentMode): ArmRole {
  switch (mode) {
    case 'single-model':
    case 'single-budget':
      return 'top_tier_baseline';
    case 'collective':
    case 'forced-pool-collective':
      return 'collective_strategy';
    case 'adaptive':
      return 'dynamic_router';
    case 'ablation':
      return 'ablation';
    default: {
      // Exhaustive narrowing — TS will error if a new mode is added without update
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/**
 * Derive identityLevel from role when no hint is provided.
 */
export function deriveDefaultIdentityLevel(role: ArmRole): IdentityLevel {
  switch (role) {
    case 'top_tier_baseline':
    case 'local_baseline':
      return 'provider_model';
    case 'family_baseline':
      return 'model_family';
    case 'dynamic_router':
    case 'collective_strategy':
    case 'resilience_strategy':
    case 'ablation':
      return 'capability_class';
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

// ─── Strategy → required roles (for collective) ────────────────────────────

/**
 * Default required roles for each collective strategy. Used by readiness
 * to decide if degradation is allowed. NOT used to constrain models —
 * model selection per role is delegated to the SemanticModelRouter.
 *
 * Strategies not listed default to ['primary'] (single-call composition).
 */
const STRATEGY_DEFAULT_ROLES: Readonly<
  Partial<Record<CollectiveStrategy, ReadonlyArray<AttemptRoleInStrategy>>>
> = Object.freeze({
  'expert-panel': ['expert', 'expert', 'expert', 'aggregator'],
  'tri-role-collective': ['expert', 'critic', 'aggregator'],
  'debate': ['expert', 'critic', 'aggregator'],
  'war-room': ['expert', 'expert', 'critic', 'aggregator'],
  'blind-debate': ['expert', 'expert', 'aggregator'],
  'devil-advocate-consensus': ['expert', 'critic', 'aggregator'],
  'safety-quorum': ['expert', 'expert', 'expert', 'critic'],
  'critique-repair': ['primary', 'critic'],
  'consensus': ['expert', 'expert', 'aggregator'],
  'sensitivity-consensus': ['expert', 'expert', 'aggregator'],
  'judge': ['primary', 'judge'],
  'cost-cascade': ['primary', 'fallback', 'fallback'],
  'quality-multipass': ['primary', 'critic'],
});

function deriveRequiredRoles(
  mode: ResolvedExperimentMode,
  strategy: CollectiveStrategy | null,
): ReadonlyArray<AttemptRoleInStrategy> {
  if (mode === 'single-model' || mode === 'single-budget') return ['primary'];
  if (mode === 'adaptive') return ['primary'];
  if (strategy === null) return ['primary'];
  return STRATEGY_DEFAULT_ROLES[strategy] ?? ['primary'];
}

// ─── Identity slot extraction ──────────────────────────────────────────────

interface IdentitySlots {
  readonly declaredProviderId: string | null;
  readonly declaredModelId: string | null;
  readonly declaredModelFamily: string | null;
}

function extractIdentitySlots(
  mode: ModeConfig,
  identityLevel: IdentityLevel,
  hints: ArmPolicyHints | undefined,
): IdentitySlots {
  // ModelId is present on single-model / single-budget / forced-pool / ablation
  const modelId = extractModelId(mode);
  const family = hints?.declaredModelFamily ?? null;

  switch (identityLevel) {
    case 'provider_model':
      return {
        declaredProviderId: extractPreferredProviderId(mode) ?? null,
        declaredModelId: modelId,
        declaredModelFamily: family,
      };
    case 'model_family':
      return {
        declaredProviderId: null,
        declaredModelId: modelId, // optional anchor; actual selection by family
        declaredModelFamily: family,
      };
    case 'capability_class':
      return {
        declaredProviderId: null,
        declaredModelId: null,
        declaredModelFamily: null,
      };
    default: {
      const _exhaustive: never = identityLevel;
      return _exhaustive;
    }
  }
}

function extractModelId(mode: ModeConfig): string | null {
  switch (mode.mode) {
    case 'single-model':
      return mode.modelId;
    case 'single-budget':
      return mode.modelId;
    default:
      return null;
  }
}

function extractPreferredProviderId(mode: ModeConfig): string | null {
  if (mode.mode === 'single-model') {
    return mode.preferredProviders?.[0] ?? null;
  }
  return null;
}

function extractStrategy(mode: ModeConfig): CollectiveStrategy | 'single' | 'auto' | null {
  switch (mode.mode) {
    case 'single-model':
    case 'single-budget':
      return 'single';
    case 'adaptive':
      return 'auto';
    case 'collective':
      return mode.strategy;
    case 'forced-pool-collective':
      return mode.strategy;
    case 'ablation':
      return mode.strategy;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function extractDisplayName(mode: ModeConfig): string {
  switch (mode.mode) {
    case 'single-model':
      return mode.displayName;
    case 'single-budget':
      return mode.displayName;
    case 'forced-pool-collective':
      return mode.displayName;
    case 'ablation':
      return mode.displayName;
    case 'collective':
      return mode.displayName ?? `Collective: ${mode.strategy}`;
    case 'adaptive':
      return 'Adaptive';
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

// ─── armId derivation (deterministic from arm shape) ───────────────────────

/**
 * Stable ID derived from arm shape. Same arm config in two experiments
 * yields the same armId — required for fairness controls and historical
 * comparison.
 */
export function deriveArmId(mode: ModeConfig): string {
  switch (mode.mode) {
    case 'single-model':
      return `single-model::${mode.modelId}`;
    case 'single-budget':
      return `single-budget::${mode.modelId}`;
    case 'collective': {
      const adv = mode.adversarialScenario ? `::${mode.adversarialScenario}` : '';
      return `collective::${mode.strategy}${adv}`;
    }
    case 'forced-pool-collective': {
      const poolHash = mode.forcedModelPool.slice().sort().join(',');
      return `forced-pool-collective::${mode.strategy}::${poolHash}`;
    }
    case 'ablation': {
      const ablations = mode.disableComponents.slice().sort().join(',');
      return `ablation::${mode.strategy}::${ablations}`;
    }
    case 'adaptive':
      return 'adaptive::auto';
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

// ─── Main resolver ─────────────────────────────────────────────────────────

/**
 * Resolve a ModeConfig into a ResolvedExperimentArm. The resolution is
 * total — every ModeConfig produces a valid resolved arm with a coherent
 * policy.
 *
 * Behavior:
 *   - hints.role takes precedence
 *   - hints.identityLevel takes precedence
 *   - policyOverrides merge field-by-field on top of role's default policy
 *   - identity slots are populated according to identityLevel
 *   - strategy roles fall back to defaults if hints.requiredRoles absent
 */
export function resolveExperimentArm(
  mode: ModeConfigWithHints,
): ResolvedExperimentArm {
  const hints: ArmPolicyHints | undefined = mode.policyHints;

  const role: ArmRole = hints?.role ?? deriveDefaultRole(mode.mode);
  const identityLevel: IdentityLevel =
    hints?.identityLevel ?? deriveDefaultIdentityLevel(role);

  const basePolicy = resolveBasePolicy(role);
  const policy: ArmEvaluationPolicy = hints?.policyOverrides
    ? mergePolicy(basePolicy, hints.policyOverrides)
    : basePolicy;

  const slots = extractIdentitySlots(mode, identityLevel, hints);
  const strategy = extractStrategy(mode);
  const requiredRoles =
    hints?.requiredRoles ?? deriveRequiredRoles(mode.mode, strategy === 'auto' || strategy === 'single' ? null : strategy);

  return Object.freeze({
    armId: deriveArmId(mode),
    mode: mode.mode,
    strategy,
    role,
    identityLevel,
    policy,
    declaredProviderId: slots.declaredProviderId,
    declaredModelId: slots.declaredModelId,
    declaredModelFamily: slots.declaredModelFamily,
    declaredCapabilityClass: hints?.declaredCapabilityClass ?? null,
    requiredRoles,
    allowDegradation: hints?.allowDegradation ?? false,
    allowIntraProviderFallback: hints?.allowIntraProviderFallback ?? false,
    displayName: extractDisplayName(mode),
  });
}

/**
 * Look up the canonical policy for a role. Ablation inherits its parent
 * collective_strategy policy (with `frozen_during_eval` learning) — caller
 * may override via hints.
 */
function resolveBasePolicy(role: ArmRole): ArmEvaluationPolicy {
  switch (role) {
    case 'top_tier_baseline':
    case 'local_baseline':
      return POLICY_STRICT_BASELINE;
    case 'family_baseline':
      return POLICY_FAMILY_BASELINE;
    case 'dynamic_router':
      return POLICY_DYNAMIC_ROUTER;
    case 'collective_strategy':
    case 'ablation':
      return POLICY_COLLECTIVE_STRATEGY;
    case 'resilience_strategy':
      return POLICY_RESILIENCE_STRATEGY;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

/**
 * Merge a partial override onto a base policy. Validates that resulting
 * policy is internally consistent (e.g., maxFallbackDepth ≥ 1).
 */
function mergePolicy(
  base: ArmEvaluationPolicy,
  overrides: NonNullable<ArmPolicyHints['policyOverrides']>,
): ArmEvaluationPolicy {
  const merged: ArmEvaluationPolicy = {
    ...base,
    ...overrides,
  };

  // Internal consistency
  if (merged.maxFallbackDepth < 1) {
    throw new Error(
      `policyOverrides invalid: maxFallbackDepth must be ≥ 1, got ${merged.maxFallbackDepth}`,
    );
  }
  if (merged.maxConcurrentInferences < 1) {
    throw new Error(
      `policyOverrides invalid: maxConcurrentInferences must be ≥ 1, got ${merged.maxConcurrentInferences}`,
    );
  }
  if (merged.totalArmBudgetUsd < merged.perAttemptBudgetUsd) {
    throw new Error(
      `policyOverrides invalid: totalArmBudgetUsd (${merged.totalArmBudgetUsd}) < perAttemptBudgetUsd (${merged.perAttemptBudgetUsd})`,
    );
  }
  if (merged.totalArmTimeoutMs < merged.perAttemptTimeoutMs) {
    throw new Error(
      `policyOverrides invalid: totalArmTimeoutMs (${merged.totalArmTimeoutMs}) < perAttemptTimeoutMs (${merged.perAttemptTimeoutMs})`,
    );
  }

  return Object.freeze(merged);
}

// ─── Convenience: get policy for a kind without arm context ────────────────

/** Look up canonical policy by kind. Useful for tests and metrics. */
export function getCanonicalPolicy(kind: ArmEvaluationPolicy['kind']): ArmEvaluationPolicy {
  return POLICIES_BY_KIND[kind];
}
