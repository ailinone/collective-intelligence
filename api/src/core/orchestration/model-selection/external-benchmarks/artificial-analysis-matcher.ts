// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R6 §8 — Artificial Analysis matcher.
 *
 * Matches a runtime model id (and optional explicit aliases) against a
 * normalized AA model set. Confidence tiers:
 *
 *   aa_id_exact        — runtime id equals an AA id verbatim         → exact
 *   aa_slug_exact      — runtime id equals an AA slug verbatim       → exact
 *   normalized_name_exact — normalized runtime equals normalized AA  → high
 *   creator_plus_name_exact — `creator/model` form matches           → high
 *   explicit_alias_high — alias whitelisted at `high` confidence     → high
 *   family_or_short_name_medium — short-form family match            → medium
 *   ambiguous          — multiple AA models match at same tier       → no_match (refuse)
 *   no_match           — no alias intersection
 *
 * Ambiguity policy: ambiguous matches are NEVER silently resolved. They
 * return `no_match` with `warnings[]` listing the candidates so callers
 * can resolve manually via the explicit-alias file.
 */
import {
  normalizeAaId,
  type NormalizedArtificialAnalysisModel,
} from './artificial-analysis-normalizer';

// ─── Types ────────────────────────────────────────────────────────────────

export type AaMatchKind =
  | 'aa_id_exact'
  | 'aa_slug_exact'
  | 'normalized_name_exact'
  | 'creator_plus_name_exact'
  | 'explicit_alias_high'
  | 'family_or_short_name_medium'
  | 'no_match'
  | 'ambiguous';

export type AaMatchConfidence = 'exact' | 'high' | 'medium' | 'low' | 'none';

export interface ArtificialAnalysisMatch {
  readonly matched: boolean;
  readonly matchKind: AaMatchKind;
  readonly confidence: AaMatchConfidence;
  readonly aaModel?: NormalizedArtificialAnalysisModel;
  readonly matchedAlias?: string;
  readonly reasons: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

export interface ExplicitAliasEntry {
  readonly runtimePattern: string;
  readonly candidateAliases: ReadonlyArray<string>;
  /** Caps the maximum confidence that match will report. */
  readonly confidenceCeiling: AaMatchConfidence;
  readonly reason?: string;
}

export interface MatchInput {
  readonly runtimeModelId: string;
  readonly runtimeAliases?: ReadonlyArray<string>;
  readonly explicitAliases?: ReadonlyArray<ExplicitAliasEntry>;
  readonly aaModels: ReadonlyArray<NormalizedArtificialAnalysisModel>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const CONFIDENCE_RANK: Record<AaMatchConfidence, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  exact: 4,
};

function buildRuntimeAliases(
  runtimeModelId: string,
  extra: ReadonlyArray<string> | undefined,
  explicitAliases: ReadonlyArray<ExplicitAliasEntry>,
): { aliases: ReadonlyArray<string>; ceiling: AaMatchConfidence | undefined } {
  const set = new Set<string>();
  set.add(runtimeModelId);
  set.add(normalizeAaId(runtimeModelId));
  const short = String(runtimeModelId).split('/').pop();
  if (short) {
    set.add(short);
    set.add(normalizeAaId(short));
  }
  for (const a of extra ?? []) {
    if (!a) continue;
    set.add(a);
    set.add(normalizeAaId(a));
  }

  // Explicit-alias entries can both ADD candidate aliases AND cap the
  // resulting confidence ceiling.
  let ceiling: AaMatchConfidence | undefined;
  const runtimeNorm = normalizeAaId(runtimeModelId);
  for (const entry of explicitAliases) {
    const patternNorm = normalizeAaId(entry.runtimePattern);
    const matches =
      runtimeNorm === patternNorm ||
      runtimeNorm.includes(patternNorm) ||
      patternNorm.includes(runtimeNorm);
    if (!matches) continue;
    for (const c of entry.candidateAliases) {
      set.add(c);
      set.add(normalizeAaId(c));
    }
    if (!ceiling || CONFIDENCE_RANK[entry.confidenceCeiling] < CONFIDENCE_RANK[ceiling]) {
      ceiling = entry.confidenceCeiling;
    }
  }
  return { aliases: [...set].filter(Boolean), ceiling };
}

function applyCeiling(c: AaMatchConfidence, ceiling: AaMatchConfidence | undefined): AaMatchConfidence {
  if (!ceiling) return c;
  return CONFIDENCE_RANK[c] > CONFIDENCE_RANK[ceiling] ? ceiling : c;
}

// ─── Public API ───────────────────────────────────────────────────────────

export function matchArtificialAnalysisModel(input: MatchInput): ArtificialAnalysisMatch {
  const { runtimeModelId, aaModels } = input;
  if (!runtimeModelId || aaModels.length === 0) {
    return {
      matched: false,
      matchKind: 'no_match',
      confidence: 'none',
      reasons: ['no_input_or_empty_aa_set'],
      warnings: [],
    };
  }
  const { aliases, ceiling } = buildRuntimeAliases(
    runtimeModelId,
    input.runtimeAliases,
    input.explicitAliases ?? [],
  );
  const aliasesLower = new Set(aliases.map((a) => a.toLowerCase()));

  // Tier 1: aa_id_exact (verbatim).
  for (const m of aaModels) {
    if (aliasesLower.has(m.aaModelId.toLowerCase())) {
      return {
        matched: true,
        matchKind: 'aa_id_exact',
        confidence: applyCeiling('exact', ceiling),
        aaModel: m,
        matchedAlias: m.aaModelId,
        reasons: ['matched_aa_id_verbatim'],
        warnings: [],
      };
    }
  }
  // Tier 2: aa_slug_exact.
  for (const m of aaModels) {
    if (m.aaSlug && aliasesLower.has(m.aaSlug.toLowerCase())) {
      return {
        matched: true,
        matchKind: 'aa_slug_exact',
        confidence: applyCeiling('exact', ceiling),
        aaModel: m,
        matchedAlias: m.aaSlug,
        reasons: ['matched_aa_slug_verbatim'],
        warnings: [],
      };
    }
  }
  // Tier 3 + 4: normalized_name_exact / creator_plus_name_exact (tied at 'high')
  const highMatches: Array<{
    model: NormalizedArtificialAnalysisModel;
    kind: AaMatchKind;
    alias: string;
  }> = [];
  for (const m of aaModels) {
    const aaAliasesLower = m.normalizedAliases.map((a) => a.toLowerCase());
    let hit: string | undefined;
    for (const a of aliasesLower) {
      if (aaAliasesLower.includes(a)) {
        hit = a;
        break;
      }
    }
    if (hit) {
      const kind: AaMatchKind = m.creatorName && m.aaName && hit.includes('/') ? 'creator_plus_name_exact' : 'normalized_name_exact';
      highMatches.push({ model: m, kind, alias: hit });
    }
  }
  if (highMatches.length === 1) {
    return {
      matched: true,
      matchKind: highMatches[0]!.kind,
      confidence: applyCeiling('high', ceiling),
      aaModel: highMatches[0]!.model,
      matchedAlias: highMatches[0]!.alias,
      reasons: [`matched_via_${highMatches[0]!.kind}`],
      warnings: [],
    };
  }
  if (highMatches.length > 1) {
    return {
      matched: false,
      matchKind: 'ambiguous',
      confidence: 'none',
      reasons: ['multiple_high_confidence_matches_refused'],
      warnings: highMatches.map((m) => `${m.model.aaName} (${m.model.aaSlug ?? ''})`),
    };
  }

  return {
    matched: false,
    matchKind: 'no_match',
    confidence: 'none',
    reasons: ['no_alias_intersection'],
    warnings: [],
  };
}
