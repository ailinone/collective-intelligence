// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Anthropic Model Fetcher
 *
 * 100% Dynamic Model Discovery - No hardcoded models
 * Uses Anthropic API /v1/models endpoint for real-time model discovery
 * Reference: https://docs.anthropic.com/en/api/models-list
 */

// 100% Dynamic Discovery - No SDK dependency needed, using REST API directly
import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

/**
 * Anthropic Model Fetcher
 * 100% Dynamic - Fetches models from Anthropic API /v1/models endpoint
 */
export class AnthropicModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'anthropic';
  private apiKey: string;
  private baseUrl: string;
  private log = logger.child({ component: 'anthropic-fetcher' });

  constructor(apiKey: string, baseUrl?: string) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || 'https://api.anthropic.com';
    if (!this.apiKey) {
      this.log.warn('Anthropic API key not provided - returning empty model list');
    }
  }

  async getModels(): Promise<ProviderModel[]> {
    // Validate API key is not mock
    if (!this.apiKey || this.apiKey.includes('mock') || this.apiKey.includes('test-')) {
      this.log.warn(
        { keyPresent: Boolean(this.apiKey) },
        'Anthropic API key appears to be mock/test key - skipping model discovery'
      );
      return [];
    }

    // Sanitize API key - remove invalid characters that can't be in HTTP headers
    // This handles cases where keys from GCP may have newlines or other control characters
    const sanitizedApiKey = this.apiKey.trim().replace(/[\r\n\t]/g, '');
    if (sanitizedApiKey !== this.apiKey) {
      this.log.warn('API key contained invalid characters and was sanitized');
    }

    // Validate baseUrl
    if (!this.baseUrl || !this.baseUrl.startsWith('http')) {
      this.log.error({ baseUrl: this.baseUrl }, 'Invalid baseUrl for Anthropic API');
      return [];
    }

    try {
      // 100% Dynamic Discovery - Fetch from Anthropic API /v1/models
      // Reference: https://docs.anthropic.com/en/api/models-list
      const { default: fetch } = await import('node-fetch');
      const allModels: ProviderModel[] = [];
      let afterId: string | null = null;
      let hasMore = true;

      while (hasMore) {
        let url: URL;
        try {
          url = new URL(`${this.baseUrl}/v1/models`);
          if (afterId) {
            url.searchParams.set('after_id', afterId);
          }
          url.searchParams.set('limit', '100'); // Max limit
        } catch (urlError) {
          this.log.error(
            { baseUrl: this.baseUrl, error: urlError instanceof Error ? urlError.message : String(urlError) },
            'Failed to construct Anthropic API URL - invalid baseUrl or character encoding issue'
          );
          return [];
        }

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'x-api-key': sanitizedApiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          this.log.error(
            {
              status: response.status,
              statusText: response.statusText,
              error: errorText.substring(0, 500),
            },
            'Failed to fetch models from Anthropic API'
          );
          return [];
        }

        const data = (await response.json()) as {
          data?: Array<{
            id: string;
            display_name: string;
            created_at: string;
            type: 'model';
          }>;
          has_more?: boolean;
          last_id?: string;
        };

        if (!data.data || !Array.isArray(data.data)) {
          this.log.warn('Anthropic API returned invalid response format');
          break;
        }

        // Convert Anthropic models to ProviderModel format
        for (const anthropicModel of data.data) {
          try {
            const model = this.convertAnthropicModel(anthropicModel);
            if (model) {
              allModels.push(model);
            }
        } catch (error) {
            this.log.warn({ modelId: anthropicModel.id, error }, 'Failed to convert Anthropic model');
          }
        }

        // Check for next page
        hasMore = Boolean(data.has_more && data.last_id);
        afterId = data.last_id || null;
      }

      this.log.info({ count: allModels.length }, 'Successfully fetched models from Anthropic API');
      return allModels;
    } catch (error) {
      const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Handle ERR_INVALID_CHAR specifically
      if (errorCode === 'ERR_INVALID_CHAR') {
        this.log.error(
          {
            baseUrl: this.baseUrl,
            keyPresent: Boolean(this.apiKey),
            error: errorMessage,
          },
          'Failed to fetch models from Anthropic API - invalid character in URL or headers (ERR_INVALID_CHAR). Check baseUrl and API key encoding.'
        );
      } else {
        this.log.error(
          {
            error: errorMessage,
            errorCode,
            baseUrl: this.baseUrl,
          },
          'Failed to fetch models from Anthropic API'
        );
      }
      // 100% Dynamic Discovery: Return empty array on failure
      // No hardcoded fallback - models must come from API
      return [];
    }
  }

  /**
   * Convert Anthropic API model to ProviderModel format
   */
  private convertAnthropicModel(betaModelInfo: {
    id: string;
    display_name: string;
    created_at: string;
    type: 'model';
  }): ProviderModel | null {
    try {
      const modelId = betaModelInfo.id;
      const capabilities = this.extractCapabilitiesFromAnthropic(modelId);
      const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(modelId);

      const metadata = {
        endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
        tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
        family: this.extractFamily(modelId),
        tier: this.extractTier(modelId),
        source: 'anthropic-api',
        displayName: betaModelInfo.display_name,
        createdAt: betaModelInfo.created_at,
      };

      return {
        id: modelId,
        name: modelId,
        displayName: betaModelInfo.display_name || this.formatDisplayName(modelId),
        contextWindow,
        maxOutputTokens,
        capabilities,
        pricing,
        metadata,
      };
    } catch (error) {
      this.log.warn({ model: betaModelInfo.id, error }, 'Failed to convert Anthropic model');
      return null;
    }
  }

  private async createProviderModel(modelId: string): Promise<ProviderModel> {
    const capabilities = this.extractCapabilitiesFromAnthropic(modelId);
    const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(modelId);

    const metadata = {
      endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
      tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
      family: this.extractFamily(modelId),
      tier: this.extractTier(modelId),
      source: 'anthropic-api',
    };

    return {
      id: modelId,
      name: modelId,
      displayName: this.formatDisplayName(modelId),
      contextWindow,
      maxOutputTokens,
      capabilities,
      pricing,
      metadata,
    };
  }

  /**
   * Extract capabilities using generic patterns, not hardcoded model names
   */
  private extractCapabilitiesFromAnthropic(modelId: string): ModelCapability[] {
    const capabilities: ModelCapability[] = ['chat', 'function_calling', 'streaming', 'json_mode'];
    const normalized = modelId.toLowerCase();

    // Vision/multimodal - check for version patterns (indicates newer models with vision)
    // Generic version pattern works for any version (3.5, 3.7, 4.0, etc.)
    const hasVersion = normalized.match(/\d+\.\d+/);
    if (hasVersion || normalized.includes('vision') || normalized.includes('multimodal')) {
      capabilities.push('vision', 'multimodal');
    }

    // Reasoning capabilities - check for reasoning-related keywords or higher version numbers
    // Higher version numbers (e.g., 3.5, 4.0) often indicate enhanced reasoning
    if (normalized.includes('reasoning') || normalized.includes('thinking') || 
        (hasVersion && parseFloat(hasVersion[0]) >= 3.5)) {
      capabilities.push('reasoning', 'thinking_mode');
    }

    return Array.from(new Set(capabilities));
  }

  /**
   * Extract model family using generic pattern extraction, not hardcoded names
   */
  private extractFamily(modelId: string): string {
    const normalized = modelId.toLowerCase();
    
    // Extract base family name (first meaningful segment)
    const match = normalized.match(/^([a-z]+(?:-\d+)?(?:\.\d+)?)/);
    if (match && match[1]) {
      const prefix = match[1];
      // Format to title case
      return prefix
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }
    
    // Fallback: extract first segment
    const segments = normalized.split('-');
    if (segments.length > 0 && segments[0]) {
      return segments[0].charAt(0).toUpperCase() + segments[0].slice(1);
    }
    
    return 'Claude';
  }

  private extractTier(modelId: string): string {
    if (modelId.includes('opus')) return 'flagship';
    if (modelId.includes('sonnet')) return 'premium';
    if (modelId.includes('haiku')) return 'fast';
    return 'standard';
  }

  private formatDisplayName(modelId: string): string {
    // Convert kebab-case to title case
    return modelId
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Estimate model specifications using generic tier/keyword inference, not hardcoded model names
   */
  private estimateModelSpecs(modelId: string): {
    contextWindow: number;
    maxOutputTokens: number;
    pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
  } {
    const normalized = modelId.toLowerCase();
    
    // Use generic tier/keyword patterns instead of specific model names
    const isFlagship = normalized.includes('opus');
    const isPremium = normalized.includes('sonnet');
    const isFast = normalized.includes('haiku');
    
    // Extract version number if available (e.g., 3.5, 3.7, 4.0)
    const versionMatch = normalized.match(/(\d+)\.(\d+)/);
    const majorVersion = versionMatch ? parseInt(versionMatch[1], 10) : 3;
    const minorVersion = versionMatch ? parseInt(versionMatch[2], 10) : 0;
    
    // Higher versions typically have larger context windows
    const hasEnhancedContext = majorVersion >= 3 && minorVersion >= 5;
    
    // Estimate based on generic patterns
    if (isFlagship) {
      return {
        contextWindow: 200_000,
        maxOutputTokens: hasEnhancedContext ? 8_192 : 4_096,
        pricing: { inputCostPer1M: 0.015 * 1000, outputCostPer1M: 0.075 * 1000, currency: 'USD' },
      };
    }
    
    if (isPremium) {
      return {
        contextWindow: 200_000,
        maxOutputTokens: hasEnhancedContext ? 8_192 : 4_096,
        pricing: { inputCostPer1M: 0.003 * 1000, outputCostPer1M: 0.015 * 1000, currency: 'USD' },
      };
    }
    
    if (isFast) {
      return {
        contextWindow: 200_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.00025 * 1000, outputCostPer1M: 0.00125 * 1000, currency: 'USD' },
      };
    }

    // Default specs - conservative estimates that work for any model
    return {
      contextWindow: 100_000,
      maxOutputTokens: 4_096,
      pricing: { inputCostPer1M: 0.001 * 1000, outputCostPer1M: 0.005 * 1000, currency: 'USD' },
    };
  }
}
