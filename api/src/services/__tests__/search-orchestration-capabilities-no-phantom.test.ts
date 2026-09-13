// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Phantom-capability regression guard for search orchestration.
 *
 * `SearchOrchestrationService#extractContent` used to filter models on
 * `web_scraping`/`content_extraction` capabilities that were never members
 * of `ModelCapability` (they don't appear anywhere else in the codebase,
 * and no assignment path in `model-capability-inference.ts` or
 * `structural-derivation.ts` ever produces them). The filter strings were
 * force-cast `as ModelCapability` to bypass the type system. Since
 * `searchModelsComplete`'s capabilities filter is a Postgres JSONB
 * containment query requiring ALL listed values to be present, a
 * capability no real model can ever hold makes the query permanently
 * return `[]`, silently killing the branch it gated (the entire
 * model-based URL-extraction path was dead code from the day it shipped).
 *
 * This test statically extracts every `'<literal>' as ModelCapability`
 * cast anywhere in the file and asserts each literal is a real member of
 * the `ModelCapability` union. A future change that adds a new
 * capability-name cast for a value that isn't in the union (typo,
 * aspirational name, or a capability later removed from the union) fails
 * this test instead of silently shipping a second permanently-empty
 * model pool.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isModelCapability } from '@/types';

const SERVICE_PATH = join(__dirname, '..', 'search-orchestration-service.ts');
const source = readFileSync(SERVICE_PATH, 'utf8');

describe('search-orchestration-service — no phantom ModelCapability cast', () => {
  // Every capability-string reference in this file is spelled as a
  // `'literal' as ModelCapability` cast (the capabilities filter on
  // `searchModelsComplete` requires this shape). Extract all of them,
  // wherever in the file they appear, rather than scoping to one method,
  // so a phantom introduced in a new method can't hide from this guard.
  const casts = Array.from(source.matchAll(/'([a-z_]+)'\s+as\s+ModelCapability/g)).map(
    (m) => m[1]
  );
  const uniqueCasts = Array.from(new Set(casts));

  it('found at least one ModelCapability cast to check (extractor sanity check)', () => {
    // If this ever drops to zero, the regex broke, not that the
    // production code magically became phantom-free.
    expect(uniqueCasts.length).toBeGreaterThan(0);
  });

  it.each(uniqueCasts.map((cap) => [cap] as const))(
    '%s is a real ModelCapability member',
    (cap) => {
      expect(
        isModelCapability(cap),
        `"${cap}" is cast \`as ModelCapability\` in search-orchestration-service.ts but is not ` +
          'a real member of the ModelCapability union. This is exactly the ' +
          '`web_scraping`/`content_extraction` phantom-capability bug: a nonexistent capability ' +
          'name silently empties any model pool filtered on it, permanently disabling the code ' +
          'path that pool gates.'
      ).toBe(true);
    }
  );
});
