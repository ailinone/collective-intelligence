// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R4 §9 — LMArena snapshot adapter tests.
 *
 * Exercises:
 *   - Elo normalization (clamp((elo-900)/600, 0, 1))
 *   - Model name canonicalization
 *   - Markdown parser (multi-category, malformed rows)
 *   - Candidate matching (exact / slug / unmatched)
 *   - Row → Entry transformation (multi-category aggregation)
 *   - Full snapshot build (matched/notCovered/skipped reports)
 *   - Attribution warning attached to every entry
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeElo,
  canonicalizeLmArenaModelName,
  compactSlug,
  parseLmArenaMarkdown,
  matchLmArenaRowToCatalogModel,
  lmArenaRowsToCalibrationEntry,
  buildLmArenaQualitySnapshot,
  ATTRIBUTION_WARNING,
  type LmArenaRow,
  type CandidateLike,
} from '@/core/orchestration/quality-benchmark/lmarena-snapshot-adapter';
import { validateSnapshot } from '@/core/orchestration/role-selection/model-quality-calibration';

const SAMPLE_MD = `
# header

## Category: chat_text

| Rank | Model | Elo | Votes |
|-----:|-------|----:|------:|
| 1 | claude-opus-4-7-thinking | 1502 | 38120 |
| 2 | claude-opus-4-7 | 1492 | 41203 |
| 211 | gpt-4o-mini-2024-07-18 | 1317 | 42081 |

## Category: chat_vision

| Rank | Model | Elo | Votes |
|-----:|-------|----:|------:|
| 96 | gpt-4o-mini-2024-07-18 | 1098 | 5402 |

## Category: bogus_category

| Rank | Model | Elo |
|-----:|-------|----:|
| 1 | should-not-parse | 9999 |
`;

describe('01C.1B-J2-C-R4 §8 — normalizeElo', () => {
  it('linear: 1500 → 1.0', () => {
    expect(normalizeElo(1500)).toBe(1);
  });
  it('linear: 900 → 0.0', () => {
    expect(normalizeElo(900)).toBe(0);
  });
  it('linear: 1200 → 0.5', () => {
    expect(normalizeElo(1200)).toBe(0.5);
  });
  it('clamps below 900', () => {
    expect(normalizeElo(800)).toBe(0);
  });
  it('clamps above 1500', () => {
    expect(normalizeElo(1700)).toBe(1);
  });
  it('rejects NaN', () => {
    expect(normalizeElo(NaN)).toBeUndefined();
  });
  it('rejects Infinity', () => {
    expect(normalizeElo(Infinity)).toBeUndefined();
  });
  it('rejects null/undefined', () => {
    expect(normalizeElo(null)).toBeUndefined();
    expect(normalizeElo(undefined)).toBeUndefined();
  });
  it('rounds to 4 decimals', () => {
    // (1234 - 900) / 600 = 0.5566...
    expect(normalizeElo(1234)).toBeCloseTo(0.5567, 4);
  });
  it('accepts numeric string input', () => {
    expect(normalizeElo('1500')).toBe(1);
  });
});

describe('01C.1B-J2-C-R4 §8 — canonicalizeLmArenaModelName', () => {
  it('lowercases', () => {
    expect(canonicalizeLmArenaModelName('Claude-Opus-4-7')).toBe('claude-opus-4-7');
  });
  it('strips parentheticals', () => {
    expect(canonicalizeLmArenaModelName('claude-opus-4-7 (thinking)')).toBe('claude-opus-4-7');
  });
  it('preserves slashes for namespaced models', () => {
    expect(canonicalizeLmArenaModelName('moonshotai/Kimi-K2.6')).toBe('moonshotai/kimi-k2.6');
  });
  it('normalizes internal whitespace', () => {
    expect(canonicalizeLmArenaModelName('  gpt   5.5   thinking  ')).toBe('gpt 5.5 thinking');
  });
  it('returns empty string for empty input', () => {
    expect(canonicalizeLmArenaModelName('')).toBe('');
  });
  it('compactSlug drops slashes and dashes', () => {
    expect(compactSlug('moonshotai/Kimi-K2.6')).toBe('moonshotaikimik2.6');
  });
});

describe('01C.1B-J2-C-R4 §8 — parseLmArenaMarkdown', () => {
  it('parses a single category with three rows', () => {
    const r = parseLmArenaMarkdown(SAMPLE_MD);
    const chatTextRows = r.rows.filter((row) => row.category === 'chat_text');
    expect(chatTextRows.length).toBe(3);
    expect(chatTextRows[0].modelName).toBe('claude-opus-4-7-thinking');
    expect(chatTextRows[0].elo).toBe(1502);
    expect(chatTextRows[0].votes).toBe(38120);
  });

  it('parses multiple categories', () => {
    const r = parseLmArenaMarkdown(SAMPLE_MD);
    const categories = new Set(r.rows.map((row) => row.category));
    expect(categories.has('chat_text')).toBe(true);
    expect(categories.has('chat_vision')).toBe(true);
  });

  it('warns and skips unknown categories', () => {
    const r = parseLmArenaMarkdown(SAMPLE_MD);
    expect(r.warnings.some((w) => w.includes('bogus_category'))).toBe(true);
    expect(r.rows.find((row) => row.modelName === 'should-not-parse')).toBeUndefined();
  });

  it('handles rows without votes column', () => {
    const md = `
## Category: chat_text

| Rank | Model | Elo |
|-----:|-------|----:|
| 1 | model-a | 1400 |
`;
    const r = parseLmArenaMarkdown(md);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].votes).toBeUndefined();
  });

  it('returns empty when no category section present', () => {
    const r = parseLmArenaMarkdown('# Title only\n\nNo tables here.');
    expect(r.rows).toEqual([]);
  });

  it('extracts gpt-4o-mini in both chat_text and chat_vision', () => {
    const r = parseLmArenaMarkdown(SAMPLE_MD);
    const matches = r.rows.filter((row) => row.modelName === 'gpt-4o-mini-2024-07-18');
    expect(matches.length).toBe(2);
    const cats = new Set(matches.map((m) => m.category));
    expect(cats).toEqual(new Set(['chat_text', 'chat_vision']));
  });

  it('recognizes category names with digits (image_t2i, video_i2v)', () => {
    const md = `
## Category: image_t2i

| Rank | Model | Elo |
|-----:|-------|----:|
| 1 | model-x | 1300 |

## Category: video_i2v

| Rank | Model | Elo |
|-----:|-------|----:|
| 1 | model-y | 1200 |
`;
    const r = parseLmArenaMarkdown(md);
    const cats = new Set(r.rows.map((row) => row.category));
    expect(cats).toEqual(new Set(['image_t2i', 'video_i2v']));
    expect(r.warnings).toEqual([]);
  });
});

describe('01C.1B-J2-C-R4 §8 — matchLmArenaRowToCatalogModel', () => {
  const candidates: CandidateLike[] = [
    { canonicalModelId: 'claude-opus-4-7', modelId: 'anthropic/claude-opus-4.7', family: 'anthropic_claude' },
    { canonicalModelId: 'gpt-4o-mini', modelId: 'gpt-4o-mini', family: 'openai_gpt' },
    { canonicalModelId: 'moonshotai/kimi-k2.6', modelId: 'moonshotai/Kimi-K2.6', family: 'moonshot' },
  ];

  it('exact canonicalModelId → high confidence', () => {
    const r = matchLmArenaRowToCatalogModel('claude-opus-4-7', candidates);
    expect(r.matched).toBe(true);
    expect(r.matchKind).toBe('exact_canonical');
    expect(r.matchConfidence).toBe('high');
  });

  it('exact modelId → high confidence', () => {
    const r = matchLmArenaRowToCatalogModel('Moonshotai/Kimi-K2.6', candidates);
    expect(r.matched).toBe(true);
    // Note: canonicalizeLmArenaModelName lower-cases, matching canonicalModelId first
    expect(r.matchConfidence).toBe('high');
  });

  it('slug substring → medium confidence', () => {
    const r = matchLmArenaRowToCatalogModel('claude-opus-4-7-thinking', candidates);
    expect(r.matched).toBe(true);
    expect(r.matchKind).toBe('normalized_name');
    expect(r.matchConfidence).toBe('medium');
  });

  it('unmatched → placeholder confidence', () => {
    const r = matchLmArenaRowToCatalogModel('mystery-model-9000', candidates);
    expect(r.matched).toBe(false);
    expect(r.matchConfidence).toBe('placeholder');
  });

  it('empty candidates list → unmatched', () => {
    const r = matchLmArenaRowToCatalogModel('any-model', []);
    expect(r.matched).toBe(false);
    expect(r.matchReason).toBe('no_candidates_provided');
  });
});

describe('01C.1B-J2-C-R4 §8 — lmArenaRowsToCalibrationEntry', () => {
  const baseMatch = {
    matched: true as const,
    candidate: { canonicalModelId: 'claude-opus-4-7', family: 'anthropic_claude' },
    matchKind: 'exact_canonical' as const,
    matchConfidence: 'high' as const,
    matchReason: 'test',
  };

  it('produces an entry with multi-category coverage', () => {
    const rows: LmArenaRow[] = [
      { category: 'chat_text', rank: 4, modelName: 'claude-opus-4-7', elo: 1492, votes: 41203 },
      { category: 'chat_document', rank: 3, modelName: 'claude-opus-4-7', elo: 1510, votes: 8019 },
      { category: 'code_webdev', rank: 2, modelName: 'claude-opus-4-7', elo: 1559, votes: 13902 },
    ];
    const entry = lmArenaRowsToCalibrationEntry('claude-opus-4-7', rows, { match: baseMatch });
    expect(entry).toBeDefined();
    expect(entry!.qualityScoreSources).toEqual(['lmarena']);
    expect(entry!.qualityScoreSource).toBe('external_benchmark');
    expect(entry!.qualityConfidence).toBe('high');
    expect(entry!.taskCategoryScores).toBeDefined();
    expect(Object.keys(entry!.taskCategoryScores!).sort()).toEqual(['chat_document', 'chat_text', 'code_webdev']);
    expect(entry!.sourceScores).toBeDefined();
    expect(entry!.sourceScores!.length).toBe(1);
    expect(entry!.sourceScores![0].source).toBe('lmarena');
  });

  it('aggregate qualityScore equals MAX of category scores', () => {
    const rows: LmArenaRow[] = [
      { category: 'chat_text', rank: 4, modelName: 'claude-opus-4-7', elo: 1492, votes: 100 },
      { category: 'code_webdev', rank: 2, modelName: 'claude-opus-4-7', elo: 1559, votes: 100 },
    ];
    const entry = lmArenaRowsToCalibrationEntry('claude-opus-4-7', rows, { match: baseMatch });
    expect(entry).toBeDefined();
    // 1559 → (1559-900)/600 = 1.0983 → clamped to 1
    expect(entry!.qualityScore).toBe(1);
  });

  it('dedups within same category — keeps higher-votes row', () => {
    const rows: LmArenaRow[] = [
      { category: 'chat_text', rank: 4, modelName: 'claude-opus-4-7', elo: 1492, votes: 100 },
      { category: 'chat_text', rank: 4, modelName: 'claude-opus-4-7', elo: 1495, votes: 1000 },
    ];
    const entry = lmArenaRowsToCalibrationEntry('claude-opus-4-7', rows, { match: baseMatch });
    expect(entry).toBeDefined();
    // 1495 wins
    expect(entry!.taskCategoryScores!.chat_text).toBe(+((1495 - 900) / 600).toFixed(4));
  });

  it('attaches ATTRIBUTION_WARNING by default', () => {
    const rows: LmArenaRow[] = [
      { category: 'chat_text', rank: 1, modelName: 'm', elo: 1400 },
    ];
    const entry = lmArenaRowsToCalibrationEntry('m', rows, { match: baseMatch });
    expect(entry!.warnings.some((w) => w.includes('LMArena'))).toBe(true);
  });

  it('returns undefined for empty rows', () => {
    const entry = lmArenaRowsToCalibrationEntry('anything', [], { match: baseMatch });
    expect(entry).toBeUndefined();
  });

  it('returns undefined when all elos are unparseable', () => {
    const rows: LmArenaRow[] = [
      { category: 'chat_text', rank: 1, modelName: 'm', elo: NaN },
    ];
    const entry = lmArenaRowsToCalibrationEntry('m', rows, { match: baseMatch });
    expect(entry).toBeUndefined();
  });
});

describe('01C.1B-J2-C-R4 §8 — buildLmArenaQualitySnapshot', () => {
  const candidates: CandidateLike[] = [
    { canonicalModelId: 'claude-opus-4-7', modelId: 'anthropic/claude-opus-4.7', family: 'anthropic_claude' },
    { canonicalModelId: 'gpt-4o-mini', modelId: 'gpt-4o-mini', family: 'openai_gpt' },
    { canonicalModelId: 'nano-banana-pro-preview', modelId: 'nano-banana-pro-preview', family: 'google_image' },
  ];

  const rows: LmArenaRow[] = [
    { category: 'chat_text', rank: 4, modelName: 'claude-opus-4-7', elo: 1492, votes: 41203 },
    { category: 'chat_text', rank: 211, modelName: 'gpt-4o-mini-2024-07-18', elo: 1317, votes: 42081 },
    { category: 'chat_vision', rank: 96, modelName: 'gpt-4o-mini-2024-07-18', elo: 1098, votes: 5402 },
    { category: 'image_edit', rank: 3, modelName: 'nano-banana-pro-preview', elo: 1387, votes: 6210 },
    { category: 'chat_text', rank: 999, modelName: 'unknown-model-xyz', elo: 1000, votes: 100 },
  ];

  it('matches candidates and produces snapshot', () => {
    const result = buildLmArenaQualitySnapshot({
      rows,
      candidates,
      version: '1.0.0-test',
      sourceArtifacts: ['test-lmarena.md'],
    });
    expect(result.matched.length).toBe(3); // claude, gpt, nano
    expect(result.snapshot.entries.length).toBe(3);
    expect(result.skipped.some((s) => s.modelName.includes('unknown'))).toBe(true);
  });

  it('reports notCovered for candidates with no LMArena rows', () => {
    const result = buildLmArenaQualitySnapshot({
      rows: [{ category: 'chat_text', rank: 4, modelName: 'claude-opus-4-7', elo: 1492 }],
      candidates,
      version: '1.0.0-test',
      sourceArtifacts: [],
    });
    const notCoveredIds = result.notCovered.map((nc) => nc.candidateModelId);
    expect(notCoveredIds).toContain('gpt-4o-mini');
    expect(notCoveredIds).toContain('nano-banana-pro-preview');
  });

  it('produces valid snapshot per contract validator', () => {
    const result = buildLmArenaQualitySnapshot({
      rows,
      candidates,
      version: '1.0.0-test',
      sourceArtifacts: ['test.md'],
    });
    const v = validateSnapshot(result.snapshot);
    expect(v.valid).toBe(true);
  });

  it('emits unmatched rows when emitUnmatchedRows=true', () => {
    const result = buildLmArenaQualitySnapshot({
      rows,
      candidates,
      version: '1.0.0-test',
      sourceArtifacts: [],
      emitUnmatchedRows: true,
    });
    // 4 unique models matched/unmatched: claude, gpt-mini, nano, unknown
    expect(result.snapshot.entries.length).toBe(4);
  });

  it('gpt-4o-mini entry aggregates BOTH chat_text and chat_vision', () => {
    const result = buildLmArenaQualitySnapshot({
      rows,
      candidates,
      version: '1.0.0-test',
      sourceArtifacts: [],
    });
    const gpt = result.snapshot.entries.find((e) => e.canonicalModelId === 'gpt-4o-mini');
    expect(gpt).toBeDefined();
    expect(gpt!.taskCategoryScores).toBeDefined();
    expect(Object.keys(gpt!.taskCategoryScores!).sort()).toEqual(['chat_text', 'chat_vision']);
  });

  it('every produced entry has ATTRIBUTION_WARNING reference', () => {
    const result = buildLmArenaQualitySnapshot({
      rows,
      candidates,
      version: '1.0.0-test',
      sourceArtifacts: [],
    });
    for (const e of result.snapshot.entries) {
      expect(e.warnings.some((w) => w.includes('LMArena'))).toBe(true);
    }
    expect(ATTRIBUTION_WARNING).toContain('LMArena');
  });

  it('snapshot hash is deterministic for same input', async () => {
    const r1 = buildLmArenaQualitySnapshot({
      rows, candidates, version: '1.0.0-test', sourceArtifacts: [],
    });
    const r2 = buildLmArenaQualitySnapshot({
      rows, candidates, version: '1.0.0-test', sourceArtifacts: [],
    });
    // Note: hash depends on entries — but createdAt is ephemeral, hash computation
    // strips it. Both should produce same hash.
    const { computeSnapshotHash } = await import(
      '@/core/orchestration/role-selection/model-quality-calibration'
    );
    expect(computeSnapshotHash(r1.snapshot)).toBe(computeSnapshotHash(r2.snapshot));
  });
});
