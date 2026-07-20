// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy Tier System
 *
 * Classifies collective strategies into tiers based on C3 pilot evidence.
 * NO strategy is removed — tiers control governance, not existence.
 *
 * Tiers influence:
 * - Timeout multiplier (fragile strategies get shorter timeouts)
 * - Feedback loop policy (stable strategies can skip feedback for speed)
 * - Pilot participation (configurable via EXPERIMENT_INCLUDE_TIERS env)
 * - Retry policy (fragile strategies get fewer retries)
 * - Monitoring priority (stable strategies require less scrutiny)
 *
 * Evidence basis (from C3 pilot, 555 executions):
 * - stable: >80% success rate OR 100% in limited runs
 * - promising: 40-80% success, competitive quality when working
 * - experimental: 28-60% success, mixed results, needs investigation
 * - fragile: <30% success OR 0% (broken/bug/design issue)
 */

// ─── Types ──────────────────────────────────────────────────────────────

export type StrategyTier = 'stable' | 'promising' | 'experimental' | 'fragile';

export interface TierConfig {
  tier: StrategyTier;
  timeoutMultiplier: number;       // applied on top of base strategy timeout
  maxRetries: number;              // max retry attempts
  feedbackPolicy: 'always' | 'conditional' | 'never';
  includeInPilot: boolean;         // whether included in default pilot
  includeInProduction: boolean;    // whether available in production traffic
  description: string;
}

// ─── Tier Definitions ───────────────────────────────────────────────────

export const TIER_CONFIGS: Record<StrategyTier, TierConfig> = {
  stable: {
    tier: 'stable',
    timeoutMultiplier: 1.0,
    maxRetries: 3,
    feedbackPolicy: 'conditional',  // skip feedback when quality > 0.8
    includeInPilot: true,
    includeInProduction: true,
    description: '>80% success rate, competitive quality, production-ready',
  },
  promising: {
    tier: 'promising',
    timeoutMultiplier: 1.2,         // 20% more time (these strategies are worth waiting for)
    maxRetries: 2,
    feedbackPolicy: 'always',
    includeInPilot: true,
    includeInProduction: true,      // available but not default
    description: '40-80% success, competitive quality when working, needs pool stability',
  },
  experimental: {
    tier: 'experimental',
    timeoutMultiplier: 1.0,
    maxRetries: 1,                  // fail fast — don't waste budget retrying unproven strategies
    feedbackPolicy: 'always',
    includeInPilot: true,
    includeInProduction: false,     // research only
    description: '28-60% success, mixed results, under investigation',
  },
  fragile: {
    tier: 'fragile',
    timeoutMultiplier: 0.8,         // shorter timeout — don't let them hog resources
    maxRetries: 1,
    feedbackPolicy: 'never',        // no point refining a broken strategy
    includeInPilot: true,           // keep in pilot for data collection
    includeInProduction: false,
    description: '<30% success or 0%, known issues, needs fix before production',
  },
};

// ─── Strategy → Tier Mapping ────────────────────────────────────────────

/**
 * Based on C3 pilot data (555 executions):
 *
 * stable (>80% success):
 *   hybrid: 93.3%, quality_multipass: 100%, sequential: 93.3%,
 *   parallel: 80%, safety-quorum: 92.9%, adaptive: 64.3% (but highest quality 0.832)
 *
 * promising (40-80%):
 *   collaborative: 40% (0.842 quality — highest), competitive: 60%,
 *   expert-panel: 53.3%, critique-repair: 42.9% (0.737 quality),
 *   multi-hop-qa: 42.9% (0.667), blind-debate: 42.9%,
 *   clarification-first: 50%, research-synthesize: 35.7% (0.700 quality)
 *
 * experimental (28-60%):
 *   consensus: 28.6%, reinforcement: 50%, hierarchical: 50%,
 *   cost-cascade: 0% (broken by cost=0 bug, now fixed),
 *   contextual: 50%, massive-parallel: 53.3%,
 *   diversity-ensemble: 50%, devil-advocate-consensus: 42.9%,
 *   war-room: 50%, stigmergic-refinement: 42.9%, agentic: 42.9%
 *
 * fragile (<30% or 0%):
 *   debate: 28.6% (0.350 quality), double-diamond: 21.4% (0.333),
 *   persona-exploration: 21.4% (0.617), swarm-explore: 35.7% (0.198),
 *   quality-multipass (dash): 0% (naming bug)
 *
 * NOTE: cost-cascade is "experimental" not "fragile" because its 0% was caused
 * by the cost=0 sorting bug (now fixed), not by fundamental design issues.
 * It needs retesting with the fix before being promoted.
 */
const STRATEGY_TIERS: Record<string, StrategyTier> = {
  // Stable tier
  'hybrid': 'stable',
  'quality-multipass': 'stable',
  'quality_multipass': 'stable',
  'sequential': 'stable',
  'parallel': 'stable',
  'safety-quorum': 'stable',
  'adaptive': 'stable',
  'single': 'stable',

  // Promising tier
  'collaborative': 'promising',
  'competitive': 'promising',
  'expert-panel': 'promising',
  'critique-repair': 'promising',
  'multi-hop-qa': 'promising',
  'blind-debate': 'promising',
  'clarification-first': 'promising',
  'research-synthesize': 'promising',

  // Experimental tier
  'consensus': 'experimental',
  'reinforcement': 'experimental',
  'hierarchical': 'experimental',
  'cost-cascade': 'experimental',  // was 0% due to bug, now fixed
  'contextual': 'experimental',
  'massive-parallel': 'experimental',
  'diversity-ensemble': 'experimental',
  'devil-advocate-consensus': 'experimental',
  'war-room': 'experimental',
  'stigmergic-refinement': 'experimental',
  'agentic': 'experimental',

  // Fragile tier
  'debate': 'fragile',
  'double-diamond': 'fragile',
  'persona-exploration': 'fragile',
  'swarm-explore': 'fragile',
};

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Get the tier for a strategy.
 * Returns 'experimental' for unknown strategies (conservative default).
 */
export function getStrategyTier(strategy: string): StrategyTier {
  return STRATEGY_TIERS[strategy.toLowerCase()] ?? 'experimental';
}

/**
 * Get the tier config for a strategy.
 */
export function getStrategyTierConfig(strategy: string): TierConfig {
  const tier = getStrategyTier(strategy);
  return TIER_CONFIGS[tier];
}

/**
 * Get all strategies in a specific tier.
 */
export function getStrategiesByTier(tier: StrategyTier): string[] {
  return Object.entries(STRATEGY_TIERS)
    .filter(([, t]) => t === tier)
    .map(([name]) => name);
}

/**
 * Check if a strategy is allowed for a given context.
 *
 * @param strategy - Strategy name
 * @param allowedTiers - Which tiers to include (from env/config)
 * @returns true if the strategy's tier is in the allowed set
 */
export function isStrategyAllowed(strategy: string, allowedTiers?: StrategyTier[]): boolean {
  if (!allowedTiers || allowedTiers.length === 0) return true; // no restriction
  const tier = getStrategyTier(strategy);
  return allowedTiers.includes(tier);
}

/**
 * Parse EXPERIMENT_INCLUDE_TIERS env var.
 * Format: "stable,promising" or "stable,promising,experimental,fragile"
 */
export function parseAllowedTiers(envValue?: string): StrategyTier[] | undefined {
  if (!envValue) return undefined;
  return envValue.split(',').map(t => t.trim() as StrategyTier).filter(t =>
    ['stable', 'promising', 'experimental', 'fragile'].includes(t)
  );
}

/**
 * Get the effective timeout for a strategy, considering its tier.
 *
 * @param baseTimeoutMs - The strategy's own timeout from metadata
 * @returns Adjusted timeout applying tier multiplier
 */
export function getEffectiveTimeout(strategy: string, baseTimeoutMs: number): number {
  const config = getStrategyTierConfig(strategy);
  return Math.round(baseTimeoutMs * config.timeoutMultiplier);
}

// ─── Provisional Tier Recalculation ─────────────────────────────────────

/**
 * All tier assignments are PROVISIONAL — they must be recalculated after
 * the next stabilized pilot. This flag prevents auto-promotion past 'promising'
 * without manual confirmation.
 */
const TIER_PROVISIONAL = true;

interface TierRecalculationInput {
  strategyName: string;
  successRate: number;       // 0-1
  avgQuality: number;        // 0-1
  sampleCount: number;
  currentTier: StrategyTier;
}

interface TierRecalculationResult {
  strategyName: string;
  currentTier: StrategyTier;
  proposedTier: StrategyTier;
  changed: boolean;
  reason: string;
  provisional: boolean;
}

/**
 * Propose a tier recalculation based on recent execution data.
 *
 * Rules:
 *   - >80% success + quality > 0.6 → stable
 *   - 40-80% success OR quality > 0.5 → promising
 *   - 28-40% success → experimental
 *   - <28% success → fragile
 *   - Minimum 10 samples required for any change
 *   - PROVISIONAL: cannot auto-promote past 'promising' (requires manual review)
 */
export function recalculateTier(input: TierRecalculationInput): TierRecalculationResult {
  const { strategyName, successRate, avgQuality, sampleCount, currentTier } = input;

  // Minimum sample requirement
  if (sampleCount < 10) {
    return {
      strategyName,
      currentTier,
      proposedTier: currentTier,
      changed: false,
      reason: `Insufficient samples (${sampleCount} < 10)`,
      provisional: TIER_PROVISIONAL,
    };
  }

  let proposedTier: StrategyTier;
  let reason: string;

  if (successRate >= 0.8 && avgQuality >= 0.6) {
    proposedTier = 'stable';
    reason = `success=${(successRate * 100).toFixed(0)}% quality=${avgQuality.toFixed(2)} → stable`;
  } else if (successRate >= 0.4 || avgQuality >= 0.5) {
    proposedTier = 'promising';
    reason = `success=${(successRate * 100).toFixed(0)}% quality=${avgQuality.toFixed(2)} → promising`;
  } else if (successRate >= 0.28) {
    proposedTier = 'experimental';
    reason = `success=${(successRate * 100).toFixed(0)}% → experimental`;
  } else {
    proposedTier = 'fragile';
    reason = `success=${(successRate * 100).toFixed(0)}% → fragile`;
  }

  // Provisional guard: cannot auto-promote past 'promising'
  if (TIER_PROVISIONAL && proposedTier === 'stable' && currentTier !== 'stable') {
    proposedTier = 'promising';
    reason += ' (capped at promising — manual promotion to stable required during provisional period)';
  }

  return {
    strategyName,
    currentTier,
    proposedTier,
    changed: proposedTier !== currentTier,
    reason,
    provisional: TIER_PROVISIONAL,
  };
}

/**
 * Get all tier recalculation proposals from execution results.
 * Returns only strategies that would change tier.
 */
export function proposeAllTierChanges(
  results: Array<{ strategy: string; success: boolean; qualityScore: number }>,
): TierRecalculationResult[] {
  // Group by strategy
  const grouped = new Map<string, { successes: number; total: number; qualitySum: number }>();
  for (const r of results) {
    const key = r.strategy.toLowerCase();
    const g = grouped.get(key) ?? { successes: 0, total: 0, qualitySum: 0 };
    g.total++;
    if (r.success) g.successes++;
    g.qualitySum += r.qualityScore;
    grouped.set(key, g);
  }

  const proposals: TierRecalculationResult[] = [];
  for (const [strategy, data] of grouped) {
    const result = recalculateTier({
      strategyName: strategy,
      successRate: data.total > 0 ? data.successes / data.total : 0,
      avgQuality: data.total > 0 ? data.qualitySum / data.total : 0,
      sampleCount: data.total,
      currentTier: getStrategyTier(strategy),
    });
    if (result.changed) {
      proposals.push(result);
    }
  }

  return proposals;
}

// ─── Feature Flags ──────────────────────────────────────────────────────

/**
 * Feature flags for strategy governance.
 * Read from environment variables for runtime control without redeployment.
 */
export function getStrategyFeatureFlags(): {
  allowedTiers: StrategyTier[] | undefined;
  enableFragileInPilot: boolean;
  enableRuntimeDegradation: boolean;
  enableAdaptiveShadow: boolean;
  enableAdaptiveLive: boolean;
  enableSelfHostedFallback: boolean;
} {
  return {
    allowedTiers: parseAllowedTiers(process.env.EXPERIMENT_INCLUDE_TIERS),
    enableFragileInPilot: process.env.EXPERIMENT_ENABLE_FRAGILE_IN_PILOT === 'true',
    enableRuntimeDegradation: process.env.ENABLE_RUNTIME_DEGRADATION !== 'false', // default: enabled
    enableAdaptiveShadow: process.env.ENABLE_ADAPTIVE_SHADOW === 'true',
    enableAdaptiveLive: false, // always disabled until ecosystem is stable
    enableSelfHostedFallback: process.env.ENABLE_SELF_HOSTED_FALLBACK !== 'false', // default: enabled
  };
}
