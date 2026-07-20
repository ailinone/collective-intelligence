// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2 §17.1 — Quality snapshot integration in synthesizer scoring.
 *
 * Proves:
 *   - high-quality single-provider entry (in snapshot) competes legitimately
 *   - low-quality multi-provider entry (in snapshot) loses despite coverage
 *   - absence of snapshot keeps fallback behavior
 *   - placeholder snapshot entry is marked correctly
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '@/core/orchestration/model-selection/model-role-resolver';
import { buildSnapshot } from '@/core/orchestration/role-selection/model-quality-calibration';
import type { ModelCandidate } from '@/core/orchestration/model-selection/model-role-types';

function mk(opts: {
  id: string;
  providerId: string;
  quality?: number;
  cost?: number;
}): ModelCandidate {
  return {
    model: {
      id: opts.id,
      provider: opts.providerId,
      name: opts.id,
      displayName: opts.id,
      contextWindow: 128000,
      maxOutputTokens: 4096,
      inputCostPer1k: 0.001,
      outputCostPer1k: 0.003,
      capabilities: ['chat', 'text_generation', 'reasoning', 'instruction_following'] as never,
      status: 'active',
      performance: {
        latencyMs: 800, throughput: 100,
        quality: opts.quality ?? 0.8, reliability: 0.9,
      },
      metadata: {},
      providerName: opts.providerId,
      providerStatus: 'active',
    } as never,
    providerId: opts.providerId,
    estimatedCostPerCallUsd: opts.cost ?? 0.005,
    hasCredits: true,
    providerHealthy: true,
    rateLimited: false,
    isLocal: false,
    score: 0,
  };
}

describe('01C.1B-J2 §17.1 — quality snapshot integration', () => {
  it('snapshot quality OVERRIDES catalog placeholder quality', async () => {
    // Catalog says q=0.8 (placeholder). Snapshot says q=0.95 (benchmarked).
    // The scorer must use 0.95.
    const pool = [
      mk({ id: 'specialized-model', providerId: 'p1', quality: 0.8 }),
      mk({ id: 'commodity-model', providerId: 'p2', quality: 0.8 }),
    ];
    const snapshot = buildSnapshot({
      version: '1.0.0',
      sourceArtifacts: ['test'],
      entries: [
        {
          modelId: 'specialized-model',
          qualityScore: 0.95,
          qualityScoreSource: 'internal_benchmark',
          qualityConfidence: 'high',
          warnings: [],
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: pool,
      modelQualityCalibrationSnapshot: snapshot,
    });
    // specialized-model with snapshot q=0.95 should beat commodity at catalog q=0.8
    expect(result.selected[0]?.model.id).toBe('specialized-model');
    expect(result.synthesizerSelectionSummary?.qualitySnapshotMetadata?.candidatesMatched).toBe(1);
    expect(result.synthesizerSelectionSummary?.qualitySnapshotMetadata?.winnerQualityScoreSource).toBe('internal_benchmark');
  });

  it('high-quality single-provider in snapshot beats multi-provider with low snapshot quality', async () => {
    const pool = [
      mk({ id: 'specialized-single', providerId: 'p1', quality: 0.8 }),
      mk({ id: 'commodity-multi', providerId: 'p2', quality: 0.8 }),
      mk({ id: 'commodity-multi', providerId: 'p3', quality: 0.8 }),
      mk({ id: 'commodity-multi', providerId: 'p4', quality: 0.8 }),
      mk({ id: 'commodity-multi', providerId: 'p5', quality: 0.8 }),
      mk({ id: 'commodity-multi', providerId: 'p6', quality: 0.8 }),
    ];
    const snapshot = buildSnapshot({
      version: '1.0.0',
      sourceArtifacts: [],
      entries: [
        {
          modelId: 'specialized-single',
          qualityScore: 0.98,
          qualityScoreSource: 'internal_benchmark',
          qualityConfidence: 'high',
          warnings: [],
          createdAt: new Date().toISOString(),
        },
        {
          modelId: 'commodity-multi',
          qualityScore: 0.62, // just above floor
          qualityScoreSource: 'internal_benchmark',
          qualityConfidence: 'high',
          warnings: [],
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: pool,
      modelQualityCalibrationSnapshot: snapshot,
    });
    // With quality diff 0.98 vs 0.62 = 0.36 × 0.40 weight = +0.144,
    // and coverage diff log(6)/log(21) × 0.20 = +0.118 for multi,
    // specialized-single WINS by ~0.026
    expect(result.selected[0]?.model.id).toBe('specialized-single');
  });

  it('absence of snapshot uses fallback (catalog) quality', async () => {
    const pool = [
      mk({ id: 'model-a', providerId: 'p1', quality: 0.8 }),
      mk({ id: 'model-b', providerId: 'p2', quality: 0.9 }),
    ];
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: pool,
      // NO snapshot
    });
    // Catalog quality differentiates: 0.9 beats 0.8
    expect(result.selected[0]?.model.id).toBe('model-b');
    // qualitySnapshotMetadata should NOT be in summary
    expect(result.synthesizerSelectionSummary?.qualitySnapshotMetadata).toBeUndefined();
  });

  it('snapshot with placeholder entry uses placeholder quality (=catalog value) + marks source', async () => {
    const pool = [mk({ id: 'placeholder-model', providerId: 'p1', quality: 0.8 })];
    const snapshot = buildSnapshot({
      version: '1.0.0',
      sourceArtifacts: [],
      entries: [
        {
          modelId: 'placeholder-model',
          qualityScore: 0.8, // SAME as catalog
          qualityScoreSource: 'placeholder',
          qualityConfidence: 'placeholder',
          warnings: ['no real benchmark yet'],
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: pool,
      modelQualityCalibrationSnapshot: snapshot,
    });
    expect(result.synthesizerSelectionSummary?.qualitySnapshotMetadata?.winnerQualityScoreSource).toBe('placeholder');
    expect(result.synthesizerSelectionSummary?.qualitySnapshotMetadata?.winnerQualityConfidence).toBe('placeholder');
  });

  it('candidates not in snapshot fall back to catalog placeholder + counted separately', async () => {
    const pool = [
      mk({ id: 'in-snapshot', providerId: 'p1' }),
      mk({ id: 'not-in-snapshot', providerId: 'p2' }),
    ];
    const snapshot = buildSnapshot({
      version: '1.0.0',
      sourceArtifacts: [],
      entries: [
        {
          modelId: 'in-snapshot',
          qualityScore: 0.85,
          qualityScoreSource: 'internal_benchmark',
          qualityConfidence: 'high',
          warnings: [],
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: pool,
      modelQualityCalibrationSnapshot: snapshot,
    });
    const meta = result.synthesizerSelectionSummary?.qualitySnapshotMetadata;
    expect(meta?.candidatesMatched).toBe(1);
    expect(meta?.candidatesFallbackToPlaceholder).toBe(1);
    expect(meta?.snapshotEntryCount).toBe(1);
  });

  it('snapshot only affects synthesizer role, NOT participant', async () => {
    const pool = [
      mk({ id: 'snapshot-favored', providerId: 'p1', quality: 0.8 }),
      mk({ id: 'catalog-favored', providerId: 'p2', quality: 0.9 }),
    ];
    const snapshot = buildSnapshot({
      version: '1.0.0',
      sourceArtifacts: [],
      entries: [
        {
          modelId: 'snapshot-favored',
          qualityScore: 0.99,
          qualityScoreSource: 'internal_benchmark',
          qualityConfidence: 'high',
          warnings: [],
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const resolver = new ModelRoleResolver({});
    // Synthesizer USES snapshot
    const synthResult = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: pool,
      modelQualityCalibrationSnapshot: snapshot,
    });
    expect(synthResult.selected[0]?.model.id).toBe('snapshot-favored');

    // Participant role does NOT use snapshot — falls back to legacy scorer
    const partResult = await resolver.resolve({
      strategyName: 'consensus',
      role: 'participant',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: { count: 1 },
      candidatePool: pool,
      modelQualityCalibrationSnapshot: snapshot,
    });
    // Legacy scorer uses catalog quality: catalog-favored has q=0.9 > 0.8
    expect(partResult.selected[0]?.model.id).toBe('catalog-favored');
  });
});
