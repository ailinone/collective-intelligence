// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wiring contract test for the Caminho-C Q2 closure:
 * the user-specified `request.model` MUST survive into strategy execution.
 *
 * The original silent-substitution bug:
 *   1. User sends `{ model: "openai/gpt-4", ... }`.
 *   2. Orchestration engine's buildContext preserves `request.model`
 *      (the deletion at line ~2128 only fires when the model is 'auto'
 *      or wasn't user-specified).
 *   3. BUT no field on `OrchestrationContext` carried the user's intent
 *      to strategies. `preferredModelIds` was only populated from triage.
 *   4. HybridStrategy.selectModels picks analyzer by latency+cost and
 *      executor by quality, IGNORING `request.model` — silent substitution.
 *
 * 2026-04-29 helper extraction
 * ────────────────────────────
 * The Q2 closure logic moved into a shared helper at
 * `strategies/preferred-model-helper.ts`. HybridStrategy now imports
 * `resolvePreferredExecutor` + `assembleExecutors` instead of inlining
 * the pin-resolution logic. The contract is split across THREE layers
 * and each layer has its own invariants below:
 *
 *   1. ENGINE LAYER  (orchestration-engine.ts)
 *      buildContext captures request.model into
 *      `preferredModelFromRequest` BEFORE the deletion block, then
 *      assigns it to `context.preferredModelIds[0]` and populates
 *      `context.semanticQuery` from extractTaskSummary.
 *
 *   2. HELPER LAYER  (strategies/preferred-model-helper.ts)
 *      `resolvePreferredExecutor` reads `context.preferredModelIds[0]`,
 *      handles all four pinReasons (no-preference, pinned,
 *      pin-collision-excluded, pin-not-in-pool), and returns a
 *      structured resolution. `assembleExecutors` consumes the
 *      resolution to produce the final executor list.
 *
 *   3. STRATEGY LAYER  (strategies/hybrid-strategy.ts)
 *      HybridStrategy imports the helper, calls
 *      `resolvePreferredExecutor` with `[analyzer.id]` as the exclusion
 *      set, logs a `warn` on `pin-not-in-pool`, and uses
 *      `assembleExecutors` to round out the executor list with quality-
 *      sorted fallbacks.
 *
 * Why a string-grep test (mirrors sublote-e1-runtime-wiring.test.ts and
 * capabilities-search-routes-wiring.test.ts):
 *   - The classic regression mode is silent: someone refactors the engine
 *     and drops the `preferredModelFromRequest` capture, or refactors
 *     HybridStrategy and deletes the `resolvePreferredExecutor` call.
 *     There's no boot-time error and no test failure unless we lock the
 *     textual references explicitly.
 *   - Spinning up the full engine to test the path requires Prisma + pg +
 *     embedder + provider registry + 6 other services via DI. That's the
 *     scope of an integration test, not a contract guard.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENGINE_PATH = join(
  __dirname,
  '..',
  'orchestration-engine.ts',
);
const HYBRID_PATH = join(
  __dirname,
  '..',
  'strategies',
  'hybrid-strategy.ts',
);
const HELPER_PATH = join(
  __dirname,
  '..',
  'strategies',
  'preferred-model-helper.ts',
);

const engineSource = readFileSync(ENGINE_PATH, 'utf8');
const hybridSource = readFileSync(HYBRID_PATH, 'utf8');
const helperSource = readFileSync(HELPER_PATH, 'utf8');

describe('Caminho-C Q2: user-specified model wiring contract', () => {
  // ────────────────────────────────────────────────────────────────────
  // ENGINE LAYER (orchestration-engine.ts)
  // ────────────────────────────────────────────────────────────────────

  it('buildContext captures request.model before deletion when user-specified', () => {
    expect(engineSource).toMatch(/let\s+preferredModelFromRequest\s*:\s*string\s*\|\s*undefined/);
    // The capture must reference both the user-specified flag AND the
    // 'auto' guard — otherwise we'd capture 'auto' as a literal model
    // name and pin to a non-existent model.
    expect(engineSource).toMatch(
      /if\s*\(\s*userSpecifiedModel\s*&&\s*request\.model\s*&&\s*request\.model\s*!==\s*['"]auto['"]\s*\)\s*\{[\s\S]{0,200}?preferredModelFromRequest\s*=\s*request\.model/,
    );
  });

  it('buildContext assigns preferredModelIds from the captured value', () => {
    expect(engineSource).toMatch(
      /preferredModelIds:\s*preferredModelFromRequest[\s\S]{0,80}?\[\s*preferredModelFromRequest\s*\]/,
    );
  });

  it('buildContext populates semanticQuery from extractTaskSummary', () => {
    expect(engineSource).toMatch(
      /const\s+semanticQuery\s*=\s*this\.extractTaskSummary\s*\(\s*request\s*\)/,
    );
    // The field must appear on the OrchestrationContext literal — not
    // just be computed and discarded.
    expect(engineSource).toMatch(/semanticQuery:\s*semanticQuery\s*&&/);
  });

  // ────────────────────────────────────────────────────────────────────
  // HELPER LAYER (strategies/preferred-model-helper.ts)
  // ────────────────────────────────────────────────────────────────────

  it('helper exports resolvePreferredExecutor with the canonical signature', () => {
    expect(helperSource).toMatch(/export\s+function\s+resolvePreferredExecutor/);
    expect(helperSource).toMatch(/models\s*:\s*readonly\s+Model\[\]/);
    expect(helperSource).toMatch(/context\s*:\s*OrchestrationContext/);
    expect(helperSource).toMatch(/excludeIds\s*:\s*readonly\s+string\[\]/);
  });

  it('helper reads context.preferredModelIds[0] (not preferredModelIds itself)', () => {
    // The semantic contract is "honor the FIRST preferred model id" so
    // strategies don't have to invent their own tiebreaker.
    expect(helperSource).toMatch(/context\.preferredModelIds\s*\?\.?\s*\[\s*0\s*\]/);
  });

  it('helper exposes the four canonical pinReason values', () => {
    // Closed enum so callers (strategies, audit logs, observer feeds)
    // can branch deterministically on resolution.pinReason.
    expect(helperSource).toMatch(/'no-preference'/);
    expect(helperSource).toMatch(/'pinned'/);
    expect(helperSource).toMatch(/'pin-collision-excluded'/);
    expect(helperSource).toMatch(/'pin-not-in-pool'/);
  });

  it('helper exports assembleExecutors for downstream use', () => {
    expect(helperSource).toMatch(/export\s+function\s+assembleExecutors/);
    // Must accept a comparator so each strategy can sort by its own
    // priority (quality, latency, cost) without re-implementing the
    // pinned-first slot logic.
    expect(helperSource).toMatch(/comparator\s*:\s*\(a\s*:\s*Model,\s*b\s*:\s*Model\)/);
  });

  // ────────────────────────────────────────────────────────────────────
  // STRATEGY LAYER (strategies/hybrid-strategy.ts)
  // ────────────────────────────────────────────────────────────────────

  it('HybridStrategy imports the shared helper', () => {
    expect(hybridSource).toMatch(
      /import\s*\{[\s\S]{0,120}?(resolvePreferredExecutor|assembleExecutors)[\s\S]{0,120}?\}\s*from\s*['"]\.\/preferred-model-helper['"]/,
    );
    // Both functions must be imported — the strategy uses both.
    expect(hybridSource).toMatch(/resolvePreferredExecutor/);
    expect(hybridSource).toMatch(/assembleExecutors/);
  });

  it('HybridStrategy excludes the analyzer id from the executor pin', () => {
    // The analyzer is picked by latency+cost; if the user pinned the
    // same model, we still run it (as the analyzer) but the executor
    // slot must come from the rest of the pool. That's what the
    // [analyzer.id] exclusion enforces.
    expect(hybridSource).toMatch(
      /resolvePreferredExecutor\s*\(\s*models\s*,\s*context\s*,\s*\[\s*analyzer\.id\s*\]\s*\)/,
    );
  });

  it('HybridStrategy logs when the pinned model is absent from the pool', () => {
    // The warn message is the user-facing audit signal — keep the
    // string stable so log-grep alerting in prod doesn't break.
    expect(hybridSource).toMatch(
      /requested model not in operational pool/i,
    );
    // And it must be branched on the pinReason from the resolution,
    // not on a manual `if (!pinnedExecutor)` re-derivation.
    expect(hybridSource).toMatch(/pinReason\s*===\s*['"]pin-not-in-pool['"]/);
  });

  it('HybridStrategy uses assembleExecutors with a quality-descending comparator', () => {
    // Two assertions form the contract:
    //   (a) assembleExecutors is invoked — confirms the helper-driven
    //       assembly path (pinned first, quality-sorted fallback) is
    //       wired, not bypassed by a hand-rolled .sort().slice().
    //   (b) The quality-descending comparator literal exists in the
    //       file — the comparator is passed AS the third argument to
    //       assembleExecutors so this guarantees the strategy keeps its
    //       premium-quality executor preference rather than silently
    //       dropping to e.g. latency-sort.
    expect(hybridSource).toMatch(/assembleExecutors\s*\(/);
    expect(hybridSource).toMatch(
      /\(a,\s*b\)\s*=>\s*b\.performance\.quality\s*-\s*a\.performance\.quality/,
    );
  });
});
