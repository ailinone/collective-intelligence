// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * contribution-aware-candidate-scorer.ts — MVP 8A
 *
 * Adjusts a candidate's structural score by overlaying historical
 * contribution data. Returns a `ContributionAwareScore` with a decomposed
 * breakdown so callers (and traces) can audit every signal.
 *
 * Pure. No I/O. No randomness. No clock. Never reads or writes external
 * state. Operates on:
 *   - the candidate metadata (`routeId`, `modelId`, `taskType`, `modality`,
 *     `routeKind`, `estimatedCostUsd`, `structuralScore`)
 *   - the optional `historicalProfile` for the (modelId, taskType) cell
 *
 * Never branches on a model or provider NAME — the only places that
 * model id is read are: as a Map/dictionary key, as a tie-breaker, and
 * as an opaque identifier in trace/explanation strings.
 */

import { buildCandidateExplanation } from './contribution-explanation';
import type {
  ModelRole,
  ModelTaskPerformanceProfile,
} from './model-task-performance-profile';

export type CandidateModality = 'text' | 'image' | 'audio' | 'video' | 'mixed';

// ─── Input ──────────────────────────────────────────────────────────────

export interface ContributionAwareCandidate {
  readonly routeId: string;
  readonly modelId: string;
  readonly canonicalModelId?: string;
  readonly taskType: string;
  readonly taskModality: CandidateModality;
  readonly capabilities: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly modality: CandidateModality;
  readonly routeKind: string;
  readonly estimatedCostUsd: number;
  readonly structuralScore: number;
  readonly historicalProfile?: ModelTaskPerformanceProfile;
}

// ─── Output ─────────────────────────────────────────────────────────────

export interface ContributionAwareBreakdown {
  readonly structuralScore: number;
  readonly contributionScore: number;
  readonly qualityPerDollarScore: number;
  readonly taskTypeFit: number;
  readonly modalityFit: number;
  readonly harmPenalty: number;
  readonly costPenalty: number;
  readonly confidencePenalty: number;
}

export interface ContributionAwareScore {
  readonly routeId: string;
  readonly modelId: string;
  readonly totalScore: number;
  readonly breakdown: ContributionAwareBreakdown;
  readonly recommendedRole: ModelRole;
  readonly rejected: boolean;
  readonly rejectionReasons: readonly string[];
  readonly explanation: string;
  readonly estimatedCostUsd: number;
  readonly expectedJudge: number;
}

// ─── Policy ─────────────────────────────────────────────────────────────

export interface ContributionAwarePolicy {
  /** Maximum allowed harm rate before automatic rejection. */
  readonly maxHarmRate: number;
  /** Maximum allowed harmScore before automatic rejection. */
  readonly maxHarmScore: number;
  /** Cost above this gets penalised heavily. */
  readonly hardCostCeilingUsd: number;
  /** When true, modality mismatch is a hard reject. */
  readonly modalityStrict: boolean;
  /** Allow `insufficient_data` candidates as exploration. */
  readonly allowExploration: boolean;
}

export const DEFAULT_CONTRIBUTION_AWARE_POLICY: ContributionAwarePolicy = Object.freeze({
  maxHarmRate: 0.4,
  maxHarmScore: 0.4,
  hardCostCeilingUsd: 0.5,
  modalityStrict: true,
  allowExploration: false,
});

// ─── Main scorer ────────────────────────────────────────────────────────

export function scoreContributionAwareCandidate(
  candidate: ContributionAwareCandidate,
  policy: ContributionAwarePolicy = DEFAULT_CONTRIBUTION_AWARE_POLICY,
): ContributionAwareScore {
  const rejections: string[] = [];

  // ─── Modality fit (hard reject when policy is strict) ────────────────
  const modalityFit = computeModalityFit(candidate);
  if (modalityFit === 0 && policy.modalityStrict) {
    rejections.push('modality_mismatch');
  }

  // ─── Capability fit ──────────────────────────────────────────────────
  const capabilityOk = checkCapabilities(candidate);
  if (!capabilityOk) {
    rejections.push('capability_mismatch');
  }

  // ─── Profile signals ─────────────────────────────────────────────────
  const profile = candidate.historicalProfile;
  const contributionScore = profile?.contributionScore ?? 0.3; // prior
  const taskTypeFit = profile && profile.taskType === candidate.taskType ? 1 : 0.5;
  const harmRate = profile?.harmRate ?? 0;
  const harmScore = profile?.harmScore ?? 0;
  const confidence = profile?.confidence ?? 0;
  const qualityPerDollar = profile?.qualityPerDollar ?? 0;
  const judgeMean = profile?.judgeMean ?? 0;

  if (profile && profile.recommendedRole === 'avoid') {
    rejections.push('historical_harm');
  }
  if (harmRate > policy.maxHarmRate) rejections.push('harm_rate_exceeded');
  if (harmScore > policy.maxHarmScore) rejections.push('harm_score_exceeded');
  if (candidate.estimatedCostUsd > policy.hardCostCeilingUsd) {
    rejections.push('cost_above_hard_ceiling');
  }
  // Treat absent profile as insufficient_data (no historical signal),
  // honouring policy.allowExploration the same way as an explicit
  // insufficient_data profile.
  const isInsufficient =
    !profile || profile.recommendedRole === 'insufficient_data';
  if (isInsufficient && !policy.allowExploration) {
    rejections.push('insufficient_data');
  }

  // ─── Breakdown ───────────────────────────────────────────────────────
  // qualityPerDollarScore is a normalised [0..1] projection — pure logistic-ish.
  const qpdScore = qualityPerDollar > 0
    ? Math.min(1, qualityPerDollar / 1_000)
    : 0;
  // Harm penalty grows linearly with harmRate and harmScore.
  const harmPenalty = -(0.6 * harmRate + 0.4 * harmScore);
  // Cost penalty grows as cost approaches the hard ceiling.
  const costPenalty =
    candidate.estimatedCostUsd <= 0
      ? 0
      : -Math.min(1, candidate.estimatedCostUsd / policy.hardCostCeilingUsd) * 0.3;
  const confidencePenalty = -((1 - confidence) * 0.1);

  const breakdown: ContributionAwareBreakdown = Object.freeze({
    structuralScore: candidate.structuralScore,
    contributionScore,
    qualityPerDollarScore: qpdScore,
    taskTypeFit,
    modalityFit,
    harmPenalty,
    costPenalty,
    confidencePenalty,
  });

  const total = composeTotal(breakdown);
  const rejected = rejections.length > 0;
  const recommendedRole: ModelRole =
    profile?.recommendedRole ?? 'insufficient_data';

  const explanation = buildCandidateExplanation({
    modelId: candidate.modelId,
    recommendedRole,
    contributionScore,
    harmScore,
    modalityFit,
    costPenalty,
    confidence,
    rejected,
    rejectionReasons: rejections,
  });

  return Object.freeze({
    routeId: candidate.routeId,
    modelId: candidate.modelId,
    totalScore: rejected ? 0 : total,
    breakdown,
    recommendedRole,
    rejected,
    rejectionReasons: Object.freeze(rejections),
    explanation,
    estimatedCostUsd: candidate.estimatedCostUsd,
    expectedJudge: judgeMean,
  });
}

// ─── Internals ──────────────────────────────────────────────────────────

function computeModalityFit(c: ContributionAwareCandidate): number {
  if (c.modality === 'mixed' || c.taskModality === 'mixed') return 1;
  return c.modality === c.taskModality ? 1 : 0;
}

function checkCapabilities(c: ContributionAwareCandidate): boolean {
  if (!c.requiredCapabilities || c.requiredCapabilities.length === 0) return true;
  const have = new Set(c.capabilities);
  for (const req of c.requiredCapabilities) if (!have.has(req)) return false;
  return true;
}

function composeTotal(b: ContributionAwareBreakdown): number {
  const positive =
    0.25 * b.structuralScore +
    0.4 * b.contributionScore +
    0.15 * b.qualityPerDollarScore +
    0.1 * b.taskTypeFit +
    0.1 * b.modalityFit;
  const negative = b.harmPenalty + b.costPenalty + b.confidencePenalty;
  return Math.max(0, Math.min(1, positive + negative));
}
