// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression: cartesia discovery migrated to execution-only + pinnedFallback
 * (2026-09-12).
 *
 * ## History
 *
 * This file used to guard the `cartesia-audio` hardcoded discovery source's
 * wire shape. That source itself was already a fix for an earlier bug: the
 * 2026-09-10 discovery audit (PR #564) found the original `GET /models` call
 * 404s live in production (Cartesia has never exposed that path) and
 * switched the fetcher to `GET /voices` instead.
 *
 * That fix was itself wrong in a subtler way: a VOICE (a persona with a
 * UUID and a display name like "Skylar - Friendly Guide") is a DIFFERENT
 * resource type from a TTS MODEL (`sonic-3`, `sonic-3.5`, ...) — the
 * `cartesia-audio` fetcher was fabricating fake "model" rows out of voice
 * personas. Re-verified 2026-09-12 against Cartesia's own docs
 * (docs.cartesia.ai/api-reference/tts/bytes) and the current cartesia-js
 * SDK (GitHub file-tree check): there is no model-listing endpoint on
 * either surface. `cartesia` is now `execution-only` with a curated
 * `pinnedFallback` in `providers.catalog.ts` (same pattern as `topaz`/`v0`)
 * — see that catalog entry's comment for the full sourcing citation.
 *
 * This file now guards two things:
 *   1. The old `cartesia-audio` hardcoded source is gone for good (a
 *      regression here would silently reintroduce the voices-as-models bug).
 *   2. The catalog row is shaped correctly for the generic catalog-bridge
 *      (`addCatalogProviderSources()`) to serve `cartesia`'s inventory
 *      without ever touching the network.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CentralModelDiscoveryService,
  type DiscoverySource,
} from '@/services/central-model-discovery-service';
import { PROVIDER_CATALOG } from '@/providers/catalog/providers.catalog';

type Internals = {
  addNativeAPISources: () => Promise<void>;
  addCatalogProviderSources: () => Promise<void>;
  discoverySources: Map<string, DiscoverySource>;
};

describe('central-model-discovery-service: cartesia-audio hardcoded source removed', () => {
  it('addNativeAPISources() no longer registers a `cartesia-audio` source', async () => {
    const service = new CentralModelDiscoveryService();
    const internals = service as unknown as Internals;
    await internals.addNativeAPISources();

    expect(internals.discoverySources.has('cartesia-audio')).toBe(false);
  });
});

describe('providers.catalog: cartesia execution-only + pinnedFallback row', () => {
  const entry = PROVIDER_CATALOG.find((e) => e.providerId === 'cartesia');

  it('exists, is speech-only + execution-only, with CartesiaAdapter wired', () => {
    expect(entry).toBeDefined();
    expect(entry?.integrationClass).toBe('speech-only');
    expect(entry?.integrationMode).toBe('execution-only');
    expect(entry?.adapterClass).toBe('CartesiaAdapter');
    expect(entry?.apiKeyEnvVar).toBe('CARTESIA_API_KEY');
  });

  it('pinnedFallback declares reason `no-list-endpoint` with operator-declared capabilities', () => {
    expect(entry?.pinnedFallback?.reason).toBe('no-list-endpoint');
    const models = entry?.pinnedFallback?.models ?? [];
    expect(models.length).toBeGreaterThan(0);
    const ids = models.map((m) => (typeof m === 'string' ? m : m.id)).sort();
    expect(ids).toEqual(['sonic-3', 'sonic-3.5', 'sonic-3.6']);
    for (const m of models) {
      expect(typeof m).not.toBe('string'); // structured form only, no bare-string entries
      if (typeof m !== 'string') {
        expect(m.capabilities).toContain('text_to_speech');
      }
    }
  });

  it('never claims chat/tools (Rule 4: specialty classes cannot)', () => {
    expect(entry?.supports.chat).toBeUndefined();
    expect(entry?.supports.tools).toBeUndefined();
    expect(entry?.supports.textToSpeech).toBe(true);
  });
});

describe('central-model-discovery-service: catalog-bridge serves cartesia without a network call', () => {
  it('addCatalogProviderSources() registers `catalog-cartesia` and its fetcher emits the pinned models with zero fetch calls', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    try {
      const service = new CentralModelDiscoveryService();
      const internals = service as unknown as Internals;
      await internals.addNativeAPISources();
      await internals.addCatalogProviderSources();

      const source = internals.discoverySources.get('catalog-cartesia');
      expect(source).toBeDefined();
      if (!source) return;

      const models = await source.fetcher();
      expect(fetchSpy).not.toHaveBeenCalled();

      const ids = models.map((m) => m.id).sort();
      expect(ids).toEqual(['sonic-3', 'sonic-3.5', 'sonic-3.6']);
      for (const m of models) {
        expect(m.capabilities).toContain('text_to_speech');
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
