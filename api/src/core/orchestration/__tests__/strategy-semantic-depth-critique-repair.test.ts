// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-SM-R6 §13b — FIX-003: critique-repair semantic depth tests.
 *
 * SM-R4/R5 classified critique-repair as `semantic_fidelity_partial` because
 * the plan showed only 2 generic execute/synthesize steps. SM-R6 FIX-003
 * replaces that with a 3-step semantic pipeline:
 *   step-0  critique    → providerCallPlanned: true  (identify flaws)
 *   step-1  repair      → providerCallPlanned: true  (rewrite/fix)
 *   step-2  validation  → providerCallPlanned: false (structural check, no extra call)
 *
 * Classification after SM-R6: semantic_fidelity_pass.
 *
 * What this test covers:
 *   - Exact step count (3)
 *   - Per-step: stepId suffix, action, role, phase, providerCallPlanned
 *   - strategySemantics presence and repairPolicy content
 *   - semanticPlanVersion = '01c1b-sm-r6-v1'
 *   - No providerCallExecuted in any step (dry-run guarantee)
 *   - Role vocabulary: critic → repairer → validator
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import type { OrchestrationContext } from '@/types';

const CTX: OrchestrationContext = {
  requestId: 'sm-r6-critique-repair-001',
  taskType: 'general',
  qualityTarget: 0.88,
  preferSpeed: false,
  models: [
    { id: 'model-critic', provider: 'anthropic' } as OrchestrationContext['models'][0],
    { id: 'model-repairer', provider: 'openai' } as OrchestrationContext['models'][0],
  ],
};

const REQ = {
  model: 'auto',
  messages: [{ role: 'user' as const, content: 'critique-repair depth test' }],
  dryRun: true as const,
};

function getCRResult() {
  return buildPlanOnlyResult(
    'critique-repair', 'explicit', 'request-flag', REQ, CTX, null, 0.88, { registered: true },
  );
}

function getCRPlan() {
  const meta = getCRResult().metadata as Record<string, unknown>;
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

describe('01C.1B-SM-R6 FIX-003 — critique-repair semantic depth (3-step pipeline)', () => {
  describe('step count', () => {
    it('has exactly 3 steps', () => {
      expect(getCRPlan().steps).toHaveLength(3);
    });
  });

  describe('step-0: critique', () => {
    it('stepId suffix is "critique"', () => {
      expect(getCRPlan().steps[0]!.stepId).toBe('step-0-critique');
    });

    it('action is critique-repair/critique', () => {
      expect(getCRPlan().steps[0]!.action).toBe('critique-repair/critique');
    });

    it('role is critic', () => {
      expect(getCRPlan().steps[0]!.role).toBe('critic');
    });

    it('phase is critique', () => {
      expect(getCRPlan().steps[0]!.phase).toBe('critique');
    });

    it('providerCallPlanned is true (calls model to identify flaws)', () => {
      expect(getCRPlan().steps[0]!.providerCallPlanned).toBe(true);
    });

    it('providerCallExecuted is false (dry-run guarantee)', () => {
      expect(getCRPlan().steps[0]!.providerCallExecuted).toBe(false);
    });
  });

  describe('step-1: repair', () => {
    it('stepId suffix is "repair"', () => {
      expect(getCRPlan().steps[1]!.stepId).toBe('step-1-repair');
    });

    it('action is critique-repair/repair-rewrite', () => {
      expect(getCRPlan().steps[1]!.action).toBe('critique-repair/repair-rewrite');
    });

    it('role is repairer', () => {
      expect(getCRPlan().steps[1]!.role).toBe('repairer');
    });

    it('phase is repair', () => {
      expect(getCRPlan().steps[1]!.phase).toBe('repair');
    });

    it('providerCallPlanned is true (calls model to rewrite/fix)', () => {
      expect(getCRPlan().steps[1]!.providerCallPlanned).toBe(true);
    });
  });

  describe('step-2: validation', () => {
    it('stepId suffix is "validate"', () => {
      expect(getCRPlan().steps[2]!.stepId).toBe('step-2-validate');
    });

    it('action is critique-repair/final-validation', () => {
      expect(getCRPlan().steps[2]!.action).toBe('critique-repair/final-validation');
    });

    it('role is validator', () => {
      expect(getCRPlan().steps[2]!.role).toBe('validator');
    });

    it('phase is validation', () => {
      expect(getCRPlan().steps[2]!.phase).toBe('validation');
    });

    it('providerCallPlanned is false (structural check, no extra provider call)', () => {
      expect(getCRPlan().steps[2]!.providerCallPlanned).toBe(false);
    });
  });

  describe('strategySemantics', () => {
    it('strategySemantics is present', () => {
      expect(getCRPlan().strategySemantics).toBeDefined();
    });

    it('semanticPlanVersion is 01c1b-sm-r6-v1', () => {
      const s = getCRPlan().strategySemantics!;
      expect(s['semanticPlanVersion']).toBe('01c1b-sm-r6-v1');
    });

    it('strategyId is critique-repair', () => {
      const s = getCRPlan().strategySemantics!;
      expect(s['strategyId']).toBe('critique-repair');
    });

    it('phaseCount is 3', () => {
      const s = getCRPlan().strategySemantics!;
      expect(s['phaseCount']).toBe(3);
    });

    it('phases array is [critique, repair, validation]', () => {
      const s = getCRPlan().strategySemantics!;
      expect(s['phases']).toEqual(['critique', 'repair', 'validation']);
    });

    it('roles array is [critic, repairer, validator]', () => {
      const s = getCRPlan().strategySemantics!;
      expect(s['roles']).toEqual(['critic', 'repairer', 'validator']);
    });

    it('repairPolicy is present', () => {
      const s = getCRPlan().strategySemantics!;
      expect(s['repairPolicy']).toBeDefined();
    });

    it('repairPolicy.critiqueRequired is true', () => {
      const s = getCRPlan().strategySemantics!;
      const policy = s['repairPolicy'] as Record<string, unknown>;
      expect(policy['critiqueRequired']).toBe(true);
    });

    it('repairPolicy.repairRequired is true', () => {
      const s = getCRPlan().strategySemantics!;
      const policy = s['repairPolicy'] as Record<string, unknown>;
      expect(policy['repairRequired']).toBe(true);
    });

    it('repairPolicy.finalValidationRequired is true', () => {
      const s = getCRPlan().strategySemantics!;
      const policy = s['repairPolicy'] as Record<string, unknown>;
      expect(policy['finalValidationRequired']).toBe(true);
    });

    it('cascadePolicy is absent (critique-repair does not cascade)', () => {
      const s = getCRPlan().strategySemantics!;
      expect(s['cascadePolicy']).toBeUndefined();
    });

    it('iterationPolicy is absent (critique-repair does not iterate)', () => {
      const s = getCRPlan().strategySemantics!;
      expect(s['iterationPolicy']).toBeUndefined();
    });
  });

  describe('dry-run invariants', () => {
    it('no providerCallExecuted in any step', () => {
      const steps = getCRPlan().steps;
      expect(steps.every(s => s.providerCallExecuted === false)).toBe(true);
    });

    it('all actions carry the critique-repair/ prefix', () => {
      const actions = getCRPlan().steps.map(s => s.action);
      expect(actions.every(a => a.startsWith('critique-repair/'))).toBe(true);
    });

    it('totalCost is 0', () => {
      expect(getCRResult().totalCost).toBe(0);
    });

    it('executable is true when registered', () => {
      const meta = getCRResult().metadata as Record<string, unknown>;
      expect(meta['executable']).toBe(true);
    });

    it('planFingerprint starts with pf_', () => {
      const meta = getCRResult().metadata as Record<string, unknown>;
      expect((meta['planFingerprint'] as string).startsWith('pf_')).toBe(true);
    });
  });
});
