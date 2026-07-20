// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-SM-R4 §13a — Strategy semantic plan fidelity tests.
 *
 * Verifies that each strategy's dry-run plan is semantically faithful:
 *   - Step count is correct for the strategy family
 *   - Action names carry the strategy prefix (not generic verbs)
 *   - Plans are not empty or blocked for registered strategies
 *   - Single-step strategies do not have a synthesis step
 *   - Multi-step strategies include a synthesis or second step
 *
 * Classification targeted: semantic_fidelity_pass (single) or
 * semantic_fidelity_partial (all others) — no generic_skeleton_only.
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import type { OrchestrationContext } from '@/types';

const CTX: OrchestrationContext = {
  requestId: 'sm-r4-fidelity-001',
  taskType: 'general',
  qualityTarget: 0.85,
  preferSpeed: false,
  models: [
    { id: 'model-a', provider: 'openai' } as OrchestrationContext['models'][0],
    { id: 'model-b', provider: 'anthropic' } as OrchestrationContext['models'][0],
    { id: 'model-c', provider: 'google' } as OrchestrationContext['models'][0],
  ],
};

const REQ = {
  model: 'auto',
  messages: [{ role: 'user' as const, content: 'test' }],
  dryRun: true as const,
};

function getPlan(strategyName: string, registered = true) {
  const result = buildPlanOnlyResult(
    strategyName, 'explicit', 'request-flag', REQ, CTX, null, 0.85,
    { registered },
  );
  return (result.metadata as Record<string, unknown>)['executionPlan'] as {
    steps: Array<{ stepId: string; action: string; providerCallPlanned: boolean; providerCallExecuted: boolean }>;
    planNote: string;
  };
}

// ── Single-model strategy ─────────────────────────────────────────────────────
describe('01C.1B-SM-R4 §13a — single strategy fidelity', () => {
  it('has exactly 1 step', () => {
    expect(getPlan('single').steps).toHaveLength(1);
  });

  it('step-0 action is single/direct-answer (SM-R6: template renamed from execute)', () => {
    expect(getPlan('single').steps[0]!.action).toBe('single/direct-answer');
  });

  it('has no synthesis step', () => {
    const actions = getPlan('single').steps.map(s => s.action);
    expect(actions.every(a => !a.includes('synthesize'))).toBe(true);
  });

  it('providerCallPlanned=true in live semantics', () => {
    expect(getPlan('single').steps[0]!.providerCallPlanned).toBe(true);
  });

  it('providerCallExecuted=false (dry-run guarantee)', () => {
    expect(getPlan('single').steps[0]!.providerCallExecuted).toBe(false);
  });

  it('planNote mentions single and step count', () => {
    const note = getPlan('single').planNote;
    expect(note).toContain('single');
    expect(note).toContain('1');
  });
});

// ── Cost-cascade: 4-step semantic cascade (SM-R6 FIX-002) ────────────────────
describe('01C.1B-SM-R6 §13a — cost-cascade strategy fidelity (FIX-002: 4-step cascade)', () => {
  it('has exactly 4 steps (cheap-attempt → quality-gate → escalation → finalize)', () => {
    expect(getPlan('cost-cascade').steps).toHaveLength(4);
  });

  it('step-0 action is cost-cascade/cheap-first-attempt', () => {
    expect(getPlan('cost-cascade').steps[0]!.action).toBe('cost-cascade/cheap-first-attempt');
  });

  it('action name is not generic (has strategy prefix)', () => {
    const action = getPlan('cost-cascade').steps[0]!.action;
    expect(action).toContain('cost-cascade');
    expect(action).toContain('/');
  });
});

// ── Multi-step strategies ─────────────────────────────────────────────────────
// SM-R5/R6 split:
//   STEP_ROLES group (consensus, debate, expert-panel): still use execute/synthesize 2-tier
//   TEMPLATE group (quality-multipass, critique-repair): SM-R6 deep semantic templates
const STEP_ROLES_STRATEGIES = ['consensus', 'debate', 'expert-panel'];
const TEMPLATE_MULTI_STRATEGIES = ['quality-multipass', 'critique-repair'];
const MULTI_STEP_STRATEGIES = [...STEP_ROLES_STRATEGIES, ...TEMPLATE_MULTI_STRATEGIES];

describe('01C.1B-SM-R4 §13a — multi-step strategy fidelity (STEP_ROLES 2-tier)', () => {
  for (const strategy of STEP_ROLES_STRATEGIES) {
    it(`${strategy}: has at least 2 steps`, () => {
      expect(getPlan(strategy).steps.length).toBeGreaterThanOrEqual(2);
    });

    it(`${strategy}: step-0 action is ${strategy}/execute`, () => {
      expect(getPlan(strategy).steps[0]!.action).toBe(`${strategy}/execute`);
    });

    it(`${strategy}: step-1 action is ${strategy}/synthesize`, () => {
      expect(getPlan(strategy).steps[1]!.action).toBe(`${strategy}/synthesize`);
    });

    it(`${strategy}: all actions carry the strategy prefix`, () => {
      const actions = getPlan(strategy).steps.map(s => s.action);
      expect(actions.every(a => a.startsWith(strategy + '/'))).toBe(true);
    });

    it(`${strategy}: no providerCallExecuted in any step`, () => {
      const steps = getPlan(strategy).steps;
      expect(steps.every(s => s.providerCallExecuted === false)).toBe(true);
    });
  }
});

describe('01C.1B-SM-R6 §13a — multi-step strategy fidelity (semantic templates)', () => {
  for (const strategy of TEMPLATE_MULTI_STRATEGIES) {
    it(`${strategy}: has at least 2 steps`, () => {
      expect(getPlan(strategy).steps.length).toBeGreaterThanOrEqual(2);
    });

    it(`${strategy}: all actions carry the strategy prefix`, () => {
      const actions = getPlan(strategy).steps.map(s => s.action);
      expect(actions.every(a => a.startsWith(strategy + '/'))).toBe(true);
    });

    it(`${strategy}: no providerCallExecuted in any step`, () => {
      const steps = getPlan(strategy).steps;
      expect(steps.every(s => s.providerCallExecuted === false)).toBe(true);
    });
  }

  // quality-multipass specific (SM-R6 FIX-004: 4-step draft→review→refine→final)
  it('quality-multipass: step-0 action is quality-multipass/draft', () => {
    expect(getPlan('quality-multipass').steps[0]!.action).toBe('quality-multipass/draft');
  });

  it('quality-multipass: step-1 action is quality-multipass/critique-review', () => {
    expect(getPlan('quality-multipass').steps[1]!.action).toBe('quality-multipass/critique-review');
  });

  // critique-repair specific (SM-R6 FIX-003: 3-step critique→repair→validation)
  it('critique-repair: step-0 action is critique-repair/critique', () => {
    expect(getPlan('critique-repair').steps[0]!.action).toBe('critique-repair/critique');
  });

  it('critique-repair: step-1 action is critique-repair/repair-rewrite', () => {
    expect(getPlan('critique-repair').steps[1]!.action).toBe('critique-repair/repair-rewrite');
  });
});

// ── Blocked / unregistered strategies ────────────────────────────────────────
describe('01C.1B-SM-R4 §13a — unregistered strategy plan', () => {
  it('blocked plan has step-0-blocked action', () => {
    const plan = getPlan('nonexistent-strategy', false);
    expect(plan.steps[0]!.action).toBe('blocked');
  });

  it('blocked plan has providerCallPlanned=false', () => {
    const plan = getPlan('nonexistent-strategy', false);
    expect(plan.steps[0]!.providerCallPlanned).toBe(false);
  });

  it('blocked planNote mentions blockers', () => {
    const plan = getPlan('nonexistent-strategy', false);
    expect(plan.planNote.toLowerCase()).toContain('block');
  });
});

// ── No generic skeletons ──────────────────────────────────────────────────────
describe('01C.1B-SM-R4 §13a — no generic skeleton actions', () => {
  const ALL_STRATEGIES = ['single', 'cost-cascade', 'consensus', 'debate', 'quality-multipass', 'critique-repair', 'expert-panel'];

  it('no strategy has action "execute" without a prefix', () => {
    for (const strategy of ALL_STRATEGIES) {
      const actions = getPlan(strategy).steps.map(s => s.action);
      expect(actions.every(a => a !== 'execute' && a !== 'synthesize')).toBe(true);
    }
  });

  it('all actions contain a / separator (strategy/verb format)', () => {
    for (const strategy of ALL_STRATEGIES) {
      const actions = getPlan(strategy).steps.map(s => s.action);
      expect(actions.every(a => a.includes('/'))).toBe(true);
    }
  });
});
