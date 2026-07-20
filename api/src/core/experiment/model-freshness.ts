// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model Freshness / Version Awareness
 *
 * Scores chat models by how recent they are within their family so the
 * top-tier resolver prefers `kimi-k2.6` over `kimi-k2-0905-preview` and
 * `gpt-5.5` over `gpt-4-turbo`. Without this, the resolver fell back to
 * `contextWindow desc` and picked whichever stale model happened to have
 * the largest declared context — losing 0905-preview was the symptom that
 * exposed this.
 *
 * The scorer is intentionally heuristic:
 *   - Families are identified by a normalized prefix scan
 *     (gpt/claude/gemini/grok/kimi/deepseek/mistral/qwen/llama/command).
 *   - Within a family, version tokens are extracted via family-specific
 *     parsers — there is no single "version" format across vendors:
 *       Anthropic uses dashes ("claude-opus-4-6"); OpenAI uses dots
 *       ("gpt-5.5"); Moonshot mixes them ("k2.6", "k2-0905-preview");
 *       DeepSeek uses dotted majors ("deepseek-v4").
 *   - `preview` / `experimental` / `alpha` / `deprecated` flags are
 *     subtractive — a preview build of a newer generation can still beat
 *     a stable build of an older one, but loses against a same-generation
 *     stable release.
 *
 * Result shape — `{ family, generationScore, isPreview, isDeprecated }`.
 * Two scores compare lexicographically:
 *   1) generationScore (numeric, higher = newer)
 *   2) isPreview flag (false beats true at the same score)
 *   3) isDeprecated flag (false beats true)
 */

export interface FreshnessSignal {
  family: string;         // 'kimi' | 'gpt' | 'claude' | …
  generationScore: number; // higher = more recent. Family-specific scale.
  isPreview: boolean;     // model id contains "preview" / "alpha" / "beta" / "exp"
  isDeprecated: boolean;  // model id matches a known stale pattern
  rationale: string;      // short explanation for audit/log output
}

/**
 * Canonical family keys. Keep this list narrow — every entry needs a
 * version parser below. Unrecognised families return generationScore=0
 * and skip the freshness sort (degrade gracefully to ctx/cost order).
 */
export const KNOWN_FAMILIES = [
  'gpt',
  'claude',
  'gemini',
  'grok',
  'kimi',
  'deepseek',
  'mistral',
  'qwen',
  'llama',
  'command',
  'magistral',
  'pixtral',
  'jamba',
  'phi',
  'nemotron',
] as const;

export type ModelFamily = typeof KNOWN_FAMILIES[number];

// ─── Family detection ──────────────────────────────────────────────────

// 2026-05-12 (ramp-final): patterns are anchored to `^` (after the `/`
// strip in detectFamily). This rejects community forks like
// `CobraMamba/mamba-gpt-7b` (matches the post-slash portion
// `mamba-gpt-7b`, which is NOT at the start) and `Qwen/Qwen3-Coder-...`
// (post-slash `qwen3-coder-...` IS at the start — accepted). The
// distinction is "is this a canonical-namespace publish?" vs "is this
// a community derivative whose family is incidental?"
const FAMILY_PATTERNS: ReadonlyArray<[ModelFamily, RegExp]> = [
  ['gpt', /^gpt-?\d/i],
  ['claude', /^claude/i],
  ['gemini', /^gemini-?\d/i],
  ['grok', /^grok-?\d/i],
  ['kimi', /^(?:kimi|k2)\b/i],
  ['deepseek', /^deepseek/i],
  ['mistral', /^(?:mistral|mixtral)/i],
  // 2026-05-12 (audit final): qwen + llama require a DASH between the
  // family name and the version digit. Canonical releases all use the
  // dash (`Qwen3` is the brand name with the 3 attached, but in DB ids
  // it's spelled `qwen-3` / `Llama-3` / `meta-llama/Llama-3.3`).
  // Community forks like `Shahradmz/llama8b_SEND_1B-...` or
  // `ZMC2019/Qwen7B-Roll-L28E3` use the no-dash spelling AND the digit
  // is parameter count (8B, 7B), not version. Without the required
  // dash, those forks were generating fake stale-pin blockers.
  ['qwen', /^qwen-\d/i],
  ['llama', /^llama-\d/i],
  ['command', /^command-/i],
  ['magistral', /^magistral/i],
  ['pixtral', /^pixtral/i],
  ['jamba', /^jamba/i],
  ['phi', /^phi-?\d/i],
  ['nemotron', /^nemotron/i],
];

export function detectFamily(modelId: string): ModelFamily | null {
  const id = modelId.toLowerCase();
  // 2026-05-12 (ramp-final): require the family token to appear at the
  // start of the id OR immediately after a `/` (i.e. it's the
  // model-name part of a `vendor/model` id). Without this, community
  // forks like `DreamFast/qwen3-8b-heretic` or `CobraMamba/mamba-gpt-7b`
  // matched the family pattern via the `\b` boundary on the right and
  // poisoned the freshness matrix with garbage "fresher available"
  // pointers. The constraint also rejects `gemini-evaluator-3b` and
  // similar derivative names.
  const canonical = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  for (const [fam, pat] of FAMILY_PATTERNS) {
    if (pat.test(canonical)) return fam;
  }
  return null;
}

// ─── Preview / deprecation flags ───────────────────────────────────────

const PREVIEW_HINTS = ['preview', 'alpha', 'beta', 'rc-', 'experimental', '-exp', '-ea-', 'snapshot'];
const DEPRECATED_HINTS = [
  // Generic
  'legacy', 'deprecated', 'retired',
  // Known stale generations the user spec specifically called out as needing
  // to lose to current frontier — keep this short, never add a family just
  // to suppress one model unless you've confirmed the vendor has shipped a
  // successor that the resolver should select instead.
  'gpt-3.5', 'gpt-4-1106', 'gpt-4-0314', 'gpt-4-0613',
  'claude-2', 'claude-instant',
  'gemini-1.0', 'gemini-1.5-flash-001',
  'kimi-k2-0905-preview', 'kimi-k2-0905', 'k2-0905',
  'llama-2', 'llama2',
  'qwen-1', 'qwen-2',
];

function isPreviewModel(id: string): boolean {
  const lid = id.toLowerCase();
  return PREVIEW_HINTS.some((h) => lid.includes(h));
}

function isDeprecatedModel(id: string): boolean {
  const lid = id.toLowerCase();
  return DEPRECATED_HINTS.some((h) => lid.includes(h));
}

// ─── Family-specific version parsers ───────────────────────────────────
//
// Each parser returns a numeric score on its OWN scale — we only ever
// compare two scores within the same family, never across families
// (cross-family ordering is already handled by `topTierClass`).

/**
 * Generic major.minor extractor — first version-like token following the
 * family prefix. Handles `kimi-k2.6` → 2.6, `gpt-5.5` → 5.5,
 * `deepseek-v4-pro` → 4.0, `claude-opus-4-7` → 4.7 (dashes folded to dot
 * for Anthropic-style ids).
 *
 * 2026-05-12 (ramp-final fix): the original parser interpreted date
 * tokens (e.g. `2025-12-11`) and sequence digits (`grok-41-fast`) as
 * versions, producing absurd scores like 2025 and 41. The fix:
 *   1) Strip ISO-like date and bare four-digit year tokens FIRST.
 *   2) Require the major digit to be 1-9 (caps versions at single-digit
 *      majors — no current chat model is past v9; if one ever ships,
 *      add an explicit family-specific parser branch).
 *   3) For the "-N-" major-only fallback, use a negative lookahead so
 *      `grok-41-fast` doesn't match `-4-` (the `1` after the `4` voids
 *      the match).
 */
function parseGenericVersion(modelId: string, family: ModelFamily): number {
  // 1) Strip dates + bare year tokens so we don't read "2025-03-20" as v2025.
  const cleaned = modelId.toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')   // YYYY-MM-DD
    .replace(/\b\d{4}\/\d{2}\/\d{2}\b/g, '') // YYYY/MM/DD
    .replace(/\b20\d{2}\b/g, '');             // bare 20xx year tokens

  // 2) Family-specific normalization first — these win when matched.

  // Claude: separates major/minor with dashes (`claude-opus-4-7` = 4.7).
  // Anthropic's naming has shifted over time:
  //   - `claude-opus-4-7` / `claude-sonnet-4-6`: class then dash-version
  //   - `claude-3-5-sonnet`: version then class
  //   - `claude-2.1`: dotted version, no class
  //   - `claude-instant-1`: class then bare major
  // Try the explicit patterns first; fall through to bare-major last.
  if (family === 'claude') {
    // Class-prefixed: `opus-4-7`, `sonnet-3-5`
    let m = cleaned.match(/(?:opus|sonnet|haiku|instant)-(\d+)[-.](\d+)/);
    if (m) return parseFloat(`${m[1]}.${m[2]}`);
    // Class-prefixed bare major: `instant-1`
    m = cleaned.match(/(?:opus|sonnet|haiku|instant)-(\d+)(?!\d)/);
    if (m) return parseFloat(m[1]);
    // Pre-class: `claude-3-5-sonnet`, `claude-4-7`
    m = cleaned.match(/claude-(\d+)-(\d+)/);
    if (m) return parseFloat(`${m[1]}.${m[2]}`);
    // Dotted: `claude-2.1`
    m = cleaned.match(/claude-(\d+)\.(\d+)/);
    if (m) return parseFloat(`${m[1]}.${m[2]}`);
    // Bare major: `claude-2`
    m = cleaned.match(/claude-(\d+)(?![\d.])/);
    if (m) return parseFloat(m[1]);
  }

  // Kimi: "kimi-k2.6", "k2.6" → first kN.M; "k2-0905-preview" → just kN.
  if (family === 'kimi') {
    const dotted = cleaned.match(/k(\d+)\.(\d+)/);
    if (dotted) return parseFloat(`${dotted[1]}.${dotted[2]}`);
    // No minor — bare "kN" → score = N.0. Sequence numbers like "-0905-"
    // are deliberately NOT consumed: they're build dates, not minor
    // versions. Without this, k2-0905 would beat k2.6 (905 > 6).
    const just = cleaned.match(/k(\d+)/);
    if (just) return parseFloat(just[1]);
  }

  // DeepSeek: "deepseek-v4-pro" → 4.0; "deepseek-r1" → 1.0 (r-series).
  if (family === 'deepseek') {
    const m = cleaned.match(/(?:v|r)(\d+)(?:[._](\d+))?/);
    if (m) return parseFloat(`${m[1]}.${m[2] ?? '0'}`);
  }

  // Qwen: "qwen3", "qwen-3", "qwen2.5" → extract major[.minor]
  // immediately after the family token. Single-digit major (same
  // rationale as Llama: community-fork ids like "qwen3-1681" or
  // "qwen99-foo" should NOT clobber the matrix). Dot required for minor.
  if (family === 'qwen') {
    const m = cleaned.match(/qwen-?(\d)(?!\d)(?:\.(\d+))?/);
    if (m) return parseFloat(`${m[1]}.${m[2] ?? '0'}`);
  }

  // Gemini: "gemini-3.1-pro", "gemini-3", "gemini-2.5-flash" → major[.minor].
  // Single-digit major + literal dot for minor.
  if (family === 'gemini') {
    const m = cleaned.match(/gemini-(\d)(?!\d)(?:\.(\d+))?/);
    if (m) return parseFloat(`${m[1]}.${m[2] ?? '0'}`);
  }

  // Llama: "llama-4-405b", "llama-3.3-70b" → major[.minor] right after
  // family. Canonical Meta releases always use a dash separator
  // (`Llama-3`, `Llama-3.3`, `llama-4-scout`); the dash is REQUIRED here
  // so community-fork ids like `Shahradmz/llama8b_SEND_1B-...` (where
  // "8b" is the parameter count) don't get read as v8. Single-digit
  // major + lookahead `(?![\dbB])` further rejects "llama-8b" if any
  // catalog ever encodes it without the canonical dash.
  if (family === 'llama') {
    const m = cleaned.match(/llama-(\d)(?![\dbB])(?:\.(\d+))?/);
    if (m) return parseFloat(`${m[1]}.${m[2] ?? '0'}`);
  }

  // Mistral: "mistral-large", "mistral-medium-3", "mistral-nemo" — most
  // ids carry only an alias not a numeric version. Use what we can find,
  // dot-only for minor.
  if (family === 'mistral') {
    const m = cleaned.match(/mistral[-]?(?:large|medium|small|tiny|nemo|7b|8x7b)?[-]?(\d+)(?:\.(\d+))?/);
    if (m) return parseFloat(`${m[1]}.${m[2] ?? '0'}`);
  }

  // GPT: "gpt-5.5", "gpt-4-turbo", "gpt-4o-mini" — single-digit major +
  // optional dot-minor right after "gpt-" prefix. The `(?!\d)` enforces
  // single-digit major so "gpt-50-mini" (hypothetical) doesn't read as v50.
  if (family === 'gpt') {
    const m = cleaned.match(/gpt-(\d)(?!\d)(?:[.](\d+))?/);
    if (m) return parseFloat(`${m[1]}.${m[2] ?? '0'}`);
  }

  // Grok: "grok-4.20-reasoning" (v4 minor 20) → 4.2; "grok-3" → 3.
  // The single-digit-major lookahead `(?!\d)` is what rejects
  // "grok-41-fast" — `4` followed by `1` fails the lookahead, so the
  // whole match falls through to score 0 instead of 41. Minor capped to
  // two digits so a date-like "grok-4-20251212" doesn't poison the score.
  if (family === 'grok') {
    const m = cleaned.match(/grok-(\d)(?!\d)(?:[.](\d{1,2}))?/);
    if (m) return parseFloat(`${m[1]}.${m[2] ?? '0'}`);
  }

  // 2026-05-12 (audit final): generic fallbacks only fire for families
  // WITHOUT a specific parser. If we recognized the family above but
  // its specific parser didn't match the id, that's a strong signal
  // the id is non-canonical (community fork, parameter-count
  // mis-encoding, etc.) — score it 0 instead of falling through to a
  // generic regex that would catch the parameter count or sequence
  // number and produce a fake version (e.g. `deepseek-coder-6.7b`
  // would otherwise read as v6.7 when 6.7 is the param count).
  //
  // Families WITH specific parsers (early-returned above):
  //   claude, kimi, deepseek, qwen, gemini, llama, mistral, gpt, grok
  // Families WITHOUT specific parsers (fall through to generics):
  //   command, magistral, pixtral, jamba, phi, nemotron
  const KNOWN_SPECIFIC_PARSER_FAMILIES: ReadonlySet<ModelFamily> = new Set([
    'gpt', 'claude', 'gemini', 'grok', 'kimi', 'deepseek', 'mistral', 'qwen', 'llama',
  ]);
  if (KNOWN_SPECIFIC_PARSER_FAMILIES.has(family)) {
    return 0;
  }

  // 3) Generic: first single-digit-major version token. The negative
  //    lookbehind/lookahead prevents matching numbers inside longer
  //    sequences (so `4o-mini` doesn't read as 4.0, but `5.5` does).
  const dotted = cleaned.match(/(?<![\d.])([1-9])\.(\d+)/);
  if (dotted) return parseFloat(`${dotted[1]}.${dotted[2]}`);

  // 4) Generic: standalone single-digit major (e.g. `gpt-4-turbo`).
  //    Strict separator after the digit — `-N-` or `-N$` or `-N.` only.
  //    This rejects parameter-count tokens like `-8b`, `-70b`, `-405B`,
  //    sequence-length suffixes like `-8k`, `-32k`, and date fragments
  //    like `-3rd`. Versions like `gpt-4-turbo` (`-4-`) and `claude-3`
  //    (terminal `-3` at end of token) still match.
  const major = cleaned.match(/-([1-9])(?=[-.]|$)/);
  if (major) return parseFloat(major[1]);

  return 0;
}

// ─── Top-level: scoreModel ─────────────────────────────────────────────

export function scoreModelFreshness(modelId: string): FreshnessSignal {
  const family = detectFamily(modelId);
  if (!family) {
    return {
      family: 'unknown',
      generationScore: 0,
      isPreview: false,
      isDeprecated: false,
      rationale: 'family_not_recognised',
    };
  }

  const preview = isPreviewModel(modelId);
  const deprecated = isDeprecatedModel(modelId);
  const score = parseGenericVersion(modelId, family);

  return {
    family,
    generationScore: score,
    isPreview: preview,
    isDeprecated: deprecated,
    rationale: `family=${family} score=${score}${preview ? ' preview' : ''}${deprecated ? ' deprecated' : ''}`,
  };
}

// ─── Comparator for sort() ─────────────────────────────────────────────

/**
 * Returns < 0 if `a` is fresher than `b`, > 0 if `b` is fresher, 0 if
 * tied. Designed for `Array.prototype.sort` (descending freshness).
 *
 * Order:
 *   1) Same family? Compare generationScore (higher wins).
 *   2) Stable beats preview at the same generation.
 *   3) Non-deprecated beats deprecated.
 *   4) Different families → 0 (defer to caller's secondary sort).
 */
export function compareFreshness(a: FreshnessSignal, b: FreshnessSignal): number {
  if (a.family !== b.family) return 0;

  if (a.generationScore !== b.generationScore) {
    return b.generationScore - a.generationScore;
  }

  // Same generation — stable beats preview.
  if (a.isPreview !== b.isPreview) {
    return a.isPreview ? 1 : -1;
  }

  // Non-deprecated beats deprecated.
  if (a.isDeprecated !== b.isDeprecated) {
    return a.isDeprecated ? 1 : -1;
  }

  return 0;
}
