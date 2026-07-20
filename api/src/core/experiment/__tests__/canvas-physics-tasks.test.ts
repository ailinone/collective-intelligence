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
  getCanvasPhysicsTaskIndices,
  getVerifiableTaskIndices,
  CANVAS_PHYSICS_TASK_TYPE,
} from '../experiment-suite';
import { resolveAnswerChecker, type AnswerCheckSpec } from '@/core/orchestration/verification/answer-check-resolver';

const canvasTasks = EXPERIMENT_SUITE.filter((t) => t.taskType === CANVAS_PHYSICS_TASK_TYPE);

describe('canvas-physics task block (136-145)', () => {
  it('ships 10 scenes, all high-complexity with a full-text structural check', () => {
    expect(canvasTasks).toHaveLength(10);
    for (const t of canvasTasks) {
      expect(t.complexity).toBe('high');
      expect(t.answerCheck?.kind).toBe('contains_all');
      expect(t.answerCheckScope).toBe('full');
      // never clip the code output
      expect((t.maxTokens ?? 0)).toBeGreaterThanOrEqual(16000);
      // asks for a single self-contained file, not a FINAL: line
      expect(t.prompt).toMatch(/self-contained/i);
      expect(t.prompt).not.toMatch(/FINAL:/);
    }
  });

  it('the structural check passes a working canvas file and fails prose/partial', () => {
    const spec = canvasTasks[0].answerCheck as AnswerCheckSpec;
    const checker = resolveAnswerChecker(spec)!;
    const working =
      '<canvas></canvas><script>const x=c.getContext("2d");requestAnimationFrame(loop)</script>';
    expect(checker(working)).toBe(true);
    expect(checker('I would build a canvas animation with physics.')).toBe(false); // prose
    expect(checker('<canvas></canvas><script>c.getContext("2d")</script>')).toBe(false); // no loop
  });

  it('is SEPARATE from the cheap numeric mini-run subset (own config, expensive)', () => {
    const verifiable = getVerifiableTaskIndices(); // numeric FINAL-line tasks
    const canvas = getCanvasPhysicsTaskIndices();
    // no overlap: the canvas tasks are excluded from the numeric mini-run so the
    // $2-5 canary is not blown by 32k-token code generations.
    for (const idx of canvas) expect(verifiable).not.toContain(idx);
    expect(canvas).toEqual([136, 137, 138, 139, 140, 141, 142, 143, 144, 145]);
  });
});
