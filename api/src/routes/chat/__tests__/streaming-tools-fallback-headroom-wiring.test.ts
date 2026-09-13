// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wiring contract — tools-required fallback headroom + parallel candidate
 * resolution (2026-09-07 incident, requests i7fTRLVuNSY0ezeixeM3A /
 * 5zMk-k8bZ5hBCSwVwUAwG / edAGdf-ei9h1pYFvzyqE_).
 *
 * Root cause (confirmed against real production logs for the exact request
 * IDs above): a tools-required `model=auto` request draws from a MUCH
 * thinner, more provider-correlated eligible pool than the flat
 * STREAMING_MAX_FALLBACKS cap was sized for. Both real incident requests
 * needed to examine 324 ranked fallback candidates (skipping 237-238 for
 * lacking function_calling on the RESOLVED registry model, plus 33-78
 * already-dead) just to fill a 9-slot chain, out of 1479 total fallback
 * options — leaving ~1150 further, likely-healthy candidates unexamined
 * below the cap. Building that same 9-slot chain also cost ~19.9s of
 * strictly SERIAL `await providerRegistry.findModel()` calls (~60ms each)
 * BEFORE the first streaming attempt even started, out of a 26.5s total
 * request duration.
 *
 * Why a string-grep test (mirrors streaming-function-calling-chain-wiring.test.ts)
 * ───────────────────────────────────────────────────────────────────────
 * This logic is deeply embedded in handleStreamingRequest's closure (shares
 * `pushCandidate`, `seenModels`, `perProviderCount`, `plan.request` with the
 * surrounding function) — a full fastify+registry integration harness is not
 * practical here, and this file already establishes string-grep "wiring
 * contract" tests as the accepted guard for exactly this kind of
 * hard-to-integration-test regression in this exact function.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES_PATH = join(__dirname, '..', 'chat-routes.ts');
const routesSource = readFileSync(ROUTES_PATH, 'utf8');

describe('tools-required fallback headroom wiring contract (2026-09-07 incident)', () => {
  it('raises the fallback cap specifically for tools-required requests', () => {
    // Must NOT be a single flat constant any more — toolsRequired requests
    // need materially more headroom than the default (a regression back to
    // `Number(process.env.STREAMING_MAX_FALLBACKS ?? 8)` unconditionally
    // would silently reintroduce the exhaustion).
    expect(routesSource).toMatch(
      /const\s+maxStreamFallbacks\s*=\s*toolsRequired\s*\?\s*Number\(\s*process\.env\.STREAMING_MAX_FALLBACKS_TOOLS\s*\?\?\s*20\s*\)\s*:\s*Number\(\s*process\.env\.STREAMING_MAX_FALLBACKS\s*\?\?\s*8\s*\)/
    );
  });

  it('does not regress the non-tools default (still 8, still env-tunable)', () => {
    expect(routesSource).toMatch(/process\.env\.STREAMING_MAX_FALLBACKS\s*\?\?\s*8/);
  });

  it('resolves fallback candidates in bounded-concurrency batches instead of one at a time', () => {
    // The old shape was a bare `for (const fallback of fallbackModels) { ...
    // await providerRegistry.findModel(fallback.id) ... }` — strictly serial.
    // It must now be resolved via Promise.all over a bounded batch, with a
    // dedicated, env-tunable concurrency knob.
    expect(routesSource).toMatch(/STREAMING_FALLBACK_RESOLVE_CONCURRENCY/);
    expect(routesSource).toMatch(
      /Promise\.all\(\s*batch\.map\(\(fallback\)\s*=>\s*providerRegistry\.findModel\(fallback\.id\)\)\s*\)/
    );
  });

  it('still applies every existing per-candidate gate inside the parallel-resolved batch', () => {
    // Parallelizing the I/O must not silently drop any of the selection-time
    // safety gates this same file already locks down elsewhere (function-
    // calling re-validation, dead-candidate skip, per-provider diversity cap)
    // — they must still run, in order, over each resolved batch.
    expect(routesSource).toMatch(
      /for \(const result of resolvedBatch\) \{[\s\S]*?if \(candidates\.length > maxStreamFallbacks\) break;/
    );
    expect(routesSource).toMatch(
      /if\s*\(toolsRequired\s*&&\s*explicitlyLacksFunctionCalling\(result\.model\)\)\s*\{[^}]*skippedNoFunctionCalling\s*\+=\s*1;\s*continue;/s
    );
    expect(routesSource).toMatch(
      /if\s*\(\s*\(primaryPushed\s*\|\|\s*candidates\.length\s*>\s*0\)\s*&&\s*isDeadCandidate\(/
    );
    expect(routesSource).toMatch(/perProviderCount\.get\(adapterProvider\)/);
  });

  it('the outer batch loop still respects the cap and the full fallback list bound', () => {
    expect(routesSource).toMatch(
      /batchStart < fallbackModels\.length && candidates\.length <= maxStreamFallbacks/
    );
  });
});
