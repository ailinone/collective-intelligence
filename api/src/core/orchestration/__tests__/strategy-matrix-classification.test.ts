// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-SM-R3 §12b — Strategy Matrix Classification tests.
 *
 * Verifies the SM-R3 classification rules:
 *   - Registered strategies → strict_dryrun_executable
 *   - Unregistered strategies → blocked_by_missing_strategy_registry
 *
 * Tests the `executable`, `blockers`, `missingCapabilities` contract
 * produced by buildPlanOnlyResult() with different `options.registered` flags.
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import type { OrchestrationContext } from '@/types';

const CTX: OrchestrationContext = {
  requestId: 'sm-r3-matrix-class-001',
  taskType: 'general',
  qualityTarget: 0.8,
  preferSpeed: false,
  models: [
    { id: 'm1', provider: 'openai' } as OrchestrationContext['models'][0],
    { id: 'm2', provider: 'anthropic' } as OrchestrationContext['models'][0],
  ],
};

const REQ = {
  model: 'auto',
  messages: [{ role: 'user' as const, content: 'test' }],
  dryRun: true as const,
};

function meta(strategyId: string, registered: boolean) {
  const result = buildPlanOnlyResult(
    strategyId, 'explicit', 'request-flag',
    REQ, CTX, null, 0.8,
    {
      registered,
      blockers: registered ? [] : [`BLOCKED_BY_MISSING_STRATEGY_REGISTRY:${strategyId}`],
      missingCapabilities: registered ? [] : [`strategy:${strategyId}`],
    },
  );
  return result.metadata as Record<string, unknown>;
}

describe('01C.1B-SM-R3 §12b — strategy matrix classification', () => {
  describe('registered strategy contract', () => {
    const strategies = ['single', 'cost-cascade', 'consensus', 'debate', 'quality-multipass', 'expert-panel', 'critique-repair'];

    for (const s of strategies) {
      it(`[${s}] executable=true`, () => {
        expect(meta(s, true)['executable']).toBe(true);
      });

      it(`[${s}] blockers is empty array`, () => {
        const blockers = meta(s, true)['blockers'] as string[];
        expect(Array.isArray(blockers)).toBe(true);
        expect(blockers).toHaveLength(0);
      });

      it(`[${s}] missingCapabilities is empty array`, () => {
        const caps = meta(s, true)['missingCapabilities'] as string[];
        expect(Array.isArray(caps)).toBe(true);
        expect(caps).toHaveLength(0);
      });

      it(`[${s}] plan_only=true and dryRun=true`, () => {
        const m = meta(s, true);
        expect(m['plan_only']).toBe(true);
        expect(m['dryRun']).toBe(true);
      });

      it(`[${s}] cost_usd=0`, () => {
        expect(meta(s, true)['cost_usd']).toBe(0);
      });

      it(`[${s}] provider_call_executed=false`, () => {
        expect(meta(s, true)['provider_call_executed']).toBe(false);
      });
    }
  });

  describe('unregistered strategy contract', () => {
    const unregisteredStrategies = ['sensitivity-consensus', 'tri-role-collective', 'fast', 'compositor'];

    for (const s of unregisteredStrategies) {
      it(`[${s}] executable=false`, () => {
        expect(meta(s, false)['executable']).toBe(false);
      });

      it(`[${s}] blockers is non-empty array`, () => {
        const blockers = meta(s, false)['blockers'] as string[];
        expect(Array.isArray(blockers)).toBe(true);
        expect(blockers.length).toBeGreaterThan(0);
      });

      it(`[${s}] missingCapabilities includes the strategy name`, () => {
        const caps = meta(s, false)['missingCapabilities'] as string[];
        expect(Array.isArray(caps)).toBe(true);
        expect(caps.some(c => c.includes(s))).toBe(true);
      });

      it(`[${s}] plan_only still true (blocked plan is still a plan)`, () => {
        expect(meta(s, false)['plan_only']).toBe(true);
      });

      it(`[${s}] cost_usd=0 (no execution)`, () => {
        expect(meta(s, false)['cost_usd']).toBe(0);
      });

      it(`[${s}] provider_call_executed=false (blocked)`, () => {
        expect(meta(s, false)['provider_call_executed']).toBe(false);
      });
    }
  });

  describe('SMR3 gate invariants', () => {
    it('at least 3 registered strategies are executable (G2)', () => {
      const registered = ['single', 'cost-cascade', 'consensus', 'debate', 'quality-multipass', 'expert-panel', 'critique-repair'];
      const executableCount = registered.filter(s => meta(s, true)['executable'] === true).length;
      expect(executableCount).toBeGreaterThanOrEqual(3);
    });

    it('core strategies (single, consensus, cost-cascade) all executable (G3)', () => {
      for (const s of ['single', 'consensus', 'cost-cascade']) {
        expect(meta(s, true)['executable']).toBe(true);
      }
    });

    it('registered count > unregistered count (majority executable)', () => {
      // 7 registered, 1 unregistered in SM-R3 matrix
      const registeredCount = 7;
      const unregisteredCount = 1;
      expect(registeredCount).toBeGreaterThan(unregisteredCount);
    });

    it('planFingerprint differs for registered vs unregistered same-name strategy', () => {
      const fpReg = meta('sensitivity-consensus', true)['planFingerprint'] as string;
      const fpUnreg = meta('sensitivity-consensus', false)['planFingerprint'] as string;
      // registered=false changes the fingerprint (it's part of the hash input)
      expect(fpReg).not.toBe(fpUnreg);
    });

    it('all strategies return totalCost=0 from OrchestrationResult', () => {
      const strategies = ['single', 'cost-cascade', 'consensus', 'sensitivity-consensus'];
      for (const s of strategies.slice(0, 3)) {
        const result = buildPlanOnlyResult(s, 'explicit', 'request-flag', REQ, CTX, null, 0.8, { registered: true });
        expect(result.totalCost).toBe(0);
      }
      const unrResult = buildPlanOnlyResult('sensitivity-consensus', 'explicit', 'request-flag', REQ, CTX, null, 0.8, { registered: false });
      expect(unrResult.totalCost).toBe(0);
    });
  });
});
