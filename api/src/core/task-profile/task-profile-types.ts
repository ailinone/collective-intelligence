// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profile-types.ts — MVP 6A
 *
 * Pure types. No I/O. No runtime imports beyond MVP 1 types.
 *
 * The TaskProfile is the CATEGORICAL projection of a request that
 * downstream consumers (CandidateRetriever, ModelScorer, StrategyPlanner)
 * use. It NEVER carries:
 *   - prompt
 *   - raw user messages
 *   - modelId / providerId / routeId
 *   - PII
 *
 * The profile is also serializable — every field is a primitive or
 * shallow array of primitives.
 */

// ─── Enums (typed unions) ───────────────────────────────────────────────

export type TaskType =
  | 'factual'
  | 'reasoning'
  | 'code'
  | 'math'
  | 'creative'
  | 'analysis'
  | 'summarization'
  | 'structured_generation'
  | 'tool_use'
  | 'vision'
  | 'audio'
  | 'agentic'
  | 'unknown';

export type Complexity = 'low' | 'medium' | 'high' | 'extreme';
export type RiskLevel = 'low' | 'medium' | 'high';
export type Sensitivity = 'low' | 'medium' | 'high';
export type PrivacyMode = 'standard' | 'local_preferred' | 'local_required';
export type Modality = 'text' | 'image' | 'audio' | 'video';
export type OutputFormat = 'json' | 'markdown' | 'code' | 'table';
export type ToolUseRequirement = 'none' | 'optional' | 'required';
export type FreshnessRequirement = 'none' | 'recent' | 'latest';

/**
 * Strategy hints — informational signal from the profiler to the
 * StrategyPlanner. The PLANNER still owns the final decision.
 */
export type StrategyHint =
  | 'single_best'
  | 'local_first'
  | 'cost_cascade'
  | 'quality_cascade'
  | 'parallel_diverse'
  | 'consensus'
  | 'expert_panel'
  | 'critique_repair';

// ─── Attachment ─────────────────────────────────────────────────────────

export type AttachmentKind =
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'spreadsheet'
  | 'code'
  | 'unknown';

export interface AttachmentInfo {
  readonly kind: AttachmentKind;
  readonly approximateTokens?: number;
}

// ─── TaskProfile ────────────────────────────────────────────────────────

export interface TaskProfile {
  readonly taskType: TaskType;
  readonly complexity: Complexity;
  readonly requiredCapabilities: readonly string[];
  readonly desiredCapabilities: readonly string[];
  readonly modalities: readonly Modality[];
  readonly contextRequirementTokens?: number;
  readonly riskLevel: RiskLevel;
  readonly latencyBudgetMs?: number;
  readonly costSensitivity: Sensitivity;
  readonly privacyMode: PrivacyMode;
  readonly confidenceNeeded: number;
  readonly strategyHints: readonly StrategyHint[];
  readonly outputFormatRequirements?: readonly OutputFormat[];
  readonly toolUseRequirement?: ToolUseRequirement;
  readonly freshnessRequirement?: FreshnessRequirement;
}

// ─── TaskProfilerInput ──────────────────────────────────────────────────

export interface TaskProfilerInput {
  readonly requestId: string;
  readonly text?: string;
  readonly messageCount?: number;
  readonly approximateInputTokens?: number;
  readonly attachments?: readonly AttachmentInfo[];
  readonly explicitPrivacyMode?: PrivacyMode;
  readonly explicitLatencyBudgetMs?: number;
  readonly explicitCostSensitivity?: Sensitivity;
  readonly explicitOutputFormat?: OutputFormat;
  readonly explicitToolUse?: ToolUseRequirement;
}
