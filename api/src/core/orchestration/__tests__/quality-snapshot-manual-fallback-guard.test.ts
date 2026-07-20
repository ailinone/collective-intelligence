// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R4 §17 — Manual / catalog fallback guard test.
 *
 * Premise: J1G's anti-pattern was catalog `performance.quality = 0.9`
 * (manual placeholder) winning over models with real external-benchmark
 * scores. This test enforces the FIX:
 *
 *   When an external_benchmark entry exists in the snapshot, the scorer
 *   MUST prefer the snapshot's score over the catalog placeholder, AND
 *   a manual contribution in `sourceScores[]` cannot override an external
 *   one (the merger demotes manual to placeholder weight).
 *
 * Together these guards close the J1G manual-bump anti-pattern at TWO
 * layers: the scorer (uses snapshot, not catalog placeholder) and the
 * merger (demotes manual when external present).
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '@/core/orchestration/model-selection/model-role-resolver';
import {
  buildSnapshot,
  validateSnapshot,
  type ModelQualityCalibrationEntry,
  type ModelQualityCalibrationSnapshot,
} from '@/core/orchestration/role-selection/model-quality-calibration';
import { mergeQualitySnapshots } from '@/core/orchestration/quality-benchmark/merge-quality-snapshots';
import type { ModelCandidate } from '@/core/orchestration/model-selection/model-role-types';

function mkCandidate(opts: { modelId: string; providerId: string; quality?: number }): ModelCandidate {
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
      performance: { latencyMs: 800, throughput: 100, quality: opts.quality ?? 0.9, reliability: 0.9 },
      metadata: {},
      providerName: opts.providerId,
      providerStatus: 'active',
    } as never,
    providerId: opts.providerId,
    estimatedCostPerCallUsd: 0.005,
    hasCredits: true, providerHealthy: true, rateLimited: false, isLocal: false,
  };
}

function mkEntry(o: Partial<ModelQualityCalibrationEntry> = {}): ModelQualityCalibrationEntry {
  return {
    modelId: 'x',
    canonicalModelId: 'x',
    qualityScore: 0.7,
    qualityScoreSource: 'external_benchmark',
    qualityConfidence: 'high',
    warnings: [],
    createdAt: '2026-05-19T00:00:00.000Z',
    ...o,
  };
}

function mkSnapshot(entries: ModelQualityCalibrationEntry[]): ModelQualityCalibrationSnapshot {
  return buildSnapshot({ version: '1.0.0-guard', sourceArtifacts: [], entries });
}

describe('01C.1B-J2-C-R4 §17 — manual/catalog fallback guard', () => {
  it('external snapshot score beats catalog placeholder of 0.9', async () => {
    // Pool: model-low-cat has catalog q=0.9 (J1G manual bump), no external data.
    //       model-real-bench has catalog q=0.5 (lower!) but EXTERNAL benchmark q=0.95.
    // The fix means: model-real-bench MUST win.
    const candCatalogBumped = mkCandidate({ modelId: 'model-catalog-bumped', providerId: 'p1', quality: 0.9 });
    const candRealBench = mkCandidate({ modelId: 'model-real-bench', providerId: 'p2', quality: 0.5 });

    const snapshot = mkSnapshot([
      mkEntry({
        modelId: 'model-real-bench',
        canonicalModelId: 'model-real-bench',
        qualityScore: 0.95,
        qualityScoreSource: 'external_benchmark',
        qualityConfidence: 'high',
        sourceScores: [{ source: 'lmarena', score: 0.95, confidence: 'high' }],
        qualityScoreSources: ['lmarena'],
      }),
      // model-catalog-bumped has no entry — falls back to catalog
    ]);

    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'free_text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [candCatalogBumped, candRealBench],
      modelQualityCalibrationSnapshot: snapshot,
    });

    expect(result.synthesizerSelectionSummary?.winner?.modelId).toBe('model-real-bench');
  });

  it('snapshot is hashed into qualitySnapshotMetadata, proving traceability', async () => {
    const snapshot = mkSnapshot([
      mkEntry({
        modelId: 'm',
        canonicalModelId: 'm',
        qualityScore: 0.85,
        qualityScoreSource: 'external_benchmark',
        qualityConfidence: 'high',
        sourceScores: [{ source: 'lmarena', score: 0.85, confidence: 'high' }],
        qualityScoreSources: ['lmarena'],
      }),
    ]);
    const cand = mkCandidate({ modelId: 'm', providerId: 'p', quality: 0.5 });
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'free_text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [cand],
      modelQualityCalibrationSnapshot: snapshot,
    });
    const meta = result.synthesizerSelectionSummary?.qualitySnapshotMetadata;
    expect(meta?.snapshotHash).toBeDefined();
    expect(meta?.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(meta?.snapshotEntryCount).toBe(1);
  });

  it('merger demotes manual source confidence to placeholder when external present', () => {
    const s1 = mkSnapshot([
      mkEntry({
        modelId: 'x',
        canonicalModelId: 'x',
        qualityScore: 0.6,
        sourceScores: [
          { source: 'manual', score: 0.99, confidence: 'high' },     // operator manual bump
          { source: 'benchlm', score: 0.6, confidence: 'high' },      // real benchmark
        ],
        qualityScoreSources: ['benchlm', 'manual'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1], version: '1.0.0-merged-guard' });
    // Without demotion: (1.0 * 0.99 + 1.0 * 0.6) / 2 = 0.795
    // With demotion:    (1.0 * 0.6 + 0.1 * 0.99) / 1.1 = 0.6354
    expect(r.snapshot.entries[0].qualityScore).toBeCloseTo(0.6354, 3);
    expect(r.merges[0].demotedManualSources).toContain('manual');
    expect(r.snapshot.entries[0].warnings.some((w) => w.includes('manual_demoted'))).toBe(true);
  });

  it('merger keeps manual at declared confidence when ONLY manual sources present', () => {
    const s1 = mkSnapshot([
      mkEntry({
        modelId: 'x',
        canonicalModelId: 'x',
        qualityScore: 0.7,
        qualityScoreSource: 'manual_legacy',
        qualityConfidence: 'medium',
        sourceScores: [
          { source: 'manual', score: 0.7, confidence: 'medium' },
        ],
        qualityScoreSources: ['manual'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1], version: '1.0.0-merged-guard' });
    // No external present → no demotion
    expect(r.snapshot.entries[0].qualityScore).toBe(0.7);
    expect(r.merges[0].demotedManualSources).toEqual([]);
  });

  it('requireExternalBenchmark filter drops manual-only entries from active snapshot', () => {
    const s1 = mkSnapshot([
      mkEntry({
        modelId: 'manual-only',
        canonicalModelId: 'manual-only',
        qualityScoreSource: 'manual_legacy',
        qualityConfidence: 'medium',
        sourceScores: [{ source: 'manual', score: 0.95, confidence: 'high' }],
        qualityScoreSources: ['manual'],
      }),
      mkEntry({
        modelId: 'real',
        canonicalModelId: 'real',
        qualityScore: 0.8,
        sourceScores: [{ source: 'benchlm', score: 0.8, confidence: 'high' }],
        qualityScoreSources: ['benchlm'],
      }),
    ]);
    const r = mergeQualitySnapshots({
      snapshots: [s1],
      version: '1.0.0-merged-guard',
      requireExternalBenchmark: true,
    });
    const entryIds = r.snapshot.entries.map((e) => e.canonicalModelId);
    expect(entryIds).not.toContain('manual-only');
    expect(entryIds).toContain('real');
    expect(r.droppedNoExternal.some((d) => d.canonicalModelId === 'manual-only')).toBe(true);
  });

  it('produced snapshot stays valid per contract', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'a',
        sourceScores: [{ source: 'benchlm', score: 0.8, confidence: 'high' }],
        qualityScoreSources: ['benchlm'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1], version: '1.0.0-merged-guard' });
    const v = validateSnapshot(r.snapshot);
    expect(v.valid).toBe(true);
  });
});
