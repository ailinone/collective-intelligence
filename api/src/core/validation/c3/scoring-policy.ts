// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Scoring Policy — Class 3 Validation Infrastructure
 *
 * Defines the scoring policy that determines which evaluation method is used
 * for different purposes. This is the core fix for P0.4: the heuristic scorer
 * must never be the sole signal feeding the learning loop.
 *
 * Three policies:
 * - 'observability': Heuristic only (fast, no API cost). For dashboards/triaging.
 * - 'learning': LLM-Judge mandatory. Feeds bandit, archive, Pareto, feedback loop.
 * - 'benchmark': LLM-Judge mandatory + rubric. For controlled experiments.
 */

/** Determines which evaluation method is used */
export type ScoringPolicy = 'observability' | 'learning' | 'benchmark';

/** Result from a policy-aware scoring call */
export interface PolicyAwareScore {
  /** The quality score used downstream (0-1) */
  overall: number;
  /** Per-dimension scores */
  dimensions: {
    correctness: number;
    completeness: number;
    clarity: number;
    efficiency: number;
    relevance: number;
  };
  /** Confidence in this score (0-1) */
  confidence: number;
  /** Human-readable reasoning */
  reasoning: string[];
  /** Which method produced this score */
  method: 'heuristic' | 'llm-judge' | 'hybrid';
  /** Which policy was applied */
  policy: ScoringPolicy;
  /** If LLM-Judge was attempted but failed, this is true */
  judgeFailed?: boolean;
  /** Heuristic score (always computed, for divergence monitoring) */
  heuristicScore?: number;
  /** LLM-Judge score (when available, for divergence monitoring) */
  judgeScore?: number;
}

/**
 * Check whether a score is valid for feeding learning systems.
 * A score is valid for learning only if:
 * 1. It was produced under 'learning' or 'benchmark' policy
 * 2. The LLM-Judge did not fail (judgeFailed !== true)
 * 3. Confidence is above minimum threshold
 */
export function isValidForLearning(score: PolicyAwareScore): boolean {
  if (score.policy === 'observability') return false;
  if (score.judgeFailed) return false;
  if (score.confidence < 0.3) return false;
  return true;
}

/**
 * Check whether a score should trigger reward hacking alarm.
 * Divergence between heuristic and judge above threshold signals
 * that the heuristic may be rewarding formatting over substance.
 */
export function checkRewardHackingDivergence(
  score: PolicyAwareScore,
  divergenceThreshold = 0.25
): { divergent: boolean; delta: number } {
  if (score.heuristicScore == null || score.judgeScore == null) {
    return { divergent: false, delta: 0 };
  }
  const delta = Math.abs(score.heuristicScore - score.judgeScore);
  return { divergent: delta > divergenceThreshold, delta };
}
