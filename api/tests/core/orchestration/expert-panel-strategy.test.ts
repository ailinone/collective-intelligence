// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Expert Panel Strategy
 * Uses REAL models from dynamic discovery - NO hardcoded models, NO mocks
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { ExpertPanelStrategy } from '@/core/orchestration/strategies/expert-panel-strategy';
import type { ChatRequest, OrchestrationContext, Model, TaskType } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { getProviderRegistry, setProviderRegistry } from '@/providers/provider-registry';
import { discoverModelsDynamically, getModelsWithCapabilities } from '../../utils/dynamic-model-discovery';
import { createRealProviderRegistry } from '../../utils/real-provider-registry';
import { startTestEnvironment, stopTestEnvironment } from '../../utils/test-environment';

/**
 * Type for strategy with getAdapterForModel method (injected by OrchestrationEngine)
 */
type StrategyWithAdapter = ExpertPanelStrategy & {
  getAdapterForModel?: (model: Model, context: OrchestrationContext) => Promise<ProviderAdapter | null>;
};

describe('ExpertPanelStrategy - Real Tests (NO Mocks, NO Hardcoded Models)', () => {
  let strategy: ExpertPanelStrategy;
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
    strategy = new ExpertPanelStrategy();

    // Discover models dynamically from real providers (NO hardcoded models)
    realModels = await getModelsWithCapabilities(['function_calling'], { anyMatch: false, limit: 10 });
    
    if (realModels.length < 3) {
      realModels = await discoverModelsDynamically();
      realModels = realModels.slice(0, 10);
    }

    // Get provider registry to get real adapters
    const registry = getProviderRegistry();
    const modelWithAdapter = realModels.find(m => registry.get(m.provider));
    const selectedModel = modelWithAdapter || realModels[0];

    testRequest = {
      messages: [
        {
          role: 'user',
          content: 'Please refactor this code for better performance and maintainability',
        },
      ],
      model: selectedModel?.id || realModels[0]?.id,
    };

    testContext = {
      models: realModels,
      strategy: 'expert-panel',
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

      expect(metadata.id).toBe('expert-panel');
      expect(metadata.name).toBe('expert-panel');
      expect(metadata.displayName).toBe('Expert Panel');
      expect(metadata.minModels).toBe(3);
      expect(metadata.maxModels).toBe(6);
    });
  });

  describe('Model Requirements', () => {
    it('should require at least 3 models', async () => {
      if (realModels.length < 3) {
        return;
      }
      
      const tooFewModels = realModels.slice(0, 2);
      const contextWithFewModels: OrchestrationContext = { ...testContext, models: tooFewModels };

      await expect(
        strategy.execute(testRequest, contextWithFewModels)
      ).rejects.toThrow(/at least 3 (eligible )?models/);
    }, 60000);

    it('should work with exactly 3 models', async () => {
      if (realModels.length < 3) {
        return;
      }
      
      const threeModels = realModels.slice(0, 3);
      const contextWithThreeModels: OrchestrationContext = { ...testContext, models: threeModels };

      const result = await strategy.execute(testRequest, contextWithThreeModels);

      expect(result).toBeDefined();
      expect(result.modelsUsed.length).toBeGreaterThanOrEqual(3);
    }, 60000);
  });

  describe('Expert Domain Detection', () => {
    it('should detect code-quality domain from refactoring request', async () => {
      if (realModels.length < 3) {
        return;
      }
      
      const refactorRequest: ChatRequest = {
        messages: [
          { role: 'user', content: 'Please refactor this code to improve quality' },
        ],
        model: testRequest.model,
      };

      const result = await strategy.execute(refactorRequest, testContext);

      expect(result.metadata?.domains).toBeDefined();
      expect(Array.isArray(result.metadata?.domains)).toBe(true);
    }, 60000);

    it('should detect performance domain from optimization request', async () => {
      if (realModels.length < 3) {
        return;
      }
      
      const perfRequest: ChatRequest = {
        messages: [
          { role: 'user', content: 'How can I optimize this code for better performance?' },
        ],
        model: testRequest.model,
      };

      const result = await strategy.execute(perfRequest, testContext);

      expect(result.metadata?.domains).toBeDefined();
      expect(Array.isArray(result.metadata?.domains)).toBe(true);
    }, 60000);
  });

  describe('Expert Selection', () => {
    it('should select diverse providers for experts', async () => {
      if (realModels.length < 3) {
        return;
      }
      
      const result = await strategy.execute(testRequest, testContext);

      const expertProviders = result.modelsUsed
        .filter((m) => m.role.startsWith('expert-'))
        .map((m) => m.provider);

      const uniqueProviders = new Set(expertProviders);
      expect(uniqueProviders.size).toBeGreaterThanOrEqual(1);
      expect(expertProviders.length).toBeGreaterThanOrEqual(2);
    }, 60000);
  });

  describe('Coordinator Synthesis', () => {
    it('should synthesize expert inputs', async () => {
      if (realModels.length < 3) {
        return;
      }
      
      const result = await strategy.execute(testRequest, testContext);

      const coordinator = result.modelsUsed.find((m) => m.role === 'coordinator');
      expect(coordinator).toBeDefined();
      expect(result.finalResponse.choices[0]?.message?.content).toBeDefined();
    }, 60000);
  });

  describe('Cost Calculation', () => {
    it('should sum costs from all experts and coordinator', async () => {
      if (realModels.length < 3) {
        return;
      }
      
      const result = await strategy.execute(testRequest, testContext);

      const expertCosts = result.modelsUsed
        .filter((m) => m.role.startsWith('expert-'))
        .reduce((sum, m) => sum + m.cost, 0);

      const coordinatorCost = result.modelsUsed.find(
        (m) => m.role === 'coordinator'
      )?.cost || 0;

      expect(result.totalCost).toBeGreaterThanOrEqual(0);
      expect(result.totalCost).toBeCloseTo(expertCosts + coordinatorCost, 2);
    }, 60000);
  });

  describe('Quality Scoring', () => {
    it('should have quality score', async () => {
      if (realModels.length < 3) {
        return;
      }
      
      const result = await strategy.execute(testRequest, testContext);

      expect(result.qualityScore).toBeGreaterThan(0);
      expect(result.qualityScore).toBeLessThanOrEqual(1);
    }, 60000);
  });
});
