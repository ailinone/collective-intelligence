// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * createModelExecution -> cost integrity guard wiring
 *
 * PRODUCTION INCIDENT (2026-02-20) — eval-baseline-metrics.json reported
 * `avgCostPerRequest: -2786 USD` for the debate strategy. The immediate
 * upstream cause was never pinned to a single adapter (every reviewed
 * adapter floors with Math.max(0, ...)), but `BaseStrategy.createModelExecution`
 * itself only had `cost: Math.max(0, cost) || 0` — an ad-hoc floor that:
 *
 *   - silently zeroed negative/NaN costs with NO logging and NO telemetry,
 *     hiding exactly the class of bug that produced the incident, and
 *   - let a positive-Infinity cost through UNGUARDED, because
 *     `Math.max(0, Infinity) || 0` evaluates to `Infinity` (Infinity is
 *     truthy, so `||` never falls back to 0).
 *
 * `cost-integrity-guard.ts` (guardCost/CostIntegrityError) already existed
 * with a full unit-tested contract but had zero real callers anywhere in the
 * codebase. This suite pins createModelExecution's wiring to that guard:
 * negative/NaN/Infinite costs must never reach `ModelExecution.cost`, and the
 * guard's own policy (env-dependent: strict-throw outside production,
 * warn-and-null in production) must fire instead of a silent zero.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const recorded: Array<{ modelId: string; costUsd?: number }> = [];

vi.mock('@/core/feedback/execution-feedback-collector', () => ({
  getExecutionFeedbackCollector: () => ({
    record: (f: { modelId: string; costUsd?: number }) => {
      recorded.push(f);
    },
  }),
}));

import { BaseStrategy } from '@/core/orchestration/base-strategy';
import { CostIntegrityError } from '@/core/cost/cost-integrity-guard';
import type {
  ChatRequest,
  ChatResponse,
  Model,
  OrchestrationContext,
  OrchestrationResult,
  ProviderAdapter,
  StrategyMetadata,
} from '@/types';

class ProbeStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return { name: 'debate' } as unknown as StrategyMetadata;
  }
  async execute(_r: ChatRequest, _c: OrchestrationContext): Promise<OrchestrationResult> {
    throw new Error('not used');
  }
  public make(cost: number) {
    const response = {
      id: 'r',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'm',
      choices: [
        { index: 0, message: { role: 'assistant', content: '391' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as ChatResponse;
    return this.createModelExecution(
      { id: 'm', name: 'm', provider: 'p' } as Model,
      { getName: () => 'p' } as ProviderAdapter,
      'primary',
      { model: 'auto', messages: [] } as ChatRequest,
      response,
      cost,
      500,
      true
    );
  }
}

const strategy = new ProbeStrategy();

const ORIGINAL_POLICY = process.env.CI_COST_INTEGRITY_POLICY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  recorded.length = 0;
  delete process.env.CI_COST_INTEGRITY_POLICY;
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  if (ORIGINAL_POLICY !== undefined) {
    process.env.CI_COST_INTEGRITY_POLICY = ORIGINAL_POLICY;
  } else {
    delete process.env.CI_COST_INTEGRITY_POLICY;
  }
  if (ORIGINAL_NODE_ENV !== undefined) {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  } else {
    delete process.env.NODE_ENV;
  }
});

describe('createModelExecution — cost integrity guard', () => {
  it('passes a valid positive cost through unchanged', () => {
    const execution = strategy.make(0.0001);
    expect(execution.cost).toBe(0.0001);
  });

  it('passes zero through unchanged (zero is a valid cost)', () => {
    const execution = strategy.make(0);
    expect(execution.cost).toBe(0);
  });

  it('throws CostIntegrityError on a negative cost under the default (non-production) policy', () => {
    // env-dependent (the guard's default) resolves to strict-throw outside
    // production — the same behavior eval/CI runs rely on to fail loudly
    // instead of silently publishing a corrupted benchmark number.
    expect(() => strategy.make(-58.04)).toThrow(CostIntegrityError);
  });

  it('throws on the exact -2786.097718 signature from the 2026-02-20 incident', () => {
    expect(() => strategy.make(-2786.097718)).toThrow(CostIntegrityError);
  });

  it('throws on NaN under the default policy', () => {
    expect(() => strategy.make(NaN)).toThrow(CostIntegrityError);
  });

  describe('production behavior (warn-and-null, never crashes live serving)', () => {
    beforeEach(() => {
      process.env.CI_COST_INTEGRITY_POLICY = 'warn-and-null';
    });

    it('coalesces a negative cost to 0 — never stores a negative ModelExecution.cost', () => {
      const execution = strategy.make(-58.04);
      expect(execution.cost).toBe(0);
      expect(execution.cost).not.toBeLessThan(0);
    });

    it('coalesces NaN to 0', () => {
      const execution = strategy.make(NaN);
      expect(execution.cost).toBe(0);
    });

    it('coalesces a previously-unguarded positive Infinity to 0', () => {
      // Regression for the OLD code path: `Math.max(0, Infinity) || 0` was
      // `Infinity` (Infinity is truthy), so this specific value used to slip
      // through completely unguarded. It must not anymore.
      const execution = strategy.make(Infinity);
      expect(execution.cost).toBe(0);
      expect(Number.isFinite(execution.cost)).toBe(true);
    });

    it('coalesces -Infinity to 0', () => {
      const execution = strategy.make(-Infinity);
      expect(execution.cost).toBe(0);
    });

    it('the feedback collector never observes a negative costUsd', () => {
      strategy.make(-58.04);
      expect(recorded).toHaveLength(1);
      expect(recorded[0].costUsd).toBe(0);
    });
  });
});
