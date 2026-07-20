// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { HierarchicalStrategy } from '@/core/orchestration/strategies/hierarchical-strategy';
import { ConsensusStrategy } from '@/core/orchestration/strategies/consensus-strategy';
import { ReinforcementStrategy } from '@/core/orchestration/strategies/reinforcement-strategy';
import type { ChatRequest, OrchestrationContext, Model, TaskType } from '@/types';
import { getProviderRegistry, setProviderRegistry } from '@/providers/provider-registry';
import { discoverModelsDynamically, getModelsWithCapabilities } from '../../utils/dynamic-model-discovery';
import { createRealProviderRegistry } from '../../utils/real-provider-registry';
import { startTestEnvironment, stopTestEnvironment } from '../../utils/test-environment';

/**
 * Type for strategy with getAdapterForModel method (injected by OrchestrationEngine)
 */
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

type StrategyWithAdapter = (HierarchicalStrategy | ConsensusStrategy | ReinforcementStrategy) & {
  getAdapterForModel?: (model: Model, context: OrchestrationContext) => Promise<ProviderAdapter | null>;
};

describe('Hierarchical, Consensus & Reinforcement Strategies', () => {
  let testContext: OrchestrationContext;
  let testRequest: ChatRequest;
  let realModels: Model[];

  beforeAll(async () => {
    await startTestEnvironment();
    const providerRegistry = await createRealProviderRegistry();
    setProviderRegistry(providerRegistry);
  });

  beforeEach(async () => {
    // Discover models dynamically from real providers (NO hardcoded models, NO mocks)
    realModels = await getModelsWithCapabilities(['function_calling'], { anyMatch: false, limit: 10 });
    
    // If we don't have enough models, try to get any models
    if (realModels.length < 2) {
      realModels = await discoverModelsDynamically();
      // Take first 10 models
      realModels = realModels.slice(0, 10);
    }

    // Get provider registry to get real adapters
    const registry = getProviderRegistry();
    
    // Select a model that has an adapter available
    const modelWithAdapter = realModels.find(m => registry.get(m.provider));
    const selectedModel = modelWithAdapter || realModels[0];

    testRequest = {
      messages: [{ role: 'user', content: 'Analyze this code' }],
      model: selectedModel?.id || realModels[0]?.id,
    };

    testContext = {
      models: realModels,
      strategy: 'hierarchical',
      requestId: 'test-' + Date.now(),
      userId: 'test',
      organizationId: 'test',
      taskType: 'code_generation' as TaskType,
      contextSize: 1000,
    };
  });

  describe('HierarchicalStrategy', () => {
    let strategy: HierarchicalStrategy;

    beforeEach(() => {
      strategy = new HierarchicalStrategy();
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
      expect(metadata.id).toBe('hierarchical');
    });

    it('should require at least 2 models', async () => {
      if (realModels.length < 2) {
        // Skip if we don't have enough models
        return;
      }
      const oneModel = realModels.slice(0, 1);
      const contextWithOneModel: OrchestrationContext = { ...testContext, models: oneModel };
      await expect(
        strategy.execute(testRequest, contextWithOneModel)
      ).rejects.toThrow('at least 2 models');
    }, 60000); // Longer timeout for real API calls

    it('should execute successfully with real models', async () => {
      if (realModels.length < 2) {
        // Skip if we don't have enough models
        return;
      }
      const result = await strategy.execute(testRequest, testContext);
      expect(result).toBeDefined();
      expect(result.finalResponse).toBeDefined();
    }, 60000); // Longer timeout for real API calls

    it('should include manager and workers in metadata', async () => {
      if (realModels.length < 2) {
        // Skip if we don't have enough models
        return;
      }
      const result = await strategy.execute(testRequest, testContext);
      expect(result.metadata?.manager).toBeDefined();
      expect(result.metadata?.workers).toBeDefined();
    }, 60000); // Longer timeout for real API calls
  });

  describe('ConsensusStrategy', () => {
    let strategy: ConsensusStrategy;

    beforeEach(() => {
      strategy = new ConsensusStrategy();
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
      expect(metadata.id).toBe('consensus');
    });

    it('should require at least 3 models', async () => {
      if (realModels.length < 3) {
        // Skip if we don't have enough models
        return;
      }
      const twoModels = realModels.slice(0, 2);
      const contextWithTwoModels: OrchestrationContext = { ...testContext, models: twoModels };
      await expect(
        strategy.execute(testRequest, contextWithTwoModels)
      ).rejects.toThrow(/at least 3 (eligible )?models/);
    }, 60000);

    it('should execute successfully with real models', async () => {
      if (realModels.length < 3) {
        // Skip if we don't have enough models
        return;
      }
      const result = await strategy.execute(testRequest, testContext);
      expect(result).toBeDefined();
      expect(result.finalResponse).toBeDefined();
    }, 60000);

    it('should include voting models in metadata', async () => {
      if (realModels.length < 3) {
        // Skip if we don't have enough models
        return;
      }
      const result = await strategy.execute(testRequest, testContext);
      expect(result.metadata?.votingModels).toBeDefined();
      expect(result.metadata?.consensusReached).toBe(true);
    }, 60000);
  });

  describe('ReinforcementStrategy', () => {
    let strategy: ReinforcementStrategy;

    beforeEach(() => {
      strategy = new ReinforcementStrategy();
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
      expect(metadata.id).toBe('reinforcement');
    });

    it('should require at least 2 models', async () => {
      if (realModels.length < 2) {
        // Skip if we don't have enough models
        return;
      }
      const oneModel = realModels.slice(0, 1);
      const contextWithOneModel: OrchestrationContext = { ...testContext, models: oneModel };
      await expect(
        strategy.execute(testRequest, contextWithOneModel)
      ).rejects.toThrow('at least 2 models');
    }, 60000);

    it('should execute successfully with real models', async () => {
      if (realModels.length < 2) {
        // Skip if we don't have enough models
        return;
      }
      const result = await strategy.execute(testRequest, testContext);
      expect(result).toBeDefined();
      expect(result.finalResponse).toBeDefined();
    }, 60000);

    it('should include RL metadata', async () => {
      if (realModels.length < 2) {
        // Skip if we don't have enough models
        return;
      }
      const result = await strategy.execute(testRequest, testContext);
      expect(result.metadata?.selectedModel).toBeDefined();
      expect(result.metadata?.selectionMethod).toBe('quality-weighted');
    }, 60000);
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });
});

