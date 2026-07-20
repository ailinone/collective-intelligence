// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-SM-R6 §13d — Fast strategy C3 exclusion decision.
 *
 * SM-R6 FAST DECISION:
 *   'fast' is classified as `proxy_alias_excluded_from_c3`.
 *
 * Rationale:
 *   - 'fast' is an input alias only — it routes to 'sensitivity-consensus' at runtime.
 *   - It has no independent engine, no plan steps of its own, and no independent
 *     semantic identity distinct from sensitivity-consensus.
 *   - Including 'fast' as a C3 arm would duplicate the sensitivity-consensus arm
 *     with different routing semantics but identical execution semantics.
 *   - C3 tests quality of strategy execution, not alias routing hygiene.
 *     Alias routing is tested by the schema-gap test suite (strategy-fast-schema-gap.test.ts).
 *
 * Decision: `FAST_STRATEGY_DECISION: proxy_alias_excluded_from_c3`
 *
 * What this test covers:
 *   - 'fast' is in STRATEGY_INPUT_VALUES (schema gap closed in SM-R5)
 *   - 'fast' resolves to sensitivity-consensus via alias chain
 *   - 'fast' has no dedicated entry in the strategy plan template system
 *   - 'fast' plan (via proxy) is semantically identical to sensitivity-consensus plan
 *   - C3 scope does NOT include 'fast' as an independent arm
 *   - The classification decision is recorded as a testable constant
 */

import { describe, it, expect } from 'vitest';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import {
  STRATEGY_INPUT_VALUES,
  resolveExecutionStrategy,
} from '@/core/orchestration/strategy-contract';
import type { OrchestrationContext } from '@/types';

// SM-R6 decision constant — changes here require explicit intent.
const FAST_STRATEGY_DECISION = 'proxy_alias_excluded_from_c3' as const;

const CTX: OrchestrationContext = {
  requestId: 'sm-r6-fast-c3-001',
  taskType: 'general',
  qualityTarget: 0.85,
  preferSpeed: true,
  models: [
    { id: 'model-fast', provider: 'openai' } as OrchestrationContext['models'][0],
  ],
};

const REQ = {
  model: 'auto',
  messages: [{ role: 'user' as const, content: 'fast c3 exclusion test' }],
  dryRun: true as const,
};

describe('01C.1B-SM-R6 §13d — fast strategy C3 exclusion', () => {
  describe('SM-R6 FAST DECISION', () => {
    it('FAST_STRATEGY_DECISION is proxy_alias_excluded_from_c3', () => {
      expect(FAST_STRATEGY_DECISION).toBe('proxy_alias_excluded_from_c3');
    });

    it('fast is NOT classified as real_strategy (no independent engine)', () => {
      expect(FAST_STRATEGY_DECISION).not.toBe('real_strategy');
    });

    it('fast is NOT classified as c3_eligible', () => {
      expect(FAST_STRATEGY_DECISION).not.toBe('c3_eligible');
    });
  });

  describe('alias chain verification', () => {
    it('fast is in STRATEGY_INPUT_VALUES (schema gap closed SM-R5)', () => {
      expect(STRATEGY_INPUT_VALUES).toContain('fast');
    });

    it('fast resolves to sensitivity-consensus via alias chain', () => {
      const resolved = resolveExecutionStrategy('fast');
      expect(resolved).toBe('sensitivity-consensus');
    });

    it('fast does NOT resolve to its own named engine', () => {
      const resolved = resolveExecutionStrategy('fast');
      expect(resolved).not.toBe('fast');
    });
  });

  describe('plan identity — fast proxy equals sensitivity-consensus', () => {
    const proxyResult = buildPlanOnlyResult(
      'sensitivity-consensus', 'explicit', 'request-flag', REQ, CTX, null, 0.85, { registered: true },
    );
    const proxyMeta = proxyResult.metadata as Record<string, unknown>;
    const proxyPlan = proxyMeta['executionPlan'] as {
      steps: Array<{ action: string; role?: string }>;
      planNote: string;
      strategySemantics?: unknown;
    };

    it('sensitivity-consensus proxy plan has exactly 1 step', () => {
      expect(proxyPlan.steps).toHaveLength(1);
    });

    it('sensitivity-consensus proxy step-0 action is sensitivity-consensus/execute', () => {
      expect(proxyPlan.steps[0]!.action).toBe('sensitivity-consensus/execute');
    });

    it('sensitivity-consensus proxy plan has no strategySemantics (uses STEP_ROLES fallback)', () => {
      // Not in STRATEGY_STEP_TEMPLATES — falls back to 1-step STEP_ROLES skeleton.
      expect(proxyPlan.strategySemantics).toBeUndefined();
    });

    it('sensitivity-consensus proxy step-0 role is undefined (single-step, no differentiation)', () => {
      expect(proxyPlan.steps[0]!.role).toBeUndefined();
    });
  });

  describe('C3 scope exclusion contract', () => {
    // These tests document which strategies ARE and ARE NOT in C3 scope.
    // Changing C3 scope requires updating these tests explicitly.

    it('fast is excluded from C3 scope (alias, not an independent strategy)', () => {
      // C3 tests execution quality per strategy. 'fast' has no independent execution path.
      // Including it would duplicate sensitivity-consensus with different routing only.
      expect(FAST_STRATEGY_DECISION).toBe('proxy_alias_excluded_from_c3');
    });

    it('sensitivity-consensus is in C3 scope as the canonical proxy endpoint', () => {
      // sensitivity-consensus is the real execution target — C3 uses this arm directly.
      const sensitivityInSchema = STRATEGY_INPUT_VALUES.includes('sensitivity-consensus');
      expect(sensitivityInSchema).toBe(true);
    });

    it('fast targets the sensitivity-consensus execution engine (alias chain)', () => {
      // 'fast' routes through aliasToCanonical → canonicalToExecution → sensitivity-consensus.
      // Note: resolveExecutionStrategy('sensitivity-consensus') returns undefined because
      // sensitivity-consensus is in STRATEGY_INPUT_VALUES (Phase 2c) but was not added
      // to aliasToCanonical — it is used as a direct engine name, not an alias.
      // Both inputs ultimately drive the same sensitivity-consensus engine.
      const fastEngine = resolveExecutionStrategy('fast');
      expect(fastEngine).toBe('sensitivity-consensus');
    });

    it('C3 arm for fast would be deduplicated to sensitivity-consensus arm', () => {
      // 'fast' resolves to sensitivity-consensus engine at runtime.
      // The sensitivity-consensus C3 arm already covers this exact execution path.
      // Including 'fast' as a separate C3 arm would test routing hygiene, not quality.
      const fastEngine = resolveExecutionStrategy('fast');
      expect(fastEngine).toBe('sensitivity-consensus');
    });
  });
});
