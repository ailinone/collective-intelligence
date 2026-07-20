// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * peer-lift-calibrator.ts — MVP 8B.7
 *
 * Learns the empirical "peer lift" — how much an ensemble's observed
 * judge exceeds the best individual member's `judgeMean` — from train
 * ensemble examples only. Separates per task type and per strategy,
 * applies empirical-Bayes shrinkage when sample size is small.
 *
 * Pure. Deterministic. No I/O. Never reads holdout data.
 */

import type { EnsembleCalibrationExample } from './ensemble-calibration-types';

// ─── Public types ───────────────────────────────────────────────────────

export interface PeerLiftCalibrationInput {
  readonly trainExamples: readonly EnsembleCalibrationExample[];
  /** Minimum samples per cell before its lift is trusted. Default 8. */
  readonly minSamples?: number;
  /** Shrinkage strength: smaller cells shrink harder toward global. Default 8. */
  readonly shrinkageK?: number;
}

export interface PeerLiftCalibrationResult {
  /** Mean lift across all ensemble examples in train. */
  readonly globalPeerLift: number;
  readonly peerLiftByTaskType: Readonly<Record<string, number>>;
  readonly peerLiftByStrategy: Readonly<Record<string, number>>;
  /** Shrinkage-applied confidence in [0..1] per task type. */
  readonly confidenceByTaskType: Readonly<Record<string, number>>;
  readonly sampleCountByTaskType: Readonly<Record<string, number>>;
  readonly reasons: readonly string[];
}

// ─── Calibrator ─────────────────────────────────────────────────────────

export function calibratePeerLift(
  input: PeerLiftCalibrationInput,
): PeerLiftCalibrationResult {
  const minSamples = input.minSamples ?? 8;
  const shrinkageK = input.shrinkageK ?? 8;
  const ensembleExamples = input.trainExamples.filter(
    (e) => e.selectedModelIds.length >= 2 && Number.isFinite(e.observedJudge),
  );

  const reasons: string[] = [];

  // 1. Compute lift = observed - max(member.judgeMean) per example.
  const liftsByTask: Record<string, number[]> = {};
  const liftsByStrategy: Record<string, number[]> = {};
  const allLifts: number[] = [];

  for (const ex of ensembleExamples) {
    if (ex.modelProfileJudges.length === 0) continue;
    let bestMemberJudge = 0;
    for (const m of ex.modelProfileJudges) {
      if (m.judgeMean > bestMemberJudge) bestMemberJudge = m.judgeMean;
    }
    const lift = ex.observedJudge - bestMemberJudge;
    allLifts.push(lift);
    pushBucket(liftsByTask, ex.taskType, lift);
    const strat = ex.effectiveStrategyId || ex.strategyId || 'unknown';
    pushBucket(liftsByStrategy, strat, lift);
  }

  // 2. Global mean.
  const globalPeerLift = mean(allLifts);
  reasons.push(`global_peer_lift=${globalPeerLift.toFixed(4)}`);
  reasons.push(`ensemble_examples=${ensembleExamples.length}`);

  // 3. Shrinkage-applied per task type / strategy.
  const peerLiftByTaskType: Record<string, number> = {};
  const confidenceByTaskType: Record<string, number> = {};
  const sampleCountByTaskType: Record<string, number> = {};
  for (const [k, arr] of Object.entries(liftsByTask)) {
    const n = arr.length;
    const localMean = mean(arr);
    const w = n / (n + shrinkageK);
    const shrunk = w * localMean + (1 - w) * globalPeerLift;
    peerLiftByTaskType[k] = shrunk;
    confidenceByTaskType[k] = Math.min(1, n / minSamples);
    sampleCountByTaskType[k] = n;
  }
  const peerLiftByStrategy: Record<string, number> = {};
  for (const [k, arr] of Object.entries(liftsByStrategy)) {
    const n = arr.length;
    const localMean = mean(arr);
    const w = n / (n + shrinkageK);
    peerLiftByStrategy[k] = w * localMean + (1 - w) * globalPeerLift;
  }

  return Object.freeze({
    globalPeerLift,
    peerLiftByTaskType: Object.freeze(peerLiftByTaskType),
    peerLiftByStrategy: Object.freeze(peerLiftByStrategy),
    confidenceByTaskType: Object.freeze(confidenceByTaskType),
    sampleCountByTaskType: Object.freeze(sampleCountByTaskType),
    reasons: Object.freeze(reasons),
  });
}

/**
 * Returns the peer-lift to apply for a given (taskType, strategyId) pair.
 * Falls back to global mean when both are absent.
 */
export function lookupPeerLift(
  calibration: PeerLiftCalibrationResult,
  taskType: string,
  strategyId?: string,
): number {
  const byTask = calibration.peerLiftByTaskType[taskType];
  if (typeof byTask === 'number') return byTask;
  if (strategyId) {
    const byStrat = calibration.peerLiftByStrategy[strategyId];
    if (typeof byStrat === 'number') return byStrat;
  }
  return calibration.globalPeerLift;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function pushBucket(buckets: Record<string, number[]>, key: string, value: number): void {
  let arr = buckets[key];
  if (!arr) {
    arr = [];
    buckets[key] = arr;
  }
  arr.push(value);
}

function mean(arr: readonly number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}
