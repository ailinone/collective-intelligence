// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Route-error demotion in the cost cascade (2026-08-18).
 *
 * Live production evidence: anonymous ailin-economy requests degraded because
 * the 5-rung ladder was captured by zero-cost free-tier routes failing 100%
 * of the time (featherless-ai first-chunk timeouts, groq
 * llama-3.1-8b-instant 404 model-not-found) while 52k healthy models sat
 * behind them. Cost is the primary sort key and a $0 model always wins it,
 * so the latency tie-break (which never crosses a cost boundary) could not
 * dislodge them.
 *
 * Pins the contract: a route whose RECENT tracked attempts are majority
 * failures (>=2 attempts, errorRate >= 0.5) is demoted to rank 1 — below
 * every candidate without observed failures, above OPEN/quarantined — and a
 * single transient failure does NOT demote.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CostCascadeStrategy } from '../cost-cascade-strategy';
import { getTtftTracker, resetTtftTrackerForTesting } from '@/core/selection/ttft-tracker';
import type { Model, OrchestrationContext } from '@/types';

function makeModel(overrides: Partial<Model> & { id: string; provider: string }): Model {
  return {
    name: overrides.id,
    providerId: overrides.provider,
    capabilities: ['chat'],
    contextWindow: 32000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    status: 'active',
    ...overrides,
  } as Model;
}

function makeContext(models: Model[]): OrchestrationContext {
  return {
    models,
    taskType: 'general',
    contextSize: 100,
    requestId: 'test-req',
  } as unknown as OrchestrationContext;
}

function candidates(strategy: CostCascadeStrategy, context: OrchestrationContext): Model[] {
  return (strategy as unknown as { buildCascadeCandidates: (c: OrchestrationContext) => Model[] })
    .buildCascadeCandidates(context);
}

describe('CostCascadeStrategy route-error demotion', () => {
  beforeEach(() => {
    resetTtftTrackerForTesting();
  });

  it('demotes a majority-failing $0 route below a healthy costlier route', () => {
    // The exact live shape: a near-free dead route (real-but-tiny pricing,
    // like groq llama-3.1-8b at $0.00005/1k) vs a real-cost healthy one.
    const dead = makeModel({
      id: 'dead-free-model',
      provider: 'featherless-ai',
      inputCostPer1k: 0.00001,
      outputCostPer1k: 0.00001,
    });
    const healthy = makeModel({
      id: 'healthy-paid-model',
      provider: 'nanogpt',
      inputCostPer1k: 0.0002,
      outputCostPer1k: 0.0002,
    });
    getTtftTracker().recordFailure('featherless-ai', 'dead-free-model');
    getTtftTracker().recordFailure('featherless-ai', 'dead-free-model');

    const order = candidates(new CostCascadeStrategy(), makeContext([dead, healthy]));
    expect(order[0].id).toBe('healthy-paid-model');
    expect(order[1].id).toBe('dead-free-model');
  });

  it('a single transient failure does NOT demote (attempts < 2)', () => {
    const flaky = makeModel({
      id: 'one-fail',
      provider: 'prov-a',
      inputCostPer1k: 0.00001,
      outputCostPer1k: 0.00001,
    });
    const healthy = makeModel({
      id: 'healthy',
      provider: 'prov-b',
      inputCostPer1k: 0.0002,
      outputCostPer1k: 0.0002,
    });
    getTtftTracker().recordFailure('prov-a', 'one-fail');

    const order = candidates(new CostCascadeStrategy(), makeContext([flaky, healthy]));
    // Cost stays primary: the $0 route with one failure still leads.
    expect(order[0].id).toBe('one-fail');
  });

  it('a recovered route (recent success lowering errorRate below 0.5) is not demoted', () => {
    const recovering = makeModel({
      id: 'recovering',
      provider: 'prov-a',
      inputCostPer1k: 0.00001,
      outputCostPer1k: 0.00001,
    });
    const healthy = makeModel({
      id: 'healthy',
      provider: 'prov-b',
      inputCostPer1k: 0.0002,
      outputCostPer1k: 0.0002,
    });
    getTtftTracker().recordFailure('prov-a', 'recovering');
    getTtftTracker().recordFailure('prov-a', 'recovering');
    getTtftTracker().recordFailure('prov-a', 'recovering');
    getTtftTracker().recordFirstChunk('prov-a', 'recovering', 900);
    getTtftTracker().recordFirstChunk('prov-a', 'recovering', 800);
    getTtftTracker().recordFirstChunk('prov-a', 'recovering', 700);
    // errorRate = 3/6 = 0.5 — boundary is inclusive-demotion at >= 0.5, so
    // push one more success to get below it.
    getTtftTracker().recordFirstChunk('prov-a', 'recovering', 600);

    const order = candidates(new CostCascadeStrategy(), makeContext([recovering, healthy]));
    expect(order[0].id).toBe('recovering');
  });

  it('demoted dead routes from distinct providers do not starve a full 5-rung ladder', () => {
    // Reproduces the live ladder (all rungs dead, diversified round-robin)
    // and asserts healthy candidates now fill the front of the ladder.
    const deadFree = [
      makeModel({ id: 'd1', provider: 'featherless-ai', inputCostPer1k: 0.00001, outputCostPer1k: 0.00001 }),
      makeModel({ id: 'd2', provider: 'groq', inputCostPer1k: 0.00002, outputCostPer1k: 0.00002 }),
      makeModel({ id: 'd3', provider: 'phala', inputCostPer1k: 0.00003, outputCostPer1k: 0.00003 }),
      makeModel({ id: 'd4', provider: 'empiriolabs', inputCostPer1k: 0.00004, outputCostPer1k: 0.00004 }),
      makeModel({ id: 'd5', provider: 'huggingface', inputCostPer1k: 0.00005, outputCostPer1k: 0.00005 }),
    ];
    const healthy = [
      makeModel({ id: 'h1', provider: 'nanogpt', inputCostPer1k: 0.0002, outputCostPer1k: 0.0002 }),
      makeModel({ id: 'h2', provider: 'chutes', inputCostPer1k: 0.0003, outputCostPer1k: 0.0003 }),
    ];
    for (const m of deadFree) {
      getTtftTracker().recordFailure(m.provider, m.id);
      getTtftTracker().recordFailure(m.provider, m.id);
    }

    const order = candidates(new CostCascadeStrategy(), makeContext([...deadFree, ...healthy]));
    expect(order.slice(0, 2).map((m) => m.id).sort()).toEqual(['h1', 'h2']);
  });
});
