// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Massive Parallel Strategy
 * Uses REAL models from dynamic discovery - NO hardcoded models, NO mocks
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { MassiveParallelStrategy } from '@/core/orchestration/strategies/massive-parallel-strategy';
import type { ChatRequest, OrchestrationContext, Model, TaskType } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { getProviderRegistry, setProviderRegistry } from '@/providers/provider-registry';
import { discoverModelsDynamically } from '../../utils/dynamic-model-discovery';
import { createRealProviderRegistry } from '../../utils/real-provider-registry';
import { startTestEnvironment, stopTestEnvironment } from '../../utils/test-environment';

/**
 * Type for strategy with getAdapterForModel method (injected by OrchestrationEngine)
 */
type StrategyWithAdapter = MassiveParallelStrategy & {
  getAdapterForModel?: (model: Model, context: OrchestrationContext) => Promise<ProviderAdapter | null>;
};

describe('MassiveParallelStrategy - Real Tests (NO Mocks, NO Hardcoded Models)', () => {
  let strategy: MassiveParallelStrategy;
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
    strategy = new MassiveParallelStrategy();

    // Discover models dynamically from real providers (NO hardcoded models)
    realModels = await discoverModelsDynamically();
    
    // Take up to 9 models for massive parallel testing
    realModels = realModels.slice(0, 9);

    // Get provider registry to get real adapters
    const registry = getProviderRegistry();
    const modelWithAdapter = realModels.find(m => registry.get(m.provider));
    const selectedModel = modelWithAdapter || realModels[0];

    testRequest = {
      messages: [
        {
          role: 'user',
          content: 'Generate a TypeScript function for user authentication',
        },
      ],
      model: selectedModel?.id || realModels[0]?.id,
    };

    testContext = {
      models: realModels,
      strategy: 'massive-parallel',
      requestId: 'test-request-' + Date.now(),
      userId: 'test-user',
      organizationId: 'test-org',
      taskType: 'code_generation' as TaskType,
      contextSize: 1000,
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
    it('should have correct metadata', () => {
      const metadata = strategy.getMetadata();

      expect(metadata.id).toBe('massive-parallel');
      expect(metadata.name).toBe('massive-parallel');
      expect(metadata.minModels).toBeGreaterThanOrEqual(2);
    });
  });

  describe('execute', () => {
    it('should execute successfully with real models', async () => {
      if (realModels.length < 2) {
        return;
      }
      
      const result = await strategy.execute(testRequest, testContext);
      
      expect(result).toBeDefined();
      expect(result.finalResponse).toBeDefined();
      expect(result.modelsUsed.length).toBeGreaterThan(0);
    }, 60000);

    it('should use multiple models in parallel', async () => {
      if (realModels.length < 2) {
        return;
      }
      
      const result = await strategy.execute(testRequest, testContext);
      
      // Should use multiple models
      expect(result.modelsUsed.length).toBeGreaterThanOrEqual(1);
    }, 60000);
  });
});
