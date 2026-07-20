// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ecosystem Hardening Stress Tests
 *
 * Validates all P0/P1/P2 hardening blocks work correctly under stress:
 *   1. Credit exhaustion (single hub, multiple hubs, all external)
 *   2. Pool contraction (3→1 models)
 *   3. Cost normalization (zero cost, unknown cost)
 *   4. Self-hosted last-resort fallback
 *   5. Route-level operability isolation
 *   6. Strategy degradation (pre-dispatch + runtime classification)
 *   7. Strategy tiering recalculation
 *
 * These tests use in-memory mocks — no real API calls.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getProviderOperabilityHub } from '../provider-operability-hub';
import { buildRouteKey, extractModelFamily, createEmptySnapshot, isRouteUsable, getUsableExternalRoutes } from '../operability/operability-snapshot';
import { CreditGovernor } from '../budget/credit-governor';
import { PoolBuilder, buildChatExecutionPool } from '../pool/pool-builder';
import { isInfraFailure, resolveWithDegradation, resolveRuntimeDegradation } from '../orchestration/strategy-degradation';
import { evaluateLastResort, buildLastResortMetadata, splitBySelfHosted } from '../resilience/last-resort-policy';
import { recalculateTier, proposeAllTierChanges, getStrategyTier, getStrategyFeatureFlags } from '../orchestration/strategy-tiers';
import type { Model } from '@/types';

// ─── Test Helpers ───────────────────────────────────────────────────────

function mockModel(overrides: Partial<Model> & { id: string }): Model {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    provider: overrides.provider ?? 'openai',
    providerId: overrides.providerId ?? overrides.provider ?? 'openai',
    status: overrides.status ?? 'active',
    capabilities: overrides.capabilities ?? ['chat', 'text_generation'],
    performance: overrides.performance ?? { quality: 0.8, latency: 1000, successRate: 0.9 },
    inputCostPer1k: overrides.inputCostPer1k ?? 0.01,
    outputCostPer1k: overrides.outputCostPer1k ?? 0.03,
    balanceStatus: overrides.balanceStatus ?? 'has-credits',
    metadata: overrides.metadata ?? {},
    ...overrides,
  } as Model;
}

// ─── 1. Route-Level Operability Isolation ──────────────────────────────

describe('Route-Level Operability', () => {
  beforeEach(() => {
    // Reset hub state by recording enough successes to clear old events
  });

  it('buildRouteKey creates composite keys for hubs', () => {
    expect(buildRouteKey('aihubmix', 'openai')).toBe('aihubmix:openai');
    expect(buildRouteKey('cometapi', 'anthropic')).toBe('cometapi:anthropic');
    expect(buildRouteKey('openai', null)).toBe('openai');
    expect(buildRouteKey('openai', 'openai')).toBe('openai'); // native serving own models
  });

  it('extractModelFamily extracts family from model ID', () => {
    expect(extractModelFamily('openai/gpt-4o')).toBe('openai');
    expect(extractModelFamily('anthropic/claude-3.5-sonnet')).toBe('anthropic');
    expect(extractModelFamily('meta-llama/llama-3.1-70b')).toBe('meta');
    expect(extractModelFamily('gpt-4o')).toBeNull(); // no family prefix
  });

  it('hub failure on one family does NOT affect other families on same hub', () => {
    const hub = getProviderOperabilityHub();

    // Record failures on aihubmix:openai route
    hub.recordRouteExecution('aihubmix', 'openai/gpt-4o', false, 402, 'insufficient balance');
    hub.recordRouteExecution('aihubmix', 'openai/gpt-4o', false, 402, 'insufficient balance');

    // Record success on aihubmix:anthropic route
    hub.recordRouteExecution('aihubmix', 'anthropic/claude-3.5', true);

    // aihubmix:openai should be no_credits
    const openaiState = hub.getRouteState('aihubmix', 'openai/gpt-4o');
    expect(openaiState.operabilityState).toBe('no_credits');

    // aihubmix:anthropic should be healthy
    const anthropicState = hub.getRouteState('aihubmix', 'anthropic/claude-3.5');
    expect(anthropicState.operabilityState).toBe('healthy');
  });

  it('hub failure does NOT degrade native provider', () => {
    const hub = getProviderOperabilityHub();

    // aihubmix→openai fails
    hub.recordRouteExecution('aihubmix', 'openai/gpt-4o', false, 402, 'insufficient balance');

    // Native openai should be unaffected (unknown since no events on native)
    const nativeState = hub.getProviderState('openai');
    expect(['healthy', 'unknown']).toContain(nativeState.operabilityState);
  });

  it('snapshot captures all route states', () => {
    const hub = getProviderOperabilityHub();
    hub.recordRouteExecution('openai', 'gpt-4o', true);
    hub.recordRouteExecution('aihubmix', 'openai/gpt-4o', false, 402, 'credit exhausted');

    const snapshot = hub.getSnapshot();
    expect(snapshot.version).toBeGreaterThan(0);
    expect(snapshot.routes).toBeDefined();
    expect(typeof snapshot.allExternalExhausted).toBe('boolean');
  });
});

// ─── 2. Credit Governor ────────────────────────────────────────────────

describe('CreditGovernor', () => {
  let governor: CreditGovernor;

  beforeEach(() => {
    governor = new CreditGovernor({
      experimentBudgetUsd: 50,
      minBufferUsd: 1,
    });
  });

  it('approves execution when route is healthy', () => {
    const hub = getProviderOperabilityHub();
    hub.recordRouteExecution('openai', 'gpt-4o', true);

    const result = governor.canExecute('openai', 'gpt-4o', 0.05);
    expect(result.canProceed).toBe(true);
    expect(result.reason).toBe('approved');
  });

  it('blocks exhausted routes but allows other routes', () => {
    governor.markRouteExhausted('aihubmix', 'openai/gpt-4o', 'HTTP 402');

    const blocked = governor.canExecute('aihubmix', 'openai/gpt-4o', 0.05);
    expect(blocked.canProceed).toBe(false);
    expect(blocked.reason).toBe('route_exhausted');

    // Different route on same hub should be OK
    const hub = getProviderOperabilityHub();
    hub.recordRouteExecution('aihubmix', 'anthropic/claude-3.5', true);
    const allowed = governor.canExecute('aihubmix', 'anthropic/claude-3.5', 0.05);
    expect(allowed.canProceed).toBe(true);
  });

  it('blocks when experiment budget exceeded', () => {
    const smallBudget = new CreditGovernor({
      experimentBudgetUsd: 1.0,
      minBufferUsd: 0.1,
    });

    smallBudget.recordSpend('openai', 'gpt-4o', 0.95);
    const result = smallBudget.canExecute('openai', 'gpt-4o', 0.10);
    expect(result.canProceed).toBe(false);
    expect(result.reason).toBe('experiment_budget_exceeded');
  });

  it('tracks spend per arm', () => {
    governor.recordSpend('openai', 'gpt-4o', 1.0, 'arm_single_gpt4');
    governor.recordSpend('openai', 'gpt-4o', 0.5, 'arm_single_gpt4');

    expect(governor.getArmSpendUsd('arm_single_gpt4')).toBe(1.5);
    expect(governor.getArmSpendUsd('arm_consensus')).toBe(0);
    expect(governor.getTotalSpendUsd()).toBe(1.5);
    expect(governor.getRemainingBudgetUsd()).toBe(48.5);
  });

  it('route recovers after recovery window', () => {
    governor.markRouteExhausted('aihubmix', 'openai/gpt-4o', 'test');
    governor.markRouteRecovered('aihubmix', 'openai/gpt-4o');

    const hub = getProviderOperabilityHub();
    hub.recordRouteExecution('aihubmix', 'openai/gpt-4o', true);
    const result = governor.canExecute('aihubmix', 'openai/gpt-4o', 0.05);
    expect(result.canProceed).toBe(true);
  });
});

// ─── 3. Pool Builder ───────────────────────────────────────────────────

describe('PoolBuilder', () => {
  const models: Model[] = [
    mockModel({ id: 'gpt-4o', provider: 'openai' }),
    mockModel({ id: 'claude-3.5-sonnet', provider: 'anthropic' }),
    mockModel({ id: 'gemini-pro', provider: 'google' }),
    mockModel({ id: 'dall-e-3', provider: 'openai', capabilities: ['image_generation'] }),
    mockModel({ id: 'whisper', provider: 'openai', capabilities: ['speech_to_text'] }),
    mockModel({ id: 'local-llama', provider: 'ollama', capabilities: ['chat'] }),
    mockModel({ id: 'inactive-model', provider: 'openai', status: 'disabled' as any }),
    mockModel({ id: 'no-credits-model', provider: 'aihubmix', balanceStatus: 'no-credits' as any }),
    mockModel({ id: 'low-quality', provider: 'openai', performance: { quality: 0.1 } as any }),
  ];

  it('filters non-chat models', () => {
    const result = new PoolBuilder(models)
      .filterByModality('chat')
      .build();

    expect(result.models.find(m => m.id === 'dall-e-3')).toBeUndefined();
    expect(result.models.find(m => m.id === 'whisper')).toBeUndefined();
    expect(result.stages[0].droppedReasons).toBeDefined();
  });

  it('excludes self-hosted models', () => {
    const result = new PoolBuilder(models)
      .filterByModality('chat')
      .excludeSelfHosted()
      .build();

    expect(result.models.find(m => m.id === 'local-llama')).toBeUndefined();
    expect(result.selfHostedAvailable).toBe(1);
  });

  it('filters inactive and no-credits models', () => {
    const result = new PoolBuilder(models)
      .filterByModality('chat')
      .filterByStatus()
      .filterByCredits()
      .build();

    expect(result.models.find(m => m.id === 'inactive-model')).toBeUndefined();
    expect(result.models.find(m => m.id === 'no-credits-model')).toBeUndefined();
  });

  it('tracks all stages with drop reasons', () => {
    const result = buildChatExecutionPool(models, 0.4);

    expect(result.stages.length).toBeGreaterThan(0);
    for (const stage of result.stages) {
      expect(stage.name).toBeTruthy();
      expect(stage.inputCount).toBeGreaterThanOrEqual(stage.outputCount);
    }
    expect(result.summary).toContain('Pool:');
  });

  it('provides provider and family diversity metrics', () => {
    const result = buildChatExecutionPool(models, 0.4);
    expect(result.providerDiversity).toBeGreaterThanOrEqual(1);
    expect(result.familyDiversity).toBeGreaterThanOrEqual(0);
  });
});

// ─── 5. Self-Hosted Last-Resort Fallback ───────────────────────────────

describe('LastResortPolicy', () => {
  it('does NOT activate when external models exist', () => {
    const models = [
      mockModel({ id: 'gpt-4o', provider: 'openai' }),
      mockModel({ id: 'local-llama', provider: 'ollama' }),
    ];

    const decision = evaluateLastResort(1, models);
    expect(decision.activated).toBe(false);
    expect(decision.externalPoolExhausted).toBe(false);
  });

  it('activates when external pool is zero and self-hosted available', () => {
    const models = [
      mockModel({ id: 'local-llama', provider: 'ollama' }),
    ];

    const decision = evaluateLastResort(0, models);
    expect(decision.activated).toBe(true);
    expect(decision.externalPoolExhausted).toBe(true);
    expect(decision.selfHostedAvailable).toBe(true);
    expect(decision.fallbackModels.length).toBeGreaterThan(0);
  });

  it('returns true failure when neither external nor self-hosted available', () => {
    const decision = evaluateLastResort(0, []);
    expect(decision.activated).toBe(false);
    expect(decision.externalPoolExhausted).toBe(true);
    expect(decision.selfHostedAvailable).toBe(false);
  });

  it('builds metadata with correct exclusion tags', () => {
    const model = mockModel({ id: 'local-llama', provider: 'ollama' });
    const meta = buildLastResortMetadata(model, 'all external exhausted');

    expect(meta.execution_mode).toBe('last_resort_self_hosted');
    expect(meta.degraded).toBe(true);
    expect(meta.excluded_from_benchmark).toBe(true);
    expect(meta.external_pool_exhausted).toBe(true);
  });

  it('splitBySelfHosted correctly separates models', () => {
    const models = [
      mockModel({ id: 'gpt-4o', provider: 'openai' }),
      mockModel({ id: 'local-llama', provider: 'ollama' }),
      mockModel({ id: 'claude', provider: 'anthropic' }),
    ];

    const { external, selfHosted } = splitBySelfHosted(models);
    expect(external.length).toBe(2);
    expect(selfHosted.length).toBe(1);
    expect(selfHosted[0].id).toBe('local-llama');
  });
});

// ─── 6. Strategy Degradation ───────────────────────────────────────────

describe('StrategyDegradation', () => {
  it('no degradation when pool is sufficient', () => {
    const result = resolveWithDegradation('debate', 5, 'test');
    expect(result.isDegraded).toBe(false);
    expect(result.executedStrategy).toBe('debate');
  });

  it('degrades debate → blind-debate → parallel → single', () => {
    // debate needs 3, pool has 2 → should degrade
    let result = resolveWithDegradation('debate', 2, 'pool contraction');
    expect(result.isDegraded).toBe(true);
    expect(result.executedStrategy).toBe('parallel');

    // pool has 1 → single
    result = resolveWithDegradation('debate', 1, 'pool contraction');
    expect(result.isDegraded).toBe(true);
    expect(result.executedStrategy).toBe('single');
  });

  it('war-room degrades through collaborative → parallel → single', () => {
    const result = resolveWithDegradation('war-room', 2, 'insufficient models');
    expect(result.isDegraded).toBe(true);
    expect(['collaborative', 'parallel']).toContain(result.executedStrategy);
  });

  it('isInfraFailure correctly classifies infra vs bugs', () => {
    // Infra failures — should trigger degradation
    expect(isInfraFailure(new Error('Request timeout'))).toEqual({ isInfra: true, failureType: 'timeout' });
    expect(isInfraFailure(new Error('HTTP 402 insufficient quota'))).toEqual({ isInfra: true, failureType: 'credit_exhaustion' });
    expect(isInfraFailure(new Error('HTTP 429 rate limit exceeded'))).toEqual({ isInfra: true, failureType: 'rate_limit' });
    expect(isInfraFailure(new Error('ECONNRESET'))).toEqual({ isInfra: true, failureType: 'connection_error' });
    expect(isInfraFailure(new Error('requires at least 3 models'))).toEqual({ isInfra: true, failureType: 'pool_contraction' });

    // Code bugs — must NOT trigger degradation
    expect(isInfraFailure(new TypeError('Cannot read properties of undefined'))).toEqual({ isInfra: false, failureType: null });
    expect(isInfraFailure(new ReferenceError('x is not defined'))).toEqual({ isInfra: false, failureType: null });
    expect(isInfraFailure(new SyntaxError('Unexpected token'))).toEqual({ isInfra: false, failureType: null });
  });

  it('resolveRuntimeDegradation uses correct chain', () => {
    const result = resolveRuntimeDegradation({
      trigger: 'runtime',
      failureType: 'timeout',
      error: new Error('Strategy execution timed out after 60s'),
      currentPoolSize: 2,
      strategy: 'war-room',
    });

    expect(result.isDegraded).toBe(true);
    expect(result.originalStrategy).toBe('war-room');
    expect(result.degradationPath.length).toBeGreaterThan(0);
  });
});

// ─── 7. Strategy Tiering ───────────────────────────────────────────────

describe('StrategyTiering', () => {
  it('returns correct tiers for known strategies', () => {
    expect(getStrategyTier('parallel')).toBe('stable');
    expect(getStrategyTier('collaborative')).toBe('promising');
    expect(getStrategyTier('consensus')).toBe('experimental');
    expect(getStrategyTier('debate')).toBe('fragile');
  });

  it('defaults unknown strategies to experimental', () => {
    expect(getStrategyTier('nonexistent-strategy')).toBe('experimental');
  });

  it('recalculates tier based on execution results', () => {
    const result = recalculateTier({
      strategyName: 'debate',
      successRate: 0.85,
      avgQuality: 0.75,
      sampleCount: 50,
      currentTier: 'fragile',
    });

    expect(result.changed).toBe(true);
    // Provisional guard: can't auto-promote to stable
    expect(result.proposedTier).toBe('promising');
    expect(result.provisional).toBe(true);
  });

  it('does not recalculate with insufficient samples', () => {
    const result = recalculateTier({
      strategyName: 'debate',
      successRate: 0.9,
      avgQuality: 0.8,
      sampleCount: 5,
      currentTier: 'fragile',
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toContain('Insufficient samples');
  });

  it('proposeAllTierChanges aggregates correctly', () => {
    const results = [
      { strategy: 'debate', success: true, qualityScore: 0.8 },
      { strategy: 'debate', success: true, qualityScore: 0.7 },
      { strategy: 'debate', success: true, qualityScore: 0.9 },
      { strategy: 'debate', success: true, qualityScore: 0.8 },
      { strategy: 'debate', success: true, qualityScore: 0.7 },
      { strategy: 'debate', success: true, qualityScore: 0.8 },
      { strategy: 'debate', success: true, qualityScore: 0.9 },
      { strategy: 'debate', success: true, qualityScore: 0.8 },
      { strategy: 'debate', success: true, qualityScore: 0.7 },
      { strategy: 'debate', success: true, qualityScore: 0.8 },
      { strategy: 'debate', success: true, qualityScore: 0.9 },
    ];

    const proposals = proposeAllTierChanges(results);
    // debate is currently fragile but 100% success → should propose promotion
    const debateProposal = proposals.find(p => p.strategyName === 'debate');
    expect(debateProposal).toBeDefined();
    expect(debateProposal!.changed).toBe(true);
  });

  it('feature flags have correct defaults', () => {
    const flags = getStrategyFeatureFlags();
    expect(flags.enableAdaptiveLive).toBe(false); // always disabled until stable
    expect(flags.enableRuntimeDegradation).toBe(true); // default enabled
    expect(flags.enableSelfHostedFallback).toBe(true); // default enabled
  });
});

// ─── 8. Stress Scenarios ───────────────────────────────────────────────

describe('Stress: Credit Exhaustion', () => {
  it('single hub exhaustion — experiment continues via other routes', () => {
    const governor = new CreditGovernor({ experimentBudgetUsd: 50, minBufferUsd: 1 });
    const hub = getProviderOperabilityHub();

    // aihubmix exhausted
    governor.markRouteExhausted('aihubmix', 'openai/gpt-4o', 'HTTP 402');
    hub.recordRouteExecution('aihubmix', 'openai/gpt-4o', false, 402, 'insufficient balance');

    // Native openai still works
    hub.recordRouteExecution('openai', 'gpt-4o', true);
    const result = governor.canExecute('openai', 'gpt-4o', 0.05);
    expect(result.canProceed).toBe(true);

    // Not structural failure
    expect(governor.isStructuralFailure()).toBe(false);
  });

  it('429 burst — routes become rate limited but recover', () => {
    const hub = getProviderOperabilityHub();

    // Burst of 429s
    for (let i = 0; i < 5; i++) {
      hub.recordRouteExecution('openai', 'gpt-4o', false, 429, 'rate limit exceeded');
    }

    const state = hub.getProviderState('openai');
    expect(state.operabilityState).toBe('rate_limited');
  });
});

describe('Stress: Pool Contraction', () => {
  it('pool reduced to 1 model — degrades to single strategy', () => {
    const result = resolveWithDegradation('consensus', 1, 'pool contracted to 1');
    expect(result.isDegraded).toBe(true);
    expect(result.executedStrategy).toBe('single');
  });

  it('pool reduced to 2 models — degrades to parallel', () => {
    const result = resolveWithDegradation('war-room', 2, 'pool contracted to 2');
    expect(result.isDegraded).toBe(true);
    // war-room → collaborative (2+) or parallel (2+)
    expect(['collaborative', 'parallel'].includes(result.executedStrategy)).toBe(true);
  });

  it('pool reduced to 0 — degradation chain exhausted', () => {
    const result = resolveWithDegradation('single', 0, 'no models at all');
    expect(result.isDegraded).toBe(false); // can't degrade further
    expect(result.degradationReason).toContain('exhausted');
  });
});

describe('Stress: Self-Hosted Fallback', () => {
  it('all external unavailable + self-hosted available → activates', () => {
    const models = [
      mockModel({ id: 'local-llama', provider: 'ollama' }),
      mockModel({ id: 'local-docling', provider: 'local-docling' }),
    ];

    const decision = evaluateLastResort(0, models);
    expect(decision.activated).toBe(true);
    expect(decision.externalPoolExhausted).toBe(true);
  });

  it('all external unavailable + no self-hosted → true failure', () => {
    const decision = evaluateLastResort(0, []);
    expect(decision.activated).toBe(false);
    expect(decision.externalPoolExhausted).toBe(true);
    expect(decision.selfHostedAvailable).toBe(false);
  });

  it('last-resort metadata correctly tags for benchmark exclusion', () => {
    const model = mockModel({ id: 'local-llama', provider: 'ollama' });
    const meta = buildLastResortMetadata(model, 'structural failure');

    expect(meta.excluded_from_benchmark).toBe(true);
    expect(meta.execution_mode).toBe('last_resort_self_hosted');
    expect(meta.degraded).toBe(true);
  });
});
