// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test fixtures for ModelRoleResolver tests.
 *
 * All model identifiers here are intentionally GENERIC — `voter-a`,
 * `provider-x`, etc. — so the no-hardcoded-models test stays green
 * even when this fixture file is scanned.
 */
import type { Model, ModelCapability } from '@/types';
import type { ModelCandidate } from '../model-role-types';

export function makeModel(overrides: Partial<Model> & { id: string }): Model {
  return {
    id: overrides.id,
    providerId: overrides.providerId ?? `provider-${overrides.id}`,
    provider: overrides.provider ?? `provider-${overrides.id}`,
    name: overrides.name ?? overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    contextWindow: overrides.contextWindow ?? 128000,
    maxOutputTokens: overrides.maxOutputTokens ?? 4096,
    inputCostPer1k: overrides.inputCostPer1k ?? 0.001,
    outputCostPer1k: overrides.outputCostPer1k ?? 0.002,
    capabilities: (overrides.capabilities ?? ['chat', 'text_generation']) as ModelCapability[],
    capabilityUris: overrides.capabilityUris,
    performance:
      overrides.performance ?? {
        latencyMs: 1000,
        throughput: 100,
        quality: 0.9,
        reliability: 0.95,
      },
    status: overrides.status ?? 'active',
    balanceStatus: overrides.balanceStatus ?? 'has-credits',
    inventoryRole: overrides.inventoryRole,
    metadata: overrides.metadata,
    tags: overrides.tags,
    specializations: overrides.specializations,
  };
}

export function makeCandidate(
  overrides: Partial<ModelCandidate> & { id: string },
): ModelCandidate {
  const model = overrides.model ?? makeModel({ id: overrides.id });
  return {
    model,
    providerId: overrides.providerId ?? model.provider,
    providerHealthy: overrides.providerHealthy ?? true,
    hasCredits: overrides.hasCredits ?? true,
    rateLimited: overrides.rateLimited ?? false,
    isLocal: overrides.isLocal ?? false,
    estimatedCostPerCallUsd: overrides.estimatedCostPerCallUsd ?? 0.005,
  };
}

/**
 * Pool tailored for full ConsensusExecutionPlanner tests:
 *   - 3 participant-grade candidates with diverse providers
 *   - 1 synthesizer-grade candidate (large context, distinct provider)
 *   - 1 judge-grade candidate (JSON capable, low cost, distinct provider)
 *   - 1 local candidate
 *   - 1 no-credits candidate (negative case)
 */
export function fullConsensusPool(): readonly ModelCandidate[] {
  const base = diversePool();
  return [
    ...base,
    makeCandidate({
      id: 'synthesizer-grade',
      model: makeModel({
        id: 'synthesizer-grade',
        provider: 'provider-synth',
        capabilities: [
          'chat',
          'text_generation',
          'reasoning',
          'instruction_following',
        ] as ModelCapability[],
        contextWindow: 200000,
        performance: { latencyMs: 1500, throughput: 90, quality: 0.93, reliability: 0.95 },
        inputCostPer1k: 0.003,
        outputCostPer1k: 0.012,
      }),
    }),
    makeCandidate({
      id: 'judge-grade',
      estimatedCostPerCallUsd: 0.0006,
      model: makeModel({
        id: 'judge-grade',
        provider: 'provider-judge',
        capabilities: [
          'chat',
          'text_generation',
          'json_mode',
          'function_calling',
          'reasoning',
          'instruction_following',
        ] as ModelCapability[],
        contextWindow: 64000,
        performance: { latencyMs: 500, throughput: 250, quality: 0.86, reliability: 0.94 },
        inputCostPer1k: 0.0001,
        outputCostPer1k: 0.0005,
      }),
    }),
  ];
}

/**
 * 5-candidate pool with diverse providers, capabilities, prices, and
 * a clear quality ordering for deterministic tests.
 */
export function diversePool(): readonly ModelCandidate[] {
  return [
    makeCandidate({
      id: 'high-quality-a',
      model: makeModel({
        id: 'high-quality-a',
        provider: 'provider-x',
        capabilities: ['chat', 'text_generation', 'reasoning', 'function_calling', 'json_mode'] as ModelCapability[],
        contextWindow: 200000,
        performance: { latencyMs: 1500, throughput: 80, quality: 0.95, reliability: 0.96 },
        inputCostPer1k: 0.005,
        outputCostPer1k: 0.015,
      }),
    }),
    makeCandidate({
      id: 'mid-quality-b',
      model: makeModel({
        id: 'mid-quality-b',
        provider: 'provider-y',
        capabilities: ['chat', 'text_generation', 'reasoning', 'code_generation'] as ModelCapability[],
        contextWindow: 128000,
        performance: { latencyMs: 900, throughput: 130, quality: 0.85, reliability: 0.92 },
        inputCostPer1k: 0.002,
        outputCostPer1k: 0.006,
      }),
    }),
    makeCandidate({
      id: 'cheap-c',
      model: makeModel({
        id: 'cheap-c',
        provider: 'provider-z',
        capabilities: ['chat', 'text_generation', 'function_calling', 'json_mode'] as ModelCapability[],
        contextWindow: 64000,
        performance: { latencyMs: 500, throughput: 250, quality: 0.7, reliability: 0.9 },
        inputCostPer1k: 0.0001,
        outputCostPer1k: 0.0004,
      }),
    }),
    makeCandidate({
      id: 'local-runner',
      isLocal: true,
      model: makeModel({
        id: 'local-runner',
        provider: 'ollama',
        capabilities: ['chat', 'text_generation', 'reasoning'] as ModelCapability[],
        contextWindow: 32000,
        performance: { latencyMs: 300, throughput: 60, quality: 0.6, reliability: 0.85 },
        inputCostPer1k: 0,
        outputCostPer1k: 0,
      }),
      estimatedCostPerCallUsd: 0,
    }),
    makeCandidate({
      id: 'no-credits-d',
      hasCredits: false,
      model: makeModel({
        id: 'no-credits-d',
        provider: 'provider-broken',
        capabilities: ['chat', 'text_generation'] as ModelCapability[],
        contextWindow: 128000,
        performance: { latencyMs: 800, throughput: 100, quality: 0.88, reliability: 0.9 },
      }),
    }),
  ];
}
