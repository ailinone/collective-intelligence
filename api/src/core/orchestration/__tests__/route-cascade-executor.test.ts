// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-H §20 — Tests for RouteCascadeExecutor.
 *
 * Pure executor — tests inject a mock `callRoute` to simulate every
 * outcome (success on first, success on second after auth failure,
 * total failure, attempt-cap exhaustion, etc.).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runRouteCascade,
  summarizeCascadeRuns,
  type RouteCallResult,
} from '../route-cascade-executor';
import {
  STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
  type ApprovedRouteCandidate,
  type RouteSelectionPolicy,
} from '../route-candidates';

function makeRoute(over: Partial<ApprovedRouteCandidate> & { providerId: string }): ApprovedRouteCandidate {
  return {
    routeId: `${over.providerId}::api::openai-compatible-chat`,
    logicalModelId: 'gpt-4o',
    apiModelId: 'gpt-4o',
    providerId: over.providerId,
    adapterKind: 'openai-compatible-chat',
    endpointKind: 'chat',
    equivalenceKind: 'exact_same_model',
    liveReady: true,
    source: 'native_provider',
    ...over,
  };
}

function frozenClock(): () => number {
  let t = 1_700_000_000_000;
  return () => {
    const v = t;
    t += 100;  // each call advances 100ms (gives latencyMs=100 per attempt)
    return v;
  };
}

// ──────────────────────────────────────────────────────────────────────
// First route succeeds
// ──────────────────────────────────────────────────────────────────────

describe('runRouteCascade — first route succeeds', () => {
  it('returns success on attempt 1 and records exactly one attempt', async () => {
    const routes = [makeRoute({ providerId: 'openai' }), makeRoute({ providerId: 'openrouter' })];
    const callRoute = vi.fn(async () => ({ ok: true, response: { content: 'OK' }, costUsd: 0.0001 } as RouteCallResult<{ content: string }>));
    const out = await runRouteCascade({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      approvedRoutes: routes,
      policy: STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
      callRoute,
      now: frozenClock(),
    });
    expect(out.success).toBe(true);
    expect(out.winningRoute?.providerId).toBe('openai');
    expect(out.attempts).toHaveLength(1);
    expect(callRoute).toHaveBeenCalledTimes(1);
  });

  it('attempt record marks wasRouteFallback=false on the first', async () => {
    const routes = [makeRoute({ providerId: 'openai' })];
    const out = await runRouteCascade({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      approvedRoutes: routes,
      policy: STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
      callRoute: async () => ({ ok: true, response: {}, costUsd: 0.0001 }),
      now: frozenClock(),
    });
    expect(out.attempts[0].wasRouteFallback).toBe(false);
    expect(out.attempts[0].wasModelFallback).toBe(false);
    expect(out.attempts[0].wasRetried).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// First fails, second succeeds (the cascade key behavior)
// ──────────────────────────────────────────────────────────────────────

describe('runRouteCascade — fallback to next route', () => {
  it('when openai 401 invalid_auth, falls through to openrouter and succeeds', async () => {
    const routes = [
      makeRoute({ providerId: 'openai' }),
      makeRoute({ providerId: 'openrouter', routerId: 'openrouter', upstreamProviderId: 'openai',
                 source: 'router_taxonomy', equivalenceKind: 'same_provider_model_via_router' }),
    ];
    const callRoute = vi.fn(async (route) => {
      if (route.providerId === 'openai') {
        return { ok: false, httpStatus: 401, errorKind: 'invalid_auth' as const, costUsd: 0 };
      }
      return { ok: true, response: { content: 'OK' }, costUsd: 0.0001 };
    });
    const out = await runRouteCascade({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      approvedRoutes: routes,
      policy: STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
      callRoute,
      now: frozenClock(),
    });
    expect(out.success).toBe(true);
    expect(out.winningRoute?.providerId).toBe('openrouter');
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[0].ok).toBe(false);
    expect(out.attempts[0].wasRouteFallback).toBe(false);
    expect(out.attempts[1].ok).toBe(true);
    expect(out.attempts[1].wasRouteFallback).toBe(true);
  });

  it('cascades through credit/auth/rate_limit/model_not_supported failures', async () => {
    const routes = ['a', 'b', 'c', 'd'].map((p) => makeRoute({ providerId: p }));
    const failures = ['insufficient_credits', 'invalid_auth', 'rate_limited', 'model_not_supported'] as const;
    let idx = 0;
    const callRoute = vi.fn(async () => {
      const kind = failures[idx];
      idx++;
      if (idx === failures.length) {
        return { ok: true, response: {}, costUsd: 0.0001 };
      }
      return { ok: false, errorKind: kind, costUsd: 0 };
    });
    const out = await runRouteCascade({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      approvedRoutes: routes,
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, maxRouteAttempts: 4 },
      callRoute,
      now: frozenClock(),
    });
    expect(out.success).toBe(true);
    expect(out.attempts).toHaveLength(4);
    expect(out.attempts.slice(0, 3).every((a) => !a.ok)).toBe(true);
    expect(out.attempts[3].ok).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// All routes fail
// ──────────────────────────────────────────────────────────────────────

describe('runRouteCascade — all routes fail', () => {
  it('returns aggregate=all_routes_failed when every route fails', async () => {
    const routes = ['a', 'b', 'c'].map((p) => makeRoute({ providerId: p }));
    const callRoute = vi.fn(async () => ({ ok: false, errorKind: 'invalid_auth' as const, costUsd: 0 }));
    const out = await runRouteCascade({
      role: 'judge',
      logicalModelId: 'gpt-4o',
      approvedRoutes: routes,
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, maxRouteAttempts: 3 },
      callRoute,
      now: frozenClock(),
    });
    expect(out.success).toBe(false);
    expect(out.aggregateFailure).toBe('all_routes_failed');
    expect(out.firstErrorKind).toBe('invalid_auth');
    expect(out.attempts).toHaveLength(3);
  });

  it('records all attempts even when all fail', async () => {
    const routes = ['a', 'b'].map((p) => makeRoute({ providerId: p }));
    const out = await runRouteCascade({
      role: 'fallback',
      logicalModelId: 'gpt-4o',
      approvedRoutes: routes,
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, maxRouteAttempts: 2 },
      callRoute: async () => ({ ok: false, errorKind: 'rate_limited', costUsd: 0 }),
      now: frozenClock(),
    });
    expect(out.attempts).toHaveLength(2);
    for (const a of out.attempts) expect(a.ok).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Attempt cap exhaustion
// ──────────────────────────────────────────────────────────────────────

describe('runRouteCascade — attempt cap', () => {
  it('respects maxRouteAttempts=2 even with 5 routes available', async () => {
    const routes = ['a', 'b', 'c', 'd', 'e'].map((p) => makeRoute({ providerId: p }));
    const callRoute = vi.fn(async () => ({ ok: false, errorKind: 'invalid_auth' as const, costUsd: 0 }));
    const policy: RouteSelectionPolicy = { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, maxRouteAttempts: 2 };
    const out = await runRouteCascade({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      approvedRoutes: routes,
      policy,
      callRoute,
      now: frozenClock(),
    });
    expect(out.success).toBe(false);
    expect(out.attempts).toHaveLength(2);
    expect(callRoute).toHaveBeenCalledTimes(2);
    expect(out.aggregateFailure).toBe('attempt_cap_exhausted');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Empty routes
// ──────────────────────────────────────────────────────────────────────

describe('runRouteCascade — no approved routes', () => {
  it('returns no_approved_routes when input list is empty', async () => {
    const callRoute = vi.fn();
    const out = await runRouteCascade({
      role: 'judge',
      logicalModelId: 'gpt-4o',
      approvedRoutes: [],
      policy: STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
      callRoute,
      now: frozenClock(),
    });
    expect(out.success).toBe(false);
    expect(out.aggregateFailure).toBe('no_approved_routes');
    expect(callRoute).not.toHaveBeenCalled();
    expect(out.attempts).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Out-of-plan routes — never used
// ──────────────────────────────────────────────────────────────────────

describe('runRouteCascade — strict invariants', () => {
  it('never calls a route NOT in the approved list', async () => {
    const approved = [makeRoute({ providerId: 'openai' })];
    let callCount = 0;
    const seenProviders: string[] = [];
    const callRoute = vi.fn(async (route) => {
      callCount++;
      seenProviders.push(route.providerId);
      return { ok: false, errorKind: 'invalid_auth' as const, costUsd: 0 };
    });
    await runRouteCascade({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      approvedRoutes: approved,
      policy: STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
      callRoute,
      now: frozenClock(),
    });
    expect(callCount).toBe(1);
    expect(seenProviders).toEqual(['openai']);
  });

  it('treats a thrown callRoute as a failure (returns ok=false, errorKind=unknown)', async () => {
    const routes = [makeRoute({ providerId: 'openai' }), makeRoute({ providerId: 'openrouter' })];
    let calls = 0;
    const callRoute = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('unexpected crash');
      return { ok: true, response: {}, costUsd: 0.0001 };
    });
    const out = await runRouteCascade({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      approvedRoutes: routes,
      policy: STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
      callRoute,
      now: frozenClock(),
    });
    expect(out.attempts[0].ok).toBe(false);
    expect(out.attempts[0].errorKind).toBe('unknown');
    expect(out.success).toBe(true);
    expect(out.attempts[1].ok).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// AttemptSink
// ──────────────────────────────────────────────────────────────────────

describe('runRouteCascade — recordAttempt sink', () => {
  it('invokes sink for each attempt (success OR failure)', async () => {
    const routes = [makeRoute({ providerId: 'a' }), makeRoute({ providerId: 'b' })];
    const sinkCalls: string[] = [];
    const sink = (a: { providerId: string }) => sinkCalls.push(a.providerId);
    await runRouteCascade({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      approvedRoutes: routes,
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, maxRouteAttempts: 2 },
      callRoute: async () => ({ ok: false, errorKind: 'rate_limited', costUsd: 0 }),
      recordAttempt: sink,
      now: frozenClock(),
    });
    expect(sinkCalls).toEqual(['a', 'b']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// summarizeCascadeRuns
// ──────────────────────────────────────────────────────────────────────

describe('summarizeCascadeRuns', () => {
  it('aggregates totalAttempts, fallbackUsedCount, totalCostUsd, perRole', async () => {
    const routes = [makeRoute({ providerId: 'a' }), makeRoute({ providerId: 'b' })];
    const o1 = await runRouteCascade({
      role: 'participant',
      logicalModelId: 'gpt-4o',
      approvedRoutes: routes,
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, maxRouteAttempts: 2 },
      callRoute: async (r) =>
        r.providerId === 'a'
          ? { ok: false, errorKind: 'invalid_auth', costUsd: 0 }
          : { ok: true, response: {}, costUsd: 0.0002 },
      now: frozenClock(),
    });
    const o2 = await runRouteCascade({
      role: 'synthesizer',
      logicalModelId: 'gpt-4o',
      approvedRoutes: [makeRoute({ providerId: 'a' })],
      policy: { ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY, maxRouteAttempts: 1 },
      callRoute: async () => ({ ok: true, response: {}, costUsd: 0.0001 }),
      now: frozenClock(),
    });
    const summary = summarizeCascadeRuns([
      { ...o1, role: 'participant' },
      { ...o2, role: 'synthesizer' },
    ]);
    expect(summary.totalRoles).toBe(2);
    expect(summary.succeededRoles).toBe(2);
    expect(summary.totalAttempts).toBe(3);
    expect(summary.fallbackUsedCount).toBe(1);  // o1's attempt 2 had wasRouteFallback=true
    expect(summary.totalCostUsd).toBeCloseTo(0.0003, 5);
  });
});
