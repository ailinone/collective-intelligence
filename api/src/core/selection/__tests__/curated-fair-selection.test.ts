// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pure-function coverage for selectCuratedFairUids (2026-09-07 provider-
 * fairness follow-up to the bucket-fair catalog-visibility fix).
 *
 * Deliberately does NOT mock Prisma or import DynamicModelSelector — this
 * exercises the fairness ranking algorithm directly against synthetic
 * CuratedBucketRow[] snapshots, which (a) makes the fairness guarantees
 * themselves trivial to assert precisely, and (b) lets the scale/perf case
 * run against a genuinely large synthetic dataset without needing a real
 * database, a mocked one, or the ~5-6s module-graph import cost documented in
 * bucket-fair-candidate-retrieval.test.ts.
 *
 * A real catalog snapshot showed one non-premium aggregator supplying the
 * large majority of the curated bucket, while several premium providers
 * each supplied only a handful of rows. A plain `ORDER BY usage_count DESC
 * LIMIT 400` over that shape (every row tied at usage_count=0) returns
 * effectively 100% of the dominant aggregator in production: the exact
 * failure this module fixes.
 */

import { describe, expect, it } from 'vitest';
import {
  selectCuratedFairUids,
  type CuratedBucketRow,
} from '@/core/selection/dynamic-model-selector';

function row(uid: string, providerId: string, overrides: Partial<CuratedBucketRow> = {}): CuratedBucketRow {
  return {
    uid,
    providerId,
    providerName: providerId,
    contextWindow: 128_000,
    usageCount: 0,
    ...overrides,
  };
}

describe('selectCuratedFairUids', () => {
  it('a single dominant provider cannot consume the whole curated take', () => {
    const minorityProviders = ['openai', 'anthropic', 'google', 'xai', 'cohere', 'deepseek'];
    const dominant = Array.from({ length: 5_000 }, (_, i) => row(`dominant-${i}`, 'dominant'));
    const minorities = minorityProviders.map((p) => row(`${p}-0`, p));

    const result = selectCuratedFairUids([...dominant, ...minorities], {}, 400, 0.15);

    // Every minority provider must be reachable.
    for (const p of minorityProviders) {
      expect(result.uids).toContain(`${p}-0`);
    }
    // The dominant provider must be capped at ceil(400 * 0.15) = 60 rows —
    // even though it has 5,000 rows available and the minorities have only 1
    // each, leaving the overall output small (66) and so, unavoidably, still
    // dominant-majority BY SHARE. The cap operates on absolute row count, not
    // on the resulting share once genuine diversity is this thin — see "a
    // hard cap can legitimately under-fill curatedTake..." below for the
    // dedicated test of that distinction.
    const dominantCount = result.uids.filter((u) => u.startsWith('dominant-')).length;
    expect(dominantCount).toBe(60);
    expect(result.distinctProviders).toBe(7); // dominant + 6 minorities
    expect(result.uids.length).toBe(66); // 60 (capped) + 6 minorities' full (thin) supply
  });

  it('reproduces a dominant-aggregator curated-bucket ratio and still surfaces every premium provider', () => {
    // A synthetic top-of-bucket shape modeled on a real production ratio:
    // one non-premium aggregator dominates the curated bucket, with enough
    // of the real "long tail" included that curatedTake=400 is reachable
    // through FAIR round-robin alone, exactly as it is in the real
    // many-provider bucket (this is what makes the cap a genuine non-issue
    // under realistic diversity, and only a real concern in the
    // pathological few-providers case covered by the next test).
    const dominant = Array.from({ length: 22_144 }, (_, i) => row(`dominant-${i}`, 'dominant-aggregator'));
    const others = [
      ...Array.from({ length: 136 }, (_, i) => row(`openai-${i}`, 'openai')),
      ...Array.from({ length: 15 }, (_, i) => row(`anthropic-${i}`, 'anthropic')),
      ...Array.from({ length: 12 }, (_, i) => row(`google-${i}`, 'google')),
      ...Array.from({ length: 21 }, (_, i) => row(`xai-${i}`, 'xai')),
      ...Array.from({ length: 35 }, (_, i) => row(`cohere-${i}`, 'cohere')),
      ...Array.from({ length: 3 }, (_, i) => row(`deepseek-${i}`, 'deepseek')),
      ...Array.from({ length: 1464 }, (_, i) => row(`minor-1-${i}`, 'minor-aggregator-1')),
      ...Array.from({ length: 1292 }, (_, i) => row(`minor-2-${i}`, 'minor-aggregator-2')),
      ...Array.from({ length: 1013 }, (_, i) => row(`minor-3-${i}`, 'minor-aggregator-3')),
      ...Array.from({ length: 879 }, (_, i) => row(`minor-4-${i}`, 'minor-aggregator-4')),
    ];

    const result = selectCuratedFairUids([...dominant, ...others], {}, 400, 0.15);

    for (const p of ['openai', 'anthropic', 'google', 'xai', 'cohere', 'deepseek']) {
      expect(result.uids.some((u) => u.startsWith(`${p}-`))).toBe(true);
    }
    const dominantCount = result.uids.filter((u) => u.startsWith('dominant-')).length;
    expect(dominantCount).toBeLessThanOrEqual(60);
    expect(result.uids.length).toBe(400);
  });

  it('a hard cap can legitimately under-fill curatedTake when real provider diversity is too thin — never relaxed', () => {
    // Only 2 providers, each with plenty of rows, cap=15% of 400=60 → the
    // most this can EVER fairly supply is 2*60=120. Relaxing the cap to hit
    // exactly 400 here would mean one (or both) of these 2 providers supplies
    // far more than 15% of the output — exactly the class of bug this
    // mechanism exists to prevent. An under-filled-but-fair 120 is the
    // correct outcome; the caller's own never-collapse fallback (triggered
    // well below 120) is what covers genuine emptiness, not this function.
    const providerA = Array.from({ length: 500 }, (_, i) => row(`a-${i}`, 'provider-a'));
    const providerB = Array.from({ length: 500 }, (_, i) => row(`b-${i}`, 'provider-b'));

    const result = selectCuratedFairUids([...providerA, ...providerB], {}, 400, 0.15);

    expect(result.uids.length).toBe(120); // 2 providers * cap 60, cap NEVER relaxed
    expect(result.distinctProviders).toBe(2);
    expect(result.uids.filter((u) => u.startsWith('a-')).length).toBe(60);
    expect(result.uids.filter((u) => u.startsWith('b-')).length).toBe(60);
  });

  it('respects contextSize and provider include/exclude filters', () => {
    const rows = [
      row('small-ctx', 'openai', { contextWindow: 4_000 }),
      row('big-ctx', 'openai', { contextWindow: 200_000 }),
      row('excluded-provider', 'excluded', { contextWindow: 200_000 }),
    ];

    const result = selectCuratedFairUids(rows, { contextSize: 100_000, excludeProviderNames: ['excluded'] }, 400, 0.15);

    expect(result.uids).toEqual(['big-ctx']);
  });

  it('include-list filter narrows to the named providers only (expected 100% share, not a bug)', () => {
    const rows = [row('a', 'provider-a'), row('b', 'provider-b')];
    const result = selectCuratedFairUids(rows, { includeProviderNames: ['provider-a'] }, 400, 0.15);
    expect(result.uids).toEqual(['a']);
    expect(result.topProviderShare).toBe(1);
  });

  it('is deterministic: repeated calls over the same (all-tied-at-zero) input produce the same order', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`p${i % 5}-row${i}`, `p${i % 5}`));
    const first = selectCuratedFairUids(rows, {}, 400, 0.15).uids;
    const second = selectCuratedFairUids(rows, {}, 400, 0.15).uids;
    expect(second).toEqual(first);
  });

  it('a boundary round that cuts off before every provider gets a turn is NOT decided by arbitrary row-scan order (adversarial re-review, 2026-09-07)', () => {
    // The curated-bucket snapshot's raw SQL has no ORDER BY (a deliberate
    // perf choice), so byProvider's Map-insertion order reflects Postgres's
    // own (unordered, scan-dependent) row order, not anything usage-based.
    // With more distinct providers than curatedTake can fully round-robin
    // through, the terminal round is necessarily partial — build the SAME
    // set of rows in several different arrival orders and confirm the
    // output set (not merely repeated-call determinism over ONE fixed
    // order, which the previous test already covers) doesn't depend on
    // which order the snapshot happened to scan providers in.
    const providerIds = Array.from({ length: 50 }, (_, i) => `provider-${String(i).padStart(2, '0')}`);
    // Every provider has exactly 1 row → curatedTake=10 forces the round-0
    // round-robin to cut off after exactly 10 of the 50 providers.
    const baseRows = providerIds.map((p) => row(`${p}-row`, p));

    function shuffled(seed: number): CuratedBucketRow[] {
      const arr = [...baseRows];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = (i * 2654435761 + seed * 40503) % (i + 1);
        const k = Math.abs(j) % (i + 1);
        [arr[i], arr[k]] = [arr[k], arr[i]];
      }
      return arr;
    }

    const arrivalOrderA = selectCuratedFairUids(shuffled(1), {}, 10, 0.15).uids;
    const arrivalOrderB = selectCuratedFairUids(shuffled(2), {}, 10, 0.15).uids;
    const arrivalOrderC = selectCuratedFairUids(shuffled(3), {}, 10, 0.15).uids;

    expect(new Set(arrivalOrderB)).toEqual(new Set(arrivalOrderA));
    expect(new Set(arrivalOrderC)).toEqual(new Set(arrivalOrderA));
    // And it picks the lexicographically-first 10 provider ids, not merely
    // "some" stable-but-unspecified 10 — pins the actual tie-break rule.
    expect([...arrivalOrderA].sort()).toEqual(
      providerIds.slice(0, 10).map((p) => `${p}-row`)
    );
  });

  it('empty input yields an empty, well-formed result', () => {
    const result = selectCuratedFairUids([], {}, 400, 0.15);
    expect(result).toEqual({ uids: [], distinctProviders: 0, topProviderShare: 0 });
  });

  it('performs well at real-catalog scale (150k rows, 300 providers) — fast, in-memory, no DB round trip', () => {
    const providerCount = 300;
    const rows: CuratedBucketRow[] = [];
    for (let p = 0; p < providerCount; p++) {
      // Skewed distribution: a handful of large providers, a long tail of
      // small ones — mirrors the real catalog's shape better than a uniform
      // split, and stresses the round-robin/backfill logic more.
      const count = p < 5 ? 20_000 : 200;
      for (let i = 0; i < count; i++) {
        rows.push(row(`p${p}-${i}`, `provider-${p}`, { usageCount: Math.floor(Math.random() * 100) }));
      }
    }
    expect(rows.length).toBeGreaterThan(100_000);

    const start = performance.now();
    const result = selectCuratedFairUids(rows, { contextSize: 8_000 }, 400, 0.15);
    const elapsedMs = performance.now() - start;

    expect(result.uids.length).toBe(400);
    expect(result.distinctProviders).toBeGreaterThan(1);
    // Generous bound for CI-machine variance — the point is "single-digit to
    // low-double-digit ms, not hundreds of ms", which is what makes this
    // mechanism viable on the request hot path in the first place (contrast
    // with the ~195-785ms measured for a live/local SQL window-function
    // equivalent over a comparable bucket size — see the module doc in
    // dynamic-model-selector.ts).
    expect(elapsedMs).toBeLessThan(500);
  });
});
