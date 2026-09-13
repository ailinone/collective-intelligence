// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ObserverService.emitImmediate — the zero-latency narration path (Gap 2).
 *
 * Unlike emit() (which awaits backend resolution and a real LLM call before a
 * narration is ever queued), emitImmediate() must deliver its narration
 * SYNCHRONOUSLY, with no network/LLM round-trip at all — that is its entire
 * reason to exist (see observer-types.ts's doc on ObserverFeed.emitImmediate
 * and observer-templates.ts's doc on buildImmediateOpeningNarration).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  ObserverService,
  createNoOpObserverFeed,
  __resetObserverBackendCacheForTests,
} from '../observer-service';
import type { ObserverEvent } from '@/types';

function phaseStart(): ObserverEvent {
  return { type: 'phase_start', timestamp: Date.now(), strategy: 'consensus', models: [] };
}

describe('ObserverService.emitImmediate', () => {
  beforeEach(() => {
    __resetObserverBackendCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('delivers the narration synchronously — readable via drainReadyNarrations() with NO await in between', () => {
    // No fetch stub at all: if this path touched the network it would hang or
    // throw on the real `fetch`. It must not reach fetch at all.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const observer = new ObserverService({ enabled: true }, 'consensus');
    observer.emitImmediate(phaseStart(), 'Iniciando a estratégia "consensus"...');

    // Deliberately NOT awaiting anything between emitImmediate() and the read —
    // an async/LLM-backed implementation would still show an EMPTY queue here.
    const ready = observer.drainReadyNarrations();

    expect(ready).toHaveLength(1);
    expect(ready[0].narration).toBe('Iniciando a estratégia "consensus"...');
    expect(ready[0].durationMs).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('measures near-zero wall-clock latency — orders of magnitude below any real LLM/network call', () => {
    const observer = new ObserverService({ enabled: true }, 'consensus');
    const t0 = Date.now();
    observer.emitImmediate(phaseStart(), 'Starting the "consensus" strategy...');
    const elapsedMs = Date.now() - t0;
    const ready = observer.drainReadyNarrations();

    // The narrator's own LLM path documents a 4-9s floor and a 10s/15s hard
    // timeout (see observer-service.ts). Anything under 50ms conclusively did
    // NOT take that path — this is a generous bound for slow CI, not a tight
    // perf assertion.
    expect(elapsedMs).toBeLessThan(50);
    expect(ready).toHaveLength(1);
  });

  it('appears in getNarrations() (final metadata) alongside later real narrations, in emission order', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'qwen2.5:1.5b' }] }),
        } as unknown as Response;
      }
      if (url.endsWith('/chat/completions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'narração real' } }] }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.OLLAMA_URL = 'http://ollama-test:11434/v1';

    const observer = new ObserverService({ enabled: true }, 'consensus');
    observer.emitImmediate(phaseStart(), 'Immediate opening line');
    observer.emit(phaseStart());
    await observer.flushPending(3000);

    const all = observer.getNarrations();
    expect(all.length).toBe(2);
    expect(all[0].narration).toBe('Immediate opening line'); // immediate landed FIRST
    expect(all[0].durationMs).toBe(0);
    expect(all[1].narration).toBe('narração real');
    delete process.env.OLLAMA_URL;
  });

  it('is a true no-op when the observer is disabled (config.enabled: false)', () => {
    const observer = new ObserverService({ enabled: false }, 'consensus');
    observer.emitImmediate(phaseStart(), 'should not appear');
    expect(observer.drainReadyNarrations()).toHaveLength(0);
    expect(observer.getNarrations()).toHaveLength(0);
  });

  it('does not touch pendingPromises / flushPending — nothing to await', async () => {
    const observer = new ObserverService({ enabled: true }, 'consensus');
    observer.emitImmediate(phaseStart(), 'instant');
    // flushPending with a near-zero timeout must return immediately regardless —
    // there is no in-flight promise for the immediate narration to wait on.
    const start = Date.now();
    await observer.flushPending(0);
    expect(Date.now() - start).toBeLessThan(50);
    expect(observer.drainReadyNarrations()).toHaveLength(1);
  });
});

describe('createNoOpObserverFeed().emitImmediate', () => {
  it('is a safe no-op (never throws, never enqueues)', () => {
    const feed = createNoOpObserverFeed();
    expect(() => feed.emitImmediate(phaseStart(), 'x')).not.toThrow();
    expect(feed.getNarrations()).toHaveLength(0);
    expect(feed.drainReadyNarrations()).toHaveLength(0);
  });
});
