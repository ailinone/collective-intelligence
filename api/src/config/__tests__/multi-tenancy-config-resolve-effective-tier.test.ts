// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * resolveEffectiveTierConfig — Fase 5 (cross-repo hardening): billing's real
 * per-tenant entitlement takes priority over the hardcoded TIER_CONFIGS
 * `requestsPerMinute` when available, and falls back to the unmodified
 * hardcoded value whenever billing is unavailable for any reason.
 *
 * billing-entitlements-client.ts is mocked here — its own network/cache
 * behavior is covered by billing-entitlements-client.test.ts; this file only
 * covers the override-vs-fallback decision in multi-tenancy-config.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetTenantEntitlements = vi.fn();

vi.mock('@/services/billing-entitlements-client', () => ({
  getTenantEntitlements: (...args: unknown[]) => mockGetTenantEntitlements(...args),
}));

import { TIER_CONFIGS, getTierConfig, resolveEffectiveTierConfig } from '@/config/multi-tenancy-config';

beforeEach(() => {
  mockGetTenantEntitlements.mockReset();
});

describe('resolveEffectiveTierConfig', () => {
  it('overrides requestsPerMinute with billing knowledge_rate_limit when billing has data', async () => {
    mockGetTenantEntitlements.mockResolvedValue({
      tenantId: 'org-1',
      planId: 'team',
      source: 'subscription',
      limits: { knowledge_rate_limit: 1000 },
    });

    const result = await resolveEffectiveTierConfig('free', 'org-1');

    expect(result.requestsPerMinute).toBe(1000);
    // Every other hardcoded field is untouched.
    expect(result.requestsPerHour).toBe(TIER_CONFIGS.free.requestsPerHour);
    expect(result.maxStorageGB).toBe(TIER_CONFIGS.free.maxStorageGB);
    expect(result.features).toEqual(TIER_CONFIGS.free.features);
    expect(mockGetTenantEntitlements).toHaveBeenCalledWith('org-1');
  });

  it('falls back to the unmodified hardcoded tier config when billing is unavailable', async () => {
    mockGetTenantEntitlements.mockResolvedValue(null);

    const result = await resolveEffectiveTierConfig('pro', 'org-2');

    expect(result).toEqual(getTierConfig('pro'));
  });

  it('falls back to the unmodified hardcoded tier config when billing has no knowledge_rate_limit entry', async () => {
    mockGetTenantEntitlements.mockResolvedValue({
      tenantId: 'org-3',
      planId: 'sandbox',
      source: 'fallback_sandbox',
      limits: { members: 1 }, // no knowledge_rate_limit key at all
    });

    const result = await resolveEffectiveTierConfig('enterprise', 'org-3');

    expect(result).toEqual(getTierConfig('enterprise'));
  });

  it('does not call billing at all when organizationId is empty', async () => {
    const result = await resolveEffectiveTierConfig('free', '');

    expect(result).toEqual(getTierConfig('free'));
    expect(mockGetTenantEntitlements).not.toHaveBeenCalled();
  });

  it('falls back to free for an unknown tier, same as getTierConfig', async () => {
    mockGetTenantEntitlements.mockResolvedValue(null);

    const result = await resolveEffectiveTierConfig('nonexistent-tier', 'org-4');

    expect(result).toEqual(TIER_CONFIGS.free);
  });
});
