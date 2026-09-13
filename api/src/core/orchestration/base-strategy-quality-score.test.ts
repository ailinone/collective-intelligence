// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * BaseStrategy.calculateQualityScore — verbosity-bias regression suite
 *
 * PRODUCTION SYMPTOM
 * ------------------
 * This scorer is separate from `QualityScorer` (core/quality/quality-scorer.ts)
 * and has a different job: QualityScorer feeds the cross-request model
 * performance EMA, while THIS one picks the winner WITHIN a single request —
 * `hybrid-strategy.selectBestExecution` (hybrid-strategy.ts:514),
 * `parallel-strategy.scoreExecution` (parallel-strategy.ts:683), and
 * cost-cascade's quality gate (cost-cascade-strategy.ts:556).
 *
 * Before this fix it was a pure LENGTH ladder:
 *
 *     0.7 base for any successful, usable response
 *     +0.1 if content.length > 500
 *     +0.1 if content.length > 1000
 *     +0.1 if it contains a code fence or a numbered list
 *
 * There was no correctness signal and no completion signal of any kind, so a
 * VERBOSE WRONG answer scored up to 0.9 and beat a CORRECT TERSE answer pinned
 * at the 0.7 floor. `selectBestExecution` takes the argmax, so in practice it
 * returned whichever model wrote the most words. On the standard arithmetic
 * probe ("Quanto e 17 vezes 23?", correct answer contains "391") that means a
 * rambling wrong answer was preferred over a bare correct "391".
 *
 * THE FIX
 * -------
 * Credit COMPLETION INTEGRITY instead of word count: a response the model chose
 * to end (`finish_reason === 'stop'`) is worth more than one the token limit cut
 * off mid-sentence. Unlike length, that does not scale with padding.
 *
 * LOAD-BEARING INVARIANT
 * ----------------------
 * Every successful, usable response must still score >= 0.7. cost-cascade's
 * default quality gate is QUALITY_THRESHOLD_BASE = 0.7 and its `executeStream`
 * doc comment reasons explicitly that "a successful rung can NEVER fail the
 * quality gate ... calculateQualityScore() floors every non-empty successful
 * response at 0.7". Every ailin-* alias request runs at that default threshold,
 * so dropping below the floor would silently turn cost-cascade's streaming path
 * into a reject-and-escalate path fleet-wide. The truncation signal therefore
 * WITHHOLDS credit rather than deducting below the floor, and the first test
 * below pins that invariant.
 */

import { describe, it, expect } from 'vitest';
import { BaseStrategy } from '@/core/orchestration/base-strategy';
import type {
  ChatRequest,
  ChatResponse,
  ModelExecution,
  OrchestrationContext,
  OrchestrationResult,
  StrategyMetadata,
} from '@/types';

/** Minimal concrete strategy exposing the protected scorer under test. */
class ProbeStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return { name: 'probe' } as unknown as StrategyMetadata;
  }
  async execute(
    _request: ChatRequest,
    _context: OrchestrationContext
  ): Promise<OrchestrationResult> {
    throw new Error('not used');
  }
  public score(execution: ModelExecution): number {
    return this.calculateQualityScore(execution);
  }
}

const strategy = new ProbeStrategy();

const req: ChatRequest = {
  model: 'auto',
  messages: [
    { role: 'user', content: 'Quanto e 17 vezes 23? Responda apenas com o numero final.' },
  ],
};

function mkExecution(
  text: string,
  opts: { finishReason?: 'stop' | 'length'; success?: boolean } = {}
): ModelExecution {
  const { finishReason = 'stop', success = true } = opts;
  const response = {
    id: 'r',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'm',
    choices: [
      { index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  } as ChatResponse;
  return {
    modelId: 'm',
    modelName: 'm',
    role: 'primary',
    request: req,
    response,
    cost: 0.0001,
    durationMs: 500,
    success,
  } as ModelExecution;
}

/** > 1000 chars of unstructured filler — max score under the OLD length ladder. */
const VERBOSE_WRONG = 'A resposta dessa multiplicacao e 407 conforme o calculo realizado. '.repeat(
  20
);
const VERBOSE_CORRECT = 'A resposta dessa multiplicacao e 391 conforme o calculo realizado. '.repeat(
  20
);

describe('BaseStrategy.calculateQualityScore — exact values', () => {
  it.each([
    // [label, text, finishReason, expected]
    ['terse correct, self-terminated', '391', 'stop', 0.85],
    ['terse correct, truncated', '391', 'length', 0.7],
    ['verbose wrong, self-terminated', VERBOSE_WRONG, 'stop', 0.85],
    ['verbose wrong, truncated', VERBOSE_WRONG, 'length', 0.7],
    ['terse correct with numbered list', '1. 391', 'stop', 0.95],
  ] as Array<[string, string, 'stop' | 'length', number]>)(
    '%s -> %s',
    (_label, text, finishReason, expected) => {
      expect(strategy.score(mkExecution(text, { finishReason }))).toBeCloseTo(expected, 10);
    }
  );

  it('returns 0 for a failed execution', () => {
    expect(strategy.score(mkExecution('391', { success: false }))).toBe(0);
  });
});

describe('BaseStrategy.calculateQualityScore — the fixed bias', () => {
  it('a verbose WRONG answer no longer OUTRANKS a terse correct one', () => {
    expect(VERBOSE_WRONG.length).toBeGreaterThan(1000);
    const verbose = strategy.score(mkExecution(VERBOSE_WRONG));
    const terse = strategy.score(mkExecution('391'));
    // Pre-fix: verbose 0.9 > terse 0.7 — selectBestExecution took the argmax and
    // therefore returned the longest answer. Post-fix they tie, and the tie is
    // broken by real structure signals rather than word count.
    expect(verbose).not.toBeGreaterThan(terse);
    expect(terse).toBeCloseTo(verbose, 10);
  });

  it('length alone buys nothing: correct terse and correct verbose score the same', () => {
    expect(strategy.score(mkExecution('391'))).toBeCloseTo(
      strategy.score(mkExecution(VERBOSE_CORRECT)),
      10
    );
  });

  it('a truncated answer scores strictly below a self-terminated one', () => {
    expect(strategy.score(mkExecution('391', { finishReason: 'length' }))).toBeLessThan(
      strategy.score(mkExecution('391', { finishReason: 'stop' }))
    );
  });
});

describe('BaseStrategy.calculateQualityScore — cost-cascade 0.7 floor invariant', () => {
  it.each([
    ['terse', '391', 'stop'],
    ['terse truncated', '391', 'length'],
    ['verbose', VERBOSE_WRONG, 'stop'],
    ['verbose truncated', VERBOSE_WRONG, 'length'],
    ['single char', 'x', 'length'],
    ['whitespace-padded short', '  391  ', 'length'],
  ] as Array<[string, string, 'stop' | 'length']>)(
    'every successful usable response stays >= 0.7 (%s)',
    (_label, text, finishReason) => {
      // cost-cascade's default gate is 0.7; a successful rung must never fail it.
      expect(strategy.score(mkExecution(text, { finishReason }))).toBeGreaterThanOrEqual(0.7);
    }
  );
});
