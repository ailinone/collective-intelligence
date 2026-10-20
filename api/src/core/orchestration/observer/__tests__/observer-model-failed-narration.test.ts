// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ci#752 — the narrator's deterministic template for `model_failed`.
 *
 * A fan-out member failing is narrated from a synchronous template (no LLM,
 * no network), via ObserverService.emit()'s model_failed branch. Pins:
 *   - buildModelFailedNarration wording (en default / pt-BR mirror, with and
 *     without a remaining-participants count)
 *   - emit() routes model_failed to that template SYNCHRONOUSLY — the
 *     narration is readable with NO await and never touches fetch
 *   - other event types still take the async LLM path (no cross-contamination)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ObserverService, __resetObserverBackendCacheForTests } from '../observer-service';
import { buildModelFailedNarration } from '../observer-templates';
import type { ObserverEvent } from '@/types';

function modelFailedEvent(metadata?: Record<string, unknown>): ObserverEvent {
  return {
    type: 'model_failed',
    timestamp: Date.now(),
    strategy: 'consensus',
    modelId: 'voter-b',
    provider: 'prov-b',
    role: 'voter',
    errorCode: 'auth_failed',
    summary: 'A participant failed: HTTP 401 Unauthorized.',
    metadata,
  };
}

describe('buildModelFailedNarration (ci#752)', () => {
  it('defaults to English with no user sample', () => {
    const line = buildModelFailedNarration({});
    expect(line).toBe("One of the participants didn't respond; continuing with the others.");
  });

  it('counts the remaining participants when known', () => {
    const line = buildModelFailedNarration({ remaining: 2 });
    expect(line).toBe(
      "One of the participants didn't respond; continuing with 2 participants."
    );
  });

  it('singularizes "participant" when only one remains', () => {
    const line = buildModelFailedNarration({ remaining: 1 });
    expect(line).toContain('1 participant.');
    expect(line).not.toContain('1 participants');
  });

  it('mirrors pt-BR from the user sample (issue wording: "seguindo com N-1")', () => {
    const line = buildModelFailedNarration({ remaining: 2, userSample: 'Por que o céu é azul?' });
    expect(line).toBe('Um dos participantes não respondeu; seguindo com 2 participantes restantes.');
  });

  it('mirrors pt-BR without a count using "os demais"', () => {
    const line = buildModelFailedNarration({ userSample: 'não sei, você acha que vai funcionar?' });
    expect(line).toBe('Um dos participantes não respondeu; seguindo com os demais.');
  });
});

describe('ObserverService.emit — model_failed template routing (ci#752)', () => {
  beforeEach(() => {
    __resetObserverBackendCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.OLLAMA_URL;
  });

  it('narrates model_failed synchronously from the template — no fetch, no await', () => {
    // No fetch stub at all: if this path touched the network it would hang or
    // throw on the real `fetch`. It must not reach fetch at all.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const observer = new ObserverService({ enabled: true }, 'consensus');
    observer.emit(modelFailedEvent({ remaining: 2 }));

    // Deliberately NOT awaiting anything — an async/LLM-backed implementation
    // would still show an EMPTY queue here.
    const ready = observer.drainReadyNarrations();
    expect(ready).toHaveLength(1);
    expect(ready[0].narration).toBe(
      "One of the participants didn't respond; continuing with 2 participants."
    );
    expect(ready[0].durationMs).toBe(0);
    expect(ready[0].event.type).toBe('model_failed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('mirrors the user language via the injected language sample', () => {
    const observer = new ObserverService(
      { enabled: true, language: 'Por que o céu é azul?' },
      'consensus'
    );
    observer.emit(modelFailedEvent());
    const ready = observer.drainReadyNarrations();
    expect(ready).toHaveLength(1);
    expect(ready[0].narration).toBe('Um dos participantes não respondeu; seguindo com os demais.');
  });

  it('is a no-op when the observer is disabled', () => {
    const observer = new ObserverService({ enabled: false }, 'consensus');
    observer.emit(modelFailedEvent());
    expect(observer.drainReadyNarrations()).toHaveLength(0);
    expect(observer.getNarrations()).toHaveLength(0);
  });

  it('does NOT hijack other event types — phase_start still takes the async LLM path', async () => {
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
          json: async () => ({ choices: [{ message: { content: 'real narration' } }] }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.OLLAMA_URL = 'http://ollama-test:11434/v1';

    const observer = new ObserverService({ enabled: true }, 'consensus');
    observer.emit({ type: 'phase_start', timestamp: Date.now(), strategy: 'consensus', models: [] });

    // Nothing synchronously queued — the phase_start narration only lands
    // after the (mocked) LLM round-trip resolves.
    expect(observer.drainReadyNarrations()).toHaveLength(0);
    await observer.flushPending(3000);
    const all = observer.getNarrations();
    expect(all).toHaveLength(1);
    expect(all[0].narration).toBe('real narration');
  });
});
