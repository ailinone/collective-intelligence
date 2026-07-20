// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Baidu/Ernie Model Fetcher
 *
 * 100% Dynamic Model Discovery - No hardcoded models
 * Uses Baidu ERNIE API for real-time model discovery
 * Reference: https://ai.baidu.com/ai-doc/AISTUDIO/Mmhslv9lf
 */

import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

/**
 * Baidu Model Fetcher
 * 100% Dynamic - Fetches models from Baidu ERNIE API
 */
export class BaiduModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'baidu';
  private apiKey: string;
  private secretKey: string;
  private log = logger.child({ component: 'baidu-fetcher' });
  private readonly baseUrl: string;
  private accessTokenCache: { token: string; expiresAt: number } | null = null;
  private lastAuthErrorTime = 0;
  private readonly AUTH_ERROR_COOLDOWN_MS = 60000; // 1 minute cooldown between auth error logs

  constructor(apiKey: string, secretKey?: string, baseUrl: string = 'https://aip.baidubce.com') {
    super();
    this.apiKey = apiKey;
    // Baidu ERNIE OAuth2 requires both client_id (API Key) and client_secret (Secret Key)
    // If secretKey is not provided, use apiKey as fallback (for backwards compatibility)
    // However, for proper authentication, both should be provided separately
    this.secretKey = secretKey || apiKey;
    this.baseUrl = baseUrl;
  }

  async getModels(): Promise<ProviderModel[]> {
    // Validate API key is not mock/test - skip discovery silently
    if (!this.apiKey || this.apiKey.includes('mock') || this.apiKey.includes('test-')) {
      return [];
    }

    try {
      // 100% Dynamic Discovery - Fetch from Baidu ERNIE API
      // Baidu ERNIE uses OAuth2 access token authentication
      const accessToken = await this.getAccessToken();

      if (!accessToken) {
        // Log auth errors with cooldown to avoid spam during discovery cycles
        const now = Date.now();
        if (now - this.lastAuthErrorTime > this.AUTH_ERROR_COOLDOWN_MS) {
          this.log.debug('Baidu ERNIE authentication failed - API key may be invalid or missing');
          this.lastAuthErrorTime = now;
        }
        return [];
      }

      // Baidu ERNIE API endpoint for listing models
      // Reference: https://ai.baidu.com/ai-doc/AISTUDIO/Mmhslv9lf
      const { default: fetch } = await import('node-fetch');
      const endpoint = `${this.baseUrl}/rpc/2.0/ai_custom/v1/wenxinworkshop/model/list`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.log.error(
          {
            status: response.status,
            statusText: response.statusText,
            error: errorText.substring(0, 500),
          },
          'Failed to fetch models from Baidu ERNIE API'
        );
        return [];
      }

      const data = (await response.json()) as {
        result?: {
          model_list?: Array<{
            model: string;
            model_name?: string;
            description?: string;
            capabilities?: string[];
          }>;
        };
        error_code?: number;
        error_msg?: string;
      };

      if (data.error_code || !data.result?.model_list || !Array.isArray(data.result.model_list)) {
        this.log.warn(
          { errorCode: data.error_code, errorMsg: data.error_msg },
          'Baidu ERNIE API returned invalid response format'
        );
        return [];
      }

      // Convert Baidu models to ProviderModel format
      const models: ProviderModel[] = [];
      for (const baiduModel of data.result.model_list) {
        try {
          const model = this.convertBaiduModel(baiduModel);
          if (model) {
          models.push(model);
          }
        } catch (error) {
          this.log.warn({ model: baiduModel.model, error }, 'Failed to convert Baidu model');
        }
      }

      this.log.info({ count: models.length }, 'Successfully fetched models from Baidu ERNIE API');
      return models;
    } catch (error) {
      this.log.error({ error }, 'Failed to fetch models from Baidu ERNIE API');
      // 100% Dynamic Discovery: Return empty array on failure
      // No hardcoded fallback - models must come from API
      return [];
    }
  }

  /**
   * Get Baidu ERNIE OAuth2 access token with caching
   * Reference: https://ai.baidu.com/ai-doc/REFERENCE/Ck3dwjgnz
   */
  private async getAccessToken(): Promise<string | null> {
    // Check cache first (tokens typically expire in 30 days, cache for 29 days to be safe)
    if (this.accessTokenCache && Date.now() < this.accessTokenCache.expiresAt) {
      return this.accessTokenCache.token;
    }

    try {
      const { default: fetch } = await import('node-fetch');
      const tokenUrl = `${this.baseUrl}/oauth/2.0/token`;

      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.apiKey,
        client_secret: this.secretKey,
      });

      const response = await fetch(`${tokenUrl}?${params.toString()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        // Use debug level for expected auth failures (invalid credentials)
        // Only log errors with cooldown to avoid spam
        const now = Date.now();
        if (now - this.lastAuthErrorTime > this.AUTH_ERROR_COOLDOWN_MS) {
          this.log.debug(
            {
              status: response.status,
              statusText: response.statusText,
              error: errorText.substring(0, 200),
            },
            'Baidu ERNIE authentication failed - check API credentials'
          );
          this.lastAuthErrorTime = now;
        }
        return null;
      }

      const data = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };

      if (data.error || !data.access_token) {
        // Use debug level for expected auth failures
        const now = Date.now();
        if (now - this.lastAuthErrorTime > this.AUTH_ERROR_COOLDOWN_MS) {
          this.log.debug(
            { error: data.error, description: data.error_description },
            'Baidu ERNIE token request failed - check API credentials'
          );
          this.lastAuthErrorTime = now;
        }
        return null;
      }

      // Cache token (default expiry is 30 days, cache for 29 days to be safe)
      const expiresIn = data.expires_in || 30 * 24 * 60 * 60 * 1000; // Default to 30 days in ms
      this.accessTokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + (expiresIn * 1000) - (24 * 60 * 60 * 1000), // Cache for expiresIn - 1 day
      };

      return data.access_token;
    } catch (error: unknown) {
      // Use debug level for network errors
      const { getErrorMessage } = await import('@/utils/type-guards');
      const errorMessage = getErrorMessage(error);
      const now = Date.now();
      if (now - this.lastAuthErrorTime > this.AUTH_ERROR_COOLDOWN_MS) {
        this.log.debug({ error: errorMessage }, 'Baidu ERNIE token request failed');
        this.lastAuthErrorTime = now;
      }
      return null;
    }
  }

  /**
   * Convert Baidu API model to ProviderModel format
   */
  private convertBaiduModel(baiduModel: {
    model: string;
    model_name?: string;
    description?: string;
    capabilities?: string[];
  }): ProviderModel | null {
    try {
      const modelId = baiduModel.model;
      const capabilities = this.extractCapabilitiesFromBaidu(modelId, baiduModel.capabilities);
      const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(modelId);

      const metadata = {
        endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
        tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
        family: this.extractFamily(modelId),
        tier: this.extractTier(modelId),
        source: 'baidu-api',
        displayName: baiduModel.model_name,
        description: baiduModel.description,
      };

      return {
        id: modelId,
        name: modelId,
        displayName: baiduModel.model_name || this.formatDisplayName(modelId),
        contextWindow,
        maxOutputTokens,
        capabilities,
        pricing,
        metadata,
      };
    } catch (error) {
      this.log.warn({ model: baiduModel.model, error }, 'Failed to convert Baidu model');
      return null;
    }
  }

  private async createProviderModel(modelId: string): Promise<ProviderModel> {
    const capabilities = this.extractCapabilitiesFromBaidu(modelId);
    const { contextWindow, maxOutputTokens, pricing } = this.estimateModelSpecs(modelId);

    const metadata = {
      endpoint: this.determineEndpoint({ capabilities, metadata: {} } as ProviderModel),
      tools: this.extractTools({ capabilities, metadata: {} } as ProviderModel),
      family: this.extractFamily(modelId),
      tier: this.extractTier(modelId),
      source: 'baidu-api',
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

  private extractCapabilitiesFromBaidu(
    modelId: string,
    apiCapabilities?: string[]
  ): ModelCapability[] {
    const capabilities: ModelCapability[] = ['chat', 'streaming'];
    const modelIdLower = modelId.toLowerCase();

    // Use API capabilities if available (highest priority)
    if (apiCapabilities) {
      if (apiCapabilities.includes('function_calling') || apiCapabilities.includes('tool_use')) {
        capabilities.push('function_calling');
      }
      if (apiCapabilities.includes('vision') || apiCapabilities.includes('multimodal')) {
        capabilities.push('vision', 'multimodal');
      }
      if (apiCapabilities.includes('reasoning') || apiCapabilities.includes('thinking')) {
        capabilities.push('reasoning', 'thinking_mode');
      }
    }

    // Infer from model ID (fallback)
    // Function calling support (ERNIE 4.0+)
    if (modelIdLower.includes('ernie-4')) {
      capabilities.push('function_calling', 'json_mode');
    }

    // ERNIE models have strong reasoning capabilities
    capabilities.push('reasoning', 'thinking_mode');

    // VL models support vision
    if (modelIdLower.includes('vl') || modelIdLower.includes('vision')) {
      capabilities.push('vision', 'multimodal');
    }

    // Thinking models have enhanced reasoning
    if (modelIdLower.includes('thinking')) {
      capabilities.push('deep_research', 'research');
    }

    // ERNIE 4.5 has advanced capabilities
    if (modelIdLower.includes('ernie-4.5')) {
      capabilities.push('web_search', 'file_search');
    }

    return Array.from(new Set(capabilities));
  }

  private extractFamily(modelId: string): string {
    if (modelId.includes('ernie-4.5')) return 'ERNIE 4.5';
    if (modelId.includes('ernie-4.0')) return 'ERNIE 4.0';
    if (modelId.includes('ernie-3.5')) return 'ERNIE 3.5';
    if (modelId.includes('ernie-lite')) return 'ERNIE Lite';
    if (modelId.includes('ernie-speed')) return 'ERNIE Speed';
    if (modelId.includes('ernie-tiny')) return 'ERNIE Tiny';
    return 'ERNIE';
  }

  private extractTier(modelId: string): string {
    if (modelId.includes('ernie-4.5-300b') || modelId.includes('ernie-4.5-424b')) return 'flagship';
    if (modelId.includes('ernie-4.5') || modelId.includes('ernie-4.0')) return 'premium';
    if (modelId.includes('ernie-3.5')) return 'standard';
    if (modelId.includes('lite') || modelId.includes('tiny')) return 'fast';
    if (modelId.includes('speed')) return 'fast';
    return 'standard';
  }

  private formatDisplayName(modelId: string): string {
    return modelId
      .split('-')
      .map((word) => {
        if (word === 'ernie') return 'ERNIE';
        if (word === 'vl') return 'VL';
        if (word === 'lite') return 'Lite';
        if (word === 'speed') return 'Speed';
        if (word === 'pro') return 'Pro';
        if (word === 'tiny') return 'Tiny';
        if (word === 'thinking') return 'Thinking';
        if (word === 'a3b') return 'A3B';
        if (word === 'a47b') return 'A47B';
        return word.toUpperCase();
      })
      .join(' ');
  }

  private estimateModelSpecs(modelId: string): {
    contextWindow: number;
    maxOutputTokens: number;
    pricing: { inputCostPer1M: number; outputCostPer1M: number; currency: string };
  } {
    const modelIdLower = modelId.toLowerCase();

    // ERNIE 4.5 flagship models
    if (modelIdLower.includes('ernie-4.5-300b')) {
      return {
        contextWindow: 200_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.0012, outputCostPer1M: 0.0048, currency: 'USD' },
      };
    }

    if (modelIdLower.includes('ernie-4.5-424b')) {
      return {
        contextWindow: 200_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.0018, outputCostPer1M: 0.0072, currency: 'USD' },
      };
    }

    if (modelIdLower.includes('ernie-4.5-21b')) {
      return {
        contextWindow: 200_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.0003, outputCostPer1M: 0.0012, currency: 'USD' },
      };
    }

    if (modelIdLower.includes('ernie-4.5-vl-28b')) {
      return {
        contextWindow: 200_000,
        maxOutputTokens: 4_096,
        pricing: { inputCostPer1M: 0.0006, outputCostPer1M: 0.0024, currency: 'USD' },
      };
    }

    // ERNIE 4.0 models
    if (modelIdLower.includes('ernie-4.0')) {
      return {
        contextWindow: 100_000,
        maxOutputTokens: 2_048,
        pricing: { inputCostPer1M: 0.0006, outputCostPer1M: 0.0024, currency: 'USD' },
      };
    }

    // ERNIE 3.5 models
    if (modelIdLower.includes('ernie-3.5-128k')) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 2_048,
        pricing: { inputCostPer1M: 0.0003, outputCostPer1M: 0.0012, currency: 'USD' },
      };
    }

    if (modelIdLower.includes('ernie-3.5-8b')) {
      return {
        contextWindow: 8_192,
        maxOutputTokens: 2_048,
        pricing: { inputCostPer1M: 0.00015, outputCostPer1M: 0.0006, currency: 'USD' },
      };
    }

    // Speed models
    if (modelIdLower.includes('ernie-speed-pro-128k')) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 2_048,
        pricing: { inputCostPer1M: 0.0001, outputCostPer1M: 0.0004, currency: 'USD' },
      };
    }

    if (modelIdLower.includes('ernie-speed-8k')) {
      return {
        contextWindow: 8_192,
        maxOutputTokens: 2_048,
        pricing: { inputCostPer1M: 0.00005, outputCostPer1M: 0.0002, currency: 'USD' },
      };
    }

    // Lite models
    if (modelIdLower.includes('ernie-lite-8k')) {
      return {
        contextWindow: 8_192,
        maxOutputTokens: 2_048,
        pricing: { inputCostPer1M: 0.000025, outputCostPer1M: 0.0001, currency: 'USD' },
      };
    }

    // Default specs
    return {
      contextWindow: 8_192,
      maxOutputTokens: 2_048,
      pricing: { inputCostPer1M: 0.0001, outputCostPer1M: 0.0004, currency: 'USD' },
    };
  }
}
