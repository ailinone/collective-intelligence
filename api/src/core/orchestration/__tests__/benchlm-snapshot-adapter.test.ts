// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R3 §9 — BenchLM adapter tests.
 *
 * Pure-function tests of the adapter. No I/O, no network, no provider calls.
 * Covers:
 *   - score normalization (0-100 → 0-1, edge cases)
 *   - dimension mapping (8 BenchLM categories → ModelQualityDimension)
 *   - name canonicalization (parenthetical qualifiers stripped)
 *   - candidate matching (exact / slug-substring / unmatched)
 *   - row → entry conversion (skips missing overall, applies attribution)
 *   - snapshot builder (matched + notCovered + skipped reporting)
 *   - sanitization (no secret-like content in produced entries)
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeBenchLmScore,
  mapBenchLmDimensions,
  canonicalizeBenchLmModelName,
  compactSlug,
  matchBenchLmRowToCatalogModel,
  benchLmRowToCalibrationEntry,
  buildBenchLmQualitySnapshot,
  ATTRIBUTION_WARNING,
  type BenchLmLeaderboardRow,
  type CandidateLike,
} from '@/core/orchestration/quality-benchmark/benchlm-snapshot-adapter';
import { computeSnapshotHash } from '@/core/orchestration/role-selection/model-quality-calibration';

describe('01C.1B-J2-C-R3 §9 — BenchLM adapter', () => {
  describe('normalizeBenchLmScore', () => {
    it('normalizes 90 (0-100 scale) to 0.90', () => {
      expect(normalizeBenchLmScore(90)).toBe(0.9);
    });
    it('preserves 0.90 (already 0-1)', () => {
      expect(normalizeBenchLmScore(0.9)).toBe(0.9);
    });
    it('rejects negative score', () => {
      expect(normalizeBenchLmScore(-5)).toBeUndefined();
    });
    it('rejects score > 100', () => {
      expect(normalizeBenchLmScore(150)).toBeUndefined();
    });
    it('rejects non-numeric input', () => {
      expect(normalizeBenchLmScore('not a number')).toBeUndefined();
      expect(normalizeBenchLmScore(null)).toBeUndefined();
      expect(normalizeBenchLmScore(undefined)).toBeUndefined();
      expect(normalizeBenchLmScore('')).toBeUndefined();
    });
    it('coerces numeric string "85" to 0.85', () => {
      expect(normalizeBenchLmScore('85')).toBe(0.85);
    });
  });

  describe('mapBenchLmDimensions', () => {
    const row: BenchLmLeaderboardRow = {
      modelName: 'Test Model',
      categoryScores: {
        agentic: 90,
        coding: 88,
        reasoning: 92,
        knowledge: 99.2,
        math: 74.7,
        multilingual: 100,
        multimodalGrounded: 73.6,
        instructionFollowing: 95.3,
      },
    };
    const mapped = mapBenchLmDimensions(row);
    it('maps agentic → tool_use', () => {
      expect(mapped.tool_use).toBe(0.9);
    });
    it('maps coding → coding', () => {
      expect(mapped.coding).toBe(0.88);
    });
    it('maps reasoning → reasoning', () => {
      expect(mapped.reasoning).toBe(0.92);
    });
    it('maps knowledge → factuality', () => {
      expect(mapped.factuality).toBe(0.992);
    });
    it('maps math → math (new dimension)', () => {
      expect(mapped.math).toBe(0.747);
    });
    it('maps multilingual → multilingual (new dimension)', () => {
      expect(mapped.multilingual).toBe(1.0);
    });
    it('maps multimodalGrounded → multimodal_grounded (new dimension)', () => {
      expect(mapped.multimodal_grounded).toBe(0.736);
    });
    it('maps instructionFollowing → instruction_following', () => {
      expect(mapped.instruction_following).toBe(0.953);
    });
    it('skips dimensions with null/missing values', () => {
      const partial = mapBenchLmDimensions({
        modelName: 'Partial',
        categoryScores: { coding: 80, reasoning: null, math: undefined },
      });
      expect(partial.coding).toBe(0.8);
      expect(partial.reasoning).toBeUndefined();
      expect(partial.math).toBeUndefined();
    });
  });

  describe('canonicalizeBenchLmModelName', () => {
    it('strips parenthetical qualifiers', () => {
      expect(canonicalizeBenchLmModelName('Claude Opus 4.7 (Adaptive)')).toBe('claude opus 4.7');
      expect(canonicalizeBenchLmModelName('GPT-5.5 (xhigh)')).toBe('gpt-5.5');
      expect(canonicalizeBenchLmModelName('DeepSeek V4 Pro (Max)')).toBe('deepseek v4 pro');
    });
    it('lowercases', () => {
      expect(canonicalizeBenchLmModelName('Kimi K2.6')).toBe('kimi k2.6');
    });
    it('handles empty input', () => {
      expect(canonicalizeBenchLmModelName('')).toBe('');
    });
  });

  describe('matchBenchLmRowToCatalogModel', () => {
    const candidates: CandidateLike[] = [
      { canonicalModelId: 'claude-opus-4.7', modelId: 'anthropic/claude-opus-4.7', family: 'anthropic_claude' },
      { canonicalModelId: 'deepseek-v4-pro', modelId: 'deepseek-v4-pro', family: 'deepseek' },
      { canonicalModelId: 'moonshotai/kimi-k2.6', modelId: 'moonshotai/Kimi-K2.6', family: 'moonshot_kimi' },
      { canonicalModelId: 'claude-3.7-sonnet', modelId: 'claude-3.7-sonnet', family: 'anthropic_claude' },
    ];

    it('returns medium confidence slug-substring match for "Claude Opus 4.7 (Adaptive)"', () => {
      const r = matchBenchLmRowToCatalogModel(
        { modelName: 'Claude Opus 4.7 (Adaptive)' },
        candidates,
      );
      expect(r.matched).toBe(true);
      expect(r.candidate?.canonicalModelId).toBe('claude-opus-4.7');
      // "claude opus 4.7" vs canonical "claude-opus-4.7" — different separators,
      // matched via slug substring (both reduce to "claudeopus4.7")
      expect(['medium', 'high']).toContain(r.matchConfidence);
    });

    it('matches DeepSeek V4 Pro (Max)', () => {
      const r = matchBenchLmRowToCatalogModel(
        { modelName: 'DeepSeek V4 Pro (Max)' },
        candidates,
      );
      expect(r.matched).toBe(true);
      expect(r.candidate?.canonicalModelId).toBe('deepseek-v4-pro');
    });

    it('matches Kimi K2.6', () => {
      const r = matchBenchLmRowToCatalogModel(
        { modelName: 'Kimi K2.6' },
        candidates,
      );
      expect(r.matched).toBe(true);
      expect(r.candidate?.canonicalModelId).toBe('moonshotai/kimi-k2.6');
    });

    it('returns unmatched for missing model', () => {
      const r = matchBenchLmRowToCatalogModel(
        { modelName: 'nonexistent-future-model-7000' },
        candidates,
      );
      expect(r.matched).toBe(false);
      expect(r.matchKind).toBe('unmatched');
      expect(r.matchConfidence).toBe('placeholder');
    });

    it('rejects too-short stem matches (does not match "gpt" against "gpt-4o-mini")', () => {
      const shortCands: CandidateLike[] = [{ canonicalModelId: 'gpt-4o-mini' }];
      const r = matchBenchLmRowToCatalogModel(
        { modelName: 'gpt' }, // dangerous: 3-char stem
        shortCands,
      );
      // "gpt" canonicalizes to "gpt" (3 chars), shorter than min 5 — should reject
      expect(r.matched).toBe(false);
    });
  });

  describe('benchLmRowToCalibrationEntry', () => {
    const row: BenchLmLeaderboardRow = {
      modelName: 'Claude Opus 4.7 (Adaptive)',
      overall: 90,
      categoryScores: {
        coding: 95.3,
        agentic: 94.3,
        reasoning: 91.9,
        knowledge: 99.2,
        math: 74.7,
      },
      pricing: { input: 5, output: 25 },
      rank: 6,
    };

    it('produces entry with qualityScoreSource=external_benchmark', () => {
      const e = benchLmRowToCalibrationEntry(row);
      expect(e).toBeDefined();
      expect(e!.qualityScoreSource).toBe('external_benchmark');
      expect(e!.qualityScore).toBe(0.9);
    });

    it('populates dimensionScores from BenchLM categoryScores', () => {
      const e = benchLmRowToCalibrationEntry(row)!;
      expect(e.dimensionScores?.coding).toBe(0.953);
      expect(e.dimensionScores?.tool_use).toBe(0.943); // agentic → tool_use
      expect(e.dimensionScores?.math).toBe(0.747);
    });

    it('attaches ATTRIBUTION_WARNING by default', () => {
      const e = benchLmRowToCalibrationEntry(row)!;
      expect(e.warnings.some((w) => w.includes('BenchLM'))).toBe(true);
    });

    it('returns undefined when overall is missing', () => {
      const e = benchLmRowToCalibrationEntry({ modelName: 'No Overall', categoryScores: { coding: 80 } });
      expect(e).toBeUndefined();
    });

    it('sets costUsd to 0 (external benchmark, no provider calls)', () => {
      const e = benchLmRowToCalibrationEntry(row)!;
      expect(e.costUsd).toBe(0);
    });

    it('uses match.confidence when match is provided', () => {
      const e = benchLmRowToCalibrationEntry(row, {
        match: {
          matched: true,
          candidate: { canonicalModelId: 'claude-opus-4.7', family: 'anthropic_claude' },
          matchKind: 'exact_canonical',
          matchConfidence: 'high',
          matchReason: 'test',
        },
      })!;
      expect(e.qualityConfidence).toBe('high');
      expect(e.canonicalModelId).toBe('claude-opus-4.7');
      expect(e.family).toBe('anthropic_claude');
    });
  });

  describe('buildBenchLmQualitySnapshot', () => {
    const rows: BenchLmLeaderboardRow[] = [
      {
        modelName: 'Claude Opus 4.7 (Adaptive)',
        overall: 90,
        categoryScores: { coding: 95.3, reasoning: 91.9, knowledge: 99.2 },
      },
      {
        modelName: 'DeepSeek V4 Pro (Max)',
        overall: 88,
        categoryScores: { coding: 90.5, knowledge: 77.9 },
      },
      {
        modelName: 'Kimi K2.6',
        overall: 85,
        categoryScores: { coding: 89.1, knowledge: 75.9 },
      },
      // This one is NOT in candidates → should be skipped (emitUnmatchedRows=false default)
      {
        modelName: 'Unrelated Model X',
        overall: 70,
        categoryScores: { coding: 60 },
      },
    ];

    const candidates: CandidateLike[] = [
      { canonicalModelId: 'claude-opus-4.7', family: 'anthropic_claude' },
      { canonicalModelId: 'deepseek-v4-pro', family: 'deepseek' },
      { canonicalModelId: 'moonshotai/kimi-k2.6', family: 'moonshot_kimi' },
      // claude-3.7-sonnet is in candidates but NOT in BenchLM rows → should appear in notCovered
      { canonicalModelId: 'claude-3.7-sonnet', family: 'anthropic_claude' },
    ];

    const result = buildBenchLmQualitySnapshot({
      rows,
      candidates,
      version: '1.0.0-benchlm-test',
      sourceArtifacts: ['test-source.csv'],
    });

    it('produces a valid snapshot', () => {
      expect(result.snapshot.entries.length).toBe(3);
      expect(result.snapshot.version).toBe('1.0.0-benchlm-test');
      expect(result.snapshot.stage).toBe('01C.1B-J2');
    });

    it('matched array contains 3 entries (Claude / DeepSeek / Kimi)', () => {
      expect(result.matched.length).toBe(3);
    });

    it('notCovered array contains claude-3.7-sonnet (in candidates but not in BenchLM)', () => {
      expect(result.notCovered.some((c) => c.candidateModelId === 'claude-3.7-sonnet')).toBe(true);
    });

    it('skipped array contains the unmatched row (Unrelated Model X)', () => {
      expect(result.skipped.some((s) => s.modelName === 'Unrelated Model X')).toBe(true);
    });

    it('snapshot hash is deterministic', () => {
      const result2 = buildBenchLmQualitySnapshot({
        rows,
        candidates,
        version: '1.0.0-benchlm-test',
        sourceArtifacts: ['test-source.csv'],
      });
      expect(computeSnapshotHash(result.snapshot)).toBe(computeSnapshotHash(result2.snapshot));
    });

    it('all entries are external_benchmark', () => {
      for (const e of result.snapshot.entries) {
        expect(e.qualityScoreSource).toBe('external_benchmark');
      }
    });

    it('all entries carry attribution warning', () => {
      for (const e of result.snapshot.entries) {
        expect(e.warnings.some((w) => w.includes('BenchLM'))).toBe(true);
      }
    });

    it('no entry contains secret-like patterns (sanitization gate)', () => {
      for (const e of result.snapshot.entries) {
        const s = JSON.stringify(e);
        expect(s).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
        expect(s).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
      }
    });

    it('confirms J1G premise: claude-3.7-sonnet is NOT covered by BenchLM (anti-pattern)', () => {
      const notCovered = result.notCovered.find((c) => c.candidateModelId === 'claude-3.7-sonnet');
      expect(notCovered).toBeDefined();
      expect(notCovered?.reason).toContain('no_benchlm_row');
    });
  });

  describe('attribution + sanitization', () => {
    it('ATTRIBUTION_WARNING contains expected source markers', () => {
      expect(ATTRIBUTION_WARNING).toContain('BenchLM');
      expect(ATTRIBUTION_WARNING).toContain('https://benchlm.ai/');
      expect(ATTRIBUTION_WARNING).toContain('external_benchmark');
    });
  });
});
