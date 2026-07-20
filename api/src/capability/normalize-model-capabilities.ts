// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability Normalizer — single source of truth for "is this model chat-capable?".
 *
 * Background (2026-05-11 canary failure):
 *   The catalog has two capability columns:
 *     - Model.capabilityUris  (canonical, text[], populated by HCRA)
 *     - Model.capabilities    (legacy Json, populated by discovery probes)
 *   Discovery/upsert paths populate `capabilities` reliably. The HCRA
 *   capability-classification rollup populates `capabilityUris`. In dev
 *   the rollup has not run, leaving `capability_uris = '{}'` for every
 *   row even though the legacy column has chat-capability data for
 *   ~19 854 active models.
 *
 *   Downstream filters (`pool-builder.filterByModality`, `base-strategy
 *   .getEligibleModelsFallback`, `parallel-race-strategy`, …) read only
 *   `model.capabilities` — but THAT field gets populated by
 *   `catalog-resolver.ts:208`, which writes `row.capabilityUris` (empty)
 *   and discards the legacy column. Result: 198/198 candidates dropped
 *   with `no_chat_capability(198)` in modality_filter, every C3
 *   execution skipped-predispatch.
 *
 * This module is the ONE function every capability-reading site should
 * call. It reads `capabilityUris` first (canonical), falls back to
 * legacy `capabilities` only when canonical is empty/missing, and reports
 * the source so dashboards/logs can track fallback usage.
 *
 * Precedence rule (intentional, documented):
 *   - capabilityUris non-empty → CANONICAL, legacy column ignored
 *   - capabilityUris empty/null + capabilities populated → LEGACY fallback
 *   - both empty/null → NONE
 *
 * This means a legacy-only model is still chat-capable (good — fixes the
 * canary). It also means a model with EXPLICITLY-curated capability_uris
 * (e.g. `['image_generation']`) is NOT silently overridden by legacy
 * data — the explicit curation wins.
 */

/**
 * Loosely-typed model shape this normalizer can read. Accepts the Prisma
 * row, the in-memory `Model` type from `@/types`, and the
 * `DiscoveredModel` interface — all carry either `capabilityUris` /
 * `capability_uris` and `capabilities` in slightly different shapes.
 */
export interface ModelLike {
  id?: string;
  modelId?: string;
  providerId?: string;
  /** Prisma camelCase. */
  capabilityUris?: readonly string[] | string[] | null;
  /** Snake_case (raw SQL select / some serializers). */
  capability_uris?: readonly string[] | string[] | null;
  /** Legacy Json column — can be array, object, string, or null. */
  capabilities?: unknown;
}

export type CapabilitySource =
  | 'capability_uris'
  | 'legacy_capabilities'
  | 'inferred'
  | 'none';

export interface NormalizedModelCapabilities {
  /** Lower-cased, de-duplicated capability tokens. */
  raw: readonly string[];
  source: CapabilitySource;

  hasChat: boolean;
  hasVision: boolean;
  hasTools: boolean;
  hasJson: boolean;
  hasStreaming: boolean;
  hasEmbedding: boolean;
  hasImageGeneration: boolean;
  hasAudio: boolean;
}

/**
 * Aliases that all mean "the model can perform open-domain chat /
 * instruction following / text generation". Listed explicitly so the
 * mapping is auditable. Add a new alias here when discovery starts
 * emitting it — DO NOT add per-call special-casing.
 */
const CHAT_ALIASES = new Set([
  'chat',
  'text-generation',
  'text_generation',
  'llm',
  'completion',
  'completions',
  'conversational',
]);

const VISION_ALIASES = new Set([
  'vision', 'image-input', 'image_input', 'multimodal-vision', 'multimodal_vision',
]);

const TOOL_ALIASES = new Set([
  'tools', 'function_calling', 'function-calling', 'tool_use', 'tool-use',
]);

const JSON_ALIASES = new Set([
  'json_mode', 'json-mode', 'structured_output', 'structured-output',
]);

const STREAMING_ALIASES = new Set(['streaming', 'stream']);

const EMBEDDING_ALIASES = new Set(['embedding', 'embeddings', 'vector']);

const IMAGE_GEN_ALIASES = new Set([
  'image_generation', 'image-generation', 'image_editing', 'image-editing',
]);

const AUDIO_ALIASES = new Set([
  'audio', 'audio_generation', 'audio-generation',
  'text_to_speech', 'text-to-speech', 'tts',
  'speech_to_text', 'speech-to-text', 'stt',
]);

/**
 * Parses any of the formats the legacy `capabilities` column has ever
 * had into a flat string[]. Never throws; bad data → empty array.
 */
function parseLegacyCapabilities(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  if (typeof raw === 'string') {
    // Some legacy rows have the JSON serialised as string (e.g. `'["chat"]'`)
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        return parseLegacyCapabilities(JSON.parse(trimmed));
      } catch {
        return [];
      }
    }
    // Or just a single value: `'chat'`
    return [trimmed.toLowerCase()];
  }
  if (typeof raw === 'object') {
    // Some rows have shape `{chat: true, embedding: false}`. Map true → key.
    const obj = raw as Record<string, unknown>;
    return Object.entries(obj)
      .filter(([, v]) => v === true)
      .map(([k]) => k.toLowerCase());
  }
  return [];
}

function normalizeUris(uris: readonly string[] | string[] | null | undefined): string[] {
  if (!uris) return [];
  return uris
    .filter((u): u is string => typeof u === 'string')
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
}

function deriveFlags(tokens: readonly string[]) {
  const set = new Set(tokens);
  const has = (aliases: ReadonlySet<string>): boolean => {
    for (const a of aliases) if (set.has(a)) return true;
    return false;
  };
  return {
    hasChat: has(CHAT_ALIASES),
    hasVision: has(VISION_ALIASES),
    hasTools: has(TOOL_ALIASES),
    hasJson: has(JSON_ALIASES),
    hasStreaming: has(STREAMING_ALIASES),
    hasEmbedding: has(EMBEDDING_ALIASES),
    hasImageGeneration: has(IMAGE_GEN_ALIASES),
    hasAudio: has(AUDIO_ALIASES),
  };
}

/**
 * The single function every capability-reading site should call.
 *
 *   const cap = resolveModelCapabilities(row);
 *   if (cap.hasChat) { ... }
 */
export function resolveModelCapabilities(model: ModelLike | null | undefined): NormalizedModelCapabilities {
  const empty = (): NormalizedModelCapabilities => ({
    raw: [],
    source: 'none',
    hasChat: false, hasVision: false, hasTools: false, hasJson: false,
    hasStreaming: false, hasEmbedding: false, hasImageGeneration: false, hasAudio: false,
  });
  if (!model) return empty();

  const canonical = normalizeUris(
    (model.capabilityUris ?? model.capability_uris) as readonly string[] | null | undefined,
  );
  if (canonical.length > 0) {
    return {
      raw: canonical,
      source: 'capability_uris',
      ...deriveFlags(canonical),
    };
  }

  const legacy = parseLegacyCapabilities(model.capabilities);
  if (legacy.length > 0) {
    return {
      raw: legacy,
      source: 'legacy_capabilities',
      ...deriveFlags(legacy),
    };
  }

  return empty();
}

/**
 * Convenience predicate matching the old `caps.includes('chat')` call
 * sites. Cheaper to read than `resolveModelCapabilities(m).hasChat` at
 * call sites that only care about the boolean.
 */
export function isChatCapable(model: ModelLike | null | undefined): boolean {
  return resolveModelCapabilities(model).hasChat;
}

/**
 * For metrics: aggregate which source the candidate pool actually
 * resolved from. Useful in dashboards to spot when legacy fallback
 * is doing more work than expected (signals a capability_uris
 * regression).
 */
export function summariseSources(
  models: readonly ModelLike[],
): Record<CapabilitySource, number> {
  const out: Record<CapabilitySource, number> = {
    capability_uris: 0,
    legacy_capabilities: 0,
    inferred: 0,
    none: 0,
  };
  for (const m of models) {
    const r = resolveModelCapabilities(m);
    out[r.source] += 1;
  }
  return out;
}
