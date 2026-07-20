// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Models Routes
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Model } from '@/types';

const mockModels = vi.hoisted(() => () => [
  {
    id: 'openai-gpt-5.1',
    providerId: 'openai',
    provider: 'openai',
    name: 'gpt-5.1',
    displayName: 'GPT-5.1',
    contextWindow: 512_000,
    maxOutputTokens: 32_768,
    inputCostPer1k: 0.0015,
    outputCostPer1k: 0.012,
    capabilities: ['chat', 'function_calling', 'vision', 'streaming', 'reasoning'],
    performance: { latencyMs: 950, throughput: 120, quality: 0.985, reliability: 0.995 },
    status: 'active',
  },
  {
    id: 'openai-gpt-5.1-mini',
    providerId: 'openai',
    provider: 'openai',
    name: 'gpt-5.1-mini',
    displayName: 'GPT-5.1 Mini',
    contextWindow: 512_000,
    maxOutputTokens: 32_768,
    inputCostPer1k: 0.00035,
    outputCostPer1k: 0.003,
    capabilities: ['chat', 'function_calling', 'vision', 'streaming'],
    performance: { latencyMs: 700, throughput: 170, quality: 0.96, reliability: 0.993 },
    status: 'active',
  },
  {
    id: 'openai-gpt-3.5-turbo',
    providerId: 'openai',
    provider: 'openai',
    name: 'gpt-3.5-turbo',
    displayName: 'GPT-3.5 Turbo',
    contextWindow: 16_385,
    maxOutputTokens: 4_096,
    inputCostPer1k: 0.0005,
    outputCostPer1k: 0.0015,
    capabilities: ['chat', 'function_calling', 'streaming'],
    performance: { latencyMs: 800, throughput: 180, quality: 0.82, reliability: 0.99 },
    status: 'active',
  },
  {
    id: 'openai-gpt-4-turbo',
    providerId: 'openai',
    provider: 'openai',
    name: 'gpt-4-turbo',
    displayName: 'GPT-4 Turbo',
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.03,
    capabilities: ['chat', 'function_calling', 'vision', 'streaming'],
    performance: { latencyMs: 1500, throughput: 85, quality: 0.94, reliability: 0.99 },
    status: 'active',
  },
  {
    id: 'anthropic-claude-3-5-sonnet',
    providerId: 'anthropic',
    provider: 'anthropic',
    name: 'claude-3-5-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    capabilities: ['chat', 'function_calling', 'vision', 'streaming'],
    performance: { latencyMs: 1600, throughput: 80, quality: 0.95, reliability: 0.99 },
    status: 'active',
  },
  {
    id: 'anthropic-claude-3-opus',
    providerId: 'anthropic',
    provider: 'anthropic',
    name: 'claude-3-opus',
    displayName: 'Claude 3 Opus',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    inputCostPer1k: 0.015,
    outputCostPer1k: 0.075,
    capabilities: ['chat', 'function_calling', 'vision'],
    performance: { latencyMs: 2000, throughput: 70, quality: 0.97, reliability: 0.99 },
    status: 'active',
  },
  {
    id: 'anthropic-claude-3-haiku',
    providerId: 'anthropic',
    provider: 'anthropic',
    name: 'claude-3-haiku',
    displayName: 'Claude 3 Haiku',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    inputCostPer1k: 0.0008,
    outputCostPer1k: 0.004,
    capabilities: ['chat', 'function_calling', 'vision'],
    performance: { latencyMs: 900, throughput: 140, quality: 0.9, reliability: 0.99 },
    status: 'active',
  },
  {
    id: 'anthropic-claude-3-sonnet',
    providerId: 'anthropic',
    provider: 'anthropic',
    name: 'claude-3-sonnet',
    displayName: 'Claude 3 Sonnet',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    capabilities: ['chat', 'function_calling', 'vision'],
    performance: { latencyMs: 1700, throughput: 85, quality: 0.94, reliability: 0.99 },
    status: 'active',
  },
]);

const listModelsMock = vi.hoisted(() =>
  vi.fn(async (filters?: { provider?: string; capability?: string; enabled?: boolean; limit?: number; offset?: number }) => {
    let results = mockModels().map((model) => ({ ...model }));
    if (filters?.provider) {
      results = results.filter(
        (model) => model.provider === filters.provider || model.providerId === filters.provider
      );
    }
    if (filters?.capability) {
      results = results.filter((model) => model.capabilities.includes(filters.capability!));
    }
    if (filters?.enabled !== undefined) {
      results = results.filter((model) => (filters.enabled ? model.status === 'active' : model.status !== 'active'));
    }
    if (filters?.offset) {
      results = results.slice(filters.offset);
    }
    if (filters?.limit !== undefined) {
      results = results.slice(0, filters.limit);
    }
    return results;
  })
);

const getModelMock = vi.hoisted(() =>
  vi.fn(async (modelId: string) => {
    const dataset = mockModels();
    const found = dataset.find((model) => model.id === modelId);
    return found ? { ...found } : null;
  })
);

const bulkGetMock = vi.hoisted(() =>
  vi.fn(async (ids: string[]) => {
    const dataset = mockModels();
    const map = new Map<string, Model>();
    for (const id of ids) {
      const found = dataset.find((model) => model.id === id);
      if (found) {
        map.set(id, { ...found });
      }
    }
    return map;
  })
);

vi.mock('@/services/model-catalog-service', () => ({
  modelCatalogService: {
    listModels: listModelsMock,
    getModel: getModelMock,
    bulkGet: bulkGetMock,
    prime: vi.fn(),
    recordUsage: vi.fn(),
  },
}));

import { ProviderRegistry } from '@/providers/provider-registry';
import { OpenAIAdapter } from '@/providers/openai/openai-adapter';
import { AnthropicAdapter } from '@/providers/anthropic/anthropic-adapter';
import { modelCatalogService } from '@/services/model-catalog-service';

describe('Models Routes Logic', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    listModelsMock.mockClear();
    getModelMock.mockClear();
    bulkGetMock.mockClear();

    // Initialize registry with mock adapters
    registry = new ProviderRegistry();
    
    const openaiAdapter = new OpenAIAdapter({
      name: 'openai',
      apiKey: 'test-key',
      models: ['gpt-5.1', 'gpt-5.1-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    });
    
    const anthropicAdapter = new AnthropicAdapter({
      name: 'anthropic',
      apiKey: 'test-key',
      models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'],
    });
    
    registry.register(openaiAdapter);
    registry.register(anthropicAdapter);
  });

  describe('List Models', () => {
    it('should return all available models from all providers', async () => {
      const models = await registry.getAllModels();

      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      
      // Should have both OpenAI and Anthropic models
      const providers = [...new Set(models.map(m => m.provider))];
      expect(providers).toContain('openai');
      expect(providers).toContain('anthropic');
    });

    it('should return models with correct structure', async () => {
      const models = await registry.getAllModels();
      
      const firstModel = models[0];
      expect(firstModel).toHaveProperty('id');
      expect(firstModel).toHaveProperty('name');
      expect(firstModel).toHaveProperty('provider');
      expect(firstModel).toHaveProperty('capabilities');
      expect(firstModel).toHaveProperty('inputCostPer1k');
      expect(firstModel).toHaveProperty('outputCostPer1k');
    });

    it('should include model capabilities', async () => {
      const models = await registry.getAllModels();
      
      const gpt5Model = models.find(m => m.id.includes('gpt-5.1'));
      expect(gpt5Model).toBeDefined();
      expect(Array.isArray(gpt5Model?.capabilities)).toBe(true);
      expect(gpt5Model?.capabilities).toContain('streaming');
      expect(gpt5Model?.capabilities).toContain('function_calling');
      expect(gpt5Model?.capabilities).toContain('vision');
    });

    it('should include model pricing', async () => {
      const models = await registry.getAllModels();
      
      const claudeModel = models.find(m => m.id.includes('claude-3-5-sonnet'));
      expect(claudeModel).toBeDefined();
      expect(typeof claudeModel?.inputCostPer1k).toBe('number');
      expect(typeof claudeModel?.outputCostPer1k).toBe('number');
      expect(claudeModel!.inputCostPer1k).toBeGreaterThan(0);
      expect(claudeModel!.outputCostPer1k).toBeGreaterThan(0);
    });

    it('should return at least 8 models (4 OpenAI + 4 Anthropic)', async () => {
      const models = await registry.getAllModels();
      expect(models.length).toBeGreaterThanOrEqual(8);
    });
  });

  describe('Get Model by ID', () => {
    it('should return model details for valid model ID', async () => {
      // Get first available model from list
      const models = await registry.getAllModels();
      expect(models.length).toBeGreaterThan(0);
      
      const firstModel = models[0];
      const result = await registry.findModel(firstModel.id);

      expect(result).toBeDefined();
      expect(result?.model.id).toBe(firstModel.id);
      expect(result?.adapter).toBeDefined();
    });

    it('should return null for invalid model ID', async () => {
      const result = await registry.findModel('invalid-model-id-that-does-not-exist');
      expect(result).toBeNull();
    });

    it('should return model with all required fields', async () => {
      const models = await registry.getAllModels();
      const claudeModel = models.find(m => m.provider === 'anthropic');
      
      if (claudeModel) {
        const result = await registry.findModel(claudeModel.id);

        expect(result).toBeDefined();
        const model = result!.model;
        expect(model).toHaveProperty('id');
        expect(model).toHaveProperty('name');
        expect(model).toHaveProperty('provider');
        expect(model).toHaveProperty('displayName');
        expect(model).toHaveProperty('capabilities');
        expect(model).toHaveProperty('inputCostPer1k');
        expect(model).toHaveProperty('outputCostPer1k');
        expect(model).toHaveProperty('contextWindow');
        expect(model).toHaveProperty('maxOutputTokens');
      }
    });

    it('should support multiple provider models', async () => {
      const models = await registry.getAllModels();
      const openaiModels = models.filter(m => m.provider === 'openai');
      const anthropicModels = models.filter(m => m.provider === 'anthropic');

      expect(openaiModels.length).toBeGreaterThan(0);
      expect(anthropicModels.length).toBeGreaterThan(0);
      
      // Verify we can find them by ID
      if (openaiModels.length > 0) {
        const found = await registry.findModel(openaiModels[0].id);
        expect(found).toBeDefined();
        expect(found?.model.provider).toBe('openai');
      }
      
      if (anthropicModels.length > 0) {
        const found = await registry.findModel(anthropicModels[0].id);
        expect(found).toBeDefined();
        expect(found?.model.provider).toBe('anthropic');
      }
    });

    it('should find models from both providers', async () => {
      const models = await registry.getAllModels();
      
      expect(models.length).toBeGreaterThanOrEqual(2);
      
      // Test finding at least 2 different models
      const model1 = await registry.findModel(models[0].id);
      const model2 = await registry.findModel(models[1].id);

      expect(model1).toBeDefined();
      expect(model2).toBeDefined();
      expect(model1?.adapter).toBeDefined();
      expect(model2?.adapter).toBeDefined();
    });
  });

  describe('Model Filtering', () => {
    it('should filter models by provider', async () => {
      const allModels = await registry.getAllModels();
      const openaiModels = allModels.filter(m => m.provider === 'openai');
      const anthropicModels = allModels.filter(m => m.provider === 'anthropic');

      expect(openaiModels.length).toBeGreaterThan(0);
      expect(anthropicModels.length).toBeGreaterThan(0);
      expect(openaiModels.length + anthropicModels.length).toBe(allModels.length);
    });

    it('should filter models by capability', async () => {
      const allModels = await registry.getAllModels();
      const visionModels = allModels.filter(m => m.capabilities.includes('vision'));
      const functionModels = allModels.filter(m => m.capabilities.includes('function_calling'));

      expect(visionModels.length).toBeGreaterThan(0);
      expect(functionModels.length).toBeGreaterThan(0);
    });

    it('should filter models by cost (cheap vs expensive)', async () => {
      const allModels = await registry.getAllModels();
      
      // Cheap: input < $0.001 per 1k tokens
      const cheapModels = allModels.filter(m => m.inputCostPer1k < 0.001);
      
      // Expensive: input >= $0.01 per 1k tokens
      const expensiveModels = allModels.filter(m => m.inputCostPer1k >= 0.01);

      expect(cheapModels.length).toBeGreaterThan(0);
      expect(expensiveModels.length).toBeGreaterThan(0);
    });
  });

  describe('Model Metadata', () => {
    it('should provide context window sizes for all models', async () => {
      const models = await registry.getAllModels();

      models.forEach(model => {
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(typeof model.contextWindow).toBe('number');
      });
      
      // Verify at least one model has a large context window
      const hasLargeContext = models.some(m => m.contextWindow >= 100000);
      expect(hasLargeContext).toBe(true);
    });

    it('should provide max output tokens for all models', async () => {
      const models = await registry.getAllModels();

      models.forEach(model => {
        expect(model.maxOutputTokens).toBeGreaterThan(0);
        expect(typeof model.maxOutputTokens).toBe('number');
      });
      
      // Verify reasonable output limits
      const hasReasonableLimit = models.some(m => m.maxOutputTokens >= 4096);
      expect(hasReasonableLimit).toBe(true);
    });

    it('should include model display names', async () => {
      const models = await registry.getAllModels();
      
      models.forEach(model => {
        expect(model.displayName).toBeDefined();
        expect(typeof model.displayName).toBe('string');
        expect(model.displayName.length).toBeGreaterThan(0);
      });
    });
  });
});

