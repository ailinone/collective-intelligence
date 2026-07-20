// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INACTIVE_DAYS,
  DEFAULT_STALE_HOURS,
  DEFAULT_UNIVERSE_ENV_VAR,
  HISTORICAL_UNIVERSE_WHERE,
  INVENTORY_LIFECYCLE_STATUSES,
  LIVE_UNIVERSE_WHERE,
  POLICY_SUMMARY,
  classifyExpressionSql,
  getClassifierLastEvaluatedAt,
  reasonExpressionSql,
  resolveDefaultUniverse,
  resolveLifecycleThresholds,
  resolveUniverseWhere,
  shouldFallbackToHistorical,
} from '../inventory-lifecycle-policy';

describe('inventory-lifecycle-policy', () => {
  describe('closed enum of statuses', () => {
    it('exposes exactly active/stale/inactive in stable order', () => {
      expect(INVENTORY_LIFECYCLE_STATUSES).toEqual(['active', 'stale', 'inactive']);
    });
  });

  describe('resolveLifecycleThresholds — defaults', () => {
    it('returns canonical defaults when env overrides are absent', () => {
      const t = resolveLifecycleThresholds({});
      expect(t.staleHours).toBe(DEFAULT_STALE_HOURS);
      expect(t.inactiveDays).toBe(DEFAULT_INACTIVE_DAYS);
    });

    it('accepts valid numeric overrides', () => {
      const t = resolveLifecycleThresholds({ STALE_HOURS: '24', INACTIVE_DAYS: '14' });
      expect(t.staleHours).toBe(24);
      expect(t.inactiveDays).toBe(14);
    });
  });

  describe('resolveLifecycleThresholds — invariant enforcement', () => {
    it('I1: rejects STALE_HOURS <= 0', () => {
      expect(() => resolveLifecycleThresholds({ STALE_HOURS: '0' })).toThrow(/STALE_HOURS/);
      expect(() => resolveLifecycleThresholds({ STALE_HOURS: '-1' })).toThrow(/STALE_HOURS/);
    });

    it('I1: rejects non-numeric STALE_HOURS', () => {
      expect(() => resolveLifecycleThresholds({ STALE_HOURS: 'abc' })).toThrow(/STALE_HOURS/);
    });

    it('I2: rejects INACTIVE_DAYS <= 0', () => {
      expect(() => resolveLifecycleThresholds({ INACTIVE_DAYS: '0' })).toThrow(/INACTIVE_DAYS/);
      expect(() =>
        resolveLifecycleThresholds({ STALE_HOURS: '12', INACTIVE_DAYS: '-1' }),
      ).toThrow(/INACTIVE_DAYS/);
    });

    it('I3: rejects thresholds where stale bucket would collapse', () => {
      // inactiveDays*24 must be strictly greater than staleHours.
      // 1 day * 24h = 24, STALE_HOURS=24 → boundary collapse.
      expect(() =>
        resolveLifecycleThresholds({ STALE_HOURS: '24', INACTIVE_DAYS: '1' }),
      ).toThrow(/stale.*bucket.*collapses|I3/i);
      // 48h vs 2d (=48h) — exact equality, collapse.
      expect(() =>
        resolveLifecycleThresholds({ STALE_HOURS: '48', INACTIVE_DAYS: '2' }),
      ).toThrow(/stale.*bucket.*collapses|I3/i);
    });

    it('I3: accepts the tightest valid ordering', () => {
      // 23h < 24h — valid.
      const t = resolveLifecycleThresholds({ STALE_HOURS: '23', INACTIVE_DAYS: '1' });
      expect(t.staleHours).toBe(23);
      expect(t.inactiveDays).toBe(1);
    });
  });

  describe('classifyExpressionSql', () => {
    it('produces a CASE expression with the three literal statuses in partition order', () => {
      const sql = classifyExpressionSql('updated_at', { staleHours: 48, inactiveDays: 7 });
      expect(sql).toMatch(/CASE\s+WHEN/);
      // Partition order matters for invariant I4.
      const activeIdx = sql.indexOf("'active'");
      const staleIdx = sql.indexOf("'stale'");
      const inactiveIdx = sql.indexOf("'inactive'");
      expect(activeIdx).toBeGreaterThan(-1);
      expect(staleIdx).toBeGreaterThan(activeIdx);
      expect(inactiveIdx).toBeGreaterThan(staleIdx);
      // Literal interpolation (not a bound param placeholder).
      expect(sql).toContain("INTERVAL '48 hours'");
      expect(sql).toContain("INTERVAL '7 days'");
    });

    it('respects a custom column name', () => {
      const sql = classifyExpressionSql('last_seen_at');
      expect(sql).toContain('last_seen_at >=');
      expect(sql).not.toContain('updated_at');
    });
  });

  describe('reasonExpressionSql', () => {
    it('emits NULL for active, a dated reason for stale, and a days-absent reason for inactive', () => {
      const sql = reasonExpressionSql('updated_at', { staleHours: 48, inactiveDays: 7 });
      expect(sql).toContain('NULL');
      expect(sql).toContain("'no-discovery-since:'");
      expect(sql).toContain("'absent-from-source-for>'");
      // Days number is inlined in the inactive reason string.
      expect(sql).toMatch(/absent-from-source-for>['\s|]*\s*\|\|\s*7/);
    });
  });

  describe('WHERE fragment constants', () => {
    it('LIVE_UNIVERSE_WHERE restricts to catalog-active AND lifecycle-active', () => {
      expect(LIVE_UNIVERSE_WHERE).toBe(
        "status = 'active' AND lifecycle_status = 'active'",
      );
    });

    it('HISTORICAL_UNIVERSE_WHERE restricts to catalog-active only', () => {
      expect(HISTORICAL_UNIVERSE_WHERE).toBe("status = 'active'");
    });

    it('LIVE is strictly more restrictive than HISTORICAL', () => {
      expect(LIVE_UNIVERSE_WHERE.length).toBeGreaterThan(HISTORICAL_UNIVERSE_WHERE.length);
      expect(LIVE_UNIVERSE_WHERE).toContain(HISTORICAL_UNIVERSE_WHERE);
    });
  });

  describe('POLICY_SUMMARY metadata', () => {
    it('references ADR-023 and carries a non-zero version', () => {
      expect(POLICY_SUMMARY.adr).toBe('ADR-023');
      expect(POLICY_SUMMARY.version).toBeGreaterThan(0);
      expect(POLICY_SUMMARY.grace.description).toBeTruthy();
      expect(POLICY_SUMMARY.grace.rationale).toBeTruthy();
      expect(POLICY_SUMMARY.runtime_override).toMatch(/STALE_HOURS|INACTIVE_DAYS/);
    });
  });

  describe('resolveDefaultUniverse', () => {
    it('falls back to historical when env is absent', () => {
      expect(resolveDefaultUniverse({})).toBe('historical');
    });

    it('honours HCRA_DEFAULT_UNIVERSE=live', () => {
      expect(resolveDefaultUniverse({ [DEFAULT_UNIVERSE_ENV_VAR]: 'live' })).toBe('live');
      expect(resolveDefaultUniverse({ [DEFAULT_UNIVERSE_ENV_VAR]: 'LIVE' })).toBe('live');
    });

    it('falls back to historical on unknown values', () => {
      expect(resolveDefaultUniverse({ [DEFAULT_UNIVERSE_ENV_VAR]: 'banana' })).toBe('historical');
    });
  });

  describe('shouldFallbackToHistorical', () => {
    const now = new Date('2026-04-24T12:00:00Z');

    it('forces fallback when the lifecycle column is missing', () => {
      const r = shouldFallbackToHistorical({
        lifecycleColumnExists: false,
        classifierLastEvaluatedAt: now,
        now,
      });
      expect(r.fallback).toBe(true);
      expect(r.reason).toBe('lifecycle_column_missing');
    });

    it('forces fallback when classifier has never run', () => {
      const r = shouldFallbackToHistorical({
        lifecycleColumnExists: true,
        classifierLastEvaluatedAt: null,
        now,
      });
      expect(r.fallback).toBe(true);
      expect(r.reason).toBe('classifier_never_ran');
    });

    it('forces fallback when classifier is older than the tolerance', () => {
      const r = shouldFallbackToHistorical({
        lifecycleColumnExists: true,
        // 10h ago, tolerance default 6h
        classifierLastEvaluatedAt: new Date(now.getTime() - 10 * 3600 * 1000),
        now,
      });
      expect(r.fallback).toBe(true);
      expect(r.reason).toBe('classifier_stale');
    });

    it('permits live when classifier is fresh', () => {
      const r = shouldFallbackToHistorical({
        lifecycleColumnExists: true,
        classifierLastEvaluatedAt: new Date(now.getTime() - 30 * 60 * 1000),
        now,
      });
      expect(r.fallback).toBe(false);
    });

    it('respects a caller-supplied tolerance', () => {
      const lastAt = new Date(now.getTime() - 2 * 3600 * 1000);
      // 2h ago, tolerance 1h → stale
      expect(
        shouldFallbackToHistorical({
          lifecycleColumnExists: true,
          classifierLastEvaluatedAt: lastAt,
          now,
          maxClassifierAgeHours: 1,
        }).fallback,
      ).toBe(true);
      // same data, tolerance 24h → fresh
      expect(
        shouldFallbackToHistorical({
          lifecycleColumnExists: true,
          classifierLastEvaluatedAt: lastAt,
          now,
          maxClassifierAgeHours: 24,
        }).fallback,
      ).toBe(false);
    });
  });

  describe('resolveUniverseWhere', () => {
    const freshNow = new Date('2026-04-24T12:00:00Z');
    const freshAt = new Date(freshNow.getTime() - 30 * 60 * 1000);

    it('returns historical when caller asks for historical', () => {
      const r = resolveUniverseWhere(
        {
          requested: 'historical',
          lifecycleColumnExists: true,
          classifierLastEvaluatedAt: freshAt,
          now: freshNow,
        },
        {},
      );
      expect(r.mode).toBe('historical');
      expect(r.sql).toBe(HISTORICAL_UNIVERSE_WHERE);
      expect(r.warning).toBeUndefined();
    });

    it('returns live when caller asks for live and signals are healthy', () => {
      const r = resolveUniverseWhere(
        {
          requested: 'live',
          lifecycleColumnExists: true,
          classifierLastEvaluatedAt: freshAt,
          now: freshNow,
        },
        {},
      );
      expect(r.mode).toBe('live');
      expect(r.sql).toBe(LIVE_UNIVERSE_WHERE);
      expect(r.warning).toBeUndefined();
    });

    it('falls back to historical with a warning when live is unsafe', () => {
      const r = resolveUniverseWhere(
        {
          requested: 'live',
          lifecycleColumnExists: false,
          classifierLastEvaluatedAt: null,
          now: freshNow,
        },
        {},
      );
      expect(r.mode).toBe('historical');
      expect(r.sql).toBe(HISTORICAL_UNIVERSE_WHERE);
      expect(r.warning).toMatch(/requested_live_fell_back:lifecycle_column_missing/);
    });

    it('uses env default when caller omits the parameter', () => {
      const r = resolveUniverseWhere(
        {
          lifecycleColumnExists: true,
          classifierLastEvaluatedAt: freshAt,
          now: freshNow,
        },
        { [DEFAULT_UNIVERSE_ENV_VAR]: 'live' },
      );
      expect(r.mode).toBe('live');
    });

    it('treats unknown requested values as "caller omitted"', () => {
      const r = resolveUniverseWhere(
        {
          requested: 'banana',
          lifecycleColumnExists: true,
          classifierLastEvaluatedAt: freshAt,
          now: freshNow,
        },
        {}, // env default historical
      );
      expect(r.mode).toBe('historical');
    });
  });

  describe('getClassifierLastEvaluatedAt', () => {
    it('returns the returned MAX timestamp as a Date', async () => {
      const iso = '2026-04-24T10:30:00.000Z';
      const at = await getClassifierLastEvaluatedAt(async () => ({
        rows: [{ max: iso }],
      }));
      expect(at).toBeInstanceOf(Date);
      expect(at?.toISOString()).toBe(iso);
    });

    it('returns null when the query yields NULL (never classified)', async () => {
      const at = await getClassifierLastEvaluatedAt(async () => ({
        rows: [{ max: null }],
      }));
      expect(at).toBeNull();
    });

    it('returns null when the query throws (e.g. column missing)', async () => {
      const at = await getClassifierLastEvaluatedAt(async () => {
        throw new Error('column does not exist');
      });
      expect(at).toBeNull();
    });
  });
});
