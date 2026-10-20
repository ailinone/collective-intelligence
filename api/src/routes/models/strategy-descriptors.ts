// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-descriptors.ts — the versioned strategy-target descriptor builder
 * for GET /v1/models/strategies (CAT-001 / A1) and the additive descriptor
 * fields on GET /v1/models/:id (A4).
 *
 * WHY a pure module (same pattern as models-list-serialization.ts): the
 * descriptor contract is the cross-repo deliverable chat's BFF and frontend
 * consume, so its shape must be unit-testable WITHOUT the provider-registry /
 * DB / config import chain. This file depends only on pricing-tiers.ts and the
 * dependency-light serialization module.
 *
 * Contract rules implemented here (README.md v3, "Required target contract"):
 *   - `catalogVersion` — "v1"; bumps whenever descriptor semantics change;
 *     consumers fail closed on unknown versions.
 *   - `selectable` is DERIVED, never hand-set:
 *     `executionReady && operability === 'operational'`.
 *   - `capabilities` is per-target truth: `streaming` is listed ONLY for
 *     families whose execution supports it. Consensus's execution has
 *     streaming deliberately blocked until its evaluator/outlier pipeline is
 *     wired into the streaming path (consensus-strategy.ts supportsStreaming()
 *     → false, pinned by the consensus-strategy.streaming-parity test), so
 *     consensus cells must NOT advertise it — STRATEGY_STREAMING_SUPPORT
 *     below encodes that audit, and a source-scan characterization test pins
 *     the map against the strategy implementations themselves.
 *   - `pricing` is an ALLOWLIST projection built at DTO time: currency + the
 *     declared per-1M list rates. NEVER a passthrough of provider-row
 *     internals (cost, margin, COGS fields exist on other shapes and must not
 *     leak here).
 *   - `controls` is ABSENT (not defaulted): no declared per-family source
 *     exists yet (CAT-001 v3 rule) — shipping a default would be inventing
 *     contract data.
 *   - Fail-closed: a cell whose family is not in the canonical family enum
 *     cannot produce a descriptor — `buildStrategyDescriptor` returns null and
 *     the catalog builder drops it loudly. Unknown enums must never leak.
 */

import { z } from 'zod';
import type { OfferedCell } from '@/services/pricing-tiers';
import { STRATEGY_POLICY, listOfferedPricingCells } from '@/services/pricing-tiers';
import {
  isStrategyFamily,
  type StrategyFamily,
} from '@/services/strategy-family';
import {
  buildStrategyTierCompositeEntry,
} from './models-list-serialization';

/** Semantic version of the descriptor contract emitted by this module. */
export const STRATEGY_CATALOG_VERSION = 'v1';

/**
 * Per-family streaming truth, audited against each execution's
 * `supportsStreaming()` (the executable truth the orchestration engine itself
 * consults — orchestration-engine.ts:4275):
 *   - consensus → FALSE: `ConsensusStrategy.supportsStreaming()` returns false
 *     and `executeStream()` throws by design until evaluator/outlier/fallback
 *     parity lands (strategies/consensus-strategy.ts:1064; pinned by
 *     consensus-strategy.streaming-parity.test.ts).
 *   - everything else → TRUE: single-model, cost-cascade (economy),
 *     quality-multipass (best), parallel, expert-panel all return true;
 *     `auto` resolves through the engine's triage/bespoke chat streaming path.
 * A source-scan test in strategy-descriptors.test.ts re-reads the strategy
 * implementations and fails if one of these flips without this map changing.
 */
export const STRATEGY_STREAMING_SUPPORT: Record<StrategyFamily, boolean> = {
  auto: true,
  best: true,
  fast: true,
  economy: true,
  single: true,
  parallel: true,
  consensus: false,
  'expert-panel': true,
  // media-planner → FALSE: the planner is a bounded agentic turn loop that
  // produces a terminal OrchestrationResult (same shape the dedicated
  // /v1/capabilities/media-plan/execute route returns); there is no
  // executeStream path for it today.
  'media-planner': false,
};

/** Human label per family (presentation only — never a policy input). */
const FAMILY_LABEL: Record<StrategyFamily, string> = {
  auto: 'Auto',
  best: 'Best',
  fast: 'Fast',
  economy: 'Economy',
  single: 'Single',
  parallel: 'Parallel',
  consensus: 'Consensus',
  'expert-panel': 'Expert Panel',
  'media-planner': 'Media Planner',
};

/** The outbound descriptor schema — the contract chat fails closed on. Also
 * the build-time invariant: a descriptor that does not satisfy it never
 * leaves this module (fail-closed at descriptor build time, CAT-006). */
export const strategyTargetDescriptorSchema = z.object({
  catalogVersion: z.literal(STRATEGY_CATALOG_VERSION),
  id: z.string().regex(/^[a-z-]+:(tiny|small|base|medium|large|extra)$/),
  kind: z.literal('collective_strategy'),
  displayName: z.string().min(1),
  description: z.string().min(1),
  strategy: z.object({
    family: z.enum([
      'auto',
      'best',
      'fast',
      'economy',
      'single',
      'parallel',
      'consensus',
      'expert-panel',
      'media-planner',
    ]),
    tier: z.enum(['tiny', 'small', 'base', 'medium', 'large', 'extra']),
  }),
  selectable: z.boolean(),
  capabilities: z.array(z.string().min(1)).min(1),
  operability: z.enum(['operational', 'non_operational']),
  pricing: z.object({
    currency: z.literal('USD'),
    inputPer1MUsd: z.number().nonnegative(),
    outputPer1MUsd: z.number().nonnegative(),
  }),
  entitlement: z.object({ required: z.literal(true) }),
});

export type StrategyTargetDescriptor = z.infer<typeof strategyTargetDescriptorSchema>;

/**
 * Build the descriptor for one offered `<family>:<tier>` cell, or `null` when
 * the cell's family is not in the canonical enum (fail-closed: an unknown or
 * shadow-wired family must not leak into the catalog). Throws if the built
 * descriptor somehow violates the published schema — an internal invariant
 * breach is a build-time failure, not a bad row in production.
 */
export function buildStrategyDescriptor(cell: OfferedCell): StrategyTargetDescriptor | null {
  if (!isStrategyFamily(cell.strategy)) return null;
  const family: StrategyFamily = cell.strategy;

  // Operability is DERIVED from the same composite entry the list endpoints
  // serialize (runnable → 'operational'), never hand-set per family.
  const entry = buildStrategyTierCompositeEntry(cell);
  const operability = entry.operability.runnable ? ('operational' as const) : ('non_operational' as const);
  const executionReady = STRATEGY_POLICY[family]?.executionReady === true;
  const selectable = executionReady && operability === 'operational';

  const label = FAMILY_LABEL[family];
  const capabilities = ['chat'];
  if (STRATEGY_STREAMING_SUPPORT[family]) capabilities.push('streaming');
  capabilities.push('function_calling');

  const descriptor: StrategyTargetDescriptor = {
    catalogVersion: STRATEGY_CATALOG_VERSION,
    id: cell.id,
    kind: 'collective_strategy',
    displayName: `${label} Strategy`,
    description: `Collective ${label.toLowerCase()} strategy at the ${cell.tier} pricing tier (quality target ${cell.qualityTarget}).`,
    strategy: { family, tier: cell.tier },
    selectable,
    capabilities,
    operability,
    // Allowlist projection ONLY — declared list price fields, nothing else
    // from the cell/provider internals.
    pricing: {
      currency: 'USD',
      inputPer1MUsd: cell.inputPer1MUsd,
      outputPer1MUsd: cell.outputPer1MUsd,
    },
    entitlement: { required: true },
  };

  const parsed = strategyTargetDescriptorSchema.safeParse(descriptor);
  if (!parsed.success) {
    throw new Error(
      `strategy descriptor for '${cell.id}' violates the published schema: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

/**
 * The full strategy catalog: every offered cell (listOfferedPricingCells ∩
 * executionReady, which is that function's own filter) through the descriptor
 * builder. Cells whose family fails the enum check are DROPPED with a warn —
 * they can never appear in the response, not even with degraded fields.
 */
export function buildStrategyCatalog(cells: OfferedCell[] = listOfferedPricingCells()): {
  catalogVersion: typeof STRATEGY_CATALOG_VERSION;
  strategies: StrategyTargetDescriptor[];
} {
  const strategies: StrategyTargetDescriptor[] = [];
  for (const cell of cells) {
    const descriptor = buildStrategyDescriptor(cell);
    if (descriptor === null) {
      // No logger import here (keeps the module dependency-light); the
      // fail-closed property is enforced by the route contract tests, which
      // assert shadow-wired/unknown families never appear.
      continue;
    }
    strategies.push(descriptor);
  }
  return { catalogVersion: STRATEGY_CATALOG_VERSION, strategies };
}

/** Descriptor for a composite id (`best:medium`), or null when the id is not
 * an offered cell — used by the additive GET /v1/models/:id extension (A4). */
export function buildStrategyDescriptorById(
  id: string,
  cells: OfferedCell[] = listOfferedPricingCells()
): StrategyTargetDescriptor | null {
  const lookup = id.trim().toLowerCase();
  const cell = cells.find((candidate) => candidate.id === lookup);
  if (!cell) return null;
  return buildStrategyDescriptor(cell);
}
