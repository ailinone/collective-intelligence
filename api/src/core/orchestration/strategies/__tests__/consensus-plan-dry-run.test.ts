// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Consensus dry-run service — sources from a provided pool, NEVER
 * calls a provider, returns the same plan shape the live probe will
 * read from `ailin_metadata.consensusPlan`.
 *
 * Also pins `shouldRunConsensusDryRun` gate logic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ConsensusPlanDryRunService,
  shouldRunConsensusDryRun,
} from '../consensus-plan-dry-run-service';
import {
  diversePool,
  makeCandidate,
  makeModel,
} from '../../model-selection/__tests__/role-resolver.fixtures';
import type { ChatRequest } from '@/types';

describe('shouldRunConsensusDryRun gate', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN;
  });

  afterEach(() => {
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('returns false when env is not set', () => {
    expect(
      shouldRunConsensusDryRun({
        model: 'auto',
        strategy: 'consensus',
        messages: [],
        // @ts-expect-error eval is an additive prop
        eval: { dryRun: true },
      } as ChatRequest),
    ).toBe(false);
  });

  it('returns false when strategy is not consensus', () => {
    process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN = 'true';
    expect(
      shouldRunConsensusDryRun({
        model: 'auto',
        strategy: 'parallel',
        messages: [],
        // @ts-expect-error
        eval: { dryRun: true },
      } as ChatRequest),
    ).toBe(false);
  });

  it('returns false when eval.dryRun is absent', () => {
    process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN = 'true';
    expect(
      shouldRunConsensusDryRun({
        model: 'auto',
        strategy: 'consensus',
        messages: [],
      } as ChatRequest),
    ).toBe(false);
  });

  it('returns true when all gates pass (dryRun)', () => {
    process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN = 'true';
    expect(
      shouldRunConsensusDryRun({
        model: 'auto',
        strategy: 'consensus',
        messages: [],
        // @ts-expect-error
        eval: { dryRun: true },
      } as ChatRequest),
    ).toBe(true);
  });

  it('also accepts eval.planOnly as an opt-in', () => {
    process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN = 'true';
    expect(
      shouldRunConsensusDryRun({
        model: 'auto',
        strategy: 'consensus',
        messages: [],
        // @ts-expect-error
        eval: { planOnly: true },
      } as ChatRequest),
    ).toBe(true);
  });
});

describe('ConsensusPlanDryRunService', () => {
  it('plans without calling any provider (no fetch / no http)', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch must not be called from dry-run');
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const service = new ConsensusPlanDryRunService();
      const plan = await service.plan({
        chatRequest: {
          model: 'auto',
          strategy: 'consensus',
          messages: [{ role: 'user', content: 'Probe task' }],
          max_tokens: 1500,
          max_cost: 0.5,
        },
        candidatePool: [
          ...diversePool().filter((c) => c.hasCredits).map((c) => c.model),
          makeCandidate({
            id: 'judge-candidate',
            model: makeModel({
              id: 'judge-candidate',
              provider: 'judge-prov',
              capabilities: ['chat', 'text_generation', 'json_mode', 'function_calling'] as never[],
              contextWindow: 64000,
              performance: { latencyMs: 500, throughput: 200, quality: 0.85, reliability: 0.93 },
              inputCostPer1k: 0.0001,
              outputCostPer1k: 0.0004,
            }),
          }).model,
        ],
      });
      expect(plan.strategyName).toBe('consensus');
      expect(plan.hardcodedModelUsed).toBe(false);
      expect(plan.selectionSource).toBe('dynamic');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('exposes the role-selection trace on the plan', async () => {
    const service = new ConsensusPlanDryRunService();
    const plan = await service.plan({
      chatRequest: {
        model: 'auto',
        strategy: 'consensus',
        messages: [{ role: 'user', content: 'analysis task' }],
        max_tokens: 1000,
      },
      candidatePool: diversePool().map((c) => c.model),
    });
    expect(plan.roleSelectionTrace.length).toBeGreaterThanOrEqual(3);
    for (const trace of plan.roleSelectionTrace) {
      expect(trace.trace.hardcodedModelUsed).toBe(false);
    }
  });
});
