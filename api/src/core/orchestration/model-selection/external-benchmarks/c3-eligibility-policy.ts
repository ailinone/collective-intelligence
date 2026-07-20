// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R6-HARDEN §6 — C3 Eligibility Policy.
 *
 * Separates the concepts of `externalBenchmarkUsed` (whether AA data was
 * used to compute the quality score) and `c3Eligible` (whether the model
 * is eligible for participation in a real C3 consensus run).
 *
 * A model can have `externalBenchmarkUsed = true` (AA data was used) while
 * still being `c3Eligible = false` (because the AA match confidence is only
 * medium, or because the variant alignment is unconfirmed).
 *
 * C3 ELIGIBILITY RULES:
 *
 *   high/exact confidence + confirmed/not_applicable variant → C3_ELIGIBLE
 *   high/exact confidence + probable variant                 → BLOCKED (variant_probable_requires_waiver)
 *   high/exact confidence + ambiguous variant                → BLOCKED (variant_ambiguous)
 *   medium confidence (any variant)                          → BLOCKED (medium_confidence_requires_waiver)
 *   low confidence                                           → BLOCKED (low_confidence)
 *   none / no_match                                          → BLOCKED (no_match)
 *   no AA data at all                                        → BLOCKED (no_external_benchmark)
 *
 * IMPORTANT: This policy is used ONLY to gate C3 participation. The
 * quality score itself is sourced from AA data regardless of c3 eligibility
 * (if external_benchmark data was ingested). The policy does NOT retroactively
 * downgrade quality scores.
 */

import type { VariantEvidence } from './model-variant-evidence';

// ─── Types ────────────────────────────────────────────────────────────────

export type C3EligibilityStatus = 'C3_ELIGIBLE' | 'C3_BLOCKED';

export type C3BlockReason =
  | 'blocked_medium_confidence_requires_waiver'
  | 'blocked_low_confidence'
  | 'blocked_no_match'
  | 'blocked_no_external_benchmark'
  | 'blocked_variant_probable_requires_waiver'
  | 'blocked_variant_ambiguous';

export interface C3EligibilityInput {
  /** Runtime model ID for diagnostics. */
  readonly modelId: string;
  /** Whether the quality score was sourced from external_benchmark (AA data). */
  readonly externalBenchmarkUsed: boolean;
  /** Match confidence from the AA matcher. `undefined` when no AA match. */
  readonly matchConfidence?: 'exact' | 'high' | 'medium' | 'low' | 'none';
  /** Variant alignment evidence from the model-variant-evidence assessor.
   *  `undefined` when no AA match or when the assessment was not run. */
  readonly variantEvidence?: VariantEvidence;
  /** AA slug from the match (for diagnostics). */
  readonly aaSlug?: string;
  /** AA display name (for diagnostics). */
  readonly aaName?: string;
}

export interface C3EligibilityResult {
  /** The runtime model ID this result applies to. */
  readonly modelId: string;
  /** Whether the model may participate in a real C3 consensus run. */
  readonly c3Eligible: boolean;
  readonly status: C3EligibilityStatus;
  /** Machine-readable reason code. */
  readonly reason: C3BlockReason | 'eligible';
  /** Human-readable explanation for the status. */
  readonly explanation: string;
  /** The match confidence that was evaluated (passthrough for diagnostics). */
  readonly matchConfidence: string;
  /** The variant evidence that was evaluated (passthrough for diagnostics). */
  readonly variantEvidence: string;
  readonly aaSlug: string | null;
  readonly aaName: string | null;
}

// ─── Policy version ───────────────────────────────────────────────────────

/**
 * Bump when the policy rules change. Included in the plan fingerprint
 * so policy changes invalidate parity between dry-run and real execution.
 */
export const C3_ELIGIBILITY_POLICY_VERSION = '01C.1B-J2-C-R6-HARDEN-v1' as const;

// ─── Core function ────────────────────────────────────────────────────────

/**
 * Evaluate C3 eligibility for a single selected model.
 *
 * Pure function — no I/O, no external state.
 */
export function evaluateC3Eligibility(input: C3EligibilityInput): C3EligibilityResult {
  const {
    modelId,
    externalBenchmarkUsed,
    matchConfidence,
    variantEvidence,
    aaSlug = null,
    aaName = null,
  } = input;

  const confStr = matchConfidence ?? 'none';
  const varStr = variantEvidence ?? 'unknown';

  // ── No external benchmark at all ────────────────────────────────────────
  if (!externalBenchmarkUsed || !matchConfidence || matchConfidence === 'none') {
    return {
      modelId,
      c3Eligible: false,
      status: 'C3_BLOCKED',
      reason: 'blocked_no_external_benchmark',
      explanation:
        'No Artificial Analysis external_benchmark data was used for this model. ' +
        'Inferred or catalog-fallback quality scores are not sufficient for C3 participation.',
      matchConfidence: confStr,
      variantEvidence: varStr,
      aaSlug,
      aaName,
    };
  }

  // ── Low confidence ───────────────────────────────────────────────────────
  if (matchConfidence === 'low') {
    return {
      modelId,
      c3Eligible: false,
      status: 'C3_BLOCKED',
      reason: 'blocked_low_confidence',
      explanation:
        `AA match confidence is "low" — the quality score provenance is too uncertain ` +
        `for C3 participation. A higher-confidence match is required.`,
      matchConfidence: confStr,
      variantEvidence: varStr,
      aaSlug,
      aaName,
    };
  }

  // ── Medium confidence ────────────────────────────────────────────────────
  // Medium blocks regardless of variant evidence — the naming uncertainty at
  // the AA match level is itself sufficient reason to require a waiver.
  if (matchConfidence === 'medium') {
    return {
      modelId,
      c3Eligible: false,
      status: 'C3_BLOCKED',
      reason: 'blocked_medium_confidence_requires_waiver',
      explanation:
        `AA match confidence is "medium" (aaSlug=${aaSlug ?? 'n/a'}). The naming ` +
        `discrepancy between the runtime model ID and the AA catalog entry requires ` +
        `an explicit operator waiver before this model can participate in C3.`,
      matchConfidence: confStr,
      variantEvidence: varStr,
      aaSlug,
      aaName,
    };
  }

  // ── High / exact confidence — evaluate variant evidence ─────────────────
  // At this point matchConfidence is 'high' or 'exact'.

  const effectiveVariant = variantEvidence ?? 'not_applicable';

  if (effectiveVariant === 'confirmed' || effectiveVariant === 'not_applicable') {
    return {
      modelId,
      c3Eligible: true,
      status: 'C3_ELIGIBLE',
      reason: 'eligible',
      explanation:
        `AA match confidence is "${matchConfidence}" and variant evidence is ` +
        `"${effectiveVariant}". The model is cleared for C3 participation.`,
      matchConfidence: confStr,
      variantEvidence: effectiveVariant,
      aaSlug,
      aaName,
    };
  }

  if (effectiveVariant === 'probable') {
    return {
      modelId,
      c3Eligible: false,
      status: 'C3_BLOCKED',
      reason: 'blocked_variant_probable_requires_waiver',
      explanation:
        `AA match confidence is "${matchConfidence}" but variant evidence is "probable" ` +
        `(aaSlug=${aaSlug ?? 'n/a'}). There is likely a reasoning-mode or naming ` +
        `variant discrepancy between the runtime model and the AA catalog entry. ` +
        `An operator waiver is required before C3 participation.`,
      matchConfidence: confStr,
      variantEvidence: effectiveVariant,
      aaSlug,
      aaName,
    };
  }

  // effectiveVariant === 'ambiguous'
  return {
    modelId,
    c3Eligible: false,
    status: 'C3_BLOCKED',
    reason: 'blocked_variant_ambiguous',
    explanation:
      `AA match confidence is "${matchConfidence}" but variant evidence is "ambiguous" ` +
      `(aaSlug=${aaSlug ?? 'n/a'}). The match is too imprecise to confirm variant ` +
      `alignment. Manual review and an operator waiver are required.`,
    matchConfidence: confStr,
    variantEvidence: effectiveVariant,
    aaSlug,
    aaName,
  };
}

// ─── Batch helper ────────────────────────────────────────────────────────

export interface C3EligibilitySummary {
  readonly policyVersion: typeof C3_ELIGIBILITY_POLICY_VERSION;
  readonly totalEvaluated: number;
  readonly c3EligibleCount: number;
  readonly c3BlockedCount: number;
  readonly results: readonly C3EligibilityResult[];
  /** True when ALL evaluated models are C3 eligible. */
  readonly allEligible: boolean;
  /** True when ANY model is blocked by medium confidence. */
  readonly anyMediumConfidenceBlock: boolean;
  /** True when ANY model is blocked by variant evidence. */
  readonly anyVariantBlock: boolean;
}

/**
 * Evaluate C3 eligibility for a batch of selected models and return
 * an aggregate summary used for plan fingerprinting and reporting.
 */
export function evaluateC3EligibilityBatch(
  inputs: readonly C3EligibilityInput[],
): C3EligibilitySummary {
  const results = inputs.map(evaluateC3Eligibility);
  const eligible = results.filter((r) => r.c3Eligible);
  const blocked = results.filter((r) => !r.c3Eligible);

  return {
    policyVersion: C3_ELIGIBILITY_POLICY_VERSION,
    totalEvaluated: results.length,
    c3EligibleCount: eligible.length,
    c3BlockedCount: blocked.length,
    results,
    allEligible: blocked.length === 0,
    anyMediumConfidenceBlock: blocked.some(
      (r) => r.reason === 'blocked_medium_confidence_requires_waiver',
    ),
    anyVariantBlock: blocked.some(
      (r) =>
        r.reason === 'blocked_variant_probable_requires_waiver' ||
        r.reason === 'blocked_variant_ambiguous',
    ),
  };
}
