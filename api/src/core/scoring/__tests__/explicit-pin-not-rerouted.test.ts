// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * explicit-pin-not-rerouted.test.ts — MVP 4
 *
 * Proves the Explicit Model Pin Invariant (v1.1 §2):
 *
 *   When `context.explicitModelPin` is set, the scorer:
 *     - evaluates ONLY the pinned candidate (matching by routeId →
 *       offeringId → canonicalModelId in priority order).
 *     - rejects the candidate (without substitution) if the pinned
 *       route is unhealthy (no_credits, auth_failed, minimal_chat_failed).
 *     - NEVER returns a result for a different routeId.
 *     - Even when `allowSubstitution: true` — MVP 4 still NEVER substitutes.
 *       A future MVP introduces an `applyPinSubstitution(candidates, pin)`
 *       step that explicitly opts into substitution; the scorer itself
 *       stays strict.
 */

import { describe, expect, it } from 'vitest';
import { scoreModelCandidate } from '../model-scorer';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import { LEGACY_MODELS_FIXTURE } from '../../registry/__tests__/fixtures/legacy-models.fixture';
import type { ModelScoringCandidate } from '../model-scorer';
import type { ProviderModelRoute } from '../../registry/model-route';
import type { CanonicalModel } from '../../registry/canonical-model';
import type { ExplicitPinInfo } from '../../registry/types';

function findCandidate(
  registry: ReturnType<typeof buildFixtureRegistry>,
  providerId: string,
  modelId: string,
): ModelScoringCandidate {
  const snap = LEGACY_MODELS_FIXTURE.find(
    (m) => m.providerId === providerId && m.id === modelId,
  );
  const oid = snap?.uid ?? `${providerId}:${modelId}`;
  const offering = registry.lookupOffering(oid);
  if (!offering) throw new Error('offering missing');
  const canonical = registry.lookupCanonicalModel(offering.canonicalModelId);
  if (!canonical) throw new Error('canonical missing');
  const routes = registry.routesForOffering(oid);
  return { canonicalModel: canonical, offering, route: routes[0] };
}

function withHealthy(c: ModelScoringCandidate): ModelScoringCandidate {
  return {
    ...c,
    canonicalModel: { ...c.canonicalModel, lifecycle: 'current' } as CanonicalModel,
    route: {
      ...c.route,
      healthState: 'healthy',
      creditStatus: 'has_credits',
      minimalChatStatus: 'verified',
      successRateWindow: 0.9,
      latencyP95Ms: 500,
    } as ProviderModelRoute,
  };
}

function withReadiness(
  c: ModelScoringCandidate,
  overrides: Partial<Pick<ProviderModelRoute, 'healthState' | 'creditStatus' | 'minimalChatStatus'>>,
): ModelScoringCandidate {
  return {
    ...c,
    route: { ...c.route, ...overrides } as ProviderModelRoute,
  };
}

describe('explicit pin — matching candidate is evaluated normally', () => {
  it('pin matches candidate by routeId → not rejected', () => {
    const registry = buildFixtureRegistry();
    const pinned = withHealthy(findCandidate(registry, 'anthropic', 'claude-opus-4-7'));
    const pin: ExplicitPinInfo = {
      source: 'request_modelPin',
      routeId: pinned.route.routeId,
      allowSubstitution: false,
    };

    const result = scoreModelCandidate(pinned, {
      requiredCapabilities: ['chat'],
      explicitModelPin: pin,
    });
    expect(result.rejected).toBe(false);
    expect(result.routeId).toBe(pinned.route.routeId);
  });

  it('pin matches by offeringId only → not rejected', () => {
    const registry = buildFixtureRegistry();
    const pinned = withHealthy(findCandidate(registry, 'anthropic', 'claude-opus-4-7'));
    const pin: ExplicitPinInfo = {
      source: 'experiment_pin',
      offeringId: pinned.offering.offeringId,
      allowSubstitution: false,
    };

    const result = scoreModelCandidate(pinned, {
      requiredCapabilities: ['chat'],
      explicitModelPin: pin,
    });
    expect(result.rejected).toBe(false);
  });

  it('pin matches by canonicalModelId only → not rejected', () => {
    const registry = buildFixtureRegistry();
    const pinned = withHealthy(findCandidate(registry, 'anthropic', 'claude-opus-4-7'));
    const pin: ExplicitPinInfo = {
      source: 'internal_pin',
      canonicalModelId: pinned.canonicalModel.canonicalModelId,
      allowSubstitution: false,
    };

    const result = scoreModelCandidate(pinned, {
      requiredCapabilities: ['chat'],
      explicitModelPin: pin,
    });
    expect(result.rejected).toBe(false);
  });
});

describe('explicit pin — other candidates are rejected without substitution', () => {
  it('other route → rejected with pin-mismatch reason', () => {
    const registry = buildFixtureRegistry();
    const pinned = withHealthy(findCandidate(registry, 'anthropic', 'claude-opus-4-7'));
    const otherCandidate = withHealthy(findCandidate(registry, 'openai', 'gpt-5.5-pro'));

    const pin: ExplicitPinInfo = {
      source: 'request_modelPin',
      routeId: pinned.route.routeId,
      allowSubstitution: false,
    };

    const result = scoreModelCandidate(otherCandidate, {
      requiredCapabilities: ['chat'],
      explicitModelPin: pin,
    });
    expect(result.rejected).toBe(true);
    expect(result.rejectionReasons).toContain('explicit_pin_route_mismatch');
    // Result reports the candidate's OWN routeId — not the pin's.
    expect(result.routeId).toBe(otherCandidate.route.routeId);
    expect(result.totalScore).toBe(0);
  });

  it('rejected pin-mismatch candidates report breakdown as all-zero', () => {
    const registry = buildFixtureRegistry();
    const pinned = withHealthy(findCandidate(registry, 'anthropic', 'claude-opus-4-7'));
    const otherCandidate = withHealthy(findCandidate(registry, 'openai', 'gpt-5.5-pro'));

    const pin: ExplicitPinInfo = {
      source: 'request_modelPin',
      routeId: pinned.route.routeId,
      allowSubstitution: false,
    };

    const result = scoreModelCandidate(otherCandidate, {
      requiredCapabilities: ['chat'],
      explicitModelPin: pin,
    });
    for (const v of Object.values(result.breakdown)) {
      expect(v).toBe(0);
    }
  });
});

describe('explicit pin — pinned route unhealthy is REJECTED, NOT substituted', () => {
  it('pinned route with no_credits → rejected with freshness_blocked reason', () => {
    const registry = buildFixtureRegistry();
    const pinned = withReadiness(
      withHealthy(findCandidate(registry, 'anthropic', 'claude-opus-4-7')),
      { creditStatus: 'no_credits' },
    );
    const pin: ExplicitPinInfo = {
      source: 'request_modelPin',
      routeId: pinned.route.routeId,
      allowSubstitution: false,
    };

    const result = scoreModelCandidate(pinned, {
      requiredCapabilities: ['chat'],
      explicitModelPin: pin,
    });
    expect(result.rejected).toBe(true);
    expect(result.rejectionReasons.some((r) => r.startsWith('freshness_blocked'))).toBe(
      true,
    );
    // Critically: result is for the PINNED route, not a substitute.
    expect(result.routeId).toBe(pinned.route.routeId);
  });

  it('pinned route with auth_failed → rejected, NOT substituted', () => {
    const registry = buildFixtureRegistry();
    const pinned = withReadiness(
      withHealthy(findCandidate(registry, 'anthropic', 'claude-opus-4-7')),
      { healthState: 'auth_failed' },
    );
    const pin: ExplicitPinInfo = {
      source: 'request_modelPin',
      routeId: pinned.route.routeId,
      allowSubstitution: false,
    };

    const result = scoreModelCandidate(pinned, {
      requiredCapabilities: ['chat'],
      explicitModelPin: pin,
    });
    expect(result.rejected).toBe(true);
    expect(result.routeId).toBe(pinned.route.routeId);
  });

  it('pinned route with minimalChatStatus=failed → rejected, NOT substituted', () => {
    const registry = buildFixtureRegistry();
    const pinned = withReadiness(
      withHealthy(findCandidate(registry, 'anthropic', 'claude-opus-4-7')),
      { minimalChatStatus: 'failed' },
    );
    const pin: ExplicitPinInfo = {
      source: 'request_modelPin',
      routeId: pinned.route.routeId,
      allowSubstitution: false,
    };

    const result = scoreModelCandidate(pinned, {
      requiredCapabilities: ['chat'],
      explicitModelPin: pin,
    });
    expect(result.rejected).toBe(true);
  });
});

describe('explicit pin — allowSubstitution=true STILL does not substitute in MVP 4', () => {
  it('allowSubstitution=true on a no-credits pinned route → STILL rejected', () => {
    // In MVP 4, the scorer is strict by design. A future MVP introduces
    // a separate `applyPinSubstitution(candidates, pin)` step that opts
    // into substitution explicitly. The SCORER itself never substitutes.
    const registry = buildFixtureRegistry();
    const pinned = withReadiness(
      withHealthy(findCandidate(registry, 'anthropic', 'claude-opus-4-7')),
      { creditStatus: 'no_credits' },
    );
    const pin: ExplicitPinInfo = {
      source: 'request_modelPin',
      routeId: pinned.route.routeId,
      allowSubstitution: true, // ← still no substitution at scorer level
      authorizingPolicy: 'experiment.allowSubstitution',
    };

    const result = scoreModelCandidate(pinned, {
      requiredCapabilities: ['chat'],
      explicitModelPin: pin,
    });
    expect(result.rejected).toBe(true);
    expect(result.routeId).toBe(pinned.route.routeId);
  });

  it('a healthy alternative candidate is STILL rejected when scored against a pin', () => {
    // If the orchestrator naively passed BOTH the pinned route AND a
    // healthy alternative through the scorer with the same pin, the
    // alternative MUST be rejected. Substitution is a higher-layer
    // decision, not a scorer decision.
    const registry = buildFixtureRegistry();
    const pinned = withReadiness(
      withHealthy(findCandidate(registry, 'anthropic', 'claude-opus-4-7')),
      { creditStatus: 'no_credits' },
    );
    const alternative = withHealthy(findCandidate(registry, 'openai', 'gpt-5.5-pro'));

    const pin: ExplicitPinInfo = {
      source: 'request_modelPin',
      routeId: pinned.route.routeId,
      allowSubstitution: true,
      authorizingPolicy: 'experiment.allowSubstitution',
    };

    const altResult = scoreModelCandidate(alternative, {
      requiredCapabilities: ['chat'],
      explicitModelPin: pin,
    });
    expect(altResult.rejected).toBe(true);
    expect(altResult.rejectionReasons).toContain('explicit_pin_route_mismatch');
  });
});

describe('explicit pin — no pin set → normal scoring', () => {
  it('without pin, candidates score normally', () => {
    const registry = buildFixtureRegistry();
    const candidate = withHealthy(findCandidate(registry, 'openai', 'gpt-5.5-pro'));
    const result = scoreModelCandidate(candidate, {
      requiredCapabilities: ['chat'],
    });
    expect(result.rejected).toBe(false);
    expect(result.totalScore).toBeGreaterThan(0);
  });
});
