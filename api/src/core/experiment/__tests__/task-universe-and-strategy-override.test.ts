// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Task universe (review TS-02) + single-arm strategy-override guard (review F11).
 *
 * TS-02: the default configs ran taskIndices: [] → getFilteredTasks returned the
 * WHOLE suite, including compositor-strategy tasks (unimplemented → mislabeled)
 * and payload-less multimodal tasks (guaranteed failures). getRunnableTextTaskIndices
 * — dead code until now — excludes exactly those and is the new default.
 *
 * F11: a task's forced collective strategy must never override a single-model
 * arm (that silently turns the "single" into a collective and contaminates the
 * single-vs-collective attribution the experiment measures).
 */
import { describe, it, expect } from 'vitest';
import { EXPERIMENT_SUITE, getRunnableTextTaskIndices } from '../experiment-suite';
import { shouldApplyTaskStrategyOverride } from '../experiment-runner';
import type { ModeConfig } from '../experiment-types';

describe('getRunnableTextTaskIndices (review TS-02)', () => {
  const runnable = new Set(getRunnableTextTaskIndices());

  it('is non-empty and a strict subset of the suite', () => {
    expect(runnable.size).toBeGreaterThan(0);
    expect(runnable.size).toBeLessThan(EXPERIMENT_SUITE.length);
  });

  it('excludes every compositor-strategy task (unimplemented → mislabeled attribution)', () => {
    const compositor = EXPERIMENT_SUITE.filter(
      (t) => t.strategy === 'compositor' || t.queueType === 'compositor',
    );
    expect(compositor.length).toBeGreaterThan(0); // sanity: the suite has them
    for (const t of compositor) expect(runnable.has(t.index)).toBe(false);
  });

  it('excludes multimodal tasks that reference an attachment the suite never populates', () => {
    const payloadless = EXPERIMENT_SUITE.filter(
      (t) => t.modality && t.modality !== 'chat' && !t.audioUrl && !t.imageUrl,
    );
    for (const t of payloadless) expect(runnable.has(t.index)).toBe(false);
  });

  it('excludes task 105 — pipeline modality asking to "listen to this audio" with no audio attached (review TS-03)', () => {
    expect(runnable.has(105)).toBe(false);
  });

  it('includes ordinary reasoning/verifiable text tasks', () => {
    // Task 116 is a plain reasoning task with an answer_check — must be runnable.
    expect(runnable.has(116)).toBe(true);
  });
});

describe('shouldApplyTaskStrategyOverride (review F11)', () => {
  const singleModel: ModeConfig = { mode: 'single-model', modelId: 'gpt-5.4', displayName: 'gpt-5.4' };
  const singleBudget: ModeConfig = { mode: 'single-budget', modelId: 'mini', displayName: 'mini' };
  const consensus: ModeConfig = { mode: 'collective', strategy: 'consensus' as never };
  const adaptive: ModeConfig = { mode: 'adaptive' };

  it('NEVER overrides a single-model arm with a task collective strategy (no contamination)', () => {
    expect(shouldApplyTaskStrategyOverride(singleModel, 'debate')).toBe(false);
    expect(shouldApplyTaskStrategyOverride(singleBudget, 'debate')).toBe(false);
  });

  it('DOES override collective-family arms with a valid task strategy', () => {
    expect(shouldApplyTaskStrategyOverride(consensus, 'debate')).toBe(true);
    expect(shouldApplyTaskStrategyOverride(adaptive, 'debate')).toBe(true);
  });

  it('rejects a strategy the chat schema does not accept, for any arm', () => {
    expect(shouldApplyTaskStrategyOverride(consensus, 'not-a-real-strategy')).toBe(false);
    expect(shouldApplyTaskStrategyOverride(consensus, undefined)).toBe(false);
  });
});
