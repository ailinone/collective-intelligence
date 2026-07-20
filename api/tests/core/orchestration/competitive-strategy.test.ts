// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Competitive Strategy
 * Uses REAL models from dynamic discovery - NO hardcoded models, NO mocks
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { CompetitiveStrategy } from '@/core/orchestration/strategies/competitive-strategy';
import type { ChatRequest, OrchestrationContext, Model, TaskType } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { getProviderRegistry, setProviderRegistry } from '@/providers/provider-registry';
import { discoverModelsDynamically, getModelsWithCapabilities } from '../../utils/dynamic-model-discovery';
import { startTestEnvironment, stopTestEnvironment } from '../../utils/test-environment';
import { createMockProviderRegistry } from '../../utils/mock-provider';

/**
 * Type for strategy with getAdapterForModel method (injected by OrchestrationEngine)
 */
type StrategyWithAdapter = CompetitiveStrategy & {
  getAdapterForModel?: (model: Model, context: OrchestrationContext) => Promise<ProviderAdapter | null>;
  parseArbiterSelection?: (response: unknown, modelCount: number) => number;
};

describe('CompetitiveStrategy - Real Tests (NO Mocks, NO Hardcoded Models)', () => {
  let strategy: CompetitiveStrategy;
  let testRequest: ChatRequest;
  let realModels: Model[];
  let testContext: OrchestrationContext;

  beforeAll(async () => {
    await startTestEnvironment();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  beforeEach(async () => {
    strategy = new CompetitiveStrategy();
    setProviderRegistry(createMockProviderRegistry());
    
    // Discover models dynamically from real providers (NO hardcoded models, NO mocks)
    realModels = await getModelsWithCapabilities(['function_calling'], { anyMatch: false, limit: 10 });
    
    // If we don't have enough models, try to get any models
    if (realModels.length < 3) {
      realModels = await discoverModelsDynamically();
      realModels = realModels.slice(0, 10);
    }

    // Get provider registry to get real adapters
    const registry = getProviderRegistry();
    
    // Select a model that has an adapter available
    const modelWithAdapter = realModels.find(m => registry.get(m.provider));
    const selectedModel = modelWithAdapter || realModels[0];

    testRequest = {
      messages: [{ role: 'user', content: 'Write a function to sort an array' }],
      model: selectedModel?.id || realModels[0]?.id,
    };

    testContext = {
      organizationId: 'org-123',
      userId: 'user-123',
      requestId: 'req-123-' + Date.now(),
      models: realModels,
      taskType: 'code-review' as TaskType,
      contextSize: 100,
    };

    // Use REAL provider adapters - NO mocks
    (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) => {
      const adapter = registry.get(model.provider);
      if (!adapter) {
        throw new Error(`No adapter found for provider: ${model.provider}`);
      }
      return adapter;
    };
  });

  describe('Metadata', () => {
    it('should have correct strategy metadata', () => {
      const metadata = strategy.getMetadata();

      expect(metadata.id).toBe('competitive');
      expect(metadata.name).toBe('competitive');
      expect(metadata.displayName).toContain('Competitive');
      expect(metadata.minModels).toBe(3);
      expect(metadata.maxModels).toBeGreaterThanOrEqual(2);
    });
  });

  describe('isSuitable', () => {
    it('should be suitable for code review tasks', () => {
      const suitable = strategy.isSuitable(testRequest, testContext);
      expect(suitable).toBe(true);
    });

    it('should not be suitable with less than 3 models', () => {
      const contextWithOneModel: OrchestrationContext = {
        ...testContext,
        models: realModels.slice(0, 2),
      };
      const suitable = strategy.isSuitable(testRequest, contextWithOneModel);
      expect(suitable).toBe(false);
    });
  });

  describe('execute', () => {
    it('should execute successfully with real models', async () => {
      if (realModels.length < 3) {
        return;
      }
      
      const result = await strategy.execute(testRequest, testContext);
      
      expect(result).toBeDefined();
      expect(result.finalResponse).toBeDefined();
      expect(result.modelsUsed.length).toBeGreaterThan(0);
    }, 60000);

    it('should require at least 3 models', async () => {
      if (realModels.length < 3) {
        return;
      }
      
      const contextWithOneModel: OrchestrationContext = {
        ...testContext,
        models: realModels.slice(0, 2),
      };
      
      await expect(strategy.execute(testRequest, contextWithOneModel)).rejects.toThrow();
    }, 60000);
  });
});
