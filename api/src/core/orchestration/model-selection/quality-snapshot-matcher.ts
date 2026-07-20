// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R5 §8 — Quality snapshot matcher.
 *
 * Pure resolver that takes a `QualityModelIdentity` (from
 * `quality-model-identity.ts`) and a list of quality snapshot entries
 * and returns the best match (or `matched=false` when no safe match
 * exists).
 *
 * Match priority (high → low):
 *   1. exact_model_id        snapshot.modelId equals runtime modelId verbatim
 *   2. exact_canonical_id    snapshot.canonicalModelId equals canonical
 *   3. provider_unwrapped    a snapshot alias equals the wrapper-stripped form
 *   4. normalized_alias      any normalized alias of either side matches
 *   5. family_alias          family + size + variant match (confidence: low)
 *   6. no_match
 *
 * Ambiguity policy:
 *   - When multiple snapshot entries tie at the same match kind, the matcher
 *     returns the FIRST in deterministic order (snapshot insertion order)
 *     and emits a `reasons` entry `ambiguous_match_count:N`. Callers can
 *     downgrade confidence in response.
 *
 * Pure: no I/O, no catalog/snapshot mutation, deterministic.
 */
import {
  buildQualityIdentityAliases,
  normalizeQualityModelId,
  type QualityModelIdentity,
} from './quality-model-identity';

// ─── Types ────────────────────────────────────────────────────────────────

export interface QualitySnapshotEntry {
  readonly modelId?: string;
  readonly canonicalModelId?: string;
  readonly displayName?: string;
  readonly name?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly qualityScore?: number;
  readonly qualityScoreSource?: string;
  readonly qualityScoreSources?: ReadonlyArray<string>;
  readonly benchmarkCoverage?: ReadonlyArray<string>;
  readonly confidence?: string;
  // No index signature — keep narrow. Callers passing wider snapshot entry
  // types can cast at the boundary.
}

export type QualityMatchKind =
  | 'exact_model_id'
  | 'exact_canonical_id'
  | 'provider_unwrapped_alias'
  | 'normalized_alias'
  | 'family_alias'
  | 'no_match';

export type QualityMatchConfidence = 'exact' | 'high' | 'medium' | 'low' | 'none';

export interface QualityMatchResult {
  readonly matched: boolean;
  readonly matchKind: QualityMatchKind;
  readonly confidence: QualityMatchConfidence;
  readonly entry?: QualitySnapshotEntry;
  readonly matchedAlias?: string;
  readonly ambiguousMatchCount: number;
  readonly reasons: ReadonlyArray<string>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function entryAliases(e: QualitySnapshotEntry): ReadonlyArray<string> {
  const ids: string[] = [];
  for (const k of ['modelId', 'canonicalModelId', 'displayName', 'name'] as const) {
    const v = e[k];
    if (typeof v === 'string') ids.push(v);
  }
  if (Array.isArray(e.aliases)) ids.push(...e.aliases);
  // Also build normalized + short forms via the same helper used on the
  // runtime side — symmetry is critical for determinism.
  const expanded = buildQualityIdentityAliases({ modelId: ids[0], aliases: ids.slice(1) });
  return expanded;
}

function aliasSet(e: QualitySnapshotEntry): Set<string> {
  return new Set(entryAliases(e).map((s) => s.toLowerCase()));
}

function familyKey(input: { family?: string; sizeClass?: string; variant?: string }): string | null {
  if (!input.family) return null;
  return [input.family, input.sizeClass ?? '', input.variant ?? ''].join('|').toLowerCase();
}

function entryFamilyKey(e: QualitySnapshotEntry): string | null {
  const id = String(e.modelId || e.canonicalModelId || e.displayName || e.name || '');
  if (!id) return null;
  const lowered = id.toLowerCase();
  const sizeMatch = /(\d+(?:\.\d+)?)\s*[bm](?![a-z])/.exec(lowered);
  const size = sizeMatch ? sizeMatch[1] + (sizeMatch[0].endsWith('m') ? 'm' : 'b') : '';
  let variant = '';
  if (lowered.includes('thinking')) variant = 'thinking';
  else if (lowered.includes('instruct')) variant = 'instruct';
  else if (lowered.includes('chat')) variant = 'chat';
  else if (lowered.includes('reasoning')) variant = 'reasoning';
  // Family = leading non-numeric token after vendor prefix
  const stripped = lowered.replace(
    /^(anthropic|openai|google|xai|deepseek-ai|deepseek|moonshotai|qwen|alibaba|abacusai|aion-labs|meta-llama|meta|mistralai|mistral)\//,
    '',
  );
  const family = stripped.split(/[-/.]/)[0];
  if (!family) return null;
  return `${family}|${size}|${variant}`;
}

// ─── Public API ───────────────────────────────────────────────────────────

export function matchQualitySnapshotEntry(input: {
  readonly runtimeIdentity: QualityModelIdentity;
  readonly snapshotEntries: ReadonlyArray<QualitySnapshotEntry>;
}): QualityMatchResult {
  const { runtimeIdentity, snapshotEntries } = input;
  const reasons: string[] = [];

  if (!runtimeIdentity.qualityCanonicalId || snapshotEntries.length === 0) {
    return {
      matched: false,
      matchKind: 'no_match',
      confidence: 'none',
      ambiguousMatchCount: 0,
      reasons: ['no_input_or_empty_snapshot'],
    };
  }

  const runtimeAliases = new Set(
    runtimeIdentity.normalizedIds.map((s) => s.toLowerCase()),
  );
  runtimeAliases.add(runtimeIdentity.qualityCanonicalId.toLowerCase());
  const canonicalLower = runtimeIdentity.qualityCanonicalId.toLowerCase();
  const runtimeFamily = familyKey(runtimeIdentity);

  // Tier 1: exact_model_id (verbatim)
  const exactModel = snapshotEntries.filter(
    (e) =>
      typeof e.modelId === 'string' &&
      runtimeIdentity.normalizedIds.includes(e.modelId),
  );
  if (exactModel.length > 0) {
    return {
      matched: true,
      matchKind: 'exact_model_id',
      confidence: 'exact',
      entry: exactModel[0],
      matchedAlias: exactModel[0].modelId,
      ambiguousMatchCount: exactModel.length,
      reasons: exactModel.length > 1 ? ['ambiguous_match_count:' + exactModel.length] : [],
    };
  }

  // Tier 2: exact_canonical_id
  const exactCanonical = snapshotEntries.filter(
    (e) =>
      (typeof e.canonicalModelId === 'string' &&
        normalizeQualityModelId(e.canonicalModelId) === canonicalLower) ||
      (typeof e.modelId === 'string' &&
        normalizeQualityModelId(e.modelId) === canonicalLower),
  );
  if (exactCanonical.length > 0) {
    return {
      matched: true,
      matchKind: 'exact_canonical_id',
      confidence: exactCanonical.length === 1 ? 'high' : 'medium',
      entry: exactCanonical[0],
      matchedAlias: exactCanonical[0].canonicalModelId ?? exactCanonical[0].modelId,
      ambiguousMatchCount: exactCanonical.length,
      reasons:
        exactCanonical.length > 1 ? ['ambiguous_match_count:' + exactCanonical.length] : [],
    };
  }

  // Tier 3: provider_unwrapped_alias — runtime alias survives wrapper strip
  // and matches a snapshot alias.
  // Tier 4: normalized_alias — any other normalized alias matches.
  const aliasMatches: Array<{ entry: QualitySnapshotEntry; aliasIntersect: string }> = [];
  for (const e of snapshotEntries) {
    const eAliases = aliasSet(e);
    let hit: string | undefined;
    for (const a of runtimeAliases) {
      if (eAliases.has(a)) {
        hit = a;
        break;
      }
    }
    if (hit) aliasMatches.push({ entry: e, aliasIntersect: hit });
  }
  if (aliasMatches.length > 0) {
    // If the alias is the wrapper-stripped form (i.e. equals canonical without
    // wrapper but original modelId had a wrapper), classify as provider_unwrapped.
    const wrapperLikeAlias = aliasMatches.find((_m) =>
      runtimeIdentity.reasons.some((r) => r.startsWith('stripped_wrapper:')),
    );
    const kind: QualityMatchKind = wrapperLikeAlias
      ? 'provider_unwrapped_alias'
      : 'normalized_alias';
    const confidence: QualityMatchConfidence =
      kind === 'provider_unwrapped_alias' ? (aliasMatches.length === 1 ? 'high' : 'medium') : 'medium';
    return {
      matched: true,
      matchKind: kind,
      confidence,
      entry: aliasMatches[0].entry,
      matchedAlias: aliasMatches[0].aliasIntersect,
      ambiguousMatchCount: aliasMatches.length,
      reasons:
        aliasMatches.length > 1 ? ['ambiguous_match_count:' + aliasMatches.length] : [],
    };
  }

  // Tier 5: family_alias — same family + size + variant.
  if (runtimeFamily) {
    const familyMatches = snapshotEntries.filter((e) => entryFamilyKey(e) === runtimeFamily);
    if (familyMatches.length === 1) {
      return {
        matched: true,
        matchKind: 'family_alias',
        confidence: 'low',
        entry: familyMatches[0],
        matchedAlias: familyMatches[0].modelId ?? familyMatches[0].canonicalModelId,
        ambiguousMatchCount: 1,
        reasons: ['family_alias_match'],
      };
    }
    if (familyMatches.length > 1) {
      // Ambiguous family — refuse to pick silently.
      return {
        matched: false,
        matchKind: 'no_match',
        confidence: 'none',
        ambiguousMatchCount: familyMatches.length,
        reasons: ['ambiguous_family_match_refused:' + familyMatches.length],
      };
    }
  }

  return {
    matched: false,
    matchKind: 'no_match',
    confidence: 'none',
    ambiguousMatchCount: 0,
    reasons: reasons.length ? reasons : ['no_alias_or_family_intersection'],
  };
}
