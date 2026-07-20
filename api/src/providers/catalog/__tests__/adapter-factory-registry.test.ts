// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * adapter-factory-registry — contract tests.
 *
 * The registry is the single point where `adapterClass` strings in the catalog
 * resolve to concrete constructors. These tests prove:
 *   - registration + resolution basics
 *   - idempotency (duplicate registrations are logged-and-ignored, not thrown)
 *   - test reset restores a pristine registry for subsequent suites
 *   - the loader-driven registration (`registerDefaultAdapterFactories`)
 *     keeps the original Batch-1 factories registered and accumulates new
 *     ones across subsequent batches (subset check — not an exact list).
 *
 * HTTP behavior of individual adapters lives in per-adapter test files; this
 * file stays narrowly about the registry's dispatch contract.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  registerAdapterFactory,
  resolveAdapterFactory,
  resetAdapterFactoryRegistryForTests,
  getRegisteredAdapterClassesForTests,
  type AdapterFactory,
  type AdapterFactoryContext,
} from '../adapter-factory-registry';
import { registerDefaultAdapterFactories } from '../default-adapter-factories';
import { isOpenAICompatibleEntry, type ProviderCatalogEntry } from '../provider-catalog.types';
import { PROVIDER_CATALOG } from '../providers.catalog';

/**
 * Phase 3A coverage invariant — every catalog entry the runtime will attempt
 * to instantiate (i.e. integrationMode !== 'catalog-only') MUST resolve to:
 *   - a registered AdapterFactory (via `resolveAdapterFactory(adapterClass)`), OR
 *   - the OAI-compat fallback path (`isOpenAICompatibleEntry(entry) === true`).
 *
 * Anything else is a structural gap: the catalog row would throw
 * `CatalogPluginUnsupportedError` at boot and silently fall into the loader's
 * `unsupported-integration-class` skip taxonomy — provider becomes invisible.
 *
 * The `PHASE_3A_KNOWN_GAPS` map below is a TRANSITIONAL allow-list. Each entry
 * names a row Phase 4 must drain to zero. Don't add to this map without filing
 * the corresponding Phase-4 obligation.
 */
const PHASE_3A_KNOWN_GAPS: Readonly<Record<string, string>> = {
  bfl: 'image-only adapter not yet built; Phase 4 migrates to pinnedFallback + catalog-only OR adds BflAdapter',
};

function stubEntry(overrides: Partial<ProviderCatalogEntry> = {}): ProviderCatalogEntry {
  return {
    providerId: 'stub',
    displayName: 'Stub',
    providerFamily: 'stub',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://stub.example/v1',
    apiKeyEnvVar: 'STUB_API_KEY',
    supports: { chat: true },
    pricingMode: 'none',
    enabledByDefault: true,
    ...overrides,
  };
}

function stubCtx(): AdapterFactoryContext {
  return {
    entry: stubEntry(),
    apiKey: 'stub-key',
    baseUrl: 'https://stub.example/v1',
  };
}

describe('adapter-factory-registry', () => {
  beforeEach(() => {
    resetAdapterFactoryRegistryForTests();
  });

  it('returns undefined when adapterClass is undefined or unknown', () => {
    expect(resolveAdapterFactory(undefined)).toBeUndefined();
    expect(resolveAdapterFactory('NotRegisteredAdapter')).toBeUndefined();
  });

  it('registers and resolves a factory by name', () => {
    const marker = Symbol('stub-adapter');
    const factory: AdapterFactory = () => ({ marker } as unknown as ReturnType<AdapterFactory>);

    registerAdapterFactory('StubAdapter', factory);

    const resolved = resolveAdapterFactory('StubAdapter');
    expect(resolved).toBe(factory);

    const built = resolved!(stubCtx()) as unknown as { marker: symbol };
    expect(built.marker).toBe(marker);
  });

  it('is idempotent — duplicate registration keeps the FIRST factory', () => {
    const first: AdapterFactory = () => ({ which: 'first' } as unknown as ReturnType<AdapterFactory>);
    const second: AdapterFactory = () => ({ which: 'second' } as unknown as ReturnType<AdapterFactory>);

    registerAdapterFactory('DupAdapter', first);
    registerAdapterFactory('DupAdapter', second); // logged-and-ignored

    const resolved = resolveAdapterFactory('DupAdapter')!;
    expect((resolved(stubCtx()) as unknown as { which: string }).which).toBe('first');
  });

  it('resetAdapterFactoryRegistryForTests clears all registrations', () => {
    registerAdapterFactory('A', () => ({}) as unknown as ReturnType<AdapterFactory>);
    registerAdapterFactory('B', () => ({}) as unknown as ReturnType<AdapterFactory>);
    expect(getRegisteredAdapterClassesForTests()).toEqual(['A', 'B']);

    resetAdapterFactoryRegistryForTests();
    expect(getRegisteredAdapterClassesForTests()).toEqual([]);
  });

  it('registerDefaultAdapterFactories keeps Batch-1 classes registered (subset check)', () => {
    registerDefaultAdapterFactories();

    const registered = getRegisteredAdapterClassesForTests();
    // Subset assertion: the Batch-1 set MUST always be present. Later batches
    // add more; we deliberately don't compare to an exhaustive list so each
    // new batch doesn't churn this test. The sibling test below checks that
    // specific post-Batch-1 additions are discoverable via the registry.
    const batch1 = [
      'CerebrasAdapter',
      'GroqAdapter',
      'PerplexityAdapter',
      'SambanovaAdapter',
      'VercelAIGatewayAdapter',
      'VolcanoAdapter',
      'VoyageAdapter',
      'WatsonxAdapter',
    ];
    expect(registered).toEqual(expect.arrayContaining(batch1));
  });

  it('registerDefaultAdapterFactories includes post-Batch-1 additions (FeatherlessAdapter sentinel)', () => {
    registerDefaultAdapterFactories();

    const registered = getRegisteredAdapterClassesForTests();
    // FeatherlessAdapter is the most recently added (Lot A). If this sentinel
    // ever regresses, the default-adapter-factories.ts registration block lost
    // an entry and the catalog's `adapterClass: 'FeatherlessAdapter'` would
    // silently fall back to the generic hub, burying provider observability.
    expect(registered).toContain('FeatherlessAdapter');
  });

  it('registerDefaultAdapterFactories is safe to call twice', () => {
    registerDefaultAdapterFactories();
    const first = getRegisteredAdapterClassesForTests();
    registerDefaultAdapterFactories();
    const second = getRegisteredAdapterClassesForTests();

    expect(second).toEqual(first);
  });

  it('every non-catalog-only catalog providerId resolves to a factory or OAI-compat fallback', () => {
    registerDefaultAdapterFactories();

    const unresolved: Array<{ providerId: string; reason: string }> = [];

    for (const entry of PROVIDER_CATALOG) {
      // catalog-only rows are routing-table metadata; the runtime never
      // tries to instantiate a plugin for them, so coverage doesn't apply.
      if (entry.integrationMode === 'catalog-only') continue;

      const dedicatedFactory = entry.adapterClass
        ? resolveAdapterFactory(entry.adapterClass)
        : undefined;
      const isOaiCompat = isOpenAICompatibleEntry(entry);

      if (!dedicatedFactory && !isOaiCompat) {
        if (entry.providerId in PHASE_3A_KNOWN_GAPS) continue;

        const reason = entry.adapterClass
          ? `adapterClass='${entry.adapterClass}' has no registered factory and integrationClass='${entry.integrationClass}' is not OAI-compatible`
          : `no adapterClass set and integrationClass='${entry.integrationClass}' is not OAI-compatible`;
        unresolved.push({ providerId: entry.providerId, reason });
      }
    }

    expect(
      unresolved,
      `Catalog rows that would throw CatalogPluginUnsupportedError at boot:\n` +
        unresolved.map((u) => `  - ${u.providerId}: ${u.reason}`).join('\n') +
        `\n\nFix: register the adapter factory in default-adapter-factories.ts, ` +
        `flip integrationMode to 'catalog-only', or add to PHASE_3A_KNOWN_GAPS ` +
        `with an explicit Phase-4 obligation.`,
    ).toEqual([]);
  });
});
