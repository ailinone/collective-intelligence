// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Proves the v4 verifiable-task chain end to end at the module boundary:
 *   task.answerCheck  → resolveAnswerChecker → predicate → selectWithVerification
 * i.e. a benchmark task's declarative check actually arms the collective's
 * best-of-N override. If this passes, an HTTP request carrying
 * ailin_constraints.answer_check reaches the consensus strategy as a working
 * verifier (the engine wiring is a one-line resolve on the same predicate).
 */
import { describe, it, expect } from 'vitest';
import { EXPERIMENT_SUITE } from '../experiment-suite';
import { resolveAnswerChecker, type AnswerCheckSpec } from '@/core/orchestration/verification/answer-check-resolver';
import { selectWithVerification } from '@/core/orchestration/verification/verified-selection';

const verifiable = EXPERIMENT_SUITE.filter((t) => t.answerCheck);

describe('v4 verifiable tasks — declarative check chain', () => {
  it('the suite ships a non-trivial verifiable subset', () => {
    expect(verifiable.length).toBeGreaterThanOrEqual(8);
  });

  it('every answerCheck resolves to a working predicate', () => {
    for (const t of verifiable) {
      const checker = resolveAnswerChecker(t.answerCheck as AnswerCheckSpec);
      expect(checker, `task ${t.index} answerCheck must resolve`).not.toBeNull();
    }
  });

  it('each FINAL-scope verifiable prompt requests a FINAL: line (unambiguous extraction)', () => {
    // Full-scope tasks (canvas-physics code) check the ENTIRE reply, not a FINAL
    // line — they legitimately do not ask for one.
    for (const t of verifiable) {
      if (t.answerCheckScope === 'full') continue;
      expect(t.prompt, `task ${t.index} must ask for FINAL:`).toMatch(/FINAL:/);
    }
  });

  it('coffee-shop task (116): a checker-verified voter overrides a wrong synthesis', () => {
    const task = EXPERIMENT_SUITE.find((t) => t.index === 116)!;
    const checker = resolveAnswerChecker(task.answerCheck as AnswerCheckSpec)!;
    // Synthesis followed a wrong majority; one voter got it right.
    const r = selectWithVerification({
      synthesisText: 'After combining, FINAL: 1000',
      candidateTexts: [
        'old revenue was 1000 so FINAL: 1000',
        'lost 30 customers... FINAL: 1000',
        '200*0.85=170, 170*6=1020, FINAL: 1020',
      ],
      checker,
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(2);
  });

  it('canvas task (136): the SELECTION side rejects a token-cap-clipped candidate (PR #124 mirror)', () => {
    // Same blind spot the experiment grading fixed: the three structural
    // needles sit in the first ~300 bytes, so a candidate clipped at the token
    // cap still passes the raw checker while being a non-executable file. The
    // task's completion signals must flow into best-of-N selection and
    // disqualify it there too.
    const task = EXPERIMENT_SUITE.find((t) => t.index === 136)!;
    const checker = resolveAnswerChecker(task.answerCheck as AnswerCheckSpec)!;
    const complete = [
      '<!DOCTYPE html><html><body><canvas id="c" width="800" height="600"></canvas>',
      '<script>',
      "const ctx = document.getElementById('c').getContext('2d');",
      'function loop(){ ctx.clearRect(0,0,800,600); requestAnimationFrame(loop); }',
      'requestAnimationFrame(loop);',
      '</script></body></html>',
    ].join('\n');
    const clipped = complete.slice(0, complete.lastIndexOf('\n</script>'));
    expect(checker(clipped)).toBe(true); // the raw checker alone WOULD pass it

    const r = selectWithVerification({
      synthesisText: null,
      candidateTexts: [clipped, complete],
      checker,
      scope: task.answerCheckScope,
      completionAnyOf: task.answerCheckCompletionAnyOf,
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(1); // the COMPLETE candidate, never the clipped one
    expect(r.verify.verifiedCount).toBe(1);
  });

  it('speed-of-light task (119): tolerates surrounding prose in the FINAL answer', () => {
    const task = EXPERIMENT_SUITE.find((t) => t.index === 119)!;
    const checker = resolveAnswerChecker(task.answerCheck as AnswerCheckSpec)!;
    expect(checker('299792458')).toBe(true);
    expect(checker('299792459')).toBe(false);
  });

  it('binary-search task (120): regex check accepts O(log n) spacing variants', () => {
    const task = EXPERIMENT_SUITE.find((t) => t.index === 120)!;
    const checker = resolveAnswerChecker(task.answerCheck as AnswerCheckSpec)!;
    expect(checker('O(log n)')).toBe(true);
    expect(checker('O(logn)')).toBe(true);
    expect(checker('O(n log n)')).toBe(false);
  });

  it('capital task (122): string check is case-insensitive, rejects the distractor', () => {
    const task = EXPERIMENT_SUITE.find((t) => t.index === 122)!;
    const checker = resolveAnswerChecker(task.answerCheck as AnswerCheckSpec)!;
    expect(checker('canberra')).toBe(true);
    expect(checker('Sydney')).toBe(false);
  });

  it('locale: a comma-decimal FINAL answer survives the extract→check chain', () => {
    // Latent-landmine guard: today every numeric_equals prompt in the suite forces
    // dot-decimal, but the primitives are production-scoped — a pt-BR "98,41" must
    // grade as 98.41 (pre-fix it collapsed to 9841 and flipped the verdict).
    const spec: AnswerCheckSpec = { kind: 'numeric_equals', expected: 98.41 };
    const checker = resolveAnswerChecker(spec)!;
    expect(checker('98,41')).toBe(true);
    expect(checker('FINAL: 98,41')).toBe(true);
    const r = selectWithVerification({
      synthesisText: 'FINAL: 9841',
      candidateTexts: ['FINAL: 9841', 'a média por cliente é 98,41... FINAL: 98,41'],
      checker,
    });
    expect(r.decision).toBe('override_to_voter');
    expect(r.voterIndex).toBe(1);
  });

  it('locale regression: dot-format and thousands answers grade exactly as before', () => {
    const cases: Array<[number, string]> = [
      [1020, '1020'],
      [98.41, '98.41'],
      [299792458, '299792458'],
      [1234, '1,234'],
      [1234567, '1,234,567'],
    ];
    for (const [expected, answer] of cases) {
      const checker = resolveAnswerChecker({ kind: 'numeric_equals', expected })!;
      expect(checker(answer), `${answer} must grade as ${expected}`).toBe(true);
    }
  });

  it('hard verifiable block (126-135): each accepts the correct answer, rejects a plausible slip', () => {
    // The correct answer and a COMMON wrong answer (the mistake the task is
    // designed to catch) for each hard task — locks both the spec and difficulty.
    const cases: Array<[number, string, string]> = [
      [126, '0.4167', '0.5'],        // exactly-2-red vs "2 of 3"
      [127, '9', '7'],               // 7^100 mod 13 via Fermat vs naive 7^1
      [128, '126', '15120'],         // C(9,5) vs P(9,5) (arrangements)
      [129, '3', '2.4'],             // combined rate WITH drain vs without
      [130, '6', '4'],               // x+y vs x alone
      [131, '24', '28'],             // definite integral vs upper term only
      [132, '8', '7'],               // popcount(2026) — off-by-one on bits
      [133, '40', '45'],            // harmonic vs arithmetic mean of speeds
      [135, '9.0', '99.0'],          // Bayes vs base-rate neglect
    ];
    for (const [index, right, wrong] of cases) {
      const task = EXPERIMENT_SUITE.find((t) => t.index === index)!;
      const checker = resolveAnswerChecker(task.answerCheck as AnswerCheckSpec)!;
      expect(checker(right), `task ${index} must accept ${right}`).toBe(true);
      expect(checker(wrong), `task ${index} must reject ${wrong}`).toBe(false);
    }
    // 134 is a comma-list regex — check separately (spacing-tolerant).
    const t134 = EXPERIMENT_SUITE.find((t) => t.index === 134)!;
    const c134 = resolveAnswerChecker(t134.answerCheck as AnswerCheckSpec)!;
    expect(c134('53,59,61,67,71')).toBe(true);
    expect(c134('53, 59, 61, 67, 71')).toBe(true);
    expect(c134('51,53,59,61,67')).toBe(false); // included 51 (=3×17)
  });
});
