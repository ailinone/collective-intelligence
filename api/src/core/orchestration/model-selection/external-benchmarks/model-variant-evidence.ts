// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R6-HARDEN §7 — Model variant evidence assessor.
 *
 * Determines whether the Artificial Analysis match refers to the SAME
 * model variant as the runtime model, or whether there is evidence of a
 * variant mismatch (e.g., Thinking vs Reasoning, -non-reasoning suffix,
 * or a different reasoning mode than declared at runtime).
 *
 * Evidence tiers:
 *   confirmed      — strong evidence both sides refer to the same variant
 *                    (slug exact, no variant-indicator discrepancy)
 *   probable       — known naming discrepancy pattern detected; likely
 *                    the same model but with a declared-mode difference
 *   ambiguous      — insufficient evidence to determine variant alignment;
 *                    requires manual review
 *   not_applicable — no variant indicator on either side; the concept
 *                    of "variant" does not apply to this model
 *
 * POLICY: C3 eligibility requires `confirmed` or `not_applicable`.
 * `probable` and `ambiguous` require an explicit waiver.
 */

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Variant alignment evidence between a runtime model and its AA match.
 */
export type VariantEvidence = 'confirmed' | 'probable' | 'ambiguous' | 'not_applicable';

export interface VariantEvidenceInput {
  /** Runtime model ID as used in the consensus plan. */
  readonly runtimeModelId: string;
  /** AA slug from the match (e.g., "deepseek-r1", "kimi-k2-5-non-reasoning"). */
  readonly aaSlug: string;
  /** AA display name (e.g., "DeepSeek R1 0528 (May '25)"). */
  readonly aaName: string;
  /** Match confidence from the AA matcher. */
  readonly matchConfidence: 'exact' | 'high' | 'medium' | 'low' | 'none';
  /** Match kind from the AA matcher. */
  readonly matchKind: string;
}

export interface VariantEvidenceResult {
  readonly variantEvidence: VariantEvidence;
  readonly reason: string;
  /** True when "Thinking" appears in runtime but not in aaSlug/aaName (or vice versa). */
  readonly thinkingReasoningDiscrepancy: boolean;
  /** True when aaSlug ends with "-non-reasoning" but runtime does not declare it. */
  readonly nonReasoningSlugNotInRuntime: boolean;
  /** True when aaSlug ends with "-reasoning" / "-instruct-reasoning" but runtime uses a different suffix. */
  readonly reasoningSlugNotInRuntime: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * True when the string contains "thinking" as a word-like token (not
 * part of "rethinking", "overthinking", etc. — only exact word boundary).
 */
function hasThinking(s: string): boolean {
  return /(?:^|[-_/\s(])thinking(?:$|[-_/\s)])/i.test(s);
}

/**
 * True when the string contains "reasoning" as a word-like token.
 */
function hasReasoning(s: string): boolean {
  return /(?:^|[-_/\s(])reasoning(?:$|[-_/\s)])/i.test(s);
}

/**
 * True when the string contains "-non-reasoning" suffix (indicates the
 * non-reasoning / non-thinking variant of a model that has both modes).
 */
function hasNonReasoningSuffix(s: string): boolean {
  return /\bnon-?reasoning\b/i.test(s);
}

// ─── Core function ────────────────────────────────────────────────────────

/**
 * Assess variant alignment between a runtime model ID and its AA match.
 *
 * The function is PURE — no I/O, no external state. It only reads the
 * inputs provided.
 */
export function assessVariantEvidence(input: VariantEvidenceInput): VariantEvidenceResult {
  const { runtimeModelId, aaSlug, aaName, matchConfidence, matchKind } = input;

  // ── Detect Thinking ↔ Reasoning discrepancy ─────────────────────────────
  const runtimeHasThinking = hasThinking(runtimeModelId);
  const aaHasReasoning = hasReasoning(aaSlug) || hasReasoning(aaName);
  const runtimeHasReasoning = hasReasoning(runtimeModelId);
  const aaHasThinking = hasThinking(aaSlug) || hasThinking(aaName);

  const thinkingReasoningDiscrepancy =
    (runtimeHasThinking && aaHasReasoning && !aaHasThinking) ||
    (aaHasThinking && runtimeHasReasoning && !runtimeHasThinking);

  // ── Detect -non-reasoning suffix mismatch ───────────────────────────────
  const aaIsNonReasoning = hasNonReasoningSuffix(aaSlug);
  const runtimeIsNonReasoning = hasNonReasoningSuffix(runtimeModelId);
  const nonReasoningSlugNotInRuntime = aaIsNonReasoning && !runtimeIsNonReasoning;

  // ── Detect -reasoning suffix in aaSlug not matched by runtime ───────────
  // e.g., aaSlug = "qwen3-235b-a22b-instruct-2507-reasoning" but runtime uses
  // "Thinking" instead of "reasoning" suffix (already caught by the Thinking
  // ↔ Reasoning check above, but also flagged here for clarity).
  const aaSlugEndsWithReasoning = /-(instruct-)?reasoning$/.test(aaSlug);
  const reasoningSlugNotInRuntime =
    aaSlugEndsWithReasoning && !runtimeHasReasoning && !thinkingReasoningDiscrepancy;

  // ── Evidence determination ───────────────────────────────────────────────

  // No match → ambiguous by definition.
  if (matchConfidence === 'none' || matchKind === 'no_match' || matchKind === 'ambiguous') {
    return {
      variantEvidence: 'ambiguous',
      reason: 'no_match_or_ambiguous_match',
      thinkingReasoningDiscrepancy: false,
      nonReasoningSlugNotInRuntime: false,
      reasoningSlugNotInRuntime: false,
    };
  }

  // Thinking → Reasoning discrepancy: probable (known pattern, same model,
  // but different declared reasoning mode naming).
  if (thinkingReasoningDiscrepancy) {
    return {
      variantEvidence: 'probable',
      reason: 'thinking_reasoning_naming_discrepancy',
      thinkingReasoningDiscrepancy: true,
      nonReasoningSlugNotInRuntime,
      reasoningSlugNotInRuntime,
    };
  }

  // AA slug declares "-non-reasoning" but runtime does not → probable.
  if (nonReasoningSlugNotInRuntime) {
    return {
      variantEvidence: 'probable',
      reason: 'aa_non_reasoning_suffix_not_declared_in_runtime',
      thinkingReasoningDiscrepancy: false,
      nonReasoningSlugNotInRuntime: true,
      reasoningSlugNotInRuntime,
    };
  }

  // Reasoning suffix in AA slug but runtime uses a different form → probable.
  if (reasoningSlugNotInRuntime) {
    return {
      variantEvidence: 'probable',
      reason: 'aa_reasoning_suffix_not_matched_by_runtime',
      thinkingReasoningDiscrepancy: false,
      nonReasoningSlugNotInRuntime: false,
      reasoningSlugNotInRuntime: true,
    };
  }

  // Family / short-name medium match without a slug → ambiguous: not enough
  // precision to declare confirmed, but no positive variant mismatch evidence.
  if (matchKind === 'family_or_short_name_medium') {
    return {
      variantEvidence: 'ambiguous',
      reason: 'family_short_name_match_insufficient_precision',
      thinkingReasoningDiscrepancy: false,
      nonReasoningSlugNotInRuntime: false,
      reasoningSlugNotInRuntime: false,
    };
  }

  // Slug-exact or id-exact or high match with no discrepancy detected.
  // Check if there are ANY variant indicators at all on either side.
  const eitherSideHasVariantIndicator =
    runtimeHasThinking || runtimeHasReasoning || aaIsNonReasoning || aaHasReasoning || aaHasThinking;

  if (!eitherSideHasVariantIndicator) {
    // No variant language on either side.
    return {
      variantEvidence: 'not_applicable',
      reason: 'no_variant_indicator_on_either_side',
      thinkingReasoningDiscrepancy: false,
      nonReasoningSlugNotInRuntime: false,
      reasoningSlugNotInRuntime: false,
    };
  }

  // Both sides use consistent variant language (e.g. both say "reasoning"),
  // or the runtime explicitly matches what the AA slug says.
  // Only slug exact / id exact gets `confirmed`; anything looser gets
  // `probable` unless we can rule out a mismatch.
  if (
    matchKind === 'aa_slug_exact' ||
    matchKind === 'aa_id_exact' ||
    matchKind === 'explicit_alias_high'
  ) {
    // Variant indicators exist on at least one side, but no discrepancy was
    // detected above — the names are consistent.
    return {
      variantEvidence: 'confirmed',
      reason: 'slug_or_id_exact_no_variant_discrepancy',
      thinkingReasoningDiscrepancy: false,
      nonReasoningSlugNotInRuntime: false,
      reasoningSlugNotInRuntime: false,
    };
  }

  // Normalized / creator match with consistent variant language — probable.
  return {
    variantEvidence: 'probable',
    reason: 'normalized_match_with_variant_indicator_unconfirmed',
    thinkingReasoningDiscrepancy: false,
    nonReasoningSlugNotInRuntime: false,
    reasoningSlugNotInRuntime: false,
  };
}
