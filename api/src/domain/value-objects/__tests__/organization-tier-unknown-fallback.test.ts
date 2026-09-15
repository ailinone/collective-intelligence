// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test (cross-repo quota/tier hardening, P0 finding #2):
 * `OrganizationTier.getLimitsForTier`'s `switch (tier)` had no `default`
 * case. `Organization.tier` is a plain `String` column
 * (`prisma/schema.prisma`'s comment even used to document a `"team"` value
 * that exists in no `TierLevel` enum member), and
 * `OrganizationEntity.reconstitute` casts that raw DB string straight to
 * `TierLevel` with no validation (`OrganizationTier.create(data.tier as
 * TierLevel)`). Any row whose `tier` doesn't match FREE/STARTER/PRO/
 * ENTERPRISE made `getLimitsForTier` return `undefined` silently, and every
 * subsequent call — `canAddApiKey`, `canAddMember`, `isWithinRequestLimit`,
 * `canUseModels`, `hasFeature` — threw a `TypeError` reading a property off
 * `undefined`, turning one bad row into an unhandled crash.
 *
 * The fix adds a fail-closed `default` branch: treat an unrecognized tier
 * as the most restrictive real tier (FREE) and log loudly, instead of
 * returning `undefined`.
 */
import { describe, it, expect, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    child: () => ({
      error: loggerMocks.error,
      warn: loggerMocks.warn,
      info: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

import { OrganizationTier, TierLevel } from '@/domain/value-objects/organization-tier';

describe('OrganizationTier.create — unknown/unexpected tier fail-closed fallback', () => {
  it('does not throw for a tier value outside TierLevel, and falls back to FREE-tier limits', () => {
    // 'team' is the stale value the Prisma schema comment used to document
    // — a realistic stand-in for bad/legacy DB data.
    let unknown!: OrganizationTier;
    expect(() => {
      unknown = OrganizationTier.create('team' as TierLevel);
    }).not.toThrow();

    const free = OrganizationTier.create(TierLevel.FREE);
    expect(unknown.getLimits()).toEqual(free.getLimits());
  });

  it('logs the unexpected value instead of failing silently', () => {
    loggerMocks.error.mockClear();
    OrganizationTier.create('some-future-tier' as TierLevel);
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'some-future-tier' }),
      expect.stringContaining('some-future-tier')
    );
  });

  it('every downstream limit check behaves like FREE instead of throwing a TypeError on undefined limits', () => {
    const unknown = OrganizationTier.create('not-a-real-tier' as TierLevel);

    expect(() => unknown.canAddApiKey(0)).not.toThrow();
    expect(unknown.canAddApiKey(0)).toBe(true); // FREE allows up to 2 keys
    expect(unknown.canAddApiKey(2)).toBe(false); // FREE caps at 2

    expect(() => unknown.canAddMember(0)).not.toThrow();
    expect(unknown.canAddMember(0)).toBe(true); // FREE allows 1 member
    expect(unknown.canAddMember(1)).toBe(false);

    expect(() => unknown.isWithinRequestLimit(0)).not.toThrow();
    expect(unknown.isWithinRequestLimit(999)).toBe(true); // FREE cap is 1000/day
    expect(unknown.isWithinRequestLimit(1000)).toBe(false);

    expect(() => unknown.canUseModels(1)).not.toThrow();
    expect(unknown.hasFeature('prioritySupport')).toBe(false);
  });

  it('still resolves every real TierLevel member to its own (non-fallback) limits', () => {
    for (const level of Object.values(TierLevel)) {
      expect(() => OrganizationTier.create(level)).not.toThrow();
    }
    // Sanity: FREE and ENTERPRISE aren't accidentally collapsed to the same limits.
    expect(OrganizationTier.create(TierLevel.FREE).getLimits()).not.toEqual(
      OrganizationTier.create(TierLevel.ENTERPRISE).getLimits()
    );
  });
});
