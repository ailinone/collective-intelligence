// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression coverage: ranking must never treat an unmeasured discovery
 * prior as if it were a measurement.
 *
 * Two real defects are locked here.
 *
 * 1. THE PLACEBO SORT (today's production state). `bulkUpsertModels`
 *    writes the identical performance record for EVERY discovered model,
 *    so `b.performance.quality - a.performance.quality` returns 0 for
 *    every pair and the sort is a no-op. The executor pick silently
 *    degrades to whatever order the catalog query returned, while the
 *    code reads as a quality ranking. Probed as a 29% error rate on a
 *    trivially checkable prompt ("17x23") in chat#55.
 *
 * 2. THE INVERSION (what got PR #420 reverted, b7cb7ee0). A measured
 *    score typically lands BELOW the optimistic discovery prior, so once
 *    measurements survive the upsert, `quality DESC` deterministically
 *    prefers models with NO execution history over models measured to be
 *    good.
 *
 * The fixtures below use the ACTUAL discovery payload
 * (`{latencyMs:1000, throughput:100, quality:0.8, reliability:0.95}` —
 * central-model-discovery-service.ts) rather than an invented one, so
 * these tests fail if the ranking regresses to raw-quality ordering
 * against real catalog data.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Model } from '@/types';
import { rankByCalibratedQuality, classifyQualityProvenance } from './quality-ranking';

/**
 * The literal record discovery writes for every model it finds. Copied
 * from central-model-discovery-service.ts so a change there surfaces
 * here.
 */
const DISCOVERY_PRIOR = {
  latencyMs: 1000,
  throughput: 100,
  quality: 0.8,
  reliability: 0.95,
} as const;

function priorModel(id: string): Model {
  return { id, performance: { ...DISCOVERY_PRIOR } } as unknown as Model;
}

function measuredModel(id: string, quality: number, extra: Record<string, unknown> = {}): Model {
  return {
    id,
    performance: {
      latencyMs: 900,
      reliability: 0.9,
      quality,
      lastValidated: new Date('2026-09-01T00:00:00Z'),
      ...extra,
    },
  } as unknown as Model;
}

/** The comparator this replaces, kept verbatim to prove the difference. */
const rawQualityComparator = (a: Model, b: Model): number =>
  (b as unknown as { performance: { quality: number } }).performance.quality -
  (a as unknown as { performance: { quality: number } }).performance.quality;

const idsOf = (models: readonly Model[]): string[] => models.map((m) => m.id);

describe('rankByCalibratedQuality — provenance classification', () => {
  it('treats a record with no provenance at all as a prior, not evidence', () => {
    expect(classifyQualityProvenance(priorModel('m'))).toBe('prior');
  });

  it('reads an explicit measured/prior stamp when the write layer supplies one', () => {
    const measured = {
      id: 'a',
      performance: { quality: 0.7, source: 'measured', samples: 4 },
    } as unknown as Model;
    const prior = {
      id: 'b',
      performance: { quality: 0.8, source: 'discovery_prior', samples: 0 },
    } as unknown as Model;

    expect(classifyQualityProvenance(measured)).toBe('measured');
    expect(classifyQualityProvenance(prior)).toBe('prior');
  });

  it('lets an explicit prior stamp override a stale validation timestamp', () => {
    // A record that says it is a prior IS a prior, even carrying a
    // leftover lastValidated — otherwise a re-synced row would be
    // mistaken for evidence.
    const restamped = {
      id: 'a',
      performance: {
        quality: 0.8,
        source: 'discovery_prior',
        lastValidated: new Date('2026-09-01T00:00:00Z'),
      },
    } as unknown as Model;

    expect(classifyQualityProvenance(restamped)).toBe('prior');
  });

  it('treats a zero sample count as a prior and a positive one as measured', () => {
    const zero = { id: 'a', performance: { quality: 0.8, samples: 0 } } as unknown as Model;
    const some = { id: 'b', performance: { quality: 0.8, samples: 1 } } as unknown as Model;

    expect(classifyQualityProvenance(zero)).toBe('prior');
    expect(classifyQualityProvenance(some)).toBe('measured');
  });

  it('accepts a validation timestamp as a Date or a serialized string', () => {
    expect(classifyQualityProvenance(measuredModel('a', 0.7))).toBe('measured');

    const serialized = {
      id: 'b',
      performance: { quality: 0.7, lastValidated: '2026-09-01T00:00:00Z' },
    } as unknown as Model;
    expect(classifyQualityProvenance(serialized)).toBe('measured');
  });

  it('rejects an unparseable validation timestamp instead of trusting it', () => {
    const junk = {
      id: 'a',
      performance: { quality: 0.7, lastValidated: 'not-a-date' },
    } as unknown as Model;
    expect(classifyQualityProvenance(junk)).toBe('prior');
  });
});

describe('rankByCalibratedQuality — the placebo sort (all-prior pool)', () => {
  // Exactly today's catalog: every row carries the discovery constant.
  const pool = ['model-a', 'model-b', 'model-c', 'model-d'].map(priorModel);

  it('reports the pool as uninformative rather than implying a merit ranking', () => {
    const ranking = rankByCalibratedQuality(pool);

    expect(ranking.informative).toBe(false);
    expect(ranking.measuredCount).toBe(0);
    expect(ranking.priorCount).toBe(pool.length);
  });

  it('proves the old comparator was a no-op on this pool', () => {
    // Every pairwise difference is 0, so the "quality sort" preserved
    // input order — i.e. it ranked by catalog recency, not quality.
    const forward = [...pool].sort(rawQualityComparator);
    const reversed = [...pool].reverse().sort(rawQualityComparator);

    expect(idsOf(forward)).toEqual(['model-a', 'model-b', 'model-c', 'model-d']);
    expect(idsOf(reversed)).toEqual(['model-d', 'model-c', 'model-b', 'model-a']);
  });

  it('produces the same order regardless of the order the catalog returned', () => {
    const { comparator } = rankByCalibratedQuality(pool);

    const forward = idsOf([...pool].sort(comparator));
    const reversed = idsOf([...pool].reverse().sort(comparator));
    const shuffled = idsOf(
      [pool[2], pool[0], pool[3], pool[1]].sort(rankByCalibratedQuality(pool).comparator)
    );

    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });
});

describe('rankByCalibratedQuality — measurement vs prior', () => {
  it('ranks a measured-good model above an unmeasured prior', () => {
    // Two measurements so the calibration point (median 0.715) sits
    // strictly below the good one — otherwise a single measurement would
    // BE the median and the two would tie, proving nothing.
    const pool = [
      priorModel('prior-a'),
      measuredModel('measured-good', 0.93),
      measuredModel('measured-weak', 0.5),
    ];
    const { comparator } = rankByCalibratedQuality(pool);

    expect(idsOf([...pool].sort(comparator))).toEqual([
      'measured-good',
      'prior-a',
      'measured-weak',
    ]);
  });

  it('does not claim an unmeasured model is worse when there is only one measurement', () => {
    // Honest limit of median calibration: with a single measured
    // candidate the median IS that candidate, so the prior ties with it
    // and the order falls to the deterministic tie-break. The system
    // must not invent a ranking it has no evidence for.
    const pool = [priorModel('zzz-prior'), measuredModel('aaa-measured', 0.93)];
    const { comparator } = rankByCalibratedQuality(pool);

    expect(idsOf([...pool].sort(comparator))).toEqual(['aaa-measured', 'zzz-prior']);
  });

  it('does NOT let the optimistic prior outrank a measured model below it (PR #420 revert)', () => {
    // The exact inversion the revert measured: measurements cluster
    // BELOW the 0.8 discovery constant, so raw quality DESC puts the
    // never-executed model first.
    const pool = [
      priorModel('never-measured'),
      measuredModel('measured-best', 0.75),
      measuredModel('measured-mid', 0.72),
      measuredModel('measured-low', 0.7),
    ];

    // Old behaviour: the prior wins on its nominal 0.8.
    expect(idsOf([...pool].sort(rawQualityComparator))[0]).toBe('never-measured');

    // New behaviour: the prior is placed at the median of the measured
    // population (0.72), so the model measured at 0.75 outranks it.
    const { comparator } = rankByCalibratedQuality(pool);
    const ordered = idsOf([...pool].sort(comparator));

    expect(ordered[0]).toBe('measured-best');
    expect(ordered.indexOf('never-measured')).toBeGreaterThan(ordered.indexOf('measured-best'));
  });

  it('sinks a measured-bad model below an unmeasured prior', () => {
    // The other direction of the same rule: a prior is not evidence of
    // being bad either, so demonstrated poor quality ranks below unknown.
    const pool = [
      measuredModel('measured-bad', 0.2),
      measuredModel('measured-ok', 0.8),
      priorModel('unknown'),
    ];
    const { comparator } = rankByCalibratedQuality(pool);
    const ordered = idsOf([...pool].sort(comparator));

    expect(ordered.indexOf('unknown')).toBeLessThan(ordered.indexOf('measured-bad'));
  });

  it('is identical to a plain quality sort when every candidate is measured', () => {
    const pool = [measuredModel('c', 0.5), measuredModel('a', 0.9), measuredModel('b', 0.7)];
    const { comparator, informative } = rankByCalibratedQuality(pool);

    expect(informative).toBe(true);
    expect(idsOf([...pool].sort(comparator))).toEqual(idsOf([...pool].sort(rawQualityComparator)));
  });

  it('calibrates on an even-sized measured population without inventing a value', () => {
    // Median of {0.6, 0.8} is 0.7, so a prior sits between the two.
    const pool = [measuredModel('low', 0.6), measuredModel('high', 0.8), priorModel('unknown')];
    const { comparator } = rankByCalibratedQuality(pool);

    expect(idsOf([...pool].sort(comparator))).toEqual(['high', 'unknown', 'low']);
  });
});

describe('rankByCalibratedQuality — tie-breaks cannot smuggle the placeholder back in', () => {
  it('never breaks a cross-provenance tie using the prior optimistic reliability', () => {
    // The discovery prior claims reliability 0.95; a measured model here
    // reports a real 0.90. Their calibrated quality keys tie (the prior
    // sits at the median of a single-measurement population). If the
    // tie-break compared reliability across provenance, the placeholder
    // 0.95 would beat the measurement — the same defect one level down.
    const measured = measuredModel('aaa-measured', 0.8, { reliability: 0.9 });
    const prior = priorModel('zzz-prior');
    const pool = [prior, measured];

    const { comparator } = rankByCalibratedQuality(pool);
    const ordered = idsOf([...pool].sort(comparator));

    // Falls through to the deterministic id tie-break, NOT to the
    // placeholder's inflated reliability.
    expect(ordered).toEqual(['aaa-measured', 'zzz-prior']);
  });

  it('does use reliability then latency to break a tie between same-provenance candidates', () => {
    const pool = [
      measuredModel('slow', 0.8, { reliability: 0.9, latencyMs: 2000 }),
      measuredModel('unreliable', 0.8, { reliability: 0.5, latencyMs: 100 }),
      measuredModel('fast', 0.8, { reliability: 0.9, latencyMs: 200 }),
    ];
    const { comparator } = rankByCalibratedQuality(pool);

    expect(idsOf([...pool].sort(comparator))).toEqual(['fast', 'slow', 'unreliable']);
  });
});

describe('rankByCalibratedQuality — degenerate inputs', () => {
  it('handles an empty pool', () => {
    const ranking = rankByCalibratedQuality([]);

    expect(ranking.informative).toBe(false);
    expect(ranking.measuredCount).toBe(0);
    expect(ranking.priorCount).toBe(0);
    expect(([] as Model[]).sort(ranking.comparator)).toEqual([]);
  });

  it('does not crash or rank on a missing performance record', () => {
    const pool = [{ id: 'no-perf' } as unknown as Model, priorModel('prior')];
    const { comparator, informative } = rankByCalibratedQuality(pool);

    expect(informative).toBe(false);
    expect(idsOf([...pool].sort(comparator))).toEqual(['no-perf', 'prior']);
  });

  it('ignores a non-finite quality instead of propagating NaN through the sort', () => {
    const pool = [
      {
        id: 'nan',
        performance: { quality: Number.NaN, lastValidated: new Date() },
      } as unknown as Model,
      measuredModel('real', 0.6),
    ];
    const { comparator } = rankByCalibratedQuality(pool);
    const ordered = idsOf([...pool].sort(comparator));

    expect(ordered).toEqual(['real', 'nan']);
  });

  it('counts a measured record with no usable score as measured but not as calibration data', () => {
    const pool = [
      { id: 'stamped', performance: { source: 'measured' } } as unknown as Model,
      priorModel('prior'),
    ];
    const ranking = rankByCalibratedQuality(pool);

    expect(ranking.measuredCount).toBe(1);
    expect(ranking.priorCount).toBe(1);
    // No usable measured score, so there is nothing to calibrate against.
    expect(ranking.informative).toBe(false);
  });
});

/**
 * Forward guard, mirroring the repo's wiring-test idiom
 * (preferred-model-honor-wiring.test.ts): the regression mode here is
 * silent. A refactor that re-inlines `b.performance.quality -
 * a.performance.quality` compiles, boots and passes every behavioural
 * test — the pool just quietly goes back to catalog order. Lock the
 * textual reference so the revert has to be deliberate.
 */
describe('HybridStrategy wiring — executor ranking must stay calibrated', () => {
  const source = readFileSync(join(__dirname, 'hybrid-strategy.ts'), 'utf-8');

  it('ranks executors through rankByCalibratedQuality', () => {
    expect(source).toContain("from './quality-ranking'");
    expect(source).toContain('rankByCalibratedQuality(preference.fallbackPool)');
    expect(source).toContain('assembleExecutors(preference, 2, ranking.comparator)');
  });

  it('no longer compares raw performance.quality directly', () => {
    // The exact expression this change removes, in the whitespace-
    // insensitive form a formatter might leave behind.
    const rawComparator = /performance\??\.quality\s*-\s*\w+\.performance\??\.quality/;
    expect(rawComparator.test(source)).toBe(false);
  });
});
