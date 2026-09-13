// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GAP-A11 (LOTE AM, 2026-09-05) — generic `{placeholder}` base URL templating.
 *
 * Before this feature, a product/account/workspace-scoped baseUrl (the
 * Infomaniak case: `.../ai/{product_id}/openai/v1`) shipped the literal
 * `{product_id}` straight into every request unless the operator
 * reconstructed the ENTIRE url by hand via `baseUrlEnvVar`. These tests pin:
 *
 *   1. a declared placeholder resolves from its mapped env var;
 *   2. a missing env var fails LOUDLY at `initialize()` (fail-closed, same
 *      posture as a missing API key), never silently sends `{placeholder}`
 *      in the URL;
 *   3. `baseUrlEnvVar` (a full-string override) still wins over templating
 *      when both are set and the operator provides it — so the 175+
 *      existing rows using that convention are provably unaffected by this
 *      being purely additive.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCatalogProviderPlugin } from '../catalog-provider-plugin';
import {
  registerAdapterFactory,
  resetAdapterFactoryRegistryForTests,
  type AdapterFactory,
} from '../adapter-factory-registry';
import type { ProviderCatalogEntry } from '../provider-catalog.types';
import type { ProviderAdapter } from '../../base/provider-adapter';

const TEMPLATE_ENV_VAR = 'STUB_TEMPLATE_PRODUCT_ID';
const OVERRIDE_ENV_VAR = 'STUB_TEMPLATE_BASE_URL';

function stubAdapter(): ProviderAdapter {
  return {
    healthCheck: async () => ({ healthy: true, checkedAt: new Date() }),
  } as unknown as ProviderAdapter;
}

function templatedEntry(overrides: Partial<ProviderCatalogEntry> = {}): ProviderCatalogEntry {
  return {
    providerId: 'stub-template',
    displayName: 'Stub Template Provider',
    providerFamily: 'stub-template',
    integrationClass: 'oai-compat-pure',
    integrationMode: 'discovery+execution',
    baseUrl: 'https://api.stub-template.example/2/ai/{product_id}/openai/v1',
    baseUrlEnvVar: OVERRIDE_ENV_VAR,
    baseUrlTemplateVars: { product_id: TEMPLATE_ENV_VAR },
    apiKeyEnvVar: 'STUB_TEMPLATE_API_KEY',
    adapterClass: 'StubTemplateAdapter',
    supports: { chat: true },
    pricingMode: 'none',
    enabledByDefault: true,
    ...overrides,
  } as ProviderCatalogEntry;
}

describe('CatalogProviderPlugin — baseUrlTemplateVars (GAP-A11)', () => {
  let capturedBaseUrl: string | undefined;

  beforeEach(() => {
    resetAdapterFactoryRegistryForTests();
    capturedBaseUrl = undefined;
    delete process.env[TEMPLATE_ENV_VAR];
    delete process.env[OVERRIDE_ENV_VAR];
    const factory: AdapterFactory = (ctx) => {
      capturedBaseUrl = ctx.baseUrl;
      return stubAdapter();
    };
    registerAdapterFactory('StubTemplateAdapter', factory);
  });

  afterEach(() => {
    delete process.env[TEMPLATE_ENV_VAR];
    delete process.env[OVERRIDE_ENV_VAR];
  });

  it('substitutes {placeholder} from the mapped env var', async () => {
    process.env[TEMPLATE_ENV_VAR] = '42';
    const entry = templatedEntry();
    const plugin = createCatalogProviderPlugin(entry);

    await plugin.initialize({ apiKey: 'stub-key' });

    expect(capturedBaseUrl).toBe('https://api.stub-template.example/2/ai/42/openai/v1');
  });

  it('fails closed at initialize() when the template env var is missing — never ships the literal {placeholder}', async () => {
    const entry = templatedEntry();
    const plugin = createCatalogProviderPlugin(entry);

    await expect(plugin.initialize({ apiKey: 'stub-key' })).rejects.toThrow(
      /baseUrl template unresolved/
    );
    // The bad-but-silent alternative this test guards against: shipping the
    // literal placeholder straight into an HTTP request.
    expect(capturedBaseUrl).toBeUndefined();
  });

  it('baseUrlEnvVar (full-string override) wins over templating when both are set', async () => {
    process.env[TEMPLATE_ENV_VAR] = '42';
    process.env[OVERRIDE_ENV_VAR] = 'https://override.example/v1';
    const entry = templatedEntry();
    const plugin = createCatalogProviderPlugin(entry);

    await plugin.initialize({ apiKey: 'stub-key' });

    expect(capturedBaseUrl).toBe('https://override.example/v1');
  });

  it('is a no-op for rows that declare no baseUrlTemplateVars (the other 175+ rows)', async () => {
    const entry = templatedEntry({
      baseUrl: 'https://api.stub-plain.example/v1',
      baseUrlTemplateVars: undefined,
    });
    const plugin = createCatalogProviderPlugin(entry);

    await plugin.initialize({ apiKey: 'stub-key' });

    expect(capturedBaseUrl).toBe('https://api.stub-plain.example/v1');
  });
});
