// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { ModelCapability } from '@/types';
import { isModelCapability } from '@/types';

export interface CapabilityInferenceInput {
  modelId?: string;
  metadata?: Record<string, unknown>;
  seedCapabilities?: readonly string[];
}

export interface ModelModalities {
  input: string[];
  output: string[];
}

export type ModelOperationEndpoint =
  | 'chat_completions'
  | 'responses'
  | 'completions'
  | 'embeddings'
  | 'images'
  | 'videos'
  | 'audio_speech'
  | 'audio_transcriptions'
  | 'realtime';

export type EndpointCompatibilityLevel = 'explicit' | 'inferred';

const CAPABILITY_ALIAS_MAP: Record<string, ModelCapability> = {
  // Core aliases
  tool_calling: 'function_calling',
  tools: 'function_calling',
  function_call: 'function_calling',
  functions: 'function_calling',
  structured_output: 'json_mode',
  structured_outputs: 'json_mode',
  json_schema: 'json_mode',
  embed: 'embedding',
  embeddings: 'embeddings',
  embedding: 'embedding',
  completion: 'completions',
  completions: 'completions',
  real_time: 'realtime',
  realtime: 'realtime',
  live: 'realtime',

  // Audio aliases
  stt: 'speech_to_text',
  asr: 'speech_to_text',
  speech_recognition: 'speech_to_text',
  tts: 'tts',
  speech_synthesis: 'text_to_speech',
  listen: 'listen',
  transcription: 'transcription',
  transcribe: 'transcription',
  audio_to_audio: 'audio_to_audio',
  audio2audio: 'audio_to_audio',
  speech_to_speech: 'audio_to_audio',
  speech2speech: 'audio_to_audio',

  // Video aliases
  video_to_text: 'video_to_text',
  video2text: 'video_to_text',
  video_transcription: 'video_transcription',
  transcribe_video: 'video_transcription',
  video_transcribe: 'video_transcription',
  image_to_video: 'image_to_video',
  image2video: 'image_to_video',
  video_to_video: 'video_to_video',
  video2video: 'video_to_video',

  // Research aliases
  deep_search: 'deep_search',
  deep_research: 'deep_research',
  research: 'research',

  // Domain aliases
  medical: 'health',
  healthcare: 'health',
  clinical: 'health',
};

function normalizeToken(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+/, '').replace(/_+$/, '');
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function maybeAddCapability(set: Set<ModelCapability>, rawCapability: string | undefined): void {
  if (!rawCapability) return;
  const normalized = normalizeToken(rawCapability);
  const alias = CAPABILITY_ALIAS_MAP[normalized];
  if (alias) {
    set.add(alias);
    return;
  }
  if (isModelCapability(normalized)) {
    set.add(normalized);
  }
}

function addCapabilities(set: Set<ModelCapability>, caps: readonly ModelCapability[]): void {
  for (const capability of caps) {
    set.add(capability);
  }
}

function readSupportedParameters(metadata?: Record<string, unknown>): string[] {
  if (!metadata) return [];
  const rawA = coerceStringArray(metadata.supported_parameters);
  const rawB = coerceStringArray(metadata.supportedParameters);
  return [...rawA, ...rawB];
}

export function extractModelModalities(metadata?: Record<string, unknown>): ModelModalities {
  if (!metadata) return { input: [], output: [] };

  const architecture = getObject(metadata.architecture);
  const input = [
    ...coerceStringArray(architecture?.input_modalities),
    ...coerceStringArray(metadata.input_modalities),
    ...coerceStringArray(metadata.inputModalities),
  ]
    .map(normalizeToken)
    .filter(Boolean);

  const output = [
    ...coerceStringArray(architecture?.output_modalities),
    ...coerceStringArray(metadata.output_modalities),
    ...coerceStringArray(metadata.outputModalities),
  ]
    .map(normalizeToken)
    .filter(Boolean);

  return {
    input: Array.from(new Set(input)),
    output: Array.from(new Set(output)),
  };
}

function addKeywordCapabilities(set: Set<ModelCapability>, rawText: string): void {
  const text = rawText.toLowerCase();

  if (/\b(code|coder|coding|programming|software)\b/.test(text)) {
    addCapabilities(set, ['coding', 'code_generation', 'code_completion']);
  }
  if (/\b(deep[\s_-]?research|deep[\s_-]?search)\b/.test(text)) {
    addCapabilities(set, ['deep_research', 'deep_search', 'research']);
  } else if (/\bresearch\b/.test(text)) {
    addCapabilities(set, ['research']);
  }
  if (/\b(web[\s_-]?search|grounding|search)\b/.test(text)) {
    addCapabilities(set, ['web_search']);
  }
  if (/\b(computer[\s_-]?use|browser[\s_-]?use|operator)\b/.test(text)) {
    addCapabilities(set, ['computer_use']);
  }
  if (/\b(realtime|real[\s_-]?time|live)\b/.test(text)) {
    addCapabilities(set, ['realtime']);
  }
  if (/\b(reasoning|thinking|o[1-9]\b)\b/.test(text)) {
    addCapabilities(set, ['reasoning', 'thinking_mode']);
  }
  if (/\b(agent|assistant)\b/.test(text)) {
    addCapabilities(set, ['agents']);
  }
  if (/\b(embed|embedding)\b/.test(text)) {
    addCapabilities(set, ['embedding', 'embeddings']);
  }
  if (/\b(image|vision|multimodal)\b/.test(text)) {
    addCapabilities(set, ['vision', 'multimodal']);
  }
  if (/\b(video|veo|sora)\b/.test(text)) {
    set.add('video_understanding');
    if (
      /\b(veo|sora|text[\s_-]?(to|2)[\s_-]?video|image[\s_-]?(to|2)[\s_-]?video|video[\s_-]?(generation|generator|generate|creating|creation|synthesis|render))\b/.test(
        text
      )
    ) {
      set.add('video_generation');
    }
    if (/\bimage[\s_-]?(to|2)[\s_-]?video\b/.test(text)) {
      set.add('image_to_video');
    }
    if (/\bvideo[\s_-]?(to|2)[\s_-]?video\b/.test(text)) {
      set.add('video_to_video');
      set.add('video_editing');
    }
  }
  if (/\b(audio|speech|voice|listen|whisper|transcrib)\b/.test(text)) {
    addCapabilities(set, ['audio', 'listen']);
  }
  if (/\b(health|medical|clinical|biomed)\b/.test(text)) {
    addCapabilities(set, ['health']);
  }
}

export function inferProviderFromModelId(modelId?: string): string | undefined {
  if (!modelId) return undefined;
  const trimmed = modelId.trim().toLowerCase();
  if (!trimmed) return undefined;

  const separatorIndex = trimmed.indexOf('/');
  const atIndex = trimmed.indexOf('@');

  // Workspace-scoped model IDs: workspace@provider/model
  if (separatorIndex > 0 && atIndex > -1 && atIndex < separatorIndex) {
    const provider = trimmed.slice(atIndex + 1, separatorIndex).trim();
    return provider || undefined;
  }

  // Canonical provider/model IDs.
  if (separatorIndex > 0) {
    return trimmed.slice(0, separatorIndex).trim() || undefined;
  }

  // Hub-style IDs: provider@model
  if (atIndex > 0 && atIndex < trimmed.length - 1) {
    return trimmed.slice(0, atIndex).trim() || undefined;
  }

  return undefined;
}

export function normalizeOperationEndpoint(value: string): ModelOperationEndpoint | undefined {
  const normalized = normalizeToken(value);
  switch (normalized) {
    case 'chat':
    case 'chat_completions':
    case 'chat_completions_special':
    case 'chat_completions_audio':
      return 'chat_completions';
    case 'responses':
      return 'responses';
    case 'completions':
      return 'completions';
    case 'embedding':
    case 'embeddings':
      return 'embeddings';
    case 'image':
    case 'images':
      return 'images';
    case 'video':
    case 'videos':
      return 'videos';
    case 'audio_speech':
    case 'speech':
    case 'tts':
      return 'audio_speech';
    case 'audio_transcriptions':
    case 'transcriptions':
    case 'stt':
      return 'audio_transcriptions';
    case 'realtime':
      return 'realtime';
    default:
      return undefined;
  }
}

function addInferredEndpoint(
  compatibility: Map<ModelOperationEndpoint, EndpointCompatibilityLevel>,
  endpoint: ModelOperationEndpoint
): void {
  if (!compatibility.has(endpoint)) {
    compatibility.set(endpoint, 'inferred');
  }
}

function addExplicitEndpoint(
  compatibility: Map<ModelOperationEndpoint, EndpointCompatibilityLevel>,
  endpoint: ModelOperationEndpoint
): void {
  compatibility.set(endpoint, 'explicit');
}

export function inferEndpointCompatibility(
  capabilities: readonly string[],
  metadata?: Record<string, unknown>
): Partial<Record<ModelOperationEndpoint, EndpointCompatibilityLevel>> {
  const compatibility = new Map<ModelOperationEndpoint, EndpointCompatibilityLevel>();

  const metadataEndpointRaw =
    (typeof metadata?.endpoint === 'string' && metadata.endpoint) ||
    (typeof metadata?.defaultEndpoint === 'string' && metadata.defaultEndpoint) ||
    '';
  const metadataEndpoint = metadataEndpointRaw
    ? normalizeOperationEndpoint(metadataEndpointRaw)
    : undefined;
  if (metadataEndpoint) {
    addExplicitEndpoint(compatibility, metadataEndpoint);
  }

  const explicitEndpoints = [
    ...coerceStringArray(metadata?.supportedEndpoints),
    ...coerceStringArray(metadata?.supported_endpoints),
  ]
    .map((value) => normalizeOperationEndpoint(value))
    .filter((value): value is ModelOperationEndpoint => Boolean(value));
  for (const endpoint of explicitEndpoints) {
    addExplicitEndpoint(compatibility, endpoint);
  }

  const caps = new Set(capabilities.map((capability) => normalizeToken(capability)));
  const hasTextGeneration = caps.has('chat') || caps.has('text_generation');

  if (hasTextGeneration) {
    addInferredEndpoint(compatibility, 'chat_completions');
  }
  if (caps.has('function_calling') || caps.has('tool_use')) {
    addInferredEndpoint(compatibility, 'responses');
  }
  if (caps.has('completions')) {
    addInferredEndpoint(compatibility, 'completions');
  }
  if (caps.has('embedding') || caps.has('embeddings')) {
    addInferredEndpoint(compatibility, 'embeddings');
  }
  if (caps.has('image_generation') || caps.has('image_editing')) {
    addInferredEndpoint(compatibility, 'images');
  }
  if (
    caps.has('video_generation') ||
    caps.has('image_to_video') ||
    caps.has('video_to_video') ||
    caps.has('video_editing')
  ) {
    addInferredEndpoint(compatibility, 'videos');
  }
  if (caps.has('text_to_speech') || caps.has('tts')) {
    addInferredEndpoint(compatibility, 'audio_speech');
  }
  if (caps.has('speech_to_text') || caps.has('transcription') || caps.has('video_transcription')) {
    addInferredEndpoint(compatibility, 'audio_transcriptions');
  }
  if (caps.has('realtime') || caps.has('realtime_audio') || caps.has('audio_to_audio')) {
    addInferredEndpoint(compatibility, 'realtime');
  }

  return Object.fromEntries(compatibility.entries()) as Partial<
    Record<ModelOperationEndpoint, EndpointCompatibilityLevel>
  >;
}

export function inferSupportedEndpoints(
  capabilities: readonly string[],
  metadata?: Record<string, unknown>
): ModelOperationEndpoint[] {
  const compatibility = inferEndpointCompatibility(capabilities, metadata);
  return Object.keys(compatibility) as ModelOperationEndpoint[];
}

export function inferModelCapabilities(input: CapabilityInferenceInput): ModelCapability[] {
  const capabilities = new Set<ModelCapability>();
  const modelId = input.modelId || '';
  const metadata = input.metadata;
  const normalizedModelId = modelId.toLowerCase();
  const modalities = extractModelModalities(metadata);
  const inputModalities = new Set(modalities.input);
  const outputModalities = new Set(modalities.output);

  for (const declared of input.seedCapabilities || []) {
    maybeAddCapability(capabilities, declared);
  }

  for (const declared of coerceStringArray(metadata?.capabilities)) {
    maybeAddCapability(capabilities, declared);
  }

  const combinedText = [
    normalizedModelId,
    typeof metadata?.description === 'string' ? metadata.description : '',
    typeof metadata?.family === 'string' ? metadata.family : '',
    typeof metadata?.tier === 'string' ? metadata.tier : '',
    typeof metadata?.endpoint === 'string' ? metadata.endpoint : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Modality-based inference (source of truth when available)
  const hasInputText = inputModalities.has('text');
  const hasInputImage = inputModalities.has('image');
  const hasInputAudio = inputModalities.has('audio');
  const hasInputVideo = inputModalities.has('video');
  const hasInputPdf = inputModalities.has('pdf');

  const hasOutputText = outputModalities.has('text');
  const hasOutputImage = outputModalities.has('image');
  const hasOutputAudio = outputModalities.has('audio');
  const hasOutputVideo = outputModalities.has('video');

  if (hasInputImage || hasInputAudio || hasInputVideo || hasOutputImage || hasOutputAudio || hasOutputVideo) {
    capabilities.add('multimodal');
  }

  if (hasInputImage || hasInputVideo) {
    addCapabilities(capabilities, ['vision']);
  }

  if (hasInputAudio) {
    addCapabilities(capabilities, ['audio', 'listen', 'audio_input']);
  }

  if (hasOutputAudio) {
    addCapabilities(capabilities, ['audio', 'audio_output', 'audio_generation']);
  }

  if (hasOutputImage) {
    addCapabilities(capabilities, ['image_generation']);
  }

  if (hasOutputVideo) {
    addCapabilities(capabilities, ['video_generation']);
  }

  if (hasInputImage && hasOutputImage) {
    capabilities.add('image_editing');
  }
  if (hasInputVideo && hasOutputVideo) {
    addCapabilities(capabilities, ['video_to_video', 'video_editing']);
  }
  if (hasInputImage && hasOutputVideo) {
    capabilities.add('image_to_video');
  }
  if (hasInputVideo && hasOutputText) {
    addCapabilities(capabilities, ['video_understanding', 'video_to_text', 'video_transcription', 'transcription']);
  }
  if (hasInputAudio && hasOutputText) {
    addCapabilities(capabilities, ['speech_to_text', 'transcription']);
  }
  if (hasInputText && hasOutputAudio) {
    addCapabilities(capabilities, ['text_to_speech', 'tts']);
  }
  if (hasInputAudio && hasOutputAudio) {
    addCapabilities(capabilities, ['audio_to_audio', 'realtime_audio']);
  }

  if ((hasInputAudio || hasOutputAudio) && /\b(realtime|real[\s_-]?time|live)\b/.test(combinedText)) {
    addCapabilities(capabilities, ['realtime', 'realtime_audio']);
  }

  if ((hasInputVideo || hasOutputVideo) && /\b(realtime|real[\s_-]?time|live)\b/.test(combinedText)) {
    capabilities.add('realtime');
  }
  if (hasInputPdf || normalizedModelId.includes('pdf')) {
    capabilities.add('pdf_understanding');
  }

  // Parameter-based inference
  const supportedParameters = readSupportedParameters(metadata).map(normalizeToken);
  for (const parameter of supportedParameters) {
    if (
      parameter === 'tools' ||
      parameter === 'tool_choice' ||
      parameter === 'function_call' ||
      parameter === 'function_calling'
    ) {
      addCapabilities(capabilities, ['function_calling', 'tool_use']);
    }
    if (
      parameter === 'structured_outputs' ||
      parameter === 'structured_output' ||
      parameter === 'json_schema' ||
      parameter === 'response_format'
    ) {
      capabilities.add('json_mode');
    }
    if (parameter === 'reasoning' || parameter === 'include_reasoning' || parameter === 'thinking') {
      addCapabilities(capabilities, ['reasoning', 'thinking_mode']);
    }
    if (parameter === 'web_search' || parameter === 'grounding' || parameter === 'search') {
      capabilities.add('web_search');
    }
    if (parameter === 'file_search') {
      capabilities.add('file_search');
    }
    if (parameter === 'computer_use' || parameter === 'browser_use') {
      capabilities.add('computer_use');
    }
    if (parameter === 'code_interpreter' || parameter === 'sandbox') {
      capabilities.add('code_interpreter');
    }
    if (parameter === 'mcp') {
      capabilities.add('mcp');
    }
    if (parameter === 'realtime' || parameter === 'live') {
      capabilities.add('realtime');
    }
    if (parameter === 'max_tokens' || parameter === 'stream' || parameter === 'streaming') {
      capabilities.add('streaming');
    }
  }

  // Text/identifier-based fallback inference
  addKeywordCapabilities(capabilities, combinedText);

  const isEmbeddingModel =
    capabilities.has('embedding') ||
    capabilities.has('embeddings') ||
    /\b(embed|embedding)\b/.test(combinedText);
  if (isEmbeddingModel) {
    addCapabilities(capabilities, ['embedding', 'embeddings']);
  }

  const likelyChatModel =
    hasOutputText ||
    /\b(gpt|chatgpt|chat|claude|gemini|llama|qwen|mistral|deepseek|grok|assistant)\b/.test(combinedText);
  const exclusiveNonChat =
    isEmbeddingModel ||
    (!hasOutputText && (hasOutputImage || hasOutputVideo || hasOutputAudio) && !hasInputText);

  if (likelyChatModel && !exclusiveNonChat) {
    addCapabilities(capabilities, ['chat', 'text_generation']);
    if (!isEmbeddingModel) {
      capabilities.add('streaming');
    }
  } else if (hasOutputText && !isEmbeddingModel) {
    capabilities.add('text_generation');
  }

  if (capabilities.has('realtime') && (capabilities.has('audio') || capabilities.has('audio_to_audio'))) {
    capabilities.add('realtime_audio');
  }

  return Array.from(capabilities);
}

// ── Capability Tiers ──────────────────────────────────────────────────────
// Distinguishes between native capabilities (dedicated model with endpoint)
// and multimodal/inferred capabilities (general model that happens to accept
// audio/image as input modality).
//
// This matters for audio/image selection: when you need STT, you want
// Deepgram (native) not GPT-4o (multimodal chat that accepts audio).

export type CapabilityTier = 'native' | 'multimodal' | 'inferred';

/**
 * Determines the tier for each capability of a model.
 *
 * Rules:
 * - 'native': Model has a dedicated endpoint for this capability
 *   (e.g., Deepgram has /v1/audio/transcriptions → native speech_to_text)
 * - 'multimodal': Model accepts the modality as input but is primarily a chat model
 *   (e.g., GPT-4o accepts audio input → multimodal speech_to_text)
 * - 'inferred': Capability was guessed from keywords or heuristics
 */
export function inferCapabilityTiers(
  input: CapabilityInferenceInput,
  capabilities: readonly ModelCapability[],
): Partial<Record<ModelCapability, CapabilityTier>> {
  const tiers: Partial<Record<ModelCapability, CapabilityTier>> = {};
  const modelId = (input.modelId || '').toLowerCase();
  const metadata = input.metadata || {};
  const endpoints = metadata.endpoints as string[] | undefined;
  const provider = (metadata.provider as string || '').toLowerCase();

  // Seed capabilities from the provider are considered native
  const seedCaps = new Set<string>(
    [...(input.seedCapabilities || []), ...coerceStringArray(metadata.capabilities)]
      .map(c => c.toLowerCase())
  );

  // Providers known to have native audio endpoints
  const nativeSTTProviders = new Set(['deepgram', 'self-hosted', 'openai']);
  const nativeTTSProviders = new Set(['deepgram', 'cartesia', 'elevenlabs', 'self-hosted', 'openai']);

  // Model name patterns that indicate native audio models
  const nativeSTTPatterns = /\b(whisper|nova|deepgram|faster-whisper|sherpa|moonshine|sensevoice)\b/i;
  const nativeTTSPatterns = /\b(tts|piper|kokoro|melotts|cosyvoice|cartesia|sonic|aura|xtts|coqui|fish-speech)\b/i;

  for (const cap of capabilities) {
    // Check for explicit endpoint support
    const hasExplicitEndpoint = endpoints?.some(e =>
      (cap === 'speech_to_text' && e.includes('audio/transcriptions')) ||
      (cap === 'text_to_speech' && (e.includes('audio/speech') || e.includes('tts'))) ||
      (cap === 'embeddings' && e.includes('embeddings')) ||
      (cap === 'image_generation' && e.includes('images'))
    );

    if (hasExplicitEndpoint) {
      tiers[cap] = 'native';
      continue;
    }

    // Check if capability was declared by the provider (seed capabilities)
    if (seedCaps.has(cap)) {
      tiers[cap] = 'native';
      continue;
    }

    // Audio-specific tier detection
    if (cap === 'speech_to_text' || cap === 'transcription') {
      if (nativeSTTProviders.has(provider) || nativeSTTPatterns.test(modelId)) {
        tiers[cap] = 'native';
      } else {
        // Model has audio input but is a chat model (GPT-4o, Gemini, etc.)
        tiers[cap] = 'multimodal';
      }
      continue;
    }

    if (cap === 'text_to_speech' || cap === 'tts') {
      if (nativeTTSProviders.has(provider) || nativeTTSPatterns.test(modelId)) {
        tiers[cap] = 'native';
      } else {
        tiers[cap] = 'multimodal';
      }
      continue;
    }

    if (cap === 'translation') {
      if (modelId.includes('nllb') || modelId.includes('opus-mt') || modelId.includes('m2m')) {
        tiers[cap] = 'native';
      } else {
        tiers[cap] = 'multimodal'; // LLM doing translation
      }
      continue;
    }

    // Default: check if it was in the original seed or inferred
    tiers[cap] = seedCaps.has(cap) ? 'native' : 'inferred';
  }

  return tiers;
}
