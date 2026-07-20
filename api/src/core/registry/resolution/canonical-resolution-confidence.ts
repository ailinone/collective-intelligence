// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * canonical-resolution-confidence.ts — pure resolver function.
 *
 * MVP 4 invariants:
 *   - Pure function. No I/O. No DB. No providers.
 *   - Deterministic.
 *   - Does NOT perform automatic merging — only computes confidence per
 *     `(providerId, providerModelId)`. The actual merge decision is made
 *     by a future caller using `canAutoMerge`.
 *
 * Precedence (highest wins; first hit returns):
 *   1. manual_override
 *   2. declared_alias
 *   3. provider_metadata (confidence ≥ 0.85)
 *   4. exact_normalized_name
 *   5. heuristic_family_version (confidence ≥ 0.5, must be ≥ 0.7 to merge)
 *   6. model_equivalence_service (variable confidence)
 *   7. fallback_provider_model_id (confidence 0, never merges)
 */

import type {
  CanonicalResolutionConfidence,
} from './canonical-resolution-types';
import {
  CANONICAL_SOURCE_AUTHORITY,
  FALLBACK_RESOLUTION_CONFIDENCE,
  MIN_CONFIDENCE_FOR_AUTO_MERGE,
} from './canonical-resolution-types';

// ─── Resolver input ─────────────────────────────────────────────────────

export interface ManualOverrideSignal {
  readonly canonicalModelId: string;
  readonly operator: string;
}

export interface DeclaredAliasSignal {
  readonly canonicalModelId: string;
}

export interface ProviderMetadataSignal {
  readonly canonicalModelId: string;
  /** Provider self-declared confidence in [0, 1]. */
  readonly confidence: number;
}

export interface ExactNormalizedNameSignal {
  readonly canonicalModelId: string;
}

export interface HeuristicFamilyVersionSignal {
  readonly canonicalModelId: string;
  /** Heuristic-derived confidence in [0, 1]. */
  readonly confidence: number;
}

export interface ModelEquivalenceServiceSignal {
  readonly canonicalModelId: string;
  /** Cosine similarity / equivalence service confidence in [0, 1]. */
  readonly confidence: number;
}

export interface CanonicalResolutionInput {
  readonly providerModelId: string;
  readonly servingProviderId: string;

  // Optional signals, evaluated in precedence order.
  readonly manualOverride?: ManualOverrideSignal;
  readonly declaredAlias?: DeclaredAliasSignal;
  readonly providerMetadata?: ProviderMetadataSignal;
  readonly exactNormalizedName?: ExactNormalizedNameSignal;
  readonly heuristicFamilyVersion?: HeuristicFamilyVersionSignal;
  readonly modelEquivalenceService?: ModelEquivalenceServiceSignal;
}

// ─── Resolver function ──────────────────────────────────────────────────

/**
 * Computes the highest-authority `CanonicalResolutionConfidence` for
 * the given inputs. NEVER merges automatically — the returned record
 * is a STATEMENT of confidence; the caller decides what to do with it
 * via `canAutoMerge` and conflict tracking.
 */
export function resolveCanonicalConfidence(
  input: CanonicalResolutionInput,
): CanonicalResolutionConfidence {
  // 1. Manual override — absolute authority.
  if (input.manualOverride) {
    return {
      canonicalModelId: input.manualOverride.canonicalModelId,
      providerModelId: input.providerModelId,
      confidence: 1.0,
      source: 'manual_override',
      reason: `manual_override_by:${input.manualOverride.operator}`,
    };
  }

  // 2. Declared alias.
  if (input.declaredAlias) {
    return {
      canonicalModelId: input.declaredAlias.canonicalModelId,
      providerModelId: input.providerModelId,
      confidence: 1.0,
      source: 'declared_alias',
      reason: 'declared_in_alias_table',
    };
  }

  // 3. Provider metadata (only when provider explicitly tells us).
  if (input.providerMetadata && input.providerMetadata.confidence >= 0.85) {
    return {
      canonicalModelId: input.providerMetadata.canonicalModelId,
      providerModelId: input.providerModelId,
      confidence: clamp01(input.providerMetadata.confidence),
      source: 'provider_metadata',
      reason: 'provider_self_declared',
    };
  }

  // 4. Exact normalised-name match.
  if (input.exactNormalizedName) {
    return {
      canonicalModelId: input.exactNormalizedName.canonicalModelId,
      providerModelId: input.providerModelId,
      confidence: 0.85,
      source: 'exact_normalized_name',
      reason: 'normalized_name_match',
    };
  }

  // 5. Heuristic family + version parse.
  if (input.heuristicFamilyVersion) {
    return {
      canonicalModelId: input.heuristicFamilyVersion.canonicalModelId,
      providerModelId: input.providerModelId,
      confidence: clamp01(input.heuristicFamilyVersion.confidence),
      source: 'heuristic_family_version',
      reason: `heuristic_confidence_${input.heuristicFamilyVersion.confidence.toFixed(2)}`,
    };
  }

  // 6. Equivalence service (probabilistic — advisory only).
  if (input.modelEquivalenceService) {
    return {
      canonicalModelId: input.modelEquivalenceService.canonicalModelId,
      providerModelId: input.providerModelId,
      confidence: clamp01(input.modelEquivalenceService.confidence),
      source: 'model_equivalence_service',
      reason: `cosine_sim_${input.modelEquivalenceService.confidence.toFixed(2)}`,
    };
  }

  // 7. Fallback: treat as its own canonical.
  return {
    canonicalModelId: `${input.servingProviderId}:${input.providerModelId}`,
    providerModelId: input.providerModelId,
    confidence: FALLBACK_RESOLUTION_CONFIDENCE,
    source: 'fallback_provider_model_id',
    reason: 'no_match_found',
  };
}

// ─── Decision helpers ───────────────────────────────────────────────────

/**
 * Returns true if the confidence is high enough to AUTO-MERGE the
 * resolution with an existing canonical model. Confidence < 0.7 is
 * NEVER merged automatically — caller must keep the resolution as a
 * separate canonical OR escalate to an audit (`conflictGroupId`).
 */
export function canAutoMerge(c: CanonicalResolutionConfidence): boolean {
  return c.confidence >= MIN_CONFIDENCE_FOR_AUTO_MERGE;
}

/**
 * Returns the "winning" resolution when two records compete for the
 * same `(providerId, providerModelId)`. Authority wins; on equal
 * authority, the higher-confidence record wins; on equal confidence,
 * the LEFT record wins (deterministic — first-seen).
 */
export function pickHigherAuthority(
  a: CanonicalResolutionConfidence,
  b: CanonicalResolutionConfidence,
): CanonicalResolutionConfidence {
  const authA = CANONICAL_SOURCE_AUTHORITY[a.source] ?? 0;
  const authB = CANONICAL_SOURCE_AUTHORITY[b.source] ?? 0;
  if (authA !== authB) return authA > authB ? a : b;
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
  return a;
}

// ─── Internal ───────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
