// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Policy Arm Resolver tests — verifies ModeConfig → ResolvedExperimentArm
 * resolution + identity slot extraction + policy override merging.
 *
 * No DB / no I/O. Pure resolution.
 */

import { describe, it, expect } from 'vitest';

import {
  resolveExperimentArm,
  deriveDefaultRole,
  deriveDefaultIdentityLevel,
  deriveArmId,
  type ModeConfigWithHints,
} from '../policy-arm-resolver';

import {
  POLICY_STRICT_BASELINE,
  POLICY_FAMILY_BASELINE,
  POLICY_DYNAMIC_ROUTER,
  POLICY_COLLECTIVE_STRATEGY,
  POLICY_RESILIENCE_STRATEGY,
} from '../arm-evaluation-policy';

describe('deriveDefaultRole', () => {
  it('single-model → top_tier_baseline', () => {
    expect(deriveDefaultRole('single-model')).toBe('top_tier_baseline');
  });

  it('single-budget → top_tier_baseline', () => {
    expect(deriveDefaultRole('single-budget')).toBe('top_tier_baseline');
  });

  it('collective → collective_strategy', () => {
    expect(deriveDefaultRole('collective')).toBe('collective_strategy');
  });

  it('forced-pool-collective → collective_strategy', () => {
    expect(deriveDefaultRole('forced-pool-collective')).toBe('collective_strategy');
  });

  it('adaptive → dynamic_router', () => {
    expect(deriveDefaultRole('adaptive')).toBe('dynamic_router');
  });

  it('ablation → ablation', () => {
    expect(deriveDefaultRole('ablation')).toBe('ablation');
  });
});

describe('deriveDefaultIdentityLevel', () => {
  it('top_tier_baseline → provider_model', () => {
    expect(deriveDefaultIdentityLevel('top_tier_baseline')).toBe('provider_model');
  });

  it('local_baseline → provider_model', () => {
    expect(deriveDefaultIdentityLevel('local_baseline')).toBe('provider_model');
  });

  it('family_baseline → model_family', () => {
    expect(deriveDefaultIdentityLevel('family_baseline')).toBe('model_family');
  });

  it.each(['dynamic_router', 'collective_strategy', 'resilience_strategy', 'ablation'] as const)(
    '%s → capability_class',
    (role) => {
      expect(deriveDefaultIdentityLevel(role)).toBe('capability_class');
    },
  );
});

describe('deriveArmId — deterministic', () => {
  it('single-model uses modelId', () => {
    expect(
      deriveArmId({
        mode: 'single-model',
        modelId: 'gpt-4o',
        displayName: 'GPT-4o',
      }),
    ).toBe('single-model::gpt-4o');
  });

  it('single-budget uses modelId', () => {
    expect(
      deriveArmId({
        mode: 'single-budget',
        modelId: 'budget-x',
        displayName: 'Budget X',
      }),
    ).toBe('single-budget::budget-x');
  });

  it('collective uses strategy + adversarial scenario when present', () => {
    expect(
      deriveArmId({
        mode: 'collective',
        strategy: 'debate',
      }),
    ).toBe('collective::debate');

    expect(
      deriveArmId({
        mode: 'collective',
        strategy: 'consensus',
        adversarialScenario: 'herding_cascade',
      }),
    ).toBe('collective::consensus::herding_cascade');
  });

  it('forced-pool-collective sorts pool for stability', () => {
    expect(
      deriveArmId({
        mode: 'forced-pool-collective',
        strategy: 'consensus',
        forcedModelPool: ['z-model', 'a-model', 'm-model'],
        displayName: 'Forced',
      }),
    ).toBe('forced-pool-collective::consensus::a-model,m-model,z-model');
  });

  it('ablation sorts disableComponents for stability', () => {
    expect(
      deriveArmId({
        mode: 'ablation',
        strategy: 'debate',
        displayName: 'Debate ablation',
        disableComponents: ['critique', 'feedback-loop', 'archive'],
      }),
    ).toBe('ablation::debate::archive,critique,feedback-loop');
  });

  it('adaptive is fixed', () => {
    expect(
      deriveArmId({
        mode: 'adaptive',
      }),
    ).toBe('adaptive::auto');
  });
});

describe('resolveExperimentArm — defaults', () => {
  it('single-model resolves to top_tier_baseline + strict policy', () => {
    const arm = resolveExperimentArm({
      mode: 'single-model',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o',
    });

    expect(arm.role).toBe('top_tier_baseline');
    expect(arm.identityLevel).toBe('provider_model');
    expect(arm.policy).toEqual(POLICY_STRICT_BASELINE);
    expect(arm.declaredModelId).toBe('gpt-4o');
    expect(arm.declaredProviderId).toBeNull();
    expect(arm.strategy).toBe('single');
  });

  it('single-model with preferredProviders fixes declaredProviderId', () => {
    const arm = resolveExperimentArm({
      mode: 'single-model',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o',
      preferredProviders: ['openai-native', 'cometapi'],
    });

    expect(arm.declaredProviderId).toBe('openai-native');
  });

  it('collective resolves to collective_strategy + collective policy', () => {
    const arm = resolveExperimentArm({
      mode: 'collective',
      strategy: 'debate',
    });

    expect(arm.role).toBe('collective_strategy');
    expect(arm.identityLevel).toBe('capability_class');
    expect(arm.policy).toEqual(POLICY_COLLECTIVE_STRATEGY);
    expect(arm.strategy).toBe('debate');
    expect(arm.declaredProviderId).toBeNull();
    expect(arm.declaredModelId).toBeNull();
  });

  it('adaptive resolves to dynamic_router policy', () => {
    const arm = resolveExperimentArm({
      mode: 'adaptive',
    });

    expect(arm.role).toBe('dynamic_router');
    expect(arm.policy).toEqual(POLICY_DYNAMIC_ROUTER);
    expect(arm.strategy).toBe('auto');
  });

  it('forced-pool-collective resolves to collective_strategy', () => {
    const arm = resolveExperimentArm({
      mode: 'forced-pool-collective',
      strategy: 'consensus',
      forcedModelPool: ['m1', 'm2'],
      displayName: 'Forced',
    });

    expect(arm.role).toBe('collective_strategy');
    expect(arm.policy).toEqual(POLICY_COLLECTIVE_STRATEGY);
  });

  it('ablation resolves to ablation role with collective_strategy policy', () => {
    const arm = resolveExperimentArm({
      mode: 'ablation',
      strategy: 'debate',
      disableComponents: ['critique'],
      displayName: 'Debate ablation',
    });

    expect(arm.role).toBe('ablation');
    expect(arm.policy).toEqual(POLICY_COLLECTIVE_STRATEGY);
  });
});

describe('resolveExperimentArm — hints override', () => {
  it('hints.role overrides default', () => {
    const arm = resolveExperimentArm({
      mode: 'single-model',
      modelId: 'qwen2.5:32b',
      displayName: 'Qwen Local',
      policyHints: {
        role: 'local_baseline',
      },
    });

    expect(arm.role).toBe('local_baseline');
    expect(arm.policy).toEqual(POLICY_STRICT_BASELINE);
  });

  it('hints.identityLevel = model_family populates declaredModelFamily', () => {
    const arm = resolveExperimentArm({
      mode: 'single-model',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o family',
      policyHints: {
        role: 'family_baseline',
        identityLevel: 'model_family',
        declaredModelFamily: 'openai',
      },
    });

    expect(arm.role).toBe('family_baseline');
    expect(arm.identityLevel).toBe('model_family');
    expect(arm.policy).toEqual(POLICY_FAMILY_BASELINE);
    expect(arm.declaredModelFamily).toBe('openai');
    expect(arm.declaredProviderId).toBeNull(); // not enforced at family level
    expect(arm.declaredModelId).toBe('gpt-4o');
  });

  it('hints.declaredCapabilityClass populates correctly for capability_class', () => {
    const arm = resolveExperimentArm({
      mode: 'collective',
      strategy: 'expert-panel',
      policyHints: {
        declaredCapabilityClass: 'frontier',
      },
    });

    expect(arm.declaredCapabilityClass).toBe('frontier');
  });

  it('hints.role = resilience_strategy applies resilience policy', () => {
    const arm = resolveExperimentArm({
      mode: 'collective',
      strategy: 'cost-cascade',
      policyHints: {
        role: 'resilience_strategy',
      },
    });

    expect(arm.role).toBe('resilience_strategy');
    expect(arm.policy).toEqual(POLICY_RESILIENCE_STRATEGY);
    expect(arm.policy.maxSubstitutionLevel).toBe('local_degraded_fallback');
  });
});

describe('resolveExperimentArm — policy overrides', () => {
  it('valid override merges field-by-field', () => {
    const arm = resolveExperimentArm({
      mode: 'collective',
      strategy: 'debate',
      policyHints: {
        policyOverrides: {
          maxFallbackDepth: 5,
        },
      },
    });

    expect(arm.policy.maxFallbackDepth).toBe(5);
    // other fields preserved
    expect(arm.policy.kind).toBe(POLICY_COLLECTIVE_STRATEGY.kind);
    expect(arm.policy.fallbackScope).toBe(POLICY_COLLECTIVE_STRATEGY.fallbackScope);
  });

  it('throws on inconsistent override (fallback depth < 1)', () => {
    expect(() =>
      resolveExperimentArm({
        mode: 'collective',
        strategy: 'debate',
        policyHints: {
          policyOverrides: { maxFallbackDepth: 0 },
        },
      }),
    ).toThrow('maxFallbackDepth must be ≥ 1');
  });

  it('throws when totalArmBudgetUsd < perAttemptBudgetUsd', () => {
    expect(() =>
      resolveExperimentArm({
        mode: 'adaptive',
        policyHints: {
          policyOverrides: {
            perAttemptBudgetUsd: 1.0,
            totalArmBudgetUsd: 0.5,
          },
        },
      }),
    ).toThrow(/totalArmBudgetUsd .* < perAttemptBudgetUsd/);
  });
});

describe('resolveExperimentArm — required roles', () => {
  it('single-model has [primary]', () => {
    const arm = resolveExperimentArm({
      mode: 'single-model',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o',
    });
    expect([...arm.requiredRoles]).toEqual(['primary']);
  });

  it('expert-panel has 3 experts + aggregator by default', () => {
    const arm = resolveExperimentArm({
      mode: 'collective',
      strategy: 'expert-panel',
    });
    const roles = [...arm.requiredRoles];
    expect(roles.filter((r) => r === 'expert')).toHaveLength(3);
    expect(roles).toContain('aggregator');
  });

  it('hints.requiredRoles overrides defaults', () => {
    const arm = resolveExperimentArm({
      mode: 'collective',
      strategy: 'expert-panel',
      policyHints: {
        requiredRoles: ['expert', 'expert', 'aggregator'],
      },
    });
    expect([...arm.requiredRoles]).toEqual(['expert', 'expert', 'aggregator']);
  });
});
