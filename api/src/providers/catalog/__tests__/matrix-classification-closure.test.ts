// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Matrix classification closure — the FINAL authoritative bucketing.
 *
 * ## Why this test exists
 *
 * After the residue-closure + consolidation work (see
 * `anti-hardcode-guard.test.ts` for the disjointness invariant and
 * `matrix-integrity.test.ts` for the one-row-per-provider invariant), the
 * SOTA-NORMALIZAÇÃO-FINAL directive requires ONE more invariant:
 *
 *   Every canonical provider id falls into **exactly one** of a closed
 *   set of classification buckets, and the bucket sizes sum to the total
 *   canonical count. No provider may appear in two buckets. No bucket
 *   may be miscounted.
 *
 * This test encodes the buckets derived from the catalog's structural
 * metadata (integrationMode + enabledByDefault + denyByDefault) plus
 * the switch cases. It deliberately does NOT encode the "integrado com
 * live validation" bucket — that bucket exists in the narrative artifact
 * but has no corresponding runtime predicate (live validation requires
 * an external probe, not a code property).
 *
 * The narrative artifact (FINAL REPORT v1.0, 2026-04-23) applies Option B
 * for live validation: the `integrado com live validation` bucket is
 * EMPTY for this release because no probe ran in the canonical session
 * that can be re-verified against the current HEAD. Promotion to that
 * bucket is reserved for a future pipeline that records upstream probe
 * timestamps and rolls them forward against HEAD changes.
 *
 * The buckets enforced here:
 *
 *   - `integrado-sem-live-validation`  → catalog + enabledByDefault + runtime-capable
 *   - `credentials-missing`            → catalog + enabledByDefault=false + runtime-capable
 *   - `upstream-suspended`             → catalog rows marked as suspended via metadata/notes
 *   - `catalog-only-inventory`         → integrationMode === 'catalog-only'
 *   - `switch-only-legitimate`         → appears in provider-registry.ts switch
 *
 * The sum must equal |catalog| + |switch| = the canonical total.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PROVIDER_CATALOG } from '../providers.catalog';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REGISTRY_PATH = join(__dirname, '..', '..', 'provider-registry.ts');

function extractSwitchCaseProviderIds(source: string): string[] {
  const regex = /^\s*case\s+'([a-z][a-z0-9-]*)'\s*:/gm;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

/**
 * Upstream-suspended providers — documented in the catalog as having
 * deprecated public endpoints, preserved as catalog rows for private-
 * deployment customers. These are a CLOSED enumerated set; adding to it
 * requires updating both the catalog note and this test.
 */
const UPSTREAM_SUSPENDED: ReadonlySet<string> = new Set([
  'anyscale', // public endpoints deprecated mid-2024; catalog comment lines 252-266
]);

type Bucket =
  | 'integrado-sem-live-validation'
  | 'credentials-missing'
  | 'upstream-suspended'
  | 'catalog-only-inventory'
  | 'switch-only-legitimate';

function classifyCatalogEntry(
  entry: (typeof PROVIDER_CATALOG)[number],
): Bucket {
  if (UPSTREAM_SUSPENDED.has(entry.providerId)) return 'upstream-suspended';
  if (entry.integrationMode === 'catalog-only') return 'catalog-only-inventory';
  if (entry.enabledByDefault === false) return 'credentials-missing';
  return 'integrado-sem-live-validation';
}

describe('matrix classification closure (FINAL v1.0, 2026-04-23)', () => {
  const registrySource = readFileSync(REGISTRY_PATH, 'utf8');
  const switchIds = extractSwitchCaseProviderIds(registrySource);

  const buckets: Record<Bucket, string[]> = {
    'integrado-sem-live-validation': [],
    'credentials-missing': [],
    'upstream-suspended': [],
    'catalog-only-inventory': [],
    'switch-only-legitimate': [],
  };

  for (const entry of PROVIDER_CATALOG) {
    const bucket = classifyCatalogEntry(entry);
    buckets[bucket].push(entry.providerId);
  }
  for (const id of switchIds) {
    buckets['switch-only-legitimate'].push(id);
  }

  it('every provider appears in exactly one bucket (partition invariant)', () => {
    const allIds: string[] = [];
    for (const ids of Object.values(buckets)) allIds.push(...ids);
    const unique = new Set(allIds);

    // If this fires, a provider was counted twice across buckets. The
    // classifier must be a partition — total with repetition equals total
    // unique. Fix: audit `classifyCatalogEntry` precedence rules.
    expect(allIds.length).toBe(unique.size);
  });

  it('bucket totals sum to |catalog| + |switch| (closure invariant)', () => {
    const catalogCount = PROVIDER_CATALOG.length;
    const switchCount = switchIds.length;
    const total = Object.values(buckets).reduce(
      (acc, ids) => acc + ids.length,
      0,
    );

    // If this fires, some provider was lost in classification. The union
    // of all buckets MUST equal the canonical registration-path total.
    expect(total).toBe(catalogCount + switchCount);
  });

  it('catalog-only bucket matches integrationMode===catalog-only exactly', () => {
    const expected = PROVIDER_CATALOG.filter(
      (e) => e.integrationMode === 'catalog-only',
    )
      .map((e) => e.providerId)
      .sort();
    expect([...buckets['catalog-only-inventory']].sort()).toEqual(expected);
  });

  it('upstream-suspended is a closed, documented enumeration', () => {
    // Any bucket membership here must be accompanied by a catalog-row comment
    // that names the deprecation date and vendor. If this list diverges from
    // UPSTREAM_SUSPENDED, we've either missed documenting a new suspension
    // or orphaned a stale entry in the set.
    expect([...buckets['upstream-suspended']].sort()).toEqual(
      [...UPSTREAM_SUSPENDED].sort(),
    );
  });

  it('Option B is enforced: no `integrado-com-live-validation` bucket exists at runtime', () => {
    // The narrative bucket `integrado com live validation` is deliberately
    // NOT a runtime-derivable property. Promoting any provider into it
    // requires a probe pipeline that writes a timestamp into
    // `providerBalanceStatus.lastLiveProbe` (not yet implemented).
    //
    // This assertion is the runtime proof that the final artifact's Option
    // B decision is not contradicted by this test file — there is no key
    // in `buckets` that could silently absorb providers without a probe.
    const keys = Object.keys(buckets);
    expect(keys).not.toContain('integrado-com-live-validation');
    expect(keys).not.toContain('live-validated');
  });

  it('classification snapshot matches the FINAL artifact bucket sizes', () => {
    // Pins the specific bucket sizes from the FINAL artifact. If catalog
    // structure changes (e.g. a provider is migrated, suspended, or opt-in
    // flag toggled), this test fails loudly — forcing the artifact (and
    // this pin) to be updated in lockstep. Without this pin, silent drift
    // between code and artifact is possible.
    //
    // Update procedure: recompute, update the pin, update the FINAL report
    // §5 `Reconciliação matemática de contagens`, commit atomically.
    //
    // 2026-04-28 Phase 4a (universal "habilitado e nunca censurado"):
    // bulk-flipped every `enabledByDefault: false` row to `true`. Net effect
    // on this snapshot: all 36 `credentials-missing` providers migrated to
    // `integrado-sem-live-validation` (39 → 75); `credentials-missing` is
    // now empty. Catalog-only-inventory and upstream-suspended unchanged.
    // Total preserved at 103 (= |catalog| + |switch| = 81 + 22).
    //
    // 2026-06 runnable-gap pass (recomputed 2026-06-11): +alibaba and
    // +aws-bedrock catalog rows (closing orphan DB provider_ids), and topaz
    // migrated catalog-only → execution-only (pinnedFallback inventory).
    // integrado 75 → 78; total 103 → 106 (= |catalog| + |switch| = 84 + 22).
    // 2026-06-20 operator promotion pass: 3 providers moved catalog-only →
    // integrado (execution wired); integrado 78→81, catalog-only 4→1 (net=0).
    // LOTE O (2026-07-10): +apertis, +inception (enabledByDefault:true,
    // integrationMode discovery+execution) — integrado 81→83.
    // LOTE P (2026-07-11): +empiriolabs (same shape) — integrado 83→84.
    // LOTE Q (2026-07-12): +concentrate (same shape) — integrado 84→85.
    // LOTE R (2026-07-13): +fastrouter (same shape) — integrado 85→86.
    // LOTE S (2026-07-13): +perplexity-agent (same shape) — integrado 86→87.
    // LOTE T (2026-07-13): +ailin (same shape) — integrado 87→88.
    expect(buckets['integrado-sem-live-validation'].length).toBe(88);
    // credentials-missing history:
    //   22 (original) → 25 (Lot B, 2026-04-23: +writer/upstage/rekaai)
    //                → 36 (LOTE M complement lot, 2026-04-23: +11 catalog
    //                      rows with enabledByDefault=false and non-
    //                      catalog-only integrationMode: arcee, atlascloud,
    //                      avian, gmi, infermatic, mancer, phala, qianfan,
    //                      siliconflow, stepfun, venice).
    //                → 0  (Phase 4a, 2026-04-28: universal flip drained
    //                      this bucket; uncensored handling moved to the
    //                      new `contentPolicyClass` field, see Phase 4b).
    expect(buckets['credentials-missing'].length).toBe(0);
    expect(buckets['upstream-suspended'].length).toBe(1);
    // catalog-only-inventory history:
    //   3 (sap, snowflake, topaz)
    //   → 5 (LOTE M, 2026-04-23: +inflection (proprietary schema, needs
    //        dedicated adapter) +relace (specialty code-edit surface,
    //        needs dedicated adapter))
    //   → 4 (runnable-gap pass: topaz migrated catalog-only →
    //        execution-only with a curated pinnedFallback inventory).
    //   → 1 (2026-06-20 promotion pass: 3 providers wired for execution
    //        and migrated from catalog-only → integrado-sem-live-validation;
    //        net catalog size unchanged, counts shifted not added).
    expect(buckets['catalog-only-inventory'].length).toBe(1);
    // switch-only history: 22 → 21 (2026-06-11: 'aws-bedrock' case removed
    // from provider-registry.ts — it was unreachable and Bedrock is served
    // by its catalog row with the AwsBedrockAdapter factory binding).
    expect(buckets['switch-only-legitimate'].length).toBe(21);
    // Sum: 88 + 0 + 1 + 1 + 21 = 111 (= |catalog 90| + |switch 21|,
    // recomputed 2026-07-13 after LOTE T ailin onboarding).
  });
});
