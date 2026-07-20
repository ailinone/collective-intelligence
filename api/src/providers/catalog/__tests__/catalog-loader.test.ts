// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Catalog loader behavior tests.
 *
 * We verify each branch of the loader's decision tree by feeding in a
 * synthetic catalog with known entries. The real `PROVIDER_CATALOG` is
 * NOT used here — that's covered by the schema test and by a separate
 * structural smoke assertion.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  loadProviderCatalog,
  resetCatalogLoaderForTests,
  getLastCatalogLoadSummary,
  type CatalogLoadEntryResult,
  type CatalogLoadSkipReason,
} from '../catalog-loader';
import type { ProviderCatalogEntry } from '../provider-catalog.types';

function makeEntry(
  overrides: Partial<ProviderCatalogEntry> = {},
): ProviderCatalogEntry {
  return {
    providerId: 'loader-test',
    displayName: 'Loader Test',
    providerFamily: 'loader-test',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://loader-test.example/v1',
    apiKeyEnvVar: 'LOADER_TEST_API_KEY',
    supports: { chat: true },
    pricingMode: 'none',
    enabledByDefault: true,
    ...overrides,
  };
}

function findResult(
  results: readonly CatalogLoadEntryResult[],
  providerId: string,
): CatalogLoadEntryResult {
  const match = results.find((r) => r.providerId === providerId);
  if (!match) {
    throw new Error(
      `test expected a result for providerId='${providerId}' — got [${results.map((r) => r.providerId).join(',')}]`,
    );
  }
  return match;
}

beforeEach(() => {
  resetCatalogLoaderForTests();
  // Scrub env vars that a previous test may have set globally.
  for (const key of Object.keys(process.env)) {
    if (key.endsWith('_API_KEY') && key.startsWith('LOADER_TEST')) {
      delete process.env[key];
    }
  }
});

describe('loadProviderCatalog — pre-flight filters', () => {
  it('skips entries with enabledByDefault=false (reason: disabled-by-default)', async () => {
    const summary = await loadProviderCatalog({
      catalog: [
        makeEntry({
          providerId: 'disabled-entry',
          apiKeyEnvVar: 'DISABLED_ENTRY_API_KEY',
          providerFamily: 'disabled-entry',
          enabledByDefault: false,
        }),
      ],
    });

    expect(summary.attempted).toBe(1);
    expect(summary.registered).toBe(0);
    expect(summary.skipped).toBe(1);
    const result = findResult(summary.results, 'disabled-entry');
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe<CatalogLoadSkipReason>('disabled-by-default');
  });

  it('skips entries with denyByDefault=true (reason: denied-by-default) even when enabled', async () => {
    const summary = await loadProviderCatalog({
      catalog: [
        makeEntry({
          providerId: 'denied-entry',
          apiKeyEnvVar: 'DENIED_ENTRY_API_KEY',
          providerFamily: 'denied-entry',
          enabledByDefault: true,
          denyByDefault: true,
        }),
      ],
    });

    const result = findResult(summary.results, 'denied-entry');
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe<CatalogLoadSkipReason>('denied-by-default');
  });

  it('skips catalog-only mode (reason: catalog-only-mode)', async () => {
    const summary = await loadProviderCatalog({
      catalog: [
        makeEntry({
          providerId: 'inventory-entry',
          apiKeyEnvVar: 'INVENTORY_ENTRY_API_KEY',
          providerFamily: 'inventory-entry',
          integrationMode: 'catalog-only',
        }),
      ],
    });

    const result = findResult(summary.results, 'inventory-entry');
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe<CatalogLoadSkipReason>('catalog-only-mode');
  });

  it('skips first-party-native entries (reason: unsupported-integration-class)', async () => {
    const summary = await loadProviderCatalog({
      catalog: [
        makeEntry({
          providerId: 'first-party-entry',
          apiKeyEnvVar: 'FIRST_PARTY_ENTRY_API_KEY',
          providerFamily: 'first-party-entry',
          integrationClass: 'first-party-native',
        }),
      ],
    });

    const result = findResult(summary.results, 'first-party-entry');
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe<CatalogLoadSkipReason>(
      'unsupported-integration-class',
    );
  });

  it('skips embeddings-only specialty class (reason: unsupported-integration-class)', async () => {
    const summary = await loadProviderCatalog({
      catalog: [
        makeEntry({
          providerId: 'specialty-embed',
          apiKeyEnvVar: 'SPECIALTY_EMBED_API_KEY',
          providerFamily: 'specialty-embed',
          integrationClass: 'embeddings-only',
          supports: { embeddings: true },
        }),
      ],
    });

    const result = findResult(summary.results, 'specialty-embed');
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe<CatalogLoadSkipReason>(
      'unsupported-integration-class',
    );
  });
});

describe('loadProviderCatalog — idempotency', () => {
  it('returns cached summary on second call without force', async () => {
    const entry = makeEntry({
      providerId: 'idem-test',
      apiKeyEnvVar: 'IDEM_TEST_API_KEY',
      providerFamily: 'idem-test',
      enabledByDefault: false, // fast skip path
    });

    const first = await loadProviderCatalog({ catalog: [entry] });
    const second = await loadProviderCatalog({ catalog: [entry] });

    // Second call should be a no-op returning the same summary reference.
    expect(second).toBe(first);
    expect(getLastCatalogLoadSummary()).toBe(first);
  });

  it('force: true re-runs the loader even after previous load', async () => {
    const firstEntry = makeEntry({
      providerId: 'force-test-a',
      apiKeyEnvVar: 'FORCE_TEST_A_API_KEY',
      providerFamily: 'force-test-a',
      enabledByDefault: false,
    });
    const secondEntry = makeEntry({
      providerId: 'force-test-b',
      apiKeyEnvVar: 'FORCE_TEST_B_API_KEY',
      providerFamily: 'force-test-b',
      enabledByDefault: false,
    });

    await loadProviderCatalog({ catalog: [firstEntry] });
    const second = await loadProviderCatalog({
      catalog: [secondEntry],
      force: true,
    });

    expect(second.attempted).toBe(1);
    expect(findResult(second.results, 'force-test-b').status).toBe('skipped');
  });
});

describe('loadProviderCatalog — empty / malformed inputs', () => {
  it('handles empty catalog gracefully', async () => {
    const summary = await loadProviderCatalog({ catalog: [] });
    expect(summary.attempted).toBe(0);
    expect(summary.registered).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('returns zero-count summary when Zod validation fails (does not throw)', async () => {
    const malformed = [
      {
        // missing required fields — Zod will reject
        providerId: 'bad-entry',
      } as unknown as ProviderCatalogEntry,
    ];

    const summary = await loadProviderCatalog({ catalog: malformed });
    expect(summary.attempted).toBe(0);
    expect(summary.registered).toBe(0);
  });
});

describe('loadProviderCatalog — reason count aggregation', () => {
  it('aggregates skip reasons across multiple entries', async () => {
    const summary = await loadProviderCatalog({
      catalog: [
        makeEntry({
          providerId: 'mixed-a',
          apiKeyEnvVar: 'MIXED_A_API_KEY',
          providerFamily: 'mixed-a',
          enabledByDefault: false,
        }),
        makeEntry({
          providerId: 'mixed-b',
          apiKeyEnvVar: 'MIXED_B_API_KEY',
          providerFamily: 'mixed-b',
          enabledByDefault: false,
        }),
        makeEntry({
          providerId: 'mixed-c',
          apiKeyEnvVar: 'MIXED_C_API_KEY',
          providerFamily: 'mixed-c',
          integrationClass: 'first-party-native',
        }),
        makeEntry({
          providerId: 'mixed-d',
          apiKeyEnvVar: 'MIXED_D_API_KEY',
          providerFamily: 'mixed-d',
          integrationMode: 'catalog-only',
        }),
      ],
    });

    expect(summary.reasonCounts['disabled-by-default']).toBe(2);
    expect(summary.reasonCounts['unsupported-integration-class']).toBe(1);
    expect(summary.reasonCounts['catalog-only-mode']).toBe(1);
  });
});

describe('loadProviderCatalog — real PROVIDER_CATALOG structural smoke', () => {
  it('loads the real catalog without throwing and summary is well-formed', async () => {
    // No env vars set — this proves the loader survives a cold environment.
    // We expect EVERY entry to either skip (disabled/catalog-only/specialty)
    // or fail (missing-api-key). The key invariant: no crashes, summary
    // fields add up.
    const summary = await loadProviderCatalog({ force: true });

    expect(summary.attempted).toBeGreaterThan(0);
    expect(summary.registered + summary.skipped + summary.failed).toBe(
      summary.attempted,
    );
    expect(summary.results).toHaveLength(summary.attempted);

    // In a completely keyless env, we expect registered=0.
    expect(summary.registered).toBe(0);
  });
});
