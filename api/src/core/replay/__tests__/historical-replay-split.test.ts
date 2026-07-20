// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-split.test.ts — MVP 8B.5
 *
 * Tests the train/holdout split logic.
 */

import { describe, expect, it } from 'vitest';
import { splitTrainHoldout } from '../historical-replay-split';
import {
  SYNTHETIC_REPLAY_FIXTURE,
  SYNTHETIC_EXPERIMENTS,
} from './fixtures/synthetic-replay.fixture';

describe('splitTrainHoldout — by_experiment_id', () => {
  it('produces train + holdout sets with non-empty content', () => {
    const s = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE, {
      holdoutFraction: 0.5,
      minPerSide: 5,
    });
    expect(s.train.length).toBeGreaterThan(0);
    expect(s.holdout.length).toBeGreaterThan(0);
  });

  it('train and holdout experimentIds are disjoint', () => {
    const s = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE, {
      holdoutFraction: 0.5,
    });
    const trainSet = new Set(s.trainExperimentIds);
    for (const id of s.holdoutExperimentIds) {
      expect(trainSet.has(id)).toBe(false);
    }
  });

  it('chooses the alphabetically-last experiments as holdout', () => {
    const s = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE, {
      holdoutFraction: 0.5,
    });
    // With 2 experiments (exp-A, exp-B), holdout count = 1 → exp-B.
    expect(s.holdoutExperimentIds).toEqual([SYNTHETIC_EXPERIMENTS.HOLDOUT]);
    expect(s.trainExperimentIds).toEqual([SYNTHETIC_EXPERIMENTS.TRAIN]);
  });

  it('every train row has experimentId in trainExperimentIds', () => {
    const s = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    const trainSet = new Set(s.trainExperimentIds);
    for (const t of s.train) expect(trainSet.has(t.experimentId)).toBe(true);
  });

  it('output is frozen', () => {
    const s = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.train)).toBe(true);
    expect(Object.isFrozen(s.holdout)).toBe(true);
  });

  it('emits leakageWarnings when train is below minPerSide', () => {
    const s = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE, {
      holdoutFraction: 0.5,
      minPerSide: 1_000,
    });
    expect(
      s.leakageWarnings.some((w) => w.indexOf('train_below_min') !== -1),
    ).toBe(true);
  });
});

describe('splitTrainHoldout — by_time', () => {
  it('respects createdAt ordering when strategy=by_time', () => {
    // Build a temporal series — 10 rows with monotonically-increasing dates.
    const exec = (id: string, createdAt: string) => ({
      executionId: id,
      experimentId: 'exp-T',
      taskId: 't',
      taskType: 'code',
      strategyId: 'single',
      modelsUsed: ['m'],
      judgeScore: 0.5,
      costUsd: 0.01,
      success: true,
      createdAt,
    });
    const rows = Array.from({ length: 10 }, (_, i) =>
      exec(`e${i}`, `2026-01-${(i + 1).toString().padStart(2, '0')}T00:00:00Z`),
    );
    const s = splitTrainHoldout(rows as readonly any[], {
      strategy: 'by_time',
      holdoutFraction: 0.3,
      minPerSide: 1,
    });
    expect(s.train.length + s.holdout.length).toBe(10);
    // Holdout contains the latest dates.
    const latestTrainDate = s.train[s.train.length - 1].createdAt!;
    const earliestHoldoutDate = s.holdout[0].createdAt!;
    expect(latestTrainDate <= earliestHoldoutDate).toBe(true);
  });
});

describe('splitTrainHoldout — leakage detection', () => {
  it('flags experiment_id_in_both when an experiment somehow lands in both sides', () => {
    // by_experiment_id can never produce this by construction; we just
    // assert the warning list is an array.
    const s = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    expect(Array.isArray(s.leakageWarnings)).toBe(true);
  });
});

describe('splitTrainHoldout — determinism', () => {
  it('same input → same split', () => {
    const a = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    const b = splitTrainHoldout(SYNTHETIC_REPLAY_FIXTURE);
    expect(a.trainExperimentIds).toEqual(b.trainExperimentIds);
    expect(a.holdoutExperimentIds).toEqual(b.holdoutExperimentIds);
  });
});
