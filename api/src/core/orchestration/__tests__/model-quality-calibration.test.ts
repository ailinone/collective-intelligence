// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2 §8 — ModelQualityCalibrationSnapshot contract tests.
 *
 * Enforces:
 *   - score in [0, 1]
 *   - source/confidence consistency rules
 *   - dimensionScores in [0, 1]
 *   - no secret leakage in any string field
 *   - hash determinism (same content → same hash)
 *   - hash sensitivity (any field change → different hash)
 *   - sanitization in serialized payload
 */
import { describe, it, expect } from 'vitest';
import {
  validateEntry,
  validateSnapshot,
  computeSnapshotHash,
  buildSnapshot,
  findEntry,
  type ModelQualityCalibrationEntry,
} from '@/core/orchestration/role-selection/model-quality-calibration';

function mkEntry(overrides: Partial<ModelQualityCalibrationEntry> = {}): ModelQualityCalibrationEntry {
  return {
    modelId: 'test-model-x',
    qualityScore: 0.75,
    qualityScoreSource: 'internal_benchmark',
    qualityConfidence: 'medium',
    warnings: [],
    createdAt: '2026-05-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('01C.1B-J2 §8 — ModelQualityCalibrationSnapshot contract', () => {
  describe('validateEntry', () => {
    it('accepts a valid benchmarked entry with score 0..1', () => {
      const r = validateEntry(mkEntry({ qualityScore: 0.85 }));
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it('rejects score < 0', () => {
      const r = validateEntry(mkEntry({ qualityScore: -0.1 }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('outside [0, 1]'))).toBe(true);
    });

    it('rejects score > 1', () => {
      const r = validateEntry(mkEntry({ qualityScore: 1.5 }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('outside [0, 1]'))).toBe(true);
    });

    it('rejects non-finite score (NaN)', () => {
      const r = validateEntry(mkEntry({ qualityScore: NaN }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('finite number'))).toBe(true);
    });

    it('rejects placeholder source with non-placeholder confidence', () => {
      const r = validateEntry(mkEntry({
        qualityScoreSource: 'placeholder',
        qualityConfidence: 'high', // INCONSISTENT
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('inconsistent with source=placeholder'))).toBe(true);
    });

    it('rejects unknown source with high confidence', () => {
      const r = validateEntry(mkEntry({
        qualityScoreSource: 'unknown',
        qualityConfidence: 'high',
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('source=unknown cannot have confidence=high'))).toBe(true);
    });

    it('accepts placeholder source with placeholder confidence', () => {
      const r = validateEntry(mkEntry({
        qualityScoreSource: 'placeholder',
        qualityConfidence: 'placeholder',
      }));
      expect(r.valid).toBe(true);
    });

    it('rejects dimensionScores values outside [0, 1]', () => {
      const r = validateEntry(mkEntry({
        dimensionScores: { reasoning: 0.9, coding: 1.5 },
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('dimensionScores.coding'))).toBe(true);
    });

    it('rejects entry with secret-like pattern in string field', () => {
      const r = validateEntry(mkEntry({
        modelId: 'test-with-sk-abc1234567890ABCDEFG-leaked-key',
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('secret-like pattern'))).toBe(true);
    });

    it('rejects entry with Bearer token in benchmarkRunId', () => {
      const r = validateEntry(mkEntry({
        benchmarkRunId: 'run-Bearer abcdef1234567890ABCDEFGHIJ-leaked',
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('secret-like pattern'))).toBe(true);
    });

    it('01C.1B-J2-C-R3: accepts math dimension', () => {
      const r = validateEntry(mkEntry({ dimensionScores: { math: 0.85 } }));
      expect(r.valid).toBe(true);
    });

    it('01C.1B-J2-C-R3: accepts multilingual dimension', () => {
      const r = validateEntry(mkEntry({ dimensionScores: { multilingual: 0.78 } }));
      expect(r.valid).toBe(true);
    });

    it('01C.1B-J2-C-R3: accepts multimodal_grounded dimension', () => {
      const r = validateEntry(mkEntry({ dimensionScores: { multimodal_grounded: 0.72 } }));
      expect(r.valid).toBe(true);
    });

    it('01C.1B-J2-C-R3: still rejects out-of-range score on new dimension', () => {
      const r = validateEntry(mkEntry({ dimensionScores: { math: 1.5 } }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('dimensionScores.math'))).toBe(true);
    });

    it('01C.1B-J2-C-R3: snapshot without new dimensions (legacy) still valid (backward compat)', () => {
      const r = validateEntry(mkEntry({
        dimensionScores: { reasoning: 0.85, coding: 0.80 },
      }));
      expect(r.valid).toBe(true);
    });

    it('rejects invalid createdAt ISO date', () => {
      const r = validateEntry(mkEntry({ createdAt: 'not-a-date' }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('not a valid ISO date'))).toBe(true);
    });
  });

  describe('computeSnapshotHash', () => {
    it('is deterministic for same content', () => {
      const s1 = buildSnapshot({
        version: '1.0.0',
        sourceArtifacts: ['a.json'],
        entries: [mkEntry({ modelId: 'a', qualityScore: 0.8 })],
      });
      const s2 = buildSnapshot({
        version: '1.0.0',
        sourceArtifacts: ['a.json'],
        entries: [mkEntry({ modelId: 'a', qualityScore: 0.8 })],
      });
      expect(computeSnapshotHash(s1)).toBe(computeSnapshotHash(s2));
    });

    it('changes when qualityScore changes', () => {
      const s1 = buildSnapshot({
        version: '1.0.0',
        sourceArtifacts: [],
        entries: [mkEntry({ modelId: 'a', qualityScore: 0.8 })],
      });
      const s2 = buildSnapshot({
        version: '1.0.0',
        sourceArtifacts: [],
        entries: [mkEntry({ modelId: 'a', qualityScore: 0.9 })],
      });
      expect(computeSnapshotHash(s1)).not.toBe(computeSnapshotHash(s2));
    });

    it('changes when qualityScoreSource changes', () => {
      const s1 = buildSnapshot({
        version: '1.0.0',
        sourceArtifacts: [],
        entries: [mkEntry({ modelId: 'a', qualityScoreSource: 'internal_benchmark' })],
      });
      const s2 = buildSnapshot({
        version: '1.0.0',
        sourceArtifacts: [],
        entries: [mkEntry({
          modelId: 'a',
          qualityScoreSource: 'placeholder',
          qualityConfidence: 'placeholder',
        })],
      });
      expect(computeSnapshotHash(s1)).not.toBe(computeSnapshotHash(s2));
    });

    it('changes when dimensionScores change', () => {
      const s1 = buildSnapshot({
        version: '1.0.0',
        sourceArtifacts: [],
        entries: [mkEntry({ modelId: 'a', dimensionScores: { reasoning: 0.8 } })],
      });
      const s2 = buildSnapshot({
        version: '1.0.0',
        sourceArtifacts: [],
        entries: [mkEntry({ modelId: 'a', dimensionScores: { reasoning: 0.85 } })],
      });
      expect(computeSnapshotHash(s1)).not.toBe(computeSnapshotHash(s2));
    });

    it('is INSENSITIVE to entry insertion order', () => {
      const e1 = mkEntry({ modelId: 'a' });
      const e2 = mkEntry({ modelId: 'b' });
      const s1 = buildSnapshot({ version: '1.0.0', sourceArtifacts: [], entries: [e1, e2] });
      const s2 = buildSnapshot({ version: '1.0.0', sourceArtifacts: [], entries: [e2, e1] });
      expect(computeSnapshotHash(s1)).toBe(computeSnapshotHash(s2));
    });

    it('is INSENSITIVE to ephemeral fields (createdAt, costUsd, latencyMs)', () => {
      const s1 = buildSnapshot({
        version: '1.0.0',
        sourceArtifacts: [],
        entries: [mkEntry({
          modelId: 'a',
          createdAt: '2026-01-01T00:00:00.000Z',
          costUsd: 0.001,
          latencyMsP50: 500,
        })],
      });
      const s2 = buildSnapshot({
        version: '1.0.0',
        sourceArtifacts: [],
        entries: [mkEntry({
          modelId: 'a',
          createdAt: '2026-12-31T00:00:00.000Z',
          costUsd: 0.005,
          latencyMsP50: 1200,
        })],
      });
      expect(computeSnapshotHash(s1)).toBe(computeSnapshotHash(s2));
    });

    it('returns a 64-char hex SHA-256 digest', () => {
      const s = buildSnapshot({
        version: '1.0.0',
        sourceArtifacts: [],
        entries: [mkEntry({ modelId: 'a' })],
      });
      const h = computeSnapshotHash(s);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('findEntry', () => {
    const snapshot = buildSnapshot({
      version: '1.0.0',
      sourceArtifacts: [],
      entries: [
        mkEntry({ modelId: 'anthropic-claude-3.7-sonnet', canonicalModelId: 'claude-3-7-sonnet' }),
        mkEntry({ modelId: 'gpt-4o' }),
      ],
    });

    it('finds entry by exact modelId', () => {
      const e = findEntry(snapshot, 'gpt-4o');
      expect(e?.modelId).toBe('gpt-4o');
    });

    it('finds entry by canonicalModelId fallback', () => {
      const e = findEntry(snapshot, 'something-else', 'claude-3-7-sonnet');
      expect(e?.modelId).toBe('anthropic-claude-3.7-sonnet');
    });

    it('returns undefined when not found', () => {
      const e = findEntry(snapshot, 'nonexistent-model');
      expect(e).toBeUndefined();
    });
  });

  describe('buildSnapshot', () => {
    it('auto-computes summary stats', () => {
      const s = buildSnapshot({
        version: '1.0.0',
        sourceArtifacts: ['a.json'],
        entries: [
          mkEntry({ modelId: 'a', qualityScoreSource: 'placeholder', qualityConfidence: 'placeholder' }),
          mkEntry({ modelId: 'b', qualityScoreSource: 'internal_benchmark', qualityConfidence: 'high', costUsd: 0.01 }),
          mkEntry({ modelId: 'c', qualityScoreSource: 'live_probe', qualityConfidence: 'medium', costUsd: 0.005 }),
        ],
      });
      expect(s.summary.totalEntries).toBe(3);
      expect(s.summary.placeholderEntries).toBe(1);
      expect(s.summary.benchmarkedEntries).toBe(2);
      expect(s.summary.highConfidenceEntries).toBe(1);
      expect(s.summary.totalBenchmarkCostUsd).toBeCloseTo(0.015, 5);
    });

    it('throws on invalid entry', () => {
      expect(() =>
        buildSnapshot({
          version: '1.0.0',
          sourceArtifacts: [],
          entries: [mkEntry({ qualityScore: 2.0 })], // invalid
        }),
      ).toThrow(/outside \[0, 1\]/);
    });
  });
});

// ─── 01C.1B-J2-C-R4 §7 — Multi-source contract extensions ───────────────

describe('01C.1B-J2-C-R4 §7 — multi-source contract extensions', () => {
  it('accepts an entry with sourceScores[] and qualityScoreSources[]', () => {
    const r = validateEntry(mkEntry({
      sourceScores: [
        { source: 'benchlm', score: 0.82, confidence: 'high' },
        { source: 'lmarena', score: 0.91, confidence: 'high', sampleSize: 41203 },
      ],
      qualityScoreSources: ['benchlm', 'lmarena'],
    }));
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects sourceScores with duplicate source', () => {
    const r = validateEntry(mkEntry({
      sourceScores: [
        { source: 'benchlm', score: 0.82, confidence: 'high' },
        { source: 'benchlm', score: 0.65, confidence: 'medium' },
      ],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("duplicate source 'benchlm'"))).toBe(true);
  });

  it('rejects sourceScores entry with score outside [0, 1]', () => {
    const r = validateEntry(mkEntry({
      sourceScores: [
        { source: 'benchlm', score: 1.7, confidence: 'high' },
      ],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('sourceScores[0].score'))).toBe(true);
  });

  it('rejects when qualityScoreSources is missing a source present in sourceScores', () => {
    const r = validateEntry(mkEntry({
      sourceScores: [
        { source: 'benchlm', score: 0.82, confidence: 'high' },
        { source: 'lmarena', score: 0.91, confidence: 'high' },
      ],
      qualityScoreSources: ['benchlm'], // forgot lmarena
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("missing 'lmarena'"))).toBe(true);
  });

  it('rejects sourceScores categoryScores outside [0, 1]', () => {
    const r = validateEntry(mkEntry({
      sourceScores: [
        { source: 'lmarena', score: 0.9, confidence: 'high', categoryScores: { chat_text: 1.4 } },
      ],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('chat_text'))).toBe(true);
  });

  it('rejects taskCategoryScores with value outside [0, 1]', () => {
    const r = validateEntry(mkEntry({
      taskCategoryScores: { chat_text: 1.05 },
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('taskCategoryScores.chat_text'))).toBe(true);
  });

  it('rejects sourceScores sourceUrl with secret pattern', () => {
    const r = validateEntry(mkEntry({
      sourceScores: [
        { source: 'lmarena', score: 0.9, confidence: 'high', sourceUrl: 'https://example.com?token=sk-abc123def456ghi7' },
      ],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('secret-like pattern'))).toBe(true);
  });

  it('hash changes when sourceScores change', () => {
    const baseEntry = mkEntry({
      sourceScores: [{ source: 'benchlm', score: 0.82, confidence: 'high' }],
      qualityScoreSources: ['benchlm'],
    });
    const modifiedEntry = mkEntry({
      sourceScores: [{ source: 'benchlm', score: 0.83, confidence: 'high' }],
      qualityScoreSources: ['benchlm'],
    });
    const h1 = computeSnapshotHash(buildSnapshot({
      version: '1.0.0', sourceArtifacts: [], entries: [baseEntry],
    }));
    const h2 = computeSnapshotHash(buildSnapshot({
      version: '1.0.0', sourceArtifacts: [], entries: [modifiedEntry],
    }));
    expect(h1).not.toBe(h2);
  });

  it('hash changes when taskCategoryScores change', () => {
    const baseEntry = mkEntry({ taskCategoryScores: { chat_text: 0.7 } });
    const modifiedEntry = mkEntry({ taskCategoryScores: { chat_text: 0.8 } });
    const h1 = computeSnapshotHash(buildSnapshot({
      version: '1.0.0', sourceArtifacts: [], entries: [baseEntry],
    }));
    const h2 = computeSnapshotHash(buildSnapshot({
      version: '1.0.0', sourceArtifacts: [], entries: [modifiedEntry],
    }));
    expect(h1).not.toBe(h2);
  });

  it('hash is stable across sourceScores key order (canonical sorting)', () => {
    const e1 = mkEntry({
      sourceScores: [
        { source: 'lmarena', score: 0.91, confidence: 'high' },
        { source: 'benchlm', score: 0.82, confidence: 'high' },
      ],
      qualityScoreSources: ['benchlm', 'lmarena'],
    });
    const e2 = mkEntry({
      sourceScores: [
        { source: 'benchlm', score: 0.82, confidence: 'high' },
        { source: 'lmarena', score: 0.91, confidence: 'high' },
      ],
      qualityScoreSources: ['lmarena', 'benchlm'],
    });
    const h1 = computeSnapshotHash(buildSnapshot({ version: '1.0.0', sourceArtifacts: [], entries: [e1] }));
    const h2 = computeSnapshotHash(buildSnapshot({ version: '1.0.0', sourceArtifacts: [], entries: [e2] }));
    expect(h1).toBe(h2);
  });
});

describe('01C.1B-J2-C-R4 §7 — aggregateQualityFromSources', () => {
  it('returns undefined when sources is empty', async () => {
    const { aggregateQualityFromSources } = await import('@/core/orchestration/role-selection/model-quality-calibration');
    expect(aggregateQualityFromSources([])).toBeUndefined();
  });

  it('confidence-weighted average: high (1.0) outweighs low (0.3)', async () => {
    const { aggregateQualityFromSources } = await import('@/core/orchestration/role-selection/model-quality-calibration');
    const result = aggregateQualityFromSources([
      { source: 'benchlm', score: 0.9, confidence: 'high' },     // weight 1.0
      { source: 'manual', score: 0.5, confidence: 'low' },        // weight 0.3
    ]);
    // (1.0 * 0.9 + 0.3 * 0.5) / 1.3 = 1.05 / 1.3 = 0.8077
    expect(result).toBeCloseTo(0.8077, 3);
  });

  it('placeholder confidence contributes ~10% of high', async () => {
    const { aggregateQualityFromSources } = await import('@/core/orchestration/role-selection/model-quality-calibration');
    const result = aggregateQualityFromSources([
      { source: 'lmarena', score: 0.95, confidence: 'high' },         // weight 1.0
      { source: 'manual', score: 0.5, confidence: 'placeholder' },    // weight 0.1
    ]);
    // (1.0 * 0.95 + 0.1 * 0.5) / 1.1 = 1.0 / 1.1 = 0.9091
    expect(result).toBeCloseTo(0.9091, 3);
  });

  it('clamps result to [0, 1] and rounds to 4 decimals', async () => {
    const { aggregateQualityFromSources } = await import('@/core/orchestration/role-selection/model-quality-calibration');
    const result = aggregateQualityFromSources([
      { source: 'benchlm', score: 1, confidence: 'high' },
      { source: 'lmarena', score: 1, confidence: 'high' },
    ]);
    expect(result).toBe(1);
  });
});

describe('01C.1B-J2-C-R4 §12 — resolveQualityForTask', () => {
  it('returns unavailable when entry is undefined', async () => {
    const { resolveQualityForTask } = await import('@/core/orchestration/role-selection/model-quality-calibration');
    const r = resolveQualityForTask(undefined, 'chat_text');
    expect(r.score).toBeUndefined();
    expect(r.resolutionPath).toBe('unavailable');
  });

  it('uses task_category when entry.taskCategoryScores[category] is present', async () => {
    const { resolveQualityForTask } = await import('@/core/orchestration/role-selection/model-quality-calibration');
    const entry = mkEntry({
      qualityScore: 0.7,
      taskCategoryScores: { chat_text: 0.95, code_webdev: 0.82 },
    });
    const r = resolveQualityForTask(entry, 'chat_text');
    expect(r.score).toBe(0.95);
    expect(r.resolutionPath).toBe('task_category');
  });

  it('uses source_category_avg when taskCategoryScores missing but sourceScores has category', async () => {
    const { resolveQualityForTask } = await import('@/core/orchestration/role-selection/model-quality-calibration');
    const entry = mkEntry({
      qualityScore: 0.7,
      sourceScores: [
        { source: 'lmarena', score: 0.8, confidence: 'high', categoryScores: { image_t2i: 0.85 } },
        { source: 'benchlm', score: 0.7, confidence: 'medium', categoryScores: { image_t2i: 0.7 } },
      ],
      qualityScoreSources: ['benchlm', 'lmarena'],
    });
    const r = resolveQualityForTask(entry, 'image_t2i');
    // (1.0*0.85 + 0.6*0.7) / 1.6 = 1.27 / 1.6 = 0.7937
    expect(r.score).toBeCloseTo(0.7938, 3);
    expect(r.resolutionPath).toBe('source_category_avg');
  });

  it('falls back to aggregate when category missing from both taskCategoryScores and sourceScores', async () => {
    const { resolveQualityForTask } = await import('@/core/orchestration/role-selection/model-quality-calibration');
    const entry = mkEntry({
      qualityScore: 0.7,
      taskCategoryScores: { chat_text: 0.95 },
      sourceScores: [{ source: 'benchlm', score: 0.7, confidence: 'high', categoryScores: { chat_text: 0.9 } }],
      qualityScoreSources: ['benchlm'],
    });
    const r = resolveQualityForTask(entry, 'video_t2v');
    expect(r.score).toBe(0.7);
    expect(r.resolutionPath).toBe('aggregate');
  });

  it('returns aggregate for entry with no per-category data', async () => {
    const { resolveQualityForTask } = await import('@/core/orchestration/role-selection/model-quality-calibration');
    const entry = mkEntry({ qualityScore: 0.6 });
    const r = resolveQualityForTask(entry, 'chat_text');
    expect(r.score).toBe(0.6);
    expect(r.resolutionPath).toBe('aggregate');
  });
});
