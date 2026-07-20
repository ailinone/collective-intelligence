// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Adaptive & Contextual Strategies
 * Uses REAL models from dynamic discovery - NO hardcoded models, NO mocks
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { AdaptiveStrategy } from '@/core/orchestration/strategies/adaptive-strategy';
import { ContextualStrategy } from '@/core/orchestration/strategies/contextual-strategy';
import type { ChatRequest, OrchestrationContext, Model, TaskType } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { getProviderRegistry, setProviderRegistry } from '@/providers/provider-registry';
import { discoverModelsDynamically, getModelsWithCapabilities } from '../../utils/dynamic-model-discovery';
import { createRealProviderRegistry } from '../../utils/real-provider-registry';
import { startTestEnvironment, stopTestEnvironment } from '../../utils/test-environment';

/**
 * Type for strategy with getAdapterForModel method (injected by OrchestrationEngine)
 */
type StrategyWithAdapter = (AdaptiveStrategy | ContextualStrategy) & {
  getAdapterForModel?: (model: Model, context: OrchestrationContext) => Promise<ProviderAdapter | null>;
};

describe('Adaptive & Contextual Strategies - Real Tests (NO Mocks, NO Hardcoded Models)', () => {
  let testContext: OrchestrationContext;
  let testRequest: ChatRequest;
  let realModels: Model[];

  beforeAll(async () => {
    await startTestEnvironment();
    const providerRegistry = await createRealProviderRegistry();
    setProviderRegistry(providerRegistry);
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  beforeEach(async () => {
    // Discover models dynamically from real providers (NO hardcoded models, NO mocks)
    realModels = await getModelsWithCapabilities(['function_calling'], { anyMatch: false, limit: 10 });
    
    // If we don't have enough models, try to get any models
    if (realModels.length < 2) {
      realModels = await discoverModelsDynamically();
      realModels = realModels.slice(0, 10);
    }

    // Get provider registry to get real adapters
    const registry = getProviderRegistry();
    
    // Select a model that has an adapter available
    const modelWithAdapter = realModels.find(m => registry.get(m.provider));
    const selectedModel = modelWithAdapter || realModels[0];

    testRequest = {
      messages: [{ role: 'user', content: 'Write a function' }],
      model: selectedModel?.id || realModels[0]?.id,
    };

    testContext = {
      models: realModels,
      strategy: 'adaptive',
      requestId: 'test-' + Date.now(),
      userId: 'test',
      organizationId: 'test',
      taskType: 'code_generation' as TaskType,
      contextSize: 1000,
    };
  });

  describe('AdaptiveStrategy', () => {
    let strategy: AdaptiveStrategy;

    beforeEach(() => {
      strategy = new AdaptiveStrategy();
      // Use REAL provider adapters - NO mocks
      const registry = getProviderRegistry();
      (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) => {
        const adapter = registry.get(model.provider);
        if (!adapter) {
          throw new Error(`No adapter found for provider: ${model.provider}`);
        }
        return adapter;
      };
    });

    it('should have correct metadata', () => {
      const metadata = strategy.getMetadata();
      expect(metadata.id).toBe('adaptive');
    });

    it('should execute successfully with real models', async () => {
      if (realModels.length < 2) {
        return;
      }
      
      const result = await strategy.execute(testRequest, testContext);
      expect(result).toBeDefined();
      expect(result.finalResponse).toBeDefined();
    }, 60000);
  });

  describe('ContextualStrategy', () => {
    let strategy: ContextualStrategy;

    beforeEach(() => {
      strategy = new ContextualStrategy();
      // Use REAL provider adapters - NO mocks
      const registry = getProviderRegistry();
      (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) => {
        const adapter = registry.get(model.provider);
        if (!adapter) {
          throw new Error(`No adapter found for provider: ${model.provider}`);
        }
        return adapter;
      };
    });

    it('should have correct metadata', () => {
      const metadata = strategy.getMetadata();
      expect(metadata.id).toBe('contextual');
    });

    it('should execute successfully with real models', async () => {
      if (realModels.length < 2) {
        return;
      }
      
      const result = await strategy.execute(testRequest, testContext);
      expect(result).toBeDefined();
      expect(result.finalResponse).toBeDefined();
    }, 60000);
  });
});
