// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wiring contract — function-calling guaranteed on EVERY selection path
 * (2026-08-20 incident, request 91YJ-kZPPLHjodsSSKLkz).
 *
 * Why a string-grep test (mirrors chat-routes-pin-wiring.test.ts)
 * ───────────────────────────────────────────────────────────────────
 * The incident was NOT a missing feature: `requiredCapabilities` already
 * included function_calling and `selectFallbackOptions` already filtered by
 * it. The hole was that the filter ran on CATALOG/DB rows while the models
 * EXECUTED came from `providerRegistry.findModel()` — a diverging surface —
 * and the PRIMARY was never checked at all. The regression mode is silent:
 * a refactor can drop a re-validation call without breaking any import or
 * type. Locking the textual wiring is the only structural guard short of a
 * full fastify+registry integration harness.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES_PATH = join(__dirname, '..', 'chat-routes.ts');
const ENGINE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'core',
  'orchestration',
  'orchestration-engine.ts'
);

const routesSource = readFileSync(ROUTES_PATH, 'utf8');
const engineSource = readFileSync(ENGINE_PATH, 'utf8');

describe('function-calling routing wiring contract (streaming fast path)', () => {
  it('derives toolsRequired from the request tools via the shared guard', () => {
    expect(routesSource).toMatch(
      /const\s+toolsRequired\s*=\s*requestRequiresFunctionCalling\(chatRequest\.tools\)/
    );
  });

  it('re-validates the PRIMARY before pushing it onto the chain', () => {
    // The primary must be resolved from the registry and demoted (not pushed)
    // when it explicitly lacks function_calling — the incident's attempts 1-4
    // were all capability-filter-passing DB rows whose resolved models
    // couldn't carry tools.
    expect(routesSource).toMatch(
      /const\s+resolvedPrimary\s*=\s*await\s+providerRegistry\.findModel\(plan\.model\.id\)/
    );
    expect(routesSource).toMatch(/explicitlyLacksFunctionCalling\(primaryModel\)/);
    expect(routesSource).toMatch(
      /demoted from chain head/
    );
  });

  it('re-validates FALLBACK candidates and skips non-function-calling ones without counting toward the cap', () => {
    expect(routesSource).toMatch(
      /if\s*\(toolsRequired\s*&&\s*explicitlyLacksFunctionCalling\(result\.model\)\)\s*\{[^}]*skippedNoFunctionCalling\s*\+=\s*1;\s*continue;/s
    );
  });

  it('never empties the fallback chain — primary is the last-resort safety net', () => {
    expect(routesSource).toMatch(
      /falling back to primary as last resort/
    );
  });

  it('dead-candidate skip still protects the primary slot (primaryPushed guard)', () => {
    // When the primary was demoted, the dead-skip must still be allowed to
    // reject the first fallback without instantly emptying the chain (the
    // post-loop safety net covers the all-rejected case).
    expect(routesSource).toMatch(
      /if\s*\(\(primaryPushed\s*\|\|\s*candidates\.length\s*>\s*0\)\s*&&\s*isDeadCandidate\(/
    );
  });
});

describe('streaming chain liveness wiring contract (2026-08-21, request k0QPvOU6tetSXz9gOJU-k)', () => {
  it('caps candidates per provider at chain build time (diversity)', () => {
    // The incident chain wasted 5 of 9 slots on one provider (alibaba ×5):
    // attempt 1 killed the provider (billing 400) and attempts 2-5 were
    // guaranteed circuit-OPEN failures. The build loop must enforce a
    // per-provider cap via STREAMING_MAX_CANDIDATES_PER_PROVIDER.
    expect(routesSource).toMatch(/maxPerProvider/);
    expect(routesSource).toMatch(
      /STREAMING_MAX_CANDIDATES_PER_PROVIDER/
    );
    expect(routesSource).toMatch(/perProviderCount\.get\(adapterProvider\)/);
  });

  it('re-checks candidate liveness between attempts (inter-attempt dead skip)', () => {
    // Candidates are resolved up front; a provider that dies mid-chain keeps
    // its pre-resolved slots. The execution loop must re-evaluate liveness
    // before each attempt and skip (without burning the attempt) providers
    // that turned dead since the chain was built.
    expect(routesSource).toMatch(
      /if\s*\(index\s*>\s*0\s*&&\s*isDeadCandidate\(candidate\.adapter\.getName\(\)/
    );
    expect(routesSource).toMatch(/Candidate provider died mid-chain/);
  });
});

describe('function-calling routing wiring contract (orchestration engine)', () => {
  it('context.requiredCapabilities carries function_calling for tools requests', () => {
    // mapInferredCapabilities must push BOTH markers so pool filtering AND
    // the adapter-resolution gate see the requirement.
    expect(engineSource).toMatch(/caps\.push\('tool_use',\s*'function_calling'\)/);
  });

  it('getAdapterForModel rejects registry-resolved models that explicitly lack function_calling', () => {
    expect(engineSource).toMatch(
      /explicitlyLacksFunctionCalling\(result\.model\)/
    );
    expect(engineSource).toMatch(
      /\(context\.requiredCapabilities\s*\?\?\s*\[\]\)\.includes\('function_calling'\)/
    );
  });
});
