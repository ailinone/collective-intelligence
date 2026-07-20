// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Role-Based Model Discovery — types.
 *
 * The contract a ConsensusStrategy (and future strategies) uses to ask
 * "give me N models for role X, under these constraints". The resolver
 * is responsible for the policy + filtering + ranking; consumers see
 * only the selected list, the rejected list (with reasons), and a
 * detailed trace.
 */
import type { Model, ModelCapability, TaskType } from '@/types';

/**
 * Execution roles that a strategy may need to fill.
 *
 * - `participant`: a voter / candidate solver in a collective strategy
 * - `leader` / `synthesizer`: combines participants' outputs
 * - `observer` / `critic` / `reviewer`: evaluates / challenges
 * - `judge`: third-party evaluator (rubric scoring) — independent
 * - `fallback_single`: best single-model baseline + fallback target
 */
export type StrategyModelRole =
  | 'participant'
  | 'leader'
  | 'synthesizer'
  | 'observer'
  | 'critic'
  | 'reviewer'
  | 'judge'
  | 'fallback_single';

/**
 * What we know about a candidate at resolution time. Wraps `Model`
 * with operability signals; the resolver works with this shape so it
 * doesn't have to call the operability hub per candidate inside a
 * filter loop.
 */
export interface ModelCandidate {
  readonly model: Model;
  readonly providerId: string;
  readonly providerHealthy: boolean;
  readonly hasCredits: boolean;
  readonly rateLimited: boolean;
  readonly isLocal: boolean;
  readonly estimatedCostPerCallUsd: number;
  readonly notes?: readonly string[];
}

export interface TaskProfile {
  readonly taskType?: TaskType | string;
  readonly complexity?: 'low' | 'medium' | 'high';
  readonly userMessageExcerpt?: string;
  readonly expectedFormat?: 'json' | 'code' | 'reasoning' | 'free_text';
  readonly approximateInputTokens?: number;
  readonly approximateOutputTokens?: number;
}

export interface RoleConstraints {
  readonly maxCostUsd?: number;
  readonly maxLatencyMs?: number;
  readonly minContextWindow?: number;
  readonly requiredCapabilities?: readonly (ModelCapability | string)[];
  readonly preferredCapabilities?: readonly (ModelCapability | string)[];
  readonly requireJsonOutput?: boolean;
  readonly allowLocal?: boolean;
  readonly preferLocal?: boolean;
  readonly requireLocal?: boolean;
  readonly excludeModelIds?: readonly string[];
  readonly excludeProviderIds?: readonly string[];
  /** How many candidates to return. If unset, role-default applies. */
  readonly count?: number;
}

export interface ModelRoleResolutionInput {
  readonly taskProfile: TaskProfile;
  readonly strategyName: string;
  readonly role: StrategyModelRole;
  /** If provided, the resolver works only over this pool. If absent,
   *  the resolver pulls from the catalog reader. */
  readonly candidatePool?: readonly ModelCandidate[];
  readonly constraints: RoleConstraints;
  /**
   * 01C.1B-J2 — Optional quality calibration snapshot.
   *
   * When provided, the synthesizer scorer uses real benchmarked quality
   * from this snapshot (matched by modelId or canonicalModelId) instead
   * of the catalog placeholder. The snapshot's hash also enters the
   * planFingerprint so runtime cannot silently substitute snapshots.
   *
   * When absent, the scorer falls back to catalog `performance.quality`
   * with an explicit `qualityScoreSource='placeholder'` annotation in
   * the trace (so consumers know the score is unreliable).
   *
   * The snapshot is `readonly` and never mutated by the resolver.
   */
  readonly modelQualityCalibrationSnapshot?: import('../role-selection/model-quality-calibration').ModelQualityCalibrationSnapshot;

  /**
   * 01C.1B-J1D-R4C — Optional dynamic-context policy.
   *
   * When `enabled: true`, the resolver:
   *   1. Uses `resolveEffectiveContextMetadata(...)` to apply
   *      `overrides[]` from a backfill artifact on top of catalog
   *      `contextWindow`. This lets the runtime see correct context
   *      sizes for models the catalog underestimates (e.g., deepinfra
   *      catalog says 8192 for claude-opus-4-7, real is 200000).
   *   2. Uses `computeDynamicContextBudget(...)` to derive
   *      `minContextWindow` from the plan (participantCount,
   *      maxOutputTokens, prompt size, safety margin) INSTEAD of the
   *      static `contextWindowMin: 32000/16000` constants in
   *      `model-role-policy.ts`.
   *
   * When absent or `enabled: false`, behavior is identical to pre-R4C.
   * The pre-R4C planFingerprint hash is preserved bit-exact for callers
   * that never opt into the new policy.
   */
  readonly contextPolicy?: import('./dynamic-context-budget').DynamicContextBudgetInput & {
    readonly enabled: boolean;
    readonly overrides?: ReadonlyArray<
      import('./effective-context-metadata').ContextMetadataOverride
    >;
    readonly backfillHash?: string;
    /** When true, attach per-candidate trace entries to the result
     *  describing effectiveContextWindow + minContextWindow + match
     *  details. Default false to keep the resolver lean by default. */
    readonly includeTrace?: boolean;
  };

  /**
   * 01C.1B-J1D-R4D — Optional judge eligibility policy.
   *
   * When `useJudgeStructuredOutputNormalization=true`, the resolver
   * REPLACES the narrow `json_mode || function_calling || tool_use`
   * capability check (which was producing `json_output_not_supported`
   * for every live-ready candidate, since the runtime catalog records
   * only `chat`/`text_generation`/`streaming` for Claude/DeepSeek/etc.)
   * with the broader `detectStructuredOutputSupport(...)` classifier.
   *
   * Default off preserves pre-R4D behavior bit-exact.
   *
   * Only applies to `role === 'judge'`; participants/synthesizer/
   * fallback paths remain untouched.
   */
  readonly judgeEligibilityPolicy?: {
    readonly enabled: boolean;
    readonly useJudgeStructuredOutputNormalization: boolean;
    readonly allowWeakStructuredOutputForJudge?: boolean;
    readonly structuredOutputBackfill?: ReadonlyArray<
      import('./structured-output-capability').StructuredOutputBackfillEntry
    >;
    readonly structuredOutputBackfillHash?: string;
    readonly fullRegistryExpansionEnabled?: boolean;
    readonly expansionSource?: string;
    /** When true, attach per-candidate trace entries describing the
     *  structured-output classification + reason. Default false to
     *  keep the resolver lean by default. */
    readonly includeTrace?: boolean;
  };

  /**
   * 01C.1B-J2-C-R5 — Optional quality coverage policy.
   *
   * When `useQualityIdentityResolver === true`, the resolver replaces the
   * exact-string `findEntry` snapshot lookup with the broader
   * `matchQualitySnapshotEntry` resolver. The new matcher uses the
   * `deriveQualityModelIdentity` helper (provider-wrapper strip + alias
   * normalization + family fallback) so runtime ids in any of the four
   * formats (provider-wrapped / vendor-prefixed / canonical / display)
   * find their snapshot entry.
   *
   * `requireNoCatalogFallbackForSelected` enforces that every selected
   * candidate has a snapshot match (any source — external_benchmark or
   * inferred_family_default). Candidates rejected with
   * `catalog_fallback_quality_blocked` reason if violated.
   */
  readonly qualityPolicy?: {
    readonly enabled: boolean;
    readonly version?: string;
    readonly qualitySnapshotHash?: string;
    readonly useQualityIdentityResolver: boolean;
    readonly requireNoCatalogFallbackForSelected?: boolean;
    readonly allowFamilyInferenceForSelected?: boolean;
    /** Per-candidate trace inclusion. Default false. */
    readonly includeTrace?: boolean;
  };
}

export interface RejectedCandidate {
  readonly modelId: string;
  readonly providerId?: string;
  readonly reason: string;
}

export interface ModelRoleResolutionResult {
  readonly role: StrategyModelRole;
  readonly selected: readonly ModelCandidate[];
  readonly rejected: readonly RejectedCandidate[];
  readonly trace: ModelRoleSelectionTrace;
  /**
   * 01C.1B-J1G-R0 §8 — Synthesizer-specific selection explainability.
   * Only populated when `role === 'synthesizer'` (the only role using
   * the hybrid scorer at present). All other roles leave this undefined.
   * Safe to include in `consensusPlan` and serialize — contains no secrets.
   */
  readonly synthesizerSelectionSummary?: SynthesizerSelectionSummary;
}

/** Per-candidate compact projection of the hybrid scorer's breakdown. */
export interface SynthesizerScoredEntry {
  readonly modelId: string;
  readonly providerId: string;
  readonly providerCoverageCount: number;
  readonly finalScore: number;
  readonly qualityFloorPassed: boolean;
  readonly selected: boolean;
}

export interface SynthesizerSelectionSummary {
  /** Policy version tag so downstream `planFingerprint` can detect changes. */
  readonly policyVersion: string;
  readonly qualityFloor: number;
  readonly poolSize: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly winner: SynthesizerScoredEntry | null;
  readonly topAlternatives: readonly SynthesizerScoredEntry[];
  /**
   * Histogram of rejection reasons (`quality_below_floor`, etc.) for
   * post-hoc analysis. Counts only — no model ids.
   */
  readonly rejectionsByReason: Readonly<Record<string, number>>;
  /** Stable hash of the candidate pool ids (for plan parity / cache). */
  readonly candidatePoolHash: string;
  /** Optional component breakdown of the winner, for deep audit views. */
  readonly winnerComponentBreakdown?: Readonly<Record<string, number>>;
  /**
   * 01C.1B-J2 §15 — Quality snapshot integration metadata.
   *
   * Populated when caller passed a `modelQualityCalibrationSnapshot` to
   * the resolver. Captures which candidates were calibrated vs fallback
   * placeholder so consumers can audit the quality signal provenance.
   *
   * `qualitySnapshotEntryFound` is a per-candidate map (modelId → bool)
   * letting traces show which models had real benchmark backing.
   */
  readonly qualitySnapshotMetadata?: {
    readonly snapshotVersion: string;
    readonly snapshotHash: string;
    readonly snapshotEntryCount: number;
    readonly candidatesMatched: number;
    readonly candidatesFallbackToPlaceholder: number;
    readonly winnerQualityScoreSource: import('../role-selection/model-quality-calibration').ModelQualityScoreSource | 'catalog_fallback';
    readonly winnerQualityConfidence: import('../role-selection/model-quality-calibration').ModelQualityConfidence | 'catalog_fallback';
  };
}

// ─── Trace types (declared here for compactness; consumers re-export) ─

export type FilterStage =
  | 'capability'
  | 'health'
  | 'credits'
  | 'rate_limit'
  | 'cost'
  | 'context_window'
  | 'locality'
  | 'exclusions'
  | 'role_specific';

export interface ModelRoleSelectionTrace {
  readonly role: StrategyModelRole;
  readonly strategyName: string;
  readonly inputCandidateCount: number;
  readonly stageCounts: Readonly<Record<FilterStage, number>>;
  readonly finalSelectedCount: number;
  readonly selectionSource: 'dynamic' | 'explicit_override' | 'fallback';
  readonly semanticSearchStatus:
    | 'used'
    | 'disabled'
    | 'source_unavailable'
    | 'not_applicable';
  readonly registrySourceStatus: 'pool_provided' | 'catalog' | 'source_unavailable';
  readonly providerHealthStatus: 'available' | 'source_unavailable';
  readonly pricingStatus: 'available' | 'source_unavailable';
  readonly hardcodedModelUsed: false;
  readonly criteria: readonly string[];
  readonly notes: readonly string[];
}
