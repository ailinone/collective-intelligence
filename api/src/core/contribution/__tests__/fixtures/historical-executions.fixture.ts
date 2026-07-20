// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-executions.fixture.ts — MVP 8A
 *
 * Curated fixture set encoding the empirical findings from the C3
 * audits. The names below are ONLY used here as opaque identifiers
 * — no production code branches on them. The scorer/optimizer operate
 * on the structural fields (judgeScore, costUsd, harm signals, etc.).
 *
 * Composition (~110 records):
 *   - single-model baselines (winning & losing)
 *   - single_budget baselines
 *   - collective:parallel winners (the validated tier)
 *   - collective:parallel losers
 *   - consensus high-quality but ~6x cost
 *   - critique-repair high-quality but ~7x cost
 *   - expert-panel / debate / tri-role low-quality
 *   - modality mismatch pools (audio/image route on text task)
 *   - multi-mini harmful pools (judge 0 across the board)
 *   - cheap-but-good (mistral-nemo-ish)
 *   - cheap-but-harmful (nemotron-nano-ish)
 *   - expensive-not-pareto-efficient
 */

import type { HistoricalExecution } from '../../historical-execution-types';

let _seq = 0;
function eid(): string {
  _seq += 1;
  return `exec-${_seq.toString().padStart(4, '0')}`;
}

// ─── Identity aliases (opaque, fixture-only) ────────────────────────────

const ANCHOR_A = 'fx-anchor-a';
const ANCHOR_B = 'fx-anchor-b';
const VISION_GOOD = 'fx-vision-good';
const TEXT_FAST = 'fx-text-fast';
const PAIR_WINNER_X = 'fx-pair-x';
const PAIR_WINNER_Y = 'fx-pair-y';
const CHEAP_GOOD = 'fx-cheap-good';
const CHEAP_HARMFUL = 'fx-cheap-harmful';
const MINI_A = 'fx-mini-a';
const MINI_B = 'fx-mini-b';
const MINI_C = 'fx-mini-c';
const AUDIO_TTS = 'fx-audio-tts';
const IMAGE_GEN = 'fx-image-gen';
const EXPENSIVE_OK = 'fx-expensive-ok';
const EXPENSIVE_BAD = 'fx-expensive-bad';
const PAIR_LOSER_P = 'fx-pair-loser-p';
const PAIR_LOSER_Q = 'fx-pair-loser-q';

// Re-exports so tests can refer to the same opaque ids.
export const FX = Object.freeze({
  ANCHOR_A,
  ANCHOR_B,
  VISION_GOOD,
  TEXT_FAST,
  PAIR_WINNER_X,
  PAIR_WINNER_Y,
  CHEAP_GOOD,
  CHEAP_HARMFUL,
  MINI_A,
  MINI_B,
  MINI_C,
  AUDIO_TTS,
  IMAGE_GEN,
  EXPENSIVE_OK,
  EXPENSIVE_BAD,
  PAIR_LOSER_P,
  PAIR_LOSER_Q,
});

const EXP = 'exp-c3-mvp8a';
const TASK = 'code-generation';

function single(
  model: string,
  judge: number,
  cost: number,
  opts: Partial<HistoricalExecution> = {},
): HistoricalExecution {
  const strategy = opts.strategyId ?? 'single';
  return Object.freeze({
    executionId: eid(),
    experimentId: EXP,
    taskId: `task-${model}`,
    taskType: opts.taskType ?? TASK,
    complexity: opts.complexity ?? 'medium',
    strategyId: strategy,
    effectiveStrategyId: opts.effectiveStrategyId ?? strategy,
    modelsUsed: [model],
    judgeScore: judge,
    costUsd: cost,
    success: opts.success ?? (judge > 0),
    degraded: opts.degraded,
    degradationReason: opts.degradationReason,
    failureMode: opts.failureMode,
    modality: opts.modality ?? 'text',
    latencyMs: opts.latencyMs ?? 1_500,
  });
}

function ensemble(
  strategy: HistoricalExecution['strategyId'],
  models: readonly string[],
  judge: number,
  cost: number,
  opts: Partial<HistoricalExecution> = {},
): HistoricalExecution {
  return Object.freeze({
    executionId: eid(),
    experimentId: EXP,
    taskId: `task-${strategy}-${models.join('+')}`,
    taskType: opts.taskType ?? TASK,
    complexity: opts.complexity ?? 'medium',
    strategyId: strategy,
    effectiveStrategyId: opts.effectiveStrategyId ?? strategy,
    modelsUsed: models,
    judgeScore: judge,
    costUsd: cost,
    success: opts.success ?? (judge > 0),
    degraded: opts.degraded,
    degradationReason: opts.degradationReason,
    failureMode: opts.failureMode,
    modality: opts.modality ?? 'text',
    latencyMs: opts.latencyMs ?? 2_500,
  });
}

// ─── Build fixture set ──────────────────────────────────────────────────

const records: HistoricalExecution[] = [];

// Single-model winners (high judge, modest cost) — baselines ~0.65, ~$0.020
for (let i = 0; i < 6; i += 1) records.push(single(ANCHOR_A, 0.72 - i * 0.01, 0.022));
for (let i = 0; i < 6; i += 1) records.push(single(ANCHOR_B, 0.7 - i * 0.01, 0.025));

// Single-model losing (lower judge) — drag the baseline mean down
for (let i = 0; i < 4; i += 1) records.push(single(ANCHOR_A, 0.45, 0.022));
for (let i = 0; i < 4; i += 1) records.push(single(ANCHOR_B, 0.43, 0.025));

// single_budget baselines — explicit strategyId so the aggregator computes
// distinct singleBudget baselines from these rows.
for (let i = 0; i < 6; i += 1)
  records.push(
    single(TEXT_FAST, 0.5 + i * 0.01, 0.004, {
      taskType: TASK,
      strategyId: 'single_budget',
    }),
  );

// Cheap-good model — moderate judge, very cheap
for (let i = 0; i < 8; i += 1) records.push(single(CHEAP_GOOD, 0.58, 0.0015));

// Cheap-harmful model — frequent zeros
for (let i = 0; i < 8; i += 1)
  records.push(
    single(CHEAP_HARMFUL, 0.05, 0.0012, {
      degraded: true,
      degradationReason: 'truncated_response',
    }),
  );

// Multi-mini singletons — consistently very low quality
for (const m of [MINI_A, MINI_B, MINI_C]) {
  for (let i = 0; i < 6; i += 1)
    records.push(single(m, 0.05, 0.0008));
}

// Vision-good model on vision tasks
for (let i = 0; i < 8; i += 1)
  records.push(
    single(VISION_GOOD, 0.78, 0.012, {
      taskType: 'image-understanding',
      modality: 'image',
    }),
  );

// Audio TTS model — appears in TEXT tasks by accident → modality mismatch
for (let i = 0; i < 5; i += 1)
  records.push(
    single(AUDIO_TTS, 0.0, 0.001, {
      modality: 'audio',
      success: false,
      failureMode: 'modality_mismatch',
    }),
  );

// Image generation model — appears in TEXT tasks by accident → mismatch
for (let i = 0; i < 5; i += 1)
  records.push(
    single(IMAGE_GEN, 0.0, 0.003, {
      modality: 'image',
      success: false,
      failureMode: 'modality_mismatch',
    }),
  );

// Expensive but OK on quality (not Pareto-efficient — cheaper options match)
for (let i = 0; i < 6; i += 1) records.push(single(EXPENSIVE_OK, 0.65, 0.18));

// Expensive AND bad
for (let i = 0; i < 5; i += 1) records.push(single(EXPENSIVE_BAD, 0.32, 0.22));

// Pair-winner combo (the validated parallel tier)
for (let i = 0; i < 10; i += 1)
  records.push(
    ensemble(
      'parallel',
      [PAIR_WINNER_X, PAIR_WINNER_Y],
      0.95 - i * 0.005,
      0.0028 + i * 0.0001,
    ),
  );

// Anchor + pair-winner combo — also strong
for (let i = 0; i < 6; i += 1)
  records.push(
    ensemble(
      'parallel',
      [ANCHOR_A, PAIR_WINNER_Y],
      0.86,
      0.024,
    ),
  );

// Multi-mini pool — judge 0
for (let i = 0; i < 6; i += 1)
  records.push(
    ensemble(
      'parallel',
      [MINI_A, MINI_B, MINI_C],
      0.02,
      0.003,
      { degraded: true, degradationReason: 'all_outputs_blank' },
    ),
  );

// Pool with modality mismatch — audio/image in code task
for (let i = 0; i < 5; i += 1)
  records.push(
    ensemble(
      'parallel',
      [AUDIO_TTS, IMAGE_GEN, ANCHOR_A],
      0.1,
      0.026,
      {
        modality: 'mixed',
        degraded: true,
        degradationReason: 'modality_partial_mismatch',
      },
    ),
  );

// Pair-loser combo — both contributors poor
for (let i = 0; i < 6; i += 1)
  records.push(
    ensemble(
      'parallel',
      [PAIR_LOSER_P, PAIR_LOSER_Q],
      0.18,
      0.012,
    ),
  );

// Singletons for pair-loser members
for (let i = 0; i < 5; i += 1) records.push(single(PAIR_LOSER_P, 0.22, 0.005));
for (let i = 0; i < 5; i += 1) records.push(single(PAIR_LOSER_Q, 0.25, 0.007));

// Consensus with high judge but ~6x baseline cost
for (let i = 0; i < 6; i += 1)
  records.push(
    ensemble(
      'consensus',
      [ANCHOR_A, ANCHOR_B, PAIR_WINNER_X],
      0.84,
      0.14,
    ),
  );

// Critique-repair with high judge but ~7x baseline cost
for (let i = 0; i < 6; i += 1)
  records.push(
    ensemble(
      'critique-repair',
      [ANCHOR_A, ANCHOR_B],
      0.82,
      0.16,
    ),
  );

// Expert-panel low quality
for (let i = 0; i < 5; i += 1)
  records.push(
    ensemble(
      'expert-panel',
      [ANCHOR_A, ANCHOR_B, MINI_A, MINI_B],
      0.4,
      0.05,
    ),
  );

// Tri-role-collective low quality
for (let i = 0; i < 4; i += 1)
  records.push(
    ensemble(
      'tri-role-collective',
      [ANCHOR_A, ANCHOR_B, EXPENSIVE_OK],
      0.45,
      0.21,
    ),
  );

// Debate low quality
for (let i = 0; i < 4; i += 1)
  records.push(
    ensemble(
      'debate',
      [ANCHOR_A, EXPENSIVE_OK],
      0.42,
      0.19,
    ),
  );

export const HISTORICAL_EXECUTIONS_FIXTURE: ReadonlyArray<HistoricalExecution> =
  Object.freeze(records);
