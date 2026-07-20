// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-results-schema.ts — MVP 8B.6
 *
 * Pure types for the expanded historical-results harvest pipeline.
 *
 *   raw   → sanitized → normalized → deduped → quality-gated
 *
 * Each stage produces a new immutable record set; nothing is mutated
 * in place. The pipeline is pure — no I/O.
 */

import type { HistoricalReplayExecution } from '../historical-replay-types';

// ─── Stage 1 — raw row (post-export, pre-sanitisation) ──────────────────

/**
 * Raw record as it lands from the read-only export. Permissive shape
 * so the sanitiser can decide what to keep. Field names match the SQL
 * column names (snake_case OR camelCase — the loader normalises).
 */
export type HistoricalRawRow = Record<string, unknown>;

// ─── Stage 2 — sanitised row ────────────────────────────────────────────

/**
 * Same shape as a `HistoricalRawRow` but with all sensitive fields
 * stripped. The sanitiser ALSO normalises the field-name casing — the
 * downstream stages see `camelCase` keys only.
 */
export type SanitisedRow = Record<string, unknown>;

// ─── Stage 3 — normalised row ───────────────────────────────────────────

export type JudgeScale = '0_1' | '0_100' | '1_5' | 'unknown';

export interface NormalisedRow {
  readonly executionId: string;
  readonly experimentId: string;
  readonly taskId: string;
  readonly taskIndex?: number;
  readonly repetition?: number;
  readonly createdAt?: string;

  readonly executionMode?: string;
  readonly strategy?: string;
  readonly effectiveStrategy?: string;

  readonly taskType?: string;
  readonly complexity?: 'low' | 'medium' | 'high' | 'extreme';
  readonly domain?: string;

  readonly modelsUsed: readonly string[];
  readonly providerRoutes: readonly string[];

  readonly judgeScoreRaw: number | null;
  readonly judgeScoreNormalized: number | null;
  readonly judgeScaleDetected: JudgeScale;
  readonly judgeNormalizationApplied: boolean;
  readonly judgeComparable: boolean;
  readonly judgeUsed: boolean;

  readonly qualityScore: number | null;
  readonly heuristicScoreRaw: number | null;

  readonly costUsd: number | null;
  readonly latencyMs: number | null;
  readonly totalTokens: number | null;

  readonly success: boolean | null;
  readonly phase?: string;
  readonly failureMode?: string;
  readonly degraded?: boolean;
  readonly degradationReason?: string;

  readonly ablationCondition?: string;
  readonly scoringPolicy?: string;

  readonly modality?: 'text' | 'image' | 'audio' | 'video' | 'mixed';
}

// ─── Stage 4 — quality-gated row ────────────────────────────────────────

export type HistoricalRowUsage =
  | 'usable_for_training'
  | 'usable_for_holdout'
  | 'usable_for_cost_only'
  | 'usable_for_failure_analysis_only'
  | 'excluded';

export interface HistoricalRowQualityDecision {
  readonly executionId: string;
  readonly usage: HistoricalRowUsage;
  readonly reasons: readonly string[];
}

export interface QualityGatedRow {
  readonly row: NormalisedRow;
  readonly decision: HistoricalRowQualityDecision;
}

// ─── Harvest pipeline output ────────────────────────────────────────────

export interface HarvestRowCounts {
  readonly rawRows: number;
  readonly sanitizedRows: number;
  readonly normalizedRows: number;
  readonly usableForTraining: number;
  readonly usableForHoldout: number;
  readonly usableForCostOnly: number;
  readonly usableForFailureAnalysisOnly: number;
  readonly excluded: number;
}

export interface HarvestSanitisationReport {
  readonly removedFields: readonly string[];
  readonly keptFields: readonly string[];
}

export interface HarvestResult {
  /** Rows promoted to `usable_for_training` AND `usable_for_holdout`. */
  readonly trainingAndHoldoutCandidates: readonly HistoricalReplayExecution[];
  /** Per-row decision records — used for audit + reporting. */
  readonly decisions: readonly HistoricalRowQualityDecision[];
  readonly counts: HarvestRowCounts;
  readonly sanitisation: HarvestSanitisationReport;
}

// ─── Forbidden fields (single source of truth) ──────────────────────────

export const FORBIDDEN_RAW_FIELDS: readonly string[] = Object.freeze([
  'prompt',
  'response',
  'response_summary',
  'responseSummary',
  'messages',
  'rawContext',
  'context',
  'raw_context',
  'attachments',
  'judge_rubric',
  'judgeRubric',
  'structured_metadata',
  'structuredMetadata',
  'userMessage',
  'user_message',
  'rawPrompt',
  'raw_prompt',
  'rawProviderPayload',
  'raw_provider_payload',
  'rawToolOutputs',
  'raw_tool_outputs',
]);

export const KEPT_FIELDS: readonly string[] = Object.freeze([
  'executionId',
  'experimentId',
  'taskId',
  'taskIndex',
  'repetition',
  'createdAt',
  'executionMode',
  'strategy',
  'effectiveStrategy',
  'taskType',
  'complexity',
  'domain',
  'modelsUsed',
  'providerRoutes',
  'judgeScore',
  'qualityScore',
  'judgeUsed',
  'heuristicScoreRaw',
  'costUsd',
  'latencyMs',
  'totalTokens',
  'success',
  'phase',
  'failureMode',
  'degraded',
  'degradationReason',
  'ablationCondition',
  'scoringPolicy',
  'modality',
]);
