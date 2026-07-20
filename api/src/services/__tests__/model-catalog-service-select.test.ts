// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 6 Fix 2 — invariant: CATALOG_HOT_PATH_SELECT and mapPrismaModel
 * MUST stay in lock-step.
 *
 * Why this test exists: the catalog hot path (~64k rows reloaded every
 * 60s) used to load ALL Model columns via `include: { provider: true }`,
 * shipping ~100MB of unused JSONB (capabilitySources, capabilityConfidence,
 * capabilityUris, lifecycleStatus, …) over the wire on every cache miss.
 * Production observed 13.9s for the catalog query while EXPLAIN ANALYZE
 * projected 7.9ms — confirming wire-size + JSON-parse, not the index.
 *
 * The fix replaced `include` with an explicit `select: CATALOG_HOT_PATH_SELECT`
 * allowlist. That speeds the query, but introduces a maintenance contract:
 * any field added to mapPrismaModel below MUST also be added to the
 * select clause. This test scans the source file for two field-set
 * signatures and asserts symmetric difference is empty.
 *
 * If this test fails, the failure mode is one of:
 *   1. Added a `record.X` read in mapPrismaModel without adding `X: true`
 *      to CATALOG_HOT_PATH_SELECT → runtime crash (X is undefined).
 *   2. Added `X: true` to the select but never read it → harmless wire
 *      bloat that re-regresses the latency fix.
 * Either way, fix it by aligning both sides.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CATALOG_SERVICE_PATH = path.resolve(
  __dirname,
  '..',
  'model-catalog-service.ts',
);

function loadSource(): string {
  return readFileSync(CATALOG_SERVICE_PATH, 'utf8');
}

/**
 * Extract the keys appearing inside the `CATALOG_HOT_PATH_SELECT = { ... }`
 * literal. Stops at the first `}` that closes the literal at depth 1.
 */
function extractSelectKeys(source: string): Set<string> {
  const marker = 'const CATALOG_HOT_PATH_SELECT = {';
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error('CATALOG_HOT_PATH_SELECT literal not found in source');
  }
  let depth = 0;
  let i = start + marker.length - 1; // position on the opening `{`
  let end = -1;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error('Could not find closing brace for CATALOG_HOT_PATH_SELECT');
  const body = source.slice(start + marker.length, end);

  const keys = new Set<string>();
  // Match top-level keys ending with `: true,` or `: { select: ... },` —
  // we treat any top-level `<ident>:` as a select key. We deliberately
  // skip nested keys (e.g. provider's inner select) by tracking brace depth.
  let nestedDepth = 0;
  const lines = body.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    if (nestedDepth === 0) {
      // top-level key/value — accept `<key>: true,` or `<key>: { ... },`
      const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.exec(line);
      if (m) {
        keys.add(m[1]);
      }
    }
    // adjust depth AFTER capturing key for the line where nesting begins.
    for (const ch of line) {
      if (ch === '{') nestedDepth += 1;
      else if (ch === '}') nestedDepth -= 1;
    }
  }
  return keys;
}

/**
 * Extract the field names actually read off the Prisma record in
 * mapPrismaModel via `record.<field>` references. Returns the set of
 * field names without the `record.` prefix.
 */
function extractMapPrismaModelReads(source: string): Set<string> {
  const fnMarker = 'function mapPrismaModel(record: CatalogHotPathRecord): Model {';
  const start = source.indexOf(fnMarker);
  if (start === -1) {
    throw new Error('mapPrismaModel definition not found');
  }
  // Walk until matching `}` at depth 1 (same algorithm).
  let depth = 0;
  let i = start + fnMarker.length - 1; // position on the opening `{`
  let end = -1;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error('Could not find closing brace for mapPrismaModel');
  const body = source.slice(start, end);

  const reads = new Set<string>();
  const re = /\brecord\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    reads.add(m[1]);
  }
  return reads;
}

describe('CATALOG_HOT_PATH_SELECT invariant (Phase 6 Fix 2)', () => {
  it('every record.<field> read in mapPrismaModel has a matching key in CATALOG_HOT_PATH_SELECT', () => {
    const source = loadSource();
    const selectKeys = extractSelectKeys(source);
    const reads = extractMapPrismaModelReads(source);

    // `provider` is special — the select uses `provider: { select: { name: true } }`,
    // but mapPrismaModel reads `record.provider.name`. Treat top-level
    // `provider` membership as sufficient for the parity check.
    const missingFromSelect = [...reads].filter((field) => !selectKeys.has(field));
    expect(
      missingFromSelect,
      `mapPrismaModel reads record.${missingFromSelect.join(', record.')} but ` +
        `CATALOG_HOT_PATH_SELECT does not include them — runtime would crash.`,
    ).toEqual([]);
  });

  it('CATALOG_HOT_PATH_SELECT does not declare keys mapPrismaModel never reads (no wire bloat)', () => {
    const source = loadSource();
    const selectKeys = extractSelectKeys(source);
    const reads = extractMapPrismaModelReads(source);

    const unread = [...selectKeys].filter((key) => !reads.has(key));
    expect(
      unread,
      `CATALOG_HOT_PATH_SELECT declares ${unread.join(', ')} but mapPrismaModel never reads them — ` +
        `re-regresses the wire-bloat fix. Drop these from the select.`,
    ).toEqual([]);
  });

  it('CATALOG_HOT_PATH_SELECT excludes known heavy/unused columns', () => {
    const source = loadSource();
    const selectKeys = extractSelectKeys(source);

    // These columns exist on the Model schema but are NOT consumed by the
    // catalog hot path. Each one was a candidate for the 100MB wire bloat.
    // Listing them here serves as a regression guard: if anyone re-adds
    // them to the select without updating mapPrismaModel, the test fails.
    const knownHeavyExcluded = [
      'capabilityUris',
      'capabilityConfidence',
      'capabilitySources',
      'capabilityUpdatedAt',
      'embedding',
      'embeddingModel',
      'embeddingUpdatedAt',
      'lifecycleStatus',
      'lifecycleReason',
      'lifecycleEvaluatedAt',
      'usageCount',
      'createdAt',
      'updatedAt',
    ];

    const accidentallyIncluded = knownHeavyExcluded.filter((col) => selectKeys.has(col));
    expect(
      accidentallyIncluded,
      `CATALOG_HOT_PATH_SELECT re-introduced heavy columns: ${accidentallyIncluded.join(', ')}. ` +
        `These are NOT read by mapPrismaModel — re-regresses the 13.9s findMany latency.`,
    ).toEqual([]);
  });
});
