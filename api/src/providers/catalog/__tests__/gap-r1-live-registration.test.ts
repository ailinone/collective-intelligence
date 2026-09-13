// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GAP-R1 live-registration regression coverage (Phase 0 refresh, 2026-09-08).
 *
 * ## Why this test exists
 *
 * `reports/provider-integration-gap-register.json` (GAP-R1) and
 * `api/docs/provider-runtime-matrix.csv` document a per-row classification
 * for 16 previously-red rows, built from a MANUAL, out-of-band re-run of
 * `loadProviderCatalog()` + `registerPlugin()` during LOTE AL (2026-09-04,
 * commit 8f4cf393) and LOTE AR (2026-09-06, commit c605ce54). Neither session
 * left behind a live, in-suite regression test that actually drives the real
 * loader end-to-end and asserts on registration outcomes — only catalog-data
 * assertions (`default-adapter-factories-apikeyoptional.test.ts`,
 * `lote-ar-closure.test.ts`) exist. This test closes that gap.
 *
 * It also fixes a real blind spot found while re-verifying GAP-R1 fresh
 * (Phase 0, 2026-09-08): `catalog-loader.test.ts`'s own "real
 * PROVIDER_CATALOG structural smoke" test calls `loadProviderCatalog()`
 * WITHOUT first calling `initializeProviderRegistry()` + `setProviderRegistry()`
 * (the real boot order in `src/index.ts`). Because Vitest isolates each test
 * file's module registry, the global provider-registry singleton is never
 * initialized in that file's scope, so EVERY entry that reaches
 * `registry.register()` — including the three `apiKeyOptional: true` rows
 * (mancer, xinference, triton) — throws "Provider registry not initialized"
 * before that call is ever reached, is caught, and is classified `failed`
 * with reason `init-error`. The test's `expect(summary.registered).toBe(0)`
 * assertion is coincidentally still true, but for the wrong reason: it would
 * pass identically whether the `apiKeyOptional` propagation bug (see
 * `default-adapter-factories-apikeyoptional.test.ts`) existed or not, and
 * therefore gives ZERO signal on whether credential-optional providers
 * actually reach a live `registered` state. This test replicates the real
 * boot order so that signal exists.
 *
 * `AZURE_OPENAI_API_KEY` is explicitly cleared for the duration of this test
 * — `tests/test-env.ts` sets a mock value for it globally (needed by other,
 * unrelated suites), which would make azure-openai register here instead of
 * reproducing the genuinely-credential-less environment GAP-R1's evidence
 * was captured in. Every other GAP-R1 candidate env var is confirmed absent
 * from `tests/test-env.ts`'s mock-key list.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProviderCatalog } from '../catalog-loader';
import { initializeProviderRegistry, setProviderRegistry } from '../../provider-registry';
import type { CatalogLoadEntryResult } from '../catalog-loader';

// The 16 rows GAP-R1 tracks in provider-runtime-matrix.csv / the gap register.
const APIKEY_OPTIONAL_ROWS = ['mancer', 'xinference', 'triton'];
const CREDENTIAL_GATED_ROWS = [
  'anyscale',
  'featherless-ai',
  'inworld',
  'azure-openai',
  'gemini-openai',
  'cloudflare-workers-ai',
  'nebius',
  'lambda-ai',
  'scaleway',
  'morph',
  'volcano',
  'qianfan',
  'venice',
];
const GAP_R1_IDS = [...APIKEY_OPTIONAL_ROWS, ...CREDENTIAL_GATED_ROWS];

describe('GAP-R1 live registration (real loadProviderCatalog + registry boot order)', () => {
  const savedAzureKey = process.env.AZURE_OPENAI_API_KEY;
  let results: Map<string, CatalogLoadEntryResult>;

  beforeEach(async () => {
    // Reproduce the genuinely-credential-less environment GAP-R1's evidence
    // was captured in — tests/test-env.ts mocks this one globally.
    delete process.env.AZURE_OPENAI_API_KEY;

    const registry = await initializeProviderRegistry([]);
    setProviderRegistry(registry);

    const summary = await loadProviderCatalog({ force: true });
    results = new Map(summary.results.map((r) => [r.providerId, r]));
  });

  afterEach(() => {
    if (savedAzureKey === undefined) {
      delete process.env.AZURE_OPENAI_API_KEY;
    } else {
      process.env.AZURE_OPENAI_API_KEY = savedAzureKey;
    }
  });

  it('covers all 16 GAP-R1 rows in the real catalog', () => {
    for (const id of GAP_R1_IDS) {
      expect(results.has(id), `expected '${id}' in loadProviderCatalog results`).toBe(true);
    }
  });

  it('mancer, xinference and triton reach a live "registered" state with zero credentials', () => {
    for (const id of APIKEY_OPTIONAL_ROWS) {
      const result = results.get(id);
      expect(result?.status, `${id}: ${JSON.stringify(result)}`).toBe('registered');
    }
  });

  it('the remaining 13 GAP-R1 rows still fail for the documented reason (missing-api-key), not a new regression', () => {
    for (const id of CREDENTIAL_GATED_ROWS) {
      const result = results.get(id);
      expect(result?.status, `${id}: ${JSON.stringify(result)}`).toBe('failed');
      expect(
        result?.reason,
        `${id} failed for an unexpected reason: ${JSON.stringify(result)}`
      ).toBe('missing-api-key');
    }
  });
});
