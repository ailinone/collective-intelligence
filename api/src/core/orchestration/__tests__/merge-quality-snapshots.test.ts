// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R4 §11 — Multi-source quality snapshot merger tests.
 *
 * Validates:
 *   - Basic merge (1 snapshot → 1 snapshot)
 *   - Two snapshots disjoint → all entries preserved
 *   - Two snapshots overlapping → single entry per canonical
 *   - sourceScores preserved verbatim
 *   - taskCategoryScores aggregated across sources (weighted by confidence)
 *   - dimensionScores merged by MAX
 *   - Manual demotion when external sources present
 *   - requireExternalBenchmark filters manual-only entries
 *   - Empty input throws
 *   - sourceArtifacts union
 */
import { describe, it, expect } from 'vitest';
import {
  mergeQualitySnapshots,
} from '@/core/orchestration/quality-benchmark/merge-quality-snapshots';
import {
  buildSnapshot,
  validateSnapshot,
  type ModelQualityCalibrationEntry,
  type ModelQualityCalibrationSnapshot,
} from '@/core/orchestration/role-selection/model-quality-calibration';

function mkEntry(
  overrides: Partial<ModelQualityCalibrationEntry> = {},
): ModelQualityCalibrationEntry {
  return {
    modelId: 'test-x',
    canonicalModelId: 'test-x',
    qualityScore: 0.7,
    qualityScoreSource: 'external_benchmark',
    qualityConfidence: 'high',
    warnings: [],
    createdAt: '2026-05-19T00:00:00.000Z',
    ...overrides,
  };
}

function mkSnapshot(
  entries: ModelQualityCalibrationEntry[],
  opts: Partial<{ version: string; sourceArtifacts: readonly string[] }> = {},
): ModelQualityCalibrationSnapshot {
  return buildSnapshot({
    version: opts.version ?? '1.0.0',
    sourceArtifacts: opts.sourceArtifacts ?? [],
    entries,
  });
}

describe('01C.1B-J2-C-R4 §10 — mergeQualitySnapshots', () => {
  it('throws when no snapshots provided', () => {
    expect(() => mergeQualitySnapshots({ snapshots: [], version: '1.0.0-empty' })).toThrow();
  });

  it('single-snapshot merge preserves entries 1:1', () => {
    const s = mkSnapshot([
      mkEntry({
        canonicalModelId: 'a',
        qualityScore: 0.8,
        sourceScores: [{ source: 'benchlm', score: 0.8, confidence: 'high' }],
        qualityScoreSources: ['benchlm'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s], version: '1.0.0-merged' });
    expect(r.snapshot.entries.length).toBe(1);
    expect(r.snapshot.entries[0].canonicalModelId).toBe('a');
    expect(r.merges[0].contributingSources).toEqual(['benchlm']);
  });

  it('two disjoint snapshots produce union of entries', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'a',
        sourceScores: [{ source: 'benchlm', score: 0.8, confidence: 'high' }],
        qualityScoreSources: ['benchlm'],
      }),
    ]);
    const s2 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'b',
        sourceScores: [{ source: 'lmarena', score: 0.9, confidence: 'high' }],
        qualityScoreSources: ['lmarena'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1, s2], version: '1.0.0-merged' });
    expect(r.snapshot.entries.length).toBe(2);
    const canons = r.snapshot.entries.map((e) => e.canonicalModelId).sort();
    expect(canons).toEqual(['a', 'b']);
  });

  it('overlapping canonicalModelId merges to single entry with both sources', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        qualityScore: 0.7,
        sourceScores: [{ source: 'benchlm', score: 0.7, confidence: 'high' }],
        qualityScoreSources: ['benchlm'],
      }),
    ]);
    const s2 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        qualityScore: 0.9,
        sourceScores: [{ source: 'lmarena', score: 0.9, confidence: 'high' }],
        qualityScoreSources: ['lmarena'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1, s2], version: '1.0.0-merged' });
    expect(r.snapshot.entries.length).toBe(1);
    const merged = r.snapshot.entries[0];
    expect(merged.qualityScoreSources?.sort()).toEqual(['benchlm', 'lmarena']);
    expect(merged.sourceScores?.length).toBe(2);
    // Weighted average: both high (weight 1.0): (0.7 + 0.9) / 2 = 0.8
    expect(merged.qualityScore).toBeCloseTo(0.8, 3);
  });

  it('weighted average reflects different confidences', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        sourceScores: [{ source: 'benchlm', score: 0.9, confidence: 'high' }],     // weight 1.0
        qualityScoreSources: ['benchlm'],
      }),
    ]);
    const s2 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        sourceScores: [{ source: 'lmarena', score: 0.5, confidence: 'low' }],       // weight 0.3
        qualityScoreSources: ['lmarena'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1, s2], version: '1.0.0-merged' });
    const merged = r.snapshot.entries[0];
    // (1.0 * 0.9 + 0.3 * 0.5) / 1.3 = 1.05 / 1.3 = 0.8077
    expect(merged.qualityScore).toBeCloseTo(0.8077, 3);
  });

  it('taskCategoryScores aggregated across sources per category', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        sourceScores: [{
          source: 'benchlm',
          score: 0.8,
          confidence: 'high',
          categoryScores: { chat_text: 0.85, code_webdev: 0.9 },
        }],
        qualityScoreSources: ['benchlm'],
      }),
    ]);
    const s2 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        sourceScores: [{
          source: 'lmarena',
          score: 0.85,
          confidence: 'high',
          categoryScores: { chat_text: 0.9, image_t2i: 0.6 },
        }],
        qualityScoreSources: ['lmarena'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1, s2], version: '1.0.0-merged' });
    const merged = r.snapshot.entries[0];
    expect(merged.taskCategoryScores).toBeDefined();
    // chat_text: both high, (0.85 + 0.9) / 2 = 0.875
    expect(merged.taskCategoryScores!.chat_text).toBeCloseTo(0.875, 3);
    // code_webdev: only benchlm covers it
    expect(merged.taskCategoryScores!.code_webdev).toBe(0.9);
    // image_t2i: only lmarena covers it
    expect(merged.taskCategoryScores!.image_t2i).toBe(0.6);
  });

  it('dimensionScores merged by max across sources', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        dimensionScores: { reasoning: 0.85, coding: 0.7 },
      }),
    ]);
    const s2 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        dimensionScores: { reasoning: 0.9, math: 0.8 },
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1, s2], version: '1.0.0-merged' });
    const merged = r.snapshot.entries[0];
    expect(merged.dimensionScores!.reasoning).toBe(0.9); // max(0.85, 0.9)
    expect(merged.dimensionScores!.coding).toBe(0.7);     // only s1
    expect(merged.dimensionScores!.math).toBe(0.8);       // only s2
  });

  it('manual source DEMOTED when external source present in same entry', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        sourceScores: [
          { source: 'benchlm', score: 0.6, confidence: 'high' },
          { source: 'manual', score: 0.95, confidence: 'high' }, // operator-injected
        ],
        qualityScoreSources: ['benchlm', 'manual'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1], version: '1.0.0-merged' });
    const merged = r.snapshot.entries[0];
    // manual demoted to placeholder weight (0.1), benchlm high (1.0)
    // (1.0 * 0.6 + 0.1 * 0.95) / 1.1 = 0.695 / 1.1 = 0.6318
    expect(merged.qualityScore).toBeCloseTo(0.6318, 3);
    expect(r.merges[0].demotedManualSources).toContain('manual');
    expect(merged.warnings.some((w) => w.includes('manual_demoted'))).toBe(true);
  });

  it('manual source NOT demoted when no external source present', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        qualityScoreSource: 'manual_legacy',
        qualityConfidence: 'medium',
        sourceScores: [
          { source: 'manual', score: 0.7, confidence: 'medium' },
        ],
        qualityScoreSources: ['manual'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1], version: '1.0.0-merged' });
    const merged = r.snapshot.entries[0];
    expect(merged.qualityScore).toBe(0.7);
    expect(r.merges[0].demotedManualSources).toEqual([]);
  });

  it('requireExternalBenchmark=true drops entries without external sources', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'manual-only',
        qualityScoreSource: 'manual_legacy',
        qualityConfidence: 'medium',
        sourceScores: [{ source: 'manual', score: 0.7, confidence: 'medium' }],
        qualityScoreSources: ['manual'],
      }),
      mkEntry({
        canonicalModelId: 'external-backed',
        sourceScores: [{ source: 'benchlm', score: 0.8, confidence: 'high' }],
        qualityScoreSources: ['benchlm'],
      }),
    ]);
    const r = mergeQualitySnapshots({
      snapshots: [s1], version: '1.0.0-merged', requireExternalBenchmark: true,
    });
    expect(r.snapshot.entries.length).toBe(1);
    expect(r.snapshot.entries[0].canonicalModelId).toBe('external-backed');
    expect(r.droppedNoExternal.length).toBe(1);
    expect(r.droppedNoExternal[0].canonicalModelId).toBe('manual-only');
  });

  it('same source across multiple snapshots keeps the higher-confidence version', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        sourceScores: [{ source: 'benchlm', score: 0.7, confidence: 'medium' }],
        qualityScoreSources: ['benchlm'],
      }),
    ]);
    const s2 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        sourceScores: [{ source: 'benchlm', score: 0.85, confidence: 'high' }],
        qualityScoreSources: ['benchlm'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1, s2], version: '1.0.0-merged' });
    const merged = r.snapshot.entries[0];
    expect(merged.sourceScores?.length).toBe(1); // dedup'd to one entry
    expect(merged.sourceScores![0].score).toBe(0.85);
    expect(merged.sourceScores![0].confidence).toBe('high');
  });

  it('sourceArtifacts is union of input snapshots + explicit additions', () => {
    const s1 = mkSnapshot([mkEntry({ canonicalModelId: 'a' })], { sourceArtifacts: ['benchlm.csv'] });
    const s2 = mkSnapshot([mkEntry({ canonicalModelId: 'b' })], { sourceArtifacts: ['lmarena.md'] });
    const r = mergeQualitySnapshots({
      snapshots: [s1, s2], version: '1.0.0-merged', sourceArtifacts: ['manifest.json'],
    });
    expect(r.snapshot.sourceArtifacts.slice().sort()).toEqual([
      'benchlm.csv', 'lmarena.md', 'manifest.json',
    ]);
  });

  it('merged snapshot is valid per contract validator', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        sourceScores: [{ source: 'benchlm', score: 0.8, confidence: 'high' }],
        qualityScoreSources: ['benchlm'],
      }),
    ]);
    const s2 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        sourceScores: [{ source: 'lmarena', score: 0.85, confidence: 'high' }],
        qualityScoreSources: ['lmarena'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1, s2], version: '1.0.0-merged' });
    const v = validateSnapshot(r.snapshot);
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('best confidence wins for the merged qualityConfidence field', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        sourceScores: [{ source: 'benchlm', score: 0.6, confidence: 'low' }],
        qualityScoreSources: ['benchlm'],
        qualityConfidence: 'low',
      }),
    ]);
    const s2 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        sourceScores: [{ source: 'lmarena', score: 0.9, confidence: 'high' }],
        qualityScoreSources: ['lmarena'],
        qualityConfidence: 'high',
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1, s2], version: '1.0.0-merged' });
    expect(r.snapshot.entries[0].qualityConfidence).toBe('high');
  });

  it('merge produces external_benchmark source type when ANY source is external', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        qualityScoreSource: 'manual_legacy',
        sourceScores: [
          { source: 'manual', score: 0.7, confidence: 'medium' },
          { source: 'lmarena', score: 0.85, confidence: 'high' },
        ],
        qualityScoreSources: ['lmarena', 'manual'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1], version: '1.0.0-merged' });
    expect(r.snapshot.entries[0].qualityScoreSource).toBe('external_benchmark');
  });

  it('warnings record the merge strategy and contributing sources', () => {
    const s1 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        sourceScores: [{ source: 'benchlm', score: 0.8, confidence: 'high' }],
        qualityScoreSources: ['benchlm'],
      }),
    ]);
    const s2 = mkSnapshot([
      mkEntry({
        canonicalModelId: 'shared',
        sourceScores: [{ source: 'lmarena', score: 0.85, confidence: 'high' }],
        qualityScoreSources: ['lmarena'],
      }),
    ]);
    const r = mergeQualitySnapshots({ snapshots: [s1, s2], version: '1.0.0-merged' });
    const merged = r.snapshot.entries[0];
    expect(merged.warnings.some((w) => w.includes('merged_sources=benchlm,lmarena'))).toBe(true);
    expect(merged.warnings.some((w) => w.includes('weighted_average_by_confidence'))).toBe(true);
  });
});
