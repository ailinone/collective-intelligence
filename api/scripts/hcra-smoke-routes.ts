// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HCRA Search API Smoke Test (ADR-022, Sprint 3)
 *
 * Boots a minimal Fastify app, registers `hcraSearchRoutes`, and verifies
 * via `inject()` that:
 *   1. All six routes are mounted at the expected paths.
 *   2. Unauthenticated requests get rejected by the `authenticate` preHandler.
 *   3. The route handlers themselves (under a stubbed auth) return well-shaped
 *      JSON for the trivial paths (health, list).
 *
 * This complements `hcra-validate-e2e.ts` which exercises the underlying SQL.
 * Together they cover SQL ↔ HTTP both ways.
 *
 * The auth bypass is implemented by registering hcraSearchRoutes inside a
 * Fastify scope where we replace `authenticate` via a module mock proxy —
 * but to keep this lean, we use a separate "stub" wrapper that calls the
 * route handlers WITHOUT mounting the real preHandler. That requires us to
 * import the route module differently, so we use Fastify's `inject` after
 * mounting the unmodified module and check both the negative (401) and the
 * positive paths via a bypass plugin that patches `req.headers` before the
 * preHandler runs (impossible for the real auth hook — so we instead test
 * the negative path here and rely on E2E for the positive).
 */
import Fastify from 'fastify';
import { prisma } from '../src/database/client';
import hcraSearchRoutes from '../src/routes/capabilities/hcra-search-routes';

interface RouteSpec {
  method: string;
  url: string;
}

// All routes the plugin should mount. Used for the route-table assertion only.
const EXPECTED_ROUTES: RouteSpec[] = [
  { method: 'GET', url: '/v1/hcra/health' },
  { method: 'GET', url: '/v1/hcra/capabilities' },
  { method: 'GET', url: '/v1/hcra/capabilities/expand' },
  { method: 'GET', url: '/v1/hcra/capabilities/facets' },
  { method: 'GET', url: '/v1/hcra/capabilities/*' },
  { method: 'GET', url: '/v1/hcra/models' },
];

// Product endpoints — registered AFTER the plugin-scoped `authenticate` hook,
// so they MUST 401 when called without credentials. /v1/hcra/health is
// deliberately excluded: it is an operational route registered BEFORE the
// hook and must always return 200 on a live process (see hcra-search-routes
// JSDoc and `OPERATIONAL_ROUTE_PATHS`).
const PRODUCT_ROUTES: RouteSpec[] = [
  { method: 'GET', url: '/v1/hcra/capabilities' },
  { method: 'GET', url: '/v1/hcra/capabilities/expand' },
  { method: 'GET', url: '/v1/hcra/capabilities/facets' },
  { method: 'GET', url: '/v1/hcra/capabilities/*' },
  { method: 'GET', url: '/v1/hcra/models' },
];

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`[PASS] ${msg}`);
}

async function main(): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(hcraSearchRoutes);
  await app.ready();

  console.log('\n──── Phase 1 — Inspect route table ────────────────────────');
  const printed = app.printRoutes({ commonPrefix: false });
  console.log(printed);

  // Fastify prints routes as a tree (`/v1/hcra/capabilities` then indented
  // children `/expand`, `/facets`). Check each leaf segment instead.
  const printedSegments = printed
    .split('\n')
    .map((line) => line.replace(/^[\s│├└─]+/, '').replace(/\s*\([A-Z, ]+\)\s*$/, '').trim())
    .filter(Boolean);
  console.log('Detected segments:', printedSegments);
  const expectedSegments = ['/v1/hcra/health', '/v1/hcra/capabilities', '/expand', '/facets', '*', '/v1/hcra/models'];
  for (const seg of expectedSegments) {
    assert(printedSegments.includes(seg), `Route segment "${seg}" mounted`);
  }

  console.log('\n──── Phase 2a — /v1/hcra/health is OPERATIONAL (expect 200, no auth) ──');
  {
    const res = await app.inject({ method: 'GET', url: '/v1/hcra/health' });
    assert(
      res.statusCode === 200,
      `GET /v1/hcra/health → 200 unauthenticated (got ${res.statusCode}); ` +
        `the health endpoint must NOT be behind product auth (see PRODUCT vs OPERATIONAL routes)`,
    );
    const payload = res.json() as { status?: unknown; service?: unknown };
    assert(payload.status === 'ok', `health payload.status === 'ok' (got ${String(payload.status)})`);
    assert(
      payload.service === 'hcra-search',
      `health payload.service === 'hcra-search' (got ${String(payload.service)})`,
    );
  }

  console.log('\n──── Phase 2b — Product routes still require auth (expect 401) ──');
  for (const r of PRODUCT_ROUTES) {
    const url = r.url.replace('*', 'http%3A%2F%2Failin.dev%2Fcap%2Fv1%2Fvision');
    const res = await app.inject({ method: r.method as 'GET', url });
    assert(
      res.statusCode === 401,
      `${r.method} ${url} → 401 unauthenticated (got ${res.statusCode})`,
    );
  }

  console.log('\n──── Phase 2c — Health idempotent across repeated calls (no double-send) ──');
  for (let i = 0; i < 5; i += 1) {
    const res = await app.inject({ method: 'GET', url: '/v1/hcra/health' });
    assert(
      res.statusCode === 200,
      `repeated GET /v1/hcra/health #${i + 1} → 200 (got ${res.statusCode}); ` +
        `if a regression reintroduces FST_ERR_REP_ALREADY_SENT, this iteration would 500`,
    );
  }

  // Note: a Phase 3 ("call handlers under stub auth") was attempted with
  // `onRoute` to clear preHandlers, but the auth hook is registered via
  // `fastify.addHook('preHandler', ...)` at plugin scope, not per-route, so
  // the per-route override is a no-op. Exercising the handler bodies under
  // real auth needs a seeded API key in the DB; the underlying SQL is
  // already validated by `hcra-validate-e2e.ts` (phases 8 + 9 mirror the
  // exact lexical and vector queries the routes use), so we don't duplicate
  // that here.

  console.log('\n──── Phase 3 — Cleanup ─────────────────────────────────────');
  await app.close();
  await prisma.$disconnect();

  console.log('\n✅ HCRA Search API smoke test PASSED');
}

main().catch(async (err) => {
  console.error('\n❌ HCRA Search API smoke test FAILED:', err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
