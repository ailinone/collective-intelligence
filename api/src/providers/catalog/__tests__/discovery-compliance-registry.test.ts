// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SOTA dynamic-discovery compliance registry — invariant guard.
 *
 * This test is the structural counterpart to consolidation-matrix.test.ts. The
 * consolidation matrix classifies providers by OPERATIONAL state (live, suspended,
 * credentials-missing, defunct, …). The compliance registry classifies the SAME
 * providers by an ORTHOGONAL axis: HOW the inventory is materialized — dynamic
 * provider /models, deployment-bound enumeration, hardcoded list, runtime gap, etc.
 *
 * This test pins the "discovery compliance is data, not free text" decision
 * (2026-04-27) into code. It exists because the prior `/v1/models` route had a
 * silent static-catalog fallback that contradicted the dynamic-discovery contract
 * documented elsewhere — the structural fix MUST be guarded structurally.
 *
 * ## Invariants enforced
 *
 *   J1  — every canonical providerId (catalog ∪ switch) appears in EXACTLY ONE
 *         bucket of DISCOVERY_COMPLIANCE_REGISTRY.
 *   J2  — every providerId in `non-compliant-runtime-not-materialized` has a
 *         non-empty `staticModels` in PROVIDER_CATALOG (the bucket's name asserts
 *         "static inventory exists but discovery has not yet materialized it";
 *         that claim must be backed by an actual array of model IDs).
 *   J3  — every catalog entry with non-empty `staticModels` (or `pinnedFallback`)
 *         belongs to one of the THREE buckets that admit static inventory:
 *         `pinnedFallback-by-design`,
 *         `non-compliant-hardcoded-inventory`, OR
 *         `non-compliant-runtime-not-materialized`.
 *         (Phase 6 Fix 7 — `pinnedFallback-by-design` joined the set when
 *         we split out `reason: 'no-list-endpoint'` providers from the
 *         hardcoded-inventory bucket.)
 *         If a provider has static inventory but is registered under any
 *         OTHER bucket, the test fails — by definition no other bucket
 *         may carry curated inventory.
 *   J4  — DISCOVERY_COMPLIANCE_BUCKETS is exactly the 9 sanctioned classes.
 *   J5  — the union of all bucket arrays equals the canonical provider set
 *         (= |catalog ∪ switch|, currently ~103 at HEAD; the structural identity
 *          is pinned, not the literal count).
 *   J6  — every providerId in `pinnedFallback-by-design` carries
 *         `pinnedFallback.reason === 'no-list-endpoint'` AND a non-empty
 *         `pinnedFallback.models` array in providers.catalog.ts. (Phase 6
 *         Fix 7 — one-way implication: the reverse does NOT hold —
 *         voyage / atlascloud / avian / qianfan also carry
 *         `'no-list-endpoint'` as their pinnedFallback reason but probe
 *         evidence shows they have real /v1/models surfaces, so they stay
 *         in `non-compliant-runtime-not-materialized` until their fetchers
 *         ship — that's a catalog-reason data-quality bug queued for
 *         separate Phase 3B fix, not an invariant violation here.)
 *
 * ## Out of scope
 *
 *   - Whether a provider is reachable RIGHT NOW (covered by consolidation matrix).
 *   - Whether a provider's adapter exists (covered by registry tests).
 *   - Whether a provider's secret is mapped (covered by sublote-e1-runtime-wiring).
 *
 *   This test is purely about "is the inventory's origin honest in the public
 *   `/v1/models` response".
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PROVIDER_CATALOG } from '../providers.catalog';
import {
  DISCOVERY_COMPLIANCE_BUCKETS,
  DISCOVERY_COMPLIANCE_REGISTRY,
  getDiscoveryComplianceClass,
  isDiscoveryCompliant,
  type DiscoveryComplianceClass,
} from '../consolidation-matrix';

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
 * Buckets whose membership presupposes a curated `pinnedFallback.models`
 * (or legacy `staticModels`) on the catalog row. Phase 6 Fix 7 expanded
 * this set to include `pinnedFallback-by-design` — that bucket is
 * COMPLIANT (the curated list is the inventory contract) but it still
 * carries pinnedFallback, so J3's "static inventory ⇒ one of these
 * buckets" check must include it.
 */
const BUCKETS_ADMITTING_STATIC_INVENTORY: readonly DiscoveryComplianceClass[] = [
  'pinnedFallback-by-design',
  'non-compliant-hardcoded-inventory',
  'non-compliant-runtime-not-materialized',
  // 2026-06-11 refinement: deployment-bound discovery (e.g. aws-bedrock's
  // /foundation-models) requires operator account credentials before any
  // model can materialise. A curated bootstrap shortlist
  // (pinnedFallback.reason: 'curated-shortlist') therefore coexists with
  // the live discovery surface BY DESIGN — it keeps the provider routable
  // pre-provisioning and is superseded the moment discovery succeeds.
  'compliant-deployment-discovery',
];

describe('discovery-compliance-registry: SOTA dynamic-discovery invariant', () => {
  const registrySource = readFileSync(REGISTRY_PATH, 'utf8');
  const switchIds = new Set(extractSwitchCaseProviderIds(registrySource));
  const catalogIds = new Set(PROVIDER_CATALOG.map((e) => e.providerId));
  const canonicalIds = new Set<string>([...catalogIds, ...switchIds]);

  // Flatten registry once. Throw on duplicates immediately for readable errors.
  const bucketOf = new Map<string, DiscoveryComplianceClass>();
  for (const bucket of DISCOVERY_COMPLIANCE_BUCKETS) {
    for (const id of DISCOVERY_COMPLIANCE_REGISTRY[bucket]) {
      if (bucketOf.has(id)) {
        throw new Error(
          `Registry corruption: '${id}' appears in both '${bucketOf.get(id)}' and '${bucket}'`,
        );
      }
      bucketOf.set(id, bucket);
    }
  }
  const classifiedIds = new Set(bucketOf.keys());

  it('J4 — DISCOVERY_COMPLIANCE_BUCKETS is exactly the 9 sanctioned classes', () => {
    expect([...DISCOVERY_COMPLIANCE_BUCKETS].sort()).toEqual(
      [
        'compliant-deployment-discovery',
        'compliant-dynamic-discovery',
        'compliant-machine-readable-official-catalog',
        // Phase 6 Fix 7 (2026-04-30) — pinnedFallback-by-design
        // (`reason: 'no-list-endpoint'`) is compliant; the operator-curated
        // list is the inventory contract.
        'pinnedFallback-by-design',
        'non-compliant-hardcoded-inventory',
        'non-compliant-no-machine-readable-discovery',
        'non-compliant-runtime-not-materialized',
        'not-applicable-non-model-surface',
        'self-hosted-runtime-dependent',
      ].sort(),
    );
  });

  it('J1 — every canonical providerId appears in EXACTLY ONE bucket', () => {
    const missing = [...canonicalIds].filter((id) => !classifiedIds.has(id));
    const orphans = [...classifiedIds].filter((id) => !canonicalIds.has(id));

    expect({ missing, orphans }).toEqual({ missing: [], orphans: [] });
  });

  it('J5 — union of all buckets equals canonical provider set', () => {
    expect(classifiedIds.size).toBe(canonicalIds.size);
  });

  it('J2 — every `non-compliant-runtime-not-materialized` provider has non-empty static inventory (pinnedFallback or legacy staticModels)', () => {
    // Phase 4d (2026-04-28): the canonical static-inventory field is
    // `pinnedFallback.models`. Legacy `staticModels` is still accepted
    // during the migration window, but new rows MUST use pinnedFallback.
    // Either form satisfies the bucket invariant: the runtime cannot
    // materialize models for these providers, so the catalog itself is
    // the inventory of record.
    const offenders: Array<{ providerId: string; reason: string }> = [];

    for (const id of DISCOVERY_COMPLIANCE_REGISTRY['non-compliant-runtime-not-materialized']) {
      const entry = PROVIDER_CATALOG.find((e) => e.providerId === id);
      if (!entry) {
        offenders.push({ providerId: id, reason: 'not in PROVIDER_CATALOG' });
        continue;
      }
      const staticModels = (entry as { staticModels?: readonly string[] }).staticModels;
      const pinnedFallbackModels = (entry as {
        pinnedFallback?: { models?: readonly string[] };
      }).pinnedFallback?.models;
      const hasStatic = Array.isArray(staticModels) && staticModels.length > 0;
      const hasPinned = Array.isArray(pinnedFallbackModels) && pinnedFallbackModels.length > 0;
      if (!hasStatic && !hasPinned) {
        offenders.push({
          providerId: id,
          reason:
            'no `pinnedFallback.models` (preferred) or `staticModels` (legacy) — bucket name asserts static inventory exists',
        });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('J3 — every catalog entry with static inventory (pinnedFallback or legacy staticModels) is in one of the inventory-admitting buckets', () => {
    // Phase 4d (2026-04-28) baseline + Phase 6 Fix 7 (2026-04-30) refine.
    // Inverted form of J2: any entry that ships a curated model list is
    // by definition not feeding from runtime discovery, so it must live
    // in one of the BUCKETS_ADMITTING_STATIC_INVENTORY classes:
    //   - pinnedFallback-by-design (`reason: 'no-list-endpoint'` — the
    //     curated list IS the inventory contract; classified compliant)
    //   - non-compliant-hardcoded-inventory (`reason: 'proprietary-schema'`
    //     — parser debt)
    //   - non-compliant-runtime-not-materialized (vendor exposes
    //     /models, fetcher unwired)
    // Both pinnedFallback (canonical) and staticModels (legacy) trigger
    // this requirement — the registry semantics are identical.
    const violators: Array<{ providerId: string; bucket: DiscoveryComplianceClass | undefined }> = [];

    for (const entry of PROVIDER_CATALOG) {
      const staticModels = (entry as { staticModels?: readonly string[] }).staticModels;
      const pinnedFallbackModels = (entry as {
        pinnedFallback?: { models?: readonly string[] };
      }).pinnedFallback?.models;
      const hasStaticInventory =
        (Array.isArray(staticModels) && staticModels.length > 0) ||
        (Array.isArray(pinnedFallbackModels) && pinnedFallbackModels.length > 0);
      if (!hasStaticInventory) continue;

      const bucket = bucketOf.get(entry.providerId);
      if (!bucket || !BUCKETS_ADMITTING_STATIC_INVENTORY.includes(bucket)) {
        violators.push({ providerId: entry.providerId, bucket });
      }
    }

    expect(violators).toEqual([]);
  });

  it('J6 — every `pinnedFallback-by-design` provider has reason === "no-list-endpoint" AND a non-empty pinnedFallback.models array', () => {
    // Phase 6 Fix 7 (2026-04-30): the new bucket is operator-curated
    // by design. Membership is gated on TWO catalog signals:
    //   1. `pinnedFallback.reason === 'no-list-endpoint'` — the operator
    //      has declared that no upstream surface exists for this vendor.
    //   2. `pinnedFallback.models.length > 0` — there is an actual
    //      curated list to expose (an empty list would mean nothing for
    //      the runtime to materialize, which is `non-compliant-no-machine
    //      -readable-discovery` territory, not this bucket).
    // The reverse direction is NOT enforced (see docstring J6 note):
    // four other providers (voyage, atlascloud, avian, qianfan) carry
    // `reason: 'no-list-endpoint'` while staying in
    // `non-compliant-runtime-not-materialized` because probe evidence
    // proves they have real /v1/models surfaces — those reason values
    // are catalog data-quality bugs queued for Phase 3B fix.
    const offenders: Array<{ providerId: string; reason: string }> = [];

    for (const id of DISCOVERY_COMPLIANCE_REGISTRY['pinnedFallback-by-design']) {
      const entry = PROVIDER_CATALOG.find((e) => e.providerId === id);
      if (!entry) {
        offenders.push({ providerId: id, reason: 'not in PROVIDER_CATALOG' });
        continue;
      }
      const pinnedFallback = (entry as {
        pinnedFallback?: { reason?: string; models?: readonly unknown[] };
      }).pinnedFallback;
      if (!pinnedFallback) {
        offenders.push({ providerId: id, reason: 'missing pinnedFallback block' });
        continue;
      }
      if (pinnedFallback.reason !== 'no-list-endpoint') {
        offenders.push({
          providerId: id,
          reason: `expected pinnedFallback.reason === 'no-list-endpoint', got ${JSON.stringify(pinnedFallback.reason)}`,
        });
      }
      const modelsLen = Array.isArray(pinnedFallback.models) ? pinnedFallback.models.length : 0;
      if (modelsLen === 0) {
        offenders.push({ providerId: id, reason: 'pinnedFallback.models is empty or non-array' });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('helpers — getDiscoveryComplianceClass and isDiscoveryCompliant are coherent with the registry', () => {
    for (const id of canonicalIds) {
      const cls = getDiscoveryComplianceClass(id);
      expect(cls, `getDiscoveryComplianceClass('${id}') returned undefined`).toBeDefined();
      expect(cls).toBe(bucketOf.get(id));

      const compliant = isDiscoveryCompliant(id);
      const expectedCompliant = cls
        ? !cls.startsWith('non-compliant-')
        : false;
      expect(compliant, `isDiscoveryCompliant('${id}') disagrees with registry class '${cls}'`).toBe(
        expectedCompliant,
      );
    }

    // Negative case: an unclassified id returns undefined / false.
    expect(getDiscoveryComplianceClass('this-provider-does-not-exist')).toBeUndefined();
    expect(isDiscoveryCompliant('this-provider-does-not-exist')).toBe(false);
  });
});
