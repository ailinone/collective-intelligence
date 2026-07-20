// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Arm-budget dimensioning — starvation guard (review F1).
 *
 * The equal split (maxBudget / #arms) starved collective arms: with the
 * union-inflated single count, each arm got ~$0.31-0.95 while a collective arm
 * needs $3-20, so 655/768 items were skipped as "arm budget exhausted" and v4
 * ended at 17% INCONCLUSIVE. computeArmBudgets weights the split by expected
 * per-arm cost; assertArmBudgetFeasible surfaces (or, strict, refuses) starvation
 * before any spend.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  armCostWeight,
  computeArmBudgets,
  summarizeArmBudgetFeasibility,
  assertArmBudgetFeasible,
} from '../experiment-runner';
import type { ExperimentConfig, ModeConfig } from '../experiment-types';

const single = (modelId: string): ModeConfig => ({ mode: 'single-model', modelId, displayName: modelId });
const collective = (strategy: string): ModeConfig => ({ mode: 'collective', strategy: strategy as never });

function cfg(modes: ModeConfig[], maxBudgetUsd: number): ExperimentConfig {
  return { name: 't', description: 't', taskIndices: [], modes, repetitions: 1, maxBudgetUsd } as ExperimentConfig;
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('armCostWeight', () => {
  it('weights single arms 1 and collective arms higher', () => {
    expect(armCostWeight(single('gpt-5.4'))).toBe(1);
    expect(armCostWeight({ mode: 'single-budget', modelId: 'x', displayName: 'x' })).toBe(1);
    expect(armCostWeight(collective('consensus'))).toBeGreaterThan(1);
    expect(armCostWeight({ mode: 'adaptive' })).toBeGreaterThan(1);
  });
});

describe('computeArmBudgets', () => {
  it('gives a collective arm a larger slice than a single arm, and the total stays within budget', () => {
    const modes = [single('a'), single('b'), collective('consensus'), collective('debate')];
    const budgets = computeArmBudgets(cfg(modes, 100));
    const total = Object.values(budgets).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(100, 5); // conserved

    // Each collective slice must exceed each single slice (the whole point).
    const singleSlice = budgets['single-model:a'];
    const collectiveSlice = budgets['collective:consensus'];
    expect(collectiveSlice).toBeGreaterThan(singleSlice);
    // With weight 6 vs 1: singles 1+1=2 units, collectives 6+6=12 → total 14.
    expect(singleSlice).toBeCloseTo(100 / 14, 4);
    expect(collectiveSlice).toBeCloseTo((100 * 6) / 14, 4);
  });

  it('reproduces the v4 starvation under the OLD equal split, and fixes it under weighting', () => {
    // 30 singles + 4 collectives, $100 budget.
    const modes = [
      ...Array.from({ length: 30 }, (_, i) => single(`m${i}`)),
      collective('consensus'), collective('debate'), collective('expert-panel'), collective('hierarchical'),
    ];
    const equalSplit = 100 / modes.length; // ~$2.94 — what the OLD code gave every arm
    const budgets = computeArmBudgets(cfg(modes, 100));
    const collectiveSlice = budgets['collective:consensus'];
    // Weighted: singles 30 units, collectives 4*6=24 → total 54. Collective gets
    // 100*6/54 ≈ $11.11 — ~4x the equal split, enough to actually run.
    expect(collectiveSlice).toBeGreaterThan(equalSplit * 3);
  });

  it('returns {} for a config with no modes', () => {
    expect(computeArmBudgets(cfg([], 100))).toEqual({});
  });
});

describe('assertArmBudgetFeasible', () => {
  it('does not throw when collective arms are above the floor', () => {
    process.env.EXPERIMENT_MIN_COLLECTIVE_ARM_USD = '2';
    const modes = [single('a'), collective('consensus')];
    expect(() => assertArmBudgetFeasible(cfg(modes, 100))).not.toThrow();
  });

  it('WARNS (does not throw) by default when a collective arm is starved', () => {
    process.env.EXPERIMENT_MIN_COLLECTIVE_ARM_USD = '5';
    delete process.env.EXPERIMENT_STRICT_BUDGET;
    // Many collectives, tiny budget → each collective slice < $5.
    const modes = Array.from({ length: 20 }, (_, i) => collective(`s${i}`));
    expect(() => assertArmBudgetFeasible(cfg(modes, 10))).not.toThrow();
    const summary = summarizeArmBudgetFeasibility(cfg(modes, 10));
    expect(summary.starvedCollectiveArms.length).toBeGreaterThan(0);
  });

  it('THROWS under EXPERIMENT_STRICT_BUDGET when a collective arm is starved', () => {
    process.env.EXPERIMENT_MIN_COLLECTIVE_ARM_USD = '5';
    process.env.EXPERIMENT_STRICT_BUDGET = '1';
    const modes = Array.from({ length: 20 }, (_, i) => collective(`s${i}`));
    expect(() => assertArmBudgetFeasible(cfg(modes, 10))).toThrow(/starvation/i);
  });
});
