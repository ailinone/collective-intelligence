// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Experiment Policy Engine tests — verdict-level coverage.
 *
 * Each test case constructs a ResolvedExperimentArm + ClassifiedModel
 * directly (no DB) and asserts the engine's verdict. This is the layer
 * the orchestrator and integrity guard depend on.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  DefaultExperimentPolicyEngine,
  computeSubstitutionLevel,
  type ExperimentPolicyEngine,
  type SelectionContext,
  type FallbackContext,
} from '../experiment-policy-engine';

import {
  POLICY_STRICT_BASELINE,
  POLICY_FAMILY_BASELINE,
  POLICY_DYNAMIC_ROUTER,
  POLICY_COLLECTIVE_STRATEGY,
  POLICY_RESILIENCE_STRATEGY,
  type ResolvedExperimentArm,
  type ArmEvaluationPolicy,
} from '../arm-evaluation-policy';

import type { ClassifiedModel, CapabilityTier } from '../model-classification';

// ─── Test fixtures (no I/O) ────────────────────────────────────────────────

function makeArm(overrides: Partial<ResolvedExperimentArm> & { policy: ArmEvaluationPolicy }): ResolvedExperimentArm {
  return Object.freeze({
    armId: overrides.armId ?? 'test-arm',
    mode: overrides.mode ?? 'single-model',
    strategy: overrides.strategy ?? 'single',
    role: overrides.role ?? 'top_tier_baseline',
    identityLevel: overrides.identityLevel ?? 'provider_model',
    policy: overrides.policy,
    declaredProviderId: overrides.declaredProviderId ?? null,
    declaredModelId: overrides.declaredModelId ?? null,
    declaredModelFamily: overrides.declaredModelFamily ?? null,
    declaredCapabilityClass: overrides.declaredCapabilityClass ?? null,
    requiredRoles: overrides.requiredRoles ?? ['primary'],
    allowDegradation: overrides.allowDegradation ?? false,
    allowIntraProviderFallback: overrides.allowIntraProviderFallback ?? false,
    displayName: overrides.displayName ?? 'Test',
  });
}

function makeModel(overrides: Partial<ClassifiedModel> & { modelId: string; providerId: string; modelFamily: string }): ClassifiedModel {
  return {
    modelId: overrides.modelId,
    providerId: overrides.providerId,
    modelFamily: overrides.modelFamily,
    contextWindow: overrides.contextWindow ?? 128_000,
    capabilities: overrides.capabilities ?? ['chat', 'tools'],
    inputCostPer1k: overrides.inputCostPer1k ?? 0.005,
    capabilityTier: overrides.capabilityTier ?? 'frontier',
    isLocal: overrides.isLocal ?? false,
  };
}

const PRIMARY_CTX: SelectionContext = { roleInStrategy: 'primary' };
const FALLBACK_CTX: SelectionContext = { roleInStrategy: 'fallback' };
const HEDGED_CTX: SelectionContext = { roleInStrategy: 'hedged' };

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('computeSubstitutionLevel', () => {
  it('exact match returns exact_provider_model', () => {
    const declared = {
      providerId: 'openai-native',
      modelId: 'gpt-4o',
      modelFamily: 'openai',
      capabilityTier: 'frontier' as CapabilityTier,
    };
    const candidate = makeModel({
      modelId: 'gpt-4o',
      providerId: 'openai-native',
      modelFamily: 'openai',
    });

    expect(computeSubstitutionLevel(declared, candidate)).toBe('exact_provider_model');
  });

  it('same provider, different model = same_provider_equivalent_model', () => {
    const declared = {
      providerId: 'openai-native',
      modelId: 'gpt-4o',
      modelFamily: 'openai',
      capabilityTier: 'frontier' as CapabilityTier,
    };
    const candidate = makeModel({
      modelId: 'gpt-4o-2024-11-20',
      providerId: 'openai-native',
      modelFamily: 'openai',
    });

    expect(computeSubstitutionLevel(declared, candidate)).toBe('same_provider_equivalent_model');
  });

  it('different provider, same family = same_family_different_provider', () => {
    const declared = {
      providerId: 'openai-native',
      modelId: 'gpt-4o',
      modelFamily: 'openai',
      capabilityTier: 'frontier' as CapabilityTier,
    };
    const candidate = makeModel({
      modelId: 'gpt-4o',
      providerId: 'cometapi',
      modelFamily: 'openai',
    });

    expect(computeSubstitutionLevel(declared, candidate)).toBe('same_family_different_provider');
  });

  it('different family, same capability tier = same_capability_tier', () => {
    const declared = {
      providerId: 'openai-native',
      modelId: 'gpt-4o',
      modelFamily: 'openai',
      capabilityTier: 'frontier' as CapabilityTier,
    };
    const candidate = makeModel({
      modelId: 'claude-3.5-sonnet',
      providerId: 'anthropic-native',
      modelFamily: 'anthropic',
      capabilityTier: 'frontier',
    });

    expect(computeSubstitutionLevel(declared, candidate)).toBe('same_capability_tier');
  });

  it('local Ollama is local_degraded_fallback', () => {
    const declared = {
      providerId: 'openai-native',
      modelId: 'gpt-4o',
      modelFamily: 'openai',
      capabilityTier: 'frontier' as CapabilityTier,
    };
    const candidate = makeModel({
      modelId: 'qwen2.5:32b',
      providerId: 'ollama-local',
      modelFamily: 'self_hosted',
      capabilityTier: 'local-frontier',
      isLocal: true,
    });

    expect(computeSubstitutionLevel(declared, candidate)).toBe('local_degraded_fallback');
  });

  it('totally different and not local = degraded_answer_mode', () => {
    const declared = {
      providerId: 'openai-native',
      modelId: 'gpt-4o',
      modelFamily: 'openai',
      capabilityTier: 'frontier' as CapabilityTier,
    };
    const candidate = makeModel({
      modelId: 'budget-model',
      providerId: 'cheap-provider',
      modelFamily: 'cheap-family',
      capabilityTier: 'budget',
    });

    expect(computeSubstitutionLevel(declared, candidate)).toBe('degraded_answer_mode');
  });

  it('null declared providerId still permits family match at level 2', () => {
    // family_baseline scenario — declared has family but no specific provider
    const declared = {
      providerId: null,
      modelId: null,
      modelFamily: 'openai',
      capabilityTier: 'frontier' as CapabilityTier,
    };
    const candidate = makeModel({
      modelId: 'gpt-4o',
      providerId: 'cometapi',
      modelFamily: 'openai',
    });

    expect(computeSubstitutionLevel(declared, candidate)).toBe('same_family_different_provider');
  });
});

describe('isCandidateAllowed — strict_baseline', () => {
  let engine: ExperimentPolicyEngine;

  beforeEach(() => {
    engine = new DefaultExperimentPolicyEngine();
  });

  it('allows exact (providerId, modelId)', () => {
    const arm = makeArm({
      policy: POLICY_STRICT_BASELINE,
      declaredProviderId: 'openai-native',
      declaredModelId: 'gpt-4o',
      declaredModelFamily: 'openai',
    });
    const candidate = makeModel({
      modelId: 'gpt-4o',
      providerId: 'openai-native',
      modelFamily: 'openai',
    });

    const verdict = engine.isCandidateAllowed(arm, candidate, PRIMARY_CTX);
    expect(verdict.allowed).toBe(true);
  });

  it('rejects different provider even with same model', () => {
    const arm = makeArm({
      policy: POLICY_STRICT_BASELINE,
      declaredProviderId: 'openai-native',
      declaredModelId: 'gpt-4o',
      declaredModelFamily: 'openai',
    });
    const candidate = makeModel({
      modelId: 'gpt-4o',
      providerId: 'cometapi',
      modelFamily: 'openai',
    });

    const verdict = engine.isCandidateAllowed(arm, candidate, PRIMARY_CTX);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('provider_identity_violation');
  });

  it('rejects Ollama as primary', () => {
    const arm = makeArm({
      policy: POLICY_STRICT_BASELINE,
      declaredProviderId: 'openai-native',
      declaredModelId: 'gpt-4o',
      declaredModelFamily: 'openai',
    });
    const candidate = makeModel({
      modelId: 'qwen2.5:32b',
      providerId: 'ollama-local',
      modelFamily: 'self_hosted',
      isLocal: true,
    });

    const verdict = engine.isCandidateAllowed(arm, candidate, PRIMARY_CTX);
    expect(verdict.allowed).toBe(false);
  });
});

describe('isCandidateAllowed — family_baseline', () => {
  let engine: ExperimentPolicyEngine;

  beforeEach(() => {
    engine = new DefaultExperimentPolicyEngine();
  });

  it('allows different silo of same family', () => {
    const arm = makeArm({
      policy: POLICY_FAMILY_BASELINE,
      identityLevel: 'model_family',
      role: 'family_baseline',
      declaredProviderId: null,
      declaredModelId: 'gpt-4o',
      declaredModelFamily: 'openai',
    });
    const candidate = makeModel({
      modelId: 'gpt-4o',
      providerId: 'cometapi',
      modelFamily: 'openai',
    });

    const verdict = engine.isCandidateAllowed(arm, candidate, PRIMARY_CTX);
    expect(verdict.allowed).toBe(true);
  });

  it('rejects different family (anthropic when declared openai)', () => {
    const arm = makeArm({
      policy: POLICY_FAMILY_BASELINE,
      identityLevel: 'model_family',
      role: 'family_baseline',
      declaredModelFamily: 'openai',
    });
    const candidate = makeModel({
      modelId: 'claude-3.5-sonnet',
      providerId: 'anthropic-native',
      modelFamily: 'anthropic',
    });

    const verdict = engine.isCandidateAllowed(arm, candidate, PRIMARY_CTX);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('family_identity_violation');
  });

  it('rejects Ollama fallback (family baseline default)', () => {
    const arm = makeArm({
      policy: POLICY_FAMILY_BASELINE,
      identityLevel: 'model_family',
      role: 'family_baseline',
      declaredModelFamily: 'openai',
    });
    const candidate = makeModel({
      modelId: 'qwen2.5:32b',
      providerId: 'ollama-local',
      modelFamily: 'openai', // even if we pretend it's same family
      isLocal: true,
    });

    const verdict = engine.isCandidateAllowed(arm, candidate, FALLBACK_CTX);
    expect(verdict.allowed).toBe(false);
  });
});

describe('isCandidateAllowed — dynamic_router', () => {
  let engine: ExperimentPolicyEngine;

  beforeEach(() => {
    engine = new DefaultExperimentPolicyEngine();
  });

  it('allows cross-family within same capability tier', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
      declaredCapabilityClass: 'frontier',
    });
    const candidate = makeModel({
      modelId: 'claude-3.5-sonnet',
      providerId: 'anthropic-native',
      modelFamily: 'anthropic',
      capabilityTier: 'frontier',
    });

    const verdict = engine.isCandidateAllowed(arm, candidate, PRIMARY_CTX);
    expect(verdict.allowed).toBe(true);
  });

  it('allows Ollama as primary', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
      declaredCapabilityClass: 'local-frontier',
    });
    const candidate = makeModel({
      modelId: 'qwen2.5:32b',
      providerId: 'ollama-local',
      modelFamily: 'self_hosted',
      capabilityTier: 'local-frontier',
      isLocal: true,
    });

    const verdict = engine.isCandidateAllowed(arm, candidate, PRIMARY_CTX);
    expect(verdict.allowed).toBe(true);
  });

  it('rejects cross-tier substitution (frontier declared, budget candidate)', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
      declaredCapabilityClass: 'frontier',
    });
    const candidate = makeModel({
      modelId: 'budget-x',
      providerId: 'cheap-hub',
      modelFamily: 'cheap-family',
      capabilityTier: 'budget',
    });

    const verdict = engine.isCandidateAllowed(arm, candidate, PRIMARY_CTX);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('capability_identity_violation');
  });
});

describe('isFallbackAllowed', () => {
  let engine: ExperimentPolicyEngine;

  beforeEach(() => {
    engine = new DefaultExperimentPolicyEngine();
  });

  it('strict_baseline rejects any fallback', () => {
    const arm = makeArm({
      policy: POLICY_STRICT_BASELINE,
      declaredProviderId: 'openai-native',
      declaredModelId: 'gpt-4o',
      declaredModelFamily: 'openai',
    });
    const from = makeModel({ modelId: 'gpt-4o', providerId: 'openai-native', modelFamily: 'openai' });
    const to = makeModel({ modelId: 'gpt-4o', providerId: 'cometapi', modelFamily: 'openai' });

    const ctx: FallbackContext = { fallbackDepth: 1, budgetSpentUsd: 0, elapsedMs: 0, forRequiredRole: false };
    const verdict = engine.isFallbackAllowed(arm, from, to, ctx);
    expect(verdict.allowed).toBe(false);
  });

  it('family_baseline allows same-family different-provider', () => {
    const arm = makeArm({
      policy: POLICY_FAMILY_BASELINE,
      identityLevel: 'model_family',
      role: 'family_baseline',
      declaredModelFamily: 'openai',
    });
    const from = makeModel({ modelId: 'gpt-4o', providerId: 'openai-native', modelFamily: 'openai' });
    const to = makeModel({ modelId: 'gpt-4o', providerId: 'cometapi', modelFamily: 'openai' });

    const ctx: FallbackContext = { fallbackDepth: 1, budgetSpentUsd: 0, elapsedMs: 0, forRequiredRole: false };
    const verdict = engine.isFallbackAllowed(arm, from, to, ctx);
    expect(verdict.allowed).toBe(true);
    expect(verdict.substitutionLevel).toBe('same_family_different_provider');
  });

  it('respects maxFallbackDepth', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
      declaredCapabilityClass: 'frontier',
    });
    const from = makeModel({ modelId: 'gpt-4o', providerId: 'openai-native', modelFamily: 'openai' });
    const to = makeModel({ modelId: 'claude-3.5-sonnet', providerId: 'anthropic-native', modelFamily: 'anthropic', capabilityTier: 'frontier' });

    const ctx: FallbackContext = {
      fallbackDepth: POLICY_DYNAMIC_ROUTER.maxFallbackDepth, // already at limit
      budgetSpentUsd: 0,
      elapsedMs: 0,
      forRequiredRole: false,
    };
    const verdict = engine.isFallbackAllowed(arm, from, to, ctx);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('max_fallback_depth');
  });

  it('respects budget exhaustion', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
      declaredCapabilityClass: 'frontier',
    });
    const from = makeModel({ modelId: 'm1', providerId: 'p1', modelFamily: 'f1' });
    const to = makeModel({ modelId: 'm2', providerId: 'p2', modelFamily: 'f1' });

    const ctx: FallbackContext = {
      fallbackDepth: 1,
      budgetSpentUsd: POLICY_DYNAMIC_ROUTER.totalArmBudgetUsd, // exhausted
      elapsedMs: 0,
      forRequiredRole: false,
    };
    const verdict = engine.isFallbackAllowed(arm, from, to, ctx);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('arm_budget');
  });

  it('respects timeout', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
      declaredCapabilityClass: 'frontier',
    });
    const from = makeModel({ modelId: 'm1', providerId: 'p1', modelFamily: 'f1' });
    const to = makeModel({ modelId: 'm2', providerId: 'p2', modelFamily: 'f1' });

    const ctx: FallbackContext = {
      fallbackDepth: 1,
      budgetSpentUsd: 0,
      elapsedMs: POLICY_DYNAMIC_ROUTER.totalArmTimeoutMs + 1,
      forRequiredRole: false,
    };
    const verdict = engine.isFallbackAllowed(arm, from, to, ctx);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('arm_timeout');
  });
});

describe('isParallelAttemptAllowed', () => {
  let engine: ExperimentPolicyEngine;

  beforeEach(() => {
    engine = new DefaultExperimentPolicyEngine();
  });

  it('strict_baseline rejects hedged (multiple attempts)', () => {
    const arm = makeArm({ policy: POLICY_STRICT_BASELINE });
    const a = makeModel({ modelId: 'a', providerId: 'pa', modelFamily: 'fa' });
    const b = makeModel({ modelId: 'b', providerId: 'pb', modelFamily: 'fb' });

    const verdict = engine.isParallelAttemptAllowed(arm, [a, b]);
    expect(verdict.allowed).toBe(false);
  });

  it('dynamic_router allows up to maxConcurrentInferences', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
    });
    const candidates = Array.from({ length: POLICY_DYNAMIC_ROUTER.maxConcurrentInferences }, (_, i) =>
      makeModel({ modelId: `m${i}`, providerId: `p${i}`, modelFamily: 'f' }),
    );

    const verdict = engine.isParallelAttemptAllowed(arm, candidates);
    expect(verdict.allowed).toBe(true);
  });

  it('rejects when count exceeds maxConcurrentInferences', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
    });
    const candidates = Array.from(
      { length: POLICY_DYNAMIC_ROUTER.maxConcurrentInferences + 1 },
      (_, i) => makeModel({ modelId: `m${i}`, providerId: `p${i}`, modelFamily: 'f' }),
    );

    const verdict = engine.isParallelAttemptAllowed(arm, candidates);
    expect(verdict.allowed).toBe(false);
  });

  it('collective_strategy allows up to 5 concurrent (expert panel)', () => {
    const arm = makeArm({
      policy: POLICY_COLLECTIVE_STRATEGY,
      identityLevel: 'capability_class',
      role: 'collective_strategy',
    });
    const candidates = Array.from(
      { length: POLICY_COLLECTIVE_STRATEGY.maxConcurrentInferences },
      (_, i) => makeModel({ modelId: `m${i}`, providerId: `p${i}`, modelFamily: 'f' }),
    );

    const verdict = engine.isParallelAttemptAllowed(arm, candidates);
    expect(verdict.allowed).toBe(true);
  });
});

describe('classifyAttempt', () => {
  let engine: ExperimentPolicyEngine;

  beforeEach(() => {
    engine = new DefaultExperimentPolicyEngine();
  });

  it('classifies primary attempt within strict baseline', () => {
    const arm = makeArm({
      policy: POLICY_STRICT_BASELINE,
      declaredProviderId: 'openai-native',
      declaredModelId: 'gpt-4o',
      declaredModelFamily: 'openai',
    });
    const classified = makeModel({
      modelId: 'gpt-4o',
      providerId: 'openai-native',
      modelFamily: 'openai',
    });

    const result = engine.classifyAttempt(
      arm,
      {
        attemptIndex: 0,
        providerId: 'openai-native',
        modelId: 'gpt-4o',
        modelFamily: 'openai',
        roleInStrategy: 'primary',
        selectionReason: 'semantic_top_ranked',
        status: 'succeeded',
        timestampMs: Date.now(),
      },
      classified,
    );

    expect(result.allowedByPolicy).toBe(true);
    expect(result.substitutionLevel).toBe('exact_provider_model');
  });

  it('flags Ollama-as-primary attempt under strict baseline', () => {
    const arm = makeArm({
      policy: POLICY_STRICT_BASELINE,
      declaredProviderId: 'openai-native',
      declaredModelId: 'gpt-4o',
      declaredModelFamily: 'openai',
    });
    const classified = makeModel({
      modelId: 'qwen2.5:32b',
      providerId: 'ollama-local',
      modelFamily: 'self_hosted',
      isLocal: true,
    });

    const result = engine.classifyAttempt(
      arm,
      {
        attemptIndex: 0,
        providerId: 'ollama-local',
        modelId: 'qwen2.5:32b',
        modelFamily: 'self_hosted',
        roleInStrategy: 'primary',
        selectionReason: 'ollama_local_preference',
        status: 'succeeded',
        timestampMs: Date.now(),
      },
      classified,
    );

    expect(result.allowedByPolicy).toBe(false);
  });

  it('allows hedged attempt under dynamic_router', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
      declaredCapabilityClass: 'frontier',
    });
    const classified = makeModel({
      modelId: 'claude-3.5-sonnet',
      providerId: 'anthropic-native',
      modelFamily: 'anthropic',
      capabilityTier: 'frontier',
    });

    const result = engine.classifyAttempt(
      arm,
      {
        attemptIndex: 1,
        providerId: 'anthropic-native',
        modelId: 'claude-3.5-sonnet',
        modelFamily: 'anthropic',
        roleInStrategy: 'hedged',
        selectionReason: 'hedged_request',
        status: 'succeeded',
        timestampMs: Date.now(),
      },
      classified,
    );

    expect(result.allowedByPolicy).toBe(true);
  });
});
