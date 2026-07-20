// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Thompson Sampling Provider Bandit
 *
 * Part of Full SOTA Provider Resolution (L5: Provider Selection).
 *
 * Learns which provider is best for each model equivalence group
 * using Beta distribution + Thompson Sampling. Each (equivalenceGroup, providerId)
 * pair is an arm. Success/failure updates the Beta parameters.
 *
 * Mirrors the architecture of strategy-bandit.ts but applied to provider routing.
 *
 * Key: `${equivalenceGroup}|${providerId}`
 * Prior: Beta(1, 1) — uninformative (explore first)
 * Reward: success ? (0.5 + 0.5 * qualityScore) : 0
 */

import { logger } from '@/utils/logger';

const _log = logger.child({ component: 'provider-bandit' });

// ─── Config ─────────────────────────────────────────────────────────────

const SUCCESS_REWARD_BASE = 0.5;
const SUCCESS_REWARD_QUALITY_WEIGHT = 0.5;
const SUCCESS_THRESHOLD = 0.6; // reward >= this → success
const FAILURE_THRESHOLD = 0.4; // reward < this → failure

// ─── Types ──────────────────────────────────────────────────────────────

interface BetaParams {
  alpha: number; // successes + 1
  beta: number;  // failures + 1
}

type BanditKey = string; // `${equivalenceGroup}|${providerId}`

function makeKey(equivalenceGroup: string, providerId: string): BanditKey {
  return `${equivalenceGroup}|${providerId}`;
}

export interface ProviderSelectionResult {
  rankedProviders: Array<{
    providerId: string;
    equivalenceGroup: string;
    sampledScore: number;
    estimatedWinRate: number;
    confidence: number;
  }>;
  decisionReason: string;
}

// ─── Beta Sampling ──────────────────────────────────────────────────────

/**
 * Sample from a Beta(alpha, beta) distribution using the Gamma decomposition method.
 * Beta(a,b) = Gamma(a) / (Gamma(a) + Gamma(b))
 * Gamma samples via the squeeze-rejection method for alpha >= 1,
 * and the recursive transformation for alpha < 1.
 */
function betaSample(alpha: number, beta: number): number {
  const ga = gammaSample(alpha);
  const gb = gammaSample(beta);
  const sum = ga + gb;
  if (sum === 0) return 0.5; // degenerate case
  return Math.max(0.001, Math.min(0.999, ga / sum));
}

/** Squeeze-rejection Gamma sampling. */
function gammaSample(shape: number): number {
  if (shape < 1) {
    // Recursive shape boost: Gamma(a) = Gamma(a+1) * U^(1/a)
    return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  // Squeeze-rejection method for shape >= 1
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      // Box-Muller normal sample
      x = Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: ProviderBandit | null = null;

export function getProviderBandit(): ProviderBandit {
  if (!instance) {
    instance = new ProviderBandit();
  }
  return instance;
}

// ─── Service ────────────────────────────────────────────────────────────

export class ProviderBandit {
  private readonly params = new Map<BanditKey, BetaParams>();

  /**
   * Select best provider for a model equivalence group using Thompson Sampling.
   *
   * @param equivalenceGroup - The model equivalence group ID
   * @param candidateProviders - Provider IDs to choose from
   * @param excludeProviders - Providers to exclude (failed, no-credits, circuit open)
   */
  selectProvider(
    equivalenceGroup: string,
    candidateProviders: string[],
    excludeProviders: string[] = [],
  ): ProviderSelectionResult {
    const excluded = new Set(excludeProviders.map(p => p.toLowerCase()));
    const eligible = candidateProviders.filter(p => !excluded.has(p.toLowerCase()));

    if (eligible.length === 0) {
      return { rankedProviders: [], decisionReason: 'No eligible providers after exclusion' };
    }

    // Sample from each arm's Beta distribution
    const scored = eligible.map(providerId => {
      const key = makeKey(equivalenceGroup, providerId.toLowerCase());
      const beta = this.params.get(key) ?? { alpha: 1, beta: 1 }; // uninformative prior
      const sampledScore = betaSample(beta.alpha, beta.beta);
      const estimatedWinRate = beta.alpha / (beta.alpha + beta.beta);
      const confidence = beta.alpha + beta.beta - 2; // observations

      return {
        providerId,
        equivalenceGroup,
        sampledScore,
        estimatedWinRate,
        confidence,
      };
    });

    // Sort by sampled score descending (Thompson Sampling selection)
    scored.sort((a, b) => b.sampledScore - a.sampledScore);

    return {
      rankedProviders: scored,
      decisionReason: scored.length > 1
        ? `Thompson Sampling: ${scored[0].providerId} scored ${scored[0].sampledScore.toFixed(3)} (α=${this.getAlpha(equivalenceGroup, scored[0].providerId)}, β=${this.getBeta(equivalenceGroup, scored[0].providerId)})`
        : `Only one provider available: ${scored[0].providerId}`,
    };
  }

  /**
   * Update bandit after execution.
   * Reward = success ? (0.5 + 0.5 * qualityScore) : 0
   */
  update(params: {
    equivalenceGroup: string;
    providerId: string;
    success: boolean;
    qualityScore?: number;
    latencyMs?: number;
  }): void {
    const { equivalenceGroup, providerId, success, qualityScore } = params;
    const key = makeKey(equivalenceGroup, providerId.toLowerCase());
    const current = this.params.get(key) ?? { alpha: 1, beta: 1 };

    const reward = success
      ? SUCCESS_REWARD_BASE + SUCCESS_REWARD_QUALITY_WEIGHT * (qualityScore ?? 0.5)
      : 0;

    if (reward >= SUCCESS_THRESHOLD) {
      current.alpha += 1;
    } else if (reward < FAILURE_THRESHOLD) {
      current.beta += 1;
    }
    // DESIGN DECISION: Rewards in [FAILURE_THRESHOLD, SUCCESS_THRESHOLD) are ambiguous
    // (e.g., success=true with very low qualityScore). We intentionally don't update
    // the bandit for these cases to avoid noisy signal corrupting the Beta parameters.
    // This affects ~5% of executions where quality is borderline.

    this.params.set(key, current);
  }

  /**
   * Get estimated win rates for all providers of a model.
   */
  getProviderWinRates(equivalenceGroup: string): Record<string, number> {
    const rates: Record<string, number> = {};
    for (const [key, beta] of this.params.entries()) {
      if (key.startsWith(equivalenceGroup + '|')) {
        const providerId = key.split('|')[1];
        rates[providerId] = beta.alpha / (beta.alpha + beta.beta);
      }
    }
    return rates;
  }

  /**
   * Get observation count for a provider arm.
   */
  getObservationCount(equivalenceGroup: string, providerId: string): number {
    const key = makeKey(equivalenceGroup, providerId.toLowerCase());
    const beta = this.params.get(key);
    return beta ? (beta.alpha + beta.beta - 2) : 0;
  }

  /**
   * Get stats for monitoring.
   */
  getStats(): { totalArms: number; totalObservations: number } {
    let totalObs = 0;
    for (const beta of this.params.values()) {
      totalObs += beta.alpha + beta.beta - 2;
    }
    return { totalArms: this.params.size, totalObservations: totalObs };
  }

  private getAlpha(group: string, provider: string): number {
    return this.params.get(makeKey(group, provider.toLowerCase()))?.alpha ?? 1;
  }

  private getBeta(group: string, provider: string): number {
    return this.params.get(makeKey(group, provider.toLowerCase()))?.beta ?? 1;
  }
}
