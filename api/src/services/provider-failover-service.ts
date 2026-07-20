// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider Failover Service
 * Automatic failover between providers for 99.99% availability
 * Enhanced with dynamic advanced model prioritization (based on capabilities, not hardcoded model names)
 */

import type { ChatRequest, ChatResponse, Model, ModelCapability } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { logger } from '@/utils/logger';

/**
 * Failover attempt result
 */
export interface FailoverAttempt {
  provider: string;
  model: string;
  success: boolean;
  error?: string;
  latency: number;
}

/**
 * Failover result
 */
export interface FailoverResult {
  success: boolean;
  response?: ChatResponse;
  attempts: FailoverAttempt[];
  finalProvider?: string;
  finalModel?: string;
  totalLatency: number;
}

/**
 * Provider Failover Service
 * Handles automatic failover between providers
 */
export class ProviderFailoverService {
  private log = logger.child({ service: 'provider-failover' });

  /**
   * Check if advanced models (with reasoning/deep_research capabilities) should be prioritized for this request
   * Uses dynamic capability-based detection, not hardcoded model names
   */
  private shouldPrioritizeAdvancedModels(request: ChatRequest, primaryModel?: Model): boolean {
    const taskType = request.task_type;
    
    // Check if primary model has advanced capabilities (if available)
    const hasAdvancedPrimaryModel = primaryModel && (
      primaryModel.capabilities.includes('reasoning') ||
      primaryModel.capabilities.includes('deep_research') ||
      primaryModel.capabilities.includes('thinking_mode')
    );
    
    const advancedModelIndicators = [
      hasAdvancedPrimaryModel, // Primary model has advanced capabilities
      taskType === 'analysis', // Use existing task type
      this.isHighComplexityRequest(request),
      this.hasAdvancedCapabilities(request),
    ];

    return advancedModelIndicators.some(Boolean);
  }

  /**
   * Check if request requires high complexity handling
   */
  private isHighComplexityRequest(request: ChatRequest): boolean {
    const content =
      request.messages?.map((m) => (typeof m.content === 'string' ? m.content : '')).join('') || '';

    return (
      content.length > 10000 ||
      (request.tools?.length || 0) > 5 ||
      /\b(architect|research|analyze|design)\b/i.test(content)
    );
  }

  /**
   * Check if request requires advanced AI capabilities
   */
  private hasAdvancedCapabilities(request: ChatRequest): boolean {
    return (
      request.tools?.some(
        (tool) =>
          tool.function?.name?.includes('reasoning') || tool.function?.name?.includes('analyze')
      ) || false
    );
  }

  /**
   * Enhance fallback options by prioritizing advanced models (with reasoning/deep_research capabilities)
   * Uses dynamic capability-based detection, not hardcoded model names
   */
  private async enhanceFallbacksWithAdvancedModels(
    request: ChatRequest,
    primaryModel: Model,
    fallbackOptions: Array<{ adapter: ProviderAdapter; model: Model }>
  ): Promise<Array<{ adapter: ProviderAdapter; model: Model }>> {
    if (!this.shouldPrioritizeAdvancedModels(request, primaryModel)) {
      return fallbackOptions;
    }

    this.log.info(
      {
        taskType: request.task_type,
        model: request.model,
      },
      'Enhancing fallbacks by prioritizing advanced models (reasoning/deep_research capabilities)'
    );

    // Find models with advanced capabilities (reasoning, deep_research, thinking_mode)
    // This is dynamic based on capabilities, not hardcoded model names
    const advancedCapabilities: ModelCapability[] = ['reasoning', 'deep_research', 'thinking_mode'];
    const advancedFallbacks = fallbackOptions.filter((f) =>
      advancedCapabilities.some(cap => f.model.capabilities.includes(cap))
    );

    if (advancedFallbacks.length > 0) {
      // Move advanced models to front of fallback list
      const otherFallbacks = fallbackOptions.filter((f) => !advancedFallbacks.includes(f));
      return [...advancedFallbacks, ...otherFallbacks];
    }

    // If no advanced models available, keep original order but log
    this.log.debug('No models with advanced capabilities (reasoning/deep_research) available in fallback options');
    return fallbackOptions;
  }

  /**
   * Execute request with automatic failover
   * Enhanced with dynamic advanced model prioritization (based on capabilities)
   */
  async executeWithFailover(
    request: ChatRequest,
    primaryAdapter: ProviderAdapter,
    primaryModel: Model,
    fallbackOptions: Array<{ adapter: ProviderAdapter; model: Model }>
  ): Promise<FailoverResult> {
    // Enhance fallback options by prioritizing advanced models (based on capabilities, not hardcoded names)
    const enhancedFallbacks = await this.enhanceFallbacksWithAdvancedModels(request, primaryModel, fallbackOptions);

    return this.executeWithFailoverInternal(
      request,
      primaryAdapter,
      primaryModel,
      enhancedFallbacks
    );
  }

  /**
   * Execute with enhanced fallback options
   */
  private async executeWithFailoverInternal(
    request: ChatRequest,
    primaryAdapter: ProviderAdapter,
    primaryModel: Model,
    fallbackOptions: Array<{ adapter: ProviderAdapter; model: Model }>
  ): Promise<FailoverResult> {
    const attempts: FailoverAttempt[] = [];
    const startTime = Date.now();

    // Try primary provider first
    const primaryResult = await this.tryProvider(request, primaryAdapter, primaryModel, 'primary');
    attempts.push(primaryResult);

    if (primaryResult.success) {
      const totalLatency = Date.now() - startTime;
      this.log.info(
        {
          provider: primaryResult.provider,
          model: primaryResult.model,
          latency: primaryResult.latency,
        },
        'Request succeeded on primary provider'
      );

      return {
        success: true,
        response: primaryResult.response,
        attempts,
        finalProvider: primaryResult.provider,
        finalModel: primaryResult.model,
        totalLatency,
      };
    }

    // Primary failed - try fallbacks
    this.log.warn(
      {
        primaryProvider: primaryResult.provider,
        error: primaryResult.error,
        fallbackCount: fallbackOptions.length,
      },
      'Primary provider failed, trying fallbacks'
    );

    for (const [index, fallback] of fallbackOptions.entries()) {
      const fallbackResult = await this.tryProvider(
        request,
        fallback.adapter,
        fallback.model,
        `fallback-${index + 1}`
      );
      attempts.push(fallbackResult);

      if (fallbackResult.success) {
        const totalLatency = Date.now() - startTime;
        this.log.info(
          {
            provider: fallbackResult.provider,
            model: fallbackResult.model,
            attempt: index + 2,
            totalAttempts: attempts.length,
            latency: totalLatency,
          },
          'Request succeeded on fallback provider'
        );

        return {
          success: true,
          response: fallbackResult.response,
          attempts,
          finalProvider: fallbackResult.provider,
          finalModel: fallbackResult.model,
          totalLatency,
        };
      }
    }

    // All providers failed
    const totalLatency = Date.now() - startTime;
    this.log.error(
      {
        attempts: attempts.length,
        totalLatency,
        errors: attempts.map((a) => ({ provider: a.provider, error: a.error })),
      },
      'All providers failed'
    );

    return {
      success: false,
      attempts,
      totalLatency,
    };
  }

  /**
   * Try a single provider
   */
  private async tryProvider(
    request: ChatRequest,
    adapter: ProviderAdapter,
    model: Model,
    attemptType: string
  ): Promise<FailoverAttempt & { response?: ChatResponse }> {
    const startTime = Date.now();
    const providerName = adapter.getName();

    try {
      this.log.debug(
        {
          provider: providerName,
          model: model.name,
          attemptType,
        },
        'Attempting provider'
      );

      // Use streaming or non-streaming based on request
      let response: ChatResponse;

      if (request.stream) {
        // For streaming, collect all chunks
        const chunks: ChatResponse[] = [];
        for await (const chunk of adapter.chatCompletionStream(request)) {
          chunks.push(chunk);
        }
        // Return last chunk as final response
        response = chunks[chunks.length - 1];
      } else {
        response = await adapter.chatCompletion(request);
      }

      const latency = Date.now() - startTime;

      return {
        provider: providerName,
        model: model.name,
        success: true,
        latency,
        response,
      };
    } catch (error) {
      const latency = Date.now() - startTime;

      this.log.warn(
        {
          provider: providerName,
          model: model.name,
          error: error instanceof Error ? error.message : String(error),
          latency,
          attemptType,
        },
        'Provider attempt failed'
      );

      return {
        provider: providerName,
        model: model.name,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        latency,
      };
    }
  }

  /**
   * Select fallback options based on cost and quality
   * NO ARTIFICIAL LIMITS - returns ALL capable models sorted by score
   * This enables true dynamic fallback across all providers
   */
  async selectFallbackOptions(
    allModels: Model[],
    primaryModel: Model,
    budget?: number,
    qualityTarget?: number,
    options?: {
      maxFallbacks?: number; // Optional limit, defaults to unlimited
      requireCapabilities?: string[]; // Filter by capabilities
      excludeProviders?: string[]; // Exclude specific providers
    }
  ): Promise<Model[]> {
    const excludeProviders = new Set([
      primaryModel.provider,
      ...(options?.excludeProviders || []),
    ]);

    // Filter models
    let fallbackModels = allModels.filter((m) => !excludeProviders.has(m.provider));

    // Filter by required capabilities if specified
    if (options?.requireCapabilities && options.requireCapabilities.length > 0) {
      fallbackModels = fallbackModels.filter((m) => {
        const modelCaps = m.capabilities || [];
        return options.requireCapabilities!.every((cap) =>
          modelCaps.includes(cap as ModelCapability)
        );
      });
    }

    if (fallbackModels.length === 0) {
      this.log.warn(
        {
          primaryProvider: primaryModel.provider,
          excludedProviders: Array.from(excludeProviders),
          requiredCapabilities: options?.requireCapabilities,
        },
        'No fallback models available after filtering'
      );
      return [];
    }

    // Score each model
    const scored = fallbackModels.map((model) => {
      let score = 0;

      // Prefer similar or better quality
      if (model.performance?.quality >= (primaryModel.performance?.quality || 0)) {
        score += 0.4;
      } else {
        score += 0.2;
      }

      // Prefer cheaper or similar cost
      const primaryCost = primaryModel.inputCostPer1k || 0;
      const modelCost = model.inputCostPer1k || 0;
      if (modelCost <= primaryCost) {
        score += 0.3;
      } else if (modelCost <= primaryCost * 2) {
        score += 0.15;
      }

      // Prefer similar or larger context window
      if (model.contextWindow >= (primaryModel.contextWindow || 0)) {
        score += 0.2;
      } else {
        score += 0.1;
      }

      // Budget constraint
      if (budget) {
        const estimatedCost = ((model.inputCostPer1k || 0) + (model.outputCostPer1k || 0)) / 2;
        if (estimatedCost > budget) {
          score *= 0.5; // Penalize over-budget
        }
      }

      // Quality target
      if (qualityTarget && (model.performance?.quality || 0) < qualityTarget) {
        score *= 0.7; // Penalize under-quality
      }

      // Bonus for function calling support
      if (model.capabilities?.includes('function_calling')) {
        score += 0.1;
      }

      // Bonus for streaming support
      if (model.capabilities?.includes('streaming')) {
        score += 0.05;
      }

      return { model, score };
    });

    // Sort by score (descending)
    const sortedModels = scored
      .sort((a, b) => b.score - a.score)
      .map((s) => s.model);

    // Apply optional limit (default: no limit - return ALL capable models)
    const maxFallbacks = options?.maxFallbacks;
    const result = maxFallbacks ? sortedModels.slice(0, maxFallbacks) : sortedModels;

    this.log.info(
      {
        totalCandidates: fallbackModels.length,
        selectedFallbacks: result.length,
        topFallbacks: result.slice(0, 5).map((m) => ({
          id: m.id,
          provider: m.provider,
        })),
      },
      'Fallback options selected (no artificial limit)'
    );

    return result;
  }

  /**
   * Check if error is retryable (should try fallback)
   */
  isRetryableError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return true; // Unknown errors, try fallback
    }

    const message = error.message.toLowerCase();

    // Rate limits - try different provider
    if (message.includes('rate limit') || message.includes('quota')) {
      return true;
    }

    // Service unavailable - try different provider
    if (message.includes('unavailable') || message.includes('timeout')) {
      return true;
    }

    // Authentication errors - don't retry (fix config)
    if (message.includes('authentication') || message.includes('api key')) {
      return false;
    }

    // Validation errors - don't retry (fix request)
    if (message.includes('invalid') || message.includes('validation')) {
      return false;
    }

    // Default: retry
    return true;
  }
}

/**
 * Global failover service instance
 */
let globalFailoverService: ProviderFailoverService | null = null;

/**
 * Get failover service
 */
export function getFailoverService(): ProviderFailoverService {
  if (!globalFailoverService) {
    globalFailoverService = new ProviderFailoverService();
  }
  return globalFailoverService;
}
