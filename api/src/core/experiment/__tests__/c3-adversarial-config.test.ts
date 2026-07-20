// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests — C3 Adversarial Robustness config (F2.8)
 */

import { describe, it, expect } from 'vitest';
import {
  buildC3AdversarialRobustness,
  buildC3AdversarialPilot,
  C3_ADVERSARIAL_STRATEGIES,
  C3_ADVERSARIAL_SCENARIOS,
} from '../c3-experiment-configs';
import { ALL_COLLECTIVE_STRATEGIES, type CollectiveConfig } from '../experiment-types';

describe('buildC3AdversarialRobustness', () => {
  it('produces a cross-product of strategies × scenarios (F2.9)', () => {
    const config = buildC3AdversarialRobustness();
    const expected = C3_ADVERSARIAL_STRATEGIES.length * C3_ADVERSARIAL_SCENARIOS.length;
    expect(config.modes.length).toBe(expected);
    for (const mode of config.modes) {
      expect(mode.mode).toBe('collective');
    }
  });

  it('every mode carries an adversarialScenario tag and displayName', () => {
    const config = buildC3AdversarialRobustness();
    for (const mode of config.modes) {
      expect(mode.mode).toBe('collective');
      const collective = mode as CollectiveConfig;
      expect(collective.adversarialScenario).toBeDefined();
      expect(C3_ADVERSARIAL_SCENARIOS).toContain(collective.adversarialScenario!);
      expect(collective.displayName).toContain(collective.strategy);
      expect(collective.displayName).toContain(collective.adversarialScenario!);
    }
  });

  it('produces every (strategy, scenario) pair exactly once', () => {
    const config = buildC3AdversarialRobustness();
    const seen = new Set<string>();
    for (const mode of config.modes) {
      const collective = mode as CollectiveConfig;
      const key = `${collective.strategy}::${collective.adversarialScenario}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    const expected = new Set<string>();
    for (const s of C3_ADVERSARIAL_STRATEGIES) {
      for (const scen of C3_ADVERSARIAL_SCENARIOS) {
        expected.add(`${s}::${scen}`);
      }
    }
    expect(seen).toEqual(expected);
  });

  it('every default strategy is registered as a CollectiveStrategy', () => {
    const registered = new Set<string>(ALL_COLLECTIVE_STRATEGIES);
    for (const strat of C3_ADVERSARIAL_STRATEGIES) {
      expect(registered.has(strat)).toBe(true);
    }
  });

  it('respects the strategies override option (cross-product still applies)', () => {
    const config = buildC3AdversarialRobustness({
      strategies: ['consensus', 'debate'],
    });
    // 2 strategies × 5 scenarios = 10 modes
    expect(config.modes.length).toBe(2 * C3_ADVERSARIAL_SCENARIOS.length);
  });

  it('respects the scenarios override option', () => {
    const config = buildC3AdversarialRobustness({
      scenarios: ['herding_cascade'],
    });
    // N strategies × 1 scenario
    expect(config.modes.length).toBe(C3_ADVERSARIAL_STRATEGIES.length);
    for (const mode of config.modes) {
      const collective = mode as CollectiveConfig;
      expect(collective.adversarialScenario).toBe('herding_cascade');
    }
  });

  it('defaults to the suite\'s adversarial-tagged task indices', async () => {
    // The prior default [0,10,20,30,40,50] picked the first 6 generic
    // tasks (5 tech + 1 marketing) which were NOT designed for
    // adversarial probing. Coverage audit (gap 8) flagged this — the
    // adversarial robustness phase now defaults to the actual
    // taskType:'adversarial' subset of the suite.
    const { ADVERSARIAL_TASK_INDICES } = await import('../c3-experiment-configs');
    const config = buildC3AdversarialRobustness();
    expect(config.taskIndices.sort()).toEqual([...ADVERSARIAL_TASK_INDICES].sort());
    expect(config.taskIndices.length).toBeGreaterThan(0);
  });

  it('respects taskIndices override', () => {
    const config = buildC3AdversarialRobustness({ taskIndices: [0, 1, 2] });
    expect(config.taskIndices).toEqual([0, 1, 2]);
  });

  it('caps the budget reasonably', () => {
    const config = buildC3AdversarialRobustness();
    expect(config.maxBudgetUsd).toBeGreaterThan(0);
    expect(config.maxBudgetUsd).toBeLessThanOrEqual(200);
  });

  it('freezes learning during evaluation', () => {
    const config = buildC3AdversarialRobustness();
    expect(config.freezeLearningDuringEval).toBe(true);
  });
});

describe('buildC3AdversarialPilot', () => {
  it('uses 3 strategies × 2 scenarios for cheap validation', () => {
    const config = buildC3AdversarialPilot();
    expect(config.modes.length).toBe(3 * 2);
  });

  it('uses 1 repetition (vs 2 for full)', () => {
    const config = buildC3AdversarialPilot();
    expect(config.repetitions).toBe(1);
  });

  it('budget is below the full adversarial run', () => {
    const pilot = buildC3AdversarialPilot();
    const full = buildC3AdversarialRobustness();
    expect(pilot.maxBudgetUsd ?? 0).toBeLessThan(full.maxBudgetUsd ?? Infinity);
  });

  it('name reflects the pilot purpose', () => {
    const config = buildC3AdversarialPilot();
    expect(config.name).toContain('Adversarial');
    expect(config.name).toContain('Pilot');
  });
});
