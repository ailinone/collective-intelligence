// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import {
  EXPERIMENT_SUITE,
  getHardVerifiableTaskIndices,
  getVerifiableTaskIndices,
  HARD_VERIFIABLE_TASK_TYPE,
} from '../experiment-suite';
import { resolveAnswerChecker, type AnswerCheckSpec } from '@/core/orchestration/verification/answer-check-resolver';

const hard = EXPERIMENT_SUITE.filter((t) => t.taskType === HARD_VERIFIABLE_TASK_TYPE);

describe('hard verifiable tier (146-155) — H-A calibration', () => {
  it('ships 10 high-difficulty numeric/regex tasks that each ask for FINAL:', () => {
    expect(hard).toHaveLength(10);
    for (const t of hard) {
      expect(t.complexity).toBe('high');
      expect(t.expectedDifficulty).toBeGreaterThanOrEqual(0.85);
      expect(t.answerCheck).toBeDefined();
      expect(t.answerCheckScope ?? 'final').toBe('final'); // short-answer, FINAL-line
      expect(t.prompt).toMatch(/FINAL:/);
    }
  });

  it('every answer accepts the correct value and rejects a common slip (verified vs script)', () => {
    // [index, correctAnswer, aPlausibleWrongAnswer]
    const cases: Array<[number, string, string]> = [
      [146, '925', '711'],      // long mod recurrence (stopped early)
      [147, '5543', '5560'],    // interest+withdrawal (rounding/step slip)
      [148, '401', '467'],      // inclusion-exclusion (forgot the "not 7" step)
      [149, '84', '120'],       // compositions (used C(10,3) — allowed 0)
      [150, '26738', '12118'],  // reverse depreciation (multiplied not divided)
      [151, '100', '80'],       // work-rate stages
      [153, '34', '36'],        // grid paths (returned the through-center count)
      [155, '204', '84'],       // increasing OR decreasing (forgot decreasing/0)
    ];
    for (const [index, right, wrong] of cases) {
      const t = EXPERIMENT_SUITE.find((x) => x.index === index)!;
      const checker = resolveAnswerChecker(t.answerCheck as AnswerCheckSpec)!;
      expect(checker(right), `task ${index} must accept ${right}`).toBe(true);
      expect(checker(wrong), `task ${index} must reject ${wrong}`).toBe(false);
    }
    // 152 is a base-7 regex; 154 a 4-decimal probability
    const t152 = EXPERIMENT_SUITE.find((x) => x.index === 152)!;
    expect(resolveAnswerChecker(t152.answerCheck as AnswerCheckSpec)!('424')).toBe(true);
    expect(resolveAnswerChecker(t152.answerCheck as AnswerCheckSpec)!('214')).toBe(false); // decimal, not base-7
    const t154 = EXPERIMENT_SUITE.find((x) => x.index === 154)!;
    expect(resolveAnswerChecker(t154.answerCheck as AnswerCheckSpec)!('0.1319')).toBe(true);
    expect(resolveAnswerChecker(t154.answerCheck as AnswerCheckSpec)!('0.5')).toBe(false);
  });

  it('the hard tier is part of the numeric verifiable set (joins the mini-run)', () => {
    const idx = getHardVerifiableTaskIndices();
    expect(idx).toEqual([146, 147, 148, 149, 150, 151, 152, 153, 154, 155]);
    // they carry an answerCheck and are not canvas → getVerifiableTaskIndices includes them
    for (const i of idx) expect(getVerifiableTaskIndices()).toContain(i);
  });
});
