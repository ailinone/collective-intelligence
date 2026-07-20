// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test Model Helper
 * 
 * Utility functions to get models dynamically in tests - NO hardcoded models
 * ALL models must come from dynamic discovery - NO exceptions
 */

import type { Model } from '@/types';
import { discoverModelsDynamically, discoverModelsForProvider, getModelsWithCapabilities, ensureModelsDiscovered } from './dynamic-model-discovery';

// Cache models per test run to avoid repeated discovery
let cachedModels: Model[] | null = null;
let modelsCacheInitialized = false;

export { ensureModelsDiscovered };

/**
 * Initialize model cache for tests
 * Call this in beforeAll hooks
 */
export async function initializeTestModels(): Promise<void> {
  if (!modelsCacheInitialized) {
    await ensureModelsDiscovered();
    cachedModels = await discoverModelsDynamically();
    modelsCacheInitialized = true;
  }
}

/**
 * Get a model for testing from dynamic discovery
 * Returns null if no models available
 * NEVER uses hardcoded model names
 */
export async function getTestModel(providerName?: string): Promise<Model | null> {
  await initializeTestModels();
  
  try {
    const models = providerName
      ? await discoverModelsForProvider(providerName)
      : cachedModels || await discoverModelsDynamically();
    
    if (models.length === 0) {
      return null;
    }
    
    return models[0];
  } catch {
    return null;
  }
}

/**
 * Get multiple models for testing from dynamic discovery
 * NEVER uses hardcoded model names
 */
export async function getTestModels(count: number, providerName?: string): Promise<Model[]> {
  await initializeTestModels();
  
  try {
    const models = providerName
      ? await discoverModelsForProvider(providerName)
      : cachedModels || await discoverModelsDynamically();
    
    return models.slice(0, count);
  } catch {
    return [];
  }
}

/**
 * Get a model with specific capabilities for testing
 * NEVER uses hardcoded model names
 */
export async function getTestModelWithCapabilities(
  capabilities: string[],
  providerName?: string
): Promise<Model | null> {
  await initializeTestModels();
  
  try {
    const models = await getModelsWithCapabilities(capabilities, { anyMatch: false, limit: 10 });
    
    if (providerName) {
      const filtered = models.filter(m => m.provider === providerName);
      return filtered.length > 0 ? filtered[0] : null;
    }
    
    return models.length > 0 ? models[0] : null;
  } catch {
    return null;
  }
}

/**
 * Get a model ID for testing (returns empty string if no model available)
 * This is safe to use in test requests
 * NEVER uses hardcoded model names
 */
export async function getTestModelId(providerName?: string): Promise<string> {
  const model = await getTestModel(providerName);
  return model?.id || '';
}

/**
 * Create a ChatRequest with a dynamically discovered model
 * NEVER uses hardcoded model names
 */
export async function createTestChatRequest(
  messages: Array<{ role: string; content: string }>,
  providerName?: string,
  options?: Partial<{ modelId: string; tools: unknown[]; temperature: number }>
): Promise<{ model: string; messages: Array<{ role: string; content: string }>; tools?: unknown[]; temperature?: number }> {
  const modelId = options?.modelId || await getTestModelId(providerName);
  
  if (!modelId) {
    throw new Error('No models available from dynamic discovery - cannot create test request');
  }
  
  return {
    model: modelId,
    messages,
    ...(options?.tools && { tools: options.tools }),
    ...(options?.temperature !== undefined && { temperature: options.temperature }),
  };
}
