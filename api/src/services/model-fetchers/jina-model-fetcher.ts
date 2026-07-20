// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import {
  BaseProviderModelFetcher,
  type ModelMetadata,
  type ProviderModel,
} from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

interface JinaModelFetcherConfig {
  apiKey: string;
  apiBaseUrl?: string;
  deepSearchBaseUrl?: string;
  seedModels?: string[];
}

type RawModelRecord = Record<string, unknown>;

const DEFAULT_JINA_SEED_MODELS = ['jina-deepsearch-v1', 'jina-embeddings-v3'] as const;

function normalizeJinaModelId(value: string): string {
  return value.trim();
}

export class JinaModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'jina';
  private readonly apiKey: string;
  private readonly apiBaseUrl: string;
  private readonly deepSearchBaseUrl: string;
  private readonly seedModels: string[];
  private readonly log = logger.child({ component: 'jina-model-fetcher' });

  constructor(config: JinaModelFetcherConfig) {
    super();
    this.apiKey = config.apiKey || '';
    this.apiBaseUrl = config.apiBaseUrl || 'https://api.jina.ai/v1';
    this.deepSearchBaseUrl = config.deepSearchBaseUrl || 'https://deepsearch.jina.ai/v1';
    this.seedModels =
      config.seedModels && config.seedModels.length > 0
        ? config.seedModels
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : [...DEFAULT_JINA_SEED_MODELS];
  }

  async getModels(): Promise<ProviderModel[]> {
    const seededModels = this.buildSeedModels();

    if (!this.apiKey || this.apiKey.includes('mock') || this.apiKey.includes('test-')) {
      this.log.warn('Jina API key missing or mock/test. Returning seeded models only');
      return seededModels;
    }

    const discovered = await this.fetchModelsFromApi();
    if (discovered.length === 0) {
      return seededModels;
    }

    const merged = new Map<string, ProviderModel>();
    for (const model of seededModels) {
      merged.set(model.id, model);
    }
    for (const model of discovered) {
      merged.set(model.id, model);
    }

    return Array.from(merged.values());
  }

  private async fetchModelsFromApi(): Promise<ProviderModel[]> {
    const candidates = [
      this.joinUrl(this.apiBaseUrl, '/models'),
      this.joinUrl(this.deepSearchBaseUrl, '/models'),
    ];

    for (const url of candidates) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          if (response.status === 404 || response.status === 405) {
            continue;
          }
          this.log.warn({ status: response.status, url }, 'Jina model endpoint returned non-success');
          continue;
        }

        const payload = (await response.json()) as unknown;
        const rawModels = this.extractRawModels(payload);
        const converted = rawModels
          .map((rawModel) => this.convertRawModel(rawModel, url))
          .filter((model): model is ProviderModel => Boolean(model));
        if (converted.length > 0) {
          return converted;
        }
      } catch (error) {
        this.log.debug(
          { url, error: error instanceof Error ? error.message : String(error) },
          'Failed to fetch models from Jina endpoint'
        );
      }
    }

    return [];
  }

  private extractRawModels(payload: unknown): RawModelRecord[] {
    if (Array.isArray(payload)) {
      return payload.filter(
        (item): item is RawModelRecord => Boolean(item && typeof item === 'object')
      );
    }

    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const record = payload as Record<string, unknown>;
    const arrays = [record.data, record.models, record.items, record.results];
    for (const candidate of arrays) {
      if (Array.isArray(candidate)) {
        return candidate.filter(
          (item): item is RawModelRecord => Boolean(item && typeof item === 'object')
        );
      }
    }

    return [];
  }

  private convertRawModel(rawModel: RawModelRecord, sourceUrl: string): ProviderModel | null {
    const modelId =
      this.extractString(rawModel, ['id', 'model', 'model_id', 'name']) || undefined;
    if (!modelId) {
      return null;
    }

    const normalizedId = normalizeJinaModelId(modelId);
    const metadata = this.buildMetadata(rawModel, sourceUrl);
    const capabilities = this.extractCapabilities(metadata, normalizedId);

    const contextWindow =
      this.extractNumber(rawModel, [
        'context_window',
        'contextWindow',
        'context_length',
        'max_context_length',
      ]) || this.inferContextWindow(normalizedId);

    const maxOutputTokens =
      this.extractNumber(rawModel, ['max_output_tokens', 'maxOutputTokens', 'max_completion_tokens']) ||
      this.inferMaxOutputTokens(normalizedId);

    return {
      id: normalizedId,
      name: normalizedId,
      displayName:
        this.extractString(rawModel, ['display_name', 'displayName', 'name']) || normalizedId,
      contextWindow,
      maxOutputTokens,
      capabilities,
      pricing: this.extractPricing(rawModel),
      metadata,
    };
  }

  private buildSeedModels(): ProviderModel[] {
    const unique = new Set<string>();
    const models: ProviderModel[] = [];

    for (const seed of this.seedModels) {
      const modelId = normalizeJinaModelId(seed);
      if (!modelId || unique.has(modelId)) {
        continue;
      }
      unique.add(modelId);
      models.push({
        id: modelId,
        name: modelId,
        displayName: modelId,
        contextWindow: this.inferContextWindow(modelId),
        maxOutputTokens: this.inferMaxOutputTokens(modelId),
        capabilities: this.inferSeedCapabilities(modelId),
        pricing: {
          inputCostPer1M: 0,
          outputCostPer1M: 0,
          currency: 'USD',
        },
        metadata: {
          source: 'jina-seed',
          provider: 'jina',
          executionProvider: 'jina',
          seeded: true,
        },
      });
    }

    return models;
  }

  private inferSeedCapabilities(modelId: string): ModelCapability[] {
    const normalized = modelId.toLowerCase();
    if (normalized.includes('embed')) {
      return ['embeddings', 'embedding'];
    }
    if (normalized.includes('deepsearch')) {
      return ['chat', 'text_generation', 'web_search', 'deep_search'];
    }
    return ['chat', 'text_generation'];
  }

  private inferContextWindow(modelId: string): number {
    const normalized = modelId.toLowerCase();
    if (normalized.includes('embed')) {
      return 8192;
    }
    if (normalized.includes('deepsearch')) {
      return 131072;
    }
    return 32768;
  }

  private inferMaxOutputTokens(modelId: string): number {
    const normalized = modelId.toLowerCase();
    if (normalized.includes('embed')) {
      return 2048;
    }
    if (normalized.includes('deepsearch')) {
      return 8192;
    }
    return 4096;
  }

  private buildMetadata(rawModel: RawModelRecord, sourceUrl: string): ModelMetadata {
    const metadata: ModelMetadata = {
      source: 'jina-api',
      discoveryPath: sourceUrl,
      provider: 'jina',
      executionProvider: 'jina',
      endpoint: 'chat_completions',
    };

    const declaredCapabilities = this.extractStringArray(rawModel, [
      'capabilities',
      'features',
      'supported_capabilities',
    ]) as ModelCapability[];
    if (declaredCapabilities.length > 0) {
      metadata.capabilities = declaredCapabilities;
    }

    const inputModalities = this.extractStringArray(rawModel, ['input_modalities', 'inputModalities']);
    const outputModalities = this.extractStringArray(rawModel, [
      'output_modalities',
      'outputModalities',
    ]);
    if (inputModalities.length > 0 || outputModalities.length > 0) {
      metadata.architecture = {
        input_modalities: inputModalities,
        output_modalities: outputModalities,
      };
    }

    const description = this.extractString(rawModel, ['description', 'summary']);
    if (description) {
      metadata.description = description;
    }

    return metadata;
  }

  private extractPricing(rawModel: RawModelRecord): ProviderModel['pricing'] {
    const inputCostPer1M =
      this.extractNumber(rawModel, ['inputCostPer1M', 'input_cost_per_1m', 'prompt_cost_per_1m']) || 0;
    const outputCostPer1M =
      this.extractNumber(rawModel, [
        'outputCostPer1M',
        'output_cost_per_1m',
        'completion_cost_per_1m',
      ]) || 0;
    return {
      inputCostPer1M,
      outputCostPer1M,
      currency: this.extractString(rawModel, ['currency']) || 'USD',
    };
  }

  private extractString(source: RawModelRecord, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return undefined;
  }

  private extractStringArray(source: RawModelRecord, keys: string[]): string[] {
    for (const key of keys) {
      const value = source[key];
      if (!Array.isArray(value)) {
        continue;
      }
      const parsed = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (parsed.length > 0) {
        return parsed;
      }
    }
    return [];
  }

  private extractNumber(source: RawModelRecord, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return undefined;
  }

  private joinUrl(baseUrl: string, path: string): string {
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
  }
}

