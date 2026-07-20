// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Coherence test for the SOTA consolidation matrix.
 *
 * This test pins the "single authoritative classification" decision
 * (2026-04-23) into code. It catches the exact class of drift that
 * produced the "0 probes vs 41 probes" contradiction in the preceding
 * narrative reports — by making the matrix a typed, testable data
 * structure rather than free-text markdown.
 *
 * ## Invariants enforced
 *
 *   I1  — every canonical providerId (catalog ∪ switch) appears in
 *         EXACTLY ONE bucket of CONSOLIDATION_MATRIX
 *   I2  — no providerId appears in more than one bucket
 *   I3  — CONSOLIDATION_BUCKETS is exactly the 10 sanctioned names
 *   I4  — NON_CANONICAL_PROVIDERS lists are disjoint from canonical
 *   I5  — historical claims do not bleed into any bucket's providerId list
 *   I6  — the matrix total equals |catalog ∪ switch|
 *         (= 103 at HEAD post LOTE M 2026-04-23; the number is not pinned,
 *          the structural identity is)
 *
 * If any invariant fails:
 *   - double-check whether the change was intentional (e.g. you moved
 *     a provider out of 'credentials-missing' into 'live-validation'
 *     because a probe succeeded), and update CONSOLIDATION_MATRIX
 *     accordingly; OR
 *   - revert the change — the catalog/registry added a provider that
 *     was not assigned to a bucket.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PROVIDER_CATALOG } from '../providers.catalog';
import {
  CONSOLIDATION_BUCKETS,
  CONSOLIDATION_MATRIX,
  CREDENTIALS_MISSING_SUBCLASS,
  NON_CANONICAL_HISTORICAL_CLAIMS,
  NON_CANONICAL_PROVIDERS,
  totalCanonicalInMatrix,
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

describe('consolidation-matrix: single authoritative classification', () => {
  const registrySource = readFileSync(REGISTRY_PATH, 'utf8');
  const switchIds = new Set(extractSwitchCaseProviderIds(registrySource));
  const catalogIds = new Set(PROVIDER_CATALOG.map((e) => e.providerId));
  const canonicalIds = new Set<string>([...catalogIds, ...switchIds]);

  // Flatten the matrix once for cross-invariant checks.
  const bucketOf = new Map<string, string>();
  for (const bucket of CONSOLIDATION_BUCKETS) {
    for (const id of CONSOLIDATION_MATRIX[bucket]) {
      // I2 — early signal: same id assigned to two buckets before we
      // even start the per-invariant assertions.
      if (bucketOf.has(id)) {
        throw new Error(
          `Matrix corruption: '${id}' appears in both '${bucketOf.get(id)}' and '${bucket}'`,
        );
      }
      bucketOf.set(id, bucket);
    }
  }
  const classifiedIds = new Set(bucketOf.keys());

  // ─── I1 — every canonical id is classified exactly once ──────────────
  it('I1: every canonical provider is in exactly one bucket', () => {
    const unclassified: string[] = [];
    for (const id of canonicalIds) {
      if (!classifiedIds.has(id)) unclassified.push(id);
    }

    // If this fires: a catalog row or switch case exists that was not
    // assigned a bucket. Either add it to the appropriate bucket in
    // consolidation-matrix.ts, or revert the catalog/registry addition.
    expect(unclassified).toEqual([]);
  });

  // ─── I2 — no provider appears in two buckets ─────────────────────────
  it('I2: no provider appears in more than one bucket', () => {
    // The Map-based flattening above would have thrown if duplicates
    // existed. This test re-asserts that condition explicitly so the
    // invariant is visible in CI output.
    const flatSize = [...CONSOLIDATION_BUCKETS].reduce(
      (sum, b) => sum + CONSOLIDATION_MATRIX[b].length,
      0,
    );
    expect(flatSize).toBe(classifiedIds.size);
  });

  // ─── I3 — buckets are exactly the 10 sanctioned names ────────────────
  it('I3: CONSOLIDATION_BUCKETS contains exactly the 10 sanctioned names', () => {
    const expected = [
      'live-validation',
      'no-live-validation',
      'partial',
      'credentials-missing',
      'vendor-side-failure',
      'upstream-suspended',
      'defunct-unreachable',
      'catalog-only-inventory',
      'switch-only-legitimate',
      'not-eligible',
    ];
    expect([...CONSOLIDATION_BUCKETS].sort()).toEqual([...expected].sort());
  });

  // ─── I4 — non-canonical orphans are disjoint from canonical ──────────
  it('I4: non-canonical (orphan) providers are NOT in the canonical set', () => {
    const orphanIds = [
      ...NON_CANONICAL_PROVIDERS.pending_closure,
      ...NON_CANONICAL_PROVIDERS.pending_removal,
    ];
    const leaked = orphanIds.filter((id) => canonicalIds.has(id));

    // If this fires: an orphan got promoted into the canonical set
    // without being removed from NON_CANONICAL_PROVIDERS. When a closure
    // lot adds (e.g.) writer to the catalog, also remove it from
    // pending_closure in consolidation-matrix.ts.
    expect(leaked).toEqual([]);
  });

  // ─── I4b — orphans are not accidentally in the matrix either ─────────
  it('I4b: non-canonical orphans do NOT appear in any matrix bucket', () => {
    const orphanIds = new Set([
      ...NON_CANONICAL_PROVIDERS.pending_closure,
      ...NON_CANONICAL_PROVIDERS.pending_removal,
    ]);
    const contamination: string[] = [];
    for (const id of classifiedIds) {
      if (orphanIds.has(id)) contamination.push(id);
    }
    expect(contamination).toEqual([]);
  });

  // ─── I5 — historical claims do not contaminate bucket arrays ─────────
  it('I5: historical claims live in a separate field, not in buckets', () => {
    // NON_CANONICAL_HISTORICAL_CLAIMS holds textual claim records;
    // no element of any bucket array should be a claim text fragment.
    // Sanity: every bucket element is shaped like a providerId
    // (lowercase-kebab, starts with a letter).
    const providerIdPattern = /^[a-z][a-z0-9-]*$/;
    const malformed: Array<{ bucket: string; id: string }> = [];
    for (const bucket of CONSOLIDATION_BUCKETS) {
      for (const id of CONSOLIDATION_MATRIX[bucket]) {
        if (!providerIdPattern.test(id)) {
          malformed.push({ bucket, id });
        }
      }
    }
    expect(malformed).toEqual([]);

    // And: historical claims is non-empty (the record of supersessions
    // should not be silently emptied).
    expect(NON_CANONICAL_HISTORICAL_CLAIMS.length).toBeGreaterThan(0);
    for (const claim of NON_CANONICAL_HISTORICAL_CLAIMS) {
      expect(claim.claim).toBeTruthy();
      expect(claim.superseded_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(claim.reason).toBeTruthy();
    }
  });

  // ─── I6 — matrix total equals canonical set size ─────────────────────
  it('I6: matrix total equals |catalog ∪ switch|', () => {
    const total = totalCanonicalInMatrix();

    // At HEAD 2026-04-23 post LOTE M: catalog=81, switch=22, canonical=103.
    // This test does NOT pin to any number — the catalog grows. It pins
    // the structural identity: every canonical id is classified exactly
    // once, which implies the matrix total equals the canonical set size.
    expect(total).toBe(canonicalIds.size);
  });

  // ─── Stale narrative rejection (Option A pin) ────────────────────────
  it('Option A is pinned: live-validation bucket is non-empty', () => {
    // This is the codified refutation of the "0 probes this session"
    // claim. The consolidation decision (2026-04-23) chose Option A:
    // accept the 41 probes emitted during that session as valid
    // evidence. If live-validation is empty, someone has silently
    // rewound to Option B without following the documented process
    // (flip the matrix consistently, retire the old historical claim
    // list, and update the module docstring).
    expect(CONSOLIDATION_MATRIX['live-validation'].length).toBeGreaterThan(0);
  });

  // ─── Sub-classification partitions credentials-missing exactly ───────
  it('credentials-missing sub-class partitions the bucket exactly', () => {
    // Every provider in CONSOLIDATION_MATRIX['credentials-missing'] MUST
    // appear in exactly one sub-class, and the total of all sub-classes
    // equals the bucket size. This prevents opaque "credentials-missing"
    // triage — every provider in the bucket must be tagged with WHY it
    // cannot be exercised (absent secret vs placeholder vs localhost
    // unreachable vs auth-incomplete).
    const bucketIds = new Set(CONSOLIDATION_MATRIX['credentials-missing']);
    const subClassIds = new Set<string>();
    const doubleTagged: string[] = [];

    for (const [subClass, ids] of Object.entries(CREDENTIALS_MISSING_SUBCLASS)) {
      for (const id of ids) {
        // No provider may be tagged with two sub-classes.
        if (subClassIds.has(id)) {
          doubleTagged.push(`${id} (re-tagged under ${subClass})`);
        }
        subClassIds.add(id);
      }
    }

    expect(doubleTagged).toEqual([]);

    // Every sub-class entry must be in the credentials-missing bucket
    // (a sub-class is a refinement of the bucket, not a fork of it).
    const strayFromBucket: string[] = [];
    for (const id of subClassIds) {
      if (!bucketIds.has(id)) strayFromBucket.push(id);
    }
    expect(strayFromBucket).toEqual([]);

    // And the converse: every bucket member must appear in exactly one
    // sub-class. If this fires, a new provider landed in
    // credentials-missing without being sub-classified.
    const untagged: string[] = [];
    for (const id of bucketIds) {
      if (!subClassIds.has(id)) untagged.push(id);
    }
    expect(untagged).toEqual([]);

    // Size identity: sub-class ∪ = bucket
    expect(subClassIds.size).toBe(bucketIds.size);
  });
});
