// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-H §20 — Tests for buildRouteCandidatesForModel().
 *
 * Pins behavior of the route candidate builder:
 *   - Pulls native + router routes from taxonomy
 *   - Resolves apiModelId per route via injected resolver
 *   - Classifies equivalence (exact / same_provider_via_router / etc.)
 *   - Rejects per filter (capability, budget, live-readiness, equivalence)
 *   - Orders by policy.orderBy with correct tie-breaks
 *   - Caps at policy.maxRouteAttempts
 *   - Surfaces coverage + rejections
 */
import { describe, it, expect } from 'vitest';
import {
  buildRouteCandidatesForModel,
  classifyRouteEquivalence,
  type ApiModelIdResolver,
  type LiveOperabilityLookup,
  type RouteEconomicsLookup,
} from '../build-route-candidates';
import { STRICT_DEFAULT_ROUTE_SELECTION_POLICY } from '../route-candidates';

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

function defaultResolver(): ApiModelIdResolver {
  return ({ providerId, logicalModelId, nativeProviderId }) => {
    // Native route: apiModelId === logical id
    if (providerId === nativeProviderId) return logicalModelId;
    // Router route serving the same native: rewrite as `<native>/<logical>`
    return `${nativeProviderId}/${logicalModelId}`;
  };
}

function liveReadyLookup(): LiveOperabilityLookup {
  return ({ providerId }) => ({
    chatReady: true,
    lastSuccessAt: new Date(Date.parse('2026-05-16T10:00:00Z')).toISOString(),
    healthRank: providerId === 'openai' ? 95 : 80,
  });
}

function neverReadyLookup(): LiveOperabilityLookup {
  return () => ({ chatReady: false });
}

function defaultEconomics(): RouteEconomicsLookup {
  return ({ providerId }) => ({
    inputCostPerMTok: providerId === 'openai' ? 5 : 7,
    outputCostPerMTok: providerId === 'openai' ? 15 : 20,
    maxContextTokens: 128_000,
    costRank: providerId === 'openai' ? 10 : 40,
    latencyRank: providerId === 'openrouter' ? 30 : 20,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Basic happy paths
// ──────────────────────────────────────────────────────────────────────

describe('buildRouteCandidatesForModel — happy paths', () => {
  it('returns native + multiple routers for openai/gpt-4o (live-ready policy met)', () => {
    const out = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      nativeProviderId: 'openai',
      taskCapability: 'chat',
      resolveApiModelId: defaultResolver(),
      lookupLiveOperability: liveReadyLookup(),
      lookupEconomics: defaultEconomics(),
      lookupAuthHandle: () => 'env:OPENAI_API_KEY',
    });
    expect(out.approved.length).toBeGreaterThan(0);
    // 01C.1B-J1R2 — `approved` is now the DISCOVERY view (capped by
    // `discoveryMaxRouteCandidates`, default 200). The runtime cap
    // applies to `approvedForExecution`, which is the strict slice.
    expect(out.approvedForExecution.length).toBeLessThanOrEqual(STRICT_DEFAULT_ROUTE_SELECTION_POLICY.maxRouteAttempts);
    expect(out.coverage.role).toBe('participant');
    expect(out.coverage.hasNativeRoute).toBe(true);
  });

  it('first candidate is the native (nativeFirst ordering kicks in on ties)', () => {
    const out = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      nativeProviderId: 'openai',
      taskCapability: 'chat',
      resolveApiModelId: defaultResolver(),
      lookupLiveOperability: liveReadyLookup(),
      lookupEconomics: defaultEconomics(),
      lookupAuthHandle: () => 'env:KEY',
    });
    expect(out.approved[0].providerId).toBe('openai');
    expect(out.approved[0].routerId).toBeUndefined();
    expect(out.approved[0].equivalenceKind).toBe('exact_same_model');
  });

  it('router candidates carry routerId + upstreamProviderId + same_provider_model_via_router', () => {
    const out = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      nativeProviderId: 'openai',
      taskCapability: 'chat',
      resolveApiModelId: defaultResolver(),
      lookupLiveOperability: liveReadyLookup(),
      lookupEconomics: defaultEconomics(),
      lookupAuthHandle: () => 'env:KEY',
    });
    const router = out.approved.find((c) => c.routerId !== undefined);
    expect(router).toBeDefined();
    expect(router!.routerId).toBeDefined();
    expect(router!.equivalenceKind).toBe('same_provider_model_via_router');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Rejection filters
// ──────────────────────────────────────────────────────────────────────

describe('buildRouteCandidatesForModel — rejection filters', () => {
  it('rejects all routes when live-readiness lookup returns chatReady=false (strict mode)', () => {
    const out = buildRouteCandidatesForModel({
      role: 'judge',
      logicalModelId: 'claude-3.5-sonnet',
      nativeProviderId: 'anthropic',
      taskCapability: 'chat',
      resolveApiModelId: defaultResolver(),
      lookupLiveOperability: neverReadyLookup(),
      lookupEconomics: defaultEconomics(),
      lookupAuthHandle: () => 'env:KEY',
    });
    expect(out.approved).toEqual([]);
    expect(out.rejections.length).toBeGreaterThan(0);
    for (const r of out.rejections) {
      expect(r.reason).toBe('unauditied_live_state');
    }
  });

  it('rejects route when resolver returns undefined (capability_mismatch)', () => {
    const out = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      nativeProviderId: 'openai',
      taskCapability: 'chat',
      resolveApiModelId: ({ providerId }) => providerId === 'openai' ? 'gpt-4o' : undefined,
      lookupLiveOperability: liveReadyLookup(),
      lookupEconomics: defaultEconomics(),
      lookupAuthHandle: () => 'env:KEY',
    });
    expect(out.approved.length).toBeLessThanOrEqual(STRICT_DEFAULT_ROUTE_SELECTION_POLICY.maxRouteAttempts);
    const capabilityRejections = out.rejections.filter((r) => r.reason === 'capability_mismatch');
    expect(capabilityRejections.length).toBeGreaterThan(0);
  });

  it('rejects routes with no auth handle (auth_handle_missing)', () => {
    const out = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      nativeProviderId: 'openai',
      taskCapability: 'chat',
      resolveApiModelId: defaultResolver(),
      lookupLiveOperability: liveReadyLookup(),
      lookupEconomics: defaultEconomics(),
      lookupAuthHandle: () => undefined,
    });
    expect(out.approved).toEqual([]);
    expect(out.rejections.every((r) => r.reason === 'auth_handle_missing')).toBe(true);
  });

  it('rejects routes over budget when maxCostUsd is tight', () => {
    const out = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      nativeProviderId: 'openai',
      taskCapability: 'chat',
      resolveApiModelId: defaultResolver(),
      lookupLiveOperability: liveReadyLookup(),
      lookupEconomics: defaultEconomics(),
      lookupAuthHandle: () => 'env:KEY',
      maxCostUsd: 0.0000001,  // absurdly tight; every route over-budget
    });
    expect(out.approved).toEqual([]);
    expect(out.rejections.some((r) => r.reason === 'over_budget')).toBe(true);
  });

  it('caps approvedForExecution at policy.runtimeMaxRouteAttempts (legacy maxRouteAttempts alias)', () => {
    // 01C.1B-J1R2 — `approved` is the DISCOVERY view (capped by
    // discoveryMaxRouteCandidates, default 200). The runtime cap
    // governs `approvedForExecution`. Setting BOTH discovery and
    // runtime caps to 2 reproduces the legacy "approved capped at 2"
    // semantics for assertions that need a hard discovery limit.
    const out = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      nativeProviderId: 'openai',
      taskCapability: 'chat',
      resolveApiModelId: defaultResolver(),
      lookupLiveOperability: liveReadyLookup(),
      lookupEconomics: defaultEconomics(),
      lookupAuthHandle: () => 'env:KEY',
      policy: {
        ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
        maxRouteAttempts: 2,
        discoveryMaxRouteCandidates: 2,
        runtimeMaxRouteAttempts: 2,
      },
    });
    expect(out.approvedForExecution.length).toBeLessThanOrEqual(2);
    expect(out.approved.length).toBeLessThanOrEqual(2); // discovery cap honored
    expect(out.rejections.some((r) => r.reason === 'over_attempt_cap')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Equivalence classification
// ──────────────────────────────────────────────────────────────────────

describe('classifyRouteEquivalence', () => {
  it('native + same id → exact_same_model', () => {
    const k = classifyRouteEquivalence({
      route: { providerId: 'openai', kind: 'native' },
      logicalModelId: 'gpt-4o',
      apiModelId: 'gpt-4o',
      nativeProviderId: 'openai',
    });
    expect(k).toBe('exact_same_model');
  });

  it('router serving same native → same_provider_model_via_router', () => {
    const k = classifyRouteEquivalence({
      route: { providerId: 'openrouter', kind: 'router', nativeProviderId: 'openai', upstreamSlug: 'openai' },
      logicalModelId: 'gpt-4o',
      apiModelId: 'openai/gpt-4o',
      nativeProviderId: 'openai',
    });
    expect(k).toBe('same_provider_model_via_router');
  });

  it('router serving different native → family_equivalent', () => {
    const k = classifyRouteEquivalence({
      route: { providerId: 'openrouter', kind: 'router', nativeProviderId: 'anthropic', upstreamSlug: 'anthropic' },
      logicalModelId: 'gpt-4o',
      apiModelId: 'anthropic/claude-3.5-sonnet',
      nativeProviderId: 'openai',
    });
    expect(k).toBe('family_equivalent');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Coverage shape
// ──────────────────────────────────────────────────────────────────────

describe('coverage summary', () => {
  it('coverage.hasNativeRoute is true when openai route is approved', () => {
    const out = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      nativeProviderId: 'openai',
      taskCapability: 'chat',
      resolveApiModelId: defaultResolver(),
      lookupLiveOperability: liveReadyLookup(),
      lookupEconomics: defaultEconomics(),
      lookupAuthHandle: () => 'env:KEY',
    });
    expect(out.coverage.hasNativeRoute).toBe(true);
  });

  it('coverage.liveReadyCount equals approved.filter(c=>c.liveReady).length', () => {
    const out = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      nativeProviderId: 'openai',
      taskCapability: 'chat',
      resolveApiModelId: defaultResolver(),
      lookupLiveOperability: liveReadyLookup(),
      lookupEconomics: defaultEconomics(),
      lookupAuthHandle: () => 'env:KEY',
    });
    const liveCount = out.approved.filter((c) => c.liveReady).length;
    expect(out.coverage.liveReadyCount).toBe(liveCount);
  });

  it('coverage.rejectedCount matches rejections.length', () => {
    const out = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      nativeProviderId: 'openai',
      taskCapability: 'chat',
      resolveApiModelId: defaultResolver(),
      lookupLiveOperability: neverReadyLookup(),
      lookupEconomics: defaultEconomics(),
      lookupAuthHandle: () => 'env:KEY',
    });
    expect(out.coverage.rejectedCount).toBe(out.rejections.length);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Multi-route operator scenario (the user's "if route fails, try next")
// ──────────────────────────────────────────────────────────────────────

describe('Multi-route fallback scenario', () => {
  it('when openai live state is unhealthy, router routes can still be approved', () => {
    const out = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      nativeProviderId: 'openai',
      taskCapability: 'chat',
      resolveApiModelId: defaultResolver(),
      lookupLiveOperability: ({ providerId }) => ({
        chatReady: providerId !== 'openai',
        healthRank: providerId === 'openai' ? 10 : 85,
        lastFailureKind: providerId === 'openai' ? 'invalid_auth' : undefined,
      }),
      lookupEconomics: defaultEconomics(),
      lookupAuthHandle: () => 'env:KEY',
    });
    // openai itself is rejected (unauditied_live_state with last_failure=invalid_auth),
    // but routers should remain.
    expect(out.approved.every((c) => c.providerId !== 'openai')).toBe(true);
    expect(out.approved.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Routes are de-duplicated by routeId
// ──────────────────────────────────────────────────────────────────────

describe('Route de-duplication', () => {
  it('two raw routes that resolve to the same (providerId, apiModelId, adapterKind) trigger duplicate_route_id', () => {
    const out = buildRouteCandidatesForModel({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      nativeProviderId: 'openai',
      taskCapability: 'chat',
      resolveApiModelId: () => 'gpt-4o',  // every route gets the same apiModelId
      lookupLiveOperability: liveReadyLookup(),
      lookupEconomics: defaultEconomics(),
      lookupAuthHandle: () => 'env:KEY',
      lookupAdapterKind: () => 'openai-compatible-chat',  // same adapter kind for all
      routeCandidatesOverride: [
        { providerId: 'openai', kind: 'native' },
        { providerId: 'openai', kind: 'native' },  // intentional duplicate
      ],
    });
    expect(out.rejections.some((r) => r.reason === 'duplicate_route_id')).toBe(true);
    expect(out.approved).toHaveLength(1);  // dedup yielded a single approved entry
  });
});
