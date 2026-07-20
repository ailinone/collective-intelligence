// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Phase 1 scale-to-100k: model-catalog scoring hot-path memoization.
 *
 * These tests pin the behavior of the memoized per-provider scoring inside
 * IntelligentModelSelectionService:
 *   - equivalence + cache hit: a repeated (required, preferred, contextSize)
 *     key reuses the cached scoring and does NOT rescan (getModels /
 *     evaluateModel are not re-invoked).
 *   - live availability: flipping a provider unusable excludes its candidates
 *     on the next call WITHOUT rebuilding the cache.
 *   - invalidation: invalidateScoredCandidateCache() forces a rebuild.
 *   - correctness: the cached-path candidate set equals a direct full scan of
 *     the same inputs.
 *
 * Hermetic: mock adapters + an injected availability stub. No DB, no registry.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IntelligentModelSelectionService } from '@/services/intelligent-model-selection-service';
import type {
  CapabilityRequirements,
  ModelCandidate,
} from '@/services/intelligent-model-selection-service';
import type { ProviderStatus } from '@/services/provider-availability-service';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { Model, ModelCapability } from '@/types';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<Model> & { id: string; provider: string }): Model {
  return {
    providerId: `${overrides.provider}-pid`,
    name: overrides.id,
    displayName: overrides.id,
    contextWindow: 8_000,
    maxOutputTokens: 4_000,
    inputCostPer1k: 1,
    outputCostPer1k: 1,
    capabilities: ['chat', 'text_generation'],
    performance: { latencyMs: 100, throughput: 100, quality: 0.5, reliability: 0.9 },
    status: 'active',
    ...overrides,
  } as Model;
}

interface MockAdapter {
  adapter: ProviderAdapter;
  getModels: ReturnType<typeof vi.fn>;
}

function makeAdapter(name: string, models: Model[]): MockAdapter {
  const getModels = vi.fn(async () => models);
  const adapter = {
    getName: () => name,
    getModels,
  } as unknown as ProviderAdapter;
  return { adapter, getModels };
}

/** Controllable availability stub matching the injected checker surface. */
function makeAvailability(initiallyUsable: string[]) {
  const usable = new Set(initiallyUsable);
  return {
    usable,
    isProviderUsable: vi.fn((provider: string) => usable.has(provider)),
    getStatus: vi.fn((_provider: string): ProviderStatus | undefined => undefined),
  };
}

// Typed access to the private hot-path method under test.
type CollectResult = { candidates: ModelCandidate[]; evaluated: number };
function collect(
  service: IntelligentModelSelectionService,
  adapters: ProviderAdapter[],
  required: ModelCapability[],
  preferred: ModelCapability[],
  requirements: CapabilityRequirements
): Promise<CollectResult> {
  return (
    service as unknown as {
      collectModelCandidates: (
        a: ProviderAdapter[],
        r: ModelCapability[],
        p: ModelCapability[],
        req: CapabilityRequirements
      ) => Promise<CollectResult>;
    }
  ).collectModelCandidates(adapters, required, preferred, requirements);
}

/** Order-independent fingerprint of a collect result for equality assertions. */
function fingerprint(result: CollectResult) {
  return {
    evaluated: result.evaluated,
    candidates: result.candidates
      .map((c) => ({ id: c.model.id, provider: c.model.provider, score: c.score }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUIRED: ModelCapability[] = ['chat', 'text_generation'];
const PREFERRED: ModelCapability[] = ['reasoning'];

function makeRequirements(contextSize = 1_000): CapabilityRequirements {
  return {
    required: REQUIRED,
    preferred: PREFERRED,
    taskType: 'chat',
    complexity: 'moderate',
    contextSize,
    needsTools: false,
    toolCount: 0,
  };
}

interface Fixture {
  service: IntelligentModelSelectionService;
  adapters: ProviderAdapter[];
  p1: MockAdapter;
  p2: MockAdapter;
  availability: ReturnType<typeof makeAvailability>;
  evalSpy: ReturnType<typeof vi.spyOn>;
  requirements: CapabilityRequirements;
}

function setup(): Fixture {
  // p1: m1 scores high (reasoning + big context + quality); m2 misses a
  // required capability -> score 0 -> excluded.
  const p1 = makeAdapter('p1', [
    makeModel({
      id: 'm1',
      provider: 'p1',
      capabilities: ['chat', 'text_generation', 'reasoning'],
      contextWindow: 100_000,
      performance: { latencyMs: 50, throughput: 200, quality: 0.9, reliability: 0.99 },
    }),
    makeModel({
      id: 'm2',
      provider: 'p1',
      capabilities: ['chat'], // missing text_generation -> score 0
    }),
  ]);

  // p2: m3 meets requirements with a cost penalty; m4 scores high.
  const p2 = makeAdapter('p2', [
    makeModel({
      id: 'm3',
      provider: 'p2',
      capabilities: ['chat', 'text_generation'],
      contextWindow: 4_000,
      inputCostPer1k: 30,
      outputCostPer1k: 30, // avgCost 30 > 10 -> -5 penalty
    }),
    makeModel({
      id: 'm4',
      provider: 'p2',
      capabilities: ['chat', 'text_generation', 'reasoning', 'analysis'],
      contextWindow: 8_000,
      performance: { latencyMs: 60, throughput: 180, quality: 0.85, reliability: 0.97 },
    }),
  ]);

  const availability = makeAvailability(['p1', 'p2']);
  const service = new IntelligentModelSelectionService(availability);

  // Spy on the pure scorer to prove cache hits skip re-scoring. Prototype spy
  // (calls through to the original by default) so instance calls are observed.
  const evalSpy = vi.spyOn(
    IntelligentModelSelectionService.prototype as unknown as { evaluateModel: (...a: unknown[]) => unknown },
    'evaluateModel'
  );

  return {
    service,
    adapters: [p1.adapter, p2.adapter],
    p1,
    p2,
    availability,
    evalSpy,
    requirements: makeRequirements(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IntelligentModelSelectionService — scored-candidate cache', () => {
  it('builds and scores correctly on the first call, then serves a cache hit without rescanning', async () => {
    const { service, adapters, p1, p2, availability, evalSpy, requirements } = setup();

    const first = await collect(service, adapters, REQUIRED, PREFERRED, requirements);

    // Cold build: every adapter fetched once, every model scored once.
    expect(p1.getModels).toHaveBeenCalledTimes(1);
    expect(p2.getModels).toHaveBeenCalledTimes(1);
    expect(evalSpy).toHaveBeenCalledTimes(4); // m1,m2,m3,m4

    // m2 excluded (score 0); evaluated counts every scanned model (4).
    const ids = first.candidates.map((c) => c.model.id).sort();
    expect(ids).toEqual(['m1', 'm3', 'm4']);
    expect(first.evaluated).toBe(4);
    // Sanity-check the concrete scores from evaluateModel's formula.
    const byId = Object.fromEntries(first.candidates.map((c) => [c.model.id, c.score]));
    expect(byId.m1).toBe(75); // 50 + reasoning10 + ctx5 + quality10
    expect(byId.m3).toBe(50); // 50 + ctx5 - cost5
    expect(byId.m4).toBe(75); // 50 + reasoning10 + ctx5 + quality10

    // Second call, identical key -> cache hit: no rescan, identical result.
    const before = { p1: p1.getModels.mock.calls.length, p2: p2.getModels.mock.calls.length, evals: evalSpy.mock.calls.length };
    const second = await collect(service, adapters, REQUIRED, PREFERRED, requirements);

    expect(p1.getModels.mock.calls.length).toBe(before.p1); // no new getModels
    expect(p2.getModels.mock.calls.length).toBe(before.p2);
    expect(evalSpy.mock.calls.length).toBe(before.evals); // no re-evaluation
    expect(fingerprint(second)).toEqual(fingerprint(first));

    // Availability is still consulted live on the cache-hit path.
    expect(availability.isProviderUsable).toHaveBeenCalledWith('p1');
    expect(availability.isProviderUsable).toHaveBeenCalledWith('p2');
  });

  it('applies availability live: flipping a provider unusable excludes it WITHOUT rebuilding', async () => {
    const { service, adapters, p1, p2, evalSpy, availability, requirements } = setup();

    const warm = await collect(service, adapters, REQUIRED, PREFERRED, requirements);
    expect(warm.candidates.map((c) => c.model.id).sort()).toEqual(['m1', 'm3', 'm4']);
    expect(warm.evaluated).toBe(4);

    const evalsAfterWarm = evalSpy.mock.calls.length;

    // p2 goes down between requests.
    availability.usable.delete('p2');

    const next = await collect(service, adapters, REQUIRED, PREFERRED, requirements);

    // No rebuild: getModels/evaluateModel not called again.
    expect(p1.getModels).toHaveBeenCalledTimes(1);
    expect(p2.getModels).toHaveBeenCalledTimes(1);
    expect(evalSpy.mock.calls.length).toBe(evalsAfterWarm);

    // p2's candidates and evaluated count are excluded live.
    expect(next.candidates.map((c) => c.model.id).sort()).toEqual(['m1']);
    expect(next.evaluated).toBe(2); // only p1's two models

    // Flipping it back restores its candidates, still from cache.
    availability.usable.add('p2');
    const restored = await collect(service, adapters, REQUIRED, PREFERRED, requirements);
    expect(p2.getModels).toHaveBeenCalledTimes(1); // still no rebuild
    expect(evalSpy.mock.calls.length).toBe(evalsAfterWarm);
    expect(fingerprint(restored)).toEqual(fingerprint(warm));
  });

  it('invalidateScoredCandidateCache() forces a full rebuild on the next call', async () => {
    const { service, adapters, p1, p2, evalSpy, requirements } = setup();

    await collect(service, adapters, REQUIRED, PREFERRED, requirements);
    expect(p1.getModels).toHaveBeenCalledTimes(1);
    expect(p2.getModels).toHaveBeenCalledTimes(1);
    const evalsAfterFirst = evalSpy.mock.calls.length;

    service.invalidateScoredCandidateCache();

    const rebuilt = await collect(service, adapters, REQUIRED, PREFERRED, requirements);

    // Rebuild: adapters fetched again, models scored again.
    expect(p1.getModels).toHaveBeenCalledTimes(2);
    expect(p2.getModels).toHaveBeenCalledTimes(2);
    expect(evalSpy.mock.calls.length).toBe(evalsAfterFirst + 4);
    expect(rebuilt.candidates.map((c) => c.model.id).sort()).toEqual(['m1', 'm3', 'm4']);
    expect(rebuilt.evaluated).toBe(4);
  });

  it('caches per (required, preferred, contextSize) key — a different contextSize rebuilds independently', async () => {
    const { service, adapters, p1, p2, requirements } = setup();

    await collect(service, adapters, REQUIRED, PREFERRED, requirements);
    expect(p1.getModels).toHaveBeenCalledTimes(1);

    // Same required/preferred but a larger contextSize is a different key: the
    // contextWindow bonus threshold (contextSize * 2 = 120k) shifts above every
    // model's contextWindow, so scoring must rebuild rather than reuse the
    // previous key's entry.
    const bigContext = makeRequirements(60_000); // 60k*2 = 120k; no model reaches it
    const other = await collect(service, adapters, REQUIRED, PREFERRED, bigContext);

    expect(p1.getModels).toHaveBeenCalledTimes(2); // rebuilt for the new key
    expect(p2.getModels).toHaveBeenCalledTimes(2);

    const byId = Object.fromEntries(other.candidates.map((c) => [c.model.id, c.score]));
    // No model's contextWindow (>=120k) reaches the raised threshold, so all
    // lose the +5 ctx bonus vs the small-context key.
    expect(byId.m1).toBe(70); // 50 + reasoning10 + quality10, no ctx bonus
    expect(byId.m3).toBe(45); // 50 - cost5, no ctx bonus
    expect(byId.m4).toBe(70); // 50 + reasoning10 + quality10, no ctx bonus
  });

  it('the cached-path candidate set equals a direct full scan of the same inputs', async () => {
    const { service, adapters, requirements } = setup();

    // Warm the cache, then read from it.
    await collect(service, adapters, REQUIRED, PREFERRED, requirements);
    const cached = await collect(service, adapters, REQUIRED, PREFERRED, requirements);

    // A fresh service (cold cache) performing a single collect IS a direct
    // full scan + live availability filter of the same inputs.
    const freshAvailability = makeAvailability(['p1', 'p2']);
    const freshService = new IntelligentModelSelectionService(freshAvailability);
    const freshAdapters = [
      makeAdapter('p1', [
        makeModel({
          id: 'm1',
          provider: 'p1',
          capabilities: ['chat', 'text_generation', 'reasoning'],
          contextWindow: 100_000,
          performance: { latencyMs: 50, throughput: 200, quality: 0.9, reliability: 0.99 },
        }),
        makeModel({ id: 'm2', provider: 'p1', capabilities: ['chat'] }),
      ]).adapter,
      makeAdapter('p2', [
        makeModel({
          id: 'm3',
          provider: 'p2',
          capabilities: ['chat', 'text_generation'],
          contextWindow: 4_000,
          inputCostPer1k: 30,
          outputCostPer1k: 30,
        }),
        makeModel({
          id: 'm4',
          provider: 'p2',
          capabilities: ['chat', 'text_generation', 'reasoning', 'analysis'],
          contextWindow: 8_000,
          performance: { latencyMs: 60, throughput: 180, quality: 0.85, reliability: 0.97 },
        }),
      ]).adapter,
    ];
    const directScan = await collect(freshService, freshAdapters, REQUIRED, PREFERRED, requirements);

    expect(fingerprint(cached)).toEqual(fingerprint(directScan));
  });
});
