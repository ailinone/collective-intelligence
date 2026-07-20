// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1R2 — Model name normalizer for cross-provider matching.
 *
 * Different providers store the same logical model under different
 * naming conventions:
 *   - `meta/llama-3.2-11b`                       (vercel-ai-gateway)
 *   - `meta-llama/Llama-3.2-11B-Vision-Instruct` (deepinfra)
 *   - `Llama-3.2-11B-Vision-Instruct`            (infermatic)
 *   - `meta/llama-3.2-11b-vision-instruct`       (nvidia)
 *
 * For multi-provider route fanout, we need to ask "which providers in
 * the catalog serve THIS logical model?" — and the matching has to
 * tolerate the naming drift WITHOUT collapsing genuinely-different
 * models onto each other (e.g., `gemma-3-4b-it` ≠ `gemma-3-4b-it-abliterated`).
 *
 * STRATEGY (conservative):
 *   1. Lowercase
 *   2. Strip a known vendor prefix (`meta/`, `meta-llama/`, `google/`,
 *      `aws/`, `amazon/`, `deepinfra/`, `anthropic/`, `openai/`,
 *      `mistralai/`, `microsoft/`, `qwen/`, `meta-llama.`,
 *      `google.`, etc.)
 *   3. Normalize separators: `_` and `.` → `-`; collapse `--` to `-`
 *   4. Trim trailing `-instruct` / `-it` / `-chat` / `-base` once (these
 *      are common variant tags); KEEP `-vision`, `-coder`, `-math`,
 *      `-r1`, `-preview` etc. because those distinguish capability families.
 *
 * NEVER strips numeric suffixes that change parameter count (`-7b` vs
 * `-70b`), language qualifiers (`-en`, `-es`), or fine-tune authors
 * (`unsloth/`, `braindao/`).
 */

const VENDOR_PREFIXES = [
  'meta-llama/',
  'meta/',
  'google/',
  'google.',
  'amazon/',
  'amazon.',
  'aws/',
  'aws.',
  'anthropic/',
  'openai/',
  'mistralai/',
  'mistral/',
  'microsoft/',
  'qwen/',
  'deepseek-ai/',
  'deepseek/',
  // Sometimes the catalog stores `<router>/<vendor>/<model>` (e.g., deepinfra/meta-llama/...) —
  // we strip ONE level here so the next pass can re-strip the vendor.
  'deepinfra/',
  'huggingface/',
  'openrouter/',
  'groq/',
] as const;

/**
 * Tags that mark a variant but typically refer to "the same logical
 * model" across providers (a chat-tuned instruct on provider A is the
 * same model as the instruct on provider B). Trimmed ONCE at the END
 * of the core for matching purposes.
 */
const VARIANT_TAGS = ['-instruct', '-it', '-chat', '-base', '-hf'] as const;

/**
 * Compound tag suffixes that providers append on top of the core,
 * representing **same-model** capability variants (a vision-enabled
 * instruct is the same logical model as the text-only one for our
 * routing purposes — both serve `chat`). Used by `buildCatalogMatchPatterns`
 * to generate the full pattern set so catalog rows like
 * `meta-llama/Llama-3.2-11B-Vision-Instruct` match a request for
 * `meta/llama-3.2-11b`.
 *
 * Strict: compound suffixes are only appended to the BASE core (after
 * a vendor prefix); fine-tune authors (`unsloth/`, `braindao/`, etc.)
 * still don't collapse onto the base because they're authored variants,
 * not capability variants.
 */
const _COMPOUND_VARIANT_SUFFIXES = [
  '',
  '-instruct',
  '-it',
  '-chat',
  '-base',
  '-hf',
  '-vision',
  '-vision-instruct',
  '-vision-preview',
  '-preview',
  '-turbo',
] as const;

/**
 * Normalize a logical model id to a canonical "core" suitable for
 * cross-provider equality.
 *
 * Examples:
 *   normalizeLogicalModelId('meta/llama-3.2-11b')
 *     → 'llama-3.2-11b'
 *   normalizeLogicalModelId('meta-llama/Llama-3.2-11B-Vision-Instruct')
 *     → 'llama-3.2-11b-vision'
 *   normalizeLogicalModelId('google/gemma-3-4b-it')
 *     → 'gemma-3-4b'
 *   normalizeLogicalModelId('gemma-3-4b-it')
 *     → 'gemma-3-4b'
 *   normalizeLogicalModelId('google/gemma-3-4b-it-qat-q4_0-unquantized')
 *     → 'gemma-3-4b-it-qat-q4-0-unquantized'   (variant tag NOT trimmed:
 *       trailing `-unquantized` follows `-q4-0`, so `-it` is not at the END)
 */
export function normalizeLogicalModelId(id: string): string {
  if (!id) return '';
  let s = id.trim().toLowerCase();
  // Strip vendor prefixes (one or more levels).
  let prevS: string | null = null;
  while (prevS !== s) {
    prevS = s;
    for (const p of VENDOR_PREFIXES) {
      if (s.startsWith(p)) {
        s = s.slice(p.length);
        break;
      }
    }
  }
  // Normalize separators. We keep DOTS in version numbers (e.g.
  // `llama-3.2-11b`) because providers use `3.2` interchangeably with
  // `3-2`. The buildCatalogMatchPatterns helper emits BOTH forms so the
  // catalog query catches either spelling. `_` is normalized to `-`.
  s = s.replace(/_/g, '-').replace(/-+/g, '-');
  // Trim one trailing variant tag (only if the WHOLE tag is at the end).
  for (const tag of VARIANT_TAGS) {
    if (s.endsWith(tag)) {
      s = s.slice(0, -tag.length);
      break;
    }
  }
  return s;
}

/**
 * Loose equality: two ids are considered to refer to the same logical
 * model when their normalized cores match. Returns one of:
 *   - 'exact'      — full string equality after normalization
 *   - 'alias'      — exact OR one is a strict suffix of the other
 *                    (e.g., `llama-3.2-11b` vs `llama-3.2-11b-vision`)
 *   - 'normalized' — only casing/separator difference
 *   - 'no_match'   — different cores
 *
 * Used to assign `confidence` to catalog-discovered serving providers.
 */
export type ModelMatchConfidence = 'exact' | 'alias' | 'normalized' | 'no_match';

export function compareModelIds(a: string, b: string): ModelMatchConfidence {
  if (!a || !b) return 'no_match';
  if (a === b) return 'exact';
  const na = normalizeLogicalModelId(a);
  const nb = normalizeLogicalModelId(b);
  if (!na || !nb) return 'no_match';
  // Version-aware: `3.2` and `3-2` refer to the same model version.
  const dotless = (s: string) => s.replace(/\./g, '-');
  if (dotless(na) === dotless(nb)) return a.toLowerCase() === b.toLowerCase() ? 'exact' : 'normalized';
  // Strict-suffix alias relation: one core extends the other with a known
  // tag (e.g., `-vision`, `-vision-instruct`). The shorter must be a
  // hyphen-bounded prefix of the longer to qualify. We compare using
  // the version-aware dotless form so `3.2` and `3-2` align.
  const naDL = dotless(na);
  const nbDL = dotless(nb);
  const [shorter, longer] = naDL.length <= nbDL.length ? [naDL, nbDL] : [nbDL, naDL];
  if (longer.startsWith(`${shorter}-`)) {
    // Allow ONLY these tail extensions (conservative — anything else
    // could be a genuinely different model family).
    const tail = longer.slice(shorter.length); // includes leading `-`
    const SAFE_TAIL_PATTERNS = [
      '-vision',
      '-vision-instruct',
      '-vision-preview',
      '-instruct',
      '-it',
      '-chat',
      '-base',
      '-hf',
      '-preview',
      '-turbo',
    ];
    if (SAFE_TAIL_PATTERNS.includes(tail)) return 'alias';
  }
  return 'no_match';
}

/**
 * Build a set of SQL `LOWER(name) = lower(pattern)` candidates that
 * a catalog query can union to find rows matching the given logical
 * model id. Includes the original id, vendor-prefixed variants, and
 * the normalized core (no prefix).
 *
 * Caller is responsible for SQL escaping. The function only emits
 * lowercase pattern strings — no wildcards, no fuzzy ILIKE.
 */
export function buildCatalogMatchPatterns(logicalModelId: string): readonly string[] {
  const id = logicalModelId.trim();
  if (!id) return [];
  const lower = id.toLowerCase();
  const core = normalizeLogicalModelId(id);
  const out = new Set<string>();
  out.add(lower);
  // Version variants: emit BOTH dotted and dashed spellings so the
  // catalog match catches `3.2` and `3-2` interchangeably.
  const expandVersions = (s: string): readonly string[] => {
    const dotless = s.replace(/\./g, '-');
    return s === dotless ? [s] : [s, dotless];
  };
  // Conservative exact-match set: just the BASE core + standard variant
  // tags. The router/builder layer adds the broader `contains`-style
  // match via `buildCatalogContainsTerms`, so we DON'T explode the
  // pattern count here with vendor × compound × router cartesian.
  if (core) {
    for (const v of expandVersions(core)) out.add(v);
    for (const tag of VARIANT_TAGS) {
      for (const v of expandVersions(`${core}${tag}`)) out.add(v);
    }
  }
  // Single-vendor prefixed forms (no compound suffixes here — those are
  // covered by the `contains` query in the lookup adapter).
  const COMMON_VENDORS = ['meta', 'meta-llama', 'google', 'amazon', 'aws', 'anthropic', 'openai', 'mistralai', 'microsoft', 'qwen', 'deepseek-ai'];
  if (core) {
    for (const v of COMMON_VENDORS) {
      for (const c of expandVersions(core)) {
        out.add(`${v}/${c}`);
        out.add(`${v}.${c}`);
        for (const tag of VARIANT_TAGS) {
          for (const ct of expandVersions(`${c}${tag}`)) {
            out.add(`${v}/${ct}`);
            out.add(`${v}.${ct}`);
          }
        }
      }
    }
  }
  return Array.from(out);
}

/**
 * Returns substring search terms suitable for a Postgres
 * `name ILIKE %term%` query. Used in addition to the exact-equality
 * pattern set so we capture provider-specific naming like
 * `Llama-3.2-11B-Vision-Instruct` without exploding the pattern count.
 *
 * The terms are intentionally narrow (the dotless and dotted version of
 * the core). The lookup adapter post-filters with `compareModelIds` so
 * fine-tunes (`unsloth/gemma-3-4b-it-abliterated`) don't survive.
 */
export function buildCatalogContainsTerms(logicalModelId: string): readonly string[] {
  const core = normalizeLogicalModelId(logicalModelId);
  if (!core) return [];
  const dotless = core.replace(/\./g, '-');
  const terms = new Set<string>();
  terms.add(core);
  if (dotless !== core) terms.add(dotless);
  return Array.from(terms);
}
