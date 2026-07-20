// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-execution-types.ts — MVP 8A
 *
 * Pure types describing a single historical execution record.
 *
 * Production code consumes these via fixtures in MVP 8A; later MVPs may
 * back them with a DB loader, but the type contract stays the same.
 */

export type ExecutionModality = 'text' | 'image' | 'audio' | 'video' | 'mixed';

/**
 * Recognised C3 strategy ids. Open string allowed for forward-compat.
 */
export type ExecutionStrategyId =
  | 'single'
  | 'single_budget'
  | 'parallel'
  | 'consensus'
  | 'debate'
  | 'critique-repair'
  | 'expert-panel'
  | 'tri-role-collective'
  | 'parallel-diverse'
  | string;

export interface HistoricalExecution {
  readonly executionId: string;
  readonly experimentId: string;
  readonly taskId: string;
  readonly taskType: string;
  readonly complexity: 'low' | 'medium' | 'high' | 'extreme';
  readonly strategyId: ExecutionStrategyId;
  /**
   * The strategy actually run (possibly after fallback). Equals
   * strategyId when no fallback occurred.
   */
  readonly effectiveStrategyId: ExecutionStrategyId;
  readonly modelsUsed: readonly string[];
  readonly providerRoutes?: readonly string[];
  readonly judgeScore: number;
  readonly costUsd: number;
  readonly latencyMs?: number;
  readonly success: boolean;
  readonly degraded?: boolean;
  readonly degradationReason?: string;
  readonly failureMode?: string;
  readonly modality?: ExecutionModality;
}

// ─── Outcome classifications (derived from judgeScore + baselines) ─────

export type ExecutionOutcomeClass =
  | 'win'
  | 'partial'
  | 'loss'
  | 'zero'
  | 'failure';

/**
 * Default thresholds used to classify a judge score. Overridable per
 * scorer invocation when callers want stricter or looser cuts.
 */
export interface JudgeThresholdPolicy {
  readonly winFloor: number;        // win: judgeScore >= max(winFloor, baseline)
  readonly partialFloor: number;    // partial: between partialFloor and winFloor
  readonly lossCeiling: number;     // loss: judgeScore < lossCeiling
  readonly zeroCeiling: number;     // zero: judgeScore <= zeroCeiling
}

export const DEFAULT_JUDGE_THRESHOLDS: JudgeThresholdPolicy = Object.freeze({
  winFloor: 0.6,
  partialFloor: 0.45,
  lossCeiling: 0.3,
  zeroCeiling: 0.1,
});
