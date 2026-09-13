// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GAP-A10 (LOTE AM, 2026-09-05) — declarative-ish inheritance for
 * plan/token-plan catalog rows via `deriveFromCatalogEntry()`.
 *
 * This is authoring-time-only sugar (a plain object spread run inside
 * providers.catalog.ts, before `PROVIDER_CATALOG` is exported) rather than a
 * runtime resolution mechanism — see the doc comment on the function and the
 * gap register entry for why a full runtime `basedOn` union type was
 * rejected (blast radius across ~9 other direct `PROVIDER_CATALOG`
 * consumers that assume a flat, fully-resolved `ProviderCatalogEntry[]`).
 *
 * These tests pin the ONLY two things that need pinning:
 *   1. the merge semantics of the helper itself (shallow spread — an
 *      override REPLACES the parent's value wholesale, it does not deep
 *      merge `supports`);
 *   2. the schema-level invariants added alongside it: every
 *      `baseUrlTemplateVars` placeholder must appear in `baseUrl`, and every
 *      `basedOn` must reference a real providerId in the same catalog.
 * The real catalog rows migrated to use it (alibaba-coding-cn,
 * minimax-token-plan-cn, stepfun-step-plan-cn) are already covered by the
 * whole-catalog Zod pass in provider-catalog.schema.test.ts — no separate
 * per-row test needed here.
 */

import { describe, expect, it } from 'vitest';
import { deriveFromCatalogEntry, type ProviderCatalogEntry } from '../provider-catalog.types';
import { ProviderCatalogEntrySchema, ProviderCatalogSchema } from '../provider-catalog.schema';

function parentEntry(overrides: Partial<ProviderCatalogEntry> = {}): ProviderCatalogEntry {
  return {
    providerId: 'stub-parent',
    displayName: 'Stub Parent',
    providerFamily: 'stub-parent',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.stub-parent.example/v1',
    apiKeyEnvVar: 'STUB_PARENT_API_KEY',
    supports: { chat: true, streaming: true, tools: true },
    pricingMode: 'none',
    enabledByDefault: true,
    priority: 30,
    ...overrides,
  };
}

describe('deriveFromCatalogEntry (GAP-A10)', () => {
  it('inherits every field not explicitly overridden', () => {
    const parent = parentEntry();
    const child = deriveFromCatalogEntry(parent, {
      providerId: 'stub-child',
      displayName: 'Stub Child',
      baseUrl: 'https://api.stub-child.example/v1',
      apiKeyEnvVar: 'STUB_CHILD_API_KEY',
    });

    expect(child.providerId).toBe('stub-child');
    expect(child.baseUrl).toBe('https://api.stub-child.example/v1');
    expect(child.apiKeyEnvVar).toBe('STUB_CHILD_API_KEY');
    // Inherited, untouched:
    expect(child.integrationClass).toBe(parent.integrationClass);
    expect(child.integrationMode).toBe(parent.integrationMode);
    expect(child.supports).toEqual(parent.supports);
    expect(child.pricingMode).toBe(parent.pricingMode);
    expect(child.priority).toBe(parent.priority);
  });

  it('stamps basedOn to the parent providerId automatically', () => {
    const parent = parentEntry();
    const child = deriveFromCatalogEntry(parent, {
      providerId: 'stub-child',
      displayName: 'Stub Child',
      baseUrl: 'https://api.stub-child.example/v1',
      apiKeyEnvVar: 'STUB_CHILD_API_KEY',
    });

    expect(child.basedOn).toBe('stub-parent');
  });

  it('an override REPLACES the parent value wholesale — no deep merge of `supports`', () => {
    const parent = parentEntry({ supports: { chat: true, streaming: true, tools: true, vision: true } });
    const child = deriveFromCatalogEntry(parent, {
      providerId: 'stub-child',
      displayName: 'Stub Child',
      baseUrl: 'https://api.stub-child.example/v1',
      apiKeyEnvVar: 'STUB_CHILD_API_KEY',
      // Deliberately narrower than the parent (the real stepfun-step-plan
      // pattern this mirrors: a plan bundles only a subset of the flagship
      // row's models/capabilities).
      supports: { chat: true, streaming: true },
    });

    expect(child.supports).toEqual({ chat: true, streaming: true });
    expect(child.supports.vision).toBeUndefined();
    // The parent itself must be untouched by deriving from it.
    expect(parent.supports.vision).toBe(true);
  });

  it('the resolved child entry passes ordinary Zod validation like any other row', () => {
    const parent = parentEntry();
    const child = deriveFromCatalogEntry(parent, {
      providerId: 'stub-child',
      displayName: 'Stub Child',
      baseUrl: 'https://api.stub-child.example/v1',
      apiKeyEnvVar: 'STUB_CHILD_API_KEY',
    });

    const result = ProviderCatalogEntrySchema.safeParse(child);
    expect(result.success).toBe(true);
  });
});

describe('basedOn schema invariant (GAP-A10)', () => {
  it('accepts a basedOn that references a real providerId in the same catalog', () => {
    const parent = parentEntry();
    const child = deriveFromCatalogEntry(parent, {
      providerId: 'stub-child',
      displayName: 'Stub Child',
      baseUrl: 'https://api.stub-child.example/v1',
      apiKeyEnvVar: 'STUB_CHILD_API_KEY',
    });

    const result = ProviderCatalogSchema.safeParse([parent, child]);
    expect(result.success).toBe(true);
  });

  it('rejects a basedOn that references a providerId absent from the catalog (stale/typo\'d parent)', () => {
    const orphan: ProviderCatalogEntry = {
      ...parentEntry(),
      providerId: 'stub-orphan',
      basedOn: 'stub-parent-that-was-renamed-away',
    };

    const result = ProviderCatalogSchema.safeParse([orphan]);
    expect(result.success).toBe(false);
  });
});

describe('baseUrlTemplateVars schema invariant (GAP-A11)', () => {
  it('accepts a placeholder that appears in baseUrl', () => {
    const entry = parentEntry({
      baseUrl: 'https://api.stub-parent.example/2/ai/{product_id}/v1',
      baseUrlTemplateVars: { product_id: 'STUB_PARENT_PRODUCT_ID' },
    });

    expect(ProviderCatalogEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('rejects a declared placeholder that never appears in baseUrl (stale/typo\'d declaration)', () => {
    const entry = parentEntry({
      baseUrl: 'https://api.stub-parent.example/v1', // no {product_id} anywhere
      baseUrlTemplateVars: { product_id: 'STUB_PARENT_PRODUCT_ID' },
    });

    const result = ProviderCatalogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });
});
