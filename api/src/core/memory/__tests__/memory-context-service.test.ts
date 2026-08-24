// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LAT-3 dedup-memory-search: MemoryContext.searched contract.
 *
 * `searched` must be true only when memoryStore.search() actually executed
 * (a pgvector round trip happened), independent of whether it found
 * anything — and false for the two paths where no round trip happened
 * (empty query short-circuit, internal error). Downstream, the
 * orchestration engine uses this to tell strategy-level
 * enrichWithMemories() whether it's safe to skip its own fallback search
 * (base-strategy.ts:2775).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryContextService } from '@/core/memory/memory-context-service';
import type { ChatRequest } from '@/types';

const searchMock = vi.hoisted(() => vi.fn());

vi.mock('@/core/memory/semantic-memory-store', () => ({
  getSemanticMemoryStore: () => ({
    search: searchMock,
  }),
}));

function req(content: string): ChatRequest {
  // Padded past TRIVIAL_MESSAGE_MAX_CHARS (64) so the fixture opts INTO the
  // full memory path — buildContext now short-circuits trivially-short
  // single-turn requests at the source (P0.8 hot-path guard).
  const padded = content.length >= 80 ? content : `${content} ${'detail '.repeat(12)}`;
  return { messages: [{ role: 'user', content: padded }] } as ChatRequest;
}

describe('MemoryContextService.buildContext — searched flag', () => {
  beforeEach(() => {
    searchMock.mockReset();
  });

  it('searched=true and hasContext=true on a HIT (memories found)', async () => {
    searchMock.mockResolvedValue([
      {
        entry: { id: 'm1', type: 'semantic', content: 'fact', organizationId: 'org1' },
        similarity: 0.9,
      },
    ]);
    const service = new MemoryContextService();
    const ctx = await service.buildContext(req('what is the plan for launch'), 'org1', 'user1');

    expect(searchMock).toHaveBeenCalled();
    expect(ctx.searched).toBe(true);
    expect(ctx.hasContext).toBe(true);
  });

  it('searched=true and hasContext=false on a MISS (search ran, found nothing)', async () => {
    searchMock.mockResolvedValue([]);
    const service = new MemoryContextService();
    const ctx = await service.buildContext(req('what is the plan for launch'), 'org1', 'user1');

    expect(searchMock).toHaveBeenCalled();
    expect(ctx.searched).toBe(true);
    expect(ctx.hasContext).toBe(false);
  });

  it('searched=false for a trivially-short single-turn request — hot-path guard, no round trip attempted', async () => {
    const service = new MemoryContextService();
    const ctx = await service.buildContext(
      { messages: [{ role: 'user', content: 'oi' }] } as ChatRequest,
      'org1',
      'user1'
    );

    expect(searchMock).not.toHaveBeenCalled();
    expect(ctx.searched).toBe(false);
    expect(ctx.hasContext).toBe(false);
  });

  it('searched=false when the query is empty (no user message) — no round trip attempted', async () => {
    const service = new MemoryContextService();
    const ctx = await service.buildContext(
      { messages: [{ role: 'system', content: 'sys only' }] } as ChatRequest,
      'org1',
      'user1'
    );

    expect(searchMock).not.toHaveBeenCalled();
    expect(ctx.searched).toBe(false);
    expect(ctx.hasContext).toBe(false);
  });

  it('per-type search() rejection is caught internally — still searched=true, hasContext=false (same as a clean miss)', async () => {
    // store.search() rejecting for every configured memory type is caught by
    // buildContext's PER-TYPE try/catch (it logs and continues the loop), not
    // its outer try/catch — so this must NOT be confused with the "outer
    // catch" case below, which needs the failure to happen outside the
    // search loop entirely (e.g. getSemanticMemoryStore() itself throwing).
    searchMock.mockRejectedValue(new Error('pgvector unreachable'));
    const service = new MemoryContextService();
    const ctx = await service.buildContext(req('anything'), 'org1', 'user1');
    expect(ctx.hasContext).toBe(false);
    expect(ctx.searched).toBe(true);
  });

  it('searched=false when getSemanticMemoryStore() itself throws (outer catch)', async () => {
    // Re-mock the module for this one test to throw at the accessor level,
    // which is the only way to hit buildContext's OUTER try/catch.
    vi.resetModules();
    vi.doMock('@/core/memory/semantic-memory-store', () => ({
      getSemanticMemoryStore: () => {
        throw new Error('store unavailable');
      },
    }));
    const { MemoryContextService: FreshService } = await import(
      '@/core/memory/memory-context-service'
    );
    const service = new FreshService();
    const ctx = await service.buildContext(req('anything'), 'org1', 'user1');
    expect(ctx.searched).toBe(false);
    expect(ctx.hasContext).toBe(false);
  });
});
