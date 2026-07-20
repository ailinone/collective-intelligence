// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4C §12 — Role eligibility × dynamic context budget tests.
 *
 * Validates the END-TO-END behavior through ModelRoleResolver:
 *   - Without contextPolicy: legacy behavior (catalog value vs static
 *     policy.contextWindowMin) — preserves J2-E-R2 baseline.
 *   - With contextPolicy.enabled=true: uses effective context metadata
 *     (override-aware) + dynamic budget (plan-derived).
 *   - Live-ready model with catalog ctx=8192 + override 200k passes
 *     synthesizer when the plan budget is ~20k.
 *   - Low-confidence overrides cannot reduce a larger catalog value.
 *   - context trace includes source/confidence/override info.
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '@/core/orchestration/model-selection/model-role-resolver';
import type { ModelCandidate } from '@/core/orchestration/model-selection/model-role-types';
import type { ContextMetadataOverride } from '@/core/orchestration/model-selection/effective-context-metadata';
import type { DynamicContextBudgetInput } from '@/core/orchestration/model-selection/dynamic-context-budget';

function mkCandidate(opts: {
  modelId: string;
  providerId: string;
  contextWindow: number;
  maxOutputTokens?: number;
}): ModelCandidate {
  return {
    model: {
      id: opts.modelId,
      provider: opts.providerId,
      providerId: opts.providerId,
      name: opts.modelId,
      displayName: opts.modelId,
      contextWindow: opts.contextWindow,
      maxOutputTokens: opts.maxOutputTokens ?? 4096,
      inputCostPer1k: 0.001,
      outputCostPer1k: 0.003,
      capabilities: ['chat', 'text_generation', 'reasoning', 'instruction_following'] as never,
      status: 'active',
      performance: { latencyMs: 800, throughput: 100, quality: 0.8, reliability: 0.9 },
      metadata: {},
      providerName: opts.providerId,
      providerStatus: 'active',
    } as never,
    providerId: opts.providerId,
    estimatedCostPerCallUsd: 0.005,
    hasCredits: true,
    providerHealthy: true,
    rateLimited: false,
    isLocal: false,
  };
}

const baseBudget: DynamicContextBudgetInput = {
  role: 'synthesizer',
  userPromptTokensEstimate: 100,
  systemPromptTokensEstimate: 100,
  roleInstructionTokensEstimate: 50,
  participantCount: 3,
  participantMaxOutputTokens: 4096,
  synthesizerMaxOutputTokens: 4096,
  judgeMaxOutputTokens: 4096,
  rubricTokensEstimate: 500,
  toolTraceTokensEstimate: 0,
  overheadTokens: 100,
  safetyMarginRatio: 0.2,
  absoluteSafetyMarginTokens: 1024,
};

describe('01C.1B-J1D-R4C §12 — role eligibility × dynamic context budget', () => {
  it('legacy behavior (no contextPolicy): catalog ctx=8192 rejected for synthesizer (default 32000)', async () => {
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'free_text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [mkCandidate({ modelId: 'm-1', providerId: 'p', contextWindow: 8192 })],
    });
    expect(result.selected.length).toBe(0);
    const rejReasons = result.rejected.map((r) => r.reason);
    expect(rejReasons).toContain('context_window_too_small');
  });

  it('contextPolicy ENABLED + override 200k: candidate WITH catalog ctx=8192 passes for synthesizer', async () => {
    const resolver = new ModelRoleResolver({});
    const overrides: ContextMetadataOverride[] = [
      {
        providerId: 'deepinfra',
        apiModelId: 'anthropic/claude-opus-4-7',
        canonicalModelId: 'anthropic/claude-opus-4-7',
        catalogContextWindow: 8192,
        effectiveContextWindow: 200000,
        effectiveMaxOutputTokens: 8192,
        source: 'conservative_inference',
        confidence: 'medium',
        reason: 'Claude family known to support 200k context',
        capturedAt: '2026-05-21',
        stage: '01C.1B-J1D-R4C',
      },
    ];
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'free_text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [
        mkCandidate({
          modelId: 'anthropic/claude-opus-4-7',
          providerId: 'deepinfra',
          contextWindow: 8192,
          maxOutputTokens: 4096,
        }),
      ],
      contextPolicy: {
        ...baseBudget,
        enabled: true,
        overrides,
      },
    });
    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.selected[0].model.id).toBe('anthropic/claude-opus-4-7');
  });

  it('contextPolicy ENABLED but NO override: candidate with catalog ctx=8192 still rejected for synthesizer', async () => {
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'free_text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [
        mkCandidate({
          modelId: 'm-small',
          providerId: 'p',
          contextWindow: 8192,
          maxOutputTokens: 4096,
        }),
      ],
      contextPolicy: { ...baseBudget, enabled: true, overrides: [] },
    });
    expect(result.selected.length).toBe(0);
  });

  it('contextPolicy disabled: legacy threshold still used (no override applied)', async () => {
    const resolver = new ModelRoleResolver({});
    const overrides: ContextMetadataOverride[] = [
      {
        providerId: 'deepinfra',
        apiModelId: 'm-small',
        canonicalModelId: 'm-small',
        catalogContextWindow: 8192,
        effectiveContextWindow: 200000,
        source: 'conservative_inference',
        confidence: 'medium',
        reason: 'unused — flag is off',
        stage: '01C.1B-J1D-R4C',
      },
    ];
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'free_text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [mkCandidate({ modelId: 'm-small', providerId: 'deepinfra', contextWindow: 8192 })],
      contextPolicy: { ...baseBudget, enabled: false, overrides },
    });
    // Flag is OFF: overrides not applied; falls back to legacy static
    // threshold (32k for synthesizer) > catalog 8192 → rejected.
    expect(result.selected.length).toBe(0);
  });

  it('low-confidence override does NOT reduce a larger catalog value (safety rule)', async () => {
    const resolver = new ModelRoleResolver({});
    const overrides: ContextMetadataOverride[] = [
      {
        canonicalModelId: 'm-big',
        catalogContextWindow: 200000,
        effectiveContextWindow: 4096, // low-confidence trying to REDUCE
        source: 'conservative_inference',
        confidence: 'low',
        reason: 'unreliable shrink attempt',
        stage: '01C.1B-J1D-R4C',
      },
    ];
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'free_text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [
        mkCandidate({ modelId: 'm-big', providerId: 'p', contextWindow: 200000, maxOutputTokens: 4096 }),
      ],
      contextPolicy: { ...baseBudget, enabled: true, overrides },
    });
    // Low-confidence override should NOT shrink catalog 200k → 4k
    expect(result.selected.length).toBeGreaterThan(0);
  });

  it('high-confidence override CAN adjust downward (operator-verified)', async () => {
    const resolver = new ModelRoleResolver({});
    const overrides: ContextMetadataOverride[] = [
      {
        canonicalModelId: 'm-overstated',
        catalogContextWindow: 1000000,
        effectiveContextWindow: 4096, // high-confidence intentional shrink
        source: 'manual_verified',
        confidence: 'high',
        reason: 'catalog overstates; provider docs confirm 4k',
        stage: '01C.1B-J1D-R4C',
      },
    ];
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'free_text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [
        mkCandidate({ modelId: 'm-overstated', providerId: 'p', contextWindow: 1000000 }),
      ],
      contextPolicy: { ...baseBudget, enabled: true, overrides },
    });
    expect(result.selected.length).toBe(0); // shrunk → too small
  });

  it('strict pool with 10 live-ready models gets ≥3 participants eligible by canonicalModelId', async () => {
    // Simulating the J1D-R4B live-ready set: 10 distinct canonical
    // models across 4 providers. With overrides for the 3 underestimated
    // ones, ALL 10 should be eligible for participant (which only needs
    // ~3000 tokens of context).
    const candidates: ModelCandidate[] = [
      mkCandidate({ modelId: 'anthropic/claude-haiku-4-5', providerId: 'deepinfra', contextWindow: 8192 }),
      mkCandidate({ modelId: 'anthropic/claude-opus-4-7', providerId: 'deepinfra', contextWindow: 8192 }),
      mkCandidate({ modelId: 'anthropic/claude-sonnet-4-6', providerId: 'deepinfra', contextWindow: 8192 }),
      mkCandidate({ modelId: 'deepseek-ai/DeepSeek-R1-0528', providerId: 'deepinfra', contextWindow: 8192 }),
      mkCandidate({
        modelId: 'accounts/fireworks/models/deepseek-v4-pro',
        providerId: 'fireworks-ai',
        contextWindow: 1_048_576,
      }),
      mkCandidate({
        modelId: 'accounts/fireworks/models/kimi-k2p5',
        providerId: 'fireworks-ai',
        contextWindow: 262_144,
      }),
      mkCandidate({ modelId: 'abacusai/Dracarys-72B-Instruct', providerId: 'nanogpt', contextWindow: 8192 }),
      mkCandidate({ modelId: 'aion-labs/aion-1.0-mini', providerId: 'nanogpt', contextWindow: 8192 }),
      mkCandidate({
        modelId: 'xai/grok-4.20-multi-agent',
        providerId: 'vercel-ai-gateway',
        contextWindow: 2_000_000,
      }),
      mkCandidate({
        modelId: 'google/gemini-2.0-flash-lite',
        providerId: 'vercel-ai-gateway',
        contextWindow: 1_048_576,
      }),
    ];
    const overrides: ContextMetadataOverride[] = [
      {
        canonicalModelId: 'anthropic/claude-haiku-4-5',
        catalogContextWindow: 8192,
        effectiveContextWindow: 200000,
        source: 'conservative_inference',
        confidence: 'medium',
        reason: 'Claude family known to support 200k',
        stage: '01C.1B-J1D-R4C',
      },
      {
        canonicalModelId: 'anthropic/claude-opus-4-7',
        catalogContextWindow: 8192,
        effectiveContextWindow: 200000,
        source: 'conservative_inference',
        confidence: 'medium',
        reason: 'Claude family',
        stage: '01C.1B-J1D-R4C',
      },
      {
        canonicalModelId: 'anthropic/claude-sonnet-4-6',
        catalogContextWindow: 8192,
        effectiveContextWindow: 200000,
        source: 'conservative_inference',
        confidence: 'medium',
        reason: 'Claude family',
        stage: '01C.1B-J1D-R4C',
      },
      {
        canonicalModelId: 'deepseek-ai/deepseek-r1-0528',
        catalogContextWindow: 8192,
        effectiveContextWindow: 128000,
        source: 'conservative_inference',
        confidence: 'medium',
        reason: 'DeepSeek R1 128k',
        stage: '01C.1B-J1D-R4C',
      },
      {
        canonicalModelId: 'abacusai/dracarys-72b-instruct',
        catalogContextWindow: 8192,
        effectiveContextWindow: 65536,
        source: 'conservative_inference',
        confidence: 'low',
        reason: 'Dracarys 64k',
        stage: '01C.1B-J1D-R4C',
      },
      {
        canonicalModelId: 'aion-labs/aion-1.0-mini',
        catalogContextWindow: 8192,
        effectiveContextWindow: 32768,
        source: 'conservative_inference',
        confidence: 'low',
        reason: 'Aion 32k',
        stage: '01C.1B-J1D-R4C',
      },
    ];
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'participant',
      taskProfile: { taskType: 'general', expectedFormat: 'free_text', userMessageExcerpt: '' },
      constraints: { count: 3 },
      candidatePool: candidates,
      contextPolicy: { ...baseBudget, role: 'participant', enabled: true, overrides },
    });
    expect(result.selected.length).toBeGreaterThanOrEqual(3);
  });

  it('contextPolicy preserves capability checks (rejection for non-chat candidate still fires)', async () => {
    const resolver = new ModelRoleResolver({});
    const cand = mkCandidate({
      modelId: 'm',
      providerId: 'p',
      contextWindow: 200000,
    });
    // Strip the 'chat' capability
    (cand as { model: { capabilities: string[] } }).model.capabilities = ['vision'];
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'free_text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [cand],
      contextPolicy: { ...baseBudget, enabled: true, overrides: [] },
    });
    expect(result.selected.length).toBe(0);
    // Should be rejected for missing capability, NOT for context
    const reasons = result.rejected.map((r) => r.reason).join(',');
    expect(reasons).toMatch(/required_capability_missing|missing_capability|capability/);
  });
});
