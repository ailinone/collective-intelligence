// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Judge-cost accounting — the LLM-as-judge is a real, billable inference that
 * was invisible to ALL experiment budget accounting: `judgeResponse` threw the
 * cost away in both modes (dynamic: `r.judgeCostUsd` unread; pinned HTTP: the
 * response type omitted `ailin_metadata.cost_usd`), so a run could overspend
 * `maxBudgetUsd` by the entire judge total with zero visibility.
 *
 * These tests pin the capture layer: `judgeResponse` must return the billable
 * judge cost as `judgeCostUsd`, accumulated across every call actually made
 * (retries and failed dynamic attempts included — money spent on a verdict
 * that didn't parse is still money spent). The loop then records it as a
 * SEPARATE spend line ('judge'), never folded into the arm's costUsd, so the
 * cross-arm cost-effectiveness comparison stays clean.
 *
 * The judge identity is frozen at module load (review F1), so each scenario
 * re-imports the module under a fresh env — same pattern as
 * judge-instrument-pinned.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.doUnmock('@/core/quality/quality-scorer.js');
  vi.doUnmock('@/database/client');
  vi.resetModules();
});

async function importUnderEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../experiment-runner');
}

/** Minimal fetch-Response stand-in for the pinned HTTP judge path. */
function httpJudgeResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const CANONICAL_VERDICT = JSON.stringify({ score: 0.8, issues: [] });

describe('judgeResponse — pinned HTTP path', () => {
  it('captures ailin_metadata.cost_usd from the judge call', async () => {
    const mod = await importUnderEnv({ JUDGE_MODE: undefined, EXPERIMENT_JUDGE_MODEL: 'prov/judge-model-x' });
    vi.stubGlobal('fetch', vi.fn(async () => httpJudgeResponse({
      model: 'prov/judge-model-x',
      choices: [{ message: { content: CANONICAL_VERDICT } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      ailin_metadata: { cost_usd: 0.01 },
    })));

    const outcome = await mod.judgeResponse('a perfectly reasonable response', 'rubric: correctness');
    expect(outcome.judgeFailed).toBe(false);
    expect(outcome.score).toBeCloseTo(0.8, 10);
    expect(outcome.judgeCostUsd).toBeCloseTo(0.01, 10);
  });

  it('falls back to DB model pricing when ailin_metadata.cost_usd is absent', async () => {
    vi.doMock('@/database/client', () => ({
      prisma: {
        model: {
          findFirst: vi.fn(async () => ({
            inputCostPer1k: 0.003,
            outputCostPer1k: 0.015,
            name: 'judge-model-x',
          })),
        },
      },
    }));
    const mod = await importUnderEnv({ JUDGE_MODE: undefined, EXPERIMENT_JUDGE_MODEL: 'prov/judge-model-x' });
    vi.stubGlobal('fetch', vi.fn(async () => httpJudgeResponse({
      model: 'prov/judge-model-x',
      choices: [{ message: { content: CANONICAL_VERDICT } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    })));

    const outcome = await mod.judgeResponse('a response', 'rubric');
    expect(outcome.judgeFailed).toBe(false);
    // 100/1000 * 0.003 + 50/1000 * 0.015 = 0.00105
    expect(outcome.judgeCostUsd).toBeCloseTo(0.00105, 10);
  });

  it('accumulates the cost of EVERY billed attempt when no verdict ever parses (failed judging is not free)', async () => {
    const mod = await importUnderEnv({ JUDGE_MODE: undefined, EXPERIMENT_JUDGE_MODEL: 'prov/judge-model-x' });
    const fetchMock = vi.fn(async () => httpJudgeResponse({
      model: 'prov/judge-model-x',
      // No digits anywhere: defeats canonical parse, regex salvage AND the
      // plain-number back-compat extractor, so every attempt is consumed.
      choices: [{ message: { content: 'unusable verdict with no numerals whatsoever' } }],
      ailin_metadata: { cost_usd: 0.01 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await mod.judgeResponse('some response body long enough to score', 'rubric');
    expect(outcome.judgeFailed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + MAX_JUDGE_RETRIES(3)
    expect(outcome.judgeCostUsd).toBeCloseTo(0.04, 10);
  });

  it('returns judgeCostUsd 0 on the heuristic fallback when every attempt errored before billing', async () => {
    const mod = await importUnderEnv({ JUDGE_MODE: undefined, EXPERIMENT_JUDGE_MODEL: 'prov/judge-model-x' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const outcome = await mod.judgeResponse('some response', 'rubric');
    expect(outcome.judgeFailed).toBe(true);
    expect(outcome.judgeCostUsd).toBe(0);
  });
});

describe('judgeResponse — dynamic (in-process cascade) path', () => {
  it('propagates judgeCostUsd from calculatePolicyAwareScore', async () => {
    vi.doMock('@/core/quality/quality-scorer.js', () => ({
      getQualityScorer: () => ({
        calculatePolicyAwareScore: vi.fn(async () => ({
          overall: 0.9,
          dimensions: { correctness: 0.9, completeness: 0.9, clarity: 0.9, efficiency: 0.9, relevance: 0.9 },
          confidence: 0.85,
          reasoning: [],
          method: 'llm-judge',
          policy: 'benchmark',
          judgeFailed: false,
          judgeScore: 0.9,
          judgeCostUsd: 0.02,
        })),
      }),
    }));
    const mod = await importUnderEnv({ JUDGE_MODE: 'dynamic', EXPERIMENT_JUDGE_MODEL: undefined });

    const outcome = await mod.judgeResponse('a response', 'rubric');
    expect(outcome.judgeFailed).toBe(false);
    expect(outcome.score).toBeCloseTo(0.9, 10);
    expect(outcome.judgeModelId).toBe('dynamic-cascade');
    expect(outcome.judgeCostUsd).toBeCloseTo(0.02, 10);
  });

  it('still bills a FAILED dynamic attempt and adds the pinned fallback cost on top', async () => {
    vi.doMock('@/core/quality/quality-scorer.js', () => ({
      getQualityScorer: () => ({
        calculatePolicyAwareScore: vi.fn(async () => ({
          overall: 0.5,
          dimensions: { correctness: 0.5, completeness: 0.5, clarity: 0.5, efficiency: 0.5, relevance: 0.5 },
          confidence: 0.1,
          reasoning: ['WARNING: LLM-Judge failed'],
          method: 'heuristic',
          policy: 'benchmark',
          judgeFailed: true,
          heuristicScore: 0.5,
          judgeCostUsd: 0.005, // the failed judge sub-call was still charged
        })),
      }),
    }));
    const mod = await importUnderEnv({ JUDGE_MODE: 'dynamic', EXPERIMENT_JUDGE_MODEL: undefined });
    vi.stubGlobal('fetch', vi.fn(async () => httpJudgeResponse({
      model: 'prov/judge-model-x',
      choices: [{ message: { content: CANONICAL_VERDICT } }],
      ailin_metadata: { cost_usd: 0.01 },
    })));

    const outcome = await mod.judgeResponse('a response', 'rubric');
    expect(outcome.judgeFailed).toBe(false); // pinned fallback produced the verdict
    expect(outcome.score).toBeCloseTo(0.8, 10);
    expect(outcome.judgeCostUsd).toBeCloseTo(0.015, 10); // 0.005 dynamic + 0.01 pinned
  });
});
