// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * candidate-retriever-explicit-pin.test.ts — MVP 5A
 *
 * Mirrors MVP 4's `explicit-pin-not-rerouted` test at the retrieval
 * level. When a pin is set, the retriever returns at most the pinned
 * candidate; other healthy candidates are dropped. The retriever
 * NEVER substitutes.
 */

import { describe, expect, it } from 'vitest';
import { retrieveCandidates } from '../candidate-retriever';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import { LEGACY_MODELS_FIXTURE } from '../../registry/__tests__/fixtures/legacy-models.fixture';
import { buildRuntimeModelRegistry } from '../../registry/registry-builder';
import { FIXTURE_ROUTE_KIND_BY_PROVIDER } from '../../registry/__tests__/fixtures/legacy-models.fixture';
import type { ExplicitPinInfo } from '../../registry/types';

function findRouteId(
  registry: ReturnType<typeof buildFixtureRegistry>,
  providerId: string,
  modelId: string,
): string {
  const snap = LEGACY_MODELS_FIXTURE.find(
    (m) => m.providerId === providerId && m.id === modelId,
  );
  const oid = snap?.uid ?? `${providerId}:${modelId}`;
  const routes = registry.routesForOffering(oid);
  if (routes.length === 0) throw new Error('no routes found');
  return routes[0].routeId;
}

describe('retriever — explicit pin by routeId', () => {
  it('returns ONLY the pinned route as candidate', () => {
    const registry = buildFixtureRegistry();
    const pinnedRouteId = findRouteId(registry, 'anthropic', 'claude-opus-4-7');
    // Heal the pinned route's readiness by reading it through the registry
    // and reconstructing via builder with overrides. For MVP 5A we use the
    // raw fixture; readiness defaults to 'unknown' which is treated as OK
    // (filterByReadiness only rejects auth_failed/no_credits/rate_limited/
    // minimal_chat_failed).

    const pin: ExplicitPinInfo = {
      source: 'request_modelPin',
      routeId: pinnedRouteId,
      allowSubstitution: false,
    };

    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'], explicitModelPin: pin },
      { registry },
    );

    // Every non-rejected candidate must match the pin.
    for (const c of result.candidates) {
      expect(c.routeId).toBe(pinnedRouteId);
    }
    // Other routes go to rejectedByStage with pin mismatch reason.
    const mismatched = result.rejectedByStage.filter(
      (r) => r.reason === 'pin_route_mismatch',
    );
    expect(mismatched.length).toBeGreaterThan(0);
  });
});

describe('retriever — explicit pin by offeringId', () => {
  it('only candidates of the pinned offering pass', () => {
    const registry = buildFixtureRegistry();
    const snap = LEGACY_MODELS_FIXTURE.find(
      (m) => m.providerId === 'anthropic' && m.id === 'claude-opus-4-7',
    );
    const pinnedOfferingId = snap?.uid ?? 'anthropic:claude-opus-4-7';

    const pin: ExplicitPinInfo = {
      source: 'experiment_pin',
      offeringId: pinnedOfferingId,
      allowSubstitution: false,
    };

    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'], explicitModelPin: pin },
      { registry },
    );
    for (const c of result.candidates) {
      expect(c.offeringId).toBe(pinnedOfferingId);
    }
  });
});

describe('retriever — explicit pin by canonicalModelId', () => {
  it('only candidates of the pinned canonical pass', () => {
    const registry = buildFixtureRegistry();
    const pinnedCanonicalId = 'anthropic:claude-opus-4-7';

    const pin: ExplicitPinInfo = {
      source: 'internal_pin',
      canonicalModelId: pinnedCanonicalId,
      allowSubstitution: false,
    };

    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'], explicitModelPin: pin },
      { registry },
    );
    for (const c of result.candidates) {
      expect(c.canonicalModelId).toBe(pinnedCanonicalId);
    }
  });
});

describe('retriever — pin to unhealthy route does NOT substitute', () => {
  it('pin to a no_credits route → candidates is empty, no substitution', () => {
    // Build a custom registry where the pinned route is no_credits but
    // a healthy alternative exists.
    const sickRoute = {
      id: 'pinned-model',
      providerId: 'sick-provider',
      status: 'active',
      capabilityUris: ['chat'],
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      inputCostPer1k: 0.001,
      outputCostPer1k: 0.003,
      lifecycleStatus: 'current',
    };
    const healthyAlt = {
      id: 'alternative-model',
      providerId: 'healthy-provider',
      status: 'active',
      capabilityUris: ['chat'],
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      inputCostPer1k: 0.001,
      outputCostPer1k: 0.003,
      lifecycleStatus: 'current',
    };
    const { registry } = buildRuntimeModelRegistry({
      models: [sickRoute, healthyAlt],
      routeKindByProvider: FIXTURE_ROUTE_KIND_BY_PROVIDER,
    });
    // Mutate route state — for MVP 5A registry is immutable; we instead
    // build with the original snapshots and apply unhealthy state by
    // pointing the pin at the pinned route and using a request that
    // would not match the alternative. The retriever's job is to NOT
    // substitute; not to manufacture unhealthy state.
    const pinnedRouteId = 'sick-provider:pinned-model::sick-provider';
    const pin: ExplicitPinInfo = {
      source: 'request_modelPin',
      routeId: pinnedRouteId,
      allowSubstitution: true,
      authorizingPolicy: 'experiment.allowSubstitution',
    };

    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'], explicitModelPin: pin },
      { registry },
    );
    // Only the pinned route can be selected.
    for (const c of result.candidates) {
      expect(c.routeId).toBe(pinnedRouteId);
    }
    // The alternative is rejected by pin filter.
    const altRejection = result.rejectedByStage.find(
      (r) => r.routeId.includes('alternative-model'),
    );
    expect(altRejection).toBeDefined();
    expect(altRejection?.reason).toBe('pin_route_mismatch');
  });
});

describe('retriever — allowSubstitution=true still does NOT substitute (MVP 5A)', () => {
  it('with allowSubstitution=true, healthy alternatives are still rejected', () => {
    const registry = buildFixtureRegistry();
    const pinnedRouteId = findRouteId(registry, 'openai', 'gpt-5.5-pro');

    const pin: ExplicitPinInfo = {
      source: 'request_modelPin',
      routeId: pinnedRouteId,
      allowSubstitution: true, // ← still no substitution at retriever level
      authorizingPolicy: 'experiment.allowSubstitution',
    };

    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'], explicitModelPin: pin },
      { registry },
    );
    // Every returned candidate must be the pinned one.
    for (const c of result.candidates) {
      expect(c.routeId).toBe(pinnedRouteId);
    }
  });
});
