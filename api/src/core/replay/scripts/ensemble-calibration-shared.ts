// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-calibration-shared.ts — MVP 8B.7
 *
 * Helper functions shared by the two ensemble-calibration scripts.
 * Pure. No I/O.
 */

import type { HistoricalContributionResult } from '../../contribution/historical-contribution-scorer';
import type { ModelTaskPerformanceProfile } from '../../contribution/model-task-performance-profile';
import { pairKey } from '../../contribution/pair-contribution-profile';
import type { PairContributionProfile } from '../../contribution/pair-contribution-profile';
import type { EnsembleCalibrationExample } from '../../pareto/calibration/ensemble-calibration-types';
import type { HistoricalReplayExecution } from '../historical-replay-types';

/**
 * Builds calibration examples from TRAIN ensemble executions only.
 */
export function buildCalibrationExamplesFromTrain(
  train: readonly HistoricalReplayExecution[],
  trainHistory: HistoricalContributionResult,
): readonly EnsembleCalibrationExample[] {
  const profileIdx = new Map<string, ModelTaskPerformanceProfile>();
  for (const p of trainHistory.modelProfiles) {
    profileIdx.set(`${p.modelId}||${p.taskType}`, p);
  }
  const pairIdx = new Map<string, PairContributionProfile>();
  for (const p of trainHistory.pairProfiles) {
    pairIdx.set(`${pairKey(p.modelA, p.modelB)}||${p.taskType}`, p);
  }
  const singleBaselinesByTask = computeSingleBaselinesByTask(train);

  const out: EnsembleCalibrationExample[] = [];
  for (const ex of train) {
    if (ex.modelsUsed.length < 2) continue;
    if (typeof ex.judgeScore !== 'number') continue;
    const memberProfiles: EnsembleCalibrationExample['modelProfileJudges'][number][] = [];
    for (const m of ex.modelsUsed) {
      const p = profileIdx.get(`${m}||${ex.taskType}`);
      if (p) {
        memberProfiles.push({
          modelId: m,
          judgeMean: p.judgeMean,
          judgeMedian: p.judgeMedian,
          judgeP80: p.judgeP80,
          judgeStdDev: p.judgeStdDev,
          contributionScore: p.contributionScore,
          harmScore: p.harmScore,
        });
      } else {
        memberProfiles.push({
          modelId: m,
          judgeMean: 0,
          judgeMedian: 0,
          judgeP80: 0,
        });
      }
    }
    let pairProfile: EnsembleCalibrationExample['pairProfile'];
    if (ex.modelsUsed.length === 2) {
      const key = `${pairKey(ex.modelsUsed[0], ex.modelsUsed[1])}||${ex.taskType}`;
      const p = pairIdx.get(key);
      if (p) {
        pairProfile = {
          modelA: p.modelA,
          modelB: p.modelB,
          judgeMean: p.judgeMean,
          costMean: p.costMean,
          paretoWinRate: p.paretoWinRate,
          complementarityScore: p.complementarityScore,
          riskScore: p.riskScore,
        };
      }
    }
    const baseline = singleBaselinesByTask.get(ex.taskType);
    out.push({
      executionId: ex.executionId,
      experimentId: ex.experimentId,
      taskId: ex.taskId,
      taskType: ex.taskType,
      strategyId: ex.strategyId,
      effectiveStrategyId: ex.effectiveStrategyId ?? ex.strategyId,
      selectedModelIds: ex.modelsUsed,
      selectedRouteIds: ex.providerRoutes,
      observedJudge: ex.judgeScore,
      observedCostUsd: typeof ex.costUsd === 'number' ? ex.costUsd : 0,
      singleBaselineJudge: baseline?.judgeMean ?? 0.5,
      singleBaselineCostUsd: baseline?.costMean ?? 0.02,
      modelProfileJudges: memberProfiles,
      pairProfile,
      metadata: {
        complexity: ex.complexity,
        modality: ex.modality,
      },
    });
  }
  return Object.freeze(out);
}

// ─── Baseline computation ───────────────────────────────────────────────

interface BaselineSlot {
  readonly judgeMean: number;
  readonly costMean: number;
}

function computeSingleBaselinesByTask(
  train: readonly HistoricalReplayExecution[],
): Map<string, BaselineSlot> {
  const buckets = new Map<string, { judges: number[]; costs: number[] }>();
  for (const t of train) {
    if (t.strategyId !== 'single') continue;
    if (typeof t.judgeScore !== 'number') continue;
    let b = buckets.get(t.taskType);
    if (!b) {
      b = { judges: [], costs: [] };
      buckets.set(t.taskType, b);
    }
    b.judges.push(t.judgeScore);
    if (typeof t.costUsd === 'number') b.costs.push(t.costUsd);
  }
  const out = new Map<string, BaselineSlot>();
  for (const [k, v] of buckets) {
    if (v.judges.length === 0) continue;
    out.set(k, {
      judgeMean: avg(v.judges),
      costMean: avg(v.costs),
    });
  }
  return out;
}

function avg(arr: readonly number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}
