// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ObserverService — dynamic Ollama model discovery.
 *
 * HARD RULE: no static/hardcoded/soft-pinned model. The narration model must be
 * DISCOVERED from the sidecar's OpenAI-compat GET /v1/models list; OBSERVER_MODEL
 * stays as an explicit operator override (precedence over discovery); when the
 * sidecar exposes no model, we must NOT synthesize a literal default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ObserverService, __resetObserverBackendCacheForTests } from '../observer-service';
import type { ObserverEvent } from '@/types';

const OLLAMA_URL = 'http://ollama-test:11434/v1';

function makeEvent(): ObserverEvent {
  return {
    type: 'phase_start',
    timestamp: 1,
    strategy: 'debate',
    summary: 'Selecting candidate models',
    models: ['model-a', 'model-b'],
  };
}

/** Serve /models discovery + /chat/completions narration. */
function stubFetch(discoveredId: string) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ object: 'list', data: [{ id: discoveredId }] }),
      } as unknown as Response;
    }
    if (url.endsWith('/chat/completions')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'narração ok' } }] }),
      } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Extract the `model` field of the /chat/completions request body. */
function narrationModelOf(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/chat/completions'));
  if (!call) return undefined;
  const init = call[1] as { body?: string } | undefined;
  return init?.body ? (JSON.parse(init.body) as { model?: string }).model : undefined;
}

describe('ObserverService — dynamic Ollama model discovery (no hardcoded pin)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.OLLAMA_URL = OLLAMA_URL;
    delete process.env.OBSERVER_MODEL;
    delete process.env.OBSERVER_CLOUD_MODEL;
    delete process.env.OBSERVER_CLOUD_MODEL_FALLBACKS;
    delete process.env.OBSERVER_FAST_MODEL;
    // The backend resolution is now cached at module scope; reset it so each test
    // resolves fresh against its own fetch stub (no cross-test leak).
    __resetObserverBackendCacheForTests();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('discovers the loaded model from /v1/models and narrates with it', async () => {
    const fetchMock = stubFetch('qwen2.5:1.5b');
    const observer = new ObserverService({ enabled: true, language: 'Portuguese' }, 'debate');
    observer.emit(makeEvent());
    await observer.flushPending(3000);

    // The discovery probe hit /models …
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/models'))).toBe(true);
    // … and the narration used the DISCOVERED id — never a code-side literal.
    expect(narrationModelOf(fetchMock)).toBe('qwen2.5:1.5b');
    expect(observer.getNarrations().length).toBeGreaterThan(0);
  });

  it('honors OBSERVER_MODEL as an explicit operator override over discovery', async () => {
    process.env.OBSERVER_MODEL = 'operator-choice:latest';
    const fetchMock = stubFetch('qwen2.5:1.5b');
    const observer = new ObserverService({ enabled: true, language: 'English' }, 'debate');
    observer.emit(makeEvent());
    await observer.flushPending(3000);

    expect(narrationModelOf(fetchMock)).toBe('operator-choice:latest');
  });

  it('does NOT synthesize a default when the sidecar exposes no model', async () => {
    // /models returns an empty list and no cloud fallback is configured →
    // the observer must deactivate (no-op), NOT fall back to a hardcoded model.
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ object: 'list', data: [] }) } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const observer = new ObserverService({ enabled: true, language: 'English' }, 'debate');
    observer.emit(makeEvent());
    await observer.flushPending(3000);

    expect(observer.isActive()).toBe(false);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/chat/completions'))).toBe(false);
    expect(observer.getNarrations().length).toBe(0);
  });

  it('resolves the backend ONCE and shares it across per-request instances (cache)', async () => {
    const fetchMock = stubFetch('qwen2.5:7b');
    const o1 = new ObserverService({ enabled: true, language: 'Portuguese' }, 'debate');
    o1.emit(makeEvent());
    await o1.flushPending(5000);
    // Second request/instance must NOT re-probe the sidecar — it reuses the cache.
    const o2 = new ObserverService({ enabled: true, language: 'English' }, 'consensus');
    o2.emit(makeEvent());
    await o2.flushPending(5000);

    const probeCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/models'));
    expect(probeCalls.length).toBe(1); // ONE probe despite two instances
    expect(o1.isActive()).toBe(true);
    expect(o2.isActive()).toBe(true);
  });

  it('prewarmBackend() resolves the shared cache so the next instance does not probe', async () => {
    const fetchMock = stubFetch('qwen2.5:7b');
    await ObserverService.prewarmBackend();
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/models')).length).toBe(1);
    // A request created after prewarm reuses the cache — still just one probe.
    const observer = new ObserverService({ enabled: true, language: 'Portuguese' }, 'debate');
    observer.emit(makeEvent());
    await observer.flushPending(5000);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/models')).length).toBe(1);
    expect(observer.isActive()).toBe(true);
  });

  it('uses OBSERVER_FAST_MODEL for the FIRST narration only, then the quality model', async () => {
    process.env.OBSERVER_MODEL = 'qwen2.5:7b';
    process.env.OBSERVER_FAST_MODEL = 'qwen2.5:1.5b';
    const fetchMock = stubFetch('qwen2.5:7b');
    const observer = new ObserverService({ enabled: true, language: 'Portuguese' }, 'debate');
    observer.emit(makeEvent());
    await observer.flushPending(5000);
    observer.emit(makeEvent());
    await observer.flushPending(5000);

    const chatModels = fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith('/chat/completions'))
      .map((c) => JSON.parse((c[1] as { body: string }).body).model as string);
    expect(chatModels[0]).toBe('qwen2.5:1.5b'); // first narration → fast opening model
    expect(chatModels[1]).toBe('qwen2.5:7b'); // subsequent → quality model
  });

  it('without OBSERVER_FAST_MODEL, the first narration uses the quality model', async () => {
    process.env.OBSERVER_MODEL = 'qwen2.5:7b';
    const fetchMock = stubFetch('qwen2.5:7b');
    const observer = new ObserverService({ enabled: true, language: 'Portuguese' }, 'debate');
    observer.emit(makeEvent());
    await observer.flushPending(5000);
    const first = fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith('/chat/completions'))
      .map((c) => JSON.parse((c[1] as { body: string }).body).model as string)[0];
    expect(first).toBe('qwen2.5:7b');
  });

  it('makes the FIRST narration a brief opening (short budget + brevity instruction), full budget after', async () => {
    process.env.OBSERVER_MODEL = 'qwen2.5:7b';
    const fetchMock = stubFetch('qwen2.5:7b');
    const observer = new ObserverService({ enabled: true, language: 'Portuguese' }, 'debate');
    observer.emit(makeEvent());
    await observer.flushPending(5000);
    observer.emit(makeEvent());
    await observer.flushPending(5000);

    const chatCalls = fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith('/chat/completions'))
      .map(
        (c) =>
          JSON.parse((c[1] as { body: string }).body) as {
            max_tokens: number;
            messages: Array<{ role: string; content: string }>;
          },
      );

    // First narration: a small budget sized to a single sentence …
    expect(chatCalls[0].max_tokens).toBe(80); // default OBSERVER_FIRST_MAX_TOKENS
    // … AND a brevity instruction so the model finishes WITHIN the budget (no mid-sentence
    // truncation — brevity by instruction, not a blind cut).
    const firstUser = chatCalls[0].messages.find((m) => m.role === 'user')?.content ?? '';
    expect(firstUser).toMatch(/OPENING line/i);
    // Subsequent narration: full budget and NO brevity instruction.
    expect(chatCalls[1].max_tokens).toBe(200);
    const secondUser = chatCalls[1].messages.find((m) => m.role === 'user')?.content ?? '';
    expect(secondUser).not.toMatch(/OPENING line/i);
  });

  it('self-heals a cached null backend on the short null-TTL once the sidecar returns', async () => {
    // A cached NULL (sidecar exposed no model) must NOT blind the narrator for the full
    // backend TTL. With the short null-TTL it re-probes aggressively and recovers as soon
    // as the sidecar is back — the fix for "a transient sidecar restart kills narration".
    process.env.OBSERVER_BACKEND_NULL_TTL_MS = '1'; // heal almost immediately in-test
    let hasModel = false;
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ object: 'list', data: hasModel ? [{ id: 'qwen2.5:7b' }] : [] }),
        } as unknown as Response;
      }
      if (url.endsWith('/chat/completions')) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    // 1) sidecar has no model → backend resolves null → observer inactive
    const o1 = new ObserverService({ enabled: true, language: 'Portuguese' }, 'debate');
    o1.emit(makeEvent());
    await o1.flushPending(3000);
    expect(o1.isActive()).toBe(false);

    // 2) sidecar returns; past the tiny null-TTL, the next request serves stale-null but
    //    triggers a background re-probe that heals the cache …
    hasModel = true;
    await new Promise((r) => setTimeout(r, 10));
    const o2 = new ObserverService({ enabled: true, language: 'Portuguese' }, 'debate');
    o2.emit(makeEvent());
    await o2.flushPending(3000);

    // 3) … so the following request sees the healed backend (within seconds, not 5min).
    await new Promise((r) => setTimeout(r, 10));
    const o3 = new ObserverService({ enabled: true, language: 'Portuguese' }, 'debate');
    o3.emit(makeEvent());
    await o3.flushPending(3000);
    expect(o3.isActive()).toBe(true);
  });
});
