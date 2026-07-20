// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-SM-R6 §13a — FIX-002: cost-cascade semantic depth tests.
 *
 * SM-R4/R5 classified cost-cascade as `semantic_fidelity_partial` because the
 * plan showed only 1 generic step. SM-R6 FIX-002 replaces that with a 4-step
 * semantic cascade:
 *   step-0  cheap_first_attempt  → providerCallPlanned: true  (try cheap model)
 *   step-1  quality_gate         → providerCallPlanned: false (evaluate result)
 *   step-2  escalation           → providerCallPlanned: true  (escalate if needed)
 *   step-3  finalization         → providerCallPlanned: false (budget-cap decision)
 *
 * Classification after SM-R6: semantic_fidelity_pass (6/8 strategies → 7/8).
 *
 * What this test covers:
 *   - Exact step count (4)
 *   - Per-step: stepId suffix, action, role, phase, providerCallPlanned
 *   - strategySemantics presence and cascadePolicy content
 *   - semanticPlanVersion = '01c1b-sm-r6-v1'
 *   - Roles cover the full cascade pipeline vocabulary
 *   - No providerCallExecuted in any step (dry-run guarantee)
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import type { OrchestrationContext } from '@/types';

const CTX: OrchestrationContext = {
  requestId: 'sm-r6-cascade-001',
  taskType: 'general',
  qualityTarget: 0.80,
  preferSpeed: false,
  models: [
    { id: 'model-cheap', provider: 'openai' } as OrchestrationContext['models'][0],
    { id: 'model-quality', provider: 'anthropic' } as OrchestrationContext['models'][0],
  ],
};

const REQ = {
  model: 'auto',
  messages: [{ role: 'user' as const, content: 'cascade depth test' }],
  dryRun: true as const,
};

function getCascadeResult() {
  return buildPlanOnlyResult(
    'cost-cascade', 'explicit', 'request-flag', REQ, CTX, null, 0.80, { registered: true },
  );
}

function getCascadePlan() {
  const meta = getCascadeResult().metadata as Record<string, unknown>;
  return meta['executionPlan'] as {
    steps: Array<{
      stepId: string;
      action: string;
      role?: string;
      phase?: string;
      providerCallPlanned: boolean;
      providerCallExecuted: boolean;
    }>;
    planNote: string;
    strategySemantics?: Record<string, unknown>;
  };
}

describe('01C.1B-SM-R6 FIX-002 — cost-cascade semantic depth (4-step cascade)', () => {
  describe('step count', () => {
    it('has exactly 4 steps', () => {
      expect(getCascadePlan().steps).toHaveLength(4);
    });
  });

  describe('step-0: cheap_first_attempt', () => {
    it('stepId suffix is "cheap-attempt"', () => {
      expect(getCascadePlan().steps[0]!.stepId).toBe('step-0-cheap-attempt');
    });

    it('action is cost-cascade/cheap-first-attempt', () => {
      expect(getCascadePlan().steps[0]!.action).toBe('cost-cascade/cheap-first-attempt');
    });

    it('role is cheap_candidate', () => {
      expect(getCascadePlan().steps[0]!.role).toBe('cheap_candidate');
    });

    it('phase is cheap_first_attempt', () => {
      expect(getCascadePlan().steps[0]!.phase).toBe('cheap_first_attempt');
    });

    it('providerCallPlanned is true (calls cheap model)', () => {
      expect(getCascadePlan().steps[0]!.providerCallPlanned).toBe(true);
    });

    it('providerCallExecuted is false (dry-run guarantee)', () => {
      expect(getCascadePlan().steps[0]!.providerCallExecuted).toBe(false);
    });
  });

  describe('step-1: quality_gate', () => {
    it('stepId suffix is "quality-gate"', () => {
      expect(getCascadePlan().steps[1]!.stepId).toBe('step-1-quality-gate');
    });

    it('action is cost-cascade/quality-gate', () => {
      expect(getCascadePlan().steps[1]!.action).toBe('cost-cascade/quality-gate');
    });

    it('role is quality_gate', () => {
      expect(getCascadePlan().steps[1]!.role).toBe('quality_gate');
    });

    it('phase is quality_gate', () => {
      expect(getCascadePlan().steps[1]!.phase).toBe('quality_gate');
    });

    it('providerCallPlanned is false (gate evaluates, no new call)', () => {
      expect(getCascadePlan().steps[1]!.providerCallPlanned).toBe(false);
    });
  });

  describe('step-2: escalation', () => {
    it('stepId suffix is "escalation"', () => {
      expect(getCascadePlan().steps[2]!.stepId).toBe('step-2-escalation');
    });

    it('action is cost-cascade/escalate-if-needed', () => {
      expect(getCascadePlan().steps[2]!.action).toBe('cost-cascade/escalate-if-needed');
    });

    it('role is escalator', () => {
      expect(getCascadePlan().steps[2]!.role).toBe('escalator');
    });

    it('phase is escalation', () => {
      expect(getCascadePlan().steps[2]!.phase).toBe('escalation');
    });

    it('providerCallPlanned is true (calls quality-tier model on escalation)', () => {
      expect(getCascadePlan().steps[2]!.providerCallPlanned).toBe(true);
    });
  });

  describe('step-3: finalization', () => {
    it('stepId suffix is "finalize"', () => {
      expect(getCascadePlan().steps[3]!.stepId).toBe('step-3-finalize');
    });

    it('action is cost-cascade/finalize-with-budget-cap', () => {
      expect(getCascadePlan().steps[3]!.action).toBe('cost-cascade/finalize-with-budget-cap');
    });

    it('role is synthesizer', () => {
      expect(getCascadePlan().steps[3]!.role).toBe('synthesizer');
    });

    it('phase is finalization', () => {
      expect(getCascadePlan().steps[3]!.phase).toBe('finalization');
    });

    it('providerCallPlanned is false (budget-cap is a selection decision)', () => {
      expect(getCascadePlan().steps[3]!.providerCallPlanned).toBe(false);
    });
  });

  describe('strategySemantics', () => {
    it('strategySemantics is present', () => {
      expect(getCascadePlan().strategySemantics).toBeDefined();
    });

    it('semanticPlanVersion is 01c1b-sm-r6-v1', () => {
      const s = getCascadePlan().strategySemantics!;
      expect(s['semanticPlanVersion']).toBe('01c1b-sm-r6-v1');
    });

    it('strategyId is cost-cascade', () => {
      const s = getCascadePlan().strategySemantics!;
      expect(s['strategyId']).toBe('cost-cascade');
    });

    it('phaseCount is 4', () => {
      const s = getCascadePlan().strategySemantics!;
      expect(s['phaseCount']).toBe(4);
    });

    it('phases array has 4 entries in correct order', () => {
      const s = getCascadePlan().strategySemantics!;
      expect(s['phases']).toEqual([
        'cheap_first_attempt',
        'quality_gate',
        'escalation',
        'finalization',
      ]);
    });

    it('roles array covers all 4 cascade roles', () => {
      const s = getCascadePlan().strategySemantics!;
      expect(s['roles']).toEqual([
        'cheap_candidate',
        'quality_gate',
        'escalator',
        'synthesizer',
      ]);
    });

    it('cascadePolicy is present', () => {
      const s = getCascadePlan().strategySemantics!;
      expect(s['cascadePolicy']).toBeDefined();
    });

    it('cascadePolicy.tiers includes cheap_first_attempt and escalation', () => {
      const s = getCascadePlan().strategySemantics!;
      const policy = s['cascadePolicy'] as Record<string, unknown>;
      expect(policy['tiers']).toContain('cheap_first_attempt');
      expect(policy['tiers']).toContain('escalation');
    });

    it('cascadePolicy.escalationThreshold is quality_gate_fail', () => {
      const s = getCascadePlan().strategySemantics!;
      const policy = s['cascadePolicy'] as Record<string, unknown>;
      expect(policy['escalationThreshold']).toBe('quality_gate_fail');
    });

    it('cascadePolicy.stopCondition is quality_gate_pass_or_budget_exhausted', () => {
      const s = getCascadePlan().strategySemantics!;
      const policy = s['cascadePolicy'] as Record<string, unknown>;
      expect(policy['stopCondition']).toBe('quality_gate_pass_or_budget_exhausted');
    });

    it('iterationPolicy is absent (cascade does not iterate)', () => {
      const s = getCascadePlan().strategySemantics!;
      expect(s['iterationPolicy']).toBeUndefined();
    });

    it('repairPolicy is absent (cascade does not critique-repair)', () => {
      const s = getCascadePlan().strategySemantics!;
      expect(s['repairPolicy']).toBeUndefined();
    });
  });

  describe('dry-run invariants', () => {
    it('no providerCallExecuted in any step', () => {
      const steps = getCascadePlan().steps;
      expect(steps.every(s => s.providerCallExecuted === false)).toBe(true);
    });

    it('all actions carry the cost-cascade/ prefix', () => {
      const actions = getCascadePlan().steps.map(s => s.action);
      expect(actions.every(a => a.startsWith('cost-cascade/'))).toBe(true);
    });

    it('totalCost is 0', () => {
      expect(getCascadeResult().totalCost).toBe(0);
    });

    it('dryRun marker is true', () => {
      const meta = getCascadeResult().metadata as Record<string, unknown>;
      expect(meta['dryRun']).toBe(true);
    });

    it('planFingerprint starts with pf_', () => {
      const meta = getCascadeResult().metadata as Record<string, unknown>;
      expect((meta['planFingerprint'] as string).startsWith('pf_')).toBe(true);
    });
  });
});
