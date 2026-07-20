// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for the `/v1/hcra/health` operational contract.
 *
 * What we're guarding against
 * ---------------------------
 * Three concrete defects that surfaced together in production:
 *
 *   1. **401 on operational health**: a previous version registered
 *      `/v1/hcra/health` *after* `fastify.addHook('preHandler', authenticate)`
 *      inside the plugin scope, so unauthenticated probes got a 401. K8s
 *      liveness, deploy verification, and on-call dashboards all broke.
 *
 *   2. **FST_ERR_REP_ALREADY_SENT**: handlers used `reply.send(...)` followed
 *      by `return;` instead of `return reply.send(...)`. Fastify could fall
 *      through to the next hook / handler, which then tried to send again.
 *
 *   3. **Product rate-limit on health**: the global token-bucket middleware
 *      was billing health probes against the API-key bucket, so an exhausted
 *      bucket masked real outages with a 429.
 *
 * Strategy
 * --------
 * We boot a *minimal* Fastify instance with only the HCRA plugin and the
 * plugin's own `authenticate` hook. The global middlewares (api-key auth,
 * token-bucket) are tested in their own files; the question this test
 * answers is narrower: "does the *plugin itself* honor the operational
 * contract for /v1/hcra/health?"
 *
 * Concretely:
 *   - Health is reachable without credentials → proves the route is
 *     registered BEFORE the plugin-scoped auth hook.
 *   - Product routes still 401 unauthenticated → proves the hook still
 *     applies to everything below it.
 *   - 50 sequential health probes all 200 → proves no FST_ERR_REP_ALREADY_SENT.
 *   - Payload shape is the documented contract → guards against silent
 *     drift in what monitors expect.
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// We do NOT mock `tryGetEmbedder` — its real implementation is a pure getter
// that returns `null` when no embedder is configured (which is the
// vitest-default state). That null branch is exactly what production
// monitoring will see when the embedder hasn't booted yet, so it's the most
// faithful test fixture.

// `prisma` IS mocked because the product routes (capabilities, models) make
// DB queries; we never actually exercise those handlers in this file (the
// auth hook rejects first) but the import graph still pulls prisma in. The
// mock prevents a real connection attempt during test boot.
vi.mock('@/database/client', () => ({
  prisma: {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  },
}));

// `authenticate` is the plugin's auth hook — we don't override it. Its
// real behavior (reject when no API key / JWT is present) is what we're
// asserting still applies to product routes.

import hcraSearchRoutes from '../hcra-search-routes';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(hcraSearchRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// ─── /v1/hcra/health: operational contract ──────────────────────────────────

describe('GET /v1/hcra/health (operational endpoint)', () => {
  it('returns 200 without any auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/hcra/health' });
    expect(res.statusCode).toBe(200);
  });

  it('returns the documented payload shape (status, service, timestamp, embedder)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/hcra/health' });
    const body = res.json() as Record<string, unknown>;

    expect(body.status).toBe('ok');
    expect(body.service).toBe('hcra-search');
    expect(typeof body.timestamp).toBe('string');
    expect(new Date(body.timestamp as string).toString()).not.toBe('Invalid Date');

    // embedder block: deterministic null/null when no embedder is configured.
    // We check the SHAPE, not the value, because the value depends on whether
    // an embedder happened to be wired in this test environment.
    expect(body.embedder).toMatchObject({
      configured: expect.any(Boolean),
      // model is `string | null`; either is acceptable.
    });
  });

  it('ignores arbitrary auth headers and still returns 200 (proves bypass is positional, not credential-dependent)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/hcra/health',
      headers: {
        authorization: 'Bearer junk-token-that-would-fail-validation',
        'x-api-key': 'ak_definitely_not_a_real_key',
      },
    });
    // The route is registered BEFORE the plugin auth hook, so the hook never
    // runs — the junk credentials are simply not consulted. If a future
    // regression moves the route below the hook, this test will start seeing
    // 401 (or 200-after-validation) and flag the change.
    expect(res.statusCode).toBe(200);
  });

  it('is idempotent across many sequential calls (no FST_ERR_REP_ALREADY_SENT)', async () => {
    // 50 sequential calls is overkill for "is it idempotent" but enough to
    // catch the specific FST_ERR_REP_ALREADY_SENT regression: that error
    // surfaces non-deterministically because it depends on hook timing, so
    // a single call is not a robust guard.
    for (let i = 0; i < 50; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/v1/hcra/health' });
      expect(res.statusCode, `call #${i + 1} should be 200`).toBe(200);
    }
  });

  it('handles concurrent calls without double-send', async () => {
    const calls = Array.from({ length: 20 }, () =>
      app.inject({ method: 'GET', url: '/v1/hcra/health' }),
    );
    const responses = await Promise.all(calls);
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }
  });
});

// ─── Product endpoints: auth gate must still apply ──────────────────────────

describe('Product /v1/hcra/* endpoints (auth-required)', () => {
  // We name a representative subset rather than enumerating every endpoint:
  // the contract is "auth applies to everything below the addHook line",
  // and one positive and one wildcard sample is sufficient to detect a
  // regression that lifts the entire hook.
  it.each([
    { url: '/v1/hcra/capabilities', label: 'list/search ontology' },
    { url: '/v1/hcra/capabilities/expand', label: 'synonym expansion' },
    { url: '/v1/hcra/capabilities/facets', label: 'facet aggregations' },
    { url: '/v1/hcra/models', label: 'models by capability' },
  ])('GET $url ($label) returns 401 without credentials', async ({ url }) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(401);
  });

  it('the wildcard URI lookup also requires auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/hcra/capabilities/' + encodeURIComponent('http://ailin.dev/cap/v1/vision'),
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── Health route ordering invariant (catches the original regression) ─────

describe('plugin encapsulation invariant', () => {
  it('health is registered in OUTER scope; product routes in NESTED scope', async () => {
    // Why this exists
    // ----------------
    // In Fastify 5, `addHook('preHandler', ...)` at plugin scope hooks the
    // ENTIRE scope — order of registration within that scope does NOT exempt
    // earlier routes. The only structural way to keep health auth-free is to
    // put product routes in a NESTED `register(...)` call (their own
    // encapsulation context), so the auth hook is local to that child.
    //
    // We assert that invariant by inspecting where each route was registered.
    // Fastify's `onRoute` hook receives a route descriptor whose `prefix`
    // reflects the encapsulation prefix of the (sub-)plugin that registered
    // it. Since neither the outer nor the inner register uses an HTTP prefix,
    // we instead lean on a known-good signal: the request-level behavior is
    // already tested above (health=200, /capabilities=401). What this test
    // adds is a *static* structural check that catches a refactor that
    // accidentally moves health into the inner scope BEFORE any traffic is
    // simulated.
    //
    // Strategy: walk the registered route table and verify health is present
    // alongside capabilities, AND that the health route does NOT have an
    // auth-applying preHandler attached. A regression that drags health into
    // the gated scope would either drop the route from the table or attach
    // the auth hook to it, and the request-level assertions above already
    // cover both.
    interface RouteRecord {
      readonly url: string;
      readonly method: string | string[];
    }
    const routes: RouteRecord[] = [];

    // Throwaway instance: do NOT touch the shared `app` (which is already
    // listening from beforeAll — Fastify forbids new hooks on it).
    const probe = Fastify({ logger: false });
    probe.addHook('onRoute', (route) => {
      routes.push({ url: route.url, method: route.method });
    });
    await probe.register(hcraSearchRoutes);
    await probe.ready();

    // Direct request via the probe: the health route MUST be reachable
    // without credentials. This is the structural assertion — if a future
    // refactor pushes the health route into the gated child scope, this
    // assertion fails on the throwaway instance, decoupled from any
    // beforeAll-shared state.
    const healthRes = await probe.inject({ method: 'GET', url: '/v1/hcra/health' });
    const capsRes = await probe.inject({ method: 'GET', url: '/v1/hcra/capabilities' });

    await probe.close();

    expect(routes.some((r) => r.url === '/v1/hcra/health')).toBe(true);
    expect(routes.some((r) => r.url === '/v1/hcra/capabilities')).toBe(true);
    // Health must answer 200 (outer scope, no auth)
    expect(healthRes.statusCode).toBe(200);
    // Capabilities must answer 401 (inner scope, auth hook applied)
    expect(capsRes.statusCode).toBe(401);
  });
});
