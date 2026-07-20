// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * model-scorer-structural.test.ts — MVP 4
 *
 * Exercises the scorer's HAPPY paths plus a handful of structural
 * filters. Verifies:
 *   - scoreBreakdown carries 8 components.
 *   - capabilityFit reflects required-cap presence.
 *   - contextFit reflects minContextWindow.
 *   - routeReliability reflects route.successRateWindow.
 *   - costEfficiency, latencyScore reflect pricing/latency.
 *   - lifecycle gates the candidate via freshness.
 *   - privacy_required forces local route.
 *   - rejected candidates have zero total.
 */

import { describe, expect, it } from 'vitest';
import { scoreModelCandidate } from '../model-scorer';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import { LEGACY_MODELS_FIXTURE } from '../../registry/__tests__/fixtures/legacy-models.fixture';
import type { ModelScoringCandidate } from '../model-scorer';
import type { ProviderModelRoute } from '../../registry/model-route';
import type { CanonicalModel } from '../../registry/canonical-model';
import type { ModelProviderOffering } from '../../registry/model-offering';

function findCandidate(
  registry: ReturnType<typeof buildFixtureRegistry>,
  providerId: string,
  modelId: string,
): ModelScoringCandidate {
  const offeringId = `${providerId}:${modelId}`;
  const snap = LEGACY_MODELS_FIXTURE.find(
    (m) => m.providerId === providerId && m.id === modelId,
  );
  // The fixture sometimes provides a `uid` — prefer it.
  const oid = snap?.uid ?? offeringId;
  const offering = registry.lookupOffering(oid);
  if (!offering) throw new Error(`offering not found: ${oid}`);
  const canonicalId = offering.canonicalModelId;
  const canonical = registry.lookupCanonicalModel(canonicalId);
  if (!canonical) throw new Error(`canonical not found: ${canonicalId}`);
  const routes = registry.routesForOffering(oid);
  if (routes.length === 0) throw new Error(`no routes for offering: ${oid}`);
  return { canonicalModel: canonical, offering, route: routes[0] };
}

/**
 * Helper that synthesises a candidate with overrides on route fields
 * (so individual tests can set successRateWindow, latency, etc., without
 * mutating the shared fixture).
 */
function withRouteOverrides(
  candidate: ModelScoringCandidate,
  overrides: Partial<ProviderModelRoute>,
): ModelScoringCandidate {
  return {
    ...candidate,
    route: { ...candidate.route, ...overrides } as ProviderModelRoute,
  };
}

function withCanonicalOverrides(
  candidate: ModelScoringCandidate,
  overrides: Partial<CanonicalModel>,
): ModelScoringCandidate {
  return {
    ...candidate,
    canonicalModel: { ...candidate.canonicalModel, ...overrides } as CanonicalModel,
  };
}

function withOfferingOverrides(
  candidate: ModelScoringCandidate,
  overrides: Partial<ModelProviderOffering>,
): ModelScoringCandidate {
  return {
    ...candidate,
    offering: { ...candidate.offering, ...overrides } as ModelProviderOffering,
  };
}

const HEALTHY_ROUTE_OVERRIDES = {
  healthState: 'healthy' as const,
  creditStatus: 'has_credits' as const,
  minimalChatStatus: 'verified' as const,
  successRateWindow: 0.95,
  latencyP95Ms: 600,
};

const HEALTHY_CANONICAL_OVERRIDES = {
  lifecycle: 'current' as const,
};

describe('scoreModelCandidate — happy path', () => {
  it('returns a non-rejected result with 8 breakdown components', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'anthropic', 'claude-opus-4-7');
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      HEALTHY_ROUTE_OVERRIDES,
    );
    const result = scoreModelCandidate(candidate, {
      requiredCapabilities: ['chat'],
    });
    expect(result.rejected).toBe(false);
    expect(result.totalScore).toBeGreaterThan(0);
    expect(Object.keys(result.breakdown)).toEqual([
      'capabilityFit',
      'freshness',
      'routeReliability',
      'latencyScore',
      'costEfficiency',
      'contextFit',
      'localPreference',
      'riskPenalty',
    ]);
    expect(result.freshnessStatus).toBe('current_and_routable');
  });
});

describe('scoreModelCandidate — capabilityFit reflects required caps', () => {
  it('all required caps present → capabilityFit = 1', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'openai', 'gpt-5.5-pro');
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      HEALTHY_ROUTE_OVERRIDES,
    );
    const result = scoreModelCandidate(candidate, {
      requiredCapabilities: ['chat', 'tools', 'json_mode', 'vision'],
    });
    expect(result.breakdown.capabilityFit).toBe(1);
    expect(result.rejected).toBe(false);
  });

  it('missing required cap → rejected with reason', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'mistral', 'mistral-large-2'); // no vision
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      HEALTHY_ROUTE_OVERRIDES,
    );
    const result = scoreModelCandidate(candidate, {
      requiredCapabilities: ['chat', 'vision'],
    });
    expect(result.rejected).toBe(true);
    expect(result.rejectionReasons.join(' ')).toContain('vision');
  });

  it('no required caps → capabilityFit = 1 (degenerate-OK)', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'anthropic', 'claude-opus-4-7');
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      HEALTHY_ROUTE_OVERRIDES,
    );
    const result = scoreModelCandidate(candidate, {});
    expect(result.breakdown.capabilityFit).toBe(1);
  });
});

describe('scoreModelCandidate — minContextWindow filter', () => {
  it('contextWindow >= min → contextFit = 1', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'google', 'gemini-2.5-pro'); // 1M ctx
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      HEALTHY_ROUTE_OVERRIDES,
    );
    const result = scoreModelCandidate(candidate, {
      requiredCapabilities: ['chat'],
      minContextWindow: 100_000,
    });
    expect(result.breakdown.contextFit).toBe(1);
    expect(result.rejected).toBe(false);
  });

  it('contextWindow < min → rejected', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'ollama', 'mistral-small-3'); // 32k
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      HEALTHY_ROUTE_OVERRIDES,
    );
    const result = scoreModelCandidate(candidate, {
      requiredCapabilities: ['chat'],
      minContextWindow: 200_000,
    });
    expect(result.rejected).toBe(true);
    expect(result.rejectionReasons.join(' ')).toContain('context_window_below_min');
  });
});

describe('scoreModelCandidate — runtime state', () => {
  it('routeReliability reflects successRateWindow', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'anthropic', 'claude-opus-4-7');
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      { ...HEALTHY_ROUTE_OVERRIDES, successRateWindow: 0.62 },
    );
    const result = scoreModelCandidate(candidate, { requiredCapabilities: ['chat'] });
    expect(result.breakdown.routeReliability).toBe(0.62);
  });

  it('latencyScore is high for low p95 and low for high p95', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'anthropic', 'claude-opus-4-7');
    const fast = scoreModelCandidate(
      withRouteOverrides(withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES), {
        ...HEALTHY_ROUTE_OVERRIDES,
        latencyP95Ms: 100,
      }),
      { requiredCapabilities: ['chat'] },
    );
    const slow = scoreModelCandidate(
      withRouteOverrides(withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES), {
        ...HEALTHY_ROUTE_OVERRIDES,
        latencyP95Ms: 4_000,
      }),
      { requiredCapabilities: ['chat'] },
    );
    expect(fast.breakdown.latencyScore).toBeGreaterThan(slow.breakdown.latencyScore);
  });

  it('null latency → fallback score of 0.5', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'anthropic', 'claude-opus-4-7');
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      { ...HEALTHY_ROUTE_OVERRIDES, latencyP95Ms: null },
    );
    const result = scoreModelCandidate(candidate, { requiredCapabilities: ['chat'] });
    expect(result.breakdown.latencyScore).toBe(0.5);
  });
});

describe('scoreModelCandidate — cost', () => {
  it('costEfficiency higher when cost lower', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'anthropic', 'claude-opus-4-7');
    const cheap = scoreModelCandidate(
      withRouteOverrides(withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES), {
        ...HEALTHY_ROUTE_OVERRIDES,
        inputCostPer1M: 1,
        outputCostPer1M: 1,
      }),
      { requiredCapabilities: ['chat'] },
    );
    const expensive = scoreModelCandidate(
      withRouteOverrides(withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES), {
        ...HEALTHY_ROUTE_OVERRIDES,
        inputCostPer1M: 30,
        outputCostPer1M: 30,
      }),
      { requiredCapabilities: ['chat'] },
    );
    expect(cheap.breakdown.costEfficiency).toBeGreaterThan(expensive.breakdown.costEfficiency);
  });
});

describe('scoreModelCandidate — privacy', () => {
  it('local_required + external route → rejected', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'anthropic', 'claude-opus-4-7');
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      HEALTHY_ROUTE_OVERRIDES,
    );
    const result = scoreModelCandidate(candidate, {
      requiredCapabilities: ['chat'],
      privacyMode: 'local_required',
    });
    expect(result.rejected).toBe(true);
    expect(result.rejectionReasons[0]).toBe('privacy_local_required_but_route_is_external');
  });

  it('local_required + local route → not rejected for that reason', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'ollama', 'llama-3.3-70b');
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      HEALTHY_ROUTE_OVERRIDES,
    );
    const result = scoreModelCandidate(candidate, {
      requiredCapabilities: ['chat'],
      privacyMode: 'local_required',
    });
    expect(result.rejected).toBe(false);
    expect(result.breakdown.localPreference).toBe(1);
  });

  it('local_preferred + local route → boost (localPreference=1)', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'ollama', 'llama-3.3-70b');
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      HEALTHY_ROUTE_OVERRIDES,
    );
    const result = scoreModelCandidate(candidate, {
      requiredCapabilities: ['chat'],
      privacyMode: 'local_preferred',
    });
    expect(result.breakdown.localPreference).toBe(1);
  });
});

describe('scoreModelCandidate — risk penalty', () => {
  it('preview lifecycle → riskPenalty > 0', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'openai', 'o3-mini-preview');
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, { lifecycle: 'preview' }),
      HEALTHY_ROUTE_OVERRIDES,
    );
    const result = scoreModelCandidate(candidate, {
      requiredCapabilities: ['chat'],
      policy: {
        weights: {
          capabilityFit: 0.2,
          freshness: 0.15,
          routeReliability: 0.15,
          latencyScore: 0.1,
          costEfficiency: 0.1,
          contextFit: 0.1,
          localPreference: 0.1,
          riskPenalty: 0.1,
        },
        thresholds: {
          minCapabilityFit: 1,
          minRouteReliability: 0,
          minScoreForSelection: 0,
        },
        freshness: { allowPreview: true, allowDeprecated: false },
      },
    });
    expect(result.breakdown.riskPenalty).toBe(0.5);
  });

  it('current lifecycle → riskPenalty = 0', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'anthropic', 'claude-opus-4-7');
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      HEALTHY_ROUTE_OVERRIDES,
    );
    const result = scoreModelCandidate(candidate, { requiredCapabilities: ['chat'] });
    expect(result.breakdown.riskPenalty).toBe(0);
  });
});

describe('scoreModelCandidate — rejected candidates have zero total', () => {
  it('rejected → totalScore = 0', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'mistral', 'mistral-large-2');
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      HEALTHY_ROUTE_OVERRIDES,
    );
    const result = scoreModelCandidate(candidate, {
      requiredCapabilities: ['vision'],
    });
    expect(result.rejected).toBe(true);
    expect(result.totalScore).toBe(0);
  });

  it('rejected → breakdown is all-zeroes', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'mistral', 'mistral-large-2');
    const candidate = withRouteOverrides(
      withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES),
      HEALTHY_ROUTE_OVERRIDES,
    );
    const result = scoreModelCandidate(candidate, {
      requiredCapabilities: ['vision'],
    });
    for (const v of Object.values(result.breakdown)) {
      expect(v).toBe(0);
    }
  });
});

describe('scoreModelCandidate — does not mutate input', () => {
  it('candidate object is unchanged after scoring', () => {
    const registry = buildFixtureRegistry();
    const raw = findCandidate(registry, 'anthropic', 'claude-opus-4-7');
    const candidate = withOfferingOverrides(
      withRouteOverrides(withCanonicalOverrides(raw, HEALTHY_CANONICAL_OVERRIDES), HEALTHY_ROUTE_OVERRIDES),
      {},
    );
    const before = JSON.stringify({
      c: candidate.canonicalModel.canonicalModelId,
      o: candidate.offering.offeringId,
      r: candidate.route.routeId,
    });
    scoreModelCandidate(candidate, { requiredCapabilities: ['chat'] });
    const after = JSON.stringify({
      c: candidate.canonicalModel.canonicalModelId,
      o: candidate.offering.offeringId,
      r: candidate.route.routeId,
    });
    expect(after).toBe(before);
  });
});
