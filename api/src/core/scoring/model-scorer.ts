// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * model-scorer.ts — structural multi-objective scorer.
 *
 * MVP 4 invariants (enforced by tests):
 *   - Pure function. No I/O. No DB. No providers. No TEI. No HNSW.
 *   - DETERMINISTIC. Same input ⇒ same output. No Date.now(),
 *     no Math.random(), no Map-iteration-dependent ordering.
 *   - NO pattern matching on names, NO substring tests, NO hardcoded
 *     family-name lists as decision inputs. Capability matching is done
 *     via a structural map of capability URI → route supports* flag.
 *   - Honors the Explicit Model Pin Invariant — when a pin is set, the
 *     scorer evaluates only the pinned route and NEVER substitutes.
 *
 * The scorer scores ONE candidate. The caller (a future MVP)
 * applies the scorer over a candidate set and sorts. Determinism per
 * candidate is what's guaranteed here.
 */

import type { CanonicalModel } from '../registry/canonical-model';
import type { ModelProviderOffering } from '../registry/model-offering';
import type { ProviderModelRoute } from '../registry/model-route';
import type {
  ExplicitPinInfo,
  PrivacyMode,
} from '../registry/types';
import {
  scoreFreshness,
  type FreshnessLifecycle,
} from './freshness-scorer';
import {
  applyWeights,
  zeroBreakdown,
  type ScoreBreakdown,
} from './score-breakdown';
import {
  DEFAULT_SCORING_POLICY,
  costSensitivityToWeightMultiplier,
  latencySensitivityToWeightMultiplier,
  type Sensitivity,
  type ScoringPolicy,
} from './scoring-policy';

// ─── Capability URI → ProviderModelRoute boolean flag map ───────────────
//
// Structural lookup so the scorer never needs to inspect model NAMES.
// Each entry says: "if this capability URI is required, check this
// boolean field on the route." Multiple URIs may map to the same flag.

const CAPABILITY_URI_TO_ROUTE_FLAG: ReadonlyMap<
  string,
  keyof ProviderModelRoute
> = new Map<string, keyof ProviderModelRoute>([
  ['streaming', 'supportsStreaming'],
  ['tools', 'supportsTools'],
  ['function_calling', 'supportsTools'],
  ['function-calling', 'supportsTools'],
  ['json_mode', 'supportsJson'],
  ['json', 'supportsJson'],
  ['vision', 'supportsVision'],
  ['image_understanding', 'supportsVision'],
  ['image-understanding', 'supportsVision'],
  ['image_generation', 'supportsImages'],
  ['image-generation', 'supportsImages'],
  ['image_edit', 'supportsImages'],
  ['image-edit', 'supportsImages'],
  ['audio_generation', 'supportsAudio'],
  ['audio-generation', 'supportsAudio'],
  ['text_to_speech', 'supportsAudio'],
  ['text-to-speech', 'supportsAudio'],
  ['speech_to_text', 'supportsAudio'],
  ['speech-to-text', 'supportsAudio'],
]);

const SELF_HOSTED_KINDS: ReadonlySet<string> = new Set([
  'local',
  'self_hosted',
]);

// ─── Inputs ─────────────────────────────────────────────────────────────

export interface ModelScoringCandidate {
  readonly canonicalModel: CanonicalModel;
  readonly offering: ModelProviderOffering;
  readonly route: ProviderModelRoute;
}

export interface ModelScoringContext {
  readonly requiredCapabilities?: ReadonlyArray<string>;
  readonly minContextWindow?: number;
  readonly costSensitivity?: Sensitivity;
  readonly latencySensitivity?: Sensitivity;
  readonly privacyMode?: PrivacyMode;
  readonly explicitModelPin?: ExplicitPinInfo | null;
  readonly policy?: ScoringPolicy;
}

// ─── Output ─────────────────────────────────────────────────────────────

export interface ModelScoreResult {
  readonly routeId: string;
  readonly canonicalModelId: string;
  readonly offeringId: string;
  readonly totalScore: number;
  readonly breakdown: ScoreBreakdown;
  readonly rejected: boolean;
  readonly rejectionReasons: ReadonlyArray<string>;
  readonly freshnessStatus: string;
}

// ─── Helper: capability fitness via structural lookup ───────────────────

interface CapabilityFitness {
  readonly fit: number;
  readonly missing: ReadonlyArray<string>;
}

function capabilityFitness(
  route: ProviderModelRoute,
  required: ReadonlyArray<string>,
): CapabilityFitness {
  if (required.length === 0) return { fit: 1, missing: [] };
  let satisfied = 0;
  const missing: string[] = [];
  for (const cap of required) {
    const key = String(cap).toLowerCase();
    if (key === 'chat') {
      // Chat is the baseline — registry only carries chat-capable routes
      // (PoolBuilder is responsible elsewhere). Count it as satisfied.
      satisfied += 1;
      continue;
    }
    const flag = CAPABILITY_URI_TO_ROUTE_FLAG.get(key);
    if (flag !== undefined && route[flag] === true) {
      satisfied += 1;
      continue;
    }
    missing.push(cap);
  }
  return { fit: satisfied / required.length, missing };
}

// ─── Helper: normalise (lower is better → score) ────────────────────────

function inverseNormalize(
  value: number | null,
  ceiling: number,
  fallback: number,
): number {
  if (value === null || !Number.isFinite(value)) return fallback;
  if (ceiling <= 0) return fallback;
  const ratio = value / ceiling;
  return clamp01(1 - ratio);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ─── Helper: lifecycle adapter ──────────────────────────────────────────

function asFreshnessLifecycle(
  lc: CanonicalModel['lifecycle'],
): FreshnessLifecycle {
  // CanonicalLifecycle from MVP 1: 'preview' | 'current' | 'deprecated' | 'retired'.
  // FreshnessLifecycle accepts those plus 'legacy' and 'unknown'.
  return lc;
}

// ─── Helper: pin invariant ──────────────────────────────────────────────

interface PinDecision {
  readonly matchesPin: boolean;
  readonly rejectionReason: string | null;
}

function evaluatePin(
  candidate: ModelScoringCandidate,
  pin: ExplicitPinInfo,
): PinDecision {
  // Match by routeId first (most specific).
  if (pin.routeId) {
    if (candidate.route.routeId !== pin.routeId) {
      return {
        matchesPin: false,
        rejectionReason: 'explicit_pin_route_mismatch',
      };
    }
    return { matchesPin: true, rejectionReason: null };
  }
  // Then offeringId.
  if (pin.offeringId) {
    if (candidate.offering.offeringId !== pin.offeringId) {
      return {
        matchesPin: false,
        rejectionReason: 'explicit_pin_offering_mismatch',
      };
    }
    return { matchesPin: true, rejectionReason: null };
  }
  // Then canonicalModelId.
  if (pin.canonicalModelId) {
    if (candidate.canonicalModel.canonicalModelId !== pin.canonicalModelId) {
      return {
        matchesPin: false,
        rejectionReason: 'explicit_pin_canonical_mismatch',
      };
    }
    return { matchesPin: true, rejectionReason: null };
  }
  // Pin set but no identifier — treat as no constraint (defensive).
  return { matchesPin: true, rejectionReason: null };
}

// ─── Main scorer ────────────────────────────────────────────────────────

/**
 * Scores a single candidate. Returns a `ModelScoreResult` with a full
 * breakdown plus a `rejected` flag. The caller decides what to do with
 * rejected candidates (skip, audit, fall back).
 *
 * Determinism: this function references no clock, no random, no Map
 * iteration where ordering matters. The output depends ONLY on the
 * input (candidate + context + policy).
 */
export function scoreModelCandidate(
  candidate: ModelScoringCandidate,
  context: ModelScoringContext = {},
): ModelScoreResult {
  const policy = context.policy ?? DEFAULT_SCORING_POLICY;
  const reasons: string[] = [];

  // ─── Pin invariant — evaluated FIRST ─────────────────────────────────
  if (context.explicitModelPin) {
    const pinDecision = evaluatePin(candidate, context.explicitModelPin);
    if (!pinDecision.matchesPin) {
      // Rejected because the candidate is not the pinned one. The
      // scorer NEVER substitutes — the caller may either fall back via
      // explicit policy, or surface the failure.
      reasons.push(pinDecision.rejectionReason!);
      return {
        routeId: candidate.route.routeId,
        canonicalModelId: candidate.canonicalModel.canonicalModelId,
        offeringId: candidate.offering.offeringId,
        totalScore: 0,
        breakdown: zeroBreakdown(),
        rejected: true,
        rejectionReasons: Object.freeze(reasons),
        freshnessStatus: 'unknown',
      };
    }
  }

  // ─── Privacy: local_required forces local/self_hosted ────────────────
  const privacyMode = context.privacyMode ?? 'standard';
  if (privacyMode === 'local_required') {
    if (!SELF_HOSTED_KINDS.has(candidate.route.routeKind)) {
      reasons.push('privacy_local_required_but_route_is_external');
      return {
        routeId: candidate.route.routeId,
        canonicalModelId: candidate.canonicalModel.canonicalModelId,
        offeringId: candidate.offering.offeringId,
        totalScore: 0,
        breakdown: zeroBreakdown(),
        rejected: true,
        rejectionReasons: Object.freeze(reasons),
        freshnessStatus: 'unknown',
      };
    }
  }

  // ─── Required-capability hard filter ─────────────────────────────────
  const required = context.requiredCapabilities ?? [];
  const capFit = capabilityFitness(candidate.route, required);
  if (capFit.fit < policy.thresholds.minCapabilityFit) {
    for (const cap of capFit.missing) {
      reasons.push(`required_capability_missing:${cap}`);
    }
  }

  // ─── minContextWindow hard filter ────────────────────────────────────
  let contextFitScore = 1;
  if (context.minContextWindow && context.minContextWindow > 0) {
    if (candidate.route.contextWindow < context.minContextWindow) {
      reasons.push(
        `context_window_below_min:${candidate.route.contextWindow}<${context.minContextWindow}`,
      );
      contextFitScore = 0;
    } else {
      contextFitScore = 1;
    }
  }

  // ─── Freshness (couples lifecycle + readiness) ───────────────────────
  const freshness = scoreFreshness({
    family: candidate.canonicalModel.family,
    version: candidate.canonicalModel.version,
    generationRank: candidate.canonicalModel.generationRank,
    releaseDate: candidate.canonicalModel.releaseDate,
    lifecycle: asFreshnessLifecycle(candidate.canonicalModel.lifecycle),
    routeReadiness: {
      healthState: candidate.route.healthState,
      creditStatus: candidate.route.creditStatus,
      minimalChatStatus: candidate.route.minimalChatStatus,
    },
    policy: {
      allowPreview: policy.freshness.allowPreview,
      allowDeprecated: policy.freshness.allowDeprecated,
    },
  });

  // Freshness score of 0 with status≠current_and_routable means a hard gate
  // failed. The candidate is rejected.
  const freshnessBlocked = freshness.score === 0 && !!freshness.status;
  if (freshnessBlocked) {
    reasons.push(`freshness_blocked:${freshness.reason}`);
  }

  // ─── Route reliability ───────────────────────────────────────────────
  const reliability = clamp01(candidate.route.successRateWindow);

  // ─── Latency scoring (lower is better) ───────────────────────────────
  // Use a 5000 ms ceiling — anything above is considered "bad".
  const latencyScore = inverseNormalize(
    candidate.route.latencyP95Ms,
    5_000,
    /* fallback when unknown */ 0.5,
  );

  // ─── Cost efficiency (cheaper is better) ─────────────────────────────
  // Ceiling: $50 per 1M tokens. Beyond that → 0.
  const totalCostPer1M =
    candidate.route.inputCostPer1M + candidate.route.outputCostPer1M;
  const costEfficiency = inverseNormalize(
    totalCostPer1M,
    50,
    /* fallback */ 0.5,
  );

  // ─── Local preference boost ──────────────────────────────────────────
  let localPreference = 0;
  if (privacyMode === 'local_preferred' && SELF_HOSTED_KINDS.has(candidate.route.routeKind)) {
    localPreference = 1;
  } else if (privacyMode === 'local_required') {
    localPreference = 1;
  }

  // ─── Risk penalty ────────────────────────────────────────────────────
  // Preview lifecycle → penalty. Deprecated/legacy already handled by
  // freshness (which zeroes the score when not allowed).
  const riskPenalty =
    candidate.canonicalModel.lifecycle === 'preview' ? 0.5 : 0;

  // ─── Build breakdown ─────────────────────────────────────────────────
  const breakdown: ScoreBreakdown = {
    capabilityFit: capFit.fit,
    freshness: freshness.score,
    routeReliability: reliability,
    latencyScore,
    costEfficiency,
    contextFit: contextFitScore,
    localPreference,
    riskPenalty,
  };

  // ─── Apply sensitivity multipliers ───────────────────────────────────
  let weights = policy.weights;
  if (context.costSensitivity) {
    weights = {
      ...weights,
      costEfficiency:
        weights.costEfficiency * costSensitivityToWeightMultiplier(context.costSensitivity),
    };
  }
  if (context.latencySensitivity) {
    weights = {
      ...weights,
      latencyScore:
        weights.latencyScore * latencySensitivityToWeightMultiplier(context.latencySensitivity),
    };
  }

  // ─── Total ───────────────────────────────────────────────────────────
  const totalScore = applyWeights(breakdown, weights);

  // ─── Decide rejection ────────────────────────────────────────────────
  const rejected = reasons.length > 0;

  return {
    routeId: candidate.route.routeId,
    canonicalModelId: candidate.canonicalModel.canonicalModelId,
    offeringId: candidate.offering.offeringId,
    totalScore: rejected ? 0 : totalScore,
    breakdown: rejected ? zeroBreakdown() : breakdown,
    rejected,
    rejectionReasons: Object.freeze(reasons),
    freshnessStatus: freshness.status,
  };
}
