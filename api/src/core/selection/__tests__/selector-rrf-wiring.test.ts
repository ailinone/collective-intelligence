// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wiring contract test for the Caminho-C closure:
 * `DynamicModelSelector` ↔ `CapabilitySearchService` (singleton).
 *
 * Why a string-grep test (mirrors `sublote-e1-runtime-wiring.test.ts` and
 * `capabilities-search-routes-wiring.test.ts`):
 *   - The four invariants below are "this code must reference that code"
 *     contracts. The classic failure mode is silent: someone refactors the
 *     selector, drops the import, and the RRF rerank goes back to being a
 *     no-op. There's no boot-time error and no test failure unless we lock
 *     the textual references explicitly.
 *   - Spinning up the full selector to test the path requires Prisma + pg +
 *     embedder + provider registry + 6 other services via DI. That's the
 *     scope of an integration test, not a contract guard.
 *   - The behaviour of the rerank itself is validated by the activation
 *     chain (HTTP probes + `caminho-c-post-rebuild-baseline.json`). This
 *     file's job is to make sure the wiring cannot disappear unnoticed.
 *
 * Five invariants:
 *
 * 1. The selector imports `getCapabilitySearchService` from the singleton
 *    module — NOT the service class directly. The singleton is the single
 *    point of consistency between routes, selector, and any future jobs.
 *
 * 2. The selector imports `ModelSearchHit` as a type — proves we're using
 *    the structured result, not just calling for side-effects.
 *
 * 3. The `SelectionCriteria` interface declares an optional `semanticQuery`
 *    field. This is the public surface for callers to opt into reranking.
 *
 * 4. The `OrchestrationContext` interface declares an optional
 *    `semanticQuery` field — the orchestration-engine path must be able to
 *    forward the user's prompt without reaching past the type boundary.
 *
 * 5. The `applySemanticRerank` private method exists and calls
 *    `searchService.searchModels` — the actual integration point.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SELECTOR_PATH = join(
  __dirname,
  '..',
  'dynamic-model-selector.ts',
);
const TYPES_PATH = join(__dirname, '..', '..', '..', 'types', 'index.ts');

const selectorSource = readFileSync(SELECTOR_PATH, 'utf8');
const typesSource = readFileSync(TYPES_PATH, 'utf8');

describe('Caminho-C selector ↔ CapabilitySearchService wiring contract', () => {
  it('imports getCapabilitySearchService from the singleton module', () => {
    expect(selectorSource).toMatch(
      /import\s*\{\s*getCapabilitySearchService\s*\}\s*from\s*['"]@\/capability\/search\/capability-search-singleton['"]/,
    );
  });

  it('imports ModelSearchHit type from the search service', () => {
    expect(selectorSource).toMatch(
      /import\s+type\s*\{\s*ModelSearchHit\s*\}\s*from\s*['"]@\/capability\/search\/capability-search-service['"]/,
    );
  });

  it('declares the semanticQuery optional field on SelectionCriteria', () => {
    // Heuristic: the field appears within the SelectionCriteria block.
    const block = selectorSource.match(
      /export\s+interface\s+SelectionCriteria\s*\{[\s\S]*?\n\}/,
    );
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/semanticQuery\?\s*:\s*string/);
  });

  it('declares the semanticQuery optional field on OrchestrationContext', () => {
    const block = typesSource.match(
      /export\s+interface\s+OrchestrationContext[\s\S]*?\n\}/,
    );
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/semanticQuery\?\s*:\s*string/);
  });

  it('defines applySemanticRerank that calls searchService.searchModels', () => {
    expect(selectorSource).toMatch(
      /private\s+async\s+applySemanticRerank\s*\(/,
    );
    // The body must reference searchModels via the service handle. The
    // exact variable name can drift, but the call shape must stay.
    expect(selectorSource).toMatch(/\.searchModels\s*\(\s*\{/);
  });

  it('forwards semanticQuery through mergeCriteriaWithContext', () => {
    // The merge step is what allows orchestration-engine callers to set
    // it on context and have it reach the selector — so the test guards
    // the field-name spelling on both sides of the merge.
    expect(selectorSource).toMatch(
      /semanticQuery:\s*criteria\.semanticQuery\s*\?\?\s*context\.semanticQuery/,
    );
  });

  it('applies the rerank as a multiplicative boost with a bounded ceiling', () => {
    // The boost must be bounded — RRF cannot override health/balance/
    // capability gates. We lock the ceiling constant by name.
    expect(selectorSource).toMatch(/SEMANTIC_RERANK_MAX_BOOST/);
    expect(selectorSource).toMatch(
      /score\s*=\s*baseScore\s*\*\s*\(\s*1\s*\+\s*semanticBoost\s*\)/,
    );
  });
});
