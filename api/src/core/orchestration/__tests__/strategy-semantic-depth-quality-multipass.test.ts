// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-SM-R6 §13c — FIX-004: quality-multipass semantic depth tests.
 *
 * SM-R4/R5 classified quality-multipass as `semantic_fidelity_partial` because
 * the plan showed only 2 generic execute/synthesize steps. SM-R6 FIX-004
 * replaces that with a 4-step semantic pipeline:
 *   step-0  draft    → providerCallPlanned: true  (initial generation)
 *   step-1  review   → providerCallPlanned: true  (critique + scoring)
 *   step-2  refine   → providerCallPlanned: true  (improvement pass)
 *   step-3  final    → providerCallPlanned: false (selection decision)
 *
 * Classification after SM-R6: semantic_fidelity_pass.
 *
 * What this test covers:
 *   - Exact step count (4)
 *   - Per-step: stepId suffix, action, role, phase, providerCallPlanned
 *   - strategySemantics presence and iterationPolicy content
 *   - semanticPlanVersion = '01c1b-sm-r6-v1'
 *   - No providerCallExecuted in any step (dry-run guarantee)
 *   - Role vocabulary: drafter → reviewer → refiner → synthesizer
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import type { OrchestrationContext } from '@/types';

const CTX: OrchestrationContext = {
  requestId: 'sm-r6-quality-multipass-001',
  taskType: 'general',
  qualityTarget: 0.92,
  preferSpeed: false,
  models: [
    { id: 'model-drafter', provider: 'openai' } as OrchestrationContext['models'][0],
    { id: 'model-reviewer', provider: 'anthropic' } as OrchestrationContext['models'][0],
    { id: 'model-refiner', provider: 'google' } as OrchestrationContext['models'][0],
  ],
};

const REQ = {
  model: 'auto',
  messages: [{ role: 'user' as const, content: 'quality-multipass depth test' }],
  dryRun: true as const,
};

function getQMResult() {
  return buildPlanOnlyResult(
    'quality-multipass', 'explicit', 'request-flag', REQ, CTX, null, 0.92, { registered: true },
  );
}

function getQMPlan() {
  const meta = getQMResult().metadata as Record<string, unknown>;
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

describe('01C.1B-SM-R6 FIX-004 — quality-multipass semantic depth (4-step pipeline)', () => {
  describe('step count', () => {
    it('has exactly 4 steps', () => {
      expect(getQMPlan().steps).toHaveLength(4);
    });
  });

  describe('step-0: draft', () => {
    it('stepId suffix is "draft"', () => {
      expect(getQMPlan().steps[0]!.stepId).toBe('step-0-draft');
    });

    it('action is quality-multipass/draft', () => {
      expect(getQMPlan().steps[0]!.action).toBe('quality-multipass/draft');
    });

    it('role is drafter', () => {
      expect(getQMPlan().steps[0]!.role).toBe('drafter');
    });

    it('phase is draft', () => {
      expect(getQMPlan().steps[0]!.phase).toBe('draft');
    });

    it('providerCallPlanned is true (initial generation pass)', () => {
      expect(getQMPlan().steps[0]!.providerCallPlanned).toBe(true);
    });

    it('providerCallExecuted is false (dry-run guarantee)', () => {
      expect(getQMPlan().steps[0]!.providerCallExecuted).toBe(false);
    });
  });

  describe('step-1: review', () => {
    it('stepId suffix is "review"', () => {
      expect(getQMPlan().steps[1]!.stepId).toBe('step-1-review');
    });

    it('action is quality-multipass/critique-review', () => {
      expect(getQMPlan().steps[1]!.action).toBe('quality-multipass/critique-review');
    });

    it('role is reviewer', () => {
      expect(getQMPlan().steps[1]!.role).toBe('reviewer');
    });

    it('phase is review', () => {
      expect(getQMPlan().steps[1]!.phase).toBe('review');
    });

    it('providerCallPlanned is true (critique + scoring pass)', () => {
      expect(getQMPlan().steps[1]!.providerCallPlanned).toBe(true);
    });
  });

  describe('step-2: refine', () => {
    it('stepId suffix is "refine"', () => {
      expect(getQMPlan().steps[2]!.stepId).toBe('step-2-refine');
    });

    it('action is quality-multipass/refine', () => {
      expect(getQMPlan().steps[2]!.action).toBe('quality-multipass/refine');
    });

    it('role is refiner', () => {
      expect(getQMPlan().steps[2]!.role).toBe('refiner');
    });

    it('phase is refine', () => {
      expect(getQMPlan().steps[2]!.phase).toBe('refine');
    });

    it('providerCallPlanned is true (improvement pass)', () => {
      expect(getQMPlan().steps[2]!.providerCallPlanned).toBe(true);
    });
  });

  describe('step-3: final', () => {
    it('stepId suffix is "final"', () => {
      expect(getQMPlan().steps[3]!.stepId).toBe('step-3-final');
    });

    it('action is quality-multipass/final-selection', () => {
      expect(getQMPlan().steps[3]!.action).toBe('quality-multipass/final-selection');
    });

    it('role is synthesizer', () => {
      expect(getQMPlan().steps[3]!.role).toBe('synthesizer');
    });

    it('phase is final', () => {
      expect(getQMPlan().steps[3]!.phase).toBe('final');
    });

    it('providerCallPlanned is false (selection decision, no extra call)', () => {
      expect(getQMPlan().steps[3]!.providerCallPlanned).toBe(false);
    });
  });

  describe('strategySemantics', () => {
    it('strategySemantics is present', () => {
      expect(getQMPlan().strategySemantics).toBeDefined();
    });

    it('semanticPlanVersion is 01c1b-sm-r6-v1', () => {
      const s = getQMPlan().strategySemantics!;
      expect(s['semanticPlanVersion']).toBe('01c1b-sm-r6-v1');
    });

    it('strategyId is quality-multipass', () => {
      const s = getQMPlan().strategySemantics!;
      expect(s['strategyId']).toBe('quality-multipass');
    });

    it('phaseCount is 4', () => {
      const s = getQMPlan().strategySemantics!;
      expect(s['phaseCount']).toBe(4);
    });

    it('phases array is [draft, review, refine, final]', () => {
      const s = getQMPlan().strategySemantics!;
      expect(s['phases']).toEqual(['draft', 'review', 'refine', 'final']);
    });

    it('roles array is [drafter, reviewer, refiner, synthesizer]', () => {
      const s = getQMPlan().strategySemantics!;
      expect(s['roles']).toEqual(['drafter', 'reviewer', 'refiner', 'synthesizer']);
    });

    it('iterationPolicy is present', () => {
      const s = getQMPlan().strategySemantics!;
      expect(s['iterationPolicy']).toBeDefined();
    });

    it('iterationPolicy.minPasses is 2', () => {
      const s = getQMPlan().strategySemantics!;
      const policy = s['iterationPolicy'] as Record<string, unknown>;
      expect(policy['minPasses']).toBe(2);
    });

    it('iterationPolicy.maxPasses is 4', () => {
      const s = getQMPlan().strategySemantics!;
      const policy = s['iterationPolicy'] as Record<string, unknown>;
      expect(policy['maxPasses']).toBe(4);
    });

    it('iterationPolicy.qualityGate is review_score_threshold', () => {
      const s = getQMPlan().strategySemantics!;
      const policy = s['iterationPolicy'] as Record<string, unknown>;
      expect(policy['qualityGate']).toBe('review_score_threshold');
    });

    it('cascadePolicy is absent (quality-multipass does not cascade)', () => {
      const s = getQMPlan().strategySemantics!;
      expect(s['cascadePolicy']).toBeUndefined();
    });

    it('repairPolicy is absent (quality-multipass does not critique-repair)', () => {
      const s = getQMPlan().strategySemantics!;
      expect(s['repairPolicy']).toBeUndefined();
    });
  });

  describe('dry-run invariants', () => {
    it('no providerCallExecuted in any step', () => {
      const steps = getQMPlan().steps;
      expect(steps.every(s => s.providerCallExecuted === false)).toBe(true);
    });

    it('all actions carry the quality-multipass/ prefix', () => {
      const actions = getQMPlan().steps.map(s => s.action);
      expect(actions.every(a => a.startsWith('quality-multipass/'))).toBe(true);
    });

    it('totalCost is 0', () => {
      expect(getQMResult().totalCost).toBe(0);
    });

    it('executable is true when registered', () => {
      const meta = getQMResult().metadata as Record<string, unknown>;
      expect(meta['executable']).toBe(true);
    });

    it('planFingerprint starts with pf_', () => {
      const meta = getQMResult().metadata as Record<string, unknown>;
      expect((meta['planFingerprint'] as string).startsWith('pf_')).toBe(true);
    });

    it('plan fingerprint differs from single (distinct semantic content)', () => {
      const qmMeta = getQMResult().metadata as Record<string, unknown>;
      const singleResult = buildPlanOnlyResult(
        'single', 'explicit', 'request-flag', REQ, CTX, null, 0.92, { registered: true },
      );
      const singleMeta = singleResult.metadata as Record<string, unknown>;
      expect(qmMeta['planFingerprint']).not.toBe(singleMeta['planFingerprint']);
    });
  });
});
