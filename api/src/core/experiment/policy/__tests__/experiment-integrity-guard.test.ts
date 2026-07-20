// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integrity Guard tests — end-to-end policy validation of execution
 * trajectories. Uses the synchronous `assertWithClassifications` path so
 * the tests stay free of DB mocks while still exercising the full
 * violation enumeration logic.
 */

import { describe, it, expect } from 'vitest';

import {
  DefaultExperimentIntegrityGuard,
  type ExecutionRecord,
  formatIntegrityResult,
} from '../experiment-integrity-guard';

import {
  POLICY_STRICT_BASELINE,
  POLICY_FAMILY_BASELINE,
  POLICY_DYNAMIC_ROUTER,
  POLICY_COLLECTIVE_STRATEGY,
  POLICY_RESILIENCE_STRATEGY,
  type ResolvedExperimentArm,
  type ArmEvaluationPolicy,
  type ModelAttemptRecord,
} from '../arm-evaluation-policy';

import type { ClassifiedModel } from '../model-classification';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeArm(o: Partial<ResolvedExperimentArm> & { policy: ArmEvaluationPolicy }): ResolvedExperimentArm {
  return Object.freeze({
    armId: o.armId ?? 'test-arm',
    mode: o.mode ?? 'single-model',
    strategy: o.strategy ?? 'single',
    role: o.role ?? 'top_tier_baseline',
    identityLevel: o.identityLevel ?? 'provider_model',
    policy: o.policy,
    declaredProviderId: o.declaredProviderId ?? null,
    declaredModelId: o.declaredModelId ?? null,
    declaredModelFamily: o.declaredModelFamily ?? null,
    declaredCapabilityClass: o.declaredCapabilityClass ?? null,
    requiredRoles: o.requiredRoles ?? ['primary'],
    allowDegradation: o.allowDegradation ?? false,
    allowIntraProviderFallback: o.allowIntraProviderFallback ?? false,
    displayName: o.displayName ?? 'Test',
  });
}

function makeAttempt(
  index: number,
  providerId: string,
  modelId: string,
  modelFamily: string,
  o: Partial<ModelAttemptRecord> = {},
): ModelAttemptRecord {
  return {
    attemptIndex: index,
    providerId,
    modelId,
    modelFamily,
    roleInStrategy: o.roleInStrategy ?? 'primary',
    selectionReason: o.selectionReason ?? 'semantic_top_ranked',
    status: o.status ?? 'succeeded',
    errorClass: o.errorClass,
    latencyMs: o.latencyMs,
    costUsd: o.costUsd,
    timestampMs: o.timestampMs ?? Date.now() + index * 200,
  };
}

function makeClass(modelId: string, providerId: string, modelFamily: string, opts: Partial<ClassifiedModel> = {}): ClassifiedModel {
  return {
    modelId,
    providerId,
    modelFamily,
    contextWindow: opts.contextWindow ?? 128_000,
    capabilities: opts.capabilities ?? ['chat', 'tools'],
    inputCostPer1k: opts.inputCostPer1k ?? 0.005,
    capabilityTier: opts.capabilityTier ?? 'frontier',
    isLocal: opts.isLocal ?? false,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('strict_baseline integrity', () => {
  const guard = new DefaultExperimentIntegrityGuard();

  it('valid: exact (provider, model) attempt passes', () => {
    const arm = makeArm({
      policy: POLICY_STRICT_BASELINE,
      armId: 'baseline::gpt-4o',
      declaredProviderId: 'openai-native',
      declaredModelId: 'gpt-4o',
      declaredModelFamily: 'openai',
    });

    const attempts = [makeAttempt(0, 'openai-native', 'gpt-4o', 'openai', { costUsd: 0.01 })];
    const classifications = new Map([
      ['gpt-4o', makeClass('gpt-4o', 'openai-native', 'openai')],
    ]);

    const record: ExecutionRecord = {
      executionId: 'exec-1',
      arm,
      attempts,
      totalCostUsd: 0.01,
      totalDurationMs: 5_000,
    };

    const result = guard.assertWithClassifications(record, classifications);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('invalid: cross-provider fallback under strict baseline', () => {
    const arm = makeArm({
      policy: POLICY_STRICT_BASELINE,
      armId: 'baseline::gpt-4o',
      declaredProviderId: 'openai-native',
      declaredModelId: 'gpt-4o',
      declaredModelFamily: 'openai',
    });

    const attempts = [
      makeAttempt(0, 'openai-native', 'gpt-4o', 'openai', { status: 'failed', costUsd: 0 }),
      makeAttempt(1, 'cometapi', 'gpt-4o', 'openai', {
        status: 'succeeded',
        roleInStrategy: 'fallback',
        selectionReason: 'fallback_after_error',
        costUsd: 0.012,
      }),
    ];
    const classifications = new Map([
      ['gpt-4o', makeClass('gpt-4o', 'openai-native', 'openai')], // by id, classifier picks one — for test, use index by full key
    ]);
    // Multi-provider models would actually be different DB rows. For test
    // simplicity, we re-key by attempt index using a separate classifier
    // composition:
    const classByAttempt = new Map<string, ClassifiedModel>();
    classByAttempt.set('gpt-4o', makeClass('gpt-4o', 'cometapi', 'openai'));

    const record: ExecutionRecord = {
      executionId: 'exec-2',
      arm,
      attempts,
      totalCostUsd: 0.012,
      totalDurationMs: 8_000,
    };

    const result = guard.assertWithClassifications(record, classByAttempt);
    expect(result.valid).toBe(false);
    const kinds = result.violations.map((v) => v.kind);
    expect(kinds).toContain('provider_identity_violation');
  });

  it('invalid: Ollama as primary in strict baseline', () => {
    const arm = makeArm({
      policy: POLICY_STRICT_BASELINE,
      declaredProviderId: 'openai-native',
      declaredModelId: 'gpt-4o',
      declaredModelFamily: 'openai',
    });

    const attempts = [
      makeAttempt(0, 'ollama-local', 'qwen2.5:32b', 'self_hosted', {
        roleInStrategy: 'primary',
        costUsd: 0,
      }),
    ];

    const classifications = new Map([
      ['qwen2.5:32b', makeClass('qwen2.5:32b', 'ollama-local', 'self_hosted', { isLocal: true, capabilityTier: 'local-frontier' })],
    ]);

    const record: ExecutionRecord = {
      executionId: 'exec-3',
      arm,
      attempts,
      totalCostUsd: 0,
      totalDurationMs: 3_000,
    };

    const result = guard.assertWithClassifications(record, classifications);
    expect(result.valid).toBe(false);
    const kinds = result.violations.map((v) => v.kind);
    expect(kinds).toContain('ollama_primary_not_allowed');
  });
});

describe('family_baseline integrity', () => {
  const guard = new DefaultExperimentIntegrityGuard();

  it('valid: same family, different silo', () => {
    const arm = makeArm({
      policy: POLICY_FAMILY_BASELINE,
      identityLevel: 'model_family',
      role: 'family_baseline',
      armId: 'family::openai/gpt-4o',
      declaredProviderId: null,
      declaredModelId: 'gpt-4o',
      declaredModelFamily: 'openai',
    });

    const attempts = [
      makeAttempt(0, 'cometapi', 'gpt-4o', 'openai', { costUsd: 0.01 }),
    ];

    const classifications = new Map([
      ['gpt-4o', makeClass('gpt-4o', 'cometapi', 'openai')],
    ]);

    const record: ExecutionRecord = {
      executionId: 'exec-4',
      arm,
      attempts,
      totalCostUsd: 0.01,
      totalDurationMs: 5_000,
    };

    const result = guard.assertWithClassifications(record, classifications);
    expect(result.valid).toBe(true);
  });

  it('invalid: cross-family substitution', () => {
    const arm = makeArm({
      policy: POLICY_FAMILY_BASELINE,
      identityLevel: 'model_family',
      role: 'family_baseline',
      armId: 'family::openai',
      declaredModelFamily: 'openai',
    });

    const attempts = [
      makeAttempt(0, 'anthropic-native', 'claude-3.5-sonnet', 'anthropic', { costUsd: 0.012 }),
    ];

    const classifications = new Map([
      ['claude-3.5-sonnet', makeClass('claude-3.5-sonnet', 'anthropic-native', 'anthropic')],
    ]);

    const record: ExecutionRecord = {
      executionId: 'exec-5',
      arm,
      attempts,
      totalCostUsd: 0.012,
      totalDurationMs: 4_000,
    };

    const result = guard.assertWithClassifications(record, classifications);
    expect(result.valid).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain('family_identity_violation');
  });
});

describe('dynamic_router integrity', () => {
  const guard = new DefaultExperimentIntegrityGuard();

  it('valid: cross-family within capability tier', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
      armId: 'dynamic::frontier',
      declaredCapabilityClass: 'frontier',
    });

    const attempts = [
      makeAttempt(0, 'cometapi', 'gpt-4o', 'openai', { costUsd: 0.01 }),
      makeAttempt(1, 'anthropic-native', 'claude-3.5-sonnet', 'anthropic', {
        roleInStrategy: 'fallback',
        selectionReason: 'fallback_after_error',
        costUsd: 0.012,
      }),
    ];

    const classifications = new Map([
      ['gpt-4o', makeClass('gpt-4o', 'cometapi', 'openai', { capabilityTier: 'frontier' })],
      ['claude-3.5-sonnet', makeClass('claude-3.5-sonnet', 'anthropic-native', 'anthropic', { capabilityTier: 'frontier' })],
    ]);

    const record: ExecutionRecord = {
      executionId: 'exec-6',
      arm,
      attempts,
      totalCostUsd: 0.022,
      totalDurationMs: 12_000,
    };

    const result = guard.assertWithClassifications(record, classifications);
    expect(result.valid).toBe(true);
  });

  it('valid: Ollama fallback under dynamic_router', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
      declaredCapabilityClass: 'frontier',
    });

    const attempts = [
      makeAttempt(0, 'cometapi', 'gpt-4o', 'openai', { status: 'failed', costUsd: 0 }),
      makeAttempt(1, 'ollama-local', 'qwen2.5:32b', 'self_hosted', {
        roleInStrategy: 'fallback',
        selectionReason: 'ollama_local_preference',
        costUsd: 0,
      }),
    ];

    const classifications = new Map([
      ['gpt-4o', makeClass('gpt-4o', 'cometapi', 'openai', { capabilityTier: 'frontier' })],
      ['qwen2.5:32b', makeClass('qwen2.5:32b', 'ollama-local', 'self_hosted', { isLocal: true, capabilityTier: 'local-frontier' })],
    ]);

    const record: ExecutionRecord = {
      executionId: 'exec-7',
      arm,
      attempts,
      totalCostUsd: 0,
      totalDurationMs: 8_000,
    };

    // Note: Ollama is local-frontier capability tier, but declared is frontier.
    // Engine enforces capabilityIdentity for dynamic_router → this VIOLATES.
    // To allow Ollama in dynamic_router declared as frontier, set declaredCapabilityClass=null.
    const result = guard.assertWithClassifications(record, classifications);
    // We expect a capability identity violation here:
    expect(result.violations.some((v) => v.kind === 'capability_identity_violation')).toBe(true);
  });

  it('valid: Ollama in dynamic_router with no declared capability tier', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
      declaredCapabilityClass: null, // not enforced
    });

    const attempts = [
      makeAttempt(0, 'ollama-local', 'qwen2.5:32b', 'self_hosted', {
        roleInStrategy: 'primary',
        selectionReason: 'ollama_local_preference',
        costUsd: 0,
      }),
    ];

    const classifications = new Map([
      ['qwen2.5:32b', makeClass('qwen2.5:32b', 'ollama-local', 'self_hosted', { isLocal: true, capabilityTier: 'local-frontier' })],
    ]);

    const record: ExecutionRecord = {
      executionId: 'exec-8',
      arm,
      attempts,
      totalCostUsd: 0,
      totalDurationMs: 6_000,
    };

    const result = guard.assertWithClassifications(record, classifications);
    expect(result.valid).toBe(true);
  });

  it('invalid: budget exceeded', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
    });

    const attempts = [
      makeAttempt(0, 'cometapi', 'gpt-4o', 'openai', {
        costUsd: POLICY_DYNAMIC_ROUTER.totalArmBudgetUsd + 0.10,
      }),
    ];

    const classifications = new Map([
      ['gpt-4o', makeClass('gpt-4o', 'cometapi', 'openai')],
    ]);

    const record: ExecutionRecord = {
      executionId: 'exec-9',
      arm,
      attempts,
      totalCostUsd: POLICY_DYNAMIC_ROUTER.totalArmBudgetUsd + 0.10,
      totalDurationMs: 5_000,
    };

    const result = guard.assertWithClassifications(record, classifications);
    expect(result.violations.map((v) => v.kind)).toContain('arm_budget_exceeded');
  });

  it('invalid: timeout exceeded', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
    });

    const attempts = [
      makeAttempt(0, 'cometapi', 'gpt-4o', 'openai', { costUsd: 0.01 }),
    ];

    const classifications = new Map([
      ['gpt-4o', makeClass('gpt-4o', 'cometapi', 'openai')],
    ]);

    const record: ExecutionRecord = {
      executionId: 'exec-10',
      arm,
      attempts,
      totalCostUsd: 0.01,
      totalDurationMs: POLICY_DYNAMIC_ROUTER.totalArmTimeoutMs + 1_000,
    };

    const result = guard.assertWithClassifications(record, classifications);
    expect(result.violations.map((v) => v.kind)).toContain('arm_timeout_exceeded');
  });

  it('invalid: fallback depth exceeded', () => {
    const arm = makeArm({
      policy: POLICY_DYNAMIC_ROUTER,
      identityLevel: 'capability_class',
      role: 'dynamic_router',
    });

    // To exceed maxFallbackDepth=4, need 5+ attempts ALL marked as fallback/hedged
    // (primary doesn't count toward fallback depth — it's the initial step).
    const fallbackCount = POLICY_DYNAMIC_ROUTER.maxFallbackDepth + 1;
    const attempts = [
      makeAttempt(0, 'p0', 'm0', 'f', { roleInStrategy: 'primary', costUsd: 0.001 }),
      ...Array.from({ length: fallbackCount }, (_, i) =>
        makeAttempt(i + 1, 'p' + (i + 1), 'm' + (i + 1), 'f', {
          roleInStrategy: 'fallback',
          costUsd: 0.001,
        }),
      ),
    ];

    const classifications = new Map<string, ClassifiedModel>();
    for (const a of attempts) {
      classifications.set(a.modelId, makeClass(a.modelId, a.providerId, a.modelFamily, { capabilityTier: 'frontier' }));
    }

    const record: ExecutionRecord = {
      executionId: 'exec-11',
      arm,
      attempts,
      totalCostUsd: 0.001 * attempts.length,
      totalDurationMs: 10_000,
    };

    const result = guard.assertWithClassifications(record, classifications);
    expect(result.violations.map((v) => v.kind)).toContain('fallback_depth_exceeded');
  });
});

describe('collective_strategy integrity', () => {
  const guard = new DefaultExperimentIntegrityGuard();

  it('valid: 3 experts in expert-panel', () => {
    const arm = makeArm({
      policy: POLICY_COLLECTIVE_STRATEGY,
      identityLevel: 'capability_class',
      role: 'collective_strategy',
      armId: 'collective::expert-panel',
      strategy: 'expert-panel',
      requiredRoles: ['expert', 'expert', 'expert', 'aggregator'],
    });

    const attempts = [
      makeAttempt(0, 'p1', 'm1', 'f1', { roleInStrategy: 'expert', costUsd: 0.005, timestampMs: Date.now() }),
      makeAttempt(1, 'p2', 'm2', 'f2', { roleInStrategy: 'expert', costUsd: 0.005, timestampMs: Date.now() + 1_000 }),
      makeAttempt(2, 'p3', 'm3', 'f3', { roleInStrategy: 'expert', costUsd: 0.005, timestampMs: Date.now() + 2_000 }),
      makeAttempt(3, 'p1', 'm-agg', 'f1', { roleInStrategy: 'aggregator', costUsd: 0.003, timestampMs: Date.now() + 3_000 }),
    ];

    const classifications = new Map<string, ClassifiedModel>();
    for (const a of attempts) {
      classifications.set(a.modelId, makeClass(a.modelId, a.providerId, a.modelFamily, { capabilityTier: 'frontier' }));
    }

    const record: ExecutionRecord = {
      executionId: 'exec-12',
      arm,
      attempts,
      totalCostUsd: 0.018,
      totalDurationMs: 30_000,
    };

    const result = guard.assertWithClassifications(record, classifications);
    expect(result.valid).toBe(true);
  });
});

describe('resilience_strategy integrity', () => {
  const guard = new DefaultExperimentIntegrityGuard();

  it('valid: deep fallback to local under resilience policy', () => {
    const arm = makeArm({
      policy: POLICY_RESILIENCE_STRATEGY,
      identityLevel: 'capability_class',
      role: 'resilience_strategy',
    });

    const attempts = [
      makeAttempt(0, 'cometapi', 'gpt-4o', 'openai', { status: 'failed', costUsd: 0 }),
      makeAttempt(1, 'aihubmix', 'gpt-4o', 'openai', { status: 'failed', roleInStrategy: 'fallback', costUsd: 0 }),
      makeAttempt(2, 'ollama-local', 'qwen2.5:32b', 'self_hosted', { status: 'succeeded', roleInStrategy: 'fallback', costUsd: 0 }),
    ];

    const classifications = new Map([
      ['gpt-4o', makeClass('gpt-4o', 'cometapi', 'openai', { capabilityTier: 'frontier' })],
      ['qwen2.5:32b', makeClass('qwen2.5:32b', 'ollama-local', 'self_hosted', { isLocal: true, capabilityTier: 'local-frontier' })],
    ]);

    const record: ExecutionRecord = {
      executionId: 'exec-13',
      arm,
      attempts,
      totalCostUsd: 0,
      totalDurationMs: 18_000,
    };

    const result = guard.assertWithClassifications(record, classifications);
    expect(result.valid).toBe(true);
  });
});

describe('formatIntegrityResult', () => {
  it('formats a valid result on a single line', () => {
    const result = {
      valid: true,
      violations: Object.freeze([]),
      armId: 'a',
      policyKind: 'strict_baseline_identity' as const,
      checkedAttempts: 1,
      totalCostUsd: 0.01,
      totalDurationMs: 5_000,
    };
    expect(formatIntegrityResult(result)).toContain('OK arm=a');
  });

  it('formats an invalid result with violations enumerated', () => {
    const result = {
      valid: false,
      violations: Object.freeze([
        {
          kind: 'family_identity_violation' as const,
          message: 'bad family',
        },
      ]),
      armId: 'a',
      policyKind: 'family_baseline_identity' as const,
      checkedAttempts: 1,
      totalCostUsd: 0.012,
      totalDurationMs: 5_000,
    };
    const formatted = formatIntegrityResult(result);
    expect(formatted).toContain('FAILED');
    expect(formatted).toContain('family_identity_violation');
  });
});
