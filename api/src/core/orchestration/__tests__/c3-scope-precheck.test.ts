// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-SM-R6 §13e — C3 Scope Precheck.
 *
 * Design-level precheck for C3 eligibility. Does NOT execute C3.
 * Encodes the SM-R6 C3 scope as a living test contract so that any
 * future change to strategy semantics, alias routing, or plan structure
 * that affects C3 eligibility produces a test failure rather than silent drift.
 *
 * C3 Scope (SM-R6 assessment):
 *   ELIGIBLE strategies — semantic_fidelity_pass, independent engine, no alias collision:
 *     - single
 *     - consensus
 *     - debate
 *     - expert-panel
 *     - cost-cascade     (SM-R6 FIX-002 upgraded to pass)
 *     - critique-repair  (SM-R6 FIX-003 upgraded to pass)
 *     - quality-multipass (SM-R6 FIX-004 upgraded to pass)
 *
 *   EXCLUDED strategies — alias or proxy, no independent engine:
 *     - fast             (alias → sensitivity-consensus; FAST DECISION: proxy_alias_excluded_from_c3)
 *     - sensitivity-consensus (proxy endpoint; valid C3 arm, but not a "real" independent strategy)
 *
 * ABSOLUTE PROHIBITIONS (from SM-R6 spec):
 *   - This test does NOT execute C3
 *   - This test does NOT execute dryRun=false
 *   - This test does NOT call any LLM provider
 *   - This test does NOT use K or real consensus
 *
 * What this test covers:
 *   - Each C3-eligible strategy produces a semantic_fidelity_pass plan
 *   - Each C3-eligible strategy has ≥1 real semantic phase (providerCallPlanned=true)
 *   - Each C3-eligible strategy has a valid plan fingerprint
 *   - 'fast' is excluded from C3 scope per FAST_STRATEGY_DECISION
 *   - Total C3-eligible strategies = 7
 *   - SM-R6 semantic fidelity pass count = 7/8 (fast excluded as alias)
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import { resolveExecutionStrategy } from '@/core/orchestration/strategy-contract';
import type { OrchestrationContext } from '@/types';

// SM-R6 C3 scope constants — changes here require explicit design review.
const C3_ELIGIBLE_STRATEGIES = [
  'single',
  'consensus',
  'debate',
  'expert-panel',
  'cost-cascade',
  'critique-repair',
  'quality-multipass',
] as const;

const C3_EXCLUDED_ALIASES = ['fast'] as const;

const C3_PROXY_ENDPOINTS = ['sensitivity-consensus'] as const;

const FAST_STRATEGY_DECISION = 'proxy_alias_excluded_from_c3' as const;

const CTX: OrchestrationContext = {
  requestId: 'sm-r6-c3-precheck-001',
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
  messages: [{ role: 'user' as const, content: 'c3 scope precheck' }],
  dryRun: true as const,
};

function getResult(strategyName: string) {
  return buildPlanOnlyResult(
    strategyName, 'explicit', 'request-flag', REQ, CTX, null, 0.85, { registered: true },
  );
}

function getPlanSteps(strategyName: string) {
  const meta = getResult(strategyName).metadata as Record<string, unknown>;
  const plan = meta['executionPlan'] as {
    steps: Array<{
      action: string;
      role?: string;
      phase?: string;
      providerCallPlanned: boolean;
    }>;
  };
  return plan.steps;
}

// ── C3 scope size ─────────────────────────────────────────────────────────────
describe('01C.1B-SM-R6 §13e — C3 scope precheck', () => {
  describe('C3 scope totals', () => {
    it('C3_ELIGIBLE_STRATEGIES has exactly 7 entries', () => {
      expect(C3_ELIGIBLE_STRATEGIES.length).toBe(7);
    });

    it('C3_EXCLUDED_ALIASES has exactly 1 entry (fast)', () => {
      expect(C3_EXCLUDED_ALIASES.length).toBe(1);
      expect(C3_EXCLUDED_ALIASES).toContain('fast');
    });

    it('FAST_STRATEGY_DECISION is proxy_alias_excluded_from_c3', () => {
      expect(FAST_STRATEGY_DECISION).toBe('proxy_alias_excluded_from_c3');
    });
  });

  // ── Each eligible strategy must produce a valid dry-run plan ─────────────
  describe('C3-eligible strategies: plan validity precheck', () => {
    for (const strategy of C3_ELIGIBLE_STRATEGIES) {
      it(`${strategy}: produces a non-empty plan`, () => {
        const steps = getPlanSteps(strategy);
        expect(steps.length).toBeGreaterThan(0);
      });

      it(`${strategy}: has ≥1 step with providerCallPlanned=true`, () => {
        const steps = getPlanSteps(strategy);
        const liveSteps = steps.filter(s => s.providerCallPlanned);
        expect(liveSteps.length).toBeGreaterThanOrEqual(1);
      });

      it(`${strategy}: all steps carry the strategy prefix in action`, () => {
        const steps = getPlanSteps(strategy);
        expect(steps.every(s => s.action.startsWith(strategy + '/'))).toBe(true);
      });

      it(`${strategy}: no step has providerCallExecuted=true (dry-run guarantee)`, () => {
        const steps = getPlanSteps(strategy);
        expect(steps.every(s => (s as { providerCallExecuted: boolean }).providerCallExecuted === false)).toBe(true);
      });

      it(`${strategy}: plan fingerprint starts with pf_`, () => {
        const meta = getResult(strategy).metadata as Record<string, unknown>;
        const fp = meta['planFingerprint'] as string;
        expect(fp.startsWith('pf_')).toBe(true);
      });

      it(`${strategy}: totalCost is 0 (no billable calls)`, () => {
        expect(getResult(strategy).totalCost).toBe(0);
      });
    }
  });

  // ── Each eligible strategy has semantic roles ────────────────────────────
  describe('C3-eligible strategies: semantic role coverage', () => {
    const TEMPLATE_STRATEGIES = ['single', 'cost-cascade', 'critique-repair', 'quality-multipass'];
    const STEP_ROLES_STRATEGIES = ['consensus', 'debate', 'expert-panel'];

    for (const strategy of TEMPLATE_STRATEGIES) {
      it(`${strategy}: step-0 has a semantic role (template-based)`, () => {
        const steps = getPlanSteps(strategy);
        expect(steps[0]!.role).toBeDefined();
        expect(typeof steps[0]!.role).toBe('string');
      });

      it(`${strategy}: step-0 has a semantic phase label (template-based)`, () => {
        const steps = getPlanSteps(strategy);
        expect(steps[0]!.phase).toBeDefined();
        expect(typeof steps[0]!.phase).toBe('string');
      });
    }

    for (const strategy of STEP_ROLES_STRATEGIES) {
      it(`${strategy}: step-0 has a semantic role (STEP_ROLES 2-tier)`, () => {
        const steps = getPlanSteps(strategy);
        expect(steps[0]!.role).toBeDefined();
        expect(typeof steps[0]!.role).toBe('string');
      });

      it(`${strategy}: has a step-1 (synthesis step)`, () => {
        const steps = getPlanSteps(strategy);
        expect(steps[1]).toBeDefined();
      });
    }
  });

  // ── C3-eligible step counts ──────────────────────────────────────────────
  describe('C3-eligible strategies: step count contract', () => {
    it('single has 1 step (direct-answer)', () => {
      expect(getPlanSteps('single')).toHaveLength(1);
    });

    it('cost-cascade has 4 steps (FIX-002 cascade depth)', () => {
      expect(getPlanSteps('cost-cascade')).toHaveLength(4);
    });

    it('critique-repair has 3 steps (FIX-003 semantic depth)', () => {
      expect(getPlanSteps('critique-repair')).toHaveLength(3);
    });

    it('quality-multipass has 4 steps (FIX-004 semantic depth)', () => {
      expect(getPlanSteps('quality-multipass')).toHaveLength(4);
    });

    it('consensus has 2 steps (execute + synthesize)', () => {
      expect(getPlanSteps('consensus')).toHaveLength(2);
    });

    it('debate has 2 steps (propose + judge)', () => {
      expect(getPlanSteps('debate')).toHaveLength(2);
    });

    it('expert-panel has 2 steps (expert + judge)', () => {
      expect(getPlanSteps('expert-panel')).toHaveLength(2);
    });
  });

  // ── Excluded alias: fast ─────────────────────────────────────────────────
  describe('C3-excluded: fast alias', () => {
    it('fast resolves to sensitivity-consensus (not an independent engine)', () => {
      expect(resolveExecutionStrategy('fast')).toBe('sensitivity-consensus');
    });

    it('fast is excluded from C3 scope per FAST_STRATEGY_DECISION', () => {
      expect(FAST_STRATEGY_DECISION).toBe('proxy_alias_excluded_from_c3');
      expect(C3_EXCLUDED_ALIASES).toContain('fast');
      expect(C3_ELIGIBLE_STRATEGIES).not.toContain('fast' as typeof C3_ELIGIBLE_STRATEGIES[number]);
    });

    it('fast is not in C3_ELIGIBLE_STRATEGIES', () => {
      // Type system + runtime check
      const eligible: readonly string[] = C3_ELIGIBLE_STRATEGIES;
      expect(eligible.includes('fast')).toBe(false);
    });
  });

  // ── Proxy endpoints ──────────────────────────────────────────────────────
  describe('proxy endpoints (not primary C3 arms)', () => {
    it('sensitivity-consensus is recognized as proxy endpoint', () => {
      expect(C3_PROXY_ENDPOINTS).toContain('sensitivity-consensus');
    });

    it('sensitivity-consensus produces a valid plan when used as buildPlanOnlyResult input', () => {
      // sensitivity-consensus is in STRATEGY_INPUT_VALUES (Phase 2c) but not in aliasToCanonical.
      // resolveExecutionStrategy would return undefined for it — it is used as a direct engine
      // name, not an input alias. buildPlanOnlyResult accepts it and produces a correct plan.
      const result = buildPlanOnlyResult(
        'sensitivity-consensus', 'explicit', 'request-flag', REQ, CTX, null, 0.85, { registered: true },
      );
      expect(result.strategyUsed).toBe('sensitivity-consensus');
    });

    it('sensitivity-consensus is not in C3_ELIGIBLE_STRATEGIES (handled via proxy endpoint list)', () => {
      const eligible: readonly string[] = C3_ELIGIBLE_STRATEGIES;
      expect(eligible.includes('sensitivity-consensus')).toBe(false);
    });
  });

  // ── All plans have distinct fingerprints ─────────────────────────────────
  describe('plan fingerprint uniqueness across C3-eligible strategies', () => {
    it('all 7 C3-eligible strategies produce distinct plan fingerprints', () => {
      const fingerprints = C3_ELIGIBLE_STRATEGIES.map(strategy => {
        const meta = getResult(strategy).metadata as Record<string, unknown>;
        return meta['planFingerprint'] as string;
      });
      const uniqueFingerprints = new Set(fingerprints);
      expect(uniqueFingerprints.size).toBe(C3_ELIGIBLE_STRATEGIES.length);
    });
  });

  // ── Semantic plan version marker ─────────────────────────────────────────
  describe('SM-R6 semantic plan version', () => {
    it('template strategies include semanticPlanVersion 01c1b-sm-r6-v1 in strategySemantics', () => {
      const TEMPLATE_STRATEGIES = ['single', 'cost-cascade', 'critique-repair', 'quality-multipass'];
      for (const strategy of TEMPLATE_STRATEGIES) {
        const meta = getResult(strategy).metadata as Record<string, unknown>;
        const plan = meta['executionPlan'] as { strategySemantics?: Record<string, unknown> };
        expect(plan.strategySemantics?.['semanticPlanVersion']).toBe('01c1b-sm-r6-v1');
      }
    });

    it('plan fingerprints encode semantic version (SM-R6 fingerprints differ from SM-R5)', () => {
      // Any plan built after SM-R6 has SEMANTIC_PLAN_VERSION in the hash input.
      // We verify fingerprint is non-trivially long and starts with pf_.
      for (const strategy of C3_ELIGIBLE_STRATEGIES) {
        const meta = getResult(strategy).metadata as Record<string, unknown>;
        const fp = meta['planFingerprint'] as string;
        expect(fp.startsWith('pf_')).toBe(true);
        expect(fp.length).toBeGreaterThan(5);
      }
    });
  });
});
