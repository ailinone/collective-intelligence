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

type RawModelRecord = Record<string, unknown>;

export class ImageRouterModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'imagerouter';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly log = logger.child({ component: 'imagerouter-model-fetcher' });

  constructor(apiKey: string, baseUrl: string = 'https://api.imagerouter.io') {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async getModels(): Promise<ProviderModel[]> {
    if (!this.apiKey || this.apiKey.includes('mock') || this.apiKey.includes('test-')) {
      this.log.warn('ImageRouter API key missing or mock/test. Skipping model discovery');
      return [];
    }

    try {
      // /v2/models returns a flat ARRAY [{ id, output, price, inputs }]. The
      // legacy /v1/models returns an object-map keyed by model id, which
      // extractRawModels() cannot consume (no data/models/items/results array)
      // — that was the "registered, 0 models" discovery bug.
      const response = await fetch(this.joinUrl('/v2/models'), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const body = await this.safeReadBody(response);
        this.log.warn(
          { status: response.status, body: body.slice(0, 300) },
          'ImageRouter models request returned non-success status'
        );
        return [];
      }

      const payload = (await response.json()) as unknown;
      const rawModels = this.extractRawModels(payload);
      return rawModels
        .map((rawModel) => this.convertRawModel(rawModel))
        .filter((model): model is ProviderModel => Boolean(model));
    } catch (error) {
      this.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to fetch models from ImageRouter'
      );
      return [];
    }
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

  private convertRawModel(rawModel: RawModelRecord): ProviderModel | null {
    const modelId = this.extractString(rawModel, ['id', 'model', 'model_id', 'name']);
    if (!modelId) {
      return null;
    }

    const modalities = this.extractStringArray(rawModel, [
      'output', // ImageRouter /v2: output: ['image'] | ['video']
      'modalities',
      'supported_modalities',
      'output_modalities',
    ]);
    const task = this.extractString(rawModel, ['task', 'type', 'category']) || '';
    const modelNameLower = modelId.toLowerCase();
    const capabilitySet = new Set<ModelCapability>();

    const hasVideoSignals =
      task.toLowerCase().includes('video') ||
      modalities.some((item) => item.toLowerCase().includes('video')) ||
      modelNameLower.includes('video');
    const hasImageSignals =
      task.toLowerCase().includes('image') ||
      modalities.some((item) => item.toLowerCase().includes('image')) ||
      modelNameLower.includes('image') ||
      modelNameLower.includes('flux') ||
      modelNameLower.includes('sdxl');

    if (hasImageSignals) {
      capabilitySet.add('image_generation');
    }
    if (hasVideoSignals) {
      capabilitySet.add('video_generation');
    }
    if (!hasImageSignals && !hasVideoSignals) {
      capabilitySet.add('image_generation');
    }

    const capabilities = Array.from(capabilitySet);
    const metadata = this.buildMetadata(rawModel, capabilities, modalities);

    return {
      id: modelId,
      name: modelId,
      displayName:
        this.extractString(rawModel, ['display_name', 'displayName', 'title', 'name']) || modelId,
      contextWindow:
        this.extractNumber(rawModel, ['context_window', 'contextWindow', 'context_length']) || 8192,
      maxOutputTokens:
        this.extractNumber(rawModel, ['max_output_tokens', 'maxOutputTokens']) || 4096,
      capabilities,
      pricing: {
        inputCostPer1M:
          this.extractNumber(rawModel, ['input_cost_per_1m', 'inputCostPer1M', 'prompt_cost_per_1m']) ||
          0,
        outputCostPer1M:
          this.extractNumber(rawModel, [
            'output_cost_per_1m',
            'outputCostPer1M',
            'completion_cost_per_1m',
          ]) || 0,
        currency: this.extractString(rawModel, ['currency']) || 'USD',
      },
      metadata,
    };
  }

  private buildMetadata(
    rawModel: RawModelRecord,
    capabilities: ModelCapability[],
    modalities: string[]
  ): ModelMetadata {
    const metadata: ModelMetadata = {
      source: 'imagerouter-api',
      provider: 'imagerouter',
      executionProvider: 'imagerouter',
      endpoint: capabilities.includes('video_generation') ? 'videos' : 'images',
      capabilities,
    };

    if (modalities.length > 0) {
      metadata.architecture = {
        input_modalities: modalities,
        output_modalities: modalities,
      };
    }

    const description = this.extractString(rawModel, ['description', 'summary']);
    if (description) {
      metadata.description = description;
    }

    // ImageRouter prices per generation (USD), not per token — surface it here
    // since the per-1M pricing fields stay 0 for image/video models.
    const price = rawModel.price;
    if (price && typeof price === 'object') {
      const avg = (price as Record<string, unknown>).average;
      if (typeof avg === 'number' && Number.isFinite(avg)) {
        metadata.pricePerGenerationUsd = avg;
      }
    }

    return metadata;
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

