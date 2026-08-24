// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LAT-3 dedup-memory-search: BaseStrategy.enrichWithMemories() must not
 * repeat the engine-level semantic-memory search on a MISS, only skip
 * work that is genuinely a duplicate of it.
 *
 * Root cause #1 (fixed by the original LAT-3 commit): `context.memoryEnriched`
 * was only ever set when the engine's concurrent memory-context lookup found
 * something (`hasContext: true`). On a miss, the lookup still ran a full
 * embedding + pgvector round trip, found nothing, left `memoryEnriched`
 * unset — and `enrichWithMemories()`'s guard then unconditionally re-ran the
 * same search a second time via `searchMemories()`. That commit added
 * `context.memorySearched` (true on both hit and miss whenever the engine's
 * lookup actually resolved) and widened the guard to
 * `memoryEnriched || memorySearched`.
 *
 * Root cause #2 (fixed here, LAT-3.1): that widened guard assumed the
 * engine-level search and the strategy-level `searchMemories()` are
 * redundant on a miss. They are not: the engine only ever searches
 * memoryTypes ['semantic', 'procedural'] (never 'episodic') scoped to the
 * requesting user (or NULL-owner rows), via
 * MemoryContextService.DEFAULT_OPTIONS. `searchMemories()` searches ALL
 * types across the whole org (no userId filter). Skipping it entirely on
 * every miss silently dropped episodic-memory recall and cross-user org-wide
 * recall for every request. The fix: skip only on `memoryEnriched` (a true
 * duplicate — the engine already found and injected something); on a miss,
 * still search, narrowed to `type: 'episodic'` — the slice the engine's
 * query structurally cannot reach, so it is not a duplicate round trip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseStrategy, type StrategyMetadata } from '@/core/orchestration/base-strategy';
import type { ChatRequest, OrchestrationContext, OrchestrationResult, Model } from '@/types';

const searchMock = vi.hoisted(() => vi.fn());

vi.mock('@/core/memory/semantic-memory-store', () => ({
  getSemanticMemoryStore: () => ({
    search: searchMock,
  }),
}));

class TestStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'test-strategy',
      name: 'single',
      displayName: 'Test',
      description: 'test-only strategy for enrichWithMemories dedup',
      minModels: 1,
      maxModels: 1,
      estimatedCostMultiplier: 1,
      estimatedQualityBoost: 0,
      estimatedDurationMultiplier: 1,
      suitableFor: [],
    };
  }
  async execute(): Promise<OrchestrationResult> {
    throw new Error('not used');
  }
}

function makeRequest(content = 'a message long enough to pass the 10-char gate'): ChatRequest {
  return { model: 'auto', messages: [{ role: 'user', content }] } as ChatRequest;
}

function makeContext(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    requestId: 'test-req',
    organizationId: 'org1',
    userId: 'user1',
    models: [] as Model[],
    taskType: 'analysis',
    contextSize: 0,
    ...overrides,
  } as OrchestrationContext;
}

describe('BaseStrategy.enrichWithMemories — LAT-3 dedup guard', () => {
  let strategy: TestStrategy;

  beforeEach(() => {
    searchMock.mockReset();
    strategy = new TestStrategy();
  });

  it('re-searches (full, unscoped) when neither memoryEnriched nor memorySearched is set (baseline, pre-fix behavior preserved)', async () => {
    searchMock.mockResolvedValue([]);
    const request = makeRequest();
    const context = makeContext(); // no memoryEnriched, no memorySearched

    await strategy.enrichWithMemories(request, context);

    expect(searchMock).toHaveBeenCalledTimes(1);
    // Full fallback: no type filter (all types), no userId filter (org-wide) —
    // matches the pre-LAT-3 searchMemories() query exactly.
    const callArgs = searchMock.mock.calls[0][0];
    expect(callArgs.organizationId).toBe('org1');
    expect(callArgs.type).toBeUndefined();
    expect(callArgs).not.toHaveProperty('userId');
  });

  it('LAT-3.1: on a MISS (memorySearched=true, memoryEnriched=false), still searches — narrowed to the engine\'s coverage gap (type: episodic, org-wide)', async () => {
    searchMock.mockResolvedValue([
      { entry: { id: 'm1', type: 'episodic', content: 'past conversation' }, similarity: 0.8 },
    ]);
    const request = makeRequest();
    const context = makeContext({ memorySearched: true, memoryEnriched: false });

    const result = await strategy.enrichWithMemories(request, context);

    // Regression guard: this used to assert `searchMock).not.toHaveBeenCalled()`,
    // which is exactly the recall-quality bug — a miss must not skip the
    // fallback outright, only narrow it.
    expect(searchMock).toHaveBeenCalledTimes(1);
    const callArgs = searchMock.mock.calls[0][0];
    expect(callArgs.organizationId).toBe('org1');
    expect(callArgs.type).toBe('episodic'); // the ONE type the engine-level search never covers
    expect(callArgs).not.toHaveProperty('userId'); // org-wide — engine scopes to userId-or-NULL
    expect(result).not.toBe(request); // episodic memory found and injected
  });

  it('LAT-3.1: the miss-case fallback never requests semantic/procedural — that slice is genuinely redundant with the engine search', async () => {
    searchMock.mockResolvedValue([]);
    const request = makeRequest();
    const context = makeContext({ memorySearched: true, memoryEnriched: false });

    await strategy.enrichWithMemories(request, context);

    expect(searchMock).toHaveBeenCalledTimes(1);
    const callArgs = searchMock.mock.calls[0][0];
    expect(callArgs.type).not.toBe('semantic');
    expect(callArgs.type).not.toBe('procedural');
  });

  it('does not re-search when the engine already enriched the request (memoryEnriched=true, HIT — pre-existing behavior, genuinely a duplicate)', async () => {
    const request = makeRequest();
    const context = makeContext({ memoryEnriched: true });

    const result = await strategy.enrichWithMemories(request, context);

    expect(searchMock).not.toHaveBeenCalled();
    expect(result).toBe(request);
  });

  it('memoryEnriched=true short-circuits even if memorySearched is also true (HIT takes precedence)', async () => {
    const request = makeRequest();
    const context = makeContext({ memoryEnriched: true, memorySearched: true });

    const result = await strategy.enrichWithMemories(request, context);

    expect(searchMock).not.toHaveBeenCalled();
    expect(result).toBe(request);
  });

  it('re-searches (full, unscoped) when the engine never resolved a search for this request (e.g. MEMORY_CONTEXT_ENABLED=false) — fallback preserved', async () => {
    searchMock.mockResolvedValue([
      { entry: { id: 'm1', type: 'semantic', content: 'fact' }, similarity: 0.8 },
    ]);
    const request = makeRequest();
    // memorySearched undefined — engine-level lookup never ran/resolved.
    const context = makeContext({ memorySearched: undefined, memoryEnriched: undefined });

    const result = await strategy.enrichWithMemories(request, context);

    expect(searchMock).toHaveBeenCalledTimes(1);
    const callArgs = searchMock.mock.calls[0][0];
    expect(callArgs.type).toBeUndefined();
    expect(callArgs).not.toHaveProperty('userId');
    expect(result).not.toBe(request); // memory block was prepended
  });

  it('still short-circuits very short messages (<10 chars) without a search, regardless of the new flag', async () => {
    const request = makeRequest('hi');
    const context = makeContext({ memorySearched: false, memoryEnriched: false });

    const result = await strategy.enrichWithMemories(request, context);

    expect(searchMock).not.toHaveBeenCalled();
    expect(result).toBe(request);
  });
});
