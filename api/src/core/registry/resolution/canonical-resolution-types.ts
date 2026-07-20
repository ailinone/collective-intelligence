// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Canonical resolution types — MVP 4.
 *
 * MVP 4 invariants:
 *   - Pure types + constants. No I/O.
 *   - No singleton, no module-level state.
 *   - DOES NOT replace `CanonicalResolution` declared in MVP 1's
 *     `core/registry/types.ts`. That type is the OUTPUT of a future
 *     full resolver. This MVP introduces a NARROWER per-(provider, model)
 *     confidence record that powers the eventual resolver.
 *
 * Pertinência:
 *   - `CanonicalResolutionConfidence` captures the confidence with which
 *     a SPECIFIC `(servingProviderId, providerModelId)` maps onto a
 *     `canonicalModelId`. It is the building block — many such records
 *     can be folded into the full `CanonicalResolution` later.
 */

import type { CanonicalResolutionSource } from '../types';

// ─── Confidence record ──────────────────────────────────────────────────

/**
 * One row of canonical-model resolution evidence for a specific
 * `(providerId, providerModelId)`. Serializable, deterministic.
 *
 *   - `confidence` is in [0, 1]. >= 0.7 is required for automatic merge.
 *   - `source` indicates WHERE the evidence came from. Higher-priority
 *     sources (manual_override, declared_alias) win over heuristic.
 *   - `reason` is a short, human-auditable string. Never carries PII.
 *   - `conflictGroupId` is set when two non-merging resolutions point
 *     to different canonicals — the auditor inspects the group.
 */
export interface CanonicalResolutionConfidence {
  readonly canonicalModelId: string;
  readonly providerModelId: string;
  readonly confidence: number;
  readonly source: CanonicalResolutionSource;
  readonly reason: string;
  readonly conflictGroupId?: string;
}

// ─── Source precedence ──────────────────────────────────────────────────

/**
 * Source authority ranking. HIGHER number wins when two records for the
 * same `(providerId, providerModelId)` disagree on `canonicalModelId`.
 *
 * Anchored to the v1.1 plan: manual_override and declared_alias always
 * win; heuristic + equivalence service are advisory and require ≥0.7
 * confidence to auto-merge; fallback is a last resort.
 */
export const CANONICAL_SOURCE_AUTHORITY: Readonly<Record<CanonicalResolutionSource, number>> = Object.freeze({
  manual_override: 100,
  declared_alias: 90,
  provider_metadata: 80,
  exact_normalized_name: 70,
  heuristic_family_version: 50,
  model_equivalence_service: 40,
  fallback_provider_model_id: 0,
});

// ─── Thresholds ─────────────────────────────────────────────────────────

/** Minimum confidence required for the resolver to AUTO-MERGE with an
 *  existing canonical model. Below this, the resolution is kept as its
 *  own canonical entry and flagged via `conflictGroupId`. */
export const MIN_CONFIDENCE_FOR_AUTO_MERGE = 0.7;

/** Default confidence assigned to a `fallback_provider_model_id`
 *  resolution — i.e., when nothing else matched. The value is 0 to
 *  signal "we know nothing" and to keep this resolution OUT of merges. */
export const FALLBACK_RESOLUTION_CONFIDENCE = 0.0;
