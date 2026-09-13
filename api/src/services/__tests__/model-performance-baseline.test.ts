// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression suite for the discovery PLACEHOLDER that overwrote measured
 * performance on every sync.
 *
 * Discovery wrote the literal `{latencyMs:1000, throughput:100, quality:0.8,
 * reliability:0.95}` for every model and the upsert used
 * `performance = EXCLUDED.performance`. PR #420 preserved the measurement and
 * was reverted (b7cb7ee0) because preservation alone made ranking worse: one
 * field carried a measured score and an optimistic constant on the same axis,
 * so `ORDER BY quality DESC` started deterministically preferring models that
 * had never run.
 *
 * These tests pin the three properties that make preservation safe:
 * provenance, a prior calibrated on the measured population, and an upsert rule
 * that refreshes a prior but never a measurement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRaw = vi.fn();

vi.mock('@/database/client', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
  },
}));

import {
  buildMeasuredPerformanceStamp,
  FALLBACK_PRIOR_LATENCY_MS,
  FALLBACK_PRIOR_QUALITY,
  FALLBACK_PRIOR_RELIABILITY,
  getDiscoveryPerformancePrior,
  getMeasuredPerformanceBaseline,
  isMeasuredPerformance,
  MODEL_UPSERT_PERFORMANCE_SET,
  PERFORMANCE_SOURCE_MEASURED,
  PERFORMANCE_SOURCE_PRIOR,
  resetMeasuredPerformanceBaselineCache,
} from '@/services/model-performance-baseline';

describe('model-performance-baseline', () => {
  beforeEach(() => {
    queryRaw.mockReset();
    resetMeasuredPerformanceBaselineCache();
  });

  describe('isMeasuredPerformance', () => {
    it('recognises a measured record by source or by sample count', () => {
      expect(isMeasuredPerformance({ source: PERFORMANCE_SOURCE_MEASURED })).toBe(true);
      expect(isMeasuredPerformance({ samples: 12 })).toBe(true);
    });

    it('treats a discovery prior as not measured', () => {
      expect(isMeasuredPerformance({ source: PERFORMANCE_SOURCE_PRIOR, samples: 0 })).toBe(false);
    });

    it('treats legacy provenance-less records as not measured', () => {
      // Pre-fix rows carry no marker at all. Calling them "measured" would
      // freeze the very constant this change is removing.
      expect(isMeasuredPerformance({ latencyMs: 1000, quality: 0.8, reliability: 0.95 })).toBe(
        false
      );
      expect(isMeasuredPerformance({})).toBe(false);
      expect(isMeasuredPerformance(null)).toBe(false);
      expect(isMeasuredPerformance('measured')).toBe(false);
    });
  });

  describe('getDiscoveryPerformancePrior', () => {
    it('falls back to the historical constants when nothing has been measured', async () => {
      // Day-one behaviour must be byte-identical to before the change, or the
      // calibration itself becomes a ranking change nobody measured.
      queryRaw.mockResolvedValue([{ quality: null, reliability: null, measured: 0 }]);

      const prior = await getDiscoveryPerformancePrior();

      expect(prior.quality).toBe(FALLBACK_PRIOR_QUALITY);
      expect(prior.reliability).toBe(FALLBACK_PRIOR_RELIABILITY);
      expect(prior.latencyMs).toBe(FALLBACK_PRIOR_LATENCY_MS);
      expect(prior.calibrated).toBe(false);
    });

    it('centres the prior on the measured population once measurements exist', async () => {
      // The whole point: an unmeasured model must sit at the CENTRE of what
      // measurement actually produces, so a measured-good model outranks it and
      // a measured-bad model sinks below it. A hardcoded 0.8 sat above almost
      // every real score, which is what inverted the ranking.
      queryRaw.mockResolvedValue([{ quality: 0.54, reliability: 0.81, measured: 42 }]);

      const prior = await getDiscoveryPerformancePrior();

      expect(prior.quality).toBe(0.54);
      expect(prior.reliability).toBe(0.81);
      expect(prior.calibrated).toBe(true);
    });

    it('always labels its output as a prior with zero samples', async () => {
      queryRaw.mockResolvedValue([{ quality: 0.54, reliability: 0.81, measured: 42 }]);

      const prior = await getDiscoveryPerformancePrior();

      expect(prior.source).toBe(PERFORMANCE_SOURCE_PRIOR);
      expect(prior.samples).toBe(0);
      expect(prior.measuredAt).toBeNull();
    });

    it('does not carry a throughput value', async () => {
      // No writer for `throughput` exists anywhere in the codebase, so there is
      // nothing to feed it. Documented, not replaced with another invented
      // constant. Safe because the sole consumer already defaults it itself:
      // ORDER BY ... COALESCE((performance->>'throughput')::numeric, 100).
      queryRaw.mockResolvedValue([{ quality: null, reliability: null, measured: 0 }]);

      const prior = await getDiscoveryPerformancePrior();

      expect(prior).not.toHaveProperty('throughput');
    });

    it('falls back rather than failing when the catalog is unreachable', async () => {
      queryRaw.mockRejectedValue(new Error('connection terminated'));

      const prior = await getDiscoveryPerformancePrior();

      expect(prior.quality).toBe(FALLBACK_PRIOR_QUALITY);
      expect(prior.calibrated).toBe(false);
    });

    it('memoises the baseline so a sync does not re-scan per batch', async () => {
      queryRaw.mockResolvedValue([{ quality: 0.6, reliability: 0.9, measured: 3 }]);

      await getMeasuredPerformanceBaseline();
      await getMeasuredPerformanceBaseline();
      await getDiscoveryPerformancePrior();

      expect(queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('MODEL_UPSERT_PERFORMANCE_SET', () => {
    it('never restores the destructive assignment', () => {
      // The forward guard: `performance = EXCLUDED.performance` is what
      // silently destroyed measured data for months while every test passed.
      expect(MODEL_UPSERT_PERFORMANCE_SET).not.toContain('performance = EXCLUDED.performance');
    });

    it('keeps the row when it carries a measurement and takes the incoming prior otherwise', () => {
      expect(MODEL_UPSERT_PERFORMANCE_SET).toContain('THEN models.performance');
      expect(MODEL_UPSERT_PERFORMANCE_SET).toContain('ELSE EXCLUDED.performance');
      expect(MODEL_UPSERT_PERFORMANCE_SET).toContain(PERFORMANCE_SOURCE_MEASURED);
      expect(MODEL_UPSERT_PERFORMANCE_SET).toContain("(models.performance->>'samples')::numeric");
    });
  });

  describe('buildMeasuredPerformanceStamp', () => {
    it('marks the record measured and dates it', () => {
      const stamp = buildMeasuredPerformanceStamp({}, 4);

      expect(stamp.source).toBe(PERFORMANCE_SOURCE_MEASURED);
      expect(stamp.samples).toBe(4);
      expect(Number.isNaN(Date.parse(stamp.measuredAt))).toBe(false);
    });

    it('accumulates samples across updates', () => {
      const first = buildMeasuredPerformanceStamp({ samples: 10 }, 5);
      expect(first.samples).toBe(15);
    });

    it('ignores a non-numeric or negative prior sample count', () => {
      expect(buildMeasuredPerformanceStamp({ samples: 'lots' }, 2).samples).toBe(2);
      expect(buildMeasuredPerformanceStamp({ samples: -7 }, 2).samples).toBe(2);
      expect(buildMeasuredPerformanceStamp(null, 2).samples).toBe(2);
    });

    it('counts at least one observation', () => {
      expect(buildMeasuredPerformanceStamp({}, 0).samples).toBe(1);
      expect(buildMeasuredPerformanceStamp({}).samples).toBe(1);
    });
  });
});
