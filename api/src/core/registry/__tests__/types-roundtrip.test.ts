// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * types-roundtrip.test.ts — MVP 1
 *
 * Validates the three-layer type contract using only fixture data.
 * No I/O, no DB, no provider, no TEI.
 *
 * Asserts:
 *   - A CanonicalModel can have many Offerings.
 *   - An Offering can have many Routes.
 *   - Two routes with same `(accessProviderId, requestModelId)` but
 *     differing `credentialRef` / `region` / `deploymentId` / `accountId`
 *     are DISTINCT entities (different routeId, independent state).
 *   - Pricing lives in ProviderModelRoute.
 *   - Health / quota live in ProviderModelRoute.
 *   - Semantic / capabilities / freshness live in CanonicalModel.
 *   - Aliases / provider naming live in ModelProviderOffering.
 */

import { describe, it, expect } from 'vitest';
import type { CanonicalModel } from '../canonical-model';
import type { ModelProviderOffering } from '../model-offering';
import type { ProviderModelRoute } from '../model-route';
import { buildRouteId } from '../model-route';
import { RuntimeModelRegistry } from '../runtime-model-registry';

// ─── Fixture builders ───────────────────────────────────────────────────

function makeCanonical(overrides: Partial<CanonicalModel> = {}): CanonicalModel {
  return {
    canonicalModelId: 'llama-3.3-70b-instruct',
    family: 'llama',
    version: '3.3',
    generationRank: 7,
    releaseDate: '2024-12-06',
    owner: 'meta',
    sizeParams: 70,
    architecture: 'dense',
    lifecycle: 'current',
    normalizedCapabilities: new Set(['chat', 'tools', 'json_mode', 'streaming']),
    semanticDocument: 'family=llama version=3.3 size=70B caps=chat,tools,json,streaming',
    freshnessScore: 0.95,
    qualityPriorByTaskClass: { chat: 0.82, code: 0.78, reasoning: 0.7 },
    typicalStrengths: ['instruction-following', 'multilingual'],
    knownWeaknesses: ['extended-context-degradation'],
    ...overrides,
  };
}

function makeOffering(overrides: Partial<ModelProviderOffering> = {}): ModelProviderOffering {
  return {
    offeringId: 'offering-groq-llama-3.3-70b-versatile',
    canonicalModelId: 'llama-3.3-70b-instruct',
    modelOwner: 'meta',
    servingProviderId: 'groq',
    providerModelId: 'llama-3.3-70b-versatile',
    aliases: ['llama-3.3-70b', 'meta-llama-3.3-70b-versatile'],
    providerReportedCapabilities: ['chat', 'tools', 'streaming'],
    providerReportedContextWindow: 131072,
    providerReportedMaxOutputTokens: 8192,
    lifecycle: 'active',
    firstSeenAt: '2025-01-01T00:00:00Z',
    lastSeenAt: '2026-05-12T00:00:00Z',
    lastNormalizedAt: '2026-05-12T00:00:00Z',
    ...overrides,
  };
}

function makeRoute(overrides: Partial<ProviderModelRoute> = {}): ProviderModelRoute {
  return {
    routeId: 'route-groq-llama-3.3-70b-versatile',
    canonicalModelId: 'llama-3.3-70b-instruct',
    offeringId: 'offering-groq-llama-3.3-70b-versatile',
    accessProviderId: 'groq',
    servingProviderId: 'groq',
    routeKind: 'native',
    endpointBaseUrl: 'https://api.groq.com/openai/v1',
    endpointPath: '/chat/completions',
    providerModelId: 'llama-3.3-70b-versatile',
    requestModelId: 'llama-3.3-70b-versatile',
    inputCostPer1M: 0.59,
    outputCostPer1M: 0.79,
    cachedInputCostPer1M: null,
    currency: 'USD',
    pricingSource: 'provider-api',
    lastPricingUpdateAt: '2026-05-12T00:00:00Z',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    supportsStreaming: true,
    supportsJson: true,
    supportsTools: true,
    supportsVision: false,
    supportsImages: false,
    supportsAudio: false,
    healthState: 'healthy',
    creditStatus: 'has_credits',
    minimalChatStatus: 'verified',
    latencyP50Ms: 280,
    latencyP95Ms: 720,
    ttftP50Ms: 110,
    ttftP95Ms: 280,
    successRateWindow: 0.98,
    errorRateWindow: 0.02,
    lastProbeAt: '2026-05-12T00:00:00Z',
    lastSuccessAt: '2026-05-12T00:00:00Z',
    lastFailureAt: null,
    failureCooldownUntil: null,
    blockedReason: null,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('CanonicalModel ↔ Offering ↔ Route — three-layer contract', () => {
  it('a CanonicalModel can have many Offerings (different providers)', () => {
    const canonical = makeCanonical();
    const groq = makeOffering({
      offeringId: 'offering-groq-llama-3.3-70b-versatile',
      servingProviderId: 'groq',
      providerModelId: 'llama-3.3-70b-versatile',
    });
    const fireworks = makeOffering({
      offeringId: 'offering-fireworks-llama-3.3-70b',
      servingProviderId: 'fireworks',
      providerModelId: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    });
    const openrouter = makeOffering({
      offeringId: 'offering-openrouter-llama-3.3-70b',
      servingProviderId: 'openrouter',
      providerModelId: 'meta-llama/llama-3.3-70b-instruct',
      modelOwner: 'meta', // attribution preserved
    });

    const registry = new RuntimeModelRegistry({
      canonicalModels: [canonical],
      offerings: [groq, fireworks, openrouter],
      routes: [],
    });

    const offerings = registry.offeringsForCanonical(canonical.canonicalModelId);
    expect(offerings).toHaveLength(3);
    expect(new Set(offerings.map((o) => o.servingProviderId))).toEqual(
      new Set(['groq', 'fireworks', 'openrouter']),
    );
  });

  it('an Offering can have many Routes', () => {
    const canonical = makeCanonical();
    const offering = makeOffering();
    const route1 = makeRoute({ routeId: 'r1', region: 'us-east-1' });
    const route2 = makeRoute({ routeId: 'r2', region: 'eu-central-1' });
    const route3 = makeRoute({ routeId: 'r3', region: 'ap-south-1' });

    const registry = new RuntimeModelRegistry({
      canonicalModels: [canonical],
      offerings: [offering],
      routes: [route1, route2, route3],
    });

    const routes = registry.routesForOffering(offering.offeringId);
    expect(routes).toHaveLength(3);
    expect(new Set(routes.map((r) => r.region))).toEqual(
      new Set(['us-east-1', 'eu-central-1', 'ap-south-1']),
    );
  });

  it('two routes with same (provider, requestModelId) but different credentialRef are DISTINCT', () => {
    const r1Id = buildRouteId({
      offeringId: 'offering-openrouter-claude',
      accessProviderId: 'openrouter',
      credentialRef: 'openrouter:org-a',
    });
    const r2Id = buildRouteId({
      offeringId: 'offering-openrouter-claude',
      accessProviderId: 'openrouter',
      credentialRef: 'openrouter:org-b',
    });
    expect(r1Id).not.toBe(r2Id);
  });

  it('two routes differing by region are DISTINCT', () => {
    const r1Id = buildRouteId({
      offeringId: 'offering-bedrock-claude',
      accessProviderId: 'aws-bedrock',
      region: 'us-east-1',
    });
    const r2Id = buildRouteId({
      offeringId: 'offering-bedrock-claude',
      accessProviderId: 'aws-bedrock',
      region: 'us-west-2',
    });
    expect(r1Id).not.toBe(r2Id);
  });

  it('two routes differing by deploymentId are DISTINCT', () => {
    const r1Id = buildRouteId({
      offeringId: 'offering-azure-openai-gpt-4o',
      accessProviderId: 'azure-openai',
      deploymentId: 'prod-chat',
    });
    const r2Id = buildRouteId({
      offeringId: 'offering-azure-openai-gpt-4o',
      accessProviderId: 'azure-openai',
      deploymentId: 'prod-fallback',
    });
    expect(r1Id).not.toBe(r2Id);
  });

  it('two routes differing by accountId are DISTINCT', () => {
    const r1Id = buildRouteId({
      offeringId: 'offering-vertex-gemini',
      accessProviderId: 'vertex-ai',
      accountId: 'prod',
    });
    const r2Id = buildRouteId({
      offeringId: 'offering-vertex-gemini',
      accessProviderId: 'vertex-ai',
      accountId: 'dev',
    });
    expect(r1Id).not.toBe(r2Id);
  });

  it('buildRouteId is deterministic — same input yields same id', () => {
    const inputs = {
      offeringId: 'o1',
      accessProviderId: 'p1',
      region: 'us-east-1',
      credentialRef: 'cred-x',
    };
    expect(buildRouteId(inputs)).toBe(buildRouteId(inputs));
  });

  it('buildRouteId for the same offering+provider WITHOUT extras returns the same id', () => {
    const a = buildRouteId({ offeringId: 'o1', accessProviderId: 'p1' });
    const b = buildRouteId({ offeringId: 'o1', accessProviderId: 'p1' });
    expect(a).toBe(b);
    expect(a).toBe('o1::p1');
  });
});

describe('Pertinência — pricing lives in ProviderModelRoute', () => {
  it('a route carries inputCostPer1M and outputCostPer1M; canonical does not', () => {
    const route = makeRoute({ inputCostPer1M: 1.23, outputCostPer1M: 4.56 });
    expect(typeof route.inputCostPer1M).toBe('number');
    expect(typeof route.outputCostPer1M).toBe('number');
    // CanonicalModel intentionally has no pricing fields.
    const canonical: CanonicalModel = makeCanonical();
    // @ts-expect-error — CanonicalModel must not declare pricing
    canonical.inputCostPer1M;
  });

  it('cachedInputCostPer1M can be null (not all providers have prompt caching)', () => {
    const route = makeRoute({ cachedInputCostPer1M: null });
    expect(route.cachedInputCostPer1M).toBeNull();
  });

  it('two routes for the same canonical model can have DIFFERENT pricing', () => {
    const native = makeRoute({ routeId: 'native', inputCostPer1M: 3.0, outputCostPer1M: 15.0 });
    const aggregator = makeRoute({
      routeId: 'aggregator',
      inputCostPer1M: 3.45,
      outputCostPer1M: 17.25,
      routeKind: 'aggregator',
    });
    expect(native.inputCostPer1M).not.toBe(aggregator.inputCostPer1M);
  });
});

describe('Pertinência — health/quota live in ProviderModelRoute', () => {
  it('a route carries healthState, creditStatus, latency stats', () => {
    const route = makeRoute({
      healthState: 'degraded',
      creditStatus: 'no_credits',
      latencyP95Ms: 1200,
    });
    expect(route.healthState).toBe('degraded');
    expect(route.creditStatus).toBe('no_credits');
    expect(route.latencyP95Ms).toBe(1200);
    // CanonicalModel must not declare runtime state.
    const canonical: CanonicalModel = makeCanonical();
    // @ts-expect-error — CanonicalModel must not declare healthState
    canonical.healthState;
  });

  it('two routes for same offering have INDEPENDENT health state', () => {
    const ok = makeRoute({ routeId: 'r-ok', healthState: 'healthy' });
    const bad = makeRoute({ routeId: 'r-bad', healthState: 'auth_failed' });
    expect(ok.healthState).not.toBe(bad.healthState);
  });
});

describe('Pertinência — semantic/capabilities/freshness live in CanonicalModel', () => {
  it('canonical carries normalizedCapabilities and freshnessScore', () => {
    const canonical = makeCanonical({
      normalizedCapabilities: new Set(['chat', 'tools', 'vision']),
      freshnessScore: 0.88,
    });
    expect(canonical.normalizedCapabilities.has('chat')).toBe(true);
    expect(canonical.freshnessScore).toBe(0.88);

    // Offering carries providerReportedCapabilities (NOT canonical).
    const offering: ModelProviderOffering = makeOffering();
    // @ts-expect-error — Offering must not declare canonical freshness
    offering.freshnessScore;
  });

  it('canonical semanticDocument is the embedder input', () => {
    const canonical = makeCanonical({
      semanticDocument: 'family=claude owner=anthropic ...',
    });
    expect(canonical.semanticDocument.length).toBeGreaterThan(0);
  });
});

describe('Pertinência — aliases/naming live in ModelProviderOffering', () => {
  it('offering carries aliases array; canonical does not', () => {
    const offering = makeOffering({
      aliases: ['gpt4o', 'openai/gpt-4o-2024-08-06'],
    });
    expect(offering.aliases).toContain('gpt4o');

    const canonical: CanonicalModel = makeCanonical();
    // @ts-expect-error — CanonicalModel must not declare provider aliases
    canonical.aliases;
  });

  it('offering carries providerReportedContextWindow (may differ from canonical)', () => {
    const offering = makeOffering({ providerReportedContextWindow: 200_000 });
    expect(offering.providerReportedContextWindow).toBe(200_000);
  });
});

describe('RuntimeModelRegistry skeleton — lookup primitives', () => {
  it('size() returns counts for all three layers', () => {
    const registry = new RuntimeModelRegistry({
      canonicalModels: [makeCanonical()],
      offerings: [makeOffering()],
      routes: [makeRoute()],
    });
    expect(registry.size()).toEqual({ canonical: 1, offerings: 1, routes: 1 });
  });

  it('empty registry has size 0 for all layers', () => {
    const registry = new RuntimeModelRegistry();
    expect(registry.size()).toEqual({ canonical: 0, offerings: 0, routes: 0 });
  });

  it('lookupRoute returns the route by id, undefined when absent', () => {
    const registry = new RuntimeModelRegistry({
      canonicalModels: [],
      offerings: [],
      routes: [makeRoute({ routeId: 'r-x' })],
    });
    expect(registry.lookupRoute('r-x')?.routeId).toBe('r-x');
    expect(registry.lookupRoute('absent')).toBeUndefined();
  });

  it('lookupCanonicalModel and lookupOffering follow the same pattern', () => {
    const registry = new RuntimeModelRegistry({
      canonicalModels: [makeCanonical({ canonicalModelId: 'c-1' })],
      offerings: [makeOffering({ offeringId: 'o-1' })],
      routes: [],
    });
    expect(registry.lookupCanonicalModel('c-1')?.canonicalModelId).toBe('c-1');
    expect(registry.lookupOffering('o-1')?.offeringId).toBe('o-1');
    expect(registry.lookupCanonicalModel('absent')).toBeUndefined();
  });

  it('routesForCanonical groups routes correctly across providers', () => {
    const canonical = makeCanonical({ canonicalModelId: 'claude-opus-4-7' });
    const r1 = makeRoute({
      routeId: 'r-native',
      canonicalModelId: 'claude-opus-4-7',
      offeringId: 'o-anthropic',
      accessProviderId: 'anthropic',
      routeKind: 'native',
    });
    const r2 = makeRoute({
      routeId: 'r-hub',
      canonicalModelId: 'claude-opus-4-7',
      offeringId: 'o-aihubmix',
      accessProviderId: 'aihubmix',
      routeKind: 'aggregator',
    });

    const registry = new RuntimeModelRegistry({
      canonicalModels: [canonical],
      offerings: [],
      routes: [r1, r2],
    });

    const routes = registry.routesForCanonical('claude-opus-4-7');
    expect(routes).toHaveLength(2);
    expect(new Set(routes.map((r) => r.routeKind))).toEqual(
      new Set(['native', 'aggregator']),
    );
  });

  it('getVersion and getBuiltAt return values from the snapshot', () => {
    const registry = new RuntimeModelRegistry({
      canonicalModels: [],
      offerings: [],
      routes: [],
      builtAt: 1_700_000_000_000,
      version: 42,
    });
    expect(registry.getVersion()).toBe(42);
    expect(registry.getBuiltAt()).toBe(1_700_000_000_000);
  });

  it('defaults: getVersion=1 and getBuiltAt is a finite number', () => {
    const registry = new RuntimeModelRegistry();
    expect(registry.getVersion()).toBe(1);
    expect(Number.isFinite(registry.getBuiltAt())).toBe(true);
  });
});
