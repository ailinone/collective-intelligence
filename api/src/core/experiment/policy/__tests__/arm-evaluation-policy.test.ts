// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Invariants on the canonical arm evaluation policies.
 *
 * These tests guarantee that the 5 canonical policies stay internally
 * consistent. They are NOT integration tests — pure structural invariants
 * over the type-frozen constants.
 */

import { describe, it, expect } from 'vitest';

import {
  POLICY_STRICT_BASELINE,
  POLICY_FAMILY_BASELINE,
  POLICY_DYNAMIC_ROUTER,
  POLICY_COLLECTIVE_STRATEGY,
  POLICY_RESILIENCE_STRATEGY,
  POLICIES_BY_KIND,
  ROLE_TO_DEFAULT_POLICY,
  SUBSTITUTION_LEVEL_ORDER,
  isSubstitutionLevelAllowed,
  isOllamaProviderId,
  type ArmEvaluationPolicy,
  type ArmRole,
  type SubstitutionLevel,
} from '../arm-evaluation-policy';

const ALL_POLICIES: ReadonlyArray<{ name: string; policy: ArmEvaluationPolicy }> = [
  { name: 'strict_baseline', policy: POLICY_STRICT_BASELINE },
  { name: 'family_baseline', policy: POLICY_FAMILY_BASELINE },
  { name: 'dynamic_router', policy: POLICY_DYNAMIC_ROUTER },
  { name: 'collective_strategy', policy: POLICY_COLLECTIVE_STRATEGY },
  { name: 'resilience_strategy', policy: POLICY_RESILIENCE_STRATEGY },
];

describe('canonical policies — structural invariants', () => {
  it.each(ALL_POLICIES)('$name has consistent budget bounds', ({ policy }) => {
    expect(policy.totalArmBudgetUsd).toBeGreaterThanOrEqual(policy.perAttemptBudgetUsd);
    expect(policy.perAttemptBudgetUsd).toBeGreaterThan(0);
  });

  it.each(ALL_POLICIES)('$name has consistent timeout bounds', ({ policy }) => {
    expect(policy.totalArmTimeoutMs).toBeGreaterThanOrEqual(policy.perAttemptTimeoutMs);
    expect(policy.perAttemptTimeoutMs).toBeGreaterThan(0);
  });

  it.each(ALL_POLICIES)('$name has positive depth and concurrency', ({ policy }) => {
    expect(policy.maxFallbackDepth).toBeGreaterThanOrEqual(1);
    expect(policy.maxConcurrentInferences).toBeGreaterThanOrEqual(1);
  });

  it('strict_baseline forbids any cross-silo behavior', () => {
    expect(POLICY_STRICT_BASELINE.fallbackScope).toBe('none');
    expect(POLICY_STRICT_BASELINE.maxFallbackDepth).toBe(1);
    expect(POLICY_STRICT_BASELINE.maxSubstitutionLevel).toBe('exact_provider_model');
    expect(POLICY_STRICT_BASELINE.allowOllamaPrimary).toBe(false);
    expect(POLICY_STRICT_BASELINE.allowOllamaFallback).toBe(false);
    expect(POLICY_STRICT_BASELINE.allowHedgedRequests).toBe(false);
    expect(POLICY_STRICT_BASELINE.adaptiveLearning).toBe('frozen');
    expect(POLICY_STRICT_BASELINE.enforceProviderIdentity).toBe(true);
    expect(POLICY_STRICT_BASELINE.enforceFamilyIdentity).toBe(true);
    expect(POLICY_STRICT_BASELINE.enforceCapabilityIdentity).toBe(true);
    expect(POLICY_STRICT_BASELINE.maxConcurrentInferences).toBe(1);
  });

  it('family_baseline allows same-family substitution but not cross-family', () => {
    expect(POLICY_FAMILY_BASELINE.maxSubstitutionLevel).toBe('same_family_different_provider');
    expect(POLICY_FAMILY_BASELINE.fallbackScope).toBe('same_family');
    expect(POLICY_FAMILY_BASELINE.enforceProviderIdentity).toBe(false);
    expect(POLICY_FAMILY_BASELINE.enforceFamilyIdentity).toBe(true);
    expect(POLICY_FAMILY_BASELINE.allowOllamaFallback).toBe(false);
  });

  it('dynamic_router allows free routing within capability tier', () => {
    expect(POLICY_DYNAMIC_ROUTER.maxSubstitutionLevel).toBe('same_capability_tier');
    expect(POLICY_DYNAMIC_ROUTER.fallbackScope).toBe('any_semantically_valid');
    expect(POLICY_DYNAMIC_ROUTER.enforceProviderIdentity).toBe(false);
    expect(POLICY_DYNAMIC_ROUTER.enforceFamilyIdentity).toBe(false);
    expect(POLICY_DYNAMIC_ROUTER.enforceCapabilityIdentity).toBe(true);
    expect(POLICY_DYNAMIC_ROUTER.allowOllamaPrimary).toBe(true);
    expect(POLICY_DYNAMIC_ROUTER.allowOllamaFallback).toBe(true);
    expect(POLICY_DYNAMIC_ROUTER.allowHedgedRequests).toBe('budget_guarded');
    expect(POLICY_DYNAMIC_ROUTER.adaptiveLearning).toBe('updates_globally');
  });

  it('collective_strategy permits high concurrency for parallel roles', () => {
    expect(POLICY_COLLECTIVE_STRATEGY.maxConcurrentInferences).toBeGreaterThanOrEqual(3);
    expect(POLICY_COLLECTIVE_STRATEGY.fallbackScope).toBe('strategy_declared_only');
    expect(POLICY_COLLECTIVE_STRATEGY.adaptiveLearning).toBe('frozen_during_eval');
  });

  it('resilience_strategy allows degraded fallback to local', () => {
    expect(POLICY_RESILIENCE_STRATEGY.maxSubstitutionLevel).toBe('local_degraded_fallback');
    expect(POLICY_RESILIENCE_STRATEGY.allowOllamaFallback).toBe(true);
    expect(POLICY_RESILIENCE_STRATEGY.allowHedgedRequests).toBe('budget_guarded');
    expect(POLICY_RESILIENCE_STRATEGY.adaptiveLearning).toBe('updates_within_arm');
  });

  it('no policy allows degraded_answer_mode', () => {
    for (const { policy } of ALL_POLICIES) {
      expect(policy.maxSubstitutionLevel).not.toBe('degraded_answer_mode');
    }
  });

  it('POLICIES_BY_KIND covers all policy kinds and is consistent', () => {
    for (const { policy } of ALL_POLICIES) {
      expect(POLICIES_BY_KIND[policy.kind]).toBe(policy);
    }
  });

  it('ROLE_TO_DEFAULT_POLICY covers every ArmRole', () => {
    const roles: ArmRole[] = [
      'top_tier_baseline',
      'family_baseline',
      'dynamic_router',
      'collective_strategy',
      'resilience_strategy',
      'local_baseline',
      'ablation',
    ];
    for (const r of roles) {
      expect(ROLE_TO_DEFAULT_POLICY[r]).toBeDefined();
    }
  });
});

describe('SUBSTITUTION_LEVEL_ORDER + isSubstitutionLevelAllowed', () => {
  it('order is monotonically increasing distance from declared', () => {
    const expected: SubstitutionLevel[] = [
      'exact_provider_model',
      'same_provider_equivalent_model',
      'same_family_different_provider',
      'same_capability_tier',
      'local_degraded_fallback',
      'degraded_answer_mode',
    ];
    expect([...SUBSTITUTION_LEVEL_ORDER]).toEqual(expected);
  });

  it('exact ≤ exact', () => {
    expect(isSubstitutionLevelAllowed('exact_provider_model', 'exact_provider_model')).toBe(true);
  });

  it('same_family ≤ same_capability_tier', () => {
    expect(isSubstitutionLevelAllowed('same_family_different_provider', 'same_capability_tier')).toBe(true);
  });

  it('same_capability_tier > exact_provider_model', () => {
    expect(isSubstitutionLevelAllowed('same_capability_tier', 'exact_provider_model')).toBe(false);
  });

  it('local_degraded_fallback ≤ local_degraded_fallback', () => {
    expect(isSubstitutionLevelAllowed('local_degraded_fallback', 'local_degraded_fallback')).toBe(true);
  });

  it('degraded_answer_mode is the strictly highest level', () => {
    const all: SubstitutionLevel[] = [
      'exact_provider_model',
      'same_provider_equivalent_model',
      'same_family_different_provider',
      'same_capability_tier',
      'local_degraded_fallback',
    ];
    for (const l of all) {
      expect(isSubstitutionLevelAllowed('degraded_answer_mode', l)).toBe(false);
    }
  });
});

describe('isOllamaProviderId', () => {
  it('matches canonical local id', () => {
    expect(isOllamaProviderId('ollama-local')).toBe(true);
  });

  it('matches namespaced ollama hosts', () => {
    expect(isOllamaProviderId('ollama-gpu-node-1')).toBe(true);
    expect(isOllamaProviderId('ollama-cpu-node-1')).toBe(true);
  });

  it('does not match remote providers that contain "ollama" in name accidentally', () => {
    expect(isOllamaProviderId('cometapi')).toBe(false);
    expect(isOllamaProviderId('openai-native')).toBe(false);
    expect(isOllamaProviderId('aihubmix')).toBe(false);
  });

  it('does not match strings with ollama as substring (only prefix)', () => {
    expect(isOllamaProviderId('xollama')).toBe(false);
    expect(isOllamaProviderId('something-ollama-something')).toBe(false);
  });
});
