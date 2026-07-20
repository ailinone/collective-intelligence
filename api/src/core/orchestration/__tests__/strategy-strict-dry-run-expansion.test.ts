// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-SM-R3 §12a — Strategy Strict Dry-Run Expansion tests.
 *
 * Verifies that buildPlanOnlyResult() satisfies the SM-R3 gate matrix
 * for every strategy candidate: 7 executable + 1 blocked (fast).
 *
 * These are pure unit tests — no container, no HTTP, no provider calls.
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import type { OrchestrationContext } from '@/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const MIN_CONTEXT: OrchestrationContext = {
  requestId: 'sm-r3-test-001',
  taskType: 'general',
  qualityTarget: 0.85,
  preferSpeed: false,
  models: [
    { id: 'model-a', provider: 'openai' } as OrchestrationContext['models'][0],
    { id: 'model-b', provider: 'anthropic' } as OrchestrationContext['models'][0],
    { id: 'model-c', provider: 'mistral' } as OrchestrationContext['models'][0],
  ],
};

const MIN_REQUEST = {
  model: 'auto',
  messages: [{ role: 'user' as const, content: 'test' }],
  dryRun: true as const,
};

const DETECTION_PATH = 'request-flag' as const;

// SM-R3 strategy matrix — (strategyId | null) for each canonical name
const STRATEGY_MATRIX: Array<{ canonical: string; strategyId: string | null; registered: boolean }> = [
  { canonical: 'single',          strategyId: 'single',           registered: true  },
  { canonical: 'fast',            strategyId: null,               registered: false },
  { canonical: 'cost-cascade',    strategyId: 'cost-cascade',     registered: true  },
  { canonical: 'quality-multipass', strategyId: 'quality-multipass', registered: true },
  { canonical: 'critique-repair', strategyId: 'critique-repair',  registered: true  },
  { canonical: 'debate',          strategyId: 'debate',           registered: true  },
  { canonical: 'expert-panel',    strategyId: 'expert-panel',     registered: true  },
  { canonical: 'consensus',       strategyId: 'consensus',        registered: true  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildResult(strategyId: string, registered: boolean) {
  return buildPlanOnlyResult(
    strategyId,
    registered ? 'explicit' : 'explicit',
    DETECTION_PATH,
    MIN_REQUEST,
    MIN_CONTEXT,
    null,
    MIN_CONTEXT.qualityTarget ?? 0.85,
    {
      registered,
      blockers: registered ? [] : [`BLOCKED_BY_MISSING_STRATEGY_REGISTRY:${strategyId}`],
      missingCapabilities: registered ? [] : [`strategy:${strategyId}`],
    },
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('01C.1B-SM-R3 §12a — strategy strict dry-run expansion', () => {
  describe('core invariants: all 8 strategies', () => {
    for (const { canonical, strategyId, registered } of STRATEGY_MATRIX) {
      const name = strategyId ?? canonical;
      it(`[${canonical}] returns HTTP-safe result with totalCost=0`, () => {
        const result = buildResult(name, registered);
        expect(result.totalCost).toBe(0);
        expect(result.modelsUsed).toHaveLength(0);
        expect(result.finalResponse).toBeDefined();
      });

      it(`[${canonical}] metadata.dryRun=true and metadata.planOnly=true`, () => {
        const result = buildResult(name, registered);
        const meta = result.metadata as Record<string, unknown>;
        expect(meta['dryRun']).toBe(true);
        expect(meta['planOnly']).toBe(true);
      });

      it(`[${canonical}] metadata.cost_usd=0`, () => {
        const result = buildResult(name, registered);
        const meta = result.metadata as Record<string, unknown>;
        expect(meta['cost_usd']).toBe(0);
      });

      it(`[${canonical}] provider_call_executed=false`, () => {
        const result = buildResult(name, registered);
        const meta = result.metadata as Record<string, unknown>;
        expect(meta['provider_call_executed']).toBe(false);
      });
    }
  });

  describe('executable strategies: registered strategies are executable', () => {
    const executables = STRATEGY_MATRIX.filter(s => s.registered);
    it(`has ${executables.length} executable strategies (≥3 required)`, () => {
      expect(executables.length).toBeGreaterThanOrEqual(3);
    });

    for (const { canonical, strategyId } of executables) {
      it(`[${canonical}] executable=true, no blockers`, () => {
        const result = buildResult(strategyId!, true);
        const meta = result.metadata as Record<string, unknown>;
        expect(meta['executable']).toBe(true);
        const blockers = meta['blockers'] as string[];
        expect(blockers).toHaveLength(0);
      });
    }
  });

  describe('blocked strategy: fast is unregistered', () => {
    it('[fast] executable=false', () => {
      const result = buildResult('fast', false);
      const meta = result.metadata as Record<string, unknown>;
      expect(meta['executable']).toBe(false);
    });

    it('[fast] blockers is non-empty array', () => {
      const result = buildResult('fast', false);
      const meta = result.metadata as Record<string, unknown>;
      const blockers = meta['blockers'] as string[];
      expect(Array.isArray(blockers)).toBe(true);
      expect(blockers.length).toBeGreaterThan(0);
    });

    it('[fast] missingCapabilities includes strategy:fast', () => {
      const result = buildResult('fast', false);
      const meta = result.metadata as Record<string, unknown>;
      const caps = meta['missingCapabilities'] as string[];
      expect(Array.isArray(caps)).toBe(true);
      expect(caps.some(c => c.includes('fast'))).toBe(true);
    });

    it('[fast] still returns HTTP-safe result (plan_only=true)', () => {
      const result = buildResult('fast', false);
      const meta = result.metadata as Record<string, unknown>;
      expect(meta['plan_only']).toBe(true);
    });
  });

  describe('core strategy set: single, consensus, cost-cascade all executable', () => {
    it('single is executable', () => {
      const result = buildResult('single', true);
      const meta = result.metadata as Record<string, unknown>;
      expect(meta['executable']).toBe(true);
    });

    it('consensus is executable', () => {
      const result = buildResult('consensus', true);
      const meta = result.metadata as Record<string, unknown>;
      expect(meta['executable']).toBe(true);
    });

    it('cost-cascade is executable', () => {
      const result = buildResult('cost-cascade', true);
      const meta = result.metadata as Record<string, unknown>;
      expect(meta['executable']).toBe(true);
    });
  });

  describe('plan fingerprint', () => {
    it('generates pf_* prefix fingerprint for each strategy', () => {
      for (const { canonical, strategyId, registered } of STRATEGY_MATRIX) {
        const name = strategyId ?? canonical;
        const result = buildResult(name, registered);
        const meta = result.metadata as Record<string, unknown>;
        const fp = meta['planFingerprint'] as string;
        expect(typeof fp).toBe('string');
        expect(fp).toMatch(/^pf_[0-9a-f]+$/);
      }
    });

    it('different strategies produce different fingerprints', () => {
      const fingerprints = STRATEGY_MATRIX
        .filter(s => s.registered)
        .map(s => {
          const result = buildResult(s.strategyId!, true);
          const meta = result.metadata as Record<string, unknown>;
          return meta['planFingerprint'] as string;
        });
      const unique = new Set(fingerprints);
      // All registered strategies should have unique fingerprints
      expect(unique.size).toBe(fingerprints.length);
    });

    it('same strategy + same params produces same fingerprint (deterministic)', () => {
      const r1 = buildResult('single', true);
      const r2 = buildResult('single', true);
      const m1 = r1.metadata as Record<string, unknown>;
      const m2 = r2.metadata as Record<string, unknown>;
      expect(m1['planFingerprint']).toBe(m2['planFingerprint']);
    });
  });

  describe('executionPlan', () => {
    it('registered strategy has executable steps', () => {
      const result = buildResult('consensus', true);
      const meta = result.metadata as Record<string, unknown>;
      const plan = meta['executionPlan'] as { steps: unknown[]; planNote: string };
      expect(plan).toBeDefined();
      expect(Array.isArray(plan.steps)).toBe(true);
      expect(plan.steps.length).toBeGreaterThan(0);
    });

    it('blocked strategy returns blocked step', () => {
      const result = buildResult('fast', false);
      const meta = result.metadata as Record<string, unknown>;
      const plan = meta['executionPlan'] as { steps: Array<{ action: string }> };
      expect(plan.steps[0]?.action).toBe('blocked');
    });

    it('multi-step strategies (consensus, debate) have ≥2 steps', () => {
      for (const strategy of ['consensus', 'debate', 'quality-multipass']) {
        const result = buildResult(strategy, true);
        const meta = result.metadata as Record<string, unknown>;
        const plan = meta['executionPlan'] as { steps: unknown[] };
        expect(plan.steps.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('all plan steps have providerCallExecuted=false', () => {
      for (const { canonical, strategyId, registered } of STRATEGY_MATRIX) {
        const name = strategyId ?? canonical;
        const result = buildResult(name, registered);
        const meta = result.metadata as Record<string, unknown>;
        const plan = meta['executionPlan'] as { steps: Array<{ providerCallExecuted: boolean }> };
        for (const step of plan.steps) {
          expect(step.providerCallExecuted).toBe(false);
        }
      }
    });
  });
});
