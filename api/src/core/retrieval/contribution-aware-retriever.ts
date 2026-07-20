// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * contribution-aware-retriever.ts — MVP 8B
 *
 * Re-scores already-retrieved structural candidates with contribution
 * awareness. Does NOT search the registry for new candidates. Does NOT
 * call providers, DB, Redis, TEI or HNSW.
 *
 * Inputs:
 *   - `structuralCandidates`: the output of the MVP 5A
 *     `retrieveCandidates` (i.e. `ModelScoreResult[]`)
 *   - `taskProfile`: the categorical profile from MVP 6A
 *   - `historicalContributionResult`: aggregated stats from MVP 8A
 *   - `registry`: used ONLY to enrich each candidate with structural
 *     metadata (routeKind, capabilities, modality, estimated cost)
 *
 * Output:
 *   - `contributionScores`: every input candidate, scored (accepted OR
 *     rejected). Order preserved from the input.
 *   - `rejectedByContribution`: compact list of rejections for tracing.
 *
 * Invariants:
 *   - Pure. No I/O. No mutation of structuralCandidates.
 *   - Deterministic. No clock, no randomness.
 *   - Honors `explicit pin` by passing it through unchanged in scoring.
 *   - Honors `local_required` by applying modalityStrict from policy.
 *   - Never branches on a model/provider NAME — uses only structural
 *     fields and historical profile lookups by id.
 */

import type { ProviderModelRoute } from '../registry/model-route';
import type { RuntimeModelRegistry } from '../registry/runtime-model-registry';
import {
  DEFAULT_CONTRIBUTION_AWARE_POLICY,
  scoreContributionAwareCandidate,
  type CandidateModality,
  type ContributionAwareCandidate,
  type ContributionAwarePolicy,
  type ContributionAwareScore,
} from '../contribution/contribution-aware-candidate-scorer';
import type { HistoricalContributionResult } from '../contribution/historical-contribution-scorer';
import type { ModelTaskPerformanceProfile } from '../contribution/model-task-performance-profile';
import {
  resolveCollectiveSelectionPolicy,
  type CollectiveSelectionPolicy,
} from '../pareto/collective-selection-policy';
import type { ModelScoreResult } from '../scoring/model-scorer';
import type { TaskProfile } from '../task-profile/task-profile-types';

// ─── Public types ───────────────────────────────────────────────────────

export interface ContributionAwareRetrieverInput {
  readonly structuralCandidates: readonly ModelScoreResult[];
  readonly taskProfile: TaskProfile;
  readonly historicalContributionResult: HistoricalContributionResult;
  readonly policy?: Partial<CollectiveSelectionPolicy>;
}

export interface ContributionAwareRetrieverDeps {
  readonly registry: RuntimeModelRegistry;
}

export interface ContributionAwareRejectionRecord {
  readonly routeId: string;
  readonly modelId: string;
  readonly reason: string;
}

export interface ContributionAwareRetrieverResult {
  readonly contributionScores: readonly ContributionAwareScore[];
  readonly rejectedByContribution: readonly ContributionAwareRejectionRecord[];
}

// ─── Main entry ─────────────────────────────────────────────────────────

export function rescoreCandidates(
  input: ContributionAwareRetrieverInput,
  deps: ContributionAwareRetrieverDeps,
): ContributionAwareRetrieverResult {
  const policy = resolveCollectiveSelectionPolicy(input.policy);
  const contributionPolicy: ContributionAwarePolicy = Object.freeze({
    ...DEFAULT_CONTRIBUTION_AWARE_POLICY,
    maxHarmRate: policy.maxHarmRate,
    modalityStrict: policy.modalityStrict,
    allowExploration: policy.allowExplorationCandidates,
  });

  // Build a fast (modelId, taskType) lookup over the historical profiles.
  const profileIndex = buildProfileIndex(input.historicalContributionResult);

  const taskModality: CandidateModality = pickTaskModality(input.taskProfile);

  const scores: ContributionAwareScore[] = [];
  const rejected: ContributionAwareRejectionRecord[] = [];

  for (const candidate of input.structuralCandidates) {
    // The structural retriever may already have flagged a candidate as
    // rejected (e.g. it doesn't meet the readiness or capability filter).
    // We keep them but record the rejection.
    const route = deps.registry.lookupRoute(candidate.routeId);
    if (!route) {
      // Defensive: shouldn't happen because the structural scorer just
      // touched this route — but tolerate it.
      rejected.push({
        routeId: candidate.routeId,
        modelId: candidate.canonicalModelId,
        reason: 'route_not_in_registry',
      });
      continue;
    }

    const modelId = route.providerModelId || candidate.canonicalModelId;
    const profile = lookupProfile(profileIndex, modelId, candidate.canonicalModelId, input.taskProfile.taskType);
    const enriched: ContributionAwareCandidate = {
      routeId: candidate.routeId,
      modelId,
      canonicalModelId: candidate.canonicalModelId,
      taskType: input.taskProfile.taskType,
      taskModality,
      capabilities: deriveCapabilities(route),
      requiredCapabilities: Array.from(input.taskProfile.requiredCapabilities),
      modality: deriveModality(route, taskModality),
      routeKind: route.routeKind,
      estimatedCostUsd: estimateCostUsd(route, input.taskProfile),
      structuralScore: candidate.totalScore,
      historicalProfile: profile,
    };

    // If the structural retriever already rejected this candidate,
    // record a rejection here too — but still produce a score record
    // so downstream sees the full set.
    if (candidate.rejected) {
      const reasonText = candidate.rejectionReasons.length
        ? candidate.rejectionReasons.join(',')
        : 'structural_reject';
      const skipScore: ContributionAwareScore = Object.freeze({
        routeId: candidate.routeId,
        modelId,
        totalScore: 0,
        breakdown: Object.freeze({
          structuralScore: candidate.totalScore,
          contributionScore: profile?.contributionScore ?? 0,
          qualityPerDollarScore: 0,
          taskTypeFit: 0,
          modalityFit: 0,
          harmPenalty: 0,
          costPenalty: 0,
          confidencePenalty: 0,
        }),
        recommendedRole: profile?.recommendedRole ?? 'insufficient_data',
        rejected: true,
        rejectionReasons: Object.freeze([reasonText]),
        explanation: `rejected:structural;reason=${reasonText}`,
        estimatedCostUsd: enriched.estimatedCostUsd,
        expectedJudge: profile?.judgeMean ?? 0,
      });
      scores.push(skipScore);
      rejected.push({ routeId: candidate.routeId, modelId, reason: reasonText });
      continue;
    }

    const score = scoreContributionAwareCandidate(enriched, contributionPolicy);
    scores.push(score);
    if (score.rejected) {
      const reasonText = score.rejectionReasons.length
        ? score.rejectionReasons.join(',')
        : 'contribution_reject';
      rejected.push({ routeId: candidate.routeId, modelId, reason: reasonText });
    }
  }

  return Object.freeze({
    contributionScores: Object.freeze(scores),
    rejectedByContribution: Object.freeze(rejected),
  });
}

// ─── Profile index ──────────────────────────────────────────────────────

interface ProfileIndex {
  readonly byModel: ReadonlyMap<string, ModelTaskPerformanceProfile>;
}

function buildProfileIndex(
  history: HistoricalContributionResult,
): ProfileIndex {
  const byModel = new Map<string, ModelTaskPerformanceProfile>();
  for (const p of history.modelProfiles) {
    byModel.set(`${p.modelId}||${p.taskType}`, p);
  }
  return { byModel };
}

function lookupProfile(
  idx: ProfileIndex,
  primaryId: string,
  fallbackId: string,
  taskType: string,
): ModelTaskPerformanceProfile | undefined {
  const primary = idx.byModel.get(`${primaryId}||${taskType}`);
  if (primary) return primary;
  if (fallbackId !== primaryId) {
    const alt = idx.byModel.get(`${fallbackId}||${taskType}`);
    if (alt) return alt;
  }
  return undefined;
}

// ─── Helpers — derived from registry record, not from names ─────────────

function deriveCapabilities(route: ProviderModelRoute): readonly string[] {
  const out: string[] = [];
  if (route.supportsStreaming) out.push('streaming');
  if (route.supportsJson) out.push('json_mode');
  if (route.supportsTools) out.push('tools');
  if (route.supportsVision) out.push('vision');
  if (route.supportsImages) out.push('image_generation');
  if (route.supportsAudio) out.push('audio_generation');
  // chat is implied by ANY chat-eligible route.
  out.push('chat');
  return Object.freeze(out);
}

function deriveModality(
  route: ProviderModelRoute,
  taskModality: CandidateModality,
): CandidateModality {
  // A model with vision/images is image-capable; audio is audio-capable.
  // When the task is text and the model is purely image/audio, we want
  // to flag a mismatch. So:
  if (route.supportsVision && !route.supportsTools && !route.supportsJson && !route.supportsStreaming) {
    return 'image';
  }
  if (route.supportsImages && !route.supportsTools && !route.supportsJson) {
    return 'image';
  }
  if (route.supportsAudio && !route.supportsTools && !route.supportsJson && !route.supportsStreaming) {
    return 'audio';
  }
  // A multimodal route (e.g. text + vision) still serves text tasks
  // perfectly — modality match.
  return taskModality;
}

function pickTaskModality(profile: TaskProfile): CandidateModality {
  const ms = profile.modalities;
  if (ms.indexOf('image') !== -1) return 'image';
  if (ms.indexOf('audio') !== -1) return 'audio';
  if (ms.indexOf('video') !== -1) return 'video';
  return 'text';
}

/**
 * Coarse cost estimator based on (inputTokens + outputTokens) and the
 * route's per-1M pricing. Used ONLY for ranking — the real cost is
 * settled by the orchestrator at execution time.
 */
function estimateCostUsd(
  route: ProviderModelRoute,
  profile: TaskProfile,
): number {
  const inputTokens = Math.max(0, profile.contextRequirementTokens ?? 1_000);
  // Heuristic: output is ~25% of input or 500 tokens, whichever is bigger.
  const outputTokens = Math.max(500, Math.floor(inputTokens * 0.25));
  const inputCost = (inputTokens * route.inputCostPer1M) / 1_000_000;
  const outputCost = (outputTokens * route.outputCostPer1M) / 1_000_000;
  return inputCost + outputCost;
}
