// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for the 'starter' tier gap (cross-repo quota/tier
 * follow-up, item 2b): PUT /v1/organizations/:id's own schema, and
 * domain/value-objects/organization-tier.ts's TierLevel enum, both treat
 * 'starter' as a real, assignable organization tier — but TIER_CONFIGS
 * (which every getTierConfig call site in the API-gateway layer reads:
 * token-bucket-rate-limit.ts, tenant-isolation-middleware.ts,
 * strategy-tiers.ts) had no entry for it, so getTierConfig('starter')
 * silently fell back to the FREE tier's throughput/features for any
 * organization actually configured as 'starter'.
 */
import { describe, expect, it } from 'vitest';
import { getTierConfig, TIER_CONFIGS } from '@/config/multi-tenancy-config';
import { TierLevel } from '@/domain/value-objects/organization-tier';

describe('getTierConfig — starter tier', () => {
  it('resolves a dedicated config, not the free-tier fallback', () => {
    const starter = getTierConfig('starter');

    expect(starter.name).toBe('Starter');
    expect(starter).not.toEqual(TIER_CONFIGS.free);
  });

  it('sits strictly between free and pro on every numeric dimension', () => {
    const free = TIER_CONFIGS.free;
    const starter = TIER_CONFIGS.starter;
    const pro = TIER_CONFIGS.pro;

    for (const key of [
      'maxConnections',
      'connectionPoolSize',
      'queryTimeout',
      'requestsPerMinute',
      'requestsPerHour',
      'concurrentRequests',
      'maxStorageGB',
      'maxFileSize',
    ] as const) {
      expect(starter[key], `${key} should be >= free`).toBeGreaterThanOrEqual(free[key]);
      expect(starter[key], `${key} should be <= pro`).toBeLessThanOrEqual(pro[key]);
    }
  });

  it('every domain TierLevel has a matching TIER_CONFIGS entry (prevents this class of gap recurring)', () => {
    for (const level of Object.values(TierLevel)) {
      expect(TIER_CONFIGS[level], `TIER_CONFIGS is missing an entry for tier '${level}'`).toBeDefined();
      if (level !== TierLevel.FREE) {
        // A real, non-free tier silently resolving to the free config is
        // exactly the bug this test guards against (getTierConfig warns and
        // falls back to TIER_CONFIGS.free for any key it doesn't recognize).
        expect(TIER_CONFIGS[level]).not.toEqual(TIER_CONFIGS.free);
      }
    }
    // Sanity check the guard itself isn't vacuous (TierLevel actually has >1 member).
    expect(Object.values(TierLevel).length).toBeGreaterThan(1);
  });
});
