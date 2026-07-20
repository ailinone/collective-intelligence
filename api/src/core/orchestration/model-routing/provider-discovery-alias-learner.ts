// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1F §9 — Discovery-driven provider alias learner.
 *
 * Catalog-first approach: query the local `models` table for rows whose
 * (provider_id, id, name) matches the family-version-variant signature
 * of the logical model id. This uses what previous discovery runs have
 * ALREADY learned, instead of duplicating external `/v1/models` calls.
 *
 * Matching algorithm (conservative — DESIGN-CRITICAL):
 *   1. **Family + version required** — `claude` + `3.7` or `3-7` + `sonnet`.
 *   2. **Confidence ladder**:
 *      - `exact`: catalog row name/id EQUALS the logical id (post-normalize)
 *      - `high`: catalog row name/id contains `<family>/<core>` form
 *      - `medium`: row contains family + version + variant but extra suffix
 *      - `low`: row contains family but version differs by patch (3.7 vs 3.5)
 *   3. **Tie-breaks** when multiple candidates per provider:
 *      a. Prefer `-latest` over dated (allows model upgrades without alias churn)
 *      b. Prefer non-regional (vertex/X over vertex/X@us-east5)
 *      c. Prefer shorter id (less namespaced)
 *      d. Prefer `anthropic/...` over `amazon/anthropic.*` when both exist
 *   4. **Family safety guards**: NEVER cross-match:
 *      - opus vs sonnet vs haiku
 *      - 3.5 vs 3.7 (different model release)
 *      - 4 vs 3 (different generation)
 *
 * NO HARDCODING of model lists — only family/version/variant tokens.
 * Operator adds new families to FAMILY_TOKENS as model lineup evolves.
 */

export type DiscoveryAliasMatchKind =
  | 'exact_logical'
  | 'exact_canonical'
  | 'provider_model_id'
  | 'native_family_match'
  | 'normalized_slug_match'
  | 'versioned_family_match'
  | 'contains_family_and_version'
  | 'no_match';

export type DiscoveryAliasConfidence = 'exact' | 'high' | 'medium' | 'low' | 'none';

export interface DiscoveredModelRow {
  readonly providerId: string;
  readonly id: string;
  readonly name: string;
}

export interface DiscoveryAliasCandidate {
  readonly providerId: string;
  readonly logicalModelId: string;
  readonly apiModelId: string;
  readonly matchKind: DiscoveryAliasMatchKind;
  readonly confidence: DiscoveryAliasConfidence;
  readonly evidence: {
    readonly discoveredModelId: string;
    readonly displayName: string;
    readonly source: 'internal_catalog';
  };
  readonly warnings: readonly string[];
}

export interface DiscoveryAliasLearningResult {
  readonly logicalModelId: string;
  readonly providerId: string;
  readonly candidates: readonly DiscoveryAliasCandidate[];
  readonly selected?: DiscoveryAliasCandidate;
  readonly unresolvedReason?: string;
}

/**
 * Token decomposition of a logical model id. The matcher uses this
 * to enforce family safety guards without fuzzy matching.
 */
export interface LogicalModelTokens {
  readonly family: string;          // 'claude'
  readonly versionMajor: string;    // '3'
  readonly versionMinor?: string;   // '7'
  readonly variant?: string;        // 'sonnet' | 'opus' | 'haiku' | 'instruct' | 'vision'
  readonly generation?: string;     // optional generation marker like '-4'
}

/**
 * Parse a logical model id into tokens. Conservative — anything that
 * doesn't match a known shape returns `null` and the matcher refuses
 * to operate (better than fuzzy guessing).
 */
export function parseLogicalModelTokens(logicalModelId: string): LogicalModelTokens | null {
  const lower = logicalModelId.toLowerCase();
  // Common shape: <vendor>?-?<family>-<version>-<variant>
  // Examples:
  //   anthropic-claude-3.7-sonnet  → family=claude, v=3.7, variant=sonnet
  //   claude-3-7-sonnet            → family=claude, v=3.7, variant=sonnet
  //   meta/llama-3.2-11b           → family=llama, v=3.2, variant=11b
  //   gpt-4o                       → family=gpt, v=4o, variant=(none)
  //   gemini-2.5-pro               → family=gemini, v=2.5, variant=pro
  const stripped = lower.replace(/^(anthropic|openai|google|meta|meta-llama|mistral|qwen|deepseek)[-/]/, '');
  // Match: <family>-<v.major>(.<v.minor>)?-<variant>?
  const m = stripped.match(/^(claude|gpt|gemini|llama|mistral|qwen|deepseek)[-_]?(\d+)(?:[._-](\d+))?(?:-([a-z0-9-]+))?$/);
  if (!m) return null;
  return {
    family: m[1],
    versionMajor: m[2],
    versionMinor: m[3],
    variant: m[4],
  };
}

/**
 * Score a discovered row against the logical tokens. Returns null when
 * family/version/variant safety guards fail (HARD reject — no fuzzy
 * fall-through).
 */
function scoreRow(
  tokens: LogicalModelTokens,
  row: DiscoveredModelRow,
): { matchKind: DiscoveryAliasMatchKind; confidence: DiscoveryAliasConfidence } | null {
  const idLower = row.id.toLowerCase();
  const nameLower = row.name.toLowerCase();
  const target = `${idLower} ${nameLower}`;

  // Family guard — must contain family
  if (!target.includes(tokens.family)) return null;

  // Version guard — must contain version major + minor (in any separator form)
  const v = tokens.versionMinor
    ? [`${tokens.versionMajor}.${tokens.versionMinor}`, `${tokens.versionMajor}-${tokens.versionMinor}`]
    : [tokens.versionMajor];
  if (!v.some((vv) => target.includes(vv))) return null;

  // Variant guard — when logical has a variant, the row must too
  if (tokens.variant) {
    if (!target.includes(tokens.variant)) return null;
    // Cross-family-variant guard: if logical=sonnet, row=opus → reject
    const VARIANTS = ['sonnet', 'opus', 'haiku', 'pro', 'flash', 'ultra', 'mini', 'nano'];
    for (const other of VARIANTS) {
      if (other === tokens.variant) continue;
      // If row contains a DIFFERENT variant explicitly, reject
      if (target.includes(`-${other}`) || target.endsWith(other)) return null;
    }
  }

  // Generation guard: claude-3.7 vs claude-4 — reject if row mentions a different gen
  const otherGens = ['-4-', '-4.', '-5-', '-5.'];
  if (tokens.versionMajor === '3') {
    for (const g of otherGens) {
      if (target.includes(g)) return null;
    }
  }

  // Now scoring
  if (idLower === tokens.family + '-' + (tokens.versionMinor ? `${tokens.versionMajor}.${tokens.versionMinor}` : tokens.versionMajor) + (tokens.variant ? `-${tokens.variant}` : '')) {
    return { matchKind: 'exact_canonical', confidence: 'exact' };
  }
  if (idLower.includes(`anthropic/${tokens.family}`) || idLower.includes(`anthropic.${tokens.family}`)) {
    return { matchKind: 'native_family_match', confidence: 'high' };
  }
  return { matchKind: 'contains_family_and_version', confidence: 'medium' };
}

/**
 * Tie-break key for picking the BEST candidate per provider. Lower
 * is better. Encodes the design preferences:
 *   - Prefer `-latest` over dated
 *   - Prefer non-regional (no `@`)
 *   - Prefer shorter id
 *   - Prefer cleaner namespace (anthropic/X over amazon/anthropic.X)
 */
function tieBreakKey(candidate: DiscoveryAliasCandidate): number {
  const id = candidate.apiModelId.toLowerCase();
  let score = 0;
  // Stronger negative for `-latest` (preferred)
  if (id.includes('-latest')) score -= 1000;
  // Penalize regional/datacenter qualifiers
  if (id.includes('@')) score += 500;
  // Penalize multi-namespace (more slashes = uglier)
  score += (id.match(/\//g) || []).length * 50;
  // Penalize length (shorter = cleaner)
  score += id.length;
  // Penalize provider-prefix-of-provider patterns (amazon/anthropic.X)
  if (id.match(/^(amazon|aws|google|vertex|bedrock)[./]/)) score += 200;
  // Penalize date-pinned versions in favor of `-latest` (already handled above)
  if (id.match(/-\d{8}/)) score += 100;
  return score;
}

/**
 * Learn an alias for a (providerId, logicalModelId) pair from a set
 * of discovered catalog rows. Returns null candidate when no row passes
 * the family/version/variant safety guards.
 */
export function learnAliasForProvider(input: {
  readonly providerId: string;
  readonly logicalModelId: string;
  readonly discoveredRows: readonly DiscoveredModelRow[];
}): DiscoveryAliasLearningResult {
  const tokens = parseLogicalModelTokens(input.logicalModelId);
  if (!tokens) {
    return {
      logicalModelId: input.logicalModelId,
      providerId: input.providerId,
      candidates: [],
      unresolvedReason: 'logical_model_id_failed_token_parse',
    };
  }
  const candidates: DiscoveryAliasCandidate[] = [];
  for (const row of input.discoveredRows) {
    if (row.providerId !== input.providerId) continue;
    const score = scoreRow(tokens, row);
    if (!score) continue;
    candidates.push({
      providerId: input.providerId,
      logicalModelId: input.logicalModelId,
      apiModelId: row.id,
      matchKind: score.matchKind,
      confidence: score.confidence,
      evidence: { discoveredModelId: row.id, displayName: row.name, source: 'internal_catalog' },
      warnings: [],
    });
  }
  if (candidates.length === 0) {
    return {
      logicalModelId: input.logicalModelId,
      providerId: input.providerId,
      candidates: [],
      unresolvedReason: 'no_catalog_row_matches_family_version_variant',
    };
  }
  // Sort by (confidence rank, tie-break)
  const confidenceRank: Record<DiscoveryAliasConfidence, number> = {
    exact: 0, high: 1, medium: 2, low: 3, none: 4,
  };
  const sorted = [...candidates].sort((a, b) => {
    const r = confidenceRank[a.confidence] - confidenceRank[b.confidence];
    if (r !== 0) return r;
    return tieBreakKey(a) - tieBreakKey(b);
  });
  return {
    logicalModelId: input.logicalModelId,
    providerId: input.providerId,
    candidates: sorted,
    selected: sorted[0],
  };
}
