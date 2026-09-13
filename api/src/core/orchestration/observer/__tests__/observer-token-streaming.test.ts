// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Token-level streaming (2026-09 follow-up to PR #473 — "Idea 2", deferred in
 * that PR's body). Once a narration call starts, ObserverService requests
 * `stream: true` from the resolved backend and delivers each token as an
 * incremental `partial: true` fragment instead of waiting for the whole
 * string and emitting it as one discrete chunk.
 *
 * This file locks the Ollama path (the "primary" backend per this service's
 * own doc comment — local, fast, free) using a real streaming `Response`
 * whose body is an OpenAI-compatible SSE stream, the same shape every
 * ProviderAdapter's own `chatCompletionStream` already parses (see
 * openai-compatible-hub-adapter.streaming-tool-calls.test.ts for the
 * equivalent pattern on the adapter side).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ObserverService,
  buildObserverChunk,
  __resetObserverBackendCacheForTests,
} from '../observer-service';
import type { ObserverEvent } from '@/types';

const OLLAMA_URL = 'http://ollama-test:11434/v1';

function makeEvent(): ObserverEvent {
  return {
    type: 'phase_start',
    timestamp: Date.now(),
    strategy: 'debate',
    summary: 'Opening the debate',
    models: ['model-a', 'model-b'],
  };
}

/**
 * Build a real streaming Response whose body is an OpenAI-compatible SSE
 * stream of `delta.content` fragments — mirrors the pattern used for
 * ProviderAdapter streaming tests elsewhere in this codebase.
 */
function sseChatResponse(fragments: string[]): Response {
  const lines = fragments.map(
    (f) => `data: ${JSON.stringify({ choices: [{ delta: { content: f } }] })}\n\n`
  );
  lines.push('data: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function stubDiscoveryAndStream(fragments: string[]) {
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
      return sseChatResponse(fragments);
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ObserverService — token-level streaming (Ollama)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.OLLAMA_URL = OLLAMA_URL;
    delete process.env.OBSERVER_MODEL;
    delete process.env.OBSERVER_CLOUD_MODEL;
    delete process.env.OBSERVER_CLOUD_MODEL_FALLBACKS;
    delete process.env.OBSERVER_FAST_MODEL;
    __resetObserverBackendCacheForTests();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('delivers a milestone narration as MULTIPLE incremental SSE chunks, not one lump', async () => {
    const fragments = ['The analysts ', 'are comparing ', 'two approaches.'];
    stubDiscoveryAndStream(fragments);

    const observer = new ObserverService({ enabled: true, language: 'English' }, 'debate');
    observer.emit(makeEvent());
    await observer.flushPending(3000);

    const drained = observer.drainReadyNarrations();

    // Multiple chunks, not one lump.
    expect(drained.length).toBeGreaterThan(1);
    expect(drained.length).toBe(fragments.length);

    // Every drained chunk for a streamed narration is a partial fragment —
    // never the complete text delivered in one shot.
    for (const n of drained) {
      expect(n.partial).toBe(true);
      expect(n.narrationId).toBeTruthy();
    }

    // All fragments share the SAME narrationId (one underlying call).
    const ids = new Set(drained.map((n) => n.narrationId));
    expect(ids.size).toBe(1);

    // Concatenating the fragments IN ARRIVAL ORDER reconstructs the full text.
    const reconstructed = drained.map((n) => n.narration).join('');
    expect(reconstructed).toBe(fragments.join(''));

    // No redundant "lump" chunk was ALSO queued alongside the fragments.
    expect(drained.some((n) => n.narration === fragments.join(''))).toBe(false);

    // The FINAL/complete record — what feeds result.metadata.observer_narrations
    // — is unaffected by streaming: exactly one entry, complete text, no
    // partial flag, but the SAME narrationId as its fragments.
    const final = observer.getNarrations();
    expect(final).toHaveLength(1);
    expect(final[0].partial).toBeFalsy();
    expect(final[0].narration).toBe(fragments.join(''));
    expect(final[0].narrationId).toBe([...ids][0]);
  });

  it('wire shape: a partial fragment carries partial:true and narration_id, off-channel', async () => {
    stubDiscoveryAndStream(['Hello', ' world.']);

    const observer = new ObserverService({ enabled: true, language: 'English' }, 'debate');
    observer.emit(makeEvent());
    await observer.flushPending(3000);

    const [first] = observer.drainReadyNarrations();
    const chunk = buildObserverChunk(first) as unknown as {
      choices: Array<{ delta: { content?: string } }>;
      ailin_metadata: {
        type: string;
        partial?: boolean;
        narration_id?: string;
        narration: string;
      };
    };

    expect(chunk.choices[0].delta.content).toBe(''); // still off-channel
    expect(chunk.ailin_metadata.type).toBe('observer');
    expect(chunk.ailin_metadata.partial).toBe(true);
    expect(chunk.ailin_metadata.narration_id).toBeTruthy();
    expect(chunk.ailin_metadata.narration).toBe(first.narration);
  });

  it('falls back to a single complete chunk when the backend does not actually stream', async () => {
    // Same JSON-envelope shape the pre-existing (pre-streaming) observer
    // tests mock — proves this feature does not regress a backend/proxy that
    // ignores `stream: true` and returns the whole response in one shot.
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
          json: async () => ({ choices: [{ message: { content: 'narração completa' } }] }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const observer = new ObserverService({ enabled: true, language: 'Portuguese' }, 'debate');
    observer.emit(makeEvent());
    await observer.flushPending(3000);

    const drained = observer.drainReadyNarrations();
    // Exactly ONE chunk — the pre-streaming, single-lump behavior — since the
    // mocked backend produced no incremental fragments.
    expect(drained).toHaveLength(1);
    expect(drained[0].partial).toBeFalsy();
    expect(drained[0].narration).toBe('narração completa');

    const final = observer.getNarrations();
    expect(final).toHaveLength(1);
    expect(final[0].narration).toBe('narração completa');
  });

  it('OBSERVER_DEFAULT_ENABLED / enable_observer kill-switches still fully disable narration (streaming included)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // config.enabled:false is the concrete mechanism both the global
    // OBSERVER_DEFAULT_ENABLED kill-switch and the per-request
    // enable_observer:false opt-out resolve to (see orchestration-engine.ts's
    // wireObserverFeed()) — locking it here pins that the streaming addition
    // never touches the network path when disabled.
    const observer = new ObserverService({ enabled: false }, 'debate');
    observer.emit(makeEvent());
    await observer.flushPending(100);

    expect(observer.drainReadyNarrations()).toHaveLength(0);
    expect(observer.getNarrations()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
