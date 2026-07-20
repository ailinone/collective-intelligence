// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Boot-wiring guard — asserts that `src/index.ts` contains the exact calls
 * needed to load the provider catalog into the runtime registry at boot.
 *
 * This is a **structural guard**, not a behavioral test. It exists to prevent
 * the specific regression documented in the Lot A / Phase 2 honesty report:
 * a prior change had claimed to wire the catalog into production boot but the
 * actual runtime call was never landed (or was reverted silently). Behavioral
 * coverage of the loader itself — plugin materialization, health-check
 * routing, summary shape, skip-reason taxonomy — lives in
 * `catalog-loader.test.ts`. This file guards the BOOT CALL itself, nothing
 * else.
 *
 * ### What this test protects against
 *
 *   1. Someone comments out the `await import('.../catalog-loader.js')` line.
 *   2. Someone inverts the order (catalog before `initializeProviderRegistry`)
 *      which would silently break the registry's log-and-replace semantics
 *      for overlapping providers.
 *   3. Someone strips the structured log of the summary fields, hiding the
 *      skipped/failed counts that ops rely on for silent-regression detection.
 *
 * ### What this test does NOT cover
 *
 *   - Whether the loader actually registers the right providers at runtime —
 *     that's an integration concern covered by `catalog-loader.test.ts` and
 *     the provider-registry test suite.
 *   - Whether the try/catch correctly isolates loader errors — covered by the
 *     loader's own negative-path tests.
 *
 * ### Fragility / refactor note
 *
 * This test reads `src/index.ts` as plain text and greps. If you deliberately
 * move the catalog loader to a different boot location (e.g. extract into
 * `bootstrap-providers.ts`), UPDATE the expected path below — do not delete
 * the test. The regression it guards is too cheap to give up.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// __dirname here is `.../src/providers/catalog/__tests__`. Go up three levels
// to reach `src/`. `new URL` would resolve via ESM; we keep the plain-join
// approach because vitest runs this file with Node's CJS-compatible shim.
const INDEX_TS_PATH = join(__dirname, '..', '..', '..', 'index.ts');

function readIndex(): string {
  return readFileSync(INDEX_TS_PATH, 'utf-8');
}

describe('boot wiring: catalog-loader is reachable from src/index.ts', () => {
  it('dynamically imports loadProviderCatalog from @/providers/catalog/catalog-loader', () => {
    const src = readIndex();
    // Accept `.js` suffix (ESM-style, TS-compiled) or no suffix (NodeNext
    // without explicit extension). Single or double quotes both allowed.
    expect(src).toMatch(
      /await import\(['"]@\/providers\/catalog\/catalog-loader(?:\.js)?['"]\)/,
    );
  });

  it('calls loadProviderCatalog() after initializeProviderRegistry()', () => {
    const src = readIndex();
    const initializeIdx = src.indexOf('initializeProviderRegistry');
    const loaderCallIdx = src.indexOf('loadProviderCatalog()');

    expect(
      initializeIdx,
      'initializeProviderRegistry must appear in boot path',
    ).toBeGreaterThan(-1);
    expect(
      loaderCallIdx,
      'loadProviderCatalog() must be invoked in boot path — catalog is test-only otherwise',
    ).toBeGreaterThan(-1);
    expect(
      loaderCallIdx,
      'loadProviderCatalog() must run AFTER initializeProviderRegistry() so the registry ' +
        'exists when the catalog registers into it AND so log-and-replace semantics favor ' +
        'the catalog over any switch-registered duplicate.',
    ).toBeGreaterThan(initializeIdx);
  });

  it('surfaces the catalog-load summary via structured log (ops observability)', () => {
    const src = readIndex();
    // These three fields are the minimum ops needs: how many tried, how many
    // landed, and WHY the rest didn't. If someone strips these to a bare
    // message, silent regressions become invisible — that's exactly what the
    // Phase 2 honesty report was about.
    expect(src).toMatch(/registered:\s*catalogSummary\.registered/);
    expect(src).toMatch(/skipped:\s*catalogSummary\.skipped/);
    expect(src).toMatch(/reasonCounts:\s*catalogSummary\.reasonCounts/);
  });

  it('wraps the loader call in try/catch (boot must not die on loader bugs)', () => {
    const src = readIndex();
    // Locate the loader call and verify it sits inside a try block before a
    // catch clause. Rough heuristic: the nearest preceding `try {` must come
    // before the nearest preceding `catch`. This keeps the test resilient to
    // minor formatting changes while still catching a "removed the try/catch"
    // regression.
    const loaderCallIdx = src.indexOf('loadProviderCatalog()');
    expect(loaderCallIdx).toBeGreaterThan(-1);

    const preceding = src.slice(0, loaderCallIdx);
    const lastTry = preceding.lastIndexOf('try {');
    const lastCatch = preceding.lastIndexOf('} catch');
    // The nearest `try {` must be more recent than the nearest `} catch` —
    // i.e. we're currently inside a try-block.
    expect(
      lastTry,
      'loadProviderCatalog() must be wrapped in try { ... } catch — a loader-module ' +
        'import crash must not kill boot for providers registered by the switch.',
    ).toBeGreaterThan(lastCatch);
  });
});
