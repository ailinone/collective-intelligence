// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-redaction.ts — PII / prompt redaction for RoutingDecisionTrace.
 *
 * MVP 3 invariants:
 *   - Pure function. No I/O.
 *   - Never mutates the input object.
 *   - Strips forbidden keys ANYWHERE in the trace (top-level, nested).
 *   - Strips keys outside the trace's documented allowlist.
 *   - Scrubs email and phone patterns from string values inside reasons /
 *     scoreBreakdown keys / route ids (defence in depth).
 *
 * NOT a sanitizer for user-supplied input — that lives in the request
 * pipeline. THIS function only protects the trace artifact against
 * accidental leakage when callers populate it.
 */

import type {
  ParetoTraceMarginalRecord,
  ParetoTracePlanSummary,
  ParetoTraceRejectedRecord,
  ParetoTraceSummary,
  RoutingDecisionTrace,
  RoutingRejectedCandidate,
  RoutingStrategyPlanRef,
  TaskProfileSummary,
} from './routing-decision-trace';
import {
  ROUTING_TRACE_ALLOWED_KEYS,
  ROUTING_TRACE_FORBIDDEN_KEYS,
} from './routing-decision-trace';
import type { ExplicitPinInfo, PinSubstitution } from '../registry/types';

const REDACTION_TOKEN = '[REDACTED]';

// ─── Regex (defence in depth — strict but conservative) ────────────────

/**
 * Email pattern — RFC-5322-ish, broad enough to catch the common cases.
 * Tested against both `user@example.com` and `User.Name+tag@sub.example.co.uk`.
 */
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Phone-number pattern — covers common international forms:
 *   +55 11 91234-5678
 *   (415) 555-0123
 *   +1-555-555-5555
 *   555.555.5555
 * Conservative enough to NOT flag arbitrary 3-digit ids (e.g. route p99).
 * Requires at least 9 digits total to qualify.
 */
const PHONE_REGEX =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}/g;

function isPhoneCandidate(s: string): boolean {
  // Cheap pre-filter: must have ≥ 9 digits before regex tries.
  let digits = 0;
  for (const ch of s) if (ch >= '0' && ch <= '9') digits += 1;
  return digits >= 9;
}

function scrubString(s: string): string {
  let out = s.replace(EMAIL_REGEX, REDACTION_TOKEN);
  if (isPhoneCandidate(out)) {
    out = out.replace(PHONE_REGEX, REDACTION_TOKEN);
  }
  return out;
}

// ─── Allowed task profile keys (categorical-only) ───────────────────────

const ALLOWED_TASK_PROFILE_KEYS: ReadonlySet<string> = new Set([
  'taskType',
  'complexity',
  'modalities',
  'riskLevel',
  'privacyMode',
]);

function redactTaskProfile(input: unknown): TaskProfileSummary {
  if (!input || typeof input !== 'object') {
    return {
      taskType: 'unknown',
      complexity: 'unknown',
      modalities: [],
      riskLevel: 'unknown',
      privacyMode: 'unknown',
    };
  }
  const raw = input as Record<string, unknown>;
  // Strict allowlist: any other key gets dropped (e.g., prompt, messages).
  return {
    taskType: typeof raw.taskType === 'string' ? scrubString(raw.taskType) : 'unknown',
    complexity:
      typeof raw.complexity === 'string' ? scrubString(raw.complexity) : 'unknown',
    modalities: Array.isArray(raw.modalities)
      ? raw.modalities
          .filter((m): m is string => typeof m === 'string')
          .map(scrubString)
      : [],
    riskLevel:
      typeof raw.riskLevel === 'string' ? scrubString(raw.riskLevel) : 'unknown',
    privacyMode:
      typeof raw.privacyMode === 'string' ? scrubString(raw.privacyMode) : 'unknown',
  };
  // Note: ALLOWED_TASK_PROFILE_KEYS is exported in spirit via this fn —
  // unused symbols cause lint noise so we reference it below.
  void ALLOWED_TASK_PROFILE_KEYS;
}

// ─── Helpers for the inner records ──────────────────────────────────────

function redactRejected(arr: unknown): ReadonlyArray<RoutingRejectedCandidate> {
  if (!Array.isArray(arr)) return [];
  const out: RoutingRejectedCandidate[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    out.push({
      routeId: typeof raw.routeId === 'string' ? scrubString(raw.routeId) : '',
      stage: typeof raw.stage === 'string' ? scrubString(raw.stage) : '',
      reason: typeof raw.reason === 'string' ? scrubString(raw.reason) : '',
    });
  }
  return out;
}

function redactStrategyPlan(input: unknown): RoutingStrategyPlanRef {
  if (!input || typeof input !== 'object') {
    return { strategy: 'unknown', routes: [] };
  }
  const raw = input as Record<string, unknown>;
  return {
    strategy: typeof raw.strategy === 'string' ? scrubString(raw.strategy) : 'unknown',
    routes: Array.isArray(raw.routes)
      ? raw.routes
          .filter((r): r is string => typeof r === 'string')
          .map(scrubString)
      : [],
  };
}

function redactStringRecord(
  input: unknown,
): Readonly<Record<string, number>> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[scrubString(k)] = v;
    }
  }
  return out;
}

function redactPin(input: unknown): ExplicitPinInfo | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const source = raw.source;
  if (
    source !== 'request_model_field' &&
    source !== 'request_modelPin' &&
    source !== 'experiment_pin' &&
    source !== 'internal_pin'
  ) {
    return null;
  }
  return {
    source,
    canonicalModelId:
      typeof raw.canonicalModelId === 'string'
        ? scrubString(raw.canonicalModelId)
        : undefined,
    offeringId:
      typeof raw.offeringId === 'string' ? scrubString(raw.offeringId) : undefined,
    routeId: typeof raw.routeId === 'string' ? scrubString(raw.routeId) : undefined,
    allowSubstitution: raw.allowSubstitution === true,
    authorizingPolicy:
      typeof raw.authorizingPolicy === 'string'
        ? scrubString(raw.authorizingPolicy)
        : undefined,
  };
}

function redactSubstitution(input: unknown): PinSubstitution | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  // policyAuthorized MUST be true — anything else returns null
  if (raw.policyAuthorized !== true) return null;
  // reason must be one of the documented enum values
  const validReasons = new Set([
    'original_route_blocked_no_credit',
    'original_route_blocked_auth_failed',
    'original_route_blocked_rate_limited',
    'original_route_minimal_chat_failed',
    'original_capability_mismatch',
    'original_offering_lifecycle_retired',
  ]);
  if (typeof raw.reason !== 'string' || !validReasons.has(raw.reason)) return null;
  return {
    originalCanonicalModelId: scrubString(String(raw.originalCanonicalModelId ?? '')),
    originalRouteId: scrubString(String(raw.originalRouteId ?? '')),
    substitutedCanonicalModelId: scrubString(
      String(raw.substitutedCanonicalModelId ?? ''),
    ),
    substitutedRouteId: scrubString(String(raw.substitutedRouteId ?? '')),
    reason: raw.reason as PinSubstitution['reason'],
    policyAuthorized: true,
    authorizingPolicy: scrubString(String(raw.authorizingPolicy ?? '')),
  };
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Redacts a (potentially unsafe) trace into a safe one. Never mutates
 * the input. The output is guaranteed:
 *   - to have ONLY keys in `ROUTING_TRACE_ALLOWED_KEYS`
 *   - to have NO keys in `ROUTING_TRACE_FORBIDDEN_KEYS` anywhere
 *   - to have all string values scrubbed of email + phone patterns
 *
 * Acts defensively: if the input is null/undefined or has unexpected
 * shape, the redactor returns a minimal valid trace with sentinel
 * values rather than throwing.
 */
export function redactRoutingTrace(input: unknown): RoutingDecisionTrace {
  // Defensive base — even null/undefined returns a valid serializable object.
  if (!input || typeof input !== 'object') {
    return buildEmptyTrace();
  }

  const raw = input as Record<string, unknown>;

  // Forbidden-key sentinel: if any top-level forbidden key exists, we
  // simply do not copy it to the output. This is implicit in the
  // allowlist filter below, but we also touch every nested object
  // through the per-field reducers.
  const sanitised: RoutingDecisionTrace = {
    traceId: typeof raw.traceId === 'string' ? scrubString(raw.traceId) : '',
    requestId:
      typeof raw.requestId === 'string' ? scrubString(raw.requestId) : '',
    timestamp:
      typeof raw.timestamp === 'string'
        ? raw.timestamp
        : new Date(0).toISOString(),
    routingMode: validRoutingMode(raw.routingMode),

    taskProfile: redactTaskProfile(raw.taskProfile),

    semanticIndexBackend: validBackend(raw.semanticIndexBackend),
    candidatesEvaluated:
      typeof raw.candidatesEvaluated === 'number' &&
      Number.isFinite(raw.candidatesEvaluated)
        ? raw.candidatesEvaluated
        : 0,
    candidatesByStage: redactStringRecord(raw.candidatesByStage),
    rejectedByStage: redactRejected(raw.rejectedByStage),

    selectedCanonicalModelId:
      typeof raw.selectedCanonicalModelId === 'string'
        ? scrubString(raw.selectedCanonicalModelId)
        : null,
    selectedOfferingId:
      typeof raw.selectedOfferingId === 'string'
        ? scrubString(raw.selectedOfferingId)
        : null,
    selectedRouteId:
      typeof raw.selectedRouteId === 'string'
        ? scrubString(raw.selectedRouteId)
        : null,

    scoreBreakdown: redactStringRecord(raw.scoreBreakdown),

    strategyPlan: redactStrategyPlan(raw.strategyPlan),

    explicitModelPin: redactPin(raw.explicitModelPin),
    pinSubstitution: redactSubstitution(raw.pinSubstitution),

    latencyByPhase: redactStringRecord(raw.latencyByPhase),

    outcomeStatus: validOutcomeStatus(raw.outcomeStatus),
    outcomeLatencyMs:
      typeof raw.outcomeLatencyMs === 'number' &&
      Number.isFinite(raw.outcomeLatencyMs)
        ? raw.outcomeLatencyMs
        : undefined,
    paretoSummary: redactParetoSummary(raw.paretoSummary),
  };

  // Sanity: drop optional fields that are undefined so JSON output is clean.
  if (sanitised.outcomeStatus === undefined) {
    delete (sanitised as { outcomeStatus?: unknown }).outcomeStatus;
  }
  if (sanitised.outcomeLatencyMs === undefined) {
    delete (sanitised as { outcomeLatencyMs?: unknown }).outcomeLatencyMs;
  }
  if (sanitised.paretoSummary === undefined) {
    delete (sanitised as { paretoSummary?: unknown }).paretoSummary;
  }

  return sanitised;
}

// ─── Pareto summary redactor (MVP 8B) ───────────────────────────────────

function redactParetoSummary(input: unknown): ParetoTraceSummary | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  return Object.freeze({
    paretoStatus:
      typeof raw.paretoStatus === 'string' ? scrubString(raw.paretoStatus) : 'unknown',
    baselineSingleJudge: numericOrZero(raw.baselineSingleJudge),
    baselineSingleCostUsd: numericOrZero(raw.baselineSingleCostUsd),
    expectedEnsembleJudge: numericOrZero(raw.expectedEnsembleJudge),
    expectedEnsembleCostUsd: numericOrZero(raw.expectedEnsembleCostUsd),
    expectedQualityPerDollar: numericOrZero(raw.expectedQualityPerDollar),
    selectedModelIds: scrubStringArray(raw.selectedModelIds),
    selectedRouteIds: scrubStringArray(raw.selectedRouteIds),
    ensembleExplanation:
      typeof raw.ensembleExplanation === 'string'
        ? scrubString(raw.ensembleExplanation)
        : '',
    marginalContributions: redactMarginalArray(raw.marginalContributions),
    rejectedCandidates: redactRejectedArray(raw.rejectedCandidates),
    structuralPlanSummary: redactPlanSummary(raw.structuralPlanSummary),
    paretoPlanSummary: redactPlanSummary(raw.paretoPlanSummary),
    finalPlanSource: validFinalPlanSource(raw.finalPlanSource),
  });
}

function numericOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function scrubStringArray(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') out.push(scrubString(item));
  }
  return Object.freeze(out);
}

function redactMarginalArray(v: unknown): readonly ParetoTraceMarginalRecord[] {
  if (!Array.isArray(v)) return [];
  const out: ParetoTraceMarginalRecord[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    out.push({
      modelId: typeof r.modelId === 'string' ? scrubString(r.modelId) : '',
      marginalQualityGain: numericOrZero(r.marginalQualityGain),
      marginalCostUsd: numericOrZero(r.marginalCostUsd),
      accepted: r.accepted === true,
      reason: typeof r.reason === 'string' ? scrubString(r.reason) : '',
    });
  }
  return Object.freeze(out);
}

function redactRejectedArray(v: unknown): readonly ParetoTraceRejectedRecord[] {
  if (!Array.isArray(v)) return [];
  const out: ParetoTraceRejectedRecord[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    out.push({
      modelId: typeof r.modelId === 'string' ? scrubString(r.modelId) : '',
      reason: typeof r.reason === 'string' ? scrubString(r.reason) : '',
    });
  }
  return Object.freeze(out);
}

function redactPlanSummary(v: unknown): ParetoTracePlanSummary {
  if (!v || typeof v !== 'object') {
    return Object.freeze({ strategy: 'unknown', routes: Object.freeze([]) });
  }
  const r = v as Record<string, unknown>;
  return Object.freeze({
    strategy: typeof r.strategy === 'string' ? scrubString(r.strategy) : 'unknown',
    routes: scrubStringArray(r.routes),
  });
}

function validFinalPlanSource(v: unknown): ParetoTraceSummary['finalPlanSource'] {
  if (v === 'pareto' || v === 'single_fallback' || v === 'original_strategy') return v;
  return 'original_strategy';
}

function validRoutingMode(v: unknown): RoutingDecisionTrace['routingMode'] {
  if (
    v === 'legacy' ||
    v === 'registry_cache' ||
    v === 'shadow_trace_only' ||
    v === 'shadow_registry_only' ||
    v === 'shadow_structural_full' ||
    v === 'shadow_semantic_full' ||
    v === 'semantic_primary'
  ) {
    return v;
  }
  return 'legacy';
}

function validBackend(v: unknown): RoutingDecisionTrace['semanticIndexBackend'] {
  if (
    v === 'none' ||
    v === 'linear' ||
    v === 'hnsw' ||
    v === 'pgvector' ||
    v === 'sidecar'
  ) {
    return v;
  }
  return 'none';
}

function validOutcomeStatus(
  v: unknown,
): RoutingDecisionTrace['outcomeStatus'] | undefined {
  if (v === 'success' || v === 'fallback' || v === 'error') return v;
  return undefined;
}

function buildEmptyTrace(): RoutingDecisionTrace {
  return {
    traceId: '',
    requestId: '',
    timestamp: new Date(0).toISOString(),
    routingMode: 'legacy',
    taskProfile: {
      taskType: 'unknown',
      complexity: 'unknown',
      modalities: [],
      riskLevel: 'unknown',
      privacyMode: 'unknown',
    },
    semanticIndexBackend: 'none',
    candidatesEvaluated: 0,
    candidatesByStage: {},
    rejectedByStage: [],
    selectedCanonicalModelId: null,
    selectedOfferingId: null,
    selectedRouteId: null,
    scoreBreakdown: {},
    strategyPlan: { strategy: 'unknown', routes: [] },
    explicitModelPin: null,
    pinSubstitution: null,
    latencyByPhase: {},
  };
}

// ─── Test seam ──────────────────────────────────────────────────────────

/**
 * Exported helpers so the redaction unit tests can probe corner cases
 * without going through the full trace path.
 */
export const __forTesting = {
  scrubString,
  isPhoneCandidate,
  EMAIL_REGEX,
  PHONE_REGEX,
  REDACTION_TOKEN,
  ROUTING_TRACE_ALLOWED_KEYS,
  ROUTING_TRACE_FORBIDDEN_KEYS,
};
