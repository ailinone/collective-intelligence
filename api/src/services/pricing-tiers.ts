// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CI pricing tiers (the budget/quality axis) + strategy×tier policy.
 *
 * Two orthogonal axes compose into a model id `<strategy>:<tier>`:
 *   - STRATEGY (mechanism): single, parallel, consensus, war-room, … (the "how").
 *     Recognised by the orchestration strategy-contract; governs deliberation.
 *   - TIER (budget/quality + price): tiny … extra (the "how much").
 *     Governs the published per-token rate the USER pays + the per-request COGS
 *     budget (margin guard). The strategy SPENDS the budget; it does NOT change
 *     the price — so `consensus:large` and `war-room:large` both bill the `large`
 *     rate, and the COGS guard keeps each within margin.
 *
 * Pricing is metered on the USER's tokens (their prompt + the final synthesised
 * answer), NOT the internal fan-out — that is the whole point: provider-compatible,
 * predictable, and the thesis "≤ top-tier" is expressible per token.
 *
 * Tier rates are anchored BELOW the benchmark Pareto frontier (cheapest single
 * model at the tier's quality target) and re-derivable when the leaderboard moves:
 *   rate = ceil(paretoAnchor × (1 − thesisDiscount)).
 */

export type TierId = 'tiny' | 'small' | 'base' | 'medium' | 'large' | 'extra';

export interface PricingTier {
  id: TierId;
  /** Quality floor the tier promises (resolution-rate proxy, 0–1). */
  qualityTarget: number;
  /** User-token INPUT rate, USD per 1M tokens (integer, rounded up). */
  inputPer1MUsd: number;
  /** User-token OUTPUT rate, USD per 1M tokens (integer, rounded up). */
  outputPer1MUsd: number;
  /** Contribution-margin floor → drives the per-request COGS budget (the guard). */
  marginTarget: number;
  /** The benchmark single-model the tier under-prices (for docs/recalibration). */
  paretoAnchor: string;
}

/**
 * The rate card. Output carries the differentiation (1→42) mirroring the "80%
 * cliff"; margin is thin at the floor (competes with cheap singles) and healthy
 * at the top (where single top-tier models cost $25–50).
 */
export const TIERS: Record<TierId, PricingTier> = {
  tiny: { id: 'tiny',   qualityTarget: 0.65, inputPer1MUsd: 1, outputPer1MUsd: 1,  marginTarget: 0.30, paretoAnchor: 'cheapest viable' },
  small: { id: 'small',  qualityTarget: 0.70, inputPer1MUsd: 1, outputPer1MUsd: 2,  marginTarget: 0.35, paretoAnchor: 'DeepSeek V3.2 ($0.27/$1.1)' },
  base: { id: 'base',   qualityTarget: 0.75, inputPer1MUsd: 1, outputPer1MUsd: 4,  marginTarget: 0.40, paretoAnchor: 'MiniMax M2.5 ($0.3/$1.2)' },
  medium: { id: 'medium', qualityTarget: 0.80, inputPer1MUsd: 2, outputPer1MUsd: 8,  marginTarget: 0.50, paretoAnchor: 'Gemini 3.1 Pro ($2/$12)' },
  large: { id: 'large',  qualityTarget: 0.88, inputPer1MUsd: 4, outputPer1MUsd: 20, marginTarget: 0.55, paretoAnchor: 'Opus 4.8 ($5/$25)' },
  extra: { id: 'extra',  qualityTarget: 0.94, inputPer1MUsd: 8, outputPer1MUsd: 42, marginTarget: 0.55, paretoAnchor: 'Fable 5 ($10/$50)' },
};

export const TIER_ORDER: readonly TierId[] = ['tiny', 'small', 'base', 'medium', 'large', 'extra'];
export const DEFAULT_TIER: TierId = 'base';

/**
 * A published per-tier rate, USD per 1M USER tokens. The STATIC card below is the
 * hand-set fallback; the calibrator (`pricing-calibrator.ts`) emits a MEASURED card
 * from the live benchmark Pareto frontier, which callers inject in place of it. The
 * billing/budget functions take the card as a parameter so a calibrated card flows
 * through without changing any call site's tier semantics.
 */
export interface TierRate {
  inputPer1MUsd: number;
  outputPer1MUsd: number;
}
export type TierRateCard = Record<TierId, TierRate>;

function rateCardFromTiers(tiers: Record<TierId, PricingTier>): TierRateCard {
  return TIER_ORDER.reduce((acc, id) => {
    acc[id] = { inputPer1MUsd: tiers[id].inputPer1MUsd, outputPer1MUsd: tiers[id].outputPer1MUsd };
    return acc;
  }, {} as TierRateCard);
}

/** Hand-set fallback rate card (used until the calibrator publishes a measured one). */
export const STATIC_RATE_CARD: TierRateCard = Object.freeze(rateCardFromTiers(TIERS));

/** Fan-out weight class — drives the valid tier range (a heavy mechanism needs budget). */
export type CogsClass = 'solo' | 'light' | 'consensus' | 'deliberative';

export interface StrategyPolicy {
  cogsClass: CogsClass;
  /** Lowest tier whose COGS budget can fund this mechanism. */
  minTier: TierId;
  /** Highest tier whose quality target this mechanism is sold for. */
  maxTier: TierId;
  /** Approx fan-out cost multiple vs a single call — for margin estimation only. */
  fanoutFactor: number;
  /** True when the mechanism has a genuinely DISTINCT execution today (safe to sell). */
  executionReady: boolean;
}

/**
 * strategy → policy. Names match the canonical `strategy-contract.ts`. Only the
 * `executionReady` set behaves distinctly today; the rest are recognised but
 * shadow-wired — keep them gated until each lands a distinct execution.
 */
export const STRATEGY_POLICY: Record<string, StrategyPolicy> = {
  // Presets (intent)
  auto: { cogsClass: 'light',        minTier: 'tiny',   maxTier: 'extra', fanoutFactor: 1.5, executionReady: true },
  best: { cogsClass: 'deliberative', minTier: 'medium', maxTier: 'extra', fanoutFactor: 6,   executionReady: true },
  fast: { cogsClass: 'solo',         minTier: 'tiny',   maxTier: 'base',  fanoutFactor: 1,   executionReady: true },
  economy: { cogsClass: 'solo',         minTier: 'tiny',   maxTier: 'base',  fanoutFactor: 1,   executionReady: true },
  // Mechanisms with distinct execution (launch-ready)
  single: { cogsClass: 'solo',         minTier: 'tiny',   maxTier: 'base',  fanoutFactor: 1,   executionReady: true },
  parallel: { cogsClass: 'light',        minTier: 'small',  maxTier: 'large', fanoutFactor: 2.5, executionReady: true },
  consensus: { cogsClass: 'consensus',    minTier: 'medium', maxTier: 'extra', fanoutFactor: 5,   executionReady: true },
  'expert-panel': { cogsClass: 'deliberative', minTier: 'large',  maxTier: 'extra', fanoutFactor: 6,   executionReady: true },
  // Shadow-wired (recognised; behaviour maturing — gate before selling)
  debate: { cogsClass: 'deliberative', minTier: 'large',  maxTier: 'extra', fanoutFactor: 6, executionReady: false },
  'blind-debate': { cogsClass: 'deliberative', minTier: 'large',  maxTier: 'extra', fanoutFactor: 6, executionReady: false },
  'devil-advocate-consensus': { cogsClass: 'consensus',    minTier: 'medium', maxTier: 'extra', fanoutFactor: 5, executionReady: false },
  'safety-quorum': { cogsClass: 'consensus',    minTier: 'medium', maxTier: 'extra', fanoutFactor: 5, executionReady: false },
  'war-room': { cogsClass: 'deliberative', minTier: 'large',  maxTier: 'extra', fanoutFactor: 8, executionReady: false },
  'persona-exploration': { cogsClass: 'deliberative', minTier: 'medium', maxTier: 'extra', fanoutFactor: 6, executionReady: false },
};

function tierIndex(t: TierId): number {
  return TIER_ORDER.indexOf(t);
}

function clampTier(t: TierId, min: TierId, max: TierId): TierId {
  const i = tierIndex(t);
  const lo = tierIndex(min);
  const hi = tierIndex(max);
  if (i < lo) return min;
  if (i > hi) return max;
  return t;
}

export interface ResolvedStrategyTier {
  strategy: string;
  /** The requested tier after clamping into the strategy's valid [min,max] range. */
  tier: TierId;
  /** True if the requested tier was out of range and got clamped. */
  clamped: boolean;
  qualityTarget: number;
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  executionReady: boolean;
}

/** Parse `<strategy>[:<tier>]` (also accepts an `ailin-` prefix). null if unknown strategy. */
export function parseStrategyTier(model: string | undefined): { strategy: string; tier: TierId } | null {
  const raw = (model ?? '').trim().toLowerCase();
  if (!raw) return null;
  const sep = raw.indexOf(':');
  const stratPart = (sep >= 0 ? raw.slice(0, sep) : raw).replace(/^ailin-/, '');
  const tierPart = sep >= 0 ? raw.slice(sep + 1) : DEFAULT_TIER;
  if (!(stratPart in STRATEGY_POLICY)) return null;
  const tier = (TIER_ORDER as readonly string[]).includes(tierPart) ? (tierPart as TierId) : DEFAULT_TIER;
  return { strategy: stratPart, tier };
}

/** Resolve a `<strategy>:<tier>` model id into its strategy + clamped tier + targets. */
export function resolveStrategyTier(
  model: string | undefined,
  rates: TierRateCard = STATIC_RATE_CARD,
): ResolvedStrategyTier | null {
  const parsed = parseStrategyTier(model);
  if (!parsed) return null;
  const policy = STRATEGY_POLICY[parsed.strategy];
  const tier = clampTier(parsed.tier, policy.minTier, policy.maxTier);
  const t = TIERS[tier];
  const r = rates[tier];
  return {
    strategy: parsed.strategy,
    tier,
    clamped: tier !== parsed.tier,
    qualityTarget: t.qualityTarget,
    inputPer1MUsd: r.inputPer1MUsd,
    outputPer1MUsd: r.outputPer1MUsd,
    executionReady: policy.executionReady,
  };
}

/** The price the USER is billed — on THEIR tokens, at the tier rate. This is the debit. */
export function tierBilledCostUsd(
  tier: TierId,
  userPromptTokens: number,
  userCompletionTokens: number,
  rates: TierRateCard = STATIC_RATE_CARD,
): number {
  const r = rates[tier];
  return (
    (userPromptTokens / 1_000_000) * r.inputPer1MUsd +
    (userCompletionTokens / 1_000_000) * r.outputPer1MUsd
  );
}

/**
 * Per-request COGS budget (the margin guard) — feed this as the spend cap to the
 * credit-governor. The collective may spend UP TO this on the fan-out; if a task
 * cannot hit the quality target within it, the strategy degrades (fewer models)
 * rather than eating the margin.
 */
export function cogsBudgetUsd(
  tier: TierId,
  userPromptTokens: number,
  expectedCompletionTokens: number,
  rates: TierRateCard = STATIC_RATE_CARD,
): number {
  const t = TIERS[tier];
  const revenue = tierBilledCostUsd(tier, userPromptTokens, expectedCompletionTokens, rates);
  return revenue * (1 - t.marginTarget);
}

/** Whether a `<strategy>:<tier>` cell is offered (strategy known, tier in range, execution distinct). */
export function isOfferedCell(strategy: string, tier: TierId): boolean {
  const policy = STRATEGY_POLICY[strategy];
  if (!policy || !policy.executionReady) return false;
  const i = tierIndex(tier);
  return i >= tierIndex(policy.minTier) && i <= tierIndex(policy.maxTier);
}

/** A published `<strategy>:<tier>` product, in the shape `/v1/models` needs (per-1k = per-1M ÷ 1000). */
export interface OfferedCell {
  id: string;
  strategy: string;
  tier: TierId;
  qualityTarget: number;
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
}

/** Every offered `<strategy>:<tier>` cell, priced from the (optionally calibrated) rate card. */
export function listOfferedPricingCells(rates: TierRateCard = STATIC_RATE_CARD): OfferedCell[] {
  const cells: OfferedCell[] = [];
  for (const strategy of Object.keys(STRATEGY_POLICY)) {
    const policy = STRATEGY_POLICY[strategy];
    if (!policy.executionReady) continue;
    for (let i = tierIndex(policy.minTier); i <= tierIndex(policy.maxTier); i++) {
      const tier = TIER_ORDER[i];
      const r = rates[tier];
      cells.push({
        id: `${strategy}:${tier}`,
        strategy,
        tier,
        qualityTarget: TIERS[tier].qualityTarget,
        inputPer1MUsd: r.inputPer1MUsd,
        outputPer1MUsd: r.outputPer1MUsd,
        inputCostPer1k: r.inputPer1MUsd / 1000,
        outputCostPer1k: r.outputPer1MUsd / 1000,
      });
    }
  }
  return cells;
}

/**
 * One-call billing quote for a finished tiered request: the USER-token charge (the
 * debit against the prepaid balance) plus the COGS spend cap (the margin guard).
 * `chargeUsd` is metered on the user's own tokens at the tier rate — never on the
 * internal fan-out — which is exactly what keeps the price provider-compatible.
 */
export interface TierCharge {
  tier: TierId;
  chargeUsd: number;
  cogsBudgetUsd: number;
}

export function quoteTierCharge(
  tier: TierId,
  userPromptTokens: number,
  userCompletionTokens: number,
  rates: TierRateCard = STATIC_RATE_CARD,
): TierCharge {
  return {
    tier,
    chargeUsd: tierBilledCostUsd(tier, userPromptTokens, userCompletionTokens, rates),
    cogsBudgetUsd: cogsBudgetUsd(tier, userPromptTokens, userCompletionTokens, rates),
  };
}
