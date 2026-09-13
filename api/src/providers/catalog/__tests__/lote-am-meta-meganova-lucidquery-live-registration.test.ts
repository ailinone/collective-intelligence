// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LOTE AM (2026-09-08) live-registration regression coverage.
 *
 * ## Why this test exists
 *
 * The operator confirmed three more GCP secrets are populated with real
 * credential values: `<prefix>-meta-key`, `<prefix>-meganova-key`,
 * `<prefix>-lucidquery-key` (verified via `gcloud secrets describe` +
 * `gcloud secrets versions list` — each has exactly one ENABLED version,
 * created 2026-09-08).
 *
 * Investigation found:
 *
 *   - `meganova` and `lucidquery` already had complete catalog rows
 *     (LOTE AI, 2026-09-03) AND complete `load-secrets-into-env.ts` wiring
 *     (`PROVIDER_SECRETS` / `ENV_VAR_TO_PROVIDER` / `LLM_PROVIDER_ENV_VARS`)
 *     whose secret candidates (`meganova-key`, `lucidquery-key`) already
 *     match the real GCP secret names exactly. No code gap — they were
 *     blocked purely on `credentials-missing`, which is now resolved.
 *
 *   - `meta` is NOT a standalone provider. LOTE AK (2026-09-04) absorbed a
 *     duplicate `meta` catalog row into `llama` (`providers.catalog.ts`
 *     providerId 'llama': `aliases: ['llama-api', 'meta', 'meta-ai']`,
 *     `apiKeyEnvVar: 'LLAMA_API_KEY'`) because the old `meta` row pointed at
 *     llama.developer.meta.com — the docs/console host, which 302-redirects
 *     every path (including /v1/models) to ai.developer.meta.com — while
 *     `llama`'s api.llama.com/compat/v1 is the real, auth-gated API host.
 *     THAT merge was catalog-only: it never added `meta-key` to
 *     `LLAMA_API_KEY`'s secretKeys candidates in `load-secrets-into-env.ts`,
 *     which only listed `llama-key` / `llama-api-key`. Since the operator
 *     provisioned the credential under `<prefix>-meta-key` (confirmed absent
 *     under `<prefix>-llama-key`), that populated secret would never have
 *     reached `process.env.LLAMA_API_KEY` without this lot's fix. See
 *     `load-secrets-meta-llama-alias.test.ts` for the focused unit test on
 *     that resolution path.
 *
 * This file proves the end state with the REAL boot order
 * (`initializeProviderRegistry` + `setProviderRegistry` +
 * `loadProviderCatalog`), mirroring `gap-r1-live-registration.test.ts`'s
 * harness: once the relevant `*_API_KEY` env var is populated (as it will
 * be in production once `loadSecretsIntoEnv()` resolves the now-provisioned
 * GCP secret), each of the three rows reaches a live `registered` state in
 * the catalog loader, and reaches `missing-api-key` (not some other failure
 * reason) when the credential is absent — proving the credential was the
 * ONLY blocker, not some other catalog defect.
 *
 * Unlike `gap-r1-live-registration.test.ts`, this file boots
 * `loadProviderCatalog({ catalog: <3-row subset>, force: true })` instead of
 * the full ~200-row `PROVIDER_CATALOG`. `loadProviderCatalog`'s `catalog`
 * option exists exactly for this ("Override the static catalog. Primarily
 * for tests"). Registration is not gated on the boot-time health probe
 * succeeding (`provider-plugin-system.ts` registers regardless of health —
 * "register first, mark health observably, retry on use"), but the probe
 * itself is a REAL network fetch with a 5s-per-candidate-path timeout; when
 * llama's real, reachable api.llama.com host was probed as part of a
 * full-catalog boot (~200 sequential entries, several of them real,
 * reachable hosts) in a sandboxed test run, the cumulative wall-clock time
 * exceeded both the default hook (10s) and test (30s) timeouts. Scoping the
 * boot to just the 3 rows under test keeps this fast and deterministic
 * while exercising the exact same Zod-validate → construct-plugin →
 * registerPlugin path as a full boot.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProviderCatalog } from '../catalog-loader';
import { PROVIDER_CATALOG } from '../providers.catalog';
import { initializeProviderRegistry, setProviderRegistry } from '../../provider-registry';
import type { CatalogLoadEntryResult } from '../catalog-loader';

const TARGET_ENV_VARS = ['LLAMA_API_KEY', 'MEGANOVA_API_KEY', 'LUCIDQUERY_API_KEY'] as const;
// providerId 'llama' also answers for the 'meta' alias absorbed in LOTE AK —
// the catalog loader's results are keyed by canonical providerId, not alias.
const TARGET_PROVIDER_IDS = ['llama', 'meganova', 'lucidquery'] as const;

const TARGET_CATALOG_SUBSET = PROVIDER_CATALOG.filter((e) =>
  (TARGET_PROVIDER_IDS as readonly string[]).includes(e.providerId)
);

async function bootCatalog(): Promise<Map<string, CatalogLoadEntryResult>> {
  const registry = await initializeProviderRegistry([]);
  setProviderRegistry(registry);
  const summary = await loadProviderCatalog({ catalog: TARGET_CATALOG_SUBSET, force: true });
  return new Map(summary.results.map((r) => [r.providerId, r]));
}

describe('LOTE AM live registration — meta(llama)/meganova/lucidquery', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const v of TARGET_ENV_VARS) {
      saved.set(v, process.env[v]);
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of TARGET_ENV_VARS) {
      const prev = saved.get(v);
      if (prev === undefined) delete process.env[v];
      else process.env[v] = prev;
    }
  });

  describe('zero credentials', () => {
    let results: Map<string, CatalogLoadEntryResult>;

    beforeEach(async () => {
      results = await bootCatalog();
    }, 20_000);

    it('all three target rows are present in the real catalog', () => {
      // Sanity floor: if a providerId typo or catalog rename ever silently
      // shrinks TARGET_CATALOG_SUBSET, every assertion below would trivially
      // pass over zero real rows. Pin the exact count instead.
      expect(TARGET_CATALOG_SUBSET.length).toBe(TARGET_PROVIDER_IDS.length);
      for (const id of TARGET_PROVIDER_IDS) {
        expect(results.has(id), `expected '${id}' in loadProviderCatalog results`).toBe(true);
      }
    });

    it('fail for the documented reason (missing-api-key) — proving the credential was the only blocker', () => {
      for (const id of TARGET_PROVIDER_IDS) {
        const result = results.get(id);
        expect(result?.status, `${id}: ${JSON.stringify(result)}`).toBe('failed');
        expect(
          result?.reason,
          `${id} failed for an unexpected reason: ${JSON.stringify(result)}`
        ).toBe('missing-api-key');
      }
    });
  });

  // The remaining tests exercise real registerPlugin() calls, which run a
  // real (non-gating, per provider-plugin-system.ts) health-check fetch
  // against the provider's live host. Registration succeeds or fails purely
  // on API-key presence, independent of that fetch's outcome — but the
  // fetch itself has a 5s-per-candidate-path network timeout, so these get
  // a generous explicit timeout as defense-in-depth against a slow/blocked
  // sandbox network, without depending on that network being reachable at
  // all for correctness.
  const NETWORK_TOUCHING_TEST_TIMEOUT_MS = 20_000;

  it(
    'llama (serving both llama-api and meta) reaches a live "registered" state once LLAMA_API_KEY is populated',
    async () => {
      process.env.LLAMA_API_KEY = 'test-llama-credential-present';
      const results = await bootCatalog();
      const result = results.get('llama');
      expect(result?.status, `llama: ${JSON.stringify(result)}`).toBe('registered');
    },
    NETWORK_TOUCHING_TEST_TIMEOUT_MS
  );

  it(
    'meganova reaches a live "registered" state once MEGANOVA_API_KEY is populated',
    async () => {
      process.env.MEGANOVA_API_KEY = 'test-meganova-credential-present';
      const results = await bootCatalog();
      const result = results.get('meganova');
      expect(result?.status, `meganova: ${JSON.stringify(result)}`).toBe('registered');
    },
    NETWORK_TOUCHING_TEST_TIMEOUT_MS
  );

  it(
    'lucidquery reaches a live "registered" state once LUCIDQUERY_API_KEY is populated',
    async () => {
      process.env.LUCIDQUERY_API_KEY = 'test-lucidquery-credential-present';
      const results = await bootCatalog();
      const result = results.get('lucidquery');
      expect(result?.status, `lucidquery: ${JSON.stringify(result)}`).toBe('registered');
    },
    NETWORK_TOUCHING_TEST_TIMEOUT_MS
  );

  it(
    'all three reach "registered" simultaneously once every target env var is populated',
    async () => {
      process.env.LLAMA_API_KEY = 'test-llama-credential-present';
      process.env.MEGANOVA_API_KEY = 'test-meganova-credential-present';
      process.env.LUCIDQUERY_API_KEY = 'test-lucidquery-credential-present';

      const results = await bootCatalog();
      for (const id of TARGET_PROVIDER_IDS) {
        const result = results.get(id);
        expect(result?.status, `${id}: ${JSON.stringify(result)}`).toBe('registered');
      }
    },
    NETWORK_TOUCHING_TEST_TIMEOUT_MS
  );
});
