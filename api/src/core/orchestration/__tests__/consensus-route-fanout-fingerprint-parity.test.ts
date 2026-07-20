// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1R2 — Fingerprint determinism & parity for the execution
 * subset.
 *
 * Pins:
 *   - The fingerprint hashes `approvedForExecution`, not `approved`,
 *     so a discovery-only addition (catalog provider beyond runtime cap)
 *     does NOT change the fingerprint.
 *   - Same execution subset → same fingerprint (deterministic).
 *   - Different runtime cap with same input → potentially different
 *     fingerprint (because the execution subset changes).
 *
 * Pure-function tests; no DB / provider.
 */

import { describe, it, expect } from 'vitest';
import { buildRouteCandidatesForModel } from '@/core/orchestration/build-route-candidates';
import { STRICT_DEFAULT_ROUTE_SELECTION_POLICY } from '@/core/orchestration/route-candidates';
import type { ServingProviderEntry } from '@/core/orchestration/lookup-serving-providers';
import { createHash } from 'node:crypto';

const baseLookups = {
  resolveApiModelId: (args: { providerId: string; logicalModelId: string }) => args.logicalModelId,
  lookupLiveOperability: () => ({ chatReady: false }),
  lookupEconomics: () => ({}),
  lookupAuthHandle: () => 'env:KEY',
};

// Compute a minimal fingerprint of the execution-subset projection.
function projectAndHash(routes: readonly { routeId: string; equivalenceKind: string; apiModelId: string; providerId: string }[]): string {
  const projection = routes.map((c) => ({
    routeId: c.routeId,
    equivalenceKind: c.equivalenceKind,
    apiModelId: c.apiModelId,
    providerId: c.providerId,
  }));
  // Stable order is already guaranteed by the builder.
  const json = JSON.stringify(projection);
  return createHash('sha256').update(json).digest('hex');
}

describe('01C.1B-J1R2 — fingerprint determinism', () => {
  it('same execution subset → same fingerprint', () => {
    const servingProviders: ServingProviderEntry[] = [
      { providerId: 'p1', apiModelId: 'm', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
      { providerId: 'p2', apiModelId: 'm', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
      { providerId: 'p3', apiModelId: 'm', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
    ];

    const r1 = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'm',
      nativeProviderId: 'p1',
      taskCapability: 'chat',
      ...baseLookups,
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, requireLiveReadyForCriticalRoles: false },
      servingProviders,
    });
    const r2 = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'm',
      nativeProviderId: 'p1',
      taskCapability: 'chat',
      ...baseLookups,
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, requireLiveReadyForCriticalRoles: false },
      servingProviders,
    });
    expect(projectAndHash(r1.approvedForExecution)).toBe(projectAndHash(r2.approvedForExecution));
  });

  it('discovery-only addition (beyond runtime cap) does NOT change execution fingerprint', () => {
    // Three providers within runtime cap of 3.
    const baseProviders: ServingProviderEntry[] = [
      { providerId: 'p1', apiModelId: 'm', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
      { providerId: 'p2', apiModelId: 'm', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
      { providerId: 'p3', apiModelId: 'm', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
    ];
    // Extra providers that will land beyond the runtime cap (sorted by providerId).
    const extraProvider: ServingProviderEntry = {
      providerId: 'zzz-extra',
      apiModelId: 'm',
      source: 'model_catalog',
      confidence: 'exact',
      capabilities: ['chat'],
      chatCapable: true,
    };

    const r1 = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'm',
      nativeProviderId: 'p1',
      taskCapability: 'chat',
      ...baseLookups,
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, requireLiveReadyForCriticalRoles: false },
      servingProviders: baseProviders,
    });
    const r2 = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'm',
      nativeProviderId: 'p1',
      taskCapability: 'chat',
      ...baseLookups,
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, requireLiveReadyForCriticalRoles: false },
      servingProviders: [...baseProviders, extraProvider],
    });
    expect(r1.approvedForExecution.length).toBe(3);
    expect(r2.approvedForExecution.length).toBe(3);
    // Execution subsets are identical → same fingerprint.
    expect(projectAndHash(r1.approvedForExecution)).toBe(projectAndHash(r2.approvedForExecution));
    // Discovery views differ (the extra provider IS exposed).
    expect(r1.approved.length).toBe(3);
    expect(r2.approved.length).toBe(4);
  });

  it('different runtime cap → potentially different execution fingerprint', () => {
    const servingProviders: ServingProviderEntry[] = [
      { providerId: 'p1', apiModelId: 'm', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
      { providerId: 'p2', apiModelId: 'm', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
      { providerId: 'p3', apiModelId: 'm', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
    ];

    const r1 = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'm',
      nativeProviderId: 'p1',
      taskCapability: 'chat',
      ...baseLookups,
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, requireLiveReadyForCriticalRoles: false, runtimeMaxRouteAttempts: 1 },
      servingProviders,
    });
    const r3 = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'm',
      nativeProviderId: 'p1',
      taskCapability: 'chat',
      ...baseLookups,
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, requireLiveReadyForCriticalRoles: false, runtimeMaxRouteAttempts: 3 },
      servingProviders,
    });
    expect(r1.approvedForExecution.length).toBe(1);
    expect(r3.approvedForExecution.length).toBe(3);
    expect(projectAndHash(r1.approvedForExecution)).not.toBe(projectAndHash(r3.approvedForExecution));
  });
});
