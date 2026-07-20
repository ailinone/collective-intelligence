// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Objective scoring is AUTHORITATIVE for verifiable tasks (review TS-04).
 *
 * The single arm of a verifiable task used to be graded purely by the fuzzy LLM
 * judge — a wrong-but-well-reasoned answer scored ~0.75, erasing the exact H-A
 * separation the experiment exists to measure. `gradeObjectiveAnswer` now grades
 * the task's `answer_check` with the SAME resolver the collective's best-of-N
 * uses, so both arms are held to one objective instrument: correctness IS the
 * score. These tests also pin the task-120 Big-O regex fix — now that the check
 * is authoritative, a false-negative would wrongly score a correct answer 0.
 */
import { describe, it, expect } from 'vitest';
import { EXPERIMENT_SUITE } from '../experiment-suite';
import { gradeObjectiveAnswer } from '../experiment-runner';
import type { ExperimentTask } from '../experiment-types';

function task(index: number): ExperimentTask {
  const t = EXPERIMENT_SUITE.find((x) => x.index === index);
  if (!t) throw new Error(`task ${index} not found in suite`);
  return t;
}

describe('gradeObjectiveAnswer — verifiable correctness is the score', () => {
  it('scores a WRONG final answer 0 even when the reasoning is long and plausible', () => {
    // Task 116: coffee-shop revenue, expected FINAL 1020. This answer reasons at
    // length and lands on 1030 — the judge would reward the coherent steps; the
    // objective check must not.
    const wrongButVerbose =
      'Let me reason carefully step by step. Original revenue was 200 cups * $5 = $1000. ' +
      'They raise the price to $6 and lose 15% of customers, so 200 * 0.85 = 170 customers remain. ' +
      'New revenue = 170 * $6 = $1030 per day, an improvement over the original.\nFINAL: 1030';
    expect(gradeObjectiveAnswer(wrongButVerbose, task(116))).toBe(0);
  });

  it('scores the CORRECT final answer 1', () => {
    const right = 'Retained customers 200*0.85=170, revenue 170*$6=$1020.\nFINAL: 1020';
    expect(gradeObjectiveAnswer(right, task(116))).toBe(1);
  });

  it('honors numeric tolerance (task 117: 98.41 ± 0.02)', () => {
    expect(gradeObjectiveAnswer('work...\nFINAL: 98.41', task(117))).toBe(1);
    expect(gradeObjectiveAnswer('work...\nFINAL: 98.40', task(117))).toBe(1); // within 0.02
    expect(gradeObjectiveAnswer('work...\nFINAL: 97.00', task(117))).toBe(0); // outside
  });

  it('returns null for a task with no objective check (falls through to the judge)', () => {
    const noCheck = EXPERIMENT_SUITE.find((t) => !t.answerCheck && !t.codeTest);
    expect(noCheck).toBeDefined();
    expect(gradeObjectiveAnswer('anything at all', noCheck!)).toBeNull();
  });
});

describe('task 122 (string_equals Canberra) — trailing punctuation must not zero a correct answer', () => {
  const t122 = task(122);

  // The task's own judgeRubric models the compliant answer as `FINAL: Canberra.`
  // (with a period). With the objective grade authoritative and no judge
  // fallback, that period used to hard-score a correct answer 0.
  it.each([
    'The capital is Canberra, not Sydney.\nFINAL: Canberra.',
    'FINAL: Canberra',
    'FINAL: canberra .',
    'FINAL: Canberra!',
  ])('grades %j as 1', (answer) => {
    expect(gradeObjectiveAnswer(answer, t122)).toBe(1);
  });

  it.each(['FINAL: Sydney.', 'FINAL: Sydney', 'FINAL: Melbourne.'])(
    'still grades the wrong city %j as 0',
    (answer) => {
      expect(gradeObjectiveAnswer(answer, t122)).toBe(0);
    },
  );
});

describe('canvas structural check (tasks 136-145) — completeness gates the grade', () => {
  const canvas = task(136);
  // A minimal but COMPLETE self-contained canvas file: all three needles
  // (<canvas, getContext, requestAnimationFrame) plus closing tags.
  const completeFile = [
    'Here is the scene:',
    '```html',
    '<!DOCTYPE html>',
    '<html>',
    '<body>',
    '<canvas id="c" width="800" height="600"></canvas>',
    '<script>',
    "const ctx = document.getElementById('c').getContext('2d');",
    'let y = 0, vy = 0;',
    'function loop() {',
    '  vy += 0.5; y += vy;',
    '  if (y > 560) { y = 560; vy = -vy * 0.6; }',
    '  ctx.clearRect(0, 0, 800, 600);',
    '  ctx.fillRect(100, y, 40, 40);',
    '  requestAnimationFrame(loop);',
    '}',
    'requestAnimationFrame(loop);',
    '</script>',
    '</body>',
    '</html>',
    '```',
  ].join('\n');
  // The SAME file cut mid-<script>, the shape a maxTokens clip produces: all
  // three needles are already present (they sit in the first few hundred
  // bytes), but the file is non-runnable and has no closing tag.
  const clippedFile = completeFile.slice(
    0,
    completeFile.indexOf('requestAnimationFrame(loop);') + 'requestAnimationFrame(loop);'.length,
  );

  it('scores a complete canvas file 1', () => {
    expect(gradeObjectiveAnswer(completeFile, canvas)).toBe(1);
  });

  it('scores the same file clipped mid-<script> 0 — needles present, no closing tag', () => {
    // Guard the fixture itself: the clip must keep all three needles, or the
    // test would pass for the wrong reason (needle absence, not the gate).
    const hay = clippedFile.toLowerCase();
    for (const needle of ['<canvas', 'getcontext', 'requestanimationframe']) {
      expect(hay).toContain(needle);
    }
    expect(gradeObjectiveAnswer(clippedFile, canvas)).toBe(0);
  });

  it("scores a structurally-complete-looking reply 0 when the provider reports finish_reason='length'", () => {
    expect(gradeObjectiveAnswer(completeFile, canvas, true)).toBe(0);
  });

  it('scores a prose-only reply that merely names the three APIs 0', () => {
    const prose =
      'I would build this with a <canvas> element, acquire a 2D context via ' +
      "getContext('2d'), and drive the physics loop with requestAnimationFrame.";
    expect(gradeObjectiveAnswer(prose, canvas)).toBe(0);
  });

  it("does NOT zero a 'final'-scope grade on truncation — a surviving FINAL line is still the answer", () => {
    // Task 116 (final-scope numeric check): truncation gates only structural
    // full-scope checks; if the FINAL line made it out, it is verifiable as-is.
    expect(gradeObjectiveAnswer('work...\nFINAL: 1020', task(116), true)).toBe(1);
  });
});

describe('task 120 Big-O check — accepts correct written forms, rejects a different complexity', () => {
  const t120 = task(120);

  it.each([
    'FINAL: O(log n)',
    'FINAL: O(logn)',
    'FINAL: O(log(n))',
    'FINAL: O(log₂ n)',
    'FINAL: O(log_2 n)',
    'The complexity is logarithmic.\nFINAL: O( log n )',
  ])('accepts %s', (answer) => {
    expect(gradeObjectiveAnswer(answer, t120)).toBe(1);
  });

  it.each([
    'FINAL: O(n log n)', // linearithmic — a DIFFERENT, wrong complexity
    'FINAL: O(n)',
    'FINAL: O(1)',
    'FINAL: O(n^2)',
  ])('rejects %s', (answer) => {
    expect(gradeObjectiveAnswer(answer, t120)).toBe(0);
  });
});
