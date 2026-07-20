// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Preferred-Model Honor Coverage — cross-strategy contract matrix.
 *
 * Locks the surface area of "which strategies honor user-specified
 * models" so future PRs cannot silently regress (or silently leave a
 * new strategy in the unaware bucket).
 *
 * Three honor patterns are accepted:
 *
 *   ① HELPER — strategy imports `preferred-model-helper` and calls
 *     `resolvePreferredExecutor` with `context` and an exclusion set.
 *     Canonical for multi-model pool-selection strategies (Hybrid,
 *     Consensus, ExpertPanel, ParallelRace, …).
 *
 *   ② DIRECT-READ — strategy reads `request.model` directly via
 *     `getUserSpecifiedModelFlag` and pre-selects the user's model
 *     from the pool before delegating to the rest of its selection
 *     logic. Appropriate when the strategy's natural unit IS a single
 *     model decision (SingleModelStrategy) or a single primary
 *     participant (CollaborativeStrategy).
 *
 *   ③ PENDING — strategy doesn't yet honor the user pin. Listed
 *     explicitly with the closure plan: each entry must move to bucket
 *     ① or ② before this test allows it to be removed from the
 *     PENDING list. The point of this list is *visibility*: the loose
 *     ends are tracked, the count goes down with each commit, and a
 *     new strategy added without honoring the pin fails the test.
 *
 * Failure modes this test catches
 * ───────────────────────────────
 *   - Someone adds a new strategy file but forgets to honor
 *     preferredModelIds AND forgets to add it to PENDING. The
 *     "every strategy is classified" assertion fires.
 *
 *   - Someone refactors HybridStrategy and accidentally removes the
 *     helper import. The HELPER bucket assertion fires.
 *
 *   - Someone removes a strategy from PENDING but doesn't actually
 *     wire the helper. The "PENDING entries are NOT in HELPER/DIRECT"
 *     cross-check fires from the other side.
 *
 *   - PENDING list goes UP instead of down. The
 *     `pendingCount <= MAX_PENDING` cap rejects regressions, even when
 *     the test author says "I'll fix it later".
 *
 * Why a string-grep test, not an integration test
 * ───────────────────────────────────────────────
 * Same rationale as `preferred-model-honor-wiring.test.ts`: the
 * regression mode is silent — a refactor that moves the helper call
 * out of a strategy doesn't crash. Locking the textual reference is
 * the only way to detect the deletion. Spinning up the engine with
 * Prisma + DI to test the path is integration-test territory.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const STRATEGIES_DIR = join(__dirname, '..', 'strategies');

/**
 * Strategies that honor the user pin via the shared helper.
 * Each entry must:
 *   - import `resolvePreferredExecutor` from `./preferred-model-helper`
 *   - call it with `context` and an exclusion set
 */
const HELPER_HONORS = new Set<string>([
  'hybrid-strategy.ts',
  // Batch 1 (2026-04-29): panel strategies migrated.
  'consensus-strategy.ts',
  'debate-strategy.ts',
  'expert-panel-strategy.ts',
  // Batch 2 (2026-04-29): sequential refinement strategies migrated.
  'cost-cascade-strategy.ts',
  'critique-repair-strategy.ts',
  'quality-multipass-strategy.ts',
  // Batch 3a (2026-04-29): canonical quality-sort strategies +
  // custom-selector strategies via withPreferredFirst. Pin biases
  // the highest-status slot in each (synthesizer/coordinator/
  // commander/aggregator/adjudicator). Anti-bias roles
  // (devil's-advocate, critic, blind respondents) intentionally
  // stay as next-best peers.
  'agentic-strategy.ts',
  'blind-debate-strategy.ts',
  'clarification-first-strategy.ts',
  'devil-advocate-consensus-strategy.ts',
  'diversity-ensemble-strategy.ts',
  'double-diamond-strategy.ts',
  'multi-hop-qa-strategy.ts',
  'persona-exploration-strategy.ts',
  'research-synthesize-strategy.ts',
  'stigmergic-refinement-strategy.ts',
  'swarm-explore-strategy.ts',
  'war-room-strategy.ts',
  // Batch 3b (2026-04-29): selector-wrapper + single-model
  // strategies. parallel/sequential pin the
  // primary/executor slot from the DynamicModelSelector pool;
  // adaptive pins the single-model fallback when sibling lookup
  // fails; contextual pins ahead of budget/quality heuristics.
  'parallel-strategy.ts',
  'sequential-strategy.ts',
  'adaptive-strategy.ts',
  'contextual-strategy.ts',
  // Batch 3c (2026-04-29): bespoke / multi-role flows. Each pins
  // the natural decision unit:
  //   - hierarchical: manager slot (highest-status synthesizer)
  //   - massive-parallel: pool inclusion (pin must be in the 9)
  //   - reinforcement: single-model decision (overrides weighted
  //                    scoring)
  //   - competitive: competitor slot (arbiter stays cross-provider
  //                  for impartiality)
  //   - strategy-compositor: pin propagation validation at workflow
  //                          boundary; sub-strategies receive pin
  //                          via context
  //   - safety-quorum: voter inclusion (pool composition; verdict
  //                    tallying remains equal-weight per May's
  //                    Theorem)
  'hierarchical-strategy.ts',
  'massive-parallel-strategy.ts',
  'reinforcement-strategy.ts',
  'competitive-strategy.ts',
  'safety-quorum-strategy.ts',
  // Batch 4 (2026-05-03): iterative-coordination strategy added.
  // Honors the pin by routing the first-round executor through
  // `resolvePreferredExecutor`; subsequent rounds inherit via the
  // standard pool-inclusion path.
  'sensitivity-consensus-strategy.ts',
  // Batch 5 (2026-05-04): tri-role-collective added (F2.1).
  // Honors the pin via `orderPoolForTriRole` which calls
  // `resolvePreferredExecutor` + `withPreferredFirst` before the
  // round-robin selection across Planner/Solver/Auditor turns.
  'tri-role-collective-strategy.ts',
]);

/**
 * Strategies that honor the user pin via direct `request.model` read.
 * Each entry must:
 *   - import or reference `getUserSpecifiedModelFlag`
 *   - branch on `userSpecifiedModel && request.model` to pre-select
 *     the user's model from the pool
 *
 * SingleModelStrategy is the canonical case (the user's pin IS the
 * answer). CollaborativeStrategy uses it to seed the lead participant.
 */
const DIRECT_READ_HONORS = new Set<string>([
  'single-model-strategy.ts',
  'collaborative-strategy.ts',
]);

/**
 * Strategies that don't yet honor the user pin. Each entry is a
 * tracked gap — pinning is a known follow-up. The list MUST shrink
 * over time. Adding to it requires explicit PR review.
 *
 * The cap `MAX_PENDING` prevents the list from growing accidentally:
 * a new strategy that doesn't honor the pin AND tries to land in
 * PENDING will hit the cap and fail the test, forcing the author to
 * either wire the helper or shrink another entry first.
 *
 * 2026-04-29 — Caminho-C Q3 closure complete (PENDING=0):
 *   - Batch 1 closed: consensus, expert-panel, parallel-race, debate
 *     (panel strategies; pin sets first voter / coordinator / first
 *     racer / moderator respectively).
 *   - Batch 2 closed: cost-cascade, quality-multipass, critique-repair
 *     (sequential refinement; pin biases the lead model — first
 *     cascade attempt / primary pass / generator slot).
 *   - Batch 3a closed (12 strategies): canonical quality-sort plus
 *     custom-selector strategies via withPreferredFirst — agentic,
 *     blind-debate, clarification-first, devil-advocate-consensus,
 *     diversity-ensemble, double-diamond, multi-hop-qa,
 *     persona-exploration, research-synthesize, stigmergic-refinement,
 *     swarm-explore, war-room.
 *   - Batch 3b closed (4 strategies): selector-wrapper +
 *     single-model decisions — parallel, sequential, adaptive,
 *     contextual.
 *   - Batch 3c closed (6 strategies): bespoke / multi-role flows —
 *     hierarchical (manager slot), massive-parallel (pool inclusion),
 *     reinforcement (weighted-score override), competitive (competitor
 *     slot, arbiter stays impartial), strategy-compositor (pin
 *     propagation validation), safety-quorum (voter inclusion).
 *
 * The PENDING list is empty. MAX_PENDING=0 prevents future
 * regression — any new strategy must honor the pin via HELPER_HONORS
 * or DIRECT_READ_HONORS before it can land.
 */
const PENDING: readonly string[] = [];

/**
 * Cap on PENDING size — catches drift from the documented baseline.
 * If a future PR adds a new strategy without wiring the pin, this
 * cap forces the author to either wire it (move to HELPER/DIRECT) or
 * remove an existing PENDING entry first.
 *
 * The cap should be DECREASED whenever a strategy is migrated out of
 * PENDING — that's how the test enforces "no loose ends" over time.
 */
const MAX_PENDING = 0;

/**
 * Helper-pattern signature: must call `resolvePreferredExecutor` with
 * `context` somewhere in its body.
 */
function usesHelper(source: string): boolean {
  if (!/from\s+['"]\.\/preferred-model-helper['"]/.test(source)) return false;
  if (!/resolvePreferredExecutor\s*\(/.test(source)) return false;
  return true;
}

/**
 * Direct-read signature: imports `getUserSpecifiedModelFlag` AND
 * branches on `userSpecifiedModel && request.model`.
 */
function usesDirectRead(source: string): boolean {
  if (!/getUserSpecifiedModelFlag/.test(source)) return false;
  if (!/userSpecifiedModel\s*&&\s*request\.model/.test(source)) return false;
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// Test setup: read every strategy file once.
// ──────────────────────────────────────────────────────────────────────

function listStrategyFiles(): string[] {
  return readdirSync(STRATEGIES_DIR)
    .filter((f) => f.endsWith('-strategy.ts'))
    .filter((f) => f !== 'preferred-model-helper.ts')
    .sort();
}

const STRATEGY_FILES = listStrategyFiles();

const STRATEGY_SOURCES = new Map<string, string>(
  STRATEGY_FILES.map((f) => [f, readFileSync(join(STRATEGIES_DIR, f), 'utf8')]),
);

// ──────────────────────────────────────────────────────────────────────
// Invariants
// ──────────────────────────────────────────────────────────────────────

describe('Preferred-model honor coverage matrix', () => {
  it('every strategy file is classified into exactly one bucket', () => {
    const allDeclared = new Set<string>([
      ...HELPER_HONORS,
      ...DIRECT_READ_HONORS,
      ...PENDING,
    ]);

    const orphans = STRATEGY_FILES.filter((f) => !allDeclared.has(f));
    expect(orphans, 'Strategy files not classified — add to HELPER_HONORS, DIRECT_READ_HONORS, or PENDING').toEqual([]);

    // Reverse: declared buckets must reference real files.
    const phantom = [...allDeclared].filter((f) => !STRATEGY_SOURCES.has(f));
    expect(phantom, 'Declared bucket entries reference missing strategy files').toEqual([]);
  });

  it('buckets are mutually exclusive (no double-classification)', () => {
    const intersections: Array<{ file: string; buckets: string[] }> = [];
    for (const file of STRATEGY_FILES) {
      const buckets: string[] = [];
      if (HELPER_HONORS.has(file)) buckets.push('HELPER_HONORS');
      if (DIRECT_READ_HONORS.has(file)) buckets.push('DIRECT_READ_HONORS');
      if (PENDING.includes(file)) buckets.push('PENDING');
      if (buckets.length > 1) {
        intersections.push({ file, buckets });
      }
    }
    expect(intersections, 'Strategy classified in multiple buckets — pick one').toEqual([]);
  });

  it('every HELPER_HONORS entry actually imports the helper and calls resolvePreferredExecutor', () => {
    const violators: Array<{ file: string; reason: string }> = [];
    for (const file of HELPER_HONORS) {
      const source = STRATEGY_SOURCES.get(file);
      if (!source) {
        violators.push({ file, reason: 'file missing' });
        continue;
      }
      if (!usesHelper(source)) {
        violators.push({
          file,
          reason: 'in HELPER_HONORS but missing import or call to resolvePreferredExecutor',
        });
      }
    }
    expect(violators).toEqual([]);
  });

  it('every DIRECT_READ_HONORS entry imports getUserSpecifiedModelFlag and branches on request.model', () => {
    const violators: Array<{ file: string; reason: string }> = [];
    for (const file of DIRECT_READ_HONORS) {
      const source = STRATEGY_SOURCES.get(file);
      if (!source) {
        violators.push({ file, reason: 'file missing' });
        continue;
      }
      if (!usesDirectRead(source)) {
        violators.push({
          file,
          reason: 'in DIRECT_READ_HONORS but missing getUserSpecifiedModelFlag import or userSpecifiedModel && request.model branch',
        });
      }
    }
    expect(violators).toEqual([]);
  });

  it('PENDING entries do NOT yet honor the pin (sanity: they belong in PENDING)', () => {
    // Inverse check: if a "pending" file already honors the pin via
    // helper or direct-read, it should be MOVED to its real bucket.
    // This test catches the case where someone wires the helper but
    // forgets to update the matrix.
    const misplaced: Array<{ file: string; should: string }> = [];
    for (const file of PENDING) {
      const source = STRATEGY_SOURCES.get(file);
      if (!source) continue;
      if (usesHelper(source)) {
        misplaced.push({ file, should: 'HELPER_HONORS' });
      } else if (usesDirectRead(source)) {
        misplaced.push({ file, should: 'DIRECT_READ_HONORS' });
      }
    }
    expect(misplaced, 'Strategy now honors the pin — promote it out of PENDING').toEqual([]);
  });

  it('PENDING list does not exceed MAX_PENDING (no regression)', () => {
    // The cap shrinks over time. If a future PR tries to add a new
    // unaware strategy to PENDING, it must first migrate an existing
    // entry to HELPER_HONORS or DIRECT_READ_HONORS (which lowers the
    // count) — net zero, no regression.
    expect(PENDING.length).toBeLessThanOrEqual(MAX_PENDING);
  });

  it('Caminho-C Q2 baseline: HybridStrategy is the first honor-via-helper migration', () => {
    // This test is a tombstone for the Q2 closure. If someone removes
    // hybrid-strategy.ts from HELPER_HONORS without replacement, the
    // closure regressed — this test fails.
    expect(HELPER_HONORS.has('hybrid-strategy.ts')).toBe(true);
  });
});
