// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * catalog-provider-plugin — fetcher-skip regression tests.
 *
 * `execution-only` catalog rows with a populated `pinnedFallback` list
 * (azure-openai, inworld, aws-bedrock) serve `listModels()` entirely from
 * the catalog — the generic OAI-compat discovery fetcher is never consulted.
 * `initialize()` must not construct that fetcher for those rows: doing so
 * forces `mapAuthScheme()` to resolve an authScheme it has no representation
 * for (`custom`, `hmac-sigv4`, ...), which previously logged a misleading
 * "Unsupported authScheme for oai-compat bridge — falling back to Bearer"
 * warning on every boot even though the entry's DEDICATED adapter (built
 * separately, right below) has the correct auth contract the whole time.
 *
 * These tests assert the observable behavior: no fetcher is constructed
 * (`getFetcher()` returns undefined) and `listModels()` still resolves
 * correctly from `pinnedFallback` without ever touching the fetcher. A
 * sibling non-pinned entry proves the fetcher is still built when it's
 * actually needed — this is a skip, not a removal.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createCatalogProviderPlugin } from '../catalog-provider-plugin';
import {
  registerAdapterFactory,
  resetAdapterFactoryRegistryForTests,
  type AdapterFactory,
} from '../adapter-factory-registry';
import type { ProviderCatalogEntry } from '../provider-catalog.types';
import type { ProviderAdapter } from '../../base/provider-adapter';

function stubAdapter(): ProviderAdapter {
  return {
    healthCheck: async () => ({ healthy: true, checkedAt: new Date() }),
  } as unknown as ProviderAdapter;
}

function dedicatedEntry(overrides: Partial<ProviderCatalogEntry> = {}): ProviderCatalogEntry {
  return {
    providerId: 'stub-custom-auth',
    displayName: 'Stub Custom Auth',
    providerFamily: 'stub-custom-auth',
    integrationClass: 'oai-compat-quirks',
    integrationMode: 'execution-only',
    baseUrl: 'https://stub.example/v1',
    authScheme: 'custom',
    apiKeyEnvVar: 'STUB_CUSTOM_AUTH_API_KEY',
    adapterClass: 'StubCustomAuthAdapter',
    supports: { chat: true },
    pricingMode: 'none',
    enabledByDefault: true,
    pinnedFallback: {
      models: [{ id: 'stub-model-1', capabilities: ['chat'] }],
      reason: 'proprietary-schema',
      lastReviewedAt: '2026-07-29',
    },
    ...overrides,
  } as ProviderCatalogEntry;
}

describe('CatalogProviderPlugin — fetcher construction for pinnedFallback rows', () => {
  beforeEach(() => {
    resetAdapterFactoryRegistryForTests();
  });

  it('skips building the discovery fetcher for execution-only + pinnedFallback + dedicated-adapter rows', async () => {
    const factory: AdapterFactory = () => stubAdapter();
    registerAdapterFactory('StubCustomAuthAdapter', factory);

    const entry = dedicatedEntry();
    const plugin = createCatalogProviderPlugin(entry);

    await plugin.initialize({ apiKey: 'stub-key', baseURL: entry.baseUrl });

    // The dead fetcher must never be constructed — nothing consumes it for
    // this row, and building it just to compute a doomed authScheme mapping
    // was the source of the misleading boot-time warning.
    expect(plugin.getFetcher()).toBeUndefined();

    // listModels() must still resolve correctly, straight from the catalog's
    // pinnedFallback — no network fetcher involved.
    const models = await plugin.listModels();
    expect(models).toEqual([
      expect.objectContaining({ id: 'stub-model-1', capabilities: ['chat'] }),
    ]);
  });

  it('still builds the discovery fetcher when the row is NOT fully covered by pinnedFallback', async () => {
    const factory: AdapterFactory = () => stubAdapter();
    registerAdapterFactory('StubCustomAuthAdapter', factory);

    // Same dedicated-adapter + custom-authScheme shape, but no pinnedFallback
    // — listModels() must fall back to the fetcher, so it has to exist.
    const entry = dedicatedEntry({ pinnedFallback: undefined });
    const plugin = createCatalogProviderPlugin(entry);

    await plugin.initialize({ apiKey: 'stub-key', baseURL: entry.baseUrl });

    expect(plugin.getFetcher()).toBeDefined();
  });

  it('still builds the discovery fetcher for discovery+execution rows even with a dedicated adapter', async () => {
    const factory: AdapterFactory = () => stubAdapter();
    registerAdapterFactory('StubCustomAuthAdapter', factory);

    const entry = dedicatedEntry({
      integrationMode: 'discovery+execution',
      // pinnedFallback present but irrelevant here — only `execution-only`
      // rows can be fully served from it.
    });
    const plugin = createCatalogProviderPlugin(entry);

    await plugin.initialize({ apiKey: 'stub-key', baseURL: entry.baseUrl });

    expect(plugin.getFetcher()).toBeDefined();
  });
});
