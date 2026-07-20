// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RoutingDecisionTrace — serializable record of one routing decision.
 *
 * MVP 3 invariant: pure types + metrics interface. No runtime imports.
 * No singleton. No I/O.
 *
 * Privacy invariant: `TaskProfileSummary` is CATEGORICAL ONLY. It does
 * NOT carry prompts, user messages, raw context, emails, names, phones
 * or any user-identifying data. The redaction layer
 * (`routing-redaction.ts`) is the enforcement boundary — but the type
 * itself declares the safe surface area.
 */

import type {
  RoutingMode,
  ExplicitPinInfo,
  PinSubstitution,
} from '../registry/types';

// ─── Semantic index backend (advertised in trace for audit) ─────────────

/**
 * Tag for which semantic-search backend produced the candidates. The
 * value matches §4 of the v1.1 plan; MVP 3 only ever sees `'none'`
 * (semantic retrieval not wired yet), but the type is forward-compatible.
 */
export type SemanticIndexBackend =
  | 'none'
  | 'linear'
  | 'hnsw'
  | 'pgvector'
  | 'sidecar';

// ─── TaskProfileSummary — CATEGORICAL ONLY ──────────────────────────────

/**
 * Categorical projection of the inbound TaskProfile. By construction,
 * this type DOES NOT carry free-text fields. The redaction layer
 * rejects any unexpected key it finds on the input.
 *
 * Fields are typed as string (not unions) so future task types and
 * privacy modes don't require schema bumps. Validation that the values
 * are in the allowed enums is done at the redaction boundary.
 */
export interface TaskProfileSummary {
  readonly taskType: string;
  readonly complexity: string;
  readonly modalities: readonly string[];
  readonly riskLevel: string;
  readonly privacyMode: string;
}

// ─── Rejected-candidate record ──────────────────────────────────────────

export interface RoutingRejectedCandidate {
  readonly routeId: string;
  readonly stage: string;
  readonly reason: string;
}

// ─── Strategy plan reference (no routes payload, only ids) ──────────────

export interface RoutingStrategyPlanRef {
  readonly strategy: string;
  readonly routes: readonly string[];
}

// ─── Pareto summary (MVP 8B — optional metadata for Pareto pipeline) ────

/**
 * Categorical + numeric summary of a Pareto ensemble decision, attached
 * to the trace when the composer used the contribution-aware path. All
 * fields are serializable. Never carries raw text.
 */
export interface ParetoTraceMarginalRecord {
  readonly modelId: string;
  readonly marginalQualityGain: number;
  readonly marginalCostUsd: number;
  readonly accepted: boolean;
  readonly reason: string;
}

export interface ParetoTraceRejectedRecord {
  readonly modelId: string;
  readonly reason: string;
}

export interface ParetoTracePlanSummary {
  readonly strategy: string;
  readonly routes: readonly string[];
}

export interface ParetoTraceSummary {
  readonly paretoStatus: string;
  readonly baselineSingleJudge: number;
  readonly baselineSingleCostUsd: number;
  readonly expectedEnsembleJudge: number;
  readonly expectedEnsembleCostUsd: number;
  readonly expectedQualityPerDollar: number;
  readonly selectedModelIds: readonly string[];
  readonly selectedRouteIds: readonly string[];
  readonly ensembleExplanation: string;
  readonly marginalContributions: readonly ParetoTraceMarginalRecord[];
  readonly rejectedCandidates: readonly ParetoTraceRejectedRecord[];
  readonly structuralPlanSummary: ParetoTracePlanSummary;
  readonly paretoPlanSummary: ParetoTracePlanSummary;
  readonly finalPlanSource: 'pareto' | 'single_fallback' | 'original_strategy';
}

// ─── The trace ──────────────────────────────────────────────────────────

/**
 * Captured trace of a routing decision. Always serializable to JSON
 * — no Map/Set, no Date instances, no functions, no symbols.
 */
export interface RoutingDecisionTrace {
  readonly traceId: string;
  readonly requestId: string;
  /** ISO-8601 timestamp. */
  readonly timestamp: string;
  readonly routingMode: RoutingMode;

  readonly taskProfile: TaskProfileSummary;

  readonly semanticIndexBackend: SemanticIndexBackend;
  readonly candidatesEvaluated: number;
  readonly candidatesByStage: Readonly<Record<string, number>>;
  readonly rejectedByStage: ReadonlyArray<RoutingRejectedCandidate>;

  readonly selectedCanonicalModelId: string | null;
  readonly selectedOfferingId: string | null;
  readonly selectedRouteId: string | null;

  readonly scoreBreakdown: Readonly<Record<string, number>>;

  readonly strategyPlan: RoutingStrategyPlanRef;

  readonly explicitModelPin: ExplicitPinInfo | null;
  readonly pinSubstitution: PinSubstitution | null;

  /** Phase → duration in ms. Phase keys are caller-defined strings. */
  readonly latencyByPhase: Readonly<Record<string, number>>;

  /** Optional — populated after execution by feedback hooks (later MVP). */
  readonly outcomeStatus?: 'success' | 'fallback' | 'error';
  readonly outcomeLatencyMs?: number;

  /** Optional Pareto-pipeline summary (MVP 8B). Present only when the
   *  contribution-aware composer produced the trace. */
  readonly paretoSummary?: ParetoTraceSummary;
}

// ─── Allowlist of top-level keys (used by redaction) ────────────────────

/**
 * The set of keys that may appear on a `RoutingDecisionTrace`.
 * Anything else is stripped by `redactRoutingTrace`. Listed once here
 * so the redactor and the schema test cannot drift.
 */
export const ROUTING_TRACE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'traceId',
  'requestId',
  'timestamp',
  'routingMode',
  'taskProfile',
  'semanticIndexBackend',
  'candidatesEvaluated',
  'candidatesByStage',
  'rejectedByStage',
  'selectedCanonicalModelId',
  'selectedOfferingId',
  'selectedRouteId',
  'scoreBreakdown',
  'strategyPlan',
  'explicitModelPin',
  'pinSubstitution',
  'latencyByPhase',
  'outcomeStatus',
  'outcomeLatencyMs',
  'paretoSummary',
]);

/**
 * Keys that, if found anywhere in the trace, indicate a privacy
 * boundary violation. Redaction MUST strip these before persisting.
 */
export const ROUTING_TRACE_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'rawPrompt',
  'messages',
  'userMessage',
  'context',
  'rawContext',
  'email',
  'phone',
  'fullName',
  'userId',
  'userName',
  'userInput',
]);

// ─── Metrics interface (injected; no global metric system yet) ──────────

/**
 * Minimal metrics surface used by the collector and handlers. MVP 3
 * injects a fake implementation in tests; later MVPs supply the
 * real Prometheus bridge.
 */
export interface RoutingTraceMetrics {
  increment(name: string, labels?: Readonly<Record<string, string>>): void;
  gauge(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
}

// ─── No-op metrics — default for collector when caller omits ────────────

export const noopRoutingTraceMetrics: RoutingTraceMetrics = Object.freeze({
  increment(): void {
    // no-op
  },
  gauge(): void {
    // no-op
  },
});
