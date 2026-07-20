// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { nanoid } from 'nanoid';
import { ProviderAdapter, type ProviderConfig } from '@/providers/base/provider-adapter';
import { ProviderRegistry } from '@/providers/provider-registry';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  Provider,
  ProviderHealth,
} from '@/types';
import type { ProviderCatalogEntry } from '@/services/model-catalog-service';
import { syncModelCatalog } from '@/services/model-catalog-service';

class MockProviderAdapter extends ProviderAdapter {
  private models: Model[];
  private readonly providerId: string;

  constructor(providerId: string, displayName: string, config: ProviderConfig, models: Model[]) {
    super(providerId, displayName, config);
    this.providerId = providerId;
    this.models = models;
  }

  async getProvider(): Promise<Provider> {
    return {
      id: this.providerId,
      name: this.providerId,
      displayName: this.displayName,
      status: 'active',
      health: this.getHealth(),
      models: this.models,
    };
  }

  async getModels(): Promise<Model[]> {
    return this.models;
  }

  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    return this.executeThroughBulkhead(
      async () => buildChatResponse(request, request.model ?? this.models[0].name),
      'chatCompletion'
    );
  }

  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse> {
    yield await this.chatCompletion(request);
  }

  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const data = inputs.map((_, index) => ({
      object: 'embedding',
      embedding: Array.from({ length: 10 }, (_value, i) => Number((0.01 * (index + 1) * (i + 1)).toFixed(6))),
      index,
    }));

    return {
      object: 'list',
      data,
      model: request.model || this.models[2].name,
      usage: {
        prompt_tokens: inputs.length * 8,
        completion_tokens: 0,
        total_tokens: inputs.length * 8,
      },
    };
  }

  async healthCheck(): Promise<ProviderHealth & { latency?: number }> {
    const health = this.getHealth();
    return {
      ...health,
      latency: 5,
    };
  }

  calculateCost(model: Model, inputTokens: number, outputTokens: number): number {
    const inputCost = (inputTokens / 1000) * model.inputCostPer1k;
    const outputCost = (outputTokens / 1000) * model.outputCostPer1k;
    return Number((inputCost + outputCost || 0.005).toFixed(6));
  }

  normalizeModelName(modelName: string): string {
    return modelName;
  }

  private getHealth(): ProviderHealth {
    return {
      status: 'healthy',
      lastCheck: new Date(),
      latency: 5,
      errorRate: 0,
    };
  }
}

function buildChatResponse(request: ChatRequest, modelName: string): ChatResponse {
  const lastMessage = request.messages[request.messages.length - 1];
  const content =
    typeof lastMessage?.content === 'string'
      ? lastMessage.content
      : Array.isArray(lastMessage?.content)
      ? JSON.stringify(lastMessage.content)
      : 'Mock request';

  return {
    id: `mock-${nanoid(8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: `Mock response to: ${content}\n\nThis is a deterministic mock response generated for testing purposes. The mock adapter simulates a real AI provider response with sufficient length and structure to satisfy aggregation quality checks in the response-aggregator (>500 chars = strength). In production, this is replaced by real model responses from the configured provider backends. Key points addressed: (1) analysis of the input request, (2) identification of relevant patterns and context, (3) actionable recommendations based on established best practices, and (4) a concise summary of findings for further review and iteration. This text intentionally meets the 500-character length threshold so that synthesisAggregation scores this response as a strength rather than neutral.`,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 16,
      completion_tokens: 12,
      total_tokens: 28,
    },
  };
}

export function createMockProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  const baseModels = (providerId: string, definitions: Array<{ id: string; name: string; displayName: string; capabilities: Model['capabilities']; }>): Model[] =>
    definitions.map(({ id, name, displayName, capabilities }) => ({
      id,
      providerId,
      provider: providerId,
      name,
      displayName,
      contextWindow: 128000,
      maxOutputTokens: 8192,
      inputCostPer1k: 0.001,
      outputCostPer1k: 0.002,
      capabilities,
      performance: {
        latencyMs: 50,
        throughput: 200,
        quality: 0.9,
        reliability: 0.99,
      },
      status: 'active',
    }));

  // NOTE: every chat model carries the explicit `'chat'` capability so it
  // passes the modality filter in PoolBuilder (`pool-builder.ts:71`) and the
  // identical fallback in `base-strategy.ts:189`. Production catalog rows do
  // the same — see `providers.catalog.ts:165` (sonar-small-online uses
  // `['chat', 'streaming', 'web_search']`). Keeping the mock honest about
  // chat tagging is what makes collaborative/competitive/expert-panel test
  // suites discover ≥3 eligible models from the seeded inventory.
  const openAiModels = baseModels('openai', [
    { id: 'mock-openai-gpt-5.1', name: 'gpt-5.1', displayName: 'GPT-5.1', capabilities: ['chat', 'function_calling', 'streaming', 'json_mode', 'reasoning'] },
    { id: 'mock-openai-gpt-5.1-mini', name: 'gpt-5.1-mini', displayName: 'GPT-5.1 Mini', capabilities: ['chat', 'function_calling', 'streaming', 'json_mode'] },
    { id: 'mock-openai-gpt-5', name: 'gpt-5', displayName: 'GPT-5', capabilities: ['chat', 'function_calling', 'streaming', 'json_mode'] },
    { id: 'mock-openai-gpt-5-mini', name: 'gpt-5-mini', displayName: 'GPT-5 Mini', capabilities: ['chat', 'function_calling', 'streaming'] },
    { id: 'mock-openai-gpt-4o', name: 'gpt-4o', displayName: 'GPT-4 Optimized', capabilities: ['chat', 'function_calling', 'streaming', 'json_mode'] },
    { id: 'mock-openai-gpt-4o-mini', name: 'gpt-4o-mini', displayName: 'GPT-4o Mini', capabilities: ['chat', 'function_calling', 'streaming'] },
    { id: 'mock-openai-embedding', name: 'text-embedding-3-small', displayName: 'Text Embedding 3 Small', capabilities: ['embeddings'] },
    { id: 'mock-openai-gpt-4.1-mini', name: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', capabilities: ['chat', 'function_calling', 'streaming'] },
    { id: 'mock-openai-gpt-4.1', name: 'gpt-4.1', displayName: 'GPT-4.1', capabilities: ['chat', 'function_calling', 'streaming', 'json_mode'] },
  ]);

  const anthropicModels = baseModels('anthropic', [
    { id: 'mock-anthropic-claude-3.7-sonnet', name: 'claude-3.7-sonnet', displayName: 'Claude 3.7 Sonnet', capabilities: ['chat', 'function_calling', 'streaming', 'json_mode', 'reasoning'] },
    { id: 'mock-anthropic-claude-3-opus', name: 'claude-3-opus', displayName: 'Claude 3 Opus', capabilities: ['chat', 'function_calling', 'streaming', 'json_mode'] },
    { id: 'mock-anthropic-claude-3-sonnet', name: 'claude-3-sonnet', displayName: 'Claude 3 Sonnet', capabilities: ['chat', 'function_calling', 'streaming'] },
    { id: 'mock-anthropic-claude-3-haiku', name: 'claude-3-haiku', displayName: 'Claude 3 Haiku', capabilities: ['chat', 'function_calling', 'streaming'] },
    { id: 'mock-anthropic-embedding', name: 'claude-embedding-v1', displayName: 'Claude Embedding v1', capabilities: ['embeddings'] },
  ]);

  registry.register(new MockProviderAdapter('openai', 'Mock OpenAI', { apiKey: 'mock-openai-key' }, openAiModels));
  registry.register(new MockProviderAdapter('anthropic', 'Mock Anthropic', { apiKey: 'mock-anthropic-key' }, anthropicModels));
  return registry;
}

export function extractAccessToken(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const obj = payload as Record<string, unknown>;
  return (obj?.tokens as Record<string, unknown>)?.accessToken as string ?? obj?.accessToken as string ?? obj?.token as string ?? '';
}

/**
 * Sync models from a ProviderRegistry to the model catalog database
 * This is needed for tests that require models to be available in the catalog
 */
export async function syncMockModelsToCatalog(registry: ProviderRegistry): Promise<void> {
  // Get models directly from adapters since getAllModels() uses catalog service
  const adapters = registry.getAll();
  const allModels: Model[] = [];
  const providersMap = new Map<string, Provider>();

  // Collect models and provider info from adapters
  for (const adapter of adapters) {
    try {
      const provider = await adapter.getProvider();
      providersMap.set(provider.name, provider);
      const models = await adapter.getModels();
      allModels.push(...models);
    } catch (error) {
      // Skip adapters that fail to provide models
      continue;
    }
  }

  if (allModels.length === 0) {
    throw new Error('No models found in registry to sync');
  }

  // Group models by provider
  const modelsByProvider = new Map<string, Model[]>();
  for (const model of allModels) {
    const providerName = model.provider;
    if (!modelsByProvider.has(providerName)) {
      modelsByProvider.set(providerName, []);
    }
    modelsByProvider.get(providerName)!.push(model);
  }

  // Convert to ProviderCatalogEntry format
  const catalogEntries: ProviderCatalogEntry[] = [];
  for (const [providerName, models] of modelsByProvider.entries()) {
    const provider = providersMap.get(providerName);
    if (!provider) {
      continue;
    }

    catalogEntries.push({
      name: providerName,
      displayName: provider.displayName,
      status: provider.status,
      metadata: {},
      models: models.map((model) => ({
        name: model.name,
        displayName: model.displayName,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        inputCostPer1K: model.inputCostPer1k,
        outputCostPer1K: model.outputCostPer1k,
        capabilities: model.capabilities,
        performance: model.performance,
        status: model.status,
        metadata: {},
      })),
    });
  }

  // Sync to database
  await syncModelCatalog(catalogEntries);
}

