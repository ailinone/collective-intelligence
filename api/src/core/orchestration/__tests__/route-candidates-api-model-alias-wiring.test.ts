// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1E §14.2 — Verifies that the route candidate builder uses
 * the central resolver instead of naive concat.
 *
 * Strategy: pass a `resolveApiModelId` that delegates to the J1E
 * resolver. Build routes for `anthropic-claude-3.7-sonnet`. Assert
 * NO route carries `anthropic/anthropic-claude-3.7-sonnet`.
 */

import { describe, it, expect } from 'vitest';
import { buildRouteCandidatesForModel } from '@/core/orchestration/build-route-candidates';
import { STRICT_DEFAULT_ROUTE_SELECTION_POLICY } from '@/core/orchestration/route-candidates';
import { resolveApiModelId as resolveApiModelIdCentral } from '@/core/orchestration/model-routing/provider-api-model-id-resolver';
import type { ServingProviderEntry } from '@/core/orchestration/lookup-serving-providers';

const lookups = {
  // Delegate to the J1E central resolver
  resolveApiModelId: (args: { providerId: string; logicalModelId: string; nativeProviderId: string }) =>
    resolveApiModelIdCentral({
      providerId: args.providerId,
      logicalModelId: args.logicalModelId,
      nativeProviderId: args.nativeProviderId,
      strict: false,
    }).apiModelId,
  lookupLiveOperability: () => ({ chatReady: false }),
  lookupEconomics: () => ({}),
  lookupAuthHandle: () => 'env:TEST',
};

const permissivePolicy = {
  ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
  requireLiveReadyForCriticalRoles: false,
  discoveryMaxRouteCandidates: 200,
  runtimeMaxRouteAttempts: 3,
};

describe('01C.1B-J1E §14.2 — route candidates wiring', () => {
  it('synthesizer routes for anthropic-claude-3.7-sonnet do NOT contain anthropic/anthropic-claude-3.7-sonnet', () => {
    const servingProviders: ServingProviderEntry[] = [
      // catalog says these routers serve the model (but the catalog id
      // is the slug form). The builder calls resolveApiModelId for each
      // route, which MUST return the corrected form.
    ];
    const result = buildRouteCandidatesForModel({
      role: 'synthesizer',
      logicalModelId: 'anthropic-claude-3.7-sonnet',
      nativeProviderId: 'anthropic',
      taskCapability: 'chat',
      ...lookups,
      policy: permissivePolicy,
      servingProviders,
    });
    // No route can carry the bad apiModelId
    const badRoutes = result.approved.filter((r) => r.apiModelId === 'anthropic/anthropic-claude-3.7-sonnet');
    expect(badRoutes).toEqual([]);
  });

  it('openrouter peering for anthropic-claude-3.7-sonnet uses alias-mapped form', () => {
    const result = buildRouteCandidatesForModel({
      role: 'synthesizer',
      logicalModelId: 'anthropic-claude-3.7-sonnet',
      nativeProviderId: 'anthropic',
      taskCapability: 'chat',
      ...lookups,
      policy: permissivePolicy,
      routeCandidatesOverride: [
        { providerId: 'openrouter', kind: 'router', nativeProviderId: 'anthropic' },
      ],
    });
    const openrouterRoute = result.approved.find((r) => r.providerId === 'openrouter');
    expect(openrouterRoute).toBeDefined();
    expect(openrouterRoute?.apiModelId).toBe('anthropic/claude-3.7-sonnet');
  });

  it('native anthropic route uses alias-mapped canonical id', () => {
    const result = buildRouteCandidatesForModel({
      role: 'synthesizer',
      logicalModelId: 'anthropic-claude-3.7-sonnet',
      nativeProviderId: 'anthropic',
      taskCapability: 'chat',
      ...lookups,
      policy: permissivePolicy,
      routeCandidatesOverride: [
        { providerId: 'anthropic', kind: 'native' },
      ],
    });
    const nativeRoute = result.approved.find((r) => r.providerId === 'anthropic');
    expect(nativeRoute).toBeDefined();
    expect(nativeRoute?.apiModelId).toBe('claude-3-7-sonnet-latest');
  });

  it('routeId reflects the resolved apiModelId, not the raw logical id', () => {
    const result = buildRouteCandidatesForModel({
      role: 'synthesizer',
      logicalModelId: 'anthropic-claude-3.7-sonnet',
      nativeProviderId: 'anthropic',
      taskCapability: 'chat',
      ...lookups,
      policy: permissivePolicy,
      routeCandidatesOverride: [
        { providerId: 'openrouter', kind: 'router', nativeProviderId: 'anthropic' },
      ],
    });
    const openrouterRoute = result.approved.find((r) => r.providerId === 'openrouter');
    // The routeId should incorporate `anthropic/claude-3.7-sonnet`, not the bad form
    expect(openrouterRoute?.routeId).toContain('anthropic/claude-3.7-sonnet');
    expect(openrouterRoute?.routeId).not.toContain('anthropic/anthropic-claude-3.7-sonnet');
  });

  it('dedup applied after resolution (no duplicate apiModelIds in approved)', () => {
    const result = buildRouteCandidatesForModel({
      role: 'synthesizer',
      logicalModelId: 'anthropic-claude-3.7-sonnet',
      nativeProviderId: 'anthropic',
      taskCapability: 'chat',
      ...lookups,
      policy: permissivePolicy,
      routeCandidatesOverride: [
        { providerId: 'openrouter', kind: 'router', nativeProviderId: 'anthropic' },
        { providerId: 'openrouter', kind: 'router', nativeProviderId: 'anthropic' }, // dup
      ],
    });
    const openrouterRoutes = result.approved.filter((r) => r.providerId === 'openrouter');
    expect(openrouterRoutes.length).toBe(1);
  });

  it('NEW router without explicit alias falls back to conservative_derivation (NOT naive)', () => {
    const result = buildRouteCandidatesForModel({
      role: 'synthesizer',
      logicalModelId: 'anthropic-claude-3.7-sonnet',
      nativeProviderId: 'anthropic',
      taskCapability: 'chat',
      ...lookups,
      policy: permissivePolicy,
      routeCandidatesOverride: [
        { providerId: 'novel-router-not-in-alias-map', kind: 'router', nativeProviderId: 'anthropic' },
      ],
    });
    const novelRoute = result.approved.find((r) => r.providerId === 'novel-router-not-in-alias-map');
    expect(novelRoute).toBeDefined();
    // Conservative derivation: strips duplicate prefix → anthropic/claude-3.7-sonnet
    expect(novelRoute?.apiModelId).toBe('anthropic/claude-3.7-sonnet');
  });
});
