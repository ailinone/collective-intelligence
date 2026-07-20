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
 * - info: { name, developer, description, context_length, max_tokens }
 * - features: array of capabilities
 * - endpoints: array of supported API paths
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
    context_length?: number;
    max_tokens?: number;
  };
  features?: string[];
  endpoints?: string[];
}

/**
 * Maps AIML's `type` field to a set of base capabilities.
 */
const TYPE_CAPABILITY_MAP: Record<string, ModelCapability[]> = {
  'chat-completion': ['chat', 'text_generation', 'streaming'],
  video: ['video_generation'],
  image: ['image_generation'],
  tts: ['text_to_speech', 'tts'],
  stt: ['speech_to_text', 'transcription'],
  embedding: ['embedding', 'embeddings'],
  audio: ['audio'],
  responses: ['chat', 'tool_use', 'function_calling'],
  document: ['pdf_understanding'],
  'language-completion': ['completions'],
};

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
          'AIML proprietary /models endpoint returned non-success status',
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
        'AIML model discovery complete',
      );

      return converted;
    } catch (error) {
      this.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to fetch models from AIML proprietary API',
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
    return Boolean(item && typeof item === 'object' && typeof (item as AimlRawModel).id === 'string');
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
      contextWindow: raw.info?.context_length || 8192,
      maxOutputTokens: raw.info?.max_tokens || 4096,
      capabilities,
      pricing: {
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

    // Map from the model type
    const typeCaps = TYPE_CAPABILITY_MAP[modelType];
    if (typeCaps) {
      for (const cap of typeCaps) {
        capSet.add(cap);
      }
    }

    // Add features as capabilities (filter to valid ModelCapability values)
    for (const feature of features) {
      const normalized = feature.trim().toLowerCase().replace(/[\s-]+/g, '_');
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
