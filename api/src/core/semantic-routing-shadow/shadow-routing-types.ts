// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-types.ts — MVP 8C.0
 *
 * Pure types for the shadow routing layer. The shadow service runs
 * in parallel to legacy routing and produces a structured, redacted
 * audit record of what the Pareto-aware selector WOULD HAVE chosen —
 * without ever altering the actual model / provider / strategy /
 * response.
 *
 * No runtime imports beyond local primitives.
 */

// ─── Inputs ─────────────────────────────────────────────────────────────

export interface ShadowRoutingTaskProfilerInput {
  readonly requestId: string;
  /** Approximate token count — do NOT pass raw prompt text. */
  readonly approximateInputTokens?: number;
  readonly messageCount?: number;
  /** Attachment summary by kind — never the raw bytes. */
  readonly attachments?: ReadonlyArray<{
    readonly kind: 'image' | 'audio' | 'video' | 'document' | 'spreadsheet' | 'code' | 'unknown';
    readonly approximateTokens?: number;
  }>;
  readonly explicitPrivacyMode?: 'standard' | 'local_preferred' | 'local_required';
  readonly explicitLatencyBudgetMs?: number;
  readonly explicitCostSensitivity?: 'low' | 'medium' | 'high';
  readonly explicitOutputFormat?: 'json' | 'markdown' | 'code' | 'table';
  readonly explicitToolUse?: 'none' | 'optional' | 'required';
  /** Hint for the task type (when caller already classified it). */
  readonly taskTypeHint?: string;
}

export interface ShadowRouteContext {
  /** What the legacy/real selector chose for THIS request. Used for diff. */
  readonly actualModel?: string;
  readonly actualProvider?: string;
  readonly actualStrategy?: string;
  readonly actualRouteId?: string;
}

export interface ShadowRoutingInput {
  readonly requestId: string;
  /** Hash of user id when known — never the raw id. */
  readonly userIdHash?: string;
  readonly routeContext: ShadowRouteContext;
  readonly profilerInput: ShadowRoutingTaskProfilerInput;
  readonly metadata?: {
    readonly source: 'chat' | 'experiment' | 'api' | 'unknown';
    readonly timestamp: string;
  };
}

// ─── Output ─────────────────────────────────────────────────────────────

export type ShadowSkipReason =
  | 'flag_disabled'
  | 'sample_rate_zero'
  | 'sample_skipped'
  | 'task_type_not_approved'
  | 'pareto_compute_not_yet_wired'
  | 'shadow_timeout'
  | 'shadow_error'
  | 'invalid_input';

export interface ShadowParetoPlanSummary {
  readonly strategy: string;
  readonly selectedRouteIds: readonly string[];
  readonly selectedModelIds: readonly string[];
  readonly expectedJudge?: number;
  readonly expectedCostUsd?: number;
  readonly paretoStatus?: string;
  readonly fallbackReason?: string;
  readonly peerLift?: number;
}

export interface ShadowDiff {
  readonly sameModelAsActual?: boolean;
  readonly sameProviderAsActual?: boolean;
  readonly sameStrategyAsActual?: boolean;
  readonly estimatedCostDeltaUsd?: number;
}

export interface ShadowTaskProfileSummary {
  readonly taskType: string;
  readonly complexity?: string;
  readonly riskLevel?: string;
  readonly privacyMode?: string;
}

export interface ShadowRoutingResult {
  readonly executed: boolean;
  readonly skippedReason?: ShadowSkipReason;
  readonly latencyMs: number;
  readonly taskProfile?: ShadowTaskProfileSummary;
  readonly paretoPlan?: ShadowParetoPlanSummary;
  readonly diff?: ShadowDiff;
}

// ─── Service contract ───────────────────────────────────────────────────

export interface ShadowRoutingService {
  isEnabled(): boolean;
  run(input: ShadowRoutingInput): Promise<ShadowRoutingResult>;
}
