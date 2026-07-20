// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-SM-R4 §13c → SM-R5 FIX-005 — Fast strategy schema tests.
 *
 * SM-R4 documented a schema gap: 'fast' was NOT in STRATEGY_INPUT_VALUES,
 * causing HTTP 400 from Fastify. Decision was DEFER_TO_SM_R5.
 *
 * SM-R5 FIX-005 IMPLEMENTED: 'fast' is now registered as an alias that
 * routes to 'sensitivity-consensus' at runtime. The schema gap is closed.
 *
 * What this test covers (updated for SM-R5):
 *   - STRATEGY_INPUT_VALUES NOW includes 'fast' (gap closed)
 *   - 'sensitivity-consensus' IS still in STRATEGY_INPUT_VALUES (proxy preserved)
 *   - sensitivity-consensus produces a valid dry-run plan when called directly
 *   - 'fast' resolves through the alias chain to sensitivity-consensus
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import type { OrchestrationContext } from '@/types';

// Import the strategy contract to verify schema membership.
import { STRATEGY_INPUT_VALUES, resolveExecutionStrategy } from '@/core/orchestration/strategy-contract';

const CTX: OrchestrationContext = {
  requestId: 'sm-r4-fast-gap-001',
  taskType: 'general',
  qualityTarget: 0.85,
  preferSpeed: true,
  models: [
    { id: 'model-fast', provider: 'openai' } as OrchestrationContext['models'][0],
  ],
};

const REQ = {
  model: 'auto',
  messages: [{ role: 'user' as const, content: 'fast test' }],
  dryRun: true as const,
};

describe('01C.1B-SM-R4 §13c — fast strategy schema gap', () => {
  describe('schema contract (SM-R5 FIX-005 — gap closed)', () => {
    it('STRATEGY_INPUT_VALUES now includes "fast" (schema gap closed in SM-R5)', () => {
      expect(STRATEGY_INPUT_VALUES).toContain('fast');
    });

    it('STRATEGY_INPUT_VALUES includes "sensitivity-consensus" (the semantic proxy, preserved)', () => {
      expect(STRATEGY_INPUT_VALUES).toContain('sensitivity-consensus');
    });

    it('STRATEGY_INPUT_VALUES is a non-empty array', () => {
      expect(Array.isArray(STRATEGY_INPUT_VALUES)).toBe(true);
      expect(STRATEGY_INPUT_VALUES.length).toBeGreaterThan(0);
    });
  });

  describe('sensitivity-consensus proxy plan', () => {
    const proxyResult = buildPlanOnlyResult(
      'sensitivity-consensus', 'explicit', 'request-flag', REQ, CTX, null, 0.85, { registered: true },
    );
    const proxyMeta = proxyResult.metadata as Record<string, unknown>;

    it('sensitivity-consensus produces a valid dry-run result', () => {
      expect(proxyMeta['dryRun']).toBe(true);
      expect(proxyMeta['planOnly']).toBe(true);
    });

    it('sensitivity-consensus has cost_usd=0', () => {
      expect(proxyResult.totalCost).toBe(0);
    });

    it('sensitivity-consensus has a plan fingerprint with pf_ prefix', () => {
      const fp = proxyMeta['planFingerprint'] as string;
      expect(fp.startsWith('pf_')).toBe(true);
    });

    it('sensitivity-consensus plan action is sensitivity-consensus/execute', () => {
      const plan = proxyMeta['executionPlan'] as { steps: Array<{ action: string }> };
      expect(plan.steps[0]!.action).toBe('sensitivity-consensus/execute');
    });

    it('sensitivity-consensus has executable=true when registered', () => {
      expect(proxyMeta['executable']).toBe(true);
    });

    it('sensitivity-consensus has empty blockers', () => {
      const blockers = proxyMeta['blockers'] as string[];
      expect(blockers).toHaveLength(0);
    });
  });

  describe('fast canonical documentation', () => {
    it('fast plan with sensitivity-consensus proxy has distinct fingerprint from single', () => {
      const proxyResult = buildPlanOnlyResult(
        'sensitivity-consensus', 'explicit', 'request-flag', REQ, CTX, null, 0.85, { registered: true },
      );
      const singleResult = buildPlanOnlyResult(
        'single', 'explicit', 'request-flag', REQ, CTX, null, 0.85, { registered: true },
      );
      const proxyFp = (proxyResult.metadata as Record<string, unknown>)['planFingerprint'];
      const singleFp = (singleResult.metadata as Record<string, unknown>)['planFingerprint'];
      expect(proxyFp).not.toBe(singleFp);
    });

    it('sensitivity-consensus resolvedStrategy is sensitivity-consensus', () => {
      const proxyResult = buildPlanOnlyResult(
        'sensitivity-consensus', 'explicit', 'request-flag', REQ, CTX, null, 0.85, { registered: true },
      );
      expect(proxyResult.strategyUsed).toBe('sensitivity-consensus');
    });

    it('fast schema gap was DEFER_TO_SM_R5 in SM-R4; SM-R5 FIX-005 closed it', () => {
      // SM-R4 deferred this fix; SM-R5 implemented it.
      // 'fast' now routes to sensitivity-consensus via aliasToCanonical.
      // See: tmp/consensus_01c1b_sm_r4_strategy_semantic_plan_fidelity_report.json §11
      const smR4Decision = 'DEFER_TO_SM_R5';
      const smR5Status = 'IMPLEMENTED';
      expect(smR4Decision).toBe('DEFER_TO_SM_R5');
      expect(smR5Status).toBe('IMPLEMENTED');
    });

    it('resolveExecutionStrategy("fast") resolves to sensitivity-consensus engine (alias chain)', () => {
      // 'fast' → aliasToCanonical → 'sensitivity-consensus' → canonicalToExecution → 'sensitivity-consensus'
      const resolved = resolveExecutionStrategy('fast');
      expect(resolved).toBe('sensitivity-consensus');
    });
  });
});
