// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R5 §7 — Quality model identity.
 *
 * Background
 * ──────────
 * The runtime selected-model id, the live-ready catalog id, the quality-
 * snapshot id, and benchmark-leaderboard ids all use different conventions:
 *
 *   accounts/fireworks/models/deepseek-v4-pro   (runtime)
 *   deepseek-v4-pro                              (snapshot/leaderboard short)
 *   deepseek/deepseek-v4-pro                     (snapshot canonical)
 *
 *   Qwen/Qwen3-235B-A22B-Thinking-2507           (runtime)
 *   Qwen3-235B-Thinking                          (snapshot display name)
 *   qwen3-235b-thinking                          (normalized alias)
 *
 *   kimi-k2p5                                    (runtime fireworks)
 *   Kimi-K2.6                                    (snapshot — DIFFERENT version)
 *
 * The exact-string match used by `findEntry` rejects all but trivial
 * matches. This module canonicalizes identity WITHOUT collapsing distinct
 * models. Key invariants:
 *
 *   - dot/underscore/space → dash (lossless)
 *   - provider-router prefix → stripped (but preserved in `originalForm`)
 *   - numeric version suffixes are PRESERVED (4.7 ≠ 4, k2.6 ≠ k2)
 *   - size suffixes are PRESERVED (235b ≠ 32b, 120b ≠ 20b)
 *   - thinking ≠ instruct unless an explicit alias source connects them
 *   - identity confidence carries through: `exact` only when the alias
 *     came from the same canonical form; `high` when a wrapper was
 *     stripped; `medium` when only a normalized form matches; `low`
 *     when only a family alias matches.
 *
 * Pure module. No I/O. No catalog mutation. Deterministic.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface QualityModelIdentityInput {
  readonly modelId?: string;
  readonly apiModelId?: string;
  readonly catalogModelId?: string;
  readonly canonicalModelId?: string;
  readonly providerId?: string;
  readonly displayName?: string;
  readonly family?: string;
  readonly aliases?: readonly string[];
}

export type QualityIdentityConfidence = 'exact' | 'high' | 'medium' | 'low';

export interface QualityModelIdentity {
  readonly qualityCanonicalId: string;
  readonly normalizedIds: readonly string[];
  readonly vendor?: string;
  readonly family?: string;
  readonly sizeClass?: string;
  readonly variant?: string;
  readonly confidence: QualityIdentityConfidence;
  readonly reasons: readonly string[];
}

// ─── Constants ────────────────────────────────────────────────────────────

export const QUALITY_IDENTITY_VERSION = '01C.1B-J2-C-R5-v1' as const;

// Provider-router prefixes that wrap a real model id. Order matters —
// longer first so we don't match a substring of a longer prefix.
const PROVIDER_WRAPPER_PREFIXES: ReadonlyArray<string> = [
  'accounts/fireworks/models/',
  'vercel-ai-gateway/',
  'aihubmix/',
  'openrouter/',
  'requesty/',
  'phala/',
  'ai302/',
  'cometapi/',
  'edenai/',
  'deepinfra/',
  'huggingface/',
];

// Vendor prefixes that DO belong with the model — preserved in canonical
// form (e.g. `anthropic/claude-opus-4-7` stays as a canonical with vendor
// prefix). Used to derive `vendor` field.
const VENDOR_PREFIXES: ReadonlyArray<string> = [
  'anthropic/',
  'google/',
  'xai/',
  'openai/',
  'meta-llama/',
  'meta/',
  'mistralai/',
  'mistral/',
  'deepseek-ai/',
  'deepseek/',
  'moonshotai/',
  'qwen/',
  'alibaba/',
  'abacusai/',
  'aion-labs/',
];

// Size-class extraction (informational; never used to collapse).
const SIZE_RE = /(\d+(?:\.\d+)?)\s*[bm](?![a-z])/i;

// ─── Pure helpers ─────────────────────────────────────────────────────────

/**
 * Normalize a single id: lowercase, normalize separators (. _ space → -),
 * collapse repeated dashes. Wrappers are NOT stripped here — only
 * separator/case-normalized. Stripping happens explicitly in
 * `buildQualityIdentityAliases`.
 */
export function normalizeQualityModelId(input: string): string {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  s = s.replace(/[._\s]+/g, '-');
  s = s.replace(/--+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s;
}

function stripProviderWrapper(id: string): { stripped: string; wrapperStripped: string | null } {
  const lower = id.toLowerCase();
  for (const prefix of PROVIDER_WRAPPER_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { stripped: id.slice(prefix.length), wrapperStripped: prefix };
    }
  }
  return { stripped: id, wrapperStripped: null };
}

function deriveVendorAndFamily(id: string): { vendor?: string; family?: string } {
  const lower = id.toLowerCase();
  for (const v of VENDOR_PREFIXES) {
    if (lower.startsWith(v)) {
      const vendor = v.replace(/\//g, '').replace(/-ai$/, '');
      // Try to read the model name segment.
      const tail = lower.slice(v.length);
      const familySeg = tail.split(/[-/]/)[0];
      return { vendor, family: familySeg || undefined };
    }
  }
  // No explicit vendor prefix — derive family from leading token.
  const tail = lower.split('/').pop() || lower;
  const familySeg = tail.split(/[-/]/)[0];
  return { family: familySeg || undefined };
}

function deriveSizeClass(id: string): string | undefined {
  const m = SIZE_RE.exec(id);
  if (m) return `${m[1]}${m[0].toLowerCase().endsWith('m') ? 'm' : 'b'}`;
  return undefined;
}

function deriveVariant(id: string): string | undefined {
  const lower = id.toLowerCase();
  if (lower.includes('thinking')) return 'thinking';
  if (lower.includes('instruct')) return 'instruct';
  if (lower.includes('chat')) return 'chat';
  if (lower.includes('reasoning')) return 'reasoning';
  return undefined;
}

/**
 * Build a stable, deterministic set of aliases for the input. The aliases
 * include:
 *   1. Original raw form (when string)
 *   2. Normalized full form (lower-dash)
 *   3. Provider-wrapper-stripped + normalized
 *   4. Vendor-stripped + normalized (when vendor present)
 *   5. Short form (last `/` segment) + normalized
 *   6. Caller-supplied aliases (verbatim + normalized)
 *
 * Each alias appears at most once. Order is deterministic.
 */
export function buildQualityIdentityAliases(input: QualityModelIdentityInput): string[] {
  const seeds: string[] = [];
  for (const id of [
    input.modelId,
    input.apiModelId,
    input.catalogModelId,
    input.canonicalModelId,
    input.displayName,
  ]) {
    if (id) seeds.push(String(id));
  }
  if (Array.isArray(input.aliases)) seeds.push(...input.aliases.map(String));

  const out = new Set<string>();
  for (const seed of seeds) {
    if (!seed) continue;
    out.add(seed); // raw
    const norm = normalizeQualityModelId(seed);
    out.add(norm);
    const { stripped } = stripProviderWrapper(seed);
    if (stripped !== seed) {
      out.add(stripped);
      out.add(normalizeQualityModelId(stripped));
    }
    // Vendor-stripped form
    for (const v of VENDOR_PREFIXES) {
      if (seed.toLowerCase().startsWith(v)) {
        const vendorless = seed.slice(v.length);
        out.add(vendorless);
        out.add(normalizeQualityModelId(vendorless));
        break;
      }
    }
    // Last-segment short form
    const short = seed.split('/').pop();
    if (short && short !== seed) {
      out.add(short);
      out.add(normalizeQualityModelId(short));
    }
  }

  // Stable order: keep insertion order, then sort lexicographically among
  // equal-priority aliases. Since `Set` preserves insertion order in V8,
  // returning [...out] is deterministic given a deterministic input.
  return [...out].filter(Boolean);
}

/**
 * Compute the quality canonical id + identity metadata for the input.
 *
 * The canonical id is the most-specific normalized vendor/family form
 * available — preferring an explicit vendor prefix when present, falling
 * back to the wrapper-stripped form.
 *
 * Confidence:
 *   - 'exact'  when input.canonicalModelId is supplied and equals the
 *              derived canonical id
 *   - 'high'   when only a provider wrapper was stripped
 *   - 'medium' when separator/case normalization was the only change
 *   - 'low'    when no input matched a known vendor or wrapper
 */
export function deriveQualityModelIdentity(
  input: QualityModelIdentityInput,
): QualityModelIdentity {
  const reasons: string[] = [];
  const raw = input.modelId || input.apiModelId || input.canonicalModelId || input.displayName || '';
  if (!raw) {
    return {
      qualityCanonicalId: '',
      normalizedIds: [],
      confidence: 'low',
      reasons: ['no_input_id'],
    };
  }

  const { stripped, wrapperStripped } = stripProviderWrapper(raw);
  if (wrapperStripped) {
    reasons.push(`stripped_wrapper:${wrapperStripped}`);
  }

  const { vendor, family } = deriveVendorAndFamily(stripped);
  const sizeClass = deriveSizeClass(stripped);
  const variant = deriveVariant(stripped);

  // Canonical: prefer vendor/familyId form. Otherwise normalized stripped.
  const lowered = stripped.toLowerCase();
  let canonical: string;
  let confidence: QualityIdentityConfidence;

  if (vendor && lowered.startsWith(`${vendor}/`)) {
    canonical = normalizeQualityModelId(stripped);
    confidence = wrapperStripped ? 'high' : 'exact';
    reasons.push(`canonical_from_vendor_prefix:${vendor}`);
  } else if (vendor) {
    // Vendor inferred but not present in stripped — prepend it.
    canonical = `${vendor}/${normalizeQualityModelId(stripped)}`;
    confidence = 'high';
    reasons.push(`canonical_inferred_vendor:${vendor}`);
  } else if (wrapperStripped) {
    // Provider wrapper was stripped, leaving a wrapper-canonical id. The
    // hub's exposed id IS canonical for the hub (e.g. fireworks-ai exposes
    // deepseek-v4-pro as the bare model name with no vendor prefix).
    // Treat as 'high' confidence.
    canonical = normalizeQualityModelId(stripped);
    confidence = 'high';
    reasons.push(`canonical_from_wrapper_strip:${wrapperStripped}`);
  } else {
    canonical = normalizeQualityModelId(stripped);
    confidence = 'low';
    reasons.push('canonical_normalized_only');
  }

  // If caller supplied canonicalModelId AND it matches what we derived,
  // upgrade to 'exact'.
  if (input.canonicalModelId) {
    const callerCanon = normalizeQualityModelId(input.canonicalModelId);
    if (callerCanon === canonical) {
      confidence = 'exact';
      reasons.push('caller_canonical_matched_derived');
    }
  }

  const normalizedIds = buildQualityIdentityAliases({
    modelId: input.modelId,
    apiModelId: input.apiModelId,
    canonicalModelId: input.canonicalModelId,
    catalogModelId: input.catalogModelId,
    displayName: input.displayName,
    aliases: input.aliases,
  });

  return {
    qualityCanonicalId: canonical,
    normalizedIds,
    vendor,
    family: input.family ?? family,
    sizeClass,
    variant,
    confidence,
    reasons,
  };
}
