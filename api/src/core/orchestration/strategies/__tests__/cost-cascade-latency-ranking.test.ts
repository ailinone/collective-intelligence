// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Workstream G — latency-aware rung ranking in the cost cascade.
 *
 * Pins the candidate-ordering contract of buildCascadeCandidates():
 *  - breaker/quarantine rank stays the PRIMARY sort key (unchanged from RC-3);
 *  - cost stays the primary key WITHIN a rank, but candidates within the
 *    COLLECTIVE_LATENCY_COST_TIE_USD band are re-ordered by tracked TTFT
 *    (fastest first, unknown-last);
 *  - P0.8 cost envelope: rank-0 candidates within X× (default 10×) of the
 *    cheapest healthy candidate — floored/capped in absolute USD — form the
 *    leading group ordered by predicted TTFT, so rung 1 is the proven-fastest
 *    cheap-tier model instead of the cheapest model regardless of speed;
 *  - the rung-1 first-chunk budget falls back to the static env pin when the
 *    winning route has no tracker history, and becomes clamp(p95*factor) when
 *    it does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('CostCascadeStrategy latency-aware ranking', () => {
  beforeEach(() => {
    resetTtftTrackerForTesting();
    process.env.COLLECTIVE_LATENCY_COST_TIE_USD = '0.0001';
  });

  afterEach(() => {
    delete process.env.COLLECTIVE_LATENCY_COST_TIE_USD;
    delete process.env.COLLECTIVE_FIRST_RUNG_TTFB_MS;
  });

  it('re-orders a cost-tied pair by tracked TTFT (fastest first)', () => {
    const slow = makeModel({ id: 'm-slow', provider: 'prov-a', inputCostPer1k: 0.001, outputCostPer1k: 0.001 });
    const fast = makeModel({ id: 'm-fast', provider: 'prov-b', inputCostPer1k: 0.001, outputCostPer1k: 0.001 });
    // Same effectiveCost (0.001 avg); only tracked TTFT differs.
    getTtftTracker().recordFirstChunk('prov-b', 'm-fast', 400);
    getTtftTracker().recordFirstChunk('prov-a', 'm-slow', 3000);

    const order = candidates(new CostCascadeStrategy(), makeContext([slow, fast]));
    expect(order[0].id).toBe('m-fast');
    expect(order[1].id).toBe('m-slow');
  });

  it('never crosses a real cost boundary for latency (cost stays primary)', () => {
    const cheap = makeModel({ id: 'm-cheap', provider: 'prov-a', inputCostPer1k: 0.0001, outputCostPer1k: 0.0001 });
    const pricier = makeModel({ id: 'm-pricier', provider: 'prov-b', inputCostPer1k: 0.01, outputCostPer1k: 0.01 });
    getTtftTracker().recordFirstChunk('prov-a', 'm-cheap', 5000);
    getTtftTracker().recordFirstChunk('prov-b', 'm-pricier', 100);

    const order = candidates(new CostCascadeStrategy(), makeContext([pricier, cheap]));
    expect(order[0].id).toBe('m-cheap');
  });

  it('sorts unknown-TTFT candidates after proven-fast ones within a cost tie', () => {
    const unknown = makeModel({ id: 'm-unknown', provider: 'prov-a', inputCostPer1k: 0.001, outputCostPer1k: 0.001 });
    const proven = makeModel({ id: 'm-proven', provider: 'prov-b', inputCostPer1k: 0.001, outputCostPer1k: 0.001 });
    getTtftTracker().recordFirstChunk('prov-b', 'm-proven', 600);

    const order = candidates(new CostCascadeStrategy(), makeContext([unknown, proven]));
    expect(order[0].id).toBe('m-proven');
  });

  it('penalizes high-error-rate routes within a cost tie', () => {
    const flaky = makeModel({ id: 'm-flaky', provider: 'prov-a', inputCostPer1k: 0.001, outputCostPer1k: 0.001 });
    const steady = makeModel({ id: 'm-steady', provider: 'prov-b', inputCostPer1k: 0.001, outputCostPer1k: 0.001 });
    const tracker = getTtftTracker();
    // Both fast; flaky fails half its attempts.
    tracker.recordFirstChunk('prov-a', 'm-flaky', 300);
    tracker.recordFailure('prov-a', 'm-flaky');
    tracker.recordFirstChunk('prov-b', 'm-steady', 400);
    tracker.recordFirstChunk('prov-b', 'm-steady', 400);

    const order = candidates(new CostCascadeStrategy(), makeContext([flaky, steady]));
    expect(order[0].id).toBe('m-steady');
  });

  it('envelope: a 5x-cost proven-fast model beats the cheapest slow model for rung 1', () => {
    const cheapSlow = makeModel({ id: 'm-cheap-slow', provider: 'prov-a', inputCostPer1k: 0.0001, outputCostPer1k: 0.0001 });
    const pricierFast = makeModel({ id: 'm-pricier-fast', provider: 'prov-b', inputCostPer1k: 0.0005, outputCostPer1k: 0.0005 });
    getTtftTracker().recordFirstChunk('prov-a', 'm-cheap-slow', 4000);
    getTtftTracker().recordFirstChunk('prov-b', 'm-pricier-fast', 400);

    const order = candidates(new CostCascadeStrategy(), makeContext([cheapSlow, pricierFast]));
    expect(order[0].id).toBe('m-pricier-fast');
  });

  it('envelope: a 100x-cost premium model never captures rung 1 via the envelope', () => {
    const cheapSlow = makeModel({ id: 'm-cheap-slow', provider: 'prov-a', inputCostPer1k: 0.0001, outputCostPer1k: 0.0001 });
    const premiumFast = makeModel({ id: 'm-premium-fast', provider: 'prov-b', inputCostPer1k: 0.01, outputCostPer1k: 0.01 });
    getTtftTracker().recordFirstChunk('prov-a', 'm-cheap-slow', 4000);
    getTtftTracker().recordFirstChunk('prov-b', 'm-premium-fast', 100);

    const order = candidates(new CostCascadeStrategy(), makeContext([premiumFast, cheapSlow]));
    expect(order[0].id).toBe('m-cheap-slow');
  });

  it('envelope: free-tier floor keeps near-free fast models eligible when the cheapest is $0', () => {
    const freeSlow = makeModel({ id: 'm-free-slow', provider: 'prov-a', inputCostPer1k: 0, outputCostPer1k: 0 });
    const nearFreeFast = makeModel({ id: 'm-nearfree-fast', provider: 'prov-b', inputCostPer1k: 0.0002, outputCostPer1k: 0.0002 });
    getTtftTracker().recordFirstChunk('prov-a', 'm-free-slow', 3000);
    getTtftTracker().recordFirstChunk('prov-b', 'm-nearfree-fast', 300);

    const order = candidates(new CostCascadeStrategy(), makeContext([freeSlow, nearFreeFast]));
    expect(order[0].id).toBe('m-nearfree-fast');
  });

  it('envelope: cold start (no tracker history) preserves pure cost order', () => {
    const cheap = makeModel({ id: 'm-cheap', provider: 'prov-a', inputCostPer1k: 0.0001, outputCostPer1k: 0.0001 });
    const pricier = makeModel({ id: 'm-pricier', provider: 'prov-b', inputCostPer1k: 0.0005, outputCostPer1k: 0.0005 });

    const order = candidates(new CostCascadeStrategy(), makeContext([pricier, cheap]));
    expect(order[0].id).toBe('m-cheap');
    expect(order[1].id).toBe('m-pricier');
  });

  it('envelope: demoted (majority-failing) routes stay outside the envelope group even when cheapest', () => {
    const flakyCheap = makeModel({ id: 'm-flaky-cheap', provider: 'prov-a', inputCostPer1k: 0.0001, outputCostPer1k: 0.0001 });
    const steadyPricier = makeModel({ id: 'm-steady-pricier', provider: 'prov-b', inputCostPer1k: 0.0005, outputCostPer1k: 0.0005 });
    const tracker = getTtftTracker();
    tracker.recordFirstChunk('prov-a', 'm-flaky-cheap', 100);
    tracker.recordFailure('prov-a', 'm-flaky-cheap');
    tracker.recordFirstChunk('prov-b', 'm-steady-pricier', 800);
    tracker.recordFirstChunk('prov-b', 'm-steady-pricier', 800);

    const order = candidates(new CostCascadeStrategy(), makeContext([flakyCheap, steadyPricier]));
    expect(order[0].id).toBe('m-steady-pricier');
  });

  it('envelope: known-fast route keeps priority over an unknown route (no user-traffic exploration)', () => {
    const knownFast = makeModel({ id: 'm-known-fast', provider: 'prov-a', inputCostPer1k: 0.0001, outputCostPer1k: 0.0001 });
    const untracked = makeModel({ id: 'm-untracked', provider: 'prov-b', inputCostPer1k: 0.0005, outputCostPer1k: 0.0005 });
    getTtftTracker().recordFirstChunk('prov-a', 'm-known-fast', 400);

    const order = candidates(new CostCascadeStrategy(), makeContext([untracked, knownFast]));
    expect(order[0].id).toBe('m-known-fast');
  });

  it('firstChunkTimeoutFor falls back to the static env pin without history', () => {
    process.env.COLLECTIVE_FIRST_RUNG_TTFB_MS = '3000';
    const strategy = new CostCascadeStrategy();
    const resolver = strategy['firstChunkTimeoutFor']();
    expect(resolver(0)).toBe(3000);
  });

  it('firstChunkTimeoutFor sizes rung 1 from tracked p95 once history exists', () => {
    process.env.COLLECTIVE_FIRST_RUNG_TTFB_MS = '3000';
    const tracker = getTtftTracker();
    for (let i = 1; i <= 10; i++) tracker.recordFirstChunk('prov-a', 'm-a', i * 100); // p95 = 900
    const strategy = new CostCascadeStrategy();
    const resolver = strategy['firstChunkTimeoutFor']();
    const fakeAdapter = { getName: () => 'prov-a' } as never;
    const fakeModel = makeModel({ id: 'm-a', provider: 'prov-a' });
    // clamp(900 * 1.5, 1500, 8000) → 1500 (floor)
    expect(resolver(0, { adapter: fakeAdapter, model: fakeModel })).toBe(1500);
    // Escalation rungs (P0.8, 2026-08-18): also sized from tracked p95 — the
    // old behavior kept the full 25s collective window for ANY later rung,
    // which is how anonymous requests tail out at ~51s (3s + 25s + 25s) on
    // routes that never deliver a first chunk.
    expect(resolver(1, { adapter: fakeAdapter, model: fakeModel })).toBe(1500);
    // Unknown escalation route → static later-rung pin (8s default), not 25s.
    const fakeAdapterB = { getName: () => 'prov-b' } as never;
    const fakeModelB = makeModel({ id: 'm-b', provider: 'prov-b' });
    expect(resolver(1, { adapter: fakeAdapterB, model: fakeModelB })).toBe(8000);
  });
});
