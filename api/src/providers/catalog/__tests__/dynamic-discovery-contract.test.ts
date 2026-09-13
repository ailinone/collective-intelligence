// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Dynamic-discovery contract tests (SOTA §40/§41, 2026-09-03 LOTE AI).
 *
 * These tests prove the discovery pipeline is genuinely DYNAMIC — that
 * model IDs originate from upstream responses, not from any value typed
 * into source code. The methodology (mission §40):
 *
 *   Mock the upstream wire with RANDOM model ids
 *   (`model-id-generated-during-test-<random hex>`), run the real
 *   catalog-plugin → hub-fetcher pipeline, and assert the runtime
 *   materializes EXACTLY those random values.
 *
 * A hidden hardcoded inventory cannot pass this test: no fixture id in
 * this file exists anywhere in production source, and no commercial
 * model name is used — so nothing name-based can accidentally satisfy
 * the assertions. If someone reintroduces a static model array for one
 * of these providers, the random upstream id will not appear in
 * `listModels()` output and the test fails.
 *
 * Capability reactivity (§41) is proven the same way: the SAME random
 * model id is returned twice with DIFFERENT declared capability
 * metadata; the parsed profiles must differ accordingly — proving
 * capabilities derive from upstream metadata, not from model-name
 * inference (which would produce identical results for both).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { createCatalogProviderPlugin } from '../catalog-provider-plugin';
import { PROVIDER_CATALOG } from '../providers.catalog';
import { OpenAICompatibleHubModelFetcher } from '@/services/model-fetchers/openai-compatible-hub-model-fetcher';
import type { ProviderCatalogEntry } from '../provider-catalog.types';
import {
  resetAdapterFactoryRegistryForTests,
} from '../adapter-factory-registry';

function randomModelId(): string {
  return `model-id-generated-during-test-${randomBytes(6).toString('hex')}`;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const STUB_BASE = 'https://upstream-stub.invalid/v1';

/** Real LOTE AI catalog rows sampled across hosted integration classes. */
function loteAiEntries(): ProviderCatalogEntry[] {
  const wanted = ['abacus', 'clarifai', 'alibaba-coding', 'stepfun-step-plan'];
  return wanted
    .map((id) => PROVIDER_CATALOG.find((e) => e.providerId === id))
    .filter((e): e is ProviderCatalogEntry => Boolean(e));
}

describe('dynamic-discovery contract: random upstream ids materialize through the catalog plugin', () => {
  beforeEach(() => {
    resetAdapterFactoryRegistryForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sampled LOTE AI rows have no hidden inventory source (catalog sanity)', () => {
    const entries = loteAiEntries();
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.integrationMode).toBe('discovery+execution');
      expect((entry as { pinnedFallback?: unknown }).pinnedFallback).toBeUndefined();
      expect((entry as { staticModels?: unknown }).staticModels).toBeUndefined();
    }
  });

  it('listModels() returns exactly the random ids the upstream mock served', async () => {
    const entries = loteAiEntries();
    const randomIds = entries.map(() => randomModelId());

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    entries.forEach((_, i) => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ data: [{ id: randomIds[i], context_window: 8192 }] })
      );
    });

    for (let i = 0; i < entries.length; i += 1) {
      // Base URL overridden to a stub host — the wire never leaves the mock.
      const plugin = createCatalogProviderPlugin({
        ...entries[i],
        baseUrl: STUB_BASE,
      } as ProviderCatalogEntry);

      await plugin.initialize({ apiKey: `stub-key-${i}`, baseURL: STUB_BASE });
      expect(plugin.getFetcher()).toBeDefined();

      const models = await plugin.listModels();
      expect(models.map((m) => m.id)).toEqual([randomIds[i]]);
    }

    expect(fetchSpy).toHaveBeenCalledTimes(entries.length);
  });

  it('alternate `models[]` response shape also materializes random ids', async () => {
    const id = randomModelId();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ models: [{ id, context_window: 4096 }] })
    );

    const fetcher = new OpenAICompatibleHubModelFetcher({
      providerName: 'shape-variant-provider',
      apiKey: 'stub-key',
      baseUrl: STUB_BASE,
      modelListPaths: ['/models'],
    });

    const models = await fetcher.getModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe(id);
  });

  it('gateway rows preserve random original-provider attribution (no name allowlist)', async () => {
    const randomUpstream = `original-provider-${randomBytes(4).toString('hex')}`;
    const id = `${randomUpstream}/${randomModelId()}`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ data: [{ id, owned_by: randomUpstream }] })
    );

    const fetcher = new OpenAICompatibleHubModelFetcher({
      providerName: 'gateway-stub',
      apiKey: 'stub-key',
      baseUrl: STUB_BASE,
    });

    const models = await fetcher.getModels();
    expect(models[0].id).toBe(id);
    const metadata = (models[0].metadata ?? {}) as Record<string, unknown>;
    expect(metadata.executionProvider).toBe('gateway-stub');
    expect(metadata.originalProvider).toBe(randomUpstream);
  });
});

describe('dynamic-discovery contract: capability profiles react to upstream metadata (§41)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the same random id yields different capability metadata when the upstream declaration differs', async () => {
    const id = randomModelId();

    const serve = (declared: string[]) =>
      vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse({ data: [{ id, capabilities: declared }] })
        );

    serve(['tool_use', 'function_calling']);
    const fetcherA = new OpenAICompatibleHubModelFetcher({
      providerName: 'cap-variant-a',
      apiKey: 'stub-key',
      baseUrl: STUB_BASE,
    });
    const modelA = (await fetcherA.getModels())[0];

    serve(['vision', 'image_understanding']);
    const fetcherB = new OpenAICompatibleHubModelFetcher({
      providerName: 'cap-variant-b',
      apiKey: 'stub-key',
      baseUrl: STUB_BASE,
    });
    const modelB = (await fetcherB.getModels())[0];

    // Same id — identical inventory identity …
    expect(modelA.id).toBe(modelB.id);
    // … but the capability metadata MUST reflect the different upstream
    // declarations. Name-based inference would have produced the same
    // (wrong) profile for both.
    const metaA = (modelA.metadata ?? {}) as { capabilities?: string[] };
    const metaB = (modelB.metadata ?? {}) as { capabilities?: string[] };
    expect(metaA.capabilities).toContain('function_calling');
    expect(metaA.capabilities).not.toContain('vision');
    expect(metaB.capabilities).toContain('vision');
    expect(metaB.capabilities).not.toContain('function_calling');
  });

  it('declared vendor capability flags (serverless extension) drive inference', async () => {
    const id = randomModelId();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        data: [{ id, wafer: { capabilities: { tools: true, reasoning: true } } }],
      })
    );

    const fetcher = new OpenAICompatibleHubModelFetcher({
      providerName: 'vendor-ext-stub',
      apiKey: 'stub-key',
      baseUrl: STUB_BASE,
    });

    const model = (await fetcher.getModels())[0];
    const metadata = (model.metadata ?? {}) as { capabilities?: string[] };
    expect(metadata.capabilities).toContain('function_calling');
    expect(metadata.capabilities).toContain('reasoning');
  });

  it('supported_parameters metadata is preserved verbatim for downstream capability fusion', async () => {
    const id = randomModelId();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id,
            supported_parameters: ['tools', 'response_format', 'max_completion_tokens'],
          },
        ],
      })
    );

    const fetcher = new OpenAICompatibleHubModelFetcher({
      providerName: 'params-stub',
      apiKey: 'stub-key',
      baseUrl: STUB_BASE,
    });

    const model = (await fetcher.getModels())[0];
    const metadata = (model.metadata ?? {}) as {
      supported_parameters?: string[];
      uses_max_completion_tokens?: boolean;
    };
    expect(metadata.supported_parameters).toEqual([
      'tools',
      'response_format',
      'max_completion_tokens',
    ]);
    expect(metadata.uses_max_completion_tokens).toBe(true);
  });
});
