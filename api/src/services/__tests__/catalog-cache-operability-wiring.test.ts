// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression guard for the 2026-09-24 catalog load audit (R1): index.ts's operability
 * `onPoolRebuilt` hook (every ~5 min in every ci_api replica) used to call
 * invalidateCatalogCache() + getAllCatalogModels(). The tick only probes
 * providers and never writes `models`, yet the invalidate DELeted the
 * fleet-wide Redis snapshot and forced a full Postgres catalog read per
 * replica per tick. Booting index.ts in a unit test is out of scope, so this
 * is a structural check on the source, like seed-boot-wiring.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function extractBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced block after: ${marker}`);
}

/** Code only: the hook's own comment explains the removed calls by name. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('index.ts operability onPoolRebuilt hook', () => {
  const indexSource = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf8');
  const hook = stripComments(extractBlock(indexSource, 'onPoolRebuilt: async () => {'));

  it('still rebuilds the embedding index', () => {
    expect(hook).toMatch(/rebuildEmbeddingIndex\(\)/);
  });

  it('does not invalidate or reload the catalog cache', () => {
    expect(hook).not.toMatch(/invalidateCatalogCache/);
    expect(hook).not.toMatch(/getAllCatalogModels/);
    expect(hook).not.toMatch(/model-catalog-service/);
  });
});
