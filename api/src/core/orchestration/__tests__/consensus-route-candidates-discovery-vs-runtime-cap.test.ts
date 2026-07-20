// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1R2 — discovery cap vs runtime cap separation tests.
 *
 * Pins the two-stage capping behavior:
 *   - `approved` honors `discoveryMaxRouteCandidates` (default 200)
 *   - `approvedForExecution` honors `runtimeMaxRouteAttempts` (default 3)
 *   - When only legacy `maxRouteAttempts` is set, BOTH default to it
 *     (back-compat: existing callers that don't know about the split
 *     keep their previous semantics)
 *   - Discovery cap is always >= runtime cap (lift if violated)
 *
 * No DB, no provider calls.
 */

import { describe, it, expect } from 'vitest';
import { buildRouteCandidatesForModel } from '@/core/orchestration/build-route-candidates';
import {
  resolveRouteCaps,
  STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
} from '@/core/orchestration/route-candidates';
import type { ServingProviderEntry } from '@/core/orchestration/lookup-serving-providers';

const tenProviders: ServingProviderEntry[] = Array.from({ length: 10 }, (_, i) => ({
  providerId: `provider-${i}`,
  apiModelId: 'm',
  source: 'model_catalog' as const,
  confidence: 'exact' as const,
  capabilities: ['chat'],
  chatCapable: true,
}));

const baseLookups = {
  resolveApiModelId: (args: { providerId: string; logicalModelId: string }) => args.logicalModelId,
  lookupLiveOperability: () => ({ chatReady: false }),
  lookupEconomics: () => ({}),
  lookupAuthHandle: () => 'env:KEY',
};

describe('01C.1B-J1R2 — discovery vs runtime cap', () => {
  it('resolveRouteCaps: default discovery >> runtime', () => {
    const { discoveryCap, runtimeCap } = resolveRouteCaps(STRICT_DEFAULT_ROUTE_SELECTION_POLICY);
    expect(runtimeCap).toBe(3);
    expect(discoveryCap).toBe(200);
    expect(discoveryCap).toBeGreaterThan(runtimeCap);
  });

  it('resolveRouteCaps: legacy maxRouteAttempts alone sets runtime cap', () => {
    const { discoveryCap, runtimeCap } = resolveRouteCaps({
      ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
      maxRouteAttempts: 5,
      // omit discoveryMaxRouteCandidates / runtimeMaxRouteAttempts
      discoveryMaxRouteCandidates: undefined,
      runtimeMaxRouteAttempts: undefined,
    });
    expect(runtimeCap).toBe(5);
    expect(discoveryCap).toBeGreaterThanOrEqual(runtimeCap);
  });

  it('resolveRouteCaps: discovery is lifted to runtime when it would be smaller', () => {
    const { discoveryCap, runtimeCap } = resolveRouteCaps({
      ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
      maxRouteAttempts: 3,
      discoveryMaxRouteCandidates: 1, // smaller than runtime — must lift
      runtimeMaxRouteAttempts: 3,
    });
    expect(runtimeCap).toBe(3);
    expect(discoveryCap).toBe(3); // lifted from 1 → 3
  });

  it('builder: discoveryCap=10, runtimeCap=3 → 10 approved, 3 approvedForExecution', () => {
    const result = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'm',
      nativeProviderId: 'provider-0',
      taskCapability: 'chat',
      ...baseLookups,
      policy: {
        ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
        requireLiveReadyForCriticalRoles: false,
        discoveryMaxRouteCandidates: 10,
        runtimeMaxRouteAttempts: 3,
      },
      servingProviders: tenProviders,
    });
    expect(result.approved.length).toBe(10);
    expect(result.approvedForExecution.length).toBe(3);
    // No over_attempt_cap rejections — all 10 are within discovery cap.
    expect(result.rejections.filter((r) => r.reason === 'over_attempt_cap')).toEqual([]);
  });

  it('builder: discoveryCap=3 → only first 3 in approved, rest as over_attempt_cap', () => {
    const result = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'm',
      nativeProviderId: 'provider-0',
      taskCapability: 'chat',
      ...baseLookups,
      policy: {
        ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
        requireLiveReadyForCriticalRoles: false,
        discoveryMaxRouteCandidates: 3,
        runtimeMaxRouteAttempts: 3,
      },
      servingProviders: tenProviders,
    });
    expect(result.approved.length).toBe(3);
    expect(result.rejections.filter((r) => r.reason === 'over_attempt_cap').length).toBeGreaterThan(0);
  });

  it('builder: discovery cap does NOT use legacy maxRouteAttempts=3 when default is in effect', () => {
    // 01C.1B-J1R2 anti-regression: a caller that omits the new fields
    // and relies on the STRICT_DEFAULT_ROUTE_SELECTION_POLICY must NOT
    // see only 3 candidates — discovery default is 200.
    const result = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'm',
      nativeProviderId: 'provider-0',
      taskCapability: 'chat',
      ...baseLookups,
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, requireLiveReadyForCriticalRoles: false },
      servingProviders: tenProviders,
    });
    expect(result.approved.length).toBe(10); // NOT 3
    expect(result.approvedForExecution.length).toBe(3);
  });

  it('approvedForExecution is always a prefix of approved (same ordering)', () => {
    const result = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'm',
      nativeProviderId: 'provider-0',
      taskCapability: 'chat',
      ...baseLookups,
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, requireLiveReadyForCriticalRoles: false },
      servingProviders: tenProviders,
    });
    expect(result.approvedForExecution).toEqual(result.approved.slice(0, result.approvedForExecution.length));
  });
});
