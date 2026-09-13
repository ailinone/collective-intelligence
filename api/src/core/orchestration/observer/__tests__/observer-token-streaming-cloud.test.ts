// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Token-level streaming (2026-09 follow-up to PR #473) — cloud-fallback path.
 *
 * Mirrors observer-token-streaming.test.ts but exercises `callCloudAdapter()`,
 * which streams via the resolved `ProviderAdapter`'s own `chatCompletionStream`
 * (every adapter implements it — see provider-adapter.ts) instead of a direct
 * `fetch` to Ollama. Isolated into its own file because it mocks
 * `@/providers/provider-registry.js` at module scope (vi.mock is hoisted and
 * file-scoped), which the Ollama-path tests don't need.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ObserverService, __resetObserverBackendCacheForTests } from '../observer-service';
import type { ObserverEvent } from '@/types';

const CLOUD_MODEL_ID = 'cloud-narrator-v1';

vi.mock('@/providers/provider-registry.js', () => ({
  getProviderRegistry: () => ({
    findModelCached: async (id: string) => {
      if (id !== 'cloud-narrator-v1') return null;
      return {
        adapter: {
          getName: () => 'fake-cloud-adapter',
          // eslint-disable-next-line require-yield -- false positive: this generator does yield below
          chatCompletionStream: async function* () {
            yield { choices: [{ delta: { content: 'Cloud ' } }] };
            yield { choices: [{ delta: { content: 'streaming ' } }] };
            yield { choices: [{ delta: { content: 'narration.' } }] };
          },
        },
      };
    },
  }),
}));

function makeEvent(): ObserverEvent {
  return {
    type: 'phase_start',
    timestamp: Date.now(),
    strategy: 'debate',
    summary: 'Opening the debate',
    models: ['model-a', 'model-b'],
  };
}

describe('ObserverService — token-level streaming (cloud adapter fallback)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // No OLLAMA_URL — doResolveObserverBackend() skips straight to the cloud
    // fallback candidate list, resolving via the mocked provider-registry.
    delete process.env.OLLAMA_URL;
    process.env.OBSERVER_CLOUD_MODEL = CLOUD_MODEL_ID;
    delete process.env.OBSERVER_CLOUD_MODEL_FALLBACKS;
    delete process.env.OBSERVER_MODEL;
    delete process.env.OBSERVER_FAST_MODEL;
    __resetObserverBackendCacheForTests();
    // The cloud path never calls fetch directly — stub it to fail loudly if
    // something unexpectedly reaches the network.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('unexpected fetch call on the cloud-adapter streaming path');
      })
    );
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('delivers a milestone narration as multiple incremental fragments via the adapter stream', async () => {
    const observer = new ObserverService({ enabled: true, language: 'English' }, 'debate');
    observer.emit(makeEvent());
    await observer.flushPending(3000);

    const drained = observer.drainReadyNarrations();

    expect(drained.length).toBeGreaterThan(1);
    expect(drained.every((n) => n.partial === true)).toBe(true);
    const ids = new Set(drained.map((n) => n.narrationId));
    expect(ids.size).toBe(1);

    const reconstructed = drained.map((n) => n.narration).join('');
    expect(reconstructed).toBe('Cloud streaming narration.');
    // No redundant lump alongside the fragments.
    expect(drained.some((n) => n.narration === 'Cloud streaming narration.')).toBe(false);

    // Final complete record unaffected by streaming.
    const final = observer.getNarrations();
    expect(final).toHaveLength(1);
    expect(final[0].partial).toBeFalsy();
    expect(final[0].narration).toBe('Cloud streaming narration.');
  });
});
