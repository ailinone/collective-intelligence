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
} from './provider-model-fetcher.js';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';
import { inferCapabilitiesFromModelId } from './model-capability-patterns.js';

interface OpenAICompatibleHubModelFetcherConfig {
  providerName: string;
  apiKey: string;
  baseUrl: string;
  modelListPaths?: string[];
  authHeaderName?: string;
  authScheme?: string;
  secondaryAuthHeaderName?: string;
  secondaryAuthScheme?: string;
  extraHeaders?: Record<string, string>;
  /** Model IDs to exclude (read from env: <PROVIDER>_MODEL_DENYLIST=model1,model2) */
  modelDenylist?: string[];
}

type RawModelRecord = Record<string, unknown>;

function normalizeHubModelId(rawModelId: string): string {
  const trimmed = rawModelId.trim();
  if (!trimmed) {
    return trimmed;
  }

  // Already canonical or workspace-scoped (e.g., workspace@provider/model)
  if (trimmed.includes('/')) {
    return trimmed;
  }

  // Some hubs expose IDs as provider@model. Normalize to provider/model for execution.
  const atIndex = trimmed.indexOf('@');
  if (atIndex > 0 && atIndex < trimmed.length - 1) {
    const provider = trimmed.slice(0, atIndex).trim();
    const model = trimmed.slice(atIndex + 1).trim();
    if (provider && model && !model.includes('/')) {
      return `${provider}/${model}`;
    }
  }

  return trimmed;
}

function normalizeProviderToken(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

export class OpenAICompatibleHubModelFetcher extends BaseProviderModelFetcher {
  protected providerName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly modelListPaths: string[];
  private readonly authHeaderName: string;
  private readonly authScheme: string;
  private readonly secondaryAuthHeaderName?: string;
  private readonly secondaryAuthScheme?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly modelDenylist: Set<string>;
  private readonly log;

  constructor(config: OpenAICompatibleHubModelFetcherConfig) {
    super();
    this.providerName = config.providerName.trim().toLowerCase().replace(/[\s_]+/g, '-');
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.modelListPaths = (
      config.modelListPaths && config.modelListPaths.length > 0
        ? config.modelListPaths
        : ['/models', '/v1/models', '/llm/models', '/info/models']
    ).filter((path, index, all) => all.indexOf(path) === index);
    this.authHeaderName = config.authHeaderName || 'Authorization';
    this.authScheme = config.authScheme || 'Bearer';
    this.secondaryAuthHeaderName = config.secondaryAuthHeaderName;
    this.secondaryAuthScheme = config.secondaryAuthScheme;
    this.extraHeaders = config.extraHeaders || {};
    // Denylist from config OR from env: <PROVIDER_UPPER>_MODEL_DENYLIST=model1,model2
    const envKey = `${this.providerName.toUpperCase().replace(/-/g, '_')}_MODEL_DENYLIST`;
    const fromEnv = process.env[envKey] ? process.env[envKey]!.split(',').map((s) => s.trim()).filter(Boolean) : [];
    this.modelDenylist = new Set([...(config.modelDenylist ?? []), ...fromEnv]);
    if (this.modelDenylist.size > 0) {
      this.log = logger.child({ component: `${this.providerName}-fetcher` });
      this.log.info({ denylist: [...this.modelDenylist] }, 'Model denylist active for hub fetcher');
    }
    this.log = logger.child({ component: `${this.providerName}-fetcher` });
  }

  async getModels(): Promise<ProviderModel[]> {
    if (!this.apiKey || this.apiKey.includes('mock') || this.apiKey.includes('test-')) {
      this.log.warn('API key appears to be missing or mock/test, skipping model discovery');
      return [];
    }

    for (const path of this.modelListPaths) {
      try {
        const response = await fetch(this.buildUrl(path), {
          method: 'GET',
          headers: this.buildRequestHeaders(),
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          if (response.status === 404 || response.status === 405) {
            continue;
          }

          const errorText = await this.safeReadResponseText(response);
          this.log.warn(
            { path, status: response.status, body: errorText.slice(0, 400) },
            'Hub model discovery endpoint returned non-success status'
          );

          if (response.status === 401 || response.status === 403) {
            return [];
          }
          continue;
        }

        const payload = (await response.json()) as unknown;
        const rawModels = this.extractRawModels(payload);
        if (rawModels.length === 0) {
          continue;
        }

        const converted = rawModels
          .map((rawModel) => this.convertRawModel(rawModel, path))
          .filter((model): model is ProviderModel => Boolean(model))
          .filter((model) => !this.modelDenylist.has(model.id));

        if (converted.length > 0) {
          return converted;
        }
      } catch (error) {
        this.log.debug(
          { path, error: error instanceof Error ? error.message : String(error) },
          'Hub model discovery request failed, trying next endpoint'
        );
      }
    }

    return [];
  }

  private buildRequestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    headers[this.authHeaderName] = this.authScheme
      ? `${this.authScheme} ${this.apiKey}`.trim()
      : this.apiKey;

    if (this.secondaryAuthHeaderName) {
      const scheme = this.secondaryAuthScheme || this.authScheme;
      headers[this.secondaryAuthHeaderName] = scheme
        ? `${scheme} ${this.apiKey}`.trim()
        : this.apiKey;
    }

    for (const [key, value] of Object.entries(this.extraHeaders)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        headers[key] = value;
      }
    }

    return headers;
  }

  private buildUrl(path: string): string {
    const normalizedBase = this.baseUrl.endsWith('/')
      ? this.baseUrl.slice(0, -1)
      : this.baseUrl;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  private async safeReadResponseText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
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
    const possibleArrays = [
      record.data,
      record.models,
      record.results,
      record.items,
      record.entries,
    ];

    for (const candidate of possibleArrays) {
      if (Array.isArray(candidate)) {
        return candidate.filter(
          (item): item is RawModelRecord => Boolean(item && typeof item === 'object')
        );
      }
    }

    return [];
  }

  private convertRawModel(rawModel: RawModelRecord, sourcePath: string): ProviderModel | null {
    const rawModelId = this.extractString(rawModel, [
      'id',
      'model',
      'model_id',
      'name',
      'slug',
    ]);

    if (!rawModelId) {
      return null;
    }

    const modelId = normalizeHubModelId(rawModelId);
    const displayName =
      this.extractString(rawModel, ['display_name', 'displayName', 'name', 'title']) || modelId;

    const contextWindow =
      this.extractNumber(rawModel, [
        'context_window',
        'contextWindow',
        'context_length',
        'max_context_length',
        'maxContextLength',
      ]) || 8192;

    const maxOutputTokens =
      this.extractNumber(rawModel, [
        'max_output_tokens',
        'maxOutputTokens',
        'max_completion_tokens',
        'maxCompletionTokens',
      ]) || 4096;

    const metadata = this.buildMetadata(rawModel, sourcePath, modelId, rawModelId);
    let capabilities = this.extractCapabilities(metadata, modelId);

    // Fallback: infer capabilities from model ID patterns when provider metadata
    // did not yield any capabilities.
    if (!capabilities || capabilities.length === 0) {
      const inferred = inferCapabilitiesFromModelId(modelId);
      if (inferred) {
        capabilities = inferred.capabilities as ModelCapability[];
        if (metadata) {
          metadata.endpoint = inferred.endpoint;
          metadata.inferredType = inferred.modelType;
        }
      } else {
        // Default: models in /v1/models are most likely chat models
        capabilities = ['chat', 'text_generation'] as ModelCapability[];
      }
    }

    const pricing = this.extractPricing(rawModel);

    return {
      id: modelId,
      name: modelId,
      displayName,
      contextWindow,
      maxOutputTokens,
      capabilities,
      pricing,
      metadata,
    };
  }

  private buildMetadata(
    rawModel: RawModelRecord,
    sourcePath: string,
    modelId: string,
    rawModelId: string
  ): ModelMetadata {
    const metadata: ModelMetadata = {
      source: `${this.providerName}-api`,
      discoveryPath: sourcePath,
      provider: this.providerName,
      executionProvider: this.providerName,
    };

    const originalProvider =
      this.extractOriginalProviderFromId(modelId) ||
      this.extractOriginalProviderFromId(rawModelId) ||
      this.extractDeclaredProvider(rawModel);
    if (originalProvider) {
      metadata.originalProvider = originalProvider;
      metadata.executionProviders = [this.providerName, originalProvider];
    } else {
      metadata.executionProviders = [this.providerName];
    }
    if (rawModelId !== modelId) {
      metadata.rawModelId = rawModelId;
    }

    const description = this.extractString(rawModel, ['description', 'summary', 'details']);
    if (description) {
      metadata.description = description;
    }

    const endpoint = this.extractString(rawModel, ['endpoint', 'api', 'target_endpoint']);
    if (endpoint) {
      metadata.endpoint = endpoint;
    }

    const supportedParameters = this.extractStringArray(rawModel, [
      'supported_parameters',
      'supportedParameters',
      'parameters',
    ]);
    if (supportedParameters.length > 0) {
      metadata.supported_parameters = supportedParameters;
      // Derive uses_max_completion_tokens from supported_parameters
      if (supportedParameters.includes('max_completion_tokens')) {
        metadata.uses_max_completion_tokens = true;
      }
    }

    const declaredCapabilities = this.extractStringArray(rawModel, [
      'capabilities',
      'features',
      'supported_capabilities',
      'supportedCapabilities',
    ]) as ModelCapability[];
    if (declaredCapabilities.length > 0) {
      metadata.capabilities = declaredCapabilities;
    }

    const inputModalities = this.extractStringArray(rawModel, [
      'input_modalities',
      'inputModalities',
    ]);
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

    return metadata;
  }

  private extractDeclaredProvider(rawModel: RawModelRecord): string | undefined {
    const candidates = ['owned_by', 'provider', 'vendor', 'model_provider', 'source_provider'];
    for (const key of candidates) {
      const value = rawModel[key];
      if (typeof value !== 'string') {
        continue;
      }
      const normalized = normalizeProviderToken(value);
      if (!normalized || normalized === this.providerName) {
        continue;
      }
      return normalized;
    }
    return undefined;
  }

  private extractPricing(rawModel: RawModelRecord): ProviderModel['pricing'] {
    const directInputCostPer1M = this.extractNumber(rawModel, [
      'inputCostPer1M',
      'input_cost_per_1m',
      'prompt_cost_per_1m',
    ]);
    const directOutputCostPer1M = this.extractNumber(rawModel, [
      'outputCostPer1M',
      'output_cost_per_1m',
      'completion_cost_per_1m',
    ]);

    if (directInputCostPer1M !== undefined || directOutputCostPer1M !== undefined) {
      return {
        inputCostPer1M: directInputCostPer1M || 0,
        outputCostPer1M: directOutputCostPer1M || 0,
        currency:
          this.extractString(rawModel, ['currency', 'pricing_currency']) || 'USD',
      };
    }

    const pricingObject =
      rawModel.pricing && typeof rawModel.pricing === 'object'
        ? (rawModel.pricing as Record<string, unknown>)
        : undefined;

    const prompt = this.extractNumberish(
      pricingObject || rawModel,
      pricingObject
        ? ['prompt', 'input', 'prompt_price', 'promptPrice']
        : ['prompt', 'input']
    );
    const completion = this.extractNumberish(
      pricingObject || rawModel,
      pricingObject
        ? ['completion', 'output', 'completion_price', 'completionPrice']
        : ['completion', 'output']
    );

    return {
      inputCostPer1M: this.normalizeTokenPriceToPer1M(prompt),
      outputCostPer1M: this.normalizeTokenPriceToPer1M(completion),
      currency:
        this.extractString(pricingObject || rawModel, ['currency']) || 'USD',
    };
  }

  // Above this, a computed per-1M price is treated as a unit-detection
  // failure rather than a genuine price — no real published API price for
  // chat completions is known to exceed this (current known max ~$75/Mtok
  // for the priciest frontier output tokens). Observed corruption this
  // guards against: qwen3.5-omni-flash / qwen-turbo / deepseek-v4-pro rows
  // computed at $250-$1200/Mtok (~1000x too high) via the unit-guessing
  // heuristic below, which then poisoned the experiment budget governor
  // (H-B mini-run: quality_multipass blew a $20 arm cap on 2 executions).
  private static readonly PLAUSIBLE_MAX_PER_1M = 100;

  private normalizeTokenPriceToPer1M(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
      return 0;
    }

    // Heuristic (inherently ambiguous — different hubs declare "prompt"/
    // "completion" price in different units with no field to disambiguate):
    // - very small values (&lt;0.0001) are almost certainly $/token
    // - mid-range values (0.0001-1) are almost certainly $/1k-tokens — this
    //   is the OpenAI-legacy convention several OAI-compat hubs follow, and
    //   was previously misclassified as $/token (×1e6 instead of ×1000),
    //   producing prices ~1000x too high.
    // - larger values are likely already normalized $/1M-tokens.
    let normalized: number;
    if (value < 0.0001) {
      normalized = value * 1_000_000;
    } else if (value < 1) {
      normalized = value * 1_000;
    } else {
      normalized = value;
    }

    // Plausibility clamp: whichever bucket guessed wrong, don't let an
    // implausible price reach the catalog/DB — 0 reads as "unknown" (see
    // PricingMode.none), not "free", so downstream cost estimation falls
    // back to a real default instead of the corrupted figure.
    return normalized <= OpenAICompatibleHubModelFetcher.PLAUSIBLE_MAX_PER_1M ? normalized : 0;
  }

  private extractOriginalProviderFromId(modelId: string): string | undefined {
    const normalizedModelId = normalizeHubModelId(modelId).trim().toLowerCase();
    if (!normalizedModelId) {
      return undefined;
    }

    // workspace@provider/model
    const atIndex = normalizedModelId.indexOf('@');
    const slashIndex = normalizedModelId.indexOf('/');
    if (atIndex > -1 && slashIndex > atIndex) {
      const provider = normalizedModelId.slice(atIndex + 1, slashIndex).trim();
      if (provider && provider !== this.providerName) {
        return provider;
      }
    }

    // provider/model
    if (slashIndex > 0) {
      const provider = normalizedModelId.slice(0, slashIndex).trim();
      if (provider && provider !== this.providerName) {
        return provider;
      }
    }

    // provider@model
    if (atIndex > 0) {
      const provider = normalizedModelId.slice(0, atIndex).trim();
      if (provider && provider !== this.providerName) {
        return provider;
      }
    }

    return undefined;
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

  private extractNumberish(source: RawModelRecord, keys: string[]): number | undefined {
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

  private extractNumber(source: RawModelRecord, keys: string[]): number | undefined {
    return this.extractNumberish(source, keys);
  }
}
