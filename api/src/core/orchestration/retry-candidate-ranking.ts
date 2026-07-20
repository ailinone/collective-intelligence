// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cross-provider retry candidate ranking.
 *
 * When a primary provider fails, we look for the *same model* on alternative
 * providers and try them in priority order. This module encodes that priority
 * as a 3-level lexicographic comparator:
 *
 *   1. Source-type tier (native_api → cloud_hub → router → aggregator).
 *      This is a *structural* preference: native APIs have no markup, full
 *      feature parity, and direct vendor support. The bandit cannot see this
 *      signal — its only feedback is success/quality.
 *   2. Bandit-sampled score (Thompson Sampling Beta(α,β)).
 *      Within the same tier, we let the L5 ProviderBandit pick which arm to
 *      try first. Cold arms hit the Beta(1,1) prior → uniform [0,1] sample,
 *      so without observations the within-tier ordering is stochastic — by
 *      design, that's the exploration step.
 *   3. sourcePriority (catalog-defined integer).
 *      Final tiebreaker for arms with identical bandit scores (e.g., two
 *      cold native arms whose Beta(1,1) samples happen to be equal). Lower
 *      number = higher priority. Defaults to 99.
 *
 * The comparator is extracted from base-strategy.ts so the contract can be
 * pinned by a unit test without standing up the full orchestration stack.
 */
import { safeMetadata } from '@/types/model-metadata.schema';

/** Source-type ordering for cross-provider retry. Lower = preferred. */
export const SOURCE_TYPE_ORDER: Record<string, number> = {
  native_api: 0,
  cloud_hub: 1,
  router: 2,
  aggregator: 3,
};

/** Default tier rank for entries whose sourceType is missing/unknown. */
export const UNKNOWN_TIER_RANK = 9;

/** Default sourcePriority when the catalog row didn't set one. */
export const DEFAULT_SOURCE_PRIORITY = 99;

/**
 * Minimum shape this comparator needs from a model-catalog entry.
 * The full ModelCatalogEntry has more fields, but the comparator only reads
 * `provider` and `metadata.{sourceType, sourcePriority}`.
 */
export interface RankableCandidate {
  provider?: string | null;
  metadata?: {
    sourceType?: string;
    sourcePriority?: number;
    [k: string]: unknown;
  } | null;
}

/**
 * Sort candidates in-place by (tier, bandit-score-desc, sourcePriority).
 *
 * @param candidates  Models to consider for retry. Mutated.
 * @param banditScoreByProvider  Map of lowercased providerId → sampled Beta score.
 *                               Missing providers default to 0 (deprioritized).
 * @returns The same array reference, sorted.
 */
export function rankRetryCandidates<T extends RankableCandidate>(
  candidates: T[],
  banditScoreByProvider: ReadonlyMap<string, number>,
  operabilityRankByProvider?: ReadonlyMap<string, number>,
): T[] {
  return candidates.sort((a, b) => {
    // 0. OPERABILITY/HOT first (determinism, 2026-06-29): proven-bad sinks to the
    //    back, hot/operable rises. Rank convention (caller-computed via the hub,
    //    see computeOperabilityRanks): hot=3 > operable=2 > unknown=1 > bad=0. This
    //    is what stops cross-provider retry from trying phala(401)/aihubmix(403)
    //    before the operable variant, and prefers already-warm HF routes.
    if (operabilityRankByProvider) {
      const opA = operabilityRankByProvider.get((a.provider || '').toLowerCase()) ?? 1;
      const opB = operabilityRankByProvider.get((b.provider || '').toLowerCase()) ?? 1;
      if (opA !== opB) return opB - opA;
    }

    const typeA = SOURCE_TYPE_ORDER[safeMetadata(a.metadata).sourceType ?? ''] ?? UNKNOWN_TIER_RANK;
    const typeB = SOURCE_TYPE_ORDER[safeMetadata(b.metadata).sourceType ?? ''] ?? UNKNOWN_TIER_RANK;
    if (typeA !== typeB) return typeA - typeB;

    const scoreA = banditScoreByProvider.get((a.provider || '').toLowerCase()) ?? 0;
    const scoreB = banditScoreByProvider.get((b.provider || '').toLowerCase()) ?? 0;
    if (scoreA !== scoreB) return scoreB - scoreA;

    const priA = (a.metadata?.sourcePriority as number | undefined) ?? DEFAULT_SOURCE_PRIORITY;
    const priB = (b.metadata?.sourcePriority as number | undefined) ?? DEFAULT_SOURCE_PRIORITY;
    return priA - priB;
  });
}

/** Minimal hub shape needed to rank routes by operability/hotness. */
export interface OperabilityHubLike {
  getRouteState(executionProvider: string, modelId: string): { operabilityState: string };
  isRouteHot(executionProvider: string, modelId: string): boolean;
}

/**
 * Build the `operabilityRankByProvider` map for rankRetryCandidates from the
 * operability hub, for ONE modelId across its candidate providers. Convention:
 *   3 = hot (proven serving NOW) · 2 = operable · 1 = unknown · 0 = proven-bad
 *       (auth_failed / no_credits / rate_limited / temporarily_unavailable).
 * This is the single place every retry path computes "which variant to prefer",
 * so phala(401)/aihubmix(403) sink and warm routes rise — deterministically.
 */
export function computeOperabilityRanks(
  candidates: ReadonlyArray<RankableCandidate>,
  modelId: string,
  hub: OperabilityHubLike,
): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const c of candidates) {
    const p = (c.provider || '').toLowerCase();
    if (!p || ranks.has(p)) continue;
    const st = hub.getRouteState(p, modelId).operabilityState;
    let rank: number;
    if (
      st === 'auth_failed' ||
      st === 'no_credits' ||
      st === 'rate_limited' ||
      st === 'temporarily_unavailable'
    ) {
      rank = 0;
    } else if (hub.isRouteHot(p, modelId)) {
      rank = 3;
    } else if (st === 'healthy' || st === 'recovering' || st === 'degraded') {
      rank = 2;
    } else {
      rank = 1; // unknown
    }
    ranks.set(p, rank);
  }
  return ranks;
}
