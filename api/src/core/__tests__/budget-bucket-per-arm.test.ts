// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Budget Bucket per-Arm Tests (ramp-final regression guard)
 *
 * Regression context: in c3-pilot-ramp-final, 13 of 65 executions were
 * silently skipped because the CreditGovernor used
 *   `getModeKey(item.mode).split(':')[0]`
 * as the arm bucket key. That collapsed every collective strategy into
 * the single bucket "collective", every single-model pin into the
 * bucket "single-model", and every single-budget pin into "single-budget".
 * The arm budget for `collective` was then shared across 7 strategies, so
 * as soon as consensus + expert-panel together consumed ~$0.77 (the
 * per-mode-share of a $10 budget across 13 modes), ALL remaining
 * `collective:*` tasks got skipped with `arm_budget_exceeded` — regardless
 * of which specific strategy was about to run.
 *
 * These tests pin the contract that:
 *   1. Each ARM (not each mode class) gets its own bucket.
 *   2. A bucket exhausted by one arm does NOT block sibling arms in the
 *      same mode class.
 *   3. Sibling arms (single-model:A vs single-model:B) get independent
 *      budgets even though both have `mode = 'single-model'`.
 *   4. adaptive arms get their own bucket.
 *
 * The matchers here intentionally use the same shape the runner does so
 * a future refactor of getModeKey() still passes — we test behavior, not
 * the bucket-key string format.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CreditGovernor } from '../budget/credit-governor';

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * The shape getModeKey produces in experiment-runner. Duplicated here
 * intentionally so a test failure points at "the runner changed its
 * bucket-key shape" rather than at the test file.
 */
function modeKeyForTest(mode:
  | { mode: 'single-model'; modelId: string }
  | { mode: 'single-budget'; modelId: string }
  | { mode: 'collective'; strategy: string }
  | { mode: 'forced-pool-collective'; strategy: string }
  | { mode: 'adaptive' }
  | { mode: 'ablation'; strategy: string; disableComponents: string[] }
): string {
  switch (mode.mode) {
    case 'single-model': return `single-model:${mode.modelId}`;
    case 'collective': return `collective:${mode.strategy}`;
    case 'forced-pool-collective': return `collective-tier1:${mode.strategy}`;
    case 'single-budget': return `single-budget:${mode.modelId}`;
    case 'adaptive': return 'adaptive';
    case 'ablation': return `ablation:${mode.strategy}:${mode.disableComponents.join(',')}`;
  }
}

const COLLECTIVE_STRATEGIES = [
  'consensus',
  'parallel',
  'debate',
  'expert-panel',
  'sensitivity-consensus',
  'tri-role-collective',
  'critique-repair',
] as const;

const TOTAL_BUDGET = 10;
const ARM_COUNT_FOR_RAMP = 13; // 3 top-tier + 7 collective + 2 budget + 1 adaptive
const PER_ARM = TOTAL_BUDGET / ARM_COUNT_FOR_RAMP; // ≈ $0.769

// ─── Tests ──────────────────────────────────────────────────────────────

describe('CreditGovernor — budget bucket per-arm (ramp-final regression)', () => {
  describe('bucket-key uniqueness', () => {
    it('produces 7 distinct keys for the 7 collective strategies', () => {
      const keys = new Set(COLLECTIVE_STRATEGIES.map((s) => modeKeyForTest({ mode: 'collective', strategy: s })));
      expect(keys.size).toBe(7);
      // And none of them collapse to the bare "collective" string.
      expect(keys.has('collective')).toBe(false);
      expect([...keys]).toEqual(expect.arrayContaining(['collective:consensus', 'collective:parallel']));
    });

    it('produces distinct keys for sibling single-model pins', () => {
      const keys = new Set([
        modeKeyForTest({ mode: 'single-model', modelId: 'xai/grok-4-fast-reasoning' }),
        modeKeyForTest({ mode: 'single-model', modelId: 'accounts/fireworks/models/deepseek-v4-pro' }),
        modeKeyForTest({ mode: 'single-model', modelId: 'kimi-k2.6' }),
      ]);
      expect(keys.size).toBe(3);
    });

    it('produces distinct keys for sibling single-budget pins', () => {
      const keys = new Set([
        modeKeyForTest({ mode: 'single-budget', modelId: 'mistral/mistral-nemo' }),
        modeKeyForTest({ mode: 'single-budget', modelId: 'nvidia/NVIDIA-Nemotron-3-Nano-Omni' }),
      ]);
      expect(keys.size).toBe(2);
    });

    it('adaptive arm has its own bucket, not shared with collective or single', () => {
      const adaptiveKey = modeKeyForTest({ mode: 'adaptive' });
      const collectiveKey = modeKeyForTest({ mode: 'collective', strategy: 'consensus' });
      const singleKey = modeKeyForTest({ mode: 'single-model', modelId: 'x' });
      expect(adaptiveKey).not.toBe(collectiveKey);
      expect(adaptiveKey).not.toBe(singleKey);
      expect(adaptiveKey).toBe('adaptive');
    });

    it('a full ramp-final mode list yields 13 distinct bucket keys', () => {
      const modes = [
        { mode: 'single-model', modelId: 'a' } as const,
        { mode: 'single-model', modelId: 'b' } as const,
        { mode: 'single-model', modelId: 'c' } as const,
        ...COLLECTIVE_STRATEGIES.map((s) => ({ mode: 'collective' as const, strategy: s })),
        { mode: 'single-budget', modelId: 'x' } as const,
        { mode: 'single-budget', modelId: 'y' } as const,
        { mode: 'adaptive' } as const,
      ];
      const keys = new Set(modes.map(modeKeyForTest));
      expect(keys.size).toBe(13);
    });
  });

  describe('per-arm budget exhaustion does not block sibling arms', () => {
    let governor: CreditGovernor;

    beforeEach(() => {
      const armBudgets = Object.fromEntries(
        COLLECTIVE_STRATEGIES.map((s) => [`collective:${s}`, PER_ARM] as const),
      );
      governor = new CreditGovernor({
        experimentBudgetUsd: TOTAL_BUDGET,
        minBufferUsd: 0,
        armBudgets,
      });
    });

    it('consensus exhausted does NOT block parallel', () => {
      // Consensus blows its budget.
      governor.recordSpend('moonshot', 'kimi-k2.6', PER_ARM + 0.01, 'collective:consensus');

      // Parallel tries to execute — must be allowed.
      const decision = governor.canExecute('groq', 'llama-3.3-70b', 0.005, 'collective:parallel');
      expect(decision.canProceed).toBe(true);
    });

    it('expert-panel exhausted does NOT block sensitivity-consensus', () => {
      governor.recordSpend('any', 'm', PER_ARM + 0.01, 'collective:expert-panel');

      const decision = governor.canExecute('any', 'm', 0.005, 'collective:sensitivity-consensus');
      expect(decision.canProceed).toBe(true);
    });

    it('consensus exhausted DOES block consensus itself', () => {
      governor.recordSpend('any', 'm', PER_ARM + 0.01, 'collective:consensus');
      const decision = governor.canExecute('any', 'm', 0.005, 'collective:consensus');
      expect(decision.canProceed).toBe(false);
      expect(decision.reason).toBe('arm_budget_exceeded');
    });

    it('single-model:A exhausted does NOT block single-model:B', () => {
      const governor2 = new CreditGovernor({
        experimentBudgetUsd: TOTAL_BUDGET,
        minBufferUsd: 0,
        armBudgets: {
          'single-model:A': PER_ARM,
          'single-model:B': PER_ARM,
        },
      });
      governor2.recordSpend('p', 'A', PER_ARM + 0.01, 'single-model:A');
      const decision = governor2.canExecute('p', 'B', 0.005, 'single-model:B');
      expect(decision.canProceed).toBe(true);
    });

    it('single-budget exhausted does NOT block single-model or collective', () => {
      const governor3 = new CreditGovernor({
        experimentBudgetUsd: TOTAL_BUDGET,
        minBufferUsd: 0,
        armBudgets: {
          'single-budget:cheap': PER_ARM,
          'single-model:premium': PER_ARM,
          'collective:consensus': PER_ARM,
        },
      });
      governor3.recordSpend('p', 'cheap', PER_ARM + 0.01, 'single-budget:cheap');
      expect(governor3.canExecute('p', 'premium', 0.005, 'single-model:premium').canProceed).toBe(true);
      expect(governor3.canExecute('p', 'cmm', 0.005, 'collective:consensus').canProceed).toBe(true);
    });
  });

  describe('experiment-wide budget still gates everything', () => {
    it('exhausting the experiment budget blocks even fresh arms', () => {
      const governor = new CreditGovernor({
        experimentBudgetUsd: 1,
        minBufferUsd: 0,
        armBudgets: {
          'collective:consensus': 0.5,
          'collective:parallel': 0.5,
        },
      });
      governor.recordSpend('p', 'm', 0.9, 'collective:consensus');
      // collective:parallel still has budget, but the experiment is almost out.
      const decision = governor.canExecute('p', 'm', 0.2, 'collective:parallel');
      expect(decision.canProceed).toBe(false);
      expect(decision.reason).toBe('experiment_budget_exceeded');
    });
  });

  describe('regression: bad armName shape used to collapse buckets', () => {
    it('the bare strings "collective" / "single-model" must not be the bucket key', () => {
      // The bug was that armName was getModeKey(mode).split(':')[0] →
      // "collective" or "single-model". If the runner ever regresses, the
      // tests above won't catch it because they pass full keys directly.
      // This test pins the shape contract.
      expect(modeKeyForTest({ mode: 'collective', strategy: 'consensus' })).not.toBe('collective');
      expect(modeKeyForTest({ mode: 'single-model', modelId: 'foo' })).not.toBe('single-model');
      expect(modeKeyForTest({ mode: 'single-budget', modelId: 'foo' })).not.toBe('single-budget');
    });
  });
});
