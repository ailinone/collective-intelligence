// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * synthetic-replay.fixture.ts — MVP 8B.5
 *
 * Small synthetic replay dataset. Two experiments × multiple task types
 * × singles + parallels. Used to exercise the loader / split / runner
 * without depending on the real C3 export artifact.
 */

import type { HistoricalReplayExecution } from '../../historical-replay-types';

let _seq = 0;
function eid(): string {
  _seq += 1;
  return `exec-syn-${_seq.toString().padStart(4, '0')}`;
}

function single(
  experimentId: string,
  model: string,
  taskType: string,
  judge: number,
  cost: number,
  overrides: Partial<HistoricalReplayExecution> = {},
): HistoricalReplayExecution {
  return Object.freeze({
    executionId: eid(),
    experimentId,
    taskId: `${experimentId}::${taskType}::${_seq}`,
    taskType,
    complexity: 'medium',
    strategyId: 'single',
    effectiveStrategyId: 'single',
    modelsUsed: Object.freeze([model]),
    judgeScore: judge,
    costUsd: cost,
    success: judge > 0,
    modality: 'text',
    createdAt: '2026-05-01T00:00:00Z',
    ...overrides,
  });
}

function parallel(
  experimentId: string,
  models: readonly string[],
  taskType: string,
  judge: number,
  cost: number,
): HistoricalReplayExecution {
  return Object.freeze({
    executionId: eid(),
    experimentId,
    taskId: `${experimentId}::${taskType}::par::${_seq}`,
    taskType,
    complexity: 'medium',
    strategyId: 'parallel',
    effectiveStrategyId: 'parallel',
    modelsUsed: Object.freeze(models.slice()),
    judgeScore: judge,
    costUsd: cost,
    success: judge > 0,
    modality: 'text',
    createdAt: '2026-05-01T00:00:00Z',
  });
}

// Two distinct experiments — used for splitting by experimentId.
const EXP_A = 'exp-A';
const EXP_B = 'exp-B';

const records: HistoricalReplayExecution[] = [];

// Anchor singles in EXP_A (training side)
for (let i = 0; i < 6; i += 1)
  records.push(single(EXP_A, 'fx-anchor-a', 'code', 0.7 - i * 0.02, 0.022));
for (let i = 0; i < 6; i += 1)
  records.push(single(EXP_A, 'fx-anchor-b', 'code', 0.65 - i * 0.02, 0.025));

// Cheap-good in EXP_A
for (let i = 0; i < 5; i += 1)
  records.push(single(EXP_A, 'fx-cheap-good', 'code', 0.55, 0.0015));

// Cheap-harmful in EXP_A
for (let i = 0; i < 5; i += 1)
  records.push(single(EXP_A, 'fx-cheap-harmful', 'code', 0.05, 0.0012, {
    degraded: true,
  }));

// Pair winner in EXP_A
for (let i = 0; i < 4; i += 1)
  records.push(
    parallel(EXP_A, ['fx-pair-x', 'fx-pair-y'], 'code', 0.92, 0.003),
  );

// Singles for pair members in EXP_A
for (let i = 0; i < 4; i += 1) records.push(single(EXP_A, 'fx-pair-x', 'code', 0.78, 0.0014));
for (let i = 0; i < 4; i += 1) records.push(single(EXP_A, 'fx-pair-y', 'code', 0.75, 0.0014));

// EXP_B (holdout side) — same task type to enable replay
for (let i = 0; i < 3; i += 1) records.push(single(EXP_B, 'fx-anchor-a', 'code', 0.7, 0.022));
for (let i = 0; i < 3; i += 1) records.push(single(EXP_B, 'fx-cheap-good', 'code', 0.55, 0.0015));
for (let i = 0; i < 3; i += 1)
  records.push(
    parallel(EXP_B, ['fx-pair-x', 'fx-pair-y'], 'code', 0.93, 0.0028),
  );
for (let i = 0; i < 3; i += 1)
  records.push(
    parallel(EXP_B, ['fx-cheap-harmful', 'fx-cheap-harmful'], 'code', 0.05, 0.0024),
  );

// Different task type in BOTH experiments — exercises taskType break-down
for (let i = 0; i < 5; i += 1) records.push(single(EXP_A, 'fx-anchor-a', 'analysis', 0.6, 0.022));
for (let i = 0; i < 3; i += 1) records.push(single(EXP_B, 'fx-anchor-a', 'analysis', 0.6, 0.022));

export const SYNTHETIC_REPLAY_FIXTURE: ReadonlyArray<HistoricalReplayExecution> =
  Object.freeze(records);

export const SYNTHETIC_EXPERIMENTS = Object.freeze({
  TRAIN: EXP_A,
  HOLDOUT: EXP_B,
});

/**
 * Serialises the fixture as JSONL — used by loader tests so they can
 * exercise the parser without hitting a file.
 */
export function asJsonl(
  records: readonly HistoricalReplayExecution[] = SYNTHETIC_REPLAY_FIXTURE,
): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}
