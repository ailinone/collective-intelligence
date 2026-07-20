// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G4 §Routing (v2) — Tests for universal multi-route taxonomy.
 *
 * v2 expands the taxonomy so EVERY native provider exposes its
 * `routesVia` list — the routers that include it in their catalog.
 * `listModelRouteCandidates(nativeId)` returns native + ALL such routers,
 * giving the executor multiple fallback paths before declaring a role
 * dead.
 *
 * The tests pin:
 *   - openai / anthropic / google / mistral / xai / cohere /
 *     deepseek / etc. (frontier natives) → each has multiple routers
 *   - hybrid backends (groq, fireworks-ai, togetherai, etc.) → multiple
 *     routers
 *   - routers (openrouter, aihubmix, vercel-ai-gateway, github-models,
 *     edenai, cometapi, etc.) → carry the right set of natives
 *   - inverse query (`listRoutersForNative`) is consistent with forward
 *     (`listRouterBackends`)
 *   - case-insensitive ids
 *   - sort stability (native first, routers alphabetical)
 */
import { describe, it, expect } from 'vitest';
import {
  classifyProviderRouting,
  listModelRouteCandidates,
  listRouterBackends,
  listRoutersForNative,
  getRoutingTaxonomySnapshot,
} from '../provider-routing-taxonomy';

// ──────────────────────────────────────────────────────────────────────
// classifyProviderRouting — native vs router
// ──────────────────────────────────────────────────────────────────────

describe('classifyProviderRouting v2 — natives', () => {
  it.each([
    'openai', 'anthropic', 'google', 'mistral', 'xai', 'cohere',
    'deepseek', 'perplexity',
  ])('"%s" is native', (id) => {
    expect(classifyProviderRouting(id)?.kind).toBe('native');
  });

  it('every frontier native has at least 2 routesVia (multi-route)', () => {
    for (const id of ['openai', 'anthropic', 'google', 'mistral', 'xai', 'cohere', 'deepseek']) {
      const c = classifyProviderRouting(id);
      expect(c?.routesVia.length, `${id} should have ≥ 2 routers`).toBeGreaterThanOrEqual(2);
    }
  });

  it('audio / image providers are natives (specialized, no chat router peering)', () => {
    for (const id of ['deepgram', 'cartesia', 'elevenlabs', 'voyage', 'recraft']) {
      expect(classifyProviderRouting(id)?.kind).toBe('native');
    }
  });
});

describe('classifyProviderRouting v2 — routers', () => {
  it.each([
    'huggingface', 'openrouter', 'aihubmix', 'cometapi', 'edenai',
    'requesty', 'nanogpt', 'github-models', 'vercel-ai-gateway',
    'aiml', 'orqai', 'venice', 'poe', 'routeway', 'imagerouter',
    'gemini-openai', 'heliconeai', 'bytez', 'cloudflare-workers-ai',
    'mancer', 'synthetic', 'ai302',
  ])('"%s" is router', (id) => {
    expect(classifyProviderRouting(id)?.kind).toBe('router');
  });

  it('routers expose non-empty routesTo', () => {
    for (const id of ['huggingface', 'openrouter', 'aihubmix']) {
      const c = classifyProviderRouting(id);
      expect(c?.routesTo.length).toBeGreaterThan(0);
    }
  });

  it('openrouter routes to all frontier natives', () => {
    const backends = listRouterBackends('openrouter');
    for (const id of ['openai', 'anthropic', 'google', 'mistral', 'deepseek', 'xai', 'cohere']) {
      expect(backends, `openrouter should route to ${id}`).toContain(id);
    }
  });

  it('vercel-ai-gateway routes to openai/anthropic/google', () => {
    const backends = listRouterBackends('vercel-ai-gateway');
    expect(backends).toContain('openai');
    expect(backends).toContain('anthropic');
    expect(backends).toContain('google');
  });

  it('aihubmix routes to broad set including Chinese natives', () => {
    const backends = listRouterBackends('aihubmix');
    expect(backends).toContain('alibaba');
    expect(backends).toContain('moonshot');
  });
});

// ──────────────────────────────────────────────────────────────────────
// listModelRouteCandidates — the multi-route core
// ──────────────────────────────────────────────────────────────────────

describe('listModelRouteCandidates v2 — frontier natives reach multiple routers', () => {
  it('openai returns native + multiple routers', () => {
    const out = listModelRouteCandidates('openai');
    expect(out[0].kind).toBe('native');
    expect(out[0].providerId).toBe('openai');
    const routerIds = out.filter((c) => c.kind === 'router').map((c) => c.providerId);
    // Must include at least these well-known openai-carrying routers.
    for (const expected of ['openrouter', 'aihubmix', 'vercel-ai-gateway', 'edenai', 'cometapi']) {
      expect(routerIds, `openai routes should include ${expected}`).toContain(expected);
    }
    expect(out.length).toBeGreaterThanOrEqual(6);
  });

  it('anthropic returns native + multiple routers (incl. vercel-ai-gateway)', () => {
    const out = listModelRouteCandidates('anthropic');
    expect(out[0].providerId).toBe('anthropic');
    const routerIds = out.filter((c) => c.kind === 'router').map((c) => c.providerId);
    expect(routerIds).toContain('openrouter');
    expect(routerIds).toContain('aihubmix');
    expect(routerIds).toContain('vercel-ai-gateway');
  });

  it('google returns native + routers (incl. gemini-openai)', () => {
    const out = listModelRouteCandidates('google');
    const routerIds = out.filter((c) => c.kind === 'router').map((c) => c.providerId);
    expect(routerIds).toContain('openrouter');
    expect(routerIds).toContain('gemini-openai');
  });

  it('mistral / xai / cohere / deepseek each have ≥2 router options', () => {
    for (const id of ['mistral', 'xai', 'cohere', 'deepseek']) {
      const routes = listModelRouteCandidates(id);
      const routers = routes.filter((c) => c.kind === 'router');
      expect(routers.length, `${id} should have ≥ 2 router options`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('listModelRouteCandidates v2 — hybrid backends still have multi-route', () => {
  it('togetherai returns native + huggingface + openrouter + aihubmix etc.', () => {
    const out = listModelRouteCandidates('togetherai');
    expect(out[0].providerId).toBe('togetherai');
    const routerIds = out.filter((c) => c.kind === 'router').map((c) => c.providerId);
    expect(routerIds).toContain('huggingface');
    expect(routerIds).toContain('openrouter');
    expect(routerIds).toContain('aihubmix');
  });

  it('groq returns native + huggingface + openrouter etc.', () => {
    const out = listModelRouteCandidates('groq');
    const routerIds = out.filter((c) => c.kind === 'router').map((c) => c.providerId);
    expect(routerIds).toContain('huggingface');
    expect(routerIds).toContain('openrouter');
  });

  it('hybrid candidates carry correct upstreamSlug + nativeProviderId', () => {
    const out = listModelRouteCandidates('togetherai');
    const hfCandidate = out.find((c) => c.providerId === 'huggingface');
    expect(hfCandidate?.kind).toBe('router');
    expect(hfCandidate?.upstreamSlug).toBe('together');  // HF slug, not 'togetherai'
    expect(hfCandidate?.nativeProviderId).toBe('togetherai');
  });
});

describe('listModelRouteCandidates v2 — degenerate cases', () => {
  it('router id returns just itself (no recursive expansion)', () => {
    const out = listModelRouteCandidates('huggingface');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('router');
  });

  it('unknown provider falls back to native (conservative)', () => {
    const out = listModelRouteCandidates('totally-new-provider-2026');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('native');
  });

  it('case-insensitive', () => {
    const a = listModelRouteCandidates('OPENAI');
    const b = listModelRouteCandidates('openai');
    expect(a.length).toBe(b.length);
  });

  it('always returns native FIRST when present', () => {
    for (const id of ['openai', 'anthropic', 'groq', 'togetherai']) {
      const out = listModelRouteCandidates(id);
      expect(out[0].providerId.toLowerCase()).toBe(id);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Inverse queries: routesTo ↔ routesVia consistency
// ──────────────────────────────────────────────────────────────────────

describe('listRouterBackends + listRoutersForNative — bidirectional consistency', () => {
  it('if router routes to native, native lists that router via routesVia', () => {
    const backends = listRouterBackends('openrouter');
    for (const native of backends) {
      const routers = listRoutersForNative(native);
      expect(routers, `${native} should list openrouter in its routesVia`).toContain('openrouter');
    }
  });

  it('listRoutersForNative is empty for routers (not natives)', () => {
    expect(listRoutersForNative('openrouter')).toEqual([]);
  });

  it('listRouterBackends is empty for natives (not routers)', () => {
    expect(listRouterBackends('openai')).toEqual([]);
  });

  it('listRoutersForNative returns sorted alphabetical', () => {
    const r = listRoutersForNative('openai');
    const sorted = r.slice().sort();
    expect(r).toEqual(sorted);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Operator-disclosure pinning — operator's 2026-05-16 list
// ──────────────────────────────────────────────────────────────────────

describe('Operator disclosure 2026-05-16 — hybrid backends preserved', () => {
  const HYBRID_BACKENDS_2026_05_16 = [
    'groq', 'novita', 'cerebras', 'sambanova', 'nscale', 'fal', 'hyperbolic',
    'togetherai', 'fireworks-ai', 'featherless-ai', 'zai', 'replicate', 'cohere',
    'scaleway', 'public-ai', 'ovhcloud', 'hf-inference', 'deepinfra', 'wavespeed',
  ];

  it.each(HYBRID_BACKENDS_2026_05_16)('"%s" is a native with at least huggingface in routesVia', (id) => {
    const cls = classifyProviderRouting(id);
    expect(cls?.kind).toBe('native');
    const routers = cls?.routesVia.map((p) => p.routerProviderId) ?? [];
    expect(routers, `${id} should be reachable via huggingface router`).toContain('huggingface');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Snapshot invariants
// ──────────────────────────────────────────────────────────────────────

describe('getRoutingTaxonomySnapshot v2 — invariants', () => {
  it('routers + natives are disjoint', () => {
    const snap = getRoutingTaxonomySnapshot();
    const all = new Set([...snap.routers, ...snap.natives]);
    expect(all.size).toBe(snap.routers.length + snap.natives.length);
  });

  it('at least 20 routers, at least 40 natives', () => {
    const snap = getRoutingTaxonomySnapshot();
    expect(snap.routers.length).toBeGreaterThanOrEqual(20);
    expect(snap.natives.length).toBeGreaterThanOrEqual(40);
  });

  it('routeCounts: openai has at least 6 routes (native + ≥5 routers)', () => {
    const snap = getRoutingTaxonomySnapshot();
    expect(snap.routeCounts.openai).toBeGreaterThanOrEqual(6);
  });

  it('routeCounts: anthropic has at least 5 routes', () => {
    const snap = getRoutingTaxonomySnapshot();
    expect(snap.routeCounts.anthropic).toBeGreaterThanOrEqual(5);
  });

  it('routeCounts: every frontier native ≥ 3 routes (high fallback density)', () => {
    const snap = getRoutingTaxonomySnapshot();
    for (const id of ['openai', 'anthropic', 'google', 'mistral', 'deepseek', 'xai', 'cohere']) {
      expect(snap.routeCounts[id], `${id} should have ≥ 3 routes`).toBeGreaterThanOrEqual(3);
    }
  });

  it('aggregate fallback density (avg routes per native) is ≥ 1.5', () => {
    const snap = getRoutingTaxonomySnapshot();
    const total = Object.values(snap.routeCounts).reduce((a, b) => a + b, 0);
    const avg = total / Object.keys(snap.routeCounts).length;
    expect(avg).toBeGreaterThanOrEqual(1.5);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Role-selection scenarios — the user's "if a route fails, try next"
// ──────────────────────────────────────────────────────────────────────

describe('Role selection fallback semantics — the operator scenario', () => {
  it('participant role for openai survives openai 401 by trying openrouter', () => {
    // The executor selects logical model `gpt-4o`. Native provider=openai.
    // Route list per taxonomy:
    const routes = listModelRouteCandidates('openai');
    // Simulating native failure: filter out the native (e.g., D_blocked_by_auth)
    const fallbackRoutes = routes.filter((r) => r.kind === 'router');
    expect(fallbackRoutes.length).toBeGreaterThan(0);
    // Operator might have OPENROUTER_API_KEY even when OPENAI_API_KEY expired.
    expect(fallbackRoutes.some((r) => r.providerId === 'openrouter')).toBe(true);
  });

  it('synthesizer role for anthropic survives credit exhaustion via vercel-ai-gateway', () => {
    const routes = listModelRouteCandidates('anthropic');
    const viaVercel = routes.find((r) => r.providerId === 'vercel-ai-gateway');
    expect(viaVercel).toBeDefined();
    expect(viaVercel?.nativeProviderId).toBe('anthropic');
  });

  it('judge role using google can fallback via gemini-openai and openrouter', () => {
    const routes = listModelRouteCandidates('google');
    const ids = routes.map((r) => r.providerId);
    expect(ids).toContain('google');         // primary
    expect(ids).toContain('gemini-openai');  // fallback 1
    expect(ids).toContain('openrouter');     // fallback 2
  });

  it('fallback role with cohere has multiple alternatives', () => {
    const routes = listModelRouteCandidates('cohere');
    expect(routes.length).toBeGreaterThanOrEqual(3);
  });
});
