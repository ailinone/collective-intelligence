// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-SM-R5 §13 — Strategy Plan Role Enrichment tests (FIX-001).
 *
 * SM-R4 classified all multi-agent strategies as `semantic_fidelity_partial`
 * because ExecutionPlanStep.role was never populated. SM-R5 FIX-001 adds
 * per-step role assignments so plan consumers can distinguish voter, synthesizer,
 * judge, proposer, etc.
 *
 * What this test covers:
 *   - Multi-agent strategies (consensus, debate, expert-panel, critique-repair,
 *     quality-multipass) have non-empty role on both steps.
 *   - Single-step strategies (single, cost-cascade, sensitivity-consensus) have
 *     role=undefined (correct — no inter-step role differentiation).
 *   - Role values are semantically appropriate for each strategy.
 *   - Role fields survive blocked-plan path (blocked → role undefined).
 *   - Roles are distinct between step-0 and step-1 for all multi-agent strategies.
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import type { OrchestrationContext } from '@/types';

const CTX: OrchestrationContext = {
  requestId: 'sm-r5-role-001',
  taskType: 'general',
  qualityTarget: 0.85,
  preferSpeed: false,
  models: [
    { id: 'model-a', provider: 'openai' } as OrchestrationContext['models'][0],
    { id: 'model-b', provider: 'anthropic' } as OrchestrationContext['models'][0],
    { id: 'model-c', provider: 'gemini' } as OrchestrationContext['models'][0],
  ],
};

const REQ = {
  model: 'auto',
  messages: [{ role: 'user' as const, content: 'role enrichment test' }],
  dryRun: true as const,
};

function getSteps(strategyName: string, registered = true) {
  const result = buildPlanOnlyResult(
    strategyName, 'explicit', 'request-flag', REQ, CTX, null, 0.85, { registered },
  );
  const meta = result.metadata as Record<string, unknown>;
  const plan = meta['executionPlan'] as { steps: Array<{ action: string; role?: string; stepId: string }> };
  return plan.steps;
}

// ── Multi-agent strategies: roles MUST be present ──────────────────────────

describe('01C.1B-SM-R5 §13 — FIX-001: ExecutionPlanStep.role population', () => {
  describe('consensus strategy roles', () => {
    const steps = getSteps('consensus');

    it('consensus step-0 has role "voter"', () => {
      expect(steps[0]!.role).toBe('voter');
    });

    it('consensus step-1 has role "synthesizer"', () => {
      expect(steps[1]!.role).toBe('synthesizer');
    });

    it('consensus roles are distinct between steps', () => {
      expect(steps[0]!.role).not.toBe(steps[1]!.role);
    });
  });

  describe('debate strategy roles', () => {
    const steps = getSteps('debate');

    it('debate step-0 has role "proposer"', () => {
      expect(steps[0]!.role).toBe('proposer');
    });

    it('debate step-1 has role "judge"', () => {
      expect(steps[1]!.role).toBe('judge');
    });

    it('debate roles are distinct between steps', () => {
      expect(steps[0]!.role).not.toBe(steps[1]!.role);
    });
  });

  describe('expert-panel strategy roles', () => {
    const steps = getSteps('expert-panel');

    it('expert-panel step-0 has role "expert"', () => {
      expect(steps[0]!.role).toBe('expert');
    });

    it('expert-panel step-1 has role "judge"', () => {
      expect(steps[1]!.role).toBe('judge');
    });

    it('expert-panel roles are distinct between steps', () => {
      expect(steps[0]!.role).not.toBe(steps[1]!.role);
    });
  });

  describe('critique-repair strategy roles', () => {
    const steps = getSteps('critique-repair');

    it('critique-repair step-0 has role "critic"', () => {
      expect(steps[0]!.role).toBe('critic');
    });

    it('critique-repair step-1 has role "repairer"', () => {
      expect(steps[1]!.role).toBe('repairer');
    });

    it('critique-repair roles are distinct between steps', () => {
      expect(steps[0]!.role).not.toBe(steps[1]!.role);
    });
  });

  describe('quality-multipass strategy roles', () => {
    const steps = getSteps('quality-multipass');

    it('quality-multipass step-0 has role "drafter" (SM-R6 FIX-004: template replaces STEP_ROLES executor)', () => {
      expect(steps[0]!.role).toBe('drafter');
    });

    it('quality-multipass step-1 has role "reviewer"', () => {
      expect(steps[1]!.role).toBe('reviewer');
    });

    it('quality-multipass roles are distinct between steps', () => {
      expect(steps[0]!.role).not.toBe(steps[1]!.role);
    });
  });

  // ── Strategy roles after SM-R6 template upgrade ───────────────────────────

  describe('SM-R6 template strategies — role present (single/cost-cascade now templated)', () => {
    it('single strategy step-0 has role "responder" (SM-R6: template adds direct-answer role)', () => {
      const steps = getSteps('single');
      expect(steps[0]!.role).toBe('responder');
    });

    it('cost-cascade strategy step-0 has role "cheap_candidate" (SM-R6 FIX-002: cascade template)', () => {
      const steps = getSteps('cost-cascade');
      expect(steps[0]!.role).toBe('cheap_candidate');
    });

    it('sensitivity-consensus strategy step-0 has role undefined (proxy, 1 step — no template)', () => {
      const steps = getSteps('sensitivity-consensus');
      expect(steps[0]!.role).toBeUndefined();
    });
  });

  // ── Blocked plan path ────────────────────────────────────────────────────

  describe('blocked plan path — role absent', () => {
    it('blocked plan step has role undefined (blocked before role assignment)', () => {
      const steps = getSteps('consensus', false); // registered=false → blocked
      expect(steps[0]!.role).toBeUndefined();
    });

    it('blocked plan has stepId "step-0-blocked" not "step-0-plan"', () => {
      const steps = getSteps('consensus', false);
      expect(steps[0]!.stepId).toBe('step-0-blocked');
    });
  });

  // ── All multi-agent strategies: roles non-empty ──────────────────────────

  describe('all multi-agent strategies have non-empty roles on both steps', () => {
    const MULTI_AGENT = ['consensus', 'debate', 'expert-panel', 'critique-repair', 'quality-multipass'];

    for (const strategy of MULTI_AGENT) {
      it(`${strategy}: step-0 role is a non-empty string`, () => {
        const steps = getSteps(strategy);
        expect(typeof steps[0]!.role).toBe('string');
        expect(steps[0]!.role!.length).toBeGreaterThan(0);
      });

      it(`${strategy}: step-1 role is a non-empty string`, () => {
        const steps = getSteps(strategy);
        expect(steps[1]).toBeDefined();
        expect(typeof steps[1]!.role).toBe('string');
        expect(steps[1]!.role!.length).toBeGreaterThan(0);
      });
    }
  });
});
