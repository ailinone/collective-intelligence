// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * createModelExecution -> ExecutionFeedbackCollector quality signal
 *
 * PRODUCTION SYMPTOM — the stored "quality" column was a verbosity meter
 * ---------------------------------------------------------------------
 * `BaseStrategy.createModelExecution` fans every execution out to
 * `ExecutionFeedbackCollector.record({ qualityScore })`. That value is NOT
 * observability-only: `flushPerformanceUpdates()`
 * (core/feedback/execution-feedback-collector.ts:188) writes it into
 * `models.performance.quality` with an EMA of
 *
 *     q' = 0.3 * observed + 0.7 * q      (q seeded at the 0.8 catalog placeholder)
 *
 * and `getEligibleModels()` then HARD-FILTERS the chat candidate pool on
 * `quality < DEFAULT_MIN_QUALITY` (0.4, base-strategy.ts) and ranks the
 * survivors by that same column (base-strategy.ts:403,
 * dynamic-model-selector.ts:2283 and :3155).
 *
 * The value being fed in was:
 *
 *     estimatedQuality = success ? min(1, max(0.1, content.length / 3000)) : 0
 *
 * — literally a character count, carrying the comment "judge score comes later
 * via experiment runner". The judge score does not come later on this path.
 *
 * So a model answering the standard arithmetic probe perfectly ("391", 3 chars)
 * scored 0.1, and its stored quality walked:
 *
 *     0.8 -> 0.59 -> 0.443 -> 0.34 -> 0.268 -> ... -> 0.1
 *
 * VERIFIED against the production DB on 2026-08-28: the quality histogram
 * matches that sequence term for term — 0.59 (15 rows), 0.443 (6 rows), 0.34
 * (4 rows), 0.101 (4 rows) — while 106,630 of 107,146 rows sit untouched at the
 * 0.8 discovery placeholder. Crossing below 0.4 takes THREE concise answers,
 * after which the model is evicted from the chat pool entirely, while a model
 * that rambles toward the 3000-char ceiling climbs past 0.9.
 *
 * That is the ratchet behind the probe's wrong answers, and it is also why
 * PR #420 regressed `single`/`parallel` to 0/4: preserving performance across
 * discovery syncs removed the hourly reset to 0.8 that had been rescuing
 * demoted models, making the demotion permanent.
 *
 * THE FIX: feed the strategy's own quality heuristic
 * (`calculateQualityScore`) instead of a character count — 0 for a failed or
 * unusable response, >= 0.7 for a successful one, credited on completion
 * integrity and structure rather than length.
 *
 * As everywhere else in this scorer family, this cannot detect a WRONG answer.
 * It stops punishing a right one for being short.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const recorded: Array<{ modelId: string; qualityScore?: number; success: boolean }> = [];

vi.mock('@/core/feedback/execution-feedback-collector', () => ({
  getExecutionFeedbackCollector: () => ({
    record: (f: { modelId: string; qualityScore?: number; success: boolean }) => {
      recorded.push(f);
    },
  }),
}));

import { BaseStrategy } from '@/core/orchestration/base-strategy';
import type {
  ChatRequest,
  ChatResponse,
  Model,
  OrchestrationContext,
  OrchestrationResult,
  ProviderAdapter,
  StrategyMetadata,
} from '@/types';

class ProbeStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return { name: 'probe' } as unknown as StrategyMetadata;
  }
  async execute(
    _r: ChatRequest,
    _c: OrchestrationContext
  ): Promise<OrchestrationResult> {
    throw new Error('not used');
  }
  public make(text: string, success = true) {
    const response = {
      id: 'r',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'm',
      choices: [
        { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as ChatResponse;
    return this.createModelExecution(
      { id: 'm', name: 'm', provider: 'p' } as Model,
      { getName: () => 'p' } as ProviderAdapter,
      'primary',
      { model: 'auto', messages: [] } as ChatRequest,
      response,
      0.0001,
      500,
      success,
      success ? undefined : 'boom'
    );
  }
}

const strategy = new ProbeStrategy();

/** The old formula, kept so the regression is stated in executable form. */
const oldFormula = (text: string, success = true) =>
  success ? Math.min(1, Math.max(0.1, text.length / 3000)) : 0;

/** The collector's DB EMA, seeded at the catalog placeholder. */
function emaFrom(seed: number, observed: number, steps: number): number {
  let q = seed;
  for (let i = 0; i < steps; i++) q = 0.3 * observed + 0.7 * q;
  return Math.round(q * 1000) / 1000;
}

const VERBOSE = 'x'.repeat(3000);

beforeEach(() => {
  recorded.length = 0;
});

describe('feedback quality signal is no longer a character count', () => {
  it('records >= 0.7 for a terse successful answer (was 0.1)', () => {
    strategy.make('391');
    expect(recorded).toHaveLength(1);
    expect(oldFormula('391')).toBeCloseTo(0.1, 10); // the regression, stated
    expect(recorded[0].qualityScore).toBeCloseTo(0.85, 10);
  });

  it('records 0 for a failed execution', () => {
    strategy.make('391', false);
    expect(recorded[0].qualityScore).toBe(0);
  });

  it('a 3000-char ramble no longer outscores a correct terse answer', () => {
    strategy.make('391');
    strategy.make(VERBOSE);
    const [terse, verbose] = recorded;
    // Old behaviour: 0.1 vs 1.0 — a 10x advantage for padding.
    expect(oldFormula('391')).toBeCloseTo(0.1, 10);
    expect(oldFormula(VERBOSE)).toBeCloseTo(1.0, 10);
    expect(verbose.qualityScore).not.toBeGreaterThan(terse.qualityScore!);
  });
});

describe('the production ratchet this removes', () => {
  it('reproduces the exact stored-quality sequence seen in production', () => {
    // Seeded at the 0.8 discovery placeholder, fed the old terse score of 0.1.
    // These four values, with these row counts, are what the production DB held
    // on 2026-08-28: 0.59 (15 rows), 0.443 (6), 0.34 (4), 0.101 (4).
    expect(emaFrom(0.8, 0.1, 1)).toBeCloseTo(0.59, 3);
    expect(emaFrom(0.8, 0.1, 2)).toBeCloseTo(0.443, 3);
    expect(emaFrom(0.8, 0.1, 3)).toBeCloseTo(0.34, 3);
    // Below DEFAULT_MIN_QUALITY (0.4) after three concise answers — the point at
    // which getEligibleModels() drops the model from the chat pool entirely.
    expect(emaFrom(0.8, 0.1, 3)).toBeLessThan(0.4);
  });

  it('post-fix, a model answering concisely converges ABOVE the 0.8 placeholder', () => {
    strategy.make('391');
    const observed = recorded[0].qualityScore!;
    // Never crosses below the 0.4 pool-eviction threshold at any step ...
    for (let steps = 1; steps <= 25; steps++) {
      expect(emaFrom(0.8, observed, steps)).toBeGreaterThan(0.4);
    }
    // ... and settles at/above the placeholder rather than beneath it, so
    // measuring a model no longer demotes it below never-measured ones.
    expect(emaFrom(0.8, observed, 25)).toBeGreaterThanOrEqual(0.8);
  });
});
