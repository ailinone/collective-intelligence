// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Quality Multi-Pass Strategy
 * Uses REAL models from dynamic discovery - NO hardcoded models, NO mocks
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { QualityMultiPassStrategy } from '@/core/orchestration/strategies/quality-multipass-strategy';
import type { ChatRequest, OrchestrationContext, Model, TaskType } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { getProviderRegistry, setProviderRegistry } from '@/providers/provider-registry';
import { discoverModelsDynamically, getModelsWithCapabilities } from '../../utils/dynamic-model-discovery';
import { createRealProviderRegistry } from '../../utils/real-provider-registry';
import { startTestEnvironment, stopTestEnvironment } from '../../utils/test-environment';

/**
 * Type for strategy with getAdapterForModel method (injected by OrchestrationEngine)
 */
type StrategyWithAdapter = QualityMultiPassStrategy & {
  getAdapterForModel?: (model: Model, context: OrchestrationContext) => Promise<ProviderAdapter | null>;
};

describe('QualityMultiPassStrategy - Real Tests (NO Mocks, NO Hardcoded Models)', () => {
  let strategy: QualityMultiPassStrategy;
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
    strategy = new QualityMultiPassStrategy();

    // Discover models dynamically from real providers (NO hardcoded models)
    realModels = await getModelsWithCapabilities(['function_calling'], { anyMatch: false, limit: 10 });
    
    if (realModels.length < 2) {
      realModels = await discoverModelsDynamically();
      realModels = realModels.slice(0, 10);
    }

    // Get provider registry to get real adapters
    const registry = getProviderRegistry();
    const modelWithAdapter = realModels.find(m => registry.get(m.provider));
    const selectedModel = modelWithAdapter || realModels[0];

    testRequest = {
      messages: [{ role: 'user', content: 'Write a high-quality authentication function' }],
      model: selectedModel?.id || realModels[0]?.id,
    };

    testContext = {
      models: realModels,
      strategy: 'quality-multipass',
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
    it('should have correct strategy metadata', () => {
      const metadata = strategy.getMetadata();
      expect(metadata.id).toBe('quality-multipass');
      expect(metadata.name).toBe('quality-multipass');
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
  });
});
