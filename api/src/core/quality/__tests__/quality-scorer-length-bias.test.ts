// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * QualityScorer — terse-answer bias regression suite
 *
 * PRODUCTION SYMPTOM
 * ------------------
 * An audit of 12 orchestration strategies x 4 trials against production, using
 * the prompt "Quanto e 17 vezes 23? Responda apenas com o numero final."
 * (correct answer contains "391"), found 29% of answers wrong (34/48 correct).
 *
 * Investigating why, the heuristic scorer turned out to be structurally biased
 * AGAINST the correct answer. Scoring the ideal response — the bare string
 * "391", from a successful, fast, cheap execution on a non-code task — produced:
 *
 *     correctness   0.70   (0.5 base + 0.1 no error words + 0.1 execution ok)
 *     completeness  0.30   (0.5 base - 0.2 because content.length < 100)
 *     clarity       0.50   (0.5 base, no headings/lists/formatting to credit)
 *     efficiency    1.00   (0.5 base + 0.25 fast + 0.25 cheap)
 *     relevance     0.50   (0.5 base; no task keyword dict for a factual/math Q)
 *     overall       0.57   = .35*.70 + .25*.30 + .15*.50 + .10*1.00 + .15*.50
 *
 * That 0.57 is the number written into the model-performance EMA
 * (orchestration-engine.ts -> modelPerformanceTracker.updateQualityOnly, EMA
 * alpha 0.1, seeded at 0.8 by base-strategy.ts). Every never-executed model in
 * the catalog carries a discovery-time placeholder of exactly 0.8 — verified
 * 2026-08-28 against the production DB: 106,630 of 107,146 rows sit at
 * quality = 0.8. `modelPerformanceTracker.applyToModel` then overlays the EMA
 * onto candidate models immediately before selection
 * (orchestration-engine.ts:4094), and the eligible pool is sorted by
 * `performance.quality` DESC (base-strategy.ts:403).
 *
 * So a model that answered CORRECTLY and CONCISELY was ranked strictly BELOW
 * every model that had never been tried: the EMA walks 0.8 -> 0.777 -> 0.756 ->
 * 0.737 -> 0.720 -> 0.705 -> 0.692 ... converging on 0.57. The more evidence
 * the system gathered that a model was good, the less it used it. This is also
 * why PR #420 (preserving measured performance across discovery syncs) made
 * `single` and `parallel` WORSE (4/4 -> 0/4) and had to be reverted as #422:
 * it made a demotion that used to be wiped on every sync permanent instead.
 *
 * WHAT THE FIX DOES — AND DELIBERATELY DOES NOT DO
 * ------------------------------------------------
 * It removes length as a standalone proxy on three axes:
 *   - completeness is measured against DEMAND (`elaborationDemanded`), with
 *     emptiness and truncation kept as the real incompleteness signals;
 *   - clarity stops requiring markdown from content too short to need it;
 *   - relevance recognises a bare answer as direct, not just English preambles;
 *   - efficiency stops paying speed/cost credit to a response that delivered
 *     nothing at all.
 *
 * It does NOT invent a correctness signal. A heuristic scorer cannot tell "391"
 * from "392", and this suite asserts that explicitly (see the final case): both
 * score identically. Correctness discrimination is the LLM judge's job
 * (calculatePolicyAwareScore). The point of this change is to stop PENALISING
 * the correct terse answer, not to start rewarding terseness.
 */

import { describe, it, expect } from 'vitest';
import { getQualityScorer } from '@/core/quality/quality-scorer';
import type {
  ChatResponse,
  ChatRequest,
  ModelExecution,
  OrchestrationContext,
  TaskType,
} from '@/types';

const req: ChatRequest = {
  model: 'auto',
  messages: [
    { role: 'user', content: 'Quanto e 17 vezes 23? Responda apenas com o numero final.' },
  ],
};

function mkResponse(text: string, finishReason: 'stop' | 'length' = 'stop'): ChatResponse {
  return {
    id: 'resp-1',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'test-model',
    choices: [
      { index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
  } as ChatResponse;
}

/** A fast (500ms), cheap ($0.0001), successful execution — the probe's shape. */
function mkExecution(response: ChatResponse, success = true): ModelExecution {
  return {
    modelId: 'test-model',
    modelName: 'test-model',
    role: 'primary',
    request: req,
    response,
    cost: 0.0001,
    durationMs: 500,
    success,
  } as ModelExecution;
}

function mkContext(taskType: TaskType = 'general'): OrchestrationContext {
  return { models: [], taskType, contextSize: 100 } as unknown as OrchestrationContext;
}

/** Verbose filler with no markdown structure, > 500 chars. */
const VERBOSE_WRONG = 'A resposta para essa multiplicacao é 407 conforme o calculo feito. '.repeat(
  12
);
const VERBOSE_CORRECT = 'A resposta para essa multiplicacao é 391 conforme o calculo feito. '.repeat(
  12
);

const scorer = getQualityScorer();

describe('QualityScorer — terse correct answers are no longer structurally penalised', () => {
  it('scores the bare correct answer "391" at the exact expected dimensions', () => {
    const r = scorer.calculateScore(mkResponse('391'), mkContext('general'), mkExecution(mkResponse('391')));

    // completeness: 0.5 base + 0.35 (no elaboration demanded, nothing missing)
    expect(r.dimensions.completeness).toBeCloseTo(0.85, 10);
    // clarity: 0.5 base + 0.2 (too short to need structure) + 0.1 (short sentences)
    expect(r.dimensions.clarity).toBeCloseTo(0.8, 10);
    // relevance: 0.5 base + 0.1 (bare answer counts as direct)
    expect(r.dimensions.relevance).toBeCloseTo(0.6, 10);
    // unchanged axes
    expect(r.dimensions.correctness).toBeCloseTo(0.7, 10);
    expect(r.dimensions.efficiency).toBeCloseTo(1.0, 10);

    // overall = .35*.70 + .25*.85 + .15*.80 + .10*1.0 + .15*.60
    expect(r.dimensions.correctness * 0.35 +
      r.dimensions.completeness * 0.25 +
      r.dimensions.clarity * 0.15 +
      r.dimensions.efficiency * 0.10 +
      r.dimensions.relevance * 0.15).toBeCloseTo(0.7675, 10);
    expect(r.overall).toBeCloseTo(0.7675, 10);
  });

  it('lifts the terse answer far above the pre-fix 0.57 and near the 0.8 catalog placeholder', () => {
    const r = scorer.calculateScore(mkResponse('391'), mkContext('general'), mkExecution(mkResponse('391')));
    // Pre-fix value, recomputed by hand in the doc comment above.
    const PRE_FIX = 0.57;
    const CATALOG_PLACEHOLDER = 0.8;
    expect(r.overall).toBeGreaterThan(PRE_FIX);
    // The demotion gap against a never-executed model shrinks from 0.23 to <0.04.
    expect(CATALOG_PLACEHOLDER - r.overall).toBeLessThan(0.04);
  });

  it('no longer lets a verbose WRONG answer outrank a terse CORRECT one', () => {
    const terse = scorer.calculateScore(
      mkResponse('391'),
      mkContext('general'),
      mkExecution(mkResponse('391'))
    );
    const verbose = scorer.calculateScore(
      mkResponse(VERBOSE_WRONG),
      mkContext('general'),
      mkExecution(mkResponse(VERBOSE_WRONG))
    );
    expect(VERBOSE_WRONG.length).toBeGreaterThan(500);
    expect(terse.overall).toBeGreaterThan(verbose.overall);
  });

  it('is honest about its limits: it cannot tell a correct number from a wrong one', () => {
    const right = scorer.calculateScore(mkResponse('391'), mkContext('general'), mkExecution(mkResponse('391')));
    const wrong = scorer.calculateScore(mkResponse('392'), mkContext('general'), mkExecution(mkResponse('392')));
    // Identical by construction — correctness discrimination is the LLM judge's
    // job. This test exists so nobody mistakes the fix for a correctness signal.
    expect(right.overall).toBeCloseTo(wrong.overall, 10);
  });
});

describe('QualityScorer — genuine incompleteness signals still bite', () => {
  it('scores an EMPTY response at completeness 0 and withholds efficiency credit', () => {
    const r = scorer.calculateScore(mkResponse(''), mkContext('general'), mkExecution(mkResponse('')));
    expect(r.dimensions.completeness).toBe(0);
    // Was 1.0 pre-fix: fast + cheap paid full credit for delivering nothing.
    expect(r.dimensions.efficiency).toBeCloseTo(0.5, 10);
  });

  it('deducts 0.3 from completeness when the answer was TRUNCATED', () => {
    const cut = mkResponse('391', 'length');
    const r = scorer.calculateScore(cut, mkContext('general'), mkExecution(cut));
    // 0.5 base + 0.35 (no elaboration demanded) - 0.3 (finish_reason=length)
    expect(r.dimensions.completeness).toBeCloseTo(0.55, 10);
  });
});

describe('QualityScorer — code/elaborative tasks keep their original length behaviour', () => {
  const CODE = [
    'Here is the function:',
    '',
    '```python',
    'def mul(a, b):',
    '    return a * b',
    '```',
    '',
    '### Notes',
    '- Works for ints and floats',
    '- For example, mul(17, 23) returns 391 because multiplication is repeated addition.',
  ].join('\n');

  it.each([
    ['code-generation', true],
    ['documentation', true],
    ['analysis', true],
    ['general', false],
    ['qa', false],
    ['factual-qa', false],
  ] as Array<[TaskType, boolean]>)(
    'taskType %s demands elaboration: %s',
    (taskType, demanded) => {
      // A 30-char answer: penalised only where elaboration is genuinely demanded.
      const short = 'The result of the sum is 391.';
      const r = scorer.calculateScore(
        mkResponse(short),
        mkContext(taskType),
        mkExecution(mkResponse(short))
      );
      if (demanded) {
        // 0.5 base - 0.2 (short, elaboration demanded); code-generation adds no
        // code/text bonus here because there is no fenced block.
        expect(r.dimensions.completeness).toBeLessThanOrEqual(0.4);
      } else {
        expect(r.dimensions.completeness).toBeGreaterThanOrEqual(0.85);
      }
    }
  );

  it('an elaborated code answer is unaffected by the fix (still scores well)', () => {
    const r = scorer.calculateScore(
      mkResponse(CODE),
      mkContext('code-generation'),
      mkExecution(mkResponse(CODE))
    );
    expect(r.overall).toBeGreaterThan(0.7);
  });

  it('capabilityInference.contextNeeds=short overrides an elaborative taskType', () => {
    const ctx = {
      models: [],
      taskType: 'analysis' as TaskType,
      contextSize: 100,
      capabilityInference: { contextNeeds: 'short' },
    } as unknown as OrchestrationContext;
    const short = 'The result of the sum is 391.';
    const r = scorer.calculateScore(mkResponse(short), ctx, mkExecution(mkResponse(short)));
    expect(r.dimensions.completeness).toBeGreaterThanOrEqual(0.85);
  });
});
