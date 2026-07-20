// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared regex-based capability inference for model IDs.
 *
 * Used by the generic OpenAI-compatible hub fetcher and the CometAPI fetcher
 * (and any other fetcher that needs pattern-based capability classification).
 *
 * Rules are evaluated in order — first match wins. Non-chat categories
 * (image, video, tts, stt, embedding) are checked before the broad chat
 * category so that specialised models are not misclassified.
 */

import type { ModelCapability } from '@/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CapabilityPattern {
  /** Regexes tested against the lowercased model ID. */
  patterns: RegExp[];
  /** Capabilities assigned when any pattern matches. */
  capabilities: ModelCapability[];
  /** Logical endpoint for routing. */
  endpoint: string;
  /** Human-readable type label stored in metadata. */
  modelType: string;
}

// ---------------------------------------------------------------------------
// Pattern rules (order matters — first match wins)
// ---------------------------------------------------------------------------

export const MODEL_CAPABILITY_PATTERNS: CapabilityPattern[] = [
  // --- Image generation ---
  {
    patterns: [
      /^dall-e-/,
      /^flux[-/]/,
      /^flux$/,
      /^midjourney/,
      /^sd[-/]/,
      /^sd3/,
      /^stable-diffusion/,
      /^bria[-/]/,
      /^seedream[-/]/,
      /^seedream$/,
      /^seedream\d/,
      /^ideogram[-/]/,
      /^recraft[-/]/,
      /^recraftv\d/,
      /^playground[-/]/,
    ],
    capabilities: ['image_generation'],
    endpoint: 'images',
    modelType: 'image',
  },
  // --- Video generation ---
  {
    patterns: [
      /^sora[-/]/,
      /^veo[-/]/,
      /^veo\d/,
      /^kling[-/]/,
      /^kling$/,
      /^kling\d/,
      /^runway[-/]/,
      /^wan[-/\d]/,
      /animate/,
      /^hailuo[-/]/,
      /^minimax-video/,
      /^luma[-/]/,
      /^pika[-/]/,
      /^cogvideo/,
      /^hunyuan-video/,
      // Runway ML product slots — `gen3a_turbo`, `gen3_alpha`, `act-one`, etc.
      /^gen[-_]?\d/,
      /^gen[-_]?[a-z]+[-_]?\d/,
      /^act-one/,
    ],
    capabilities: ['video_generation'],
    endpoint: 'videos',
    modelType: 'video',
  },
  // --- Reranking (must precede embeddings + chat — `rerank-*` is a distinct
  //     retrieval-rescoring tool surface, not generative). ---
  {
    patterns: [
      /^rerank[-/]/,
      /^rerank-/,
      /-rerank[-/]/,
      /-reranker$/,
      /-reranker-/,
      /^cohere-rerank/,
      /^relace-code-reranker/,
    ],
    capabilities: ['reranking', 'retrieval'],
    endpoint: 'rerank',
    modelType: 'reranker',
  },
  // --- Moderation / safety classifiers (must precede chat — `omni-moderation`
  //     looks like an OpenAI multimodal slot but is purely a classifier). ---
  {
    patterns: [
      /^omni-moderation/,
      /^text-moderation/,
      /^moderation[-/]/,
      /^llamaguard[-/]?/,
      /^llama-guard[-/]?/,
      /-moderation[-/]?/,
    ],
    capabilities: ['moderation', 'safety'],
    endpoint: 'moderations',
    modelType: 'moderation',
  },
  // --- TTS ---
  {
    patterns: [
      /^tts-/,
      /-tts$/,
      /-tts-/,
      /^cosyvoice[-/]/,
      /^fish-speech[-/]/,
      /^chattts/,
      /^f5-tts/,
    ],
    capabilities: ['text_to_speech', 'tts'],
    endpoint: 'audio_speech',
    modelType: 'tts',
  },
  // --- STT (added `transcribe-*` family — Cohere/OpenAI/etc. ship a dedicated
  //     transcription model with this prefix). ---
  {
    patterns: [
      /^whisper[-/]/,
      /^whisper$/,
      /-asr$/,
      /-asr-/,
      /^sensevoice/,
      /^transcribe[-/]/,
      /-transcribe[-/]/,
      /-transcribe-/,
      /^cohere-transcribe/,
      /^gpt-4o-transcribe/,
      /^gpt-4o-mini-transcribe/,
    ],
    capabilities: ['speech_to_text', 'transcription'],
    endpoint: 'audio_transcriptions',
    modelType: 'stt',
  },
  // --- Embeddings (added `databricks-{bge,gte,e5}` for hub-prefixed listings,
  //     and `nomic-embed`, `e5-`, vendor-suffix variants for completeness). ---
  {
    patterns: [
      /^text-embedding[-/]/,
      /^embedding[-/]/,
      /^voyage[-/]/,
      /^bge[-/]/,
      /^gte[-/]/,
      /^e5[-/]/,
      /^jina-embeddings/,
      /^nomic-embed/,
      /^databricks-bge[-/]/,
      /^databricks-gte[-/]/,
      /^databricks-e5[-/]/,
      /-embedding$/,
      /-embeddings$/,
      /^relace-embedding/,
      // Delimiter-safe (NOT prefix-anchored) variants: hub listings flatten org
      // prefixes into the id (`intfloat-multilingual-e5-base`), so `^e5-` never
      // matches and the model leaked into chat pools as a consensus voter
      // (observed in c3-v4). Same class: labse, minilm, sentence-transformers.
      /(?:^|[/_-])(?:multilingual-)?e5(?:[/_-]|$)/,
      /(?:^|[/_-])(?:bge|gte|labse|minilm)(?:[/_-]|$)/,
      /(?:^|[/_-])sentence-transformers?(?:[/_-]|$)/,
    ],
    capabilities: ['embedding', 'embeddings'],
    endpoint: 'embeddings',
    modelType: 'embedding',
  },
  // --- Chat / LLM (matched last as the broadest category — note: hyphen-
  //     prefixed hub variants like `databricks-dbrx` need explicit listing
  //     because the prefix-strip helper only handles slash-delimited prefixes,
  //     not hyphenated ones). ---
  {
    patterns: [
      /^gpt-/,
      /^chatgpt-/,
      /^claude[-/]/,
      /^claude-/,
      /^gemini[-/]/,
      /^gemini-/,
      /^deepseek[-/]/,
      /^deepseek-/,
      /^o1[-/]?/,
      /^o3[-/]?/,
      /^o4[-/]?/,
      /^llama[-/]/,
      /^qwen[-/]/,
      /^qwq[-/]/,
      /^mistral[-/]/,
      /^mixtral[-/]/,
      /^phi[-/]/,
      /^command[-/]/,
      /^yi[-/]/,
      /^glm[-/]/,
      /^glm\d/,
      /^internlm[-/]/,
      /^codestral[-/]/,
      /^dbrx[-/]/,
      /^nous[-/]/,
      /^wizardlm[-/]/,
      /^solar[-/]/,
      /^gemma[-/]/,
      // MosaicML Pre-trained Transformer family — broad structural; matches
      // `mpt-7b-chat`, `mpt-30b-instruct`, etc. that hub aggregators may
      // surface even when the canonical Databricks-prefixed form is the one
      // declared in catalog.
      /^mpt[-/]/,
      // Moonshot AI Kimi family — bare-name form is left after hub-prefix
      // strip (e.g. `moonshotai/kimi-k2` → `kimi-k2`). Structural, not vendor-
      // specific palliative.
      /^kimi[-/]/,
      /^kimi-/,
      // Databricks hub-prefixed chat variants (hyphen, not slash). Structural
      // broad pattern — covers any Databricks hub listing, regardless of
      // whether the specific SKU is in catalog.
      /^databricks-(dbrx|mixtral|mpt|llama|qwen|nous|wizardlm|gemma|phi|mistral|codestral|solar|meta)[-/]/,
      // Meta Llama on hub providers — `meta-llama-3-*`, `meta/meta-llama-*`
      // (slash-stripped form). The bare `^llama-` already matches; this
      // handles the `meta-` prefix variant directly.
      /^meta-llama[-/]/,
      /^meta-/,
      // NOTE: regex patterns for catalog-declared families (palmyra, sonar,
      // ernie/eb, inflection/pi, relace-apply, aqa) were intentionally
      // REMOVED on 2026-04-28 (root-cause refactor). Those models now flow
      // through the catalog-bridge with operator-declared capabilities
      // (pinnedFallback). Regex inference here is reserved for STRUCTURAL
      // fallbacks (vendor-family naming conventions) that aggregator hubs
      // may surface — never for compensating missing catalog declarations.
    ],
    capabilities: ['chat', 'text_generation', 'streaming'],
    endpoint: 'chat_completions',
    modelType: 'chat',
  },
];

// ---------------------------------------------------------------------------
// Inference function
// ---------------------------------------------------------------------------

/**
 * Try to match a model ID against the pattern rules.
 *
 * For hub model IDs that contain a provider prefix (e.g. `openai/gpt-4o`),
 * the matching is performed on both the full ID and the bare model name
 * (everything after the last `/`).
 *
 * @returns the inferred capabilities, endpoint, and model type, or `null`
 *          if no pattern matches.
 */
export function inferCapabilitiesFromModelId(
  modelId: string,
): { capabilities: ModelCapability[]; endpoint: string; modelType: string } | null {
  const lower = modelId.toLowerCase();

  // Try full ID first
  const fullMatch = matchPatternRules(lower);
  if (fullMatch) return fullMatch;

  // If the ID contains a prefix (provider/model), try the bare model name
  const slashIndex = lower.lastIndexOf('/');
  if (slashIndex > 0 && slashIndex < lower.length - 1) {
    const bareModel = lower.slice(slashIndex + 1);
    const bareMatch = matchPatternRules(bareModel);
    if (bareMatch) return bareMatch;
  }

  return null;
}

/**
 * Internal: test a lowercased string against all pattern rules.
 */
function matchPatternRules(
  lowerStr: string,
): { capabilities: ModelCapability[]; endpoint: string; modelType: string } | null {
  for (const rule of MODEL_CAPABILITY_PATTERNS) {
    for (const pattern of rule.patterns) {
      if (pattern.test(lowerStr)) {
        return {
          capabilities: [...rule.capabilities],
          endpoint: rule.endpoint,
          modelType: rule.modelType,
        };
      }
    }
  }
  return null;
}
