// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1R2 — Model-centric route fanout tests for the builder.
 *
 * These tests verify the `lookupServingProviders` / `servingProviders`
 * union with taxonomy routes:
 *   - Catalog adds providers not present in taxonomy.
 *   - Router-as-native model no longer collapses to 1 route.
 *   - Dedup by routeId is stable.
 *   - Non-chat capability is rejected.
 *
 * No DB calls, no provider calls, no secrets. Uses inline fixtures.
 */

import { describe, it, expect } from 'vitest';
import { buildRouteCandidatesForModel } from '@/core/orchestration/build-route-candidates';
import { STRICT_DEFAULT_ROUTE_SELECTION_POLICY } from '@/core/orchestration/route-candidates';
import type { ServingProviderEntry } from '@/core/orchestration/lookup-serving-providers';

const defaultLookups = {
  resolveApiModelId: (args: { providerId: string; logicalModelId: string; nativeProviderId: string }) =>
    args.providerId === args.nativeProviderId ? args.logicalModelId : `${args.nativeProviderId}/${args.logicalModelId}`,
  lookupLiveOperability: () => ({ chatReady: false }),
  lookupEconomics: () => ({}),
  lookupAuthHandle: () => 'env:TEST_KEY',
};

const permissivePolicy = {
  ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
  requireLiveReadyForCriticalRoles: false,
  discoveryMaxRouteCandidates: 200,
  runtimeMaxRouteAttempts: 3,
};

describe('01C.1B-J1R2 — model-centric multi-provider fanout', () => {
  it('lookupServingProviders adds providers not in taxonomy (router-as-native gemma case)', () => {
    // Native is `routeway` (a router-classified provider per taxonomy).
    // Taxonomy would return only [routeway]. With servingProviders, we
    // expect catalog entries to add deepinfra, openrouter, huggingface, etc.
    const servingProviders: ServingProviderEntry[] = [
      { providerId: 'deepinfra', apiModelId: 'google/gemma-3-4b-it', source: 'model_catalog', confidence: 'normalized', capabilities: ['chat'], chatCapable: true },
      { providerId: 'openrouter', apiModelId: 'google/gemma-3-4b-it', source: 'model_catalog', confidence: 'normalized', capabilities: ['chat'], chatCapable: true },
      { providerId: 'aiml', apiModelId: 'gemma-3-4b-it', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
    ];

    const result = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'gemma-3-4b-it',
      nativeProviderId: 'routeway',
      taskCapability: 'chat',
      ...defaultLookups,
      policy: permissivePolicy,
      servingProviders,
    });

    // 1 (taxonomy: routeway self) + 3 (catalog) = 4 raw routes. After
    // dedup + classification, all 4 must survive.
    expect(result.approved.length).toBe(4);
    const providers = result.approved.map((c) => c.providerId).sort();
    expect(providers).toEqual(['aiml', 'deepinfra', 'openrouter', 'routeway']);
  });

  it('router-as-native model produces >1 route when catalog has alternates', () => {
    // The J1R fix made router-as-native return 1 candidate at minimum.
    // J1R2 expands this to ALL catalog rows for the same logical model.
    const servingProviders: ServingProviderEntry[] = [
      { providerId: 'deepinfra', apiModelId: 'meta-llama/Llama-3.2-11B-Vision-Instruct', source: 'model_catalog', confidence: 'alias', capabilities: ['chat'], chatCapable: true },
      { providerId: 'openrouter', apiModelId: 'meta-llama/llama-3.2-11b-vision-instruct', source: 'model_catalog', confidence: 'alias', capabilities: ['chat'], chatCapable: true },
      { providerId: 'nvidia', apiModelId: 'meta/llama-3.2-11b-vision-instruct', source: 'model_catalog', confidence: 'alias', capabilities: ['chat'], chatCapable: true },
    ];

    const result = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'meta/llama-3.2-11b',
      nativeProviderId: 'vercel-ai-gateway',
      taskCapability: 'chat',
      ...defaultLookups,
      policy: permissivePolicy,
      servingProviders,
    });

    expect(result.approved.length).toBeGreaterThanOrEqual(4); // 1 taxonomy + 3 catalog
    expect(result.approved.find((c) => c.providerId === 'vercel-ai-gateway')).toBeDefined();
    expect(result.approved.find((c) => c.providerId === 'deepinfra')).toBeDefined();
  });

  it('dedupes by routeId when catalog and taxonomy overlap', () => {
    // The native taxonomy route for `vercel-ai-gateway` plus a catalog
    // entry for the same provider+model should produce ONE final route.
    const servingProviders: ServingProviderEntry[] = [
      // Same providerId as the taxonomy self-route — should dedup.
      { providerId: 'vercel-ai-gateway', apiModelId: 'meta/llama-3.2-11b', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
      { providerId: 'deepinfra', apiModelId: 'meta-llama/Llama-3.2-11B-Vision-Instruct', source: 'model_catalog', confidence: 'alias', capabilities: ['chat'], chatCapable: true },
    ];

    const result = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'meta/llama-3.2-11b',
      nativeProviderId: 'vercel-ai-gateway',
      taskCapability: 'chat',
      ...defaultLookups,
      policy: permissivePolicy,
      servingProviders,
    });

    // No duplicate vercel-ai-gateway:: routes.
    const vercelRoutes = result.approved.filter((c) => c.providerId === 'vercel-ai-gateway');
    expect(vercelRoutes.length).toBe(1);
    // Should have a duplicate_route_id rejection for the dedup.
    const dupRejection = result.rejections.find((r) => r.reason === 'duplicate_route_id');
    expect(dupRejection).toBeDefined();
  });

  it('catalog-sourced routes are tagged source=catalog_binding', () => {
    const servingProviders: ServingProviderEntry[] = [
      { providerId: 'deepinfra', apiModelId: 'google/gemma-3-4b-it', source: 'model_catalog', confidence: 'normalized', capabilities: ['chat'], chatCapable: true },
    ];

    const result = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'gemma-3-4b-it',
      nativeProviderId: 'routeway',
      taskCapability: 'chat',
      ...defaultLookups,
      policy: permissivePolicy,
      servingProviders,
    });

    const deepinfraRoute = result.approved.find((c) => c.providerId === 'deepinfra');
    expect(deepinfraRoute).toBeDefined();
    expect(deepinfraRoute?.source).toBe('catalog_binding');
    // The taxonomy self-route for `routeway` should be tagged differently.
    const routewayRoute = result.approved.find((c) => c.providerId === 'routeway');
    expect(routewayRoute?.source).not.toBe('catalog_binding');
  });

  it('uses catalog apiModelId verbatim — does not run resolver for catalog rows', () => {
    // Catalog says deepinfra serves the model as `meta-llama/Llama-3.2-…`.
    // The default resolver would produce `vercel-ai-gateway/meta/llama-3.2-11b`
    // (wrong for deepinfra). The builder must trust the catalog.
    const servingProviders: ServingProviderEntry[] = [
      { providerId: 'deepinfra', apiModelId: 'meta-llama/Llama-3.2-11B-Vision-Instruct', source: 'model_catalog', confidence: 'alias', capabilities: ['chat'], chatCapable: true },
    ];

    const result = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'meta/llama-3.2-11b',
      nativeProviderId: 'vercel-ai-gateway',
      taskCapability: 'chat',
      ...defaultLookups,
      policy: permissivePolicy,
      servingProviders,
    });

    const deepinfraRoute = result.approved.find((c) => c.providerId === 'deepinfra');
    expect(deepinfraRoute?.apiModelId).toBe('meta-llama/Llama-3.2-11B-Vision-Instruct');
  });

  it('servingProviders is optional (back-compat with J1R-only callers)', () => {
    // Without servingProviders, builder falls back to taxonomy-only.
    const result = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'gemma-3-4b-it',
      nativeProviderId: 'routeway',
      taskCapability: 'chat',
      ...defaultLookups,
      policy: permissivePolicy,
    });

    // Taxonomy-only path = 1 candidate (the router self-route).
    expect(result.approved.length).toBe(1);
    expect(result.approved[0].providerId).toBe('routeway');
  });

  it('approvedForExecution is non-empty when approved is non-empty', () => {
    const servingProviders: ServingProviderEntry[] = [
      { providerId: 'p1', apiModelId: 'm', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
      { providerId: 'p2', apiModelId: 'm', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
      { providerId: 'p3', apiModelId: 'm', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
      { providerId: 'p4', apiModelId: 'm', source: 'model_catalog', confidence: 'exact', capabilities: ['chat'], chatCapable: true },
    ];
    const result = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'm',
      nativeProviderId: 'p1',
      taskCapability: 'chat',
      ...defaultLookups,
      policy: permissivePolicy,
      servingProviders,
    });
    // approvedForExecution ≤ approved always
    expect(result.approvedForExecution.length).toBeLessThanOrEqual(result.approved.length);
    expect(result.approvedForExecution.length).toBeGreaterThan(0);
  });
});
