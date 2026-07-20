// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability → endpoint heuristic.
 *
 * The "endpoint" of a model is the API surface the orchestrator must call to
 * exercise it (chat_completions, images, embeddings, etc.). Most providers do
 * NOT include this field on their /models payloads — it has to be inferred
 * from capabilities. Until 2026-04-29 the heuristic lived only on the base
 * fetcher class (`provider-model-fetcher.ts#determineEndpoint`), which meant:
 *
 *   1. Fetchers that don't extend `BaseProviderModelFetcher` (or that override
 *      `fetchModels` without going through the helper) silently skipped it.
 *   2. The discovery-service persistence paths (bulkUpsertModels,
 *      createNewModel, updateExistingModel) wrote `metadata` rows with no
 *      `endpoint` field — leaving the dynamic-model-selector with nothing to
 *      filter on at the SQL level.
 *
 * Extracting the rule into a pure function gives us:
 *
 *   - One callable from any layer (no inheritance dependency).
 *   - One place to pin the rule with a unit test.
 *   - A normalization seam in the discovery pipeline so every persisted row
 *     carries a non-null endpoint regardless of which fetcher produced it.
 *
 * The shape is intentionally permissive: callers in different layers carry
 * different metadata types (typed `ModelMetadata` from fetchers,
 * `Record<string, unknown>` from the central service). A loose input keeps
 * the function reusable without forcing a shared type.
 */

const VIDEO_GENERATION_CAPS = ['video_generation', 'image_to_video', 'video_to_video'] as const;
const TRANSCRIPTION_CAPS = ['speech_to_text', 'transcription', 'video_transcription'] as const;

type LooseMetadata = {
  endpoint?: unknown;
  tier?: unknown;
  [key: string]: unknown;
} | null | undefined;

/**
 * Returns the endpoint slug for a model given its capabilities and (optional)
 * metadata. If `metadata.endpoint` is already a non-empty string, it wins —
 * the fetcher knows better than the heuristic. Otherwise we walk capabilities
 * in priority order (most specific first) and fall back to `chat_completions`,
 * which covers the bulk of LLM models.
 */
export function inferEndpoint(
  capabilities: readonly string[],
  metadata?: LooseMetadata,
): string {
  if (typeof metadata?.endpoint === 'string' && metadata.endpoint.trim().length > 0) {
    return metadata.endpoint;
  }

  const caps = new Set<string>(capabilities);

  if (caps.has('image_generation')) return 'images';
  if (VIDEO_GENERATION_CAPS.some((c) => caps.has(c))) return 'videos';
  if (caps.has('text_to_speech')) return 'audio_speech';
  if (TRANSCRIPTION_CAPS.some((c) => caps.has(c))) return 'audio_transcriptions';
  if (caps.has('realtime')) return 'realtime';
  if (caps.has('function_calling') && metadata?.tier === 'premium') return 'responses';
  if (caps.has('embedding')) return 'embeddings';
  if (caps.has('completions')) return 'completions';

  return 'chat_completions';
}

/**
 * Returns a metadata object with `endpoint` set, inferring it if missing.
 * Used by the discovery-service persistence paths to guarantee every
 * persisted row carries the field — see `central-model-discovery-service.ts`.
 *
 * The input is not mutated.
 */
export function withInferredEndpoint<T extends Record<string, unknown>>(
  metadata: T,
  capabilities: readonly string[],
): T & { endpoint: string } {
  if (typeof metadata.endpoint === 'string' && metadata.endpoint.trim().length > 0) {
    return metadata as T & { endpoint: string };
  }
  return { ...metadata, endpoint: inferEndpoint(capabilities, metadata) };
}
