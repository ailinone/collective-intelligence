// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the C3 experiment config builders + dispatcher invariant.
 *
 * After deleting c3-benchmark-configs.ts (the static-modelId builders
 * with the empty forced-pool bug), every C3 config now flows through
 * the dynamic builders in c3-experiment-configs.ts. These tests:
 *
 *   1. Lock the architectural invariant that GET /c3-configs and POST
 *      /c3-create surface the same set of keys (the C3_CONFIG_BUILDERS
 *      map is the single source of truth).
 *   2. Verify each builder produces a structurally valid ExperimentConfig
 *      — non-empty modes, populated taskIndices, sane budget, etc.
 *   3. Catch the specific empty-pool regression: any
 *      forced-pool-collective mode MUST have a non-empty
 *      forcedModelPool.
 *
 * Builders that resolve models from the DB are mocked at the prisma
 * layer so these tests run without a database.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Stub the prisma client BEFORE importing the builders, since the
// dynamic builders run prisma.model.findFirst/findMany at module load
// time when called.
vi.mock('@/database/client', () => ({
  prisma: {
    model: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'openai/gpt-4o',
        displayName: 'GPT-4o',
        capabilities: ['chat'],
        provider: { name: 'openai' },
      }),
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'openai/gpt-4o-mini',
          displayName: 'GPT-4o mini',
          capabilities: ['chat'],
          provider: { name: 'openai' },
        },
        {
          id: 'anthropic/claude-haiku',
          displayName: 'Claude Haiku',
          capabilities: ['chat'],
          provider: { name: 'anthropic' },
        },
      ]),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('C3_CONFIG_BUILDERS — dispatcher invariant', () => {
  it('exposes every key documented in the API contract', async () => {
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');

    // The 45 canonical keys. Adding a 46th REQUIRES updating this
    // assertion — that's deliberate so the API surface change goes
    // through code review.
    const expected = [
      'c3-pilot',
      'c3-ablation-pilot',
      'c3-main-comparison',
      // H-A adjudication mini-run (2026-07-04, post-7bb900e2 errata)
      'c3-ha-verifiable-minirun',
      // Pure H-A test — hard verifiable tier (2026-07-12)
      'c3-ha-hard',
      // Code-verified (executed) benchmark (2026-07-12)
      'c3-code-verified',
      // Canvas-physics code benchmark (2026-07-11)
      'c3-canvas-physics',
      // Capability #4 (tool-calling), objective grade (2026-07-13)
      'c3-tool-calling',
      // Public-benchmark axes (2026-07-21): standard datasets, judge-free
      'ailin-humaneval',
      'ailin-gsm8k',
      // Frontier supplement (2026-07-05, post-7bb900e2 single-arm audit)
      'c3-frontier-comparison',
      // H-A top-up: collectives × verifiable subset (post-9590ff41)
      'c3-frontier-ha-topup',
      // H-B first instantiation (2026-07-06, Ollama on the VPS)
      'c3-hb-mixed-minirun',
      'c3-ablation-debate',
      'c3-ablation-consensus',
      'c3-ablation-war-room',
      // Phase 2c shadow-wired strategies (Round 9 of coord-stable)
      'c3-ablation-sensitivity-consensus',
      'c3-ablation-tri-role-collective',
      'c3-ablation-expert-panel',
      'c3-ablation-critique-repair',
      // Universal ablation coverage (2026-07-19): the remaining 23
      // BENCHMARK_COLLECTIVE_STRATEGIES entries that had no dedicated
      // ablation builder — same buildC3Ablation, just the rest of the roster.
      'c3-ablation-collaborative',
      'c3-ablation-parallel',
      'c3-ablation-sequential',
      'c3-ablation-hybrid',
      'c3-ablation-competitive',
      'c3-ablation-massive-parallel',
      'c3-ablation-cost-cascade',
      'c3-ablation-quality-multipass',
      'c3-ablation-adaptive',
      'c3-ablation-contextual',
      'c3-ablation-reinforcement',
      'c3-ablation-blind-debate',
      'c3-ablation-devil-advocate-consensus',
      'c3-ablation-safety-quorum',
      'c3-ablation-diversity-ensemble',
      'c3-ablation-stigmergic-refinement',
      'c3-ablation-swarm-explore',
      'c3-ablation-clarification-first',
      'c3-ablation-research-synthesize',
      'c3-ablation-double-diamond',
      'c3-ablation-multi-hop-qa',
      'c3-ablation-persona-exploration',
      'c3-ablation-agentic',
      'c3-independence-herding',
      'c3-learning-baselines',
      'c3-longitudinal',
      'c3-adversarial-robustness',
      'c3-adversarial-pilot',
    ].sort();

    expect(Object.keys(C3_CONFIG_BUILDERS).sort()).toEqual(expected);
  });

  it('getAllC3Configs returns the same keys as C3_CONFIG_BUILDERS', async () => {
    const { C3_CONFIG_BUILDERS, getAllC3Configs } = await import('../c3-experiment-configs');

    const allConfigs = await getAllC3Configs();

    expect(Object.keys(allConfigs).sort()).toEqual(Object.keys(C3_CONFIG_BUILDERS).sort());
  });

  it('every builder is a callable function', async () => {
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');

    for (const [key, builder] of Object.entries(C3_CONFIG_BUILDERS)) {
      expect(typeof builder, `${key} should be a function`).toBe('function');
    }
  });
});

describe('C3 config builders — structural validation', () => {
  it('every builder produces a config with non-empty modes', async () => {
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');

    for (const [key, builder] of Object.entries(C3_CONFIG_BUILDERS)) {
      const config = await builder();
      expect(config.modes.length, `${key} should have ≥1 mode`).toBeGreaterThan(0);
      expect(config.repetitions, `${key} should have ≥1 repetition`).toBeGreaterThan(0);
      expect(
        config.maxBudgetUsd,
        `${key} should have a positive maxBudgetUsd`,
      ).toBeGreaterThan(0);
      expect(config.name, `${key} should have a non-empty name`).toMatch(/\S/);
    }
  });

  it('every forced-pool-collective mode has a non-empty forcedModelPool', async () => {
    // Regression: c3-benchmark-configs.ts (now deleted) had
    // forcedModelPool: [] which silently degraded the forced-pool
    // semantic to a regular collective. This test fails the build if
    // any builder ever ships an empty pool again.
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');

    for (const [key, builder] of Object.entries(C3_CONFIG_BUILDERS)) {
      const config = await builder();
      const forcedPoolModes = config.modes.filter((m) => m.mode === 'forced-pool-collective');
      for (const mode of forcedPoolModes) {
        if (mode.mode !== 'forced-pool-collective') continue;
        expect(
          mode.forcedModelPool.length,
          `${key} has forced-pool-collective mode with empty pool — bug regression`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every mode has the required `mode` discriminator field', async () => {
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');

    for (const [key, builder] of Object.entries(C3_CONFIG_BUILDERS)) {
      const config = await builder();
      for (const mode of config.modes) {
        expect(
          typeof mode.mode,
          `${key}: every mode must have a string discriminator`,
        ).toBe('string');
        expect(
          [
            'single-model',
            'single-budget',
            'collective',
            'forced-pool-collective',
            'ablation',
            'adaptive',
          ],
          `${key}: mode '${mode.mode}' is not a known ExecutionMode`,
        ).toContain(mode.mode);
      }
    }
  });

  it('every collective/ablation mode has a strategy', async () => {
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');

    for (const [key, builder] of Object.entries(C3_CONFIG_BUILDERS)) {
      const config = await builder();
      for (const mode of config.modes) {
        if (
          mode.mode === 'collective' ||
          mode.mode === 'forced-pool-collective' ||
          mode.mode === 'ablation'
        ) {
          expect(
            mode.strategy,
            `${key}: ${mode.mode} mode must specify a strategy`,
          ).toBeTruthy();
        }
      }
    }
  });

  it('pilot configs have small task counts (cost guard)', async () => {
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');

    // Pilots should be cheap — sub-50 task slots. Catches "someone
    // pasted main config into pilot builder" regression.
    const pilotKeys = ['c3-pilot', 'c3-ablation-pilot', 'c3-adversarial-pilot'];
    for (const key of pilotKeys) {
      const config = await C3_CONFIG_BUILDERS[key]!();
      const taskCount =
        config.taskIndices.length > 0 ? config.taskIndices.length : 100;
      const armCount = config.modes.length;
      const totalExecs = taskCount * armCount * config.repetitions;
      expect(
        totalExecs,
        `${key} estimated ${totalExecs} executions — too large for a pilot`,
      ).toBeLessThan(2000);
    }
  });

  it('main comparison + adversarial robustness produce ≥ pilot in scale', async () => {
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');

    const pilot = await C3_CONFIG_BUILDERS['c3-pilot']!();
    const main = await C3_CONFIG_BUILDERS['c3-main-comparison']!();
    const advRobust = await C3_CONFIG_BUILDERS['c3-adversarial-robustness']!();
    const advPilot = await C3_CONFIG_BUILDERS['c3-adversarial-pilot']!();

    const pilotScale =
      (pilot.taskIndices.length || 100) * pilot.modes.length * pilot.repetitions;
    const mainScale =
      (main.taskIndices.length || 100) * main.modes.length * main.repetitions;
    const advRobustScale =
      (advRobust.taskIndices.length || 100) * advRobust.modes.length * advRobust.repetitions;
    const advPilotScale =
      (advPilot.taskIndices.length || 100) * advPilot.modes.length * advPilot.repetitions;

    expect(mainScale, 'main should be larger than pilot').toBeGreaterThanOrEqual(pilotScale);
    expect(
      advRobustScale,
      'adversarial-robustness should be larger than its pilot',
    ).toBeGreaterThanOrEqual(advPilotScale);
  });
});

describe('C3 config builders — option overrides', () => {
  it('builder accepts taskIndices override', async () => {
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');

    const customTasks = [0, 1, 2];
    const config = await C3_CONFIG_BUILDERS['c3-pilot']!({ taskIndices: customTasks });
    expect(config.taskIndices).toEqual(customTasks);
  });

  it('builder accepts maxBudgetUsd override', async () => {
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');

    const config = await C3_CONFIG_BUILDERS['c3-pilot']!({ maxBudgetUsd: 999 });
    expect(config.maxBudgetUsd).toBe(999);
  });
});

/**
 * Coverage invariants — these tests catch drift in WHAT the experiment
 * suite covers (strategies, complexities, task domains). They're the
 * structural gate that future config refactors must pass.
 */
describe('C3 coverage invariants', () => {
  it('pickStratifiedTaskIndices draws balanced complexity samples', async () => {
    const { pickStratifiedTaskIndices } = await import('../c3-experiment-configs');
    const { EXPERIMENT_SUITE } = await import('../experiment-suite');

    const indices = pickStratifiedTaskIndices(4);
    expect(indices.length).toBeGreaterThanOrEqual(8); // 4 per bucket × 3 buckets, minus
                                                     //   any bucket smaller than 4.

    // Decompose by complexity — every bucket should have ≥1 sample.
    const byCplx: Record<string, number> = { low: 0, medium: 0, high: 0 };
    for (const idx of indices) {
      const task = EXPERIMENT_SUITE.find((t) => t.index === idx);
      expect(task, `task ${idx} should exist`).toBeDefined();
      byCplx[task!.complexity]! += 1;
    }
    expect(byCplx.low, 'pilot must include low-complexity tasks').toBeGreaterThan(0);
    expect(byCplx.medium, 'pilot must include medium-complexity tasks').toBeGreaterThan(0);
    expect(byCplx.high, 'pilot must include high-complexity tasks').toBeGreaterThan(0);
  });

  it('stratified pilot indices span the full suite (not just first 50)', async () => {
    const { pickStratifiedTaskIndices } = await import('../c3-experiment-configs');
    const { EXPERIMENT_SUITE } = await import('../experiment-suite');

    const indices = pickStratifiedTaskIndices(4);
    const max = Math.max(...indices);
    const suiteMax = EXPERIMENT_SUITE.length - 1;

    // The prior arbitrary `[0,1,10,...,41]` had max=41, missing 56% of suite.
    // Stratified should reach into the upper half of the suite.
    expect(
      max,
      `stratified sample max=${max} should reach above suite midpoint ${Math.floor(suiteMax / 2)}`,
    ).toBeGreaterThanOrEqual(Math.floor(suiteMax / 2));
  });

  it('ADVERSARIAL_TASK_INDICES references real adversarial-tagged tasks', async () => {
    const { ADVERSARIAL_TASK_INDICES } = await import('../c3-experiment-configs');
    const { EXPERIMENT_SUITE } = await import('../experiment-suite');

    expect(ADVERSARIAL_TASK_INDICES.length).toBeGreaterThan(0);
    for (const idx of ADVERSARIAL_TASK_INDICES) {
      const task = EXPERIMENT_SUITE.find((t) => t.index === idx);
      expect(task?.taskType).toBe('adversarial');
    }
  });

  it('adversarial-robustness defaults to adversarial-tagged tasks', async () => {
    const { C3_CONFIG_BUILDERS, ADVERSARIAL_TASK_INDICES } = await import(
      '../c3-experiment-configs'
    );

    const config = await C3_CONFIG_BUILDERS['c3-adversarial-robustness']!();
    expect(config.taskIndices.sort()).toEqual([...ADVERSARIAL_TASK_INDICES].sort());
  });

  it('main-comparison covers all BENCHMARK collective strategies (stubs excluded)', async () => {
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');
    const { BENCHMARK_COLLECTIVE_STRATEGIES, NON_COLLECTIVE_BENCHMARK_STRATEGIES } = await import('../experiment-types');

    const config = await C3_CONFIG_BUILDERS['c3-main-comparison']!();
    const strategiesUsed = new Set<string>();
    for (const mode of config.modes) {
      if (mode.mode === 'collective' && mode.strategy) {
        strategiesUsed.add(mode.strategy);
      }
    }
    // Every GENUINE collective must appear as an arm...
    for (const strategy of BENCHMARK_COLLECTIVE_STRATEGIES) {
      expect(
        strategiesUsed.has(strategy),
        `main-comparison should include strategy '${strategy}'`,
      ).toBe(true);
    }
    // ...and known stubs (e.g. hierarchical) must NOT — they would contaminate
    // the pooled collective mean with single-model results.
    for (const stub of NON_COLLECTIVE_BENCHMARK_STRATEGIES) {
      expect(
        strategiesUsed.has(stub),
        `main-comparison must exclude stub strategy '${stub}'`,
      ).toBe(false);
    }
  });

  it('independence-herding covers all BENCHMARK collective strategies (stubs excluded)', async () => {
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');
    const { BENCHMARK_COLLECTIVE_STRATEGIES, NON_COLLECTIVE_BENCHMARK_STRATEGIES } = await import('../experiment-types');

    const config = await C3_CONFIG_BUILDERS['c3-independence-herding']!();
    const strategiesUsed = new Set<string>();
    for (const mode of config.modes) {
      if (mode.mode === 'collective' && mode.strategy) {
        strategiesUsed.add(mode.strategy);
      }
    }
    for (const strategy of BENCHMARK_COLLECTIVE_STRATEGIES) {
      expect(strategiesUsed.has(strategy)).toBe(true);
    }
    for (const stub of NON_COLLECTIVE_BENCHMARK_STRATEGIES) {
      expect(strategiesUsed.has(stub)).toBe(false);
    }
  });

  it('every Phase 2c shadow-wired strategy has a dedicated ablation builder', async () => {
    // The 5 strategies that the coord-stable shadow wire targets MUST
    // have ablation coverage so component-importance analysis can
    // measure what each layer contributes for THOSE strategies. Without
    // this gate, a refactor that drops `c3-ablation-tri-role-collective`
    // (etc.) leaves the shadow-wired strategies ablated only by the
    // generic debate ablation, which is meaningless.
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');

    const SHADOW_WIRED_STRATEGIES = [
      'debate',
      'tri-role-collective',
      'expert-panel',
      'consensus',
      'sensitivity-consensus',
      'critique-repair',
    ];

    for (const strategy of SHADOW_WIRED_STRATEGIES) {
      const key = `c3-ablation-${strategy}`;
      expect(
        C3_CONFIG_BUILDERS[key],
        `Missing ablation builder for shadow-wired strategy '${strategy}' (key: ${key})`,
      ).toBeDefined();
    }
  });

  it('every BENCHMARK collective strategy has a dedicated ablation builder (universal coverage, 2026-07-19)', async () => {
    // Generalizes the shadow-wired check above to ALL 30 genuine collective
    // strategies. Without this gate, a new strategy added to
    // BENCHMARK_COLLECTIVE_STRATEGIES would appear in main-comparison
    // (breadth) but silently have zero ablation coverage (depth) — the
    // exact gap that existed for 23 of 30 strategies before this test.
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');
    const { BENCHMARK_COLLECTIVE_STRATEGIES } = await import('../experiment-types');

    for (const strategy of BENCHMARK_COLLECTIVE_STRATEGIES) {
      const key = `c3-ablation-${strategy}`;
      expect(
        C3_CONFIG_BUILDERS[key],
        `Missing ablation builder for strategy '${strategy}' (key: ${key})`,
      ).toBeDefined();
    }
  });
});

describe('c3-ha-verifiable-minirun — H-A adjudication config (2026-07-04)', () => {
  it('is registered in C3_CONFIG_BUILDERS', async () => {
    const { C3_CONFIG_BUILDERS } = await import('../c3-experiment-configs');
    expect(C3_CONFIG_BUILDERS['c3-ha-verifiable-minirun']).toBeDefined();
  });

  it('targets the FULL verifiable subset (incl. the hard 126-135) and both H-A collective arms', async () => {
    const { buildC3VerifiableMiniRun, VERIFIABLE_TASK_INDICES } = await import(
      '../c3-experiment-configs'
    );
    const { getVerifiableTaskIndices } = await import('../experiment-suite');
    const config = await buildC3VerifiableMiniRun();

    // Derived from the suite (every task with an answerCheck), so the hard
    // frontier-discriminating tasks (126-135) are included, not just 116-125.
    expect(config.taskIndices).toEqual(getVerifiableTaskIndices());
    expect(config.taskIndices).toEqual([...VERIFIABLE_TASK_INDICES]);
    expect(config.taskIndices).toContain(116); // easy block still present
    expect(config.taskIndices).toContain(135); // hard block now included

    const collectives = config.modes.filter((m) => m.mode === 'collective');
    expect(collectives.map((m) => (m as { strategy?: string }).strategy).sort()).toEqual([
      'blind-debate',
      'consensus',
    ]);
    // NOTE: under the unit-test prisma mock, resolveTopTierModels() resolves
    // empty, so single-model arms may be absent HERE; in production the
    // registry provides them (same resolver the main comparison uses). The
    // collective arms are the structural invariant this test pins.
    expect(config.modes.length).toBeGreaterThanOrEqual(2);
  });

  it('every referenced task index exists in the suite AND carries an answerCheck', async () => {
    const { VERIFIABLE_TASK_INDICES } = await import('../c3-experiment-configs');
    const { EXPERIMENT_SUITE } = await import('../experiment-suite');
    for (const idx of VERIFIABLE_TASK_INDICES) {
      const task = EXPERIMENT_SUITE.find((t) => t.index === idx);
      expect(task, `task ${idx} must exist`).toBeDefined();
      expect(task!.answerCheck, `task ${idx} must be verifiable (answerCheck)`).toBeDefined();
    }
  });

  it('is cost-guarded (small budget, small warmup, learning frozen)', async () => {
    const { buildC3VerifiableMiniRun } = await import('../c3-experiment-configs');
    const config = await buildC3VerifiableMiniRun();
    expect(config.maxBudgetUsd).toBeLessThanOrEqual(10);
    expect(config.warmupExecutions).toBeLessThanOrEqual(10);
    expect(config.freezeLearningDuringEval).toBe(true);
    const overridden = await buildC3VerifiableMiniRun({ maxBudgetUsd: 3, repetitions: 1 });
    expect(overridden.maxBudgetUsd).toBe(3);
    expect(overridden.repetitions).toBe(1);
  });
});
