// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4B §7 — Canonical model identity.
 *
 * Pure helper that maps a `(modelId, providerId)` pair to a canonical
 * model identity. Used to:
 *   - count "distinct models" correctly across providers (the J1D-R4A
 *     post-mortem proved provider count ≠ model count: deepinfra/X and
 *     huggingface/X are the SAME model, not two)
 *   - dedupe consensus diversity (3 endpoints of the same canonical
 *     model = 1 voice, not 3)
 *   - build the inventory matrix (canonical × provider × endpoint)
 *
 * Pure: no I/O, no DB. The function works on opaque metadata only.
 *
 * Canonicalization rules (J1D-R4B spec §7):
 *   1. Strip router/wrapper prefixes when they're known indirection layers
 *      and the suffix is a vendor-qualified model id (vendor/model-name).
 *      Examples: `deepinfra/openai/gpt-oss-120b` → `openai/gpt-oss-120b`.
 *      `huggingface/Qwen/Qwen3-235B-A22B-Thinking-2507` →
 *      `qwen/qwen3-235b-a22b-thinking-2507`.
 *      `hf:Qwen/Qwen3-235B...` → `qwen/qwen3-235b...`.
 *   2. NEVER collapse different models from the same vendor (gpt-oss-120b ≠
 *      gpt-oss-20b, Qwen3-235B ≠ Qwen3-32B).
 *   3. Preserve original ids in `sourceModelId` for audit.
 *   4. Case normalization is applied only for canonical comparison; the
 *      original display form is preserved for trace.
 *   5. Deterministic: same input → same output every call.
 *
 * NOT in scope:
 *   - resolving alias graphs from the catalog (handled by separate
 *     `provider-model-aliases.ts` table — that's broader semantic equivalence,
 *     not strict canonicalization)
 *   - inferring family from model name (handled by separate scorer)
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface CanonicalModelIdentity {
  /** Lowercased, prefix-stripped canonical id used for dedupe/comparison. */
  readonly canonicalModelId: string;
  /** Best-effort family slug derived from the canonical id (e.g., 'qwen',
   *  'gpt-oss', 'claude', 'gemini'). Undefined when not derivable. */
  readonly family?: string;
  /** Best-effort vendor slug (e.g., 'qwen', 'openai', 'anthropic', 'google',
   *  'mistralai'). Distinct from `family`: gemini family vendor is 'google'. */
  readonly vendor?: string;
  /** Lowercased model id without the wrapper prefix but BEFORE further
   *  family/vendor decomposition. Useful for comparison without losing
   *  vendor-qualified shape. */
  readonly normalizedModelId: string;
  /** Exact original modelId string as provided by the caller. */
  readonly sourceModelId: string;
}

export interface DeriveCanonicalIdentityInput {
  readonly modelId?: string;
  readonly apiModelId?: string;
  readonly providerId?: string;
  readonly originalProvider?: string;
  readonly metadata?: Record<string, unknown>;
}

// ─── Wrapper / router prefix set ──────────────────────────────────────────
//
// These are providers that *route* to other providers' models. When their
// id appears as a leading path segment in a modelId, it's a wrapper marker
// that must be stripped to find the canonical vendor/model.

const WRAPPER_PREFIXES: ReadonlyArray<string> = [
  'deepinfra',
  'huggingface',
  'hf',
  'openrouter',
  'requesty',
  'edenai',
  'phala',
  'routeway',
  'ai302',
  'aihubmix',
  'cometapi',
  'poe',
  'vercel-ai-gateway',
  'aiml',
  'nanogpt',
  'novita',
];

// Vendor → family hints. Used as a soft heuristic; absence does NOT block
// canonicalization, just leaves `family`/`vendor` undefined.
const VENDOR_FAMILY_HINTS: ReadonlyArray<{
  re: RegExp;
  vendor: string;
  family: string;
}> = [
  { re: /^qwen[/-]?qwen?/i, vendor: 'qwen', family: 'qwen' },
  { re: /^openai\/gpt-oss/i, vendor: 'openai', family: 'gpt-oss' },
  { re: /^openai\/gpt-/i, vendor: 'openai', family: 'gpt' },
  { re: /^openai\/o\d/i, vendor: 'openai', family: 'o-series' },
  { re: /^anthropic\/claude/i, vendor: 'anthropic', family: 'claude' },
  { re: /^claude/i, vendor: 'anthropic', family: 'claude' },
  { re: /^google\/gemini/i, vendor: 'google', family: 'gemini' },
  { re: /^gemini/i, vendor: 'google', family: 'gemini' },
  { re: /^xai\/grok/i, vendor: 'xai', family: 'grok' },
  { re: /^grok/i, vendor: 'xai', family: 'grok' },
  { re: /^mistralai?\//i, vendor: 'mistralai', family: 'mistral' },
  { re: /^mistral[-\/]/i, vendor: 'mistralai', family: 'mistral' },
  { re: /^cohere\//i, vendor: 'cohere', family: 'command' },
  { re: /^command-/i, vendor: 'cohere', family: 'command' },
  { re: /^moonshotai\//i, vendor: 'moonshotai', family: 'kimi' },
  { re: /^kimi/i, vendor: 'moonshotai', family: 'kimi' },
  { re: /^deepseek/i, vendor: 'deepseek', family: 'deepseek' },
  { re: /^meta-llama\//i, vendor: 'meta', family: 'llama' },
  { re: /^llama/i, vendor: 'meta', family: 'llama' },
  { re: /^microsoft\//i, vendor: 'microsoft', family: 'phi' },
  { re: /^phi-/i, vendor: 'microsoft', family: 'phi' },
];

// ─── Internal helpers ─────────────────────────────────────────────────────

function lower(v: string | undefined | null): string {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * Strip a single wrapper prefix (if present) from a path-qualified modelId.
 * Returns `{ remainder, stripped }` so caller can detect whether a strip
 * happened. The strip is conservative: only when the leading segment is in
 * `WRAPPER_PREFIXES` AND there's at least one more segment AND the next
 * segment looks like a vendor (contains a '/') OR is a known vendor.
 */
function stripWrapperPrefix(id: string): { remainder: string; stripped: boolean } {
  const trimmed = lower(id);
  if (!trimmed.includes('/') && !trimmed.startsWith('hf:')) {
    return { remainder: trimmed, stripped: false };
  }
  // Handle `hf:Qwen/...` style colon prefix
  if (trimmed.startsWith('hf:')) {
    return { remainder: trimmed.slice('hf:'.length), stripped: true };
  }
  const firstSlash = trimmed.indexOf('/');
  if (firstSlash < 1) return { remainder: trimmed, stripped: false };
  const head = trimmed.slice(0, firstSlash);
  if (!WRAPPER_PREFIXES.includes(head)) {
    return { remainder: trimmed, stripped: false };
  }
  const tail = trimmed.slice(firstSlash + 1);
  // Only strip when there's something after the prefix
  if (!tail) return { remainder: trimmed, stripped: false };
  return { remainder: tail, stripped: true };
}

function deriveVendorAndFamily(canonicalId: string): { vendor?: string; family?: string } {
  for (const hint of VENDOR_FAMILY_HINTS) {
    if (hint.re.test(canonicalId)) {
      return { vendor: hint.vendor, family: hint.family };
    }
  }
  // Fallback: when canonicalId has a vendor/model shape, take the first
  // path segment as the vendor.
  const firstSlash = canonicalId.indexOf('/');
  if (firstSlash > 0) {
    return { vendor: canonicalId.slice(0, firstSlash) };
  }
  return {};
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Lower-case + strip a router wrapper prefix from a modelId. Used as a
 * lightweight alternative to `deriveCanonicalModelIdentity` when callers
 * only want the comparison key.
 *
 * `Qwen/Qwen3-235B-A22B-Thinking-2507` → `qwen/qwen3-235b-a22b-thinking-2507`
 * `deepinfra/openai/gpt-oss-120b`      → `openai/gpt-oss-120b`
 * `hf:Qwen/Qwen3-235B-...`             → `qwen/qwen3-235b-...`
 */
export function normalizeModelId(input: string): string {
  if (!input) return '';
  // Strip up to TWO wrapper prefixes (covers `edenai/deepinfra/...` shape).
  // Mirrors `deriveCanonicalModelIdentity`'s peeling so the two helpers
  // agree on the canonical key for any nested-wrapper input.
  let current = input;
  for (let i = 0; i < 2; i++) {
    const { remainder, stripped } = stripWrapperPrefix(current);
    current = remainder;
    if (!stripped) break;
  }
  return current;
}

/**
 * Full canonical-identity derivation. Returns vendor/family hints when
 * recognizable. Always returns a valid (possibly minimal) identity even
 * for unknown vendors.
 *
 * Determinism: the same `(modelId, apiModelId, providerId)` tuple always
 * yields the same identity. `originalProvider` and `metadata` are
 * accepted for forward compatibility but currently do not influence the
 * canonical id.
 */
export function deriveCanonicalModelIdentity(
  input: DeriveCanonicalIdentityInput,
): CanonicalModelIdentity {
  // Prefer apiModelId when present — it's the upstream-visible name.
  // Fall back to modelId. Both empty → empty canonical.
  const source = String(input.apiModelId ?? input.modelId ?? '');
  if (!source) {
    return {
      canonicalModelId: '',
      normalizedModelId: '',
      sourceModelId: '',
    };
  }
  let normalizedModelId = lower(source);
  // Strip up to TWO wrapper prefixes (covers `edenai/deepinfra/...` shape).
  for (let i = 0; i < 2; i++) {
    const { remainder, stripped } = stripWrapperPrefix(normalizedModelId);
    if (!stripped) break;
    normalizedModelId = remainder;
  }
  const canonicalModelId = normalizedModelId;
  const { vendor, family } = deriveVendorAndFamily(canonicalModelId);
  return {
    canonicalModelId,
    family,
    vendor,
    normalizedModelId,
    sourceModelId: source,
  };
}
