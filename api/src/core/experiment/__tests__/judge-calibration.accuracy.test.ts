// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Accuracy axis of judge calibration.
 *
 * The legacy report measured only stdDev (NOISE) — the right gate for a PINNED
 * judge. A DYNAMIC judge (provider-diverse fallback cascade) is variance-rich by
 * design, so it must instead be gated on ACCURACY: does each verdict track the
 * human gold label? These tests pin that behaviour, and crucially the
 * "accurate-but-noisy" case proves the two axes are independent.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { calibrateJudge } from '@/core/experiment/judge-calibration';

// Gold labels, in CALIBRATION_CASES order (perfect, mediocre, wrong, detailed).
const GOLD = [0.95, 0.5, 0.0, 0.85];
const RUNS = 2; // minScoresPerCase = max(2, ceil(RUNS/2)) = 2 → exactly enough

/**
 * Mock the judge HTTP self-call. `seq` is the score returned per call, in order
 * (cases run sequentially, RUNS calls each); a null entry returns unparseable
 * content so no score is collected for that run.
 */
function mockJudge(seq: Array<number | null>): void {
  let call = 0;
  global.fetch = vi.fn(async () => {
    const score = seq[call++];
    const content = score === null
      ? 'sorry, I cannot produce JSON'
      : JSON.stringify({ score, issues: [], summary: 's', confidence: 0.9 });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const cfg = { runs: RUNS, apiBase: 'http://judge.local', bearerToken: 't', judgeModel: 'test-judge' };

// Build a per-call sequence from a per-case score picker.
const seqFrom = (pick: (caseIdx: number, run: number) => number | null): Array<number | null> =>
  GOLD.flatMap((_g, c) => Array.from({ length: RUNS }, (_v, r) => pick(c, r)));

afterEach(() => { vi.restoreAllMocks(); });

describe('judge calibration — accuracy axis (vs gold)', () => {
  it('accurate + consistent judge → accurate=true, reliable=true, ~0 error', async () => {
    mockJudge(seqFrom((c) => GOLD[c]));
    const r = await calibrateJudge(cfg);
    expect(r.enoughData).toBe(true);
    expect(r.maxAbsError).toBeLessThan(1e-9);
    expect(r.accurate).toBe(true);
    expect(r.reliable).toBe(true);
  });

  it('inaccurate judge (one case far from gold) → accurate=false', async () => {
    // Case 0 gold 0.95 but judge says 0.50 → absError 0.45 ≫ 0.15.
    mockJudge(seqFrom((c) => (c === 0 ? 0.5 : GOLD[c])));
    const r = await calibrateJudge(cfg);
    expect(r.maxAbsError).toBeGreaterThan(0.4);
    expect(r.accurate).toBe(false);
  });

  it('accurate BUT noisy → accurate=true while reliable=false (axes are independent)', async () => {
    // Per case, two verdicts straddling the gold: mean ≈ gold (accurate) but
    // wide spread (noisy). This is exactly a healthy provider-diverse cascade.
    const spread: Record<number, [number, number]> = {
      0: [0.95, 0.78], // mean 0.865, err 0.085
      1: [0.62, 0.38], // mean 0.50,  err 0
      2: [0.1, 0.0],   // mean 0.05,  err 0.05
      3: [0.95, 0.75], // mean 0.85,  err 0
    };
    mockJudge(seqFrom((c, run) => spread[c][run]));
    const r = await calibrateJudge(cfg);
    expect(r.maxAbsError).toBeLessThan(0.15);
    expect(r.accurate).toBe(true);          // tracks the gold
    expect(r.maxStdDev).toBeGreaterThan(0.1);
    expect(r.reliable).toBe(false);         // but variance-rich
  });

  it('unreachable judge (no parseable scores) → enoughData=false, accurate=false, NaN error', async () => {
    mockJudge(seqFrom(() => null));
    const r = await calibrateJudge(cfg);
    expect(r.totalScoresCollected).toBe(0);
    expect(r.enoughData).toBe(false);
    expect(r.accurate).toBe(false);
    expect(Number.isNaN(r.maxAbsError)).toBe(true);
  });

  it('non-gated case (mediocre, index 1) does NOT fail the accuracy gate', async () => {
    // Gated cases (0,2,3) hit gold; the non-gated mediocre is wildly off — the
    // gate must stay green because only unambiguous (gated) cases count.
    mockJudge(seqFrom((c) => (c === 1 ? 0.0 : GOLD[c])));
    const r = await calibrateJudge(cfg);
    expect(r.results[1].gated).toBe(false);
    expect(r.results[1].absError).toBeGreaterThan(0.4); // still measured + reported
    expect(r.accurate).toBe(true);                       // but does not gate
  });

  it('every case carries its gold label, gated flag + per-case absError', async () => {
    mockJudge(seqFrom((c) => GOLD[c]));
    const r = await calibrateJudge(cfg);
    expect(r.results.map((x) => x.expectedScore)).toEqual(GOLD);
    expect(r.results.map((x) => x.gated)).toEqual([true, false, true, true]);
    expect(r.results.every((x) => x.absError < 1e-9)).toBe(true);
  });
});
