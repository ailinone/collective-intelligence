// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * AIML-specific model fetcher using their proprietary /models API.
 * Unlike the generic OpenAI-compatible fetcher, this uses AIML's richer
 * model metadata (type, features, endpoints) for accurate capability mapping.
 *
 * The proprietary API at GET https://api.aimlapi.com/models returns models with:
 * - type: "chat-completion", "video", "tts", "image", "stt", "embedding", etc.
 * - info: { name, developer, description, contextLength, outputMax }
 * - features: array of capabilities
 * - endpoints: array of supported API paths
 *
 * `info.contextLength`/`info.outputMax` are the field names live-verified
 * 2026-09 against `curl https://api.aimlapi.com/models` (937 real entries,
 * e.g. `anthropic/claude-sonnet-4.6` → `contextLength: 200000, outputMax:
 * 64000`). The interface previously declared `context_length`/`max_tokens`
 * (snake_case), which never matches — every model silently fell back to the
 * generic 8192/4096 defaults below, including flagship models with
 * documented 1M-token context windows (`amazon/nova-2-lite-v1`: 1,000,000).
 * `info` also NEVER carries a price field of any kind (confirmed by
 * substring-searching the full raw payload for "price"/"cost" — zero
 * matches outside prose descriptions) — AIML's own API has no per-model
 * pricing endpoint, so `pricing` below stays a deliberate `{0, 0}` (means
 * "unknown", not "free" — see `PricingMode.none` in provider-catalog.types.ts)
 * rather than a guessed value. See providers.catalog.ts's `aiml` entry,
 * corrected from `pricingMode: 'remote'` to `'none'` to match this reality.
 */

import {
  BaseProviderModelFetcher,
  type ModelMetadata,
  type ProviderModel,
} from './provider-model-fetcher.js';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

interface AimlModelFetcherConfig {
  apiKey: string;
  baseUrl?: string;
}

/** Shape of a single model from the AIML proprietary /models response. */
interface AimlRawModel {
  id: string;
  type?: string;
  info?: {
    name?: string;
    developer?: string;
    description?: string;
    /** Real live field name (camelCase). See file header for verification. */
    contextLength?: number;
    /** Real live field name (camelCase). See file header for verification. */
    outputMax?: number;
    /** Legacy/defensive: older docs and some third-party mirrors describe
     *  this endpoint with snake_case field names. Never observed live, but
     *  cheap to also accept in case AIML serves a different shape to some
     *  accounts/tiers. */
    context_length?: number;
    max_tokens?: number;
  };
  features?: string[];
  endpoints?: string[];
}

/**
 * Maps AIML's `type` field to a set of base capabilities.
 *
 * Exact-match table for the short-form values AIML has historically returned
 * (`image`, `tts`, `stt`, ...).
 */
const TYPE_CAPABILITY_MAP: Record<string, ModelCapability[]> = {
  'chat-completion': ['chat', 'text_generation', 'streaming'],
  'chat-completions': ['chat', 'text_generation', 'streaming'],
  video: ['video_generation'],
  image: ['image_generation'],
  tts: ['text_to_speech', 'tts'],
  stt: ['speech_to_text', 'transcription'],
  embedding: ['embedding', 'embeddings'],
  embeddings: ['embedding', 'embeddings'],
  audio: ['audio'],
  responses: ['chat', 'tool_use', 'function_calling'],
  document: ['pdf_understanding'],
  'language-completion': ['completions'],
};

/**
 * AIML's LIVE `/models` endpoint actually returns `type` as a namespaced
 * endpoint path (`openai/image-generations`, `internal/video-generations/
 * submit`, `openai/embeddings`, ...), not the short form
 * `TYPE_CAPABILITY_MAP` was written against. An exact-key lookup misses
 * every one of these, and `buildCapabilities` silently defaults the model to
 * `['chat', 'text_generation']` — confirmed live in production (2026-09):
 * of AIML's real `type` values, `internal/video-generations/submit` (269
 * models), `openai/image-generations` (160), `internal/text-to-speech` (87),
 * `internal/speech-to-text/submit` (46), `openai/embeddings` (30),
 * `internal/optical-character-recognition` (12) and `openai/image-editing`
 * (4) all fell through to the chat default — ~600 non-chat models (video,
 * image, tts, stt, embedding, OCR generation/editing endpoints) mislabelled
 * as generic chat completions.
 *
 * Matched only when the exact-key lookup above misses. Ordered so a more
 * specific substring (`image-editing`) is not shadowed by a broader one
 * that happens to also occur in the same string family (`image`) — though
 * with the substrings actually observed there is no real overlap, order is
 * kept defensive for future additions.
 */
const TYPE_SUBSTRING_CAPABILITY_RULES: ReadonlyArray<{
  pattern: RegExp;
  capabilities: ModelCapability[];
}> = [
  { pattern: /image-editing/, capabilities: ['image_generation', 'image_editing'] },
  { pattern: /image-generation/, capabilities: ['image_generation'] },
  { pattern: /video-generation/, capabilities: ['video_generation'] },
  { pattern: /text-to-speech/, capabilities: ['text_to_speech', 'tts'] },
  { pattern: /speech-to-text/, capabilities: ['speech_to_text', 'transcription'] },
  { pattern: /embedding/, capabilities: ['embedding', 'embeddings'] },
  { pattern: /optical-character-recognition/, capabilities: ['vision'] },
  { pattern: /audio-generation/, capabilities: ['audio', 'audio_generation'] },
  { pattern: /responses/, capabilities: ['chat', 'tool_use', 'function_calling'] },
  { pattern: /chat-completion/, capabilities: ['chat', 'text_generation', 'streaming'] },
];

export class AimlModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'aiml';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly log = logger.child({ component: 'aiml-model-fetcher' });

  constructor(config: AimlModelFetcherConfig) {
    super();
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.aimlapi.com';
  }

  async getModels(): Promise<ProviderModel[]> {
    try {
      const url = this.joinUrl('/models');
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      // Include API key in case AIML starts requiring auth for /models
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const body = await this.safeReadBody(response);
        this.log.warn(
          { status: response.status, body: body.slice(0, 400) },
          'AIML proprietary /models endpoint returned non-success status'
        );
        return [];
      }

      const payload = (await response.json()) as unknown;
      const rawModels = this.extractRawModels(payload);

      if (rawModels.length === 0) {
        this.log.warn('AIML /models returned no models');
        return [];
      }

      const converted = rawModels
        .map((raw) => this.convertRawModel(raw))
        .filter((model): model is ProviderModel => Boolean(model));

      this.logModelTypeCounts(rawModels);

      this.log.info(
        { totalRaw: rawModels.length, converted: converted.length },
        'AIML model discovery complete'
      );

      return converted;
    } catch (error) {
      this.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to fetch models from AIML proprietary API'
      );
      return [];
    }
  }

  /**
   * Extract the array of raw models from the API response.
   * Handles both a direct array and `{ data: [...] }` shapes.
   */
  private extractRawModels(payload: unknown): AimlRawModel[] {
    if (Array.isArray(payload)) {
      return payload.filter(this.isRawModel);
    }

    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      for (const key of ['data', 'models', 'results', 'items']) {
        const candidate = record[key];
        if (Array.isArray(candidate)) {
          return candidate.filter(this.isRawModel);
        }
      }
    }

    return [];
  }

  private isRawModel(item: unknown): item is AimlRawModel {
    return Boolean(
      item && typeof item === 'object' && typeof (item as AimlRawModel).id === 'string'
    );
  }

  private convertRawModel(raw: AimlRawModel): ProviderModel | null {
    const modelId = raw.id?.trim();
    if (!modelId) {
      return null;
    }

    const modelType = raw.type?.toLowerCase().trim() || '';
    const capabilities = this.buildCapabilities(modelType, raw.features || []);
    const metadata = this.buildMetadata(raw, modelType);

    return {
      id: modelId,
      name: modelId,
      displayName: raw.info?.name || modelId,
      // contextLength/outputMax are the real live field names; context_length/
      // max_tokens are kept as a defensive fallback (see AimlRawModel).
      contextWindow: raw.info?.contextLength || raw.info?.context_length || 8192,
      maxOutputTokens: raw.info?.outputMax || raw.info?.max_tokens || 4096,
      capabilities,
      pricing: {
        // AIML's /models response never carries a price field (live-verified
        // 2026-09 — see file header). 0 means "unknown", not "free"; do not
        // replace with a guessed/heuristic value here.
        inputCostPer1M: 0,
        outputCostPer1M: 0,
        currency: 'USD',
      },
      metadata,
    };
  }

  /**
   * Build capabilities from the AIML type field plus features array.
   */
  private buildCapabilities(modelType: string, features: string[]): ModelCapability[] {
    const capSet = new Set<ModelCapability>();

    // Map from the model type: exact short-form key first, then the
    // namespaced-path substring rules AIML's live API actually returns
    // (see TYPE_SUBSTRING_CAPABILITY_RULES for why this second pass exists).
    const typeCaps = TYPE_CAPABILITY_MAP[modelType];
    if (typeCaps) {
      for (const cap of typeCaps) {
        capSet.add(cap);
      }
    } else if (modelType) {
      const rule = TYPE_SUBSTRING_CAPABILITY_RULES.find((r) => r.pattern.test(modelType));
      if (rule) {
        for (const cap of rule.capabilities) {
          capSet.add(cap);
        }
      }
    }

    // Add features as capabilities (filter to valid ModelCapability values)
    for (const feature of features) {
      const normalized = feature
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
      // Only add if it looks like a known capability pattern
      if (normalized) {
        capSet.add(normalized as ModelCapability);
      }
    }

    // If no capabilities were mapped, default to chat
    if (capSet.size === 0) {
      capSet.add('chat');
      capSet.add('text_generation');
    }

    return Array.from(capSet);
  }

  private buildMetadata(raw: AimlRawModel, modelType: string): ModelMetadata {
    const metadata: ModelMetadata = {
      source: 'aiml-proprietary-api',
      provider: 'aiml',
      executionProvider: 'aiml',
    };

    if (modelType) {
      metadata.aimlType = modelType;
    }

    if (raw.info?.description) {
      metadata.description = raw.info.description;
    }

    if (raw.info?.developer) {
      metadata.originalProvider = raw.info.developer.toLowerCase().replace(/[\s_]+/g, '-');
    }

    if (raw.endpoints && raw.endpoints.length > 0) {
      metadata.supportedEndpoints = raw.endpoints;
      // Determine the primary endpoint from the endpoints array
      metadata.endpoint = this.determineEndpointFromPaths(raw.endpoints, modelType);
    }

    if (raw.features && raw.features.length > 0) {
      metadata.capabilities = raw.features as ModelCapability[];
    }

    // Extract original provider from model ID (e.g., "openai/gpt-4.1" -> "openai")
    const slashIndex = raw.id.indexOf('/');
    if (slashIndex > 0) {
      const idProvider = raw.id.slice(0, slashIndex).trim().toLowerCase();
      if (idProvider && idProvider !== 'aiml') {
        metadata.originalProvider = metadata.originalProvider || idProvider;
        metadata.executionProviders = ['aiml', idProvider];
      }
    }

    return metadata;
  }

  /**
   * Determine the primary endpoint from the AIML endpoints array.
   */
  private determineEndpointFromPaths(endpoints: string[], modelType: string): string {
    if (endpoints.includes('/v1/chat/completions')) {
      return 'chat_completions';
    }
    if (endpoints.includes('/v1/embeddings')) {
      return 'embeddings';
    }
    if (endpoints.includes('/v1/images/generations')) {
      return 'images';
    }
    if (endpoints.includes('/v1/audio/speech')) {
      return 'audio_speech';
    }
    if (endpoints.includes('/v1/audio/transcriptions')) {
      return 'audio_transcriptions';
    }
    if (endpoints.includes('/v1/completions')) {
      return 'completions';
    }

    // Fall back to type-based mapping
    switch (modelType) {
      case 'chat-completion':
      case 'responses':
        return 'chat_completions';
      case 'embedding':
        return 'embeddings';
      case 'image':
        return 'images';
      case 'video':
        return 'videos';
      case 'tts':
        return 'audio_speech';
      case 'stt':
        return 'audio_transcriptions';
      case 'language-completion':
        return 'completions';
      default:
        return 'chat_completions';
    }
  }

  /**
   * Log model counts grouped by type for observability.
   */
  private logModelTypeCounts(rawModels: AimlRawModel[]): void {
    const typeCounts: Record<string, number> = {};
    for (const model of rawModels) {
      const t = model.type || 'unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    this.log.info({ typeCounts }, 'AIML models by type');
  }

  private joinUrl(path: string): string {
    const normalizedBase = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  private async safeReadBody(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }
}
