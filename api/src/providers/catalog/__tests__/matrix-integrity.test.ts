// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Matrix integrity guard — one-provider-one-row-one-classification.
 *
 * ## Why this test exists
 *
 * The canonical provider set has TWO registration paths today:
 *
 *   (1) `PROVIDER_CATALOG` — data-driven rows (65 at HEAD 2026-04-22)
 *   (2) `provider-registry.ts` switch cases — legacy first-party-native /
 *       specialty audio / self-hosted-non-OAI (22 at HEAD 2026-04-22)
 *
 * The SOTA-CONSOLIDAÇÃO-FINAL-CANÔNICA directive requires that the
 * canonical union be exactly `catalog_count + switch_count` with **zero
 * overlap**: no `providerId` (or alias) appears as both a catalog row
 * AND a switch case. Overlap causes non-deterministic dispatch and
 * double-registration warnings at startup.
 *
 * The existing `anti-hardcode-guard.test.ts` already covers catalog/switch
 * disjointness for OAI-compatible entries. This file extends the guarantee
 * in three orthogonal directions:
 *
 *   (A) **No catalog row appears twice under different providerIds** —
 *       every `providerId` value across the catalog is unique. (Not
 *       currently enforced by Zod.)
 *
 *   (B) **No alias collides with a foreign providerId** — if catalog row
 *       X lists `['foo']` as an alias, no other row (or switch case) may
 *       have providerId `foo`. Collisions cause alias normalization to
 *       resolve to the wrong canonical row.
 *
 *   (C) **Every catalog row is also classified exactly once** — the union
 *       { catalogIds ∪ switchIds } has cardinality equal to the sum (zero
 *       overlap). This is the mathematical invariant: canonical = 65 + 22 = 87,
 *       intersect = ∅.
 *
 * These three invariants together give the "one provider = one row = one
 * classification" contract required by the consolidation directive.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PROVIDER_CATALOG } from '../providers.catalog';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REGISTRY_PATH = join(__dirname, '..', '..', 'provider-registry.ts');

/**
 * Extract lowercase-kebab providerIds from `case 'x':` statements.
 * Mirrors the logic in anti-hardcode-guard.test.ts so the two tests
 * agree on what constitutes a switch-case registration.
 */
function extractSwitchCaseProviderIds(source: string): string[] {
  const regex = /^\s*case\s+'([a-z][a-z0-9-]*)'\s*:/gm;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

describe('matrix integrity: one provider = one row = one classification', () => {
  const registrySource = readFileSync(REGISTRY_PATH, 'utf8');
  const switchIds = extractSwitchCaseProviderIds(registrySource);
  const catalogIds = PROVIDER_CATALOG.map((e) => e.providerId);

  // ─── Invariant A: catalog providerIds are unique ──────────────────────
  it('every providerId in the catalog is unique (no duplicate rows)', () => {
    const seen = new Map<string, number>();
    for (const id of catalogIds) {
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1);

    // If this fires: two rows share a providerId. Zod validates shape but
    // does not cross-check uniqueness across rows. Merge or rename.
    expect(duplicates).toEqual([]);
  });

  // ─── Invariant B: aliases do not collide with foreign providerIds ─────
  it('no catalog alias collides with another providerId (catalog or switch)', () => {
    const canonicalIds = new Set<string>([...catalogIds, ...switchIds]);
    const collisions: Array<{ owner: string; alias: string }> = [];

    for (const entry of PROVIDER_CATALOG) {
      for (const alias of entry.aliases ?? []) {
        // An alias is a collision if it equals a DIFFERENT canonical
        // providerId (catalog row or switch case).
        if (alias !== entry.providerId && canonicalIds.has(alias)) {
          collisions.push({ owner: entry.providerId, alias });
        }
      }
    }

    // If this fires: alias normalization is ambiguous. Example scenario —
    // catalog row `foo` lists `['bar']` as alias, but `bar` is ALSO a
    // canonical providerId. The normalizer can't tell which canonical
    // row the incoming `bar` request should resolve to. Remove the
    // conflicting alias.
    expect(collisions).toEqual([]);
  });

  // ─── Invariant C: catalog ∩ switch = ∅, canonical = catalog + switch ──
  it('canonical union has exactly catalog_count + switch_count entries (zero overlap)', () => {
    const catalogSet = new Set(catalogIds);
    const switchSet = new Set(switchIds);
    const intersection = [...catalogSet].filter((id) => switchSet.has(id));

    // Duplicates-within-a-single-source are caught by Invariant A (catalog)
    // and by the TypeScript compiler (switch cases are literal strings).
    // Here we only need to verify the cross-source disjointness.
    expect(intersection).toEqual([]);

    // And the mathematical identity: |catalog ∪ switch| = |catalog| + |switch|
    const union = new Set<string>([...catalogSet, ...switchSet]);
    expect(union.size).toBe(catalogSet.size + switchSet.size);
  });

  // ─── Smoke: the canonical set is non-empty and matches the audit ──────
  it('canonical union count is bounded sanely (sanity check)', () => {
    // At HEAD 2026-04-22 the audit recorded 65 + 22 = 87. The test does
    // NOT pin to that number — it pins a sane band. Pinning exact counts
    // would force a test update on every legitimate provider addition.
    //
    // The floor (30) catches catastrophic catalog/registry truncation;
    // the ceiling (200) catches a runaway codepath that registers
    // unintended strings as providers.
    const union = new Set<string>([...catalogIds, ...switchIds]);
    expect(union.size).toBeGreaterThanOrEqual(30);
    expect(union.size).toBeLessThanOrEqual(200);
  });
});
