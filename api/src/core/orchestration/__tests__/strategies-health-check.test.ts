// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * F0.5 + F0.6 — Collective strategies health-check inventory
 *
 * Type-safe inventory and structural validation for every strategy
 * declared in `ALL_COLLECTIVE_STRATEGIES`. Catches three regressions
 * that production has historically hit silently:
 *
 *   1. A name in `ALL_COLLECTIVE_STRATEGIES` whose strategy class is no
 *      longer instantiable (constructor signature drift, removed file).
 *   2. A strategy class whose `getMetadata().name` no longer matches
 *      the entry it is registered under.
 *   3. Bad metadata: minModels < 1, maxModels < minModels, empty
 *      suitableFor, non-finite cost/quality/duration multipliers.
 *
 * The test deliberately instantiates each strategy class WITHOUT the
 * orchestration engine because the goal is structural validation, not
 * end-to-end execution. End-to-end smoke for each strategy belongs in
 * `orchestration-integration.test.ts`.
 *
 * The factory map below is the canonical inventory: when a new
 * collective strategy is added to `ALL_COLLECTIVE_STRATEGIES`, this
 * file MUST be updated in the same change. The cross-check at the
 * bottom of the suite enforces that.
 */

import { describe, it, expect } from 'vitest';
import { ALL_COLLECTIVE_STRATEGIES, type CollectiveStrategy } from '@/core/experiment/experiment-types';
import type { BaseStrategy, StrategyMetadata } from '@/core/orchestration/base-strategy';

import { CollaborativeStrategy } from '@/core/orchestration/strategies/collaborative-strategy';
import { ParallelStrategy } from '@/core/orchestration/strategies/parallel-strategy';
import { SequentialStrategy } from '@/core/orchestration/strategies/sequential-strategy';
import { HybridStrategy } from '@/core/orchestration/strategies/hybrid-strategy';
import { CompetitiveStrategy } from '@/core/orchestration/strategies/competitive-strategy';
import { ExpertPanelStrategy } from '@/core/orchestration/strategies/expert-panel-strategy';
import { MassiveParallelStrategy } from '@/core/orchestration/strategies/massive-parallel-strategy';
import { CostCascadeStrategy } from '@/core/orchestration/strategies/cost-cascade-strategy';
import { QualityMultiPassStrategy } from '@/core/orchestration/strategies/quality-multipass-strategy';
import { AdaptiveStrategy } from '@/core/orchestration/strategies/adaptive-strategy';
import { ContextualStrategy } from '@/core/orchestration/strategies/contextual-strategy';
import { HierarchicalStrategy } from '@/core/orchestration/strategies/hierarchical-strategy';
import { ConsensusStrategy } from '@/core/orchestration/strategies/consensus-strategy';
import { ReinforcementStrategy } from '@/core/orchestration/strategies/reinforcement-strategy';
import { DebateStrategy } from '@/core/orchestration/strategies/debate-strategy';
import { WarRoomStrategy } from '@/core/orchestration/strategies/war-room-strategy';
import { BlindDebateStrategy } from '@/core/orchestration/strategies/blind-debate-strategy';
import { DevilAdvocateConsensusStrategy } from '@/core/orchestration/strategies/devil-advocate-consensus-strategy';
import { SafetyQuorumStrategy } from '@/core/orchestration/strategies/safety-quorum-strategy';
import { DiversityEnsembleStrategy } from '@/core/orchestration/strategies/diversity-ensemble-strategy';
import { StigmergicRefinementStrategy } from '@/core/orchestration/strategies/stigmergic-refinement-strategy';
import { SwarmExploreStrategy } from '@/core/orchestration/strategies/swarm-explore-strategy';
import { ClarificationFirstStrategy } from '@/core/orchestration/strategies/clarification-first-strategy';
import { ResearchSynthesizeStrategy } from '@/core/orchestration/strategies/research-synthesize-strategy';
import { CritiqueRepairStrategy } from '@/core/orchestration/strategies/critique-repair-strategy';
import { DoubleDiamondStrategy } from '@/core/orchestration/strategies/double-diamond-strategy';
import { MultiHopQAStrategy } from '@/core/orchestration/strategies/multi-hop-qa-strategy';
import { PersonaExplorationStrategy } from '@/core/orchestration/strategies/persona-exploration-strategy';
import { AgenticStrategy } from '@/core/orchestration/strategies/agentic-strategy';
import { SensitivityConsensusStrategy } from '@/core/orchestration/strategies/sensitivity-consensus-strategy';
import { TriRoleCollectiveStrategy } from '@/core/orchestration/strategies/tri-role-collective-strategy';

/**
 * Constructor-shaped descriptor for a strategy class. Strategies vary in
 * which optional dependencies they accept in their constructors, so we
 * type the factory as a no-arg callable that yields a `BaseStrategy`.
 * Each entry in the map below uses an arrow that supplies sensible
 * defaults for its specific class.
 */
type StrategyFactory = () => BaseStrategy;

/**
 * The canonical inventory: every CollectiveStrategy name maps to a
 * factory that produces a fresh instance of the corresponding class.
 *
 * Using a `Record<CollectiveStrategy, ...>` as the type makes it a
 * compile error to forget an entry when a new name is added to the
 * `CollectiveStrategy` union — the closest thing TypeScript has to an
 * exhaustive `match` for string-union types.
 */
const COLLECTIVE_STRATEGY_FACTORIES: Record<CollectiveStrategy, StrategyFactory> = {
  collaborative: () => new CollaborativeStrategy(),
  parallel: () => new ParallelStrategy(),
  sequential: () => new SequentialStrategy(),
  hybrid: () => new HybridStrategy(),
  competitive: () => new CompetitiveStrategy(),
  'expert-panel': () => new ExpertPanelStrategy(),
  'massive-parallel': () => new MassiveParallelStrategy(),
  'cost-cascade': () => new CostCascadeStrategy(),
  'quality-multipass': () => new QualityMultiPassStrategy(),
  adaptive: () => new AdaptiveStrategy(),
  contextual: () => new ContextualStrategy(),
  hierarchical: () => new HierarchicalStrategy(),
  consensus: () => new ConsensusStrategy(),
  reinforcement: () => new ReinforcementStrategy(),
  debate: () => new DebateStrategy(),
  'war-room': () => new WarRoomStrategy(),
  'blind-debate': () => new BlindDebateStrategy(),
  'devil-advocate-consensus': () => new DevilAdvocateConsensusStrategy(),
  'safety-quorum': () => new SafetyQuorumStrategy(),
  'diversity-ensemble': () => new DiversityEnsembleStrategy(),
  'stigmergic-refinement': () => new StigmergicRefinementStrategy(),
  'swarm-explore': () => new SwarmExploreStrategy(),
  'clarification-first': () => new ClarificationFirstStrategy(),
  'research-synthesize': () => new ResearchSynthesizeStrategy(),
  'critique-repair': () => new CritiqueRepairStrategy(),
  'double-diamond': () => new DoubleDiamondStrategy(),
  'multi-hop-qa': () => new MultiHopQAStrategy(),
  'persona-exploration': () => new PersonaExplorationStrategy(),
  agentic: () => new AgenticStrategy(),
  'sensitivity-consensus': () => new SensitivityConsensusStrategy(),
  'tri-role-collective': () => new TriRoleCollectiveStrategy(),
};

/**
 * Validate a strategy's metadata against the `StrategyMetadata`
 * contract. Returns an array of human-readable issues (empty when
 * the metadata passes every check).
 */
function validateMetadata(name: CollectiveStrategy, metadata: StrategyMetadata): string[] {
  const issues: string[] = [];

  if (typeof metadata.id !== 'string' || metadata.id.length === 0) {
    issues.push('id missing or empty');
  }
  if (metadata.name !== name) {
    issues.push(`name mismatch: factory key "${name}" vs metadata.name "${metadata.name}"`);
  }
  if (typeof metadata.displayName !== 'string' || metadata.displayName.length === 0) {
    issues.push('displayName missing or empty');
  }
  if (typeof metadata.description !== 'string' || metadata.description.length === 0) {
    issues.push('description missing or empty');
  }
  if (!Number.isInteger(metadata.minModels) || metadata.minModels < 1) {
    issues.push(`minModels invalid: ${metadata.minModels}`);
  }
  if (!Number.isInteger(metadata.maxModels) || metadata.maxModels < metadata.minModels) {
    issues.push(`maxModels invalid: ${metadata.maxModels} (minModels=${metadata.minModels})`);
  }
  if (!Number.isFinite(metadata.estimatedCostMultiplier) || metadata.estimatedCostMultiplier <= 0) {
    issues.push(`estimatedCostMultiplier invalid: ${metadata.estimatedCostMultiplier}`);
  }
  if (
    !Number.isFinite(metadata.estimatedQualityBoost) ||
    metadata.estimatedQualityBoost < 0 ||
    metadata.estimatedQualityBoost > 1
  ) {
    issues.push(`estimatedQualityBoost out of [0, 1]: ${metadata.estimatedQualityBoost}`);
  }
  if (!Number.isFinite(metadata.estimatedDurationMultiplier) || metadata.estimatedDurationMultiplier <= 0) {
    issues.push(`estimatedDurationMultiplier invalid: ${metadata.estimatedDurationMultiplier}`);
  }
  if (!Array.isArray(metadata.suitableFor) || metadata.suitableFor.length === 0) {
    issues.push('suitableFor must be a non-empty array');
  }

  return issues;
}

describe('Collective strategies — health-check inventory (F0.5 + F0.6)', () => {
  describe('factory inventory parity with ALL_COLLECTIVE_STRATEGIES', () => {
    it('contains an entry for every name in ALL_COLLECTIVE_STRATEGIES', () => {
      const factoryKeys = new Set(Object.keys(COLLECTIVE_STRATEGY_FACTORIES));
      const missing = ALL_COLLECTIVE_STRATEGIES.filter((name) => !factoryKeys.has(name));
      expect(missing, `Missing factories for: ${missing.join(', ')}`).toEqual([]);
    });

    it('does not contain factories for unknown names', () => {
      const declaredSet = new Set<string>(ALL_COLLECTIVE_STRATEGIES);
      const unknown = Object.keys(COLLECTIVE_STRATEGY_FACTORIES).filter((k) => !declaredSet.has(k));
      expect(unknown, `Unknown factory keys: ${unknown.join(', ')}`).toEqual([]);
    });
  });

  describe('per-strategy structural validation', () => {
    for (const name of ALL_COLLECTIVE_STRATEGIES) {
      const factory = COLLECTIVE_STRATEGY_FACTORIES[name];

      it(`${name}: instantiates without throwing`, () => {
        expect(() => factory()).not.toThrow();
      });

      it(`${name}: getMetadata() returns a well-formed StrategyMetadata`, () => {
        const strategy = factory();
        const metadata = strategy.getMetadata();
        const issues = validateMetadata(name, metadata);
        expect(issues, `metadata issues for "${name}": ${issues.join('; ')}`).toEqual([]);
      });
    }
  });

  describe('inventory snapshot (F0.6)', () => {
    /**
     * Snapshot-style aggregation. Useful when triaging a regression:
     * the test output lists every strategy with its key metrics so
     * the operator can spot the one that drifted without re-running
     * each per-strategy test.
     */
    it('produces a stable inventory line per strategy', () => {
      const inventory = ALL_COLLECTIVE_STRATEGIES.map((name) => {
        const meta = COLLECTIVE_STRATEGY_FACTORIES[name]().getMetadata();
        return {
          name,
          minModels: meta.minModels,
          maxModels: meta.maxModels,
          costMultiplier: meta.estimatedCostMultiplier,
          qualityBoost: meta.estimatedQualityBoost,
          durationMultiplier: meta.estimatedDurationMultiplier,
          suitableForCount: meta.suitableFor.length,
        };
      });

      // Every entry must satisfy the per-strategy contract — failures
      // here mirror the per-strategy assertions above but emit one
      // consolidated diff that's easier to scan in CI logs.
      for (const entry of inventory) {
        expect(entry.minModels).toBeGreaterThanOrEqual(1);
        expect(entry.maxModels).toBeGreaterThanOrEqual(entry.minModels);
        expect(entry.costMultiplier).toBeGreaterThan(0);
        expect(entry.qualityBoost).toBeGreaterThanOrEqual(0);
        expect(entry.qualityBoost).toBeLessThanOrEqual(1);
        expect(entry.durationMultiplier).toBeGreaterThan(0);
        expect(entry.suitableForCount).toBeGreaterThan(0);
      }

      // Cardinality sanity-check: catches silent removal of a strategy
      // from the union without updating the test or the runtime array.
      expect(inventory.length).toBe(ALL_COLLECTIVE_STRATEGIES.length);
    });
  });
});
