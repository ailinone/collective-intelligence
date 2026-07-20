// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider Model Fetcher Interface
 *
 * Interface for dynamically fetching models from provider APIs.
 * This replaces hardcoded model lists with dynamic discovery.
 */

import type { ModelCapability } from '@/types';
import { inferModelCapabilities } from '@/services/model-capability-inference';
import { inferEndpoint } from '@/capability/endpoint-inference';

// Re-export ModelCapability for convenience
export type { ModelCapability };

/**
 * Model metadata structure from provider API
 */
export interface ModelMetadata {
  endpoint?: string;
  tools?: string[];
  supportedEndpoints?: string[];
  capabilities?: string[];
  description?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  supported_parameters?: string[];
  tier?: string;
  family?: string;
  [key: string]: unknown;
}

/**
 * Provider model structure (from provider API)
 */
export interface ProviderModel {
  id: string;
  name: string;
  displayName?: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: ModelCapability[];
  pricing: {
    inputCostPer1M: number;
    outputCostPer1M: number;
    currency?: string;
  };
  performance?: {
    latencyMs: number;
    throughput: number;
    quality: number;
    reliability: number;
  };
  metadata?: ModelMetadata;
}

/**
 * Interface for fetching models from provider APIs
 */
export interface ProviderModelFetcher {
  /**
   * Get all available models from the provider
   * Should fetch from provider API when available
   * Returns empty array if API is not available or fails
   */
  getModels(): Promise<ProviderModel[]>;

  /**
   * Get detailed metadata for a specific model
   * Optional - can return null if not available
   */
  getModelMetadata?(modelId: string): Promise<ModelMetadata | null>;

  /**
   * Get provider name
   */
  getProviderName(): string;
}

/**
 * Base class for provider model fetchers
 * Provides common functionality and fallback handling
 */
export abstract class BaseProviderModelFetcher implements ProviderModelFetcher {
  protected abstract providerName: string;

  abstract getModels(): Promise<ProviderModel[]>;

  getModelMetadata?(_modelId: string): Promise<ModelMetadata | null> {
    return Promise.resolve(null);
  }

  getProviderName(): string {
    return this.providerName;
  }

  /**
   * Determine endpoint based on model capabilities and metadata.
   * Delegates to the shared `inferEndpoint` heuristic so the same rule
   * applies in the discovery-service normalization path.
   */
  protected determineEndpoint(model: ProviderModel): string {
    return inferEndpoint(model.capabilities, model.metadata);
  }

  /**
   * Extract tools from model metadata and capabilities
   */
  protected extractTools(model: ProviderModel): string[] {
    // 1. Check metadata for tools
    if (model.metadata?.tools && Array.isArray(model.metadata.tools)) {
      return model.metadata.tools;
    }

    // 2. Infer from capabilities
    const tools: string[] = [];
    if (model.capabilities.includes('web_search')) {
      tools.push('web_search');
    }
    if (model.capabilities.includes('code_interpreter')) {
      tools.push('code_interpreter');
    }
    if (model.capabilities.includes('file_search')) {
      tools.push('file_search');
    }
    if (model.capabilities.includes('mcp')) {
      tools.push('mcp');
    }

    return tools;
  }

  /**
   * Extract capabilities from model metadata
   * Prioritizes API metadata over heuristics
   */
  protected extractCapabilities(metadata?: ModelMetadata, modelId?: string): ModelCapability[] {
    return inferModelCapabilities({
      modelId,
      metadata,
      seedCapabilities: metadata?.capabilities,
    });
  }
}
