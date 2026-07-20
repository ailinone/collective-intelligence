// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-split.ts — MVP 8B.5
 *
 * Splits a flat list of historical executions into train/holdout without
 * leakage. Preference: split by experimentId; fallback: split temporal.
 *
 * Pure. Deterministic. Sorts experiment ids alphabetically and uses a
 * stable partitioning so two runs with the same input produce the same
 * split.
 */

import type {
  HistoricalReplayExecution,
  HistoricalReplaySplit,
  SplitStrategy,
} from './historical-replay-types';

export interface SplitOptions {
  /** Fraction of experiments to use for HOLDOUT. Default 0.30. */
  readonly holdoutFraction?: number;
  /** Force a specific split strategy. */
  readonly strategy?: SplitStrategy;
  /** Minimum executions per side. Default 20. */
  readonly minPerSide?: number;
}

export function splitTrainHoldout(
  executions: readonly HistoricalReplayExecution[],
  options: SplitOptions = {},
): HistoricalReplaySplit {
  const holdoutFraction = clamp01(options.holdoutFraction ?? 0.3);
  const minPerSide = Math.max(0, options.minPerSide ?? 20);
  const strategy: SplitStrategy = options.strategy ?? 'by_experiment_id';
  if (strategy === 'by_experiment_id') {
    return splitByExperimentId(executions, holdoutFraction, minPerSide);
  }
  return splitByTime(executions, holdoutFraction, minPerSide);
}

// ─── By experiment id ───────────────────────────────────────────────────

function splitByExperimentId(
  executions: readonly HistoricalReplayExecution[],
  holdoutFraction: number,
  minPerSide: number,
): HistoricalReplaySplit {
  const allExperiments = [...new Set(executions.map((e) => e.experimentId))].sort();
  const holdoutCount = Math.max(1, Math.round(allExperiments.length * holdoutFraction));
  // Take the LAST experiments alphabetically as holdout — gives a
  // deterministic, reviewable selection.
  const holdoutIds = new Set(allExperiments.slice(allExperiments.length - holdoutCount));
  const trainIds: string[] = [];
  for (const id of allExperiments) if (!holdoutIds.has(id)) trainIds.push(id);

  const train: HistoricalReplayExecution[] = [];
  const holdout: HistoricalReplayExecution[] = [];
  for (const ex of executions) {
    if (holdoutIds.has(ex.experimentId)) holdout.push(ex);
    else train.push(ex);
  }

  const leakageWarnings = checkLeakage(train, holdout, 'by_experiment_id');
  if (train.length < minPerSide) {
    leakageWarnings.push(`train_below_min:${train.length}<${minPerSide}`);
  }
  if (holdout.length < minPerSide) {
    leakageWarnings.push(`holdout_below_min:${holdout.length}<${minPerSide}`);
  }

  return Object.freeze({
    train: Object.freeze(train),
    holdout: Object.freeze(holdout),
    splitStrategy: 'by_experiment_id',
    trainExperimentIds: Object.freeze(trainIds),
    holdoutExperimentIds: Object.freeze([...holdoutIds].sort()),
    leakageWarnings: Object.freeze(leakageWarnings),
  });
}

// ─── By time ────────────────────────────────────────────────────────────

function splitByTime(
  executions: readonly HistoricalReplayExecution[],
  holdoutFraction: number,
  minPerSide: number,
): HistoricalReplaySplit {
  // Sort by createdAt; first (1 - holdoutFraction) goes to train.
  const sortable = [...executions].sort((a, b) => {
    const aa = a.createdAt ?? '';
    const bb = b.createdAt ?? '';
    if (aa !== bb) return aa < bb ? -1 : 1;
    return a.executionId < b.executionId ? -1 : a.executionId > b.executionId ? 1 : 0;
  });
  const cutoff = Math.floor(sortable.length * (1 - holdoutFraction));
  const train = sortable.slice(0, cutoff);
  const holdout = sortable.slice(cutoff);

  const trainExperimentIds = [...new Set(train.map((e) => e.experimentId))].sort();
  const holdoutExperimentIds = [...new Set(holdout.map((e) => e.experimentId))].sort();

  const leakageWarnings = checkLeakage(train, holdout, 'by_time');
  if (train.length < minPerSide) {
    leakageWarnings.push(`train_below_min:${train.length}<${minPerSide}`);
  }
  if (holdout.length < minPerSide) {
    leakageWarnings.push(`holdout_below_min:${holdout.length}<${minPerSide}`);
  }

  return Object.freeze({
    train: Object.freeze(train),
    holdout: Object.freeze(holdout),
    splitStrategy: 'by_time',
    trainExperimentIds: Object.freeze(trainExperimentIds),
    holdoutExperimentIds: Object.freeze(holdoutExperimentIds),
    leakageWarnings: Object.freeze(leakageWarnings),
  });
}

// ─── Leakage detection ──────────────────────────────────────────────────

function checkLeakage(
  train: readonly HistoricalReplayExecution[],
  holdout: readonly HistoricalReplayExecution[],
  strategy: SplitStrategy,
): string[] {
  const warnings: string[] = [];
  const trainExpIds = new Set(train.map((e) => e.experimentId));
  for (const h of holdout) {
    if (trainExpIds.has(h.experimentId)) {
      warnings.push(`experiment_id_in_both:${h.experimentId}`);
    }
  }
  // taskId leakage only meaningful for by_experiment_id strategy
  // (by_time can legitimately share a "synthetic" taskId across days).
  if (strategy === 'by_experiment_id') {
    const trainTaskIds = new Set(train.map((e) => e.taskId));
    for (const h of holdout) {
      if (trainTaskIds.has(h.taskId)) {
        warnings.push(`task_id_in_both:${h.taskId}`);
        break; // one warning is enough — we don't need the full list
      }
    }
  }
  // Dedupe warnings.
  return [...new Set(warnings)];
}

// ─── Helpers ────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
