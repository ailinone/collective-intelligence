// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for the Caminho-C Stage 4 wiring gap:
 *
 *   `src/routes/capabilities/capabilities-search-routes.ts` defines two
 *   routes (`/v1/capabilities/ontology/search`, `/v1/capabilities/models/search`)
 *   backed by the `CapabilitySearchService` singleton. For the routes to
 *   actually serve traffic, `index.ts` must import and invoke
 *   `registerCapabilitySearchRoutes(server)` during boot.
 *
 *   The original Stage 4 PRO commit (f16f8e9) refactored the route handler
 *   to use the singleton but did NOT add the registration call. The image
 *   booted, served `/v1/hcra/*` (the parallel implementation), and silently
 *   never exposed the singleton-backed surface. The 404s only appeared
 *   under HTTP probe — there was no boot-time error, no test failure, no
 *   warning log.
 *
 *   This test locks both gates so the gap can't reopen:
 *
 *     1. The function `registerCapabilitySearchRoutes` is exported from
 *        the route module (anyone deleting the export breaks this test).
 *     2. `src/index.ts` imports AND invokes it (anyone deleting the
 *        import or the call breaks this test).
 *
 * Why a string-grep test rather than a Fastify boot test:
 *   - A boot test would require spinning up the full server (pg pool,
 *     embedder, redis, etc.) — the tests folder structure here is unit-only.
 *   - The wiring is a static one-liner; grep semantics match the contract
 *     exactly. A boot test would also work, but at 50× the runtime cost.
 *   - Subloto-E1 and the no-static-models tests use the same string-grep
 *     pattern for similar "wiring must be present" invariants.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');
const ROUTE_PATH = join(
  REPO_ROOT,
  'src',
  'routes',
  'capabilities',
  'capabilities-search-routes.ts',
);

function readSrc(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('Caminho-C Stage 4 wiring invariant', () => {
  it('capabilities-search-routes exports registerCapabilitySearchRoutes', () => {
    const src = readSrc(ROUTE_PATH);
    expect(src).toMatch(/export\s+async\s+function\s+registerCapabilitySearchRoutes\s*\(/);
  });

  it('capabilities-search-routes imports the search-service singleton', () => {
    const src = readSrc(ROUTE_PATH);
    // The route file MUST import the singleton — otherwise the Stage 4
    // refactor (one source of CapabilitySearchService) is silently undone.
    expect(src).toMatch(
      /from\s+['"]@\/capability\/search\/capability-search-singleton['"]/,
    );
  });

  it('index.ts imports registerCapabilitySearchRoutes', () => {
    const src = readSrc(INDEX_PATH);
    // The dynamic import string must reference the route module by path.
    expect(src).toMatch(/registerCapabilitySearchRoutes/);
    expect(src).toMatch(
      /['"]@\/routes\/capabilities\/capabilities-search-routes\.js['"]/,
    );
  });

  it('index.ts invokes registerCapabilitySearchRoutes(server)', () => {
    const src = readSrc(INDEX_PATH);
    // The call must happen — not just the import. We accept both
    // `await registerCapabilitySearchRoutes(server)` and any wrapper that
    // forwards `server` as first arg, but reject a stray import with no
    // call site (which is the bug class this test exists for).
    expect(src).toMatch(/await\s+registerCapabilitySearchRoutes\s*\(\s*server\b/);
  });

  it('hcra-search-routes still registered (parallel /v1/hcra/* coexistence intact)', () => {
    // Coexistence is intentional during the migration window. If someone
    // removes hcraSearchRoutes registration thinking the new route replaces
    // it, /v1/hcra/* breaks for existing consumers — fail loudly here.
    const src = readSrc(INDEX_PATH);
    expect(src).toMatch(/server\.register\s*\(\s*hcraSearchRoutes\s*\)/);
  });
});
