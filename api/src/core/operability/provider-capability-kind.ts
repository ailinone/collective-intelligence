// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G2 — Provider Capability Kind.
 *
 * Classifies providers by the modality they primarily serve so the
 * readiness audit doesn't treat audio/embeddings/image providers as
 * "broken chat providers". A provider with kind != 'chat' falls into
 * bucket N (specialized non-chat) when the chat probe is inapplicable,
 * not into the unknown bucket.
 *
 * The kind is INDEPENDENT from the catalog `capabilities[]` array — that
 * array lives on individual models. This module classifies the PROVIDER
 * by its primary endpoint family (chat / embeddings / STT / TTS / image /
 * video / rerank / gateway / local / multi-modal).
 *
 * Providers not in this map default to `'chat'` — the audit then chat-probes
 * them. False positives (treating a chat provider as specialized) are
 * worse than false negatives, so the map is intentionally narrow.
 */
export type ProviderCapabilityKind =
  | 'chat'
  | 'embeddings'
  | 'speech_to_text'
  | 'text_to_speech'
  | 'image_generation'
  | 'video_generation'
  | 'rerank'
  | 'search'
  | 'gateway'
  | 'local'
  | 'multi_modal'
  | 'unknown';

/**
 * Static classification of known specialized providers. This is OPERATOR
 * KNOWLEDGE — these providers offer specialized endpoints (STT, TTS,
 * embeddings, image) and rarely expose chat completions. Probing them
 * as chat producers fails for structural reasons, not for credit/auth.
 */
const PROVIDER_KIND_MAP: Readonly<Record<string, ProviderCapabilityKind>> = {
  // ── Audio ──
  deepgram: 'speech_to_text',
  cartesia: 'text_to_speech',
  elevenlabs: 'text_to_speech',
  // ── Embeddings / rerank ──
  voyage: 'embeddings',
  // ── Image / video ──
  recraft: 'image_generation',
  runwayml: 'video_generation',
  topaz: 'image_generation',
  bfl: 'image_generation',
  imagerouter: 'image_generation',
  // ── Multi-modal hosting / gateway providers ──
  replicate: 'multi_modal',
  // ── Search-augmented ──
  perplexity: 'search', // also serves chat, but the primary use case is search-augmented
  // ── Local / self-hosted ──
  ollama: 'local',
  'local-llama': 'local',
  'local-kobold': 'local',
  'local-embeddings': 'embeddings',
  xinference: 'local',
  vllm: 'local',
  'lm-studio': 'local',
  triton: 'local',
  // ── Gateways (chat-capable but mostly aggregators) ──
  'gemini-openai': 'gateway',
  'github-models': 'gateway',
  bytez: 'gateway',
};

export function classifyProviderCapabilityKind(providerId: string): ProviderCapabilityKind {
  return PROVIDER_KIND_MAP[providerId.toLowerCase()] ?? 'chat';
}

export function isChatPrimaryProvider(providerId: string): boolean {
  const kind = classifyProviderCapabilityKind(providerId);
  // 'chat' and 'multi_modal' providers should be chat-probed.
  // 'search' providers (perplexity) often ALSO serve chat; probe.
  // 'gateway' providers proxy chat; probe.
  // 'local' providers can serve chat if they have the model; probe.
  return kind === 'chat' || kind === 'multi_modal' || kind === 'search' || kind === 'gateway' || kind === 'local';
}

export function isSpecializedNonChatProvider(providerId: string): boolean {
  const kind = classifyProviderCapabilityKind(providerId);
  return (
    kind === 'embeddings' ||
    kind === 'speech_to_text' ||
    kind === 'text_to_speech' ||
    kind === 'image_generation' ||
    kind === 'video_generation' ||
    kind === 'rerank'
  );
}
