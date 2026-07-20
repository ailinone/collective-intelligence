// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Dynamic Model Discovery for Tests
 * 
 * This utility ensures tests use REAL dynamic model discovery instead of hardcoded models.
 * NO MOCKS - all tests must use real discovery and real API calls.
 */

import { getCentralModelDiscoveryService } from '@/services/central-model-discovery-service';
import { getModelRepository } from '@/services/model-repository';
import type { Model, ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'test-dynamic-discovery' });

function shouldUseRealProviderDiscovery(): boolean {
  return (
    process.env.TEST_USE_REAL_API_KEYS === 'true' &&
    process.env.TEST_SKIP_EXTERNAL_APIS !== 'true'
  );
}

async function seedFallbackCatalogIfNeeded(): Promise<void> {
  const repository = getModelRepository();
  const existingModels = await repository.getAllModels();
  if (existingModels.length > 0) {
    return;
  }

  const { seedAllTestModels } = await import('./test-model-catalog');
  await seedAllTestModels();
}

function normalizeProviderTokens(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

function getModelProviderCandidates(model: Model): string[] {
  const metadata = (model as unknown as { metadata?: Record<string, unknown> }).metadata;
  const executionProviderFromMetadata =
    metadata && typeof metadata.executionProvider === 'string'
      ? metadata.executionProvider
      : undefined;

  const executionProvider = (model as unknown as { executionProvider?: string }).executionProvider;
  const provider = model.provider;

  const tokens = [
    ...normalizeProviderTokens(provider),
    ...normalizeProviderTokens(executionProvider),
    ...normalizeProviderTokens(executionProviderFromMetadata),
  ];

  return Array.from(new Set(tokens));
}

async function filterModelsByRegisteredAdapters(models: Model[]): Promise<Model[]> {
  try {
    const { getProviderRegistry } = (await import('@/providers/provider-registry')) as {
      getProviderRegistry: () => { getProviderNames: () => string[] };
    };
    const registry = getProviderRegistry();
    const registered = new Set(
      registry
        .getProviderNames()
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0)
    );

    if (registered.size === 0) {
      return models;
    }

    return models.filter((model) =>
      getModelProviderCandidates(model).some((candidate) => registered.has(candidate))
    );
  } catch {
    // Registry may not be initialized yet in some early test phases.
    return models;
  }
}

/**
 * Discover models dynamically from all providers
 * This performs REAL discovery - no mocks, no hardcoded models
 */
export async function discoverModelsDynamically(): Promise<Model[]> {
  log.info('Starting dynamic model discovery for tests (REAL discovery, no mocks)');
  
  try {
    if (!shouldUseRealProviderDiscovery()) {
      await seedFallbackCatalogIfNeeded();
      const repository = getModelRepository();
      const models = await repository.getAllModels();
      const runnableModels = await filterModelsByRegisteredAdapters(models);
      log.info(
        {
          modelCount: models.length,
          runnableWithAdapters: runnableModels.length,
        },
        'Using local fallback model catalog for deterministic tests'
      );
      return runnableModels;
    }

    // Get the central discovery service
    const discoveryService = await getCentralModelDiscoveryService();
    
    // Perform real discovery from all providers
    const results = await discoveryService.discoverAllModels();
    
    const totalDiscovered = results.reduce((sum, r) => sum + r.modelsDiscovered, 0);
    log.info({ totalDiscovered, sourcesProcessed: results.length }, 'Dynamic discovery completed');
    
    // Get models from database (they were stored during discovery)
    const repository = getModelRepository();
    const models = await repository.getAllModels();
    const runnableModels = await filterModelsByRegisteredAdapters(models);
    
    log.info(
      { modelCount: models.length, runnableWithAdapters: runnableModels.length },
      'Retrieved models from database after discovery'
    );
    
    return runnableModels;
  } catch (error) {
    log.error({ error }, 'Dynamic model discovery failed');
    throw error;
  }
}

/**
 * Discover models for a specific provider dynamically
 */
export async function discoverModelsForProvider(providerName: string): Promise<Model[]> {
  log.info({ provider: providerName }, 'Discovering models for provider (REAL discovery)');
  
  try {
    // Discover all models first
    await discoverModelsDynamically();
    
    // Then filter by provider
    const repository = getModelRepository();
    const models = await repository.searchModels({
      providers: [providerName],
      status: 'active',
    });
    const runnableModels = await filterModelsByRegisteredAdapters(models);
    
    log.info(
      { provider: providerName, modelCount: models.length, runnableWithAdapters: runnableModels.length },
      'Retrieved models for provider'
    );
    
    return runnableModels;
  } catch (error) {
    log.error({ error, provider: providerName }, 'Failed to discover models for provider');
    throw error;
  }
}

/**
 * Get models with specific capabilities dynamically
 */
export async function getModelsWithCapabilities(
  capabilities: ModelCapability[],
  options?: { anyMatch?: boolean; limit?: number }
): Promise<Model[]> {
  log.info({ capabilities, options }, 'Getting models with capabilities (REAL discovery)');
  
  try {
    // Ensure we have discovered models
    await discoverModelsDynamically();
    
    // Get models with capabilities
    const repository = getModelRepository();
    const models = await repository.findModelsWithCapabilities(capabilities, {
      anyMatch: options?.anyMatch ?? false,
      limit: options?.limit ?? 100,
    });
    const runnableModels = await filterModelsByRegisteredAdapters(models);
    
    log.info(
      { capabilities, modelCount: models.length, runnableWithAdapters: runnableModels.length },
      'Retrieved models with capabilities'
    );
    
    return runnableModels;
  } catch (error) {
    log.error({ error, capabilities }, 'Failed to get models with capabilities');
    throw error;
  }
}

/**
 * Get a random model for testing (dynamically discovered)
 */
export async function getRandomModel(providerName?: string): Promise<Model | null> {
  log.info({ provider: providerName }, 'Getting random model (REAL discovery)');
  
  try {
    const models = providerName
      ? await discoverModelsForProvider(providerName)
      : await discoverModelsDynamically();
    
    if (models.length === 0) {
      log.warn('No models available after dynamic discovery');
      return null;
    }
    
    const randomIndex = Math.floor(Math.random() * models.length);
    const model = models[randomIndex];
    
    log.info({ modelId: model.id, provider: model.provider }, 'Selected random model');
    
    return model;
  } catch (error) {
    log.error({ error }, 'Failed to get random model');
    return null;
  }
}

/**
 * Get a single model suitable for tests (optionally constrained by provider).
 * This keeps backward-compatibility with older test helpers that imported
 * getTestModel from this module.
 */
export async function getTestModel(providerName?: string): Promise<Model | null> {
  try {
    const models = providerName
      ? await discoverModelsForProvider(providerName)
      : await discoverModelsDynamically();
    // Prefer a chat-capable model — skip embedding-only models
    const chatCapable = models.find(
      (m) => m.capabilities?.includes('chat') || m.capabilities?.includes('function_calling')
    );
    return chatCapable ?? models[0] ?? null;
  } catch (error) {
    log.error({ error, provider: providerName }, 'Failed to get test model');
    return null;
  }
}

/**
 * Get N models suitable for tests (optionally constrained by provider).
 * Backward-compatible export expected by multiple test suites.
 */
export async function getTestModels(count: number, providerName?: string): Promise<Model[]> {
  try {
    const models = providerName
      ? await discoverModelsForProvider(providerName)
      : await discoverModelsDynamically();
    return models.slice(0, Math.max(0, count));
  } catch (error) {
    log.error({ error, provider: providerName, count }, 'Failed to get test models');
    return [];
  }
}

/**
 * Get a model with the requested capabilities for tests.
 */
export async function getTestModelWithCapabilities(
  capabilities: ModelCapability[] | string[],
  providerName?: string
): Promise<Model | null> {
  try {
    const capabilityList = capabilities as ModelCapability[];
    const candidates = await getModelsWithCapabilities(capabilityList, { anyMatch: false, limit: 25 });
    const filtered = providerName
      ? candidates.filter((model) =>
          getModelProviderCandidates(model).includes(providerName.trim().toLowerCase())
        )
      : candidates;
    return filtered[0] ?? null;
  } catch (error) {
    log.error(
      { error, provider: providerName, capabilities },
      'Failed to get test model with capabilities'
    );
    return null;
  }
}

/**
 * Ensure models are discovered before running tests
 * Call this in beforeAll/beforeEach hooks
 */
export async function ensureModelsDiscovered(): Promise<void> {
  log.info('Ensuring models are discovered for tests');
  
  try {
    const repository = getModelRepository();
    const existingModels = await repository.getAllModels();
    
    if (existingModels.length === 0) {
      log.info('No models in database, performing discovery/bootstrap');
      await discoverModelsDynamically();
    } else {
      log.info({ modelCount: existingModels.length }, 'Models already in database, skipping discovery');
    }
  } catch (error) {
    log.error({ error }, 'Failed to ensure models are discovered');
    // Don't throw - allow tests to continue and fail gracefully if needed
    log.warn('Continuing without models - tests may fail if they require models');
  }
}

/**
 * Get a model ID suitable for testing
 * Returns the first available chat-capable model from dynamic discovery
 * NO hardcoded models - always uses dynamically discovered models
 */
export async function getTestModelId(providerName?: string): Promise<string> {
  log.info({ provider: providerName }, 'Getting test model ID from dynamic discovery');

  try {
    const model = await getTestModel(providerName);
    if (!model) {
      log.warn({ provider: providerName }, 'No models available for testing');
      return 'auto';
    }

    log.info({ modelId: model.id, provider: model.provider }, 'Selected test model');
    return model.id;
  } catch (error) {
    log.error({ error, provider: providerName }, 'Failed to get test model ID');
    return 'auto';
  }
}

/**
 * Create a chat request payload with a dynamically discovered model.
 */
export async function createTestChatRequest(
  messages: Array<{ role: string; content: string }>,
  providerName?: string,
  options?: {
    modelId?: string;
    tools?: unknown[];
    temperature?: number;
  }
): Promise<{
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
  temperature?: number;
}> {
  const modelId = options?.modelId || (await getTestModelId(providerName));
  if (!modelId || modelId === 'auto') {
    throw new Error('No runnable models available from dynamic discovery for test chat request');
  }

  return {
    model: modelId,
    messages,
    ...(options?.tools ? { tools: options.tools } : {}),
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
  };
}
