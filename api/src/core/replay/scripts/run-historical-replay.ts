// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * run-historical-replay.ts — MVP 8B.5
 *
 * Reads the exported JSONL artefact, splits train/holdout, trains the
 * contribution scorer on TRAIN ONLY, runs the Pareto-aware backtest
 * on HOLDOUT, and writes the final report to a JSON file.
 *
 * Outputs:
 *   api/src/core/replay/artifacts/c3-replay-report.json
 *
 * Inputs (already produced by export-c3-history-readonly.ts):
 *   api/src/core/replay/artifacts/c3-history-export.jsonl
 *   api/src/core/replay/artifacts/c3-history-export.metadata.json
 *
 * This script does NOT touch the DB. It does NOT call any provider.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scoreHistoricalContribution } from '../../contribution/historical-contribution-scorer';
import { readJsonlFile } from '../historical-replay-loader';
import {
  computeMetricsByTaskType,
  computeReplayMetrics,
} from '../historical-replay-metrics';
import { buildReplayReport } from '../historical-replay-report';
import { runHistoricalReplay } from '../historical-replay-runner';
import { splitTrainHoldout } from '../historical-replay-split';
import type { HistoricalExecution } from '../../contribution/historical-execution-types';
import type {
  HistoricalReplayExecution,
  ReplayExportMetadata,
} from '../historical-replay-types';


const ARTIFACTS_DIR = resolve(__dirname, '..', 'artifacts');
const JSONL_PATH = resolve(ARTIFACTS_DIR, 'c3-history-export.jsonl');
const META_PATH = resolve(ARTIFACTS_DIR, 'c3-history-export.metadata.json');
const REPORT_PATH = resolve(ARTIFACTS_DIR, 'c3-replay-report.json');

function main(): void {
  console.log('[replay] loading export from', JSONL_PATH);
  const loaded = readJsonlFile(JSONL_PATH);
  console.log(
    '[replay] loaded',
    loaded.executions.length,
    'executions; skipped',
    loaded.skipped.length,
  );

  const meta = readMetadata();

  console.log('[replay] splitting train/holdout by experiment_id');
  const split = splitTrainHoldout(loaded.executions, {
    holdoutFraction: 0.3,
    strategy: 'by_experiment_id',
  });
  console.log(
    '[replay] train:',
    split.train.length,
    'executions over',
    split.trainExperimentIds.length,
    'experiments',
  );
  console.log(
    '[replay] holdout:',
    split.holdout.length,
    'executions over',
    split.holdoutExperimentIds.length,
    'experiments',
  );
  for (const w of split.leakageWarnings) console.warn('[replay] leakage:', w);

  // Train the contribution scorer on TRAIN ONLY.
  const trainAsContribution = split.train.map(
    replayToContributionExecution,
  );
  console.log('[replay] scoring contribution profiles on train…');
  const trainHistory = scoreHistoricalContribution({
    executions: trainAsContribution,
  });
  console.log(
    '[replay] train profiles built:',
    trainHistory.modelProfiles.length,
    'cells across',
    new Set(trainHistory.modelProfiles.map((p) => p.taskType)).size,
    'task types',
  );

  // Run replay on holdout.
  console.log('[replay] running backtest on holdout…');
  const runResult = runHistoricalReplay({
    train: split.train,
    holdout: split.holdout,
    trainHistory,
  });
  console.log('[replay] evaluated rows:', runResult.rows.length);

  // Aggregate metrics.
  const excludedDueToMissingBaseline =
    split.holdout.length - runResult.rows.length;
  const globalMetrics = computeReplayMetrics({
    rows: runResult.rows,
    totalHoldoutRows: split.holdout.length,
    excludedDueToMissingBaseline,
  });
  const metricsByTaskType = computeMetricsByTaskType(runResult.rows);

  const report = buildReplayReport({
    exportMetadata: meta,
    split,
    globalMetrics,
    metricsByTaskType,
    nowIso: new Date().toISOString(),
  });

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log('[replay] wrote report to', REPORT_PATH);
  console.log(
    '[replay] APPROVAL:',
    report.approval.approved ? 'APPROVED' : 'REJECTED',
  );
  for (const r of report.approval.reasons) console.log('         -', r);
}

function readMetadata(): ReplayExportMetadata {
  try {
    const text = readFileSync(META_PATH, 'utf-8');
    return JSON.parse(text) as ReplayExportMetadata;
  } catch {
    return {
      exportedAt: new Date().toISOString(),
      source: 'fixture',
      rowCounts: { executions: 0, experiments: 0 },
      filters: { onlyWithJudgeScore: true, onlyCompletedExecutions: false },
      schemaVersion: '8b5-v1',
    };
  }
}

/**
 * Adapts the replay-execution shape to the `HistoricalExecution` shape
 * expected by `scoreHistoricalContribution`. Lossy by design — judge
 * NULLs are filtered out upstream by the export query.
 */
function replayToContributionExecution(
  e: HistoricalReplayExecution,
): HistoricalExecution {
  return {
    executionId: e.executionId,
    experimentId: e.experimentId,
    taskId: e.taskId,
    taskType: e.taskType,
    complexity: e.complexity ?? 'medium',
    strategyId: e.strategyId,
    effectiveStrategyId: e.effectiveStrategyId ?? e.strategyId,
    modelsUsed: e.modelsUsed,
    judgeScore: typeof e.judgeScore === 'number' ? e.judgeScore : 0,
    costUsd: typeof e.costUsd === 'number' ? e.costUsd : 0,
    success: e.success,
    degraded: e.degraded,
    degradationReason: e.degradationReason ?? undefined,
    failureMode: e.failureMode ?? undefined,
    modality: e.modality,
  };
}

main();
