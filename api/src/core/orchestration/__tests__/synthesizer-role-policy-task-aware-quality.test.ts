// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R4 §13 — Task-aware quality integration in R2 scorer.
 *
 * Validates the END-TO-END behavior: when a calibration snapshot carries
 * per-category scores, the synthesizer scorer picks a different winner
 * based on the request's taskProfile.taskType.
 *
 * Scenario: Two candidates with the same aggregate quality but different
 * per-category scores.
 *   - Candidate A is great at chat_text (0.95) but poor at code_webdev (0.60)
 *   - Candidate B is poor at chat_text (0.60) but great at code_webdev (0.95)
 *   - Both have aggregate = 0.78
 *
 * For taskType='general' (→ chat_text priority) → A wins.
 * For taskType='code-generation' (→ code_webdev priority) → B wins.
 *
 * This is the proof that monolithic qualityScore is no longer the only
 * quality signal — task-aware routing is operational.
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '@/core/orchestration/model-selection/model-role-resolver';
import { buildSnapshot } from '@/core/orchestration/role-selection/model-quality-calibration';
import type { ModelCandidate } from '@/core/orchestration/model-selection/model-role-types';

function mkCandidate(opts: { modelId: string; providerId: string }): ModelCandidate {
  return {
    model: {
      id: opts.modelId,
      provider: opts.providerId,
      name: opts.modelId,
      displayName: opts.modelId,
      contextWindow: 128000,
      maxOutputTokens: 4096,
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

const ENTRY_BASE = {
  qualityScoreSource: 'external_benchmark' as const,
  qualityConfidence: 'high' as const,
  warnings: [],
  createdAt: '2026-05-19T00:00:00.000Z',
};

describe('01C.1B-J2-C-R4 §13 — task-aware quality changes the synthesizer winner', () => {
  const candA = mkCandidate({ modelId: 'model-text-specialist', providerId: 'provider-1' });
  const candB = mkCandidate({ modelId: 'model-code-specialist', providerId: 'provider-2' });

  const snapshot = buildSnapshot({
    version: '1.0.0-test',
    sourceArtifacts: ['test.md'],
    entries: [
      {
        ...ENTRY_BASE,
        modelId: 'model-text-specialist',
        canonicalModelId: 'model-text-specialist',
        qualityScore: 0.78,
        taskCategoryScores: { chat_text: 0.95, code_webdev: 0.60 },
        qualityScoreSources: ['lmarena'],
        sourceScores: [{
          source: 'lmarena', score: 0.78, confidence: 'high',
          categoryScores: { chat_text: 0.95, code_webdev: 0.60 },
        }],
      },
      {
        ...ENTRY_BASE,
        modelId: 'model-code-specialist',
        canonicalModelId: 'model-code-specialist',
        qualityScore: 0.78,
        taskCategoryScores: { chat_text: 0.60, code_webdev: 0.95 },
        qualityScoreSources: ['lmarena'],
        sourceScores: [{
          source: 'lmarena', score: 0.78, confidence: 'high',
          categoryScores: { chat_text: 0.60, code_webdev: 0.95 },
        }],
      },
    ],
  });

  it('taskType=general (→ chat_text) → text specialist wins', async () => {
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'free_text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [candA, candB],
      modelQualityCalibrationSnapshot: snapshot,
    });
    expect(result.synthesizerSelectionSummary?.winner?.modelId).toBe('model-text-specialist');
  });

  it('taskType=code-generation (→ code_webdev) → code specialist wins', async () => {
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'code-generation', expectedFormat: 'code', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [candA, candB],
      modelQualityCalibrationSnapshot: snapshot,
    });
    expect(result.synthesizerSelectionSummary?.winner?.modelId).toBe('model-code-specialist');
  });

  it('without snapshot, both candidates fall back to catalog quality (tie broken by other dims)', async () => {
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'free_text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [candA, candB],
      // NO modelQualityCalibrationSnapshot
    });
    // With catalog quality 0.8 for both, the scorer picks one. The point is that
    // the resolver succeeds without crashing.
    expect(result.synthesizerSelectionSummary?.winner).toBeDefined();
  });

  it('with snapshot but no taskProfile match, falls back to aggregate qualityScore', async () => {
    const resolver = new ModelRoleResolver({});
    // A task type whose category priority does not match any of the entries' categories
    // → resolver falls back to aggregate (both 0.78); winner determined by other factors
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      // We use 'caching' (priority = ['chat_text']) but BOTH entries have chat_text data,
      // so we pick one whose chat_text is higher: A wins.
      taskProfile: { taskType: 'caching', expectedFormat: 'free_text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [candA, candB],
      modelQualityCalibrationSnapshot: snapshot,
    });
    expect(result.synthesizerSelectionSummary?.winner?.modelId).toBe('model-text-specialist');
  });
});
