// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability Execution Service
 *
 * Provides capability-based execution through the OrchestrationEngine.
 * This ensures ALL requests go through the full orchestration pipeline:
 * - Triage Service (strategy selection)
 * - 15 Execution Strategies (single, parallel, collaborative, etc.)
 * - Dynamic Model Selection (by capabilities)
 * - Feedback Loop (quality assurance)
 * - Auto-Learning System
 *
 * This is the CORRECT architecture where tools delegate to the
 * OrchestrationEngine for true "collective AI" intelligence.
 */

import { logger } from '@/utils/logger';
import {
  getOrchestrationEngine,
  isOrchestrationEngineInitialized,
  OrchestrationEngine,
} from '@/core/orchestration/orchestration-engine';
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  ModelCapability,
  OrchestrationResult,
  TaskType,
  ExecutionStrategyName,
} from '@/types';
import { nanoid } from 'nanoid';

// ============================================
// Types
// ============================================

export interface CapabilityExecutionOptions {
  requiredCapabilities: ModelCapability[];
  preferredProviders?: string[];
  maxCost?: number;
  qualityTarget?: number;
  timeout?: number;
  organizationId: string;
  userId?: string;
  taskType?: TaskType;
  strategy?: string;
}

export interface CapabilityExecutionResult {
  success: boolean;
  response?: ChatResponse;
  modelUsed?: string;
  providerUsed?: string;
  strategyUsed?: string;
  modelsConsidered?: number;
  error?: string;
  fallbackUsed?: boolean;
  executionTimeMs?: number;
  qualityScore?: number;
  orchestrationMetadata?: Record<string, unknown>;
}

export interface ModelWithCapability {
  id: string;
  name: string;
  provider: string;
  capabilities: ModelCapability[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

// ============================================
// Task Type Inference from Capabilities
// ============================================

function inferTaskTypeFromCapabilities(capabilities: ModelCapability[]): TaskType {
  // Map capabilities to task types for better strategy selection
  if (capabilities.includes('vision') || capabilities.includes('multimodal')) {
    return 'analysis'; // Visual analysis tasks
  }
  if (capabilities.includes('web_search') || capabilities.includes('deep_research')) {
    return 'qa'; // Question answering with search
  }
  if (capabilities.includes('code_generation')) {
    return 'code-generation';
  }
  if (capabilities.includes('code_review')) {
    return 'code-review';
  }
  if (capabilities.includes('reasoning') || capabilities.includes('thinking_mode')) {
    return 'analysis';
  }
  return 'general'; // Default
}

// ============================================
// Capability Execution Service
// ============================================

export class CapabilityExecutionService {
  private log = logger.child({ service: 'capability-execution' });

  /**
   * Get the OrchestrationEngine instance
   * Throws if not initialized (bootstrap not complete)
   */
  private getEngine(): OrchestrationEngine {
    if (!isOrchestrationEngineInitialized()) {
      throw new Error(
        'OrchestrationEngine not initialized. Cannot execute capability-based requests before bootstrap completes.'
      );
    }
    return getOrchestrationEngine();
  }

  /**
   * Find all models with specific capabilities
   * Uses the ProviderRegistry from the OrchestrationEngine
   */
  async findModelsWithCapabilities(
    requiredCapabilities: ModelCapability[],
    preferredProviders?: string[]
  ): Promise<ModelWithCapability[]> {
    const engine = this.getEngine();
    const registry = engine.getProviderRegistry();
    const allProviders = await registry.getAllProviders();
    const matchingModels: ModelWithCapability[] = [];

    for (const provider of allProviders) {
      // Filter by preferred providers if specified
      if (preferredProviders && preferredProviders.length > 0) {
        if (!preferredProviders.includes(provider.name.toLowerCase())) {
          continue;
        }
      }

      for (const model of provider.models) {
        // Check if model has ALL required capabilities
        const hasAllCapabilities = requiredCapabilities.every((cap) =>
          model.capabilities.includes(cap)
        );

        if (hasAllCapabilities) {
          matchingModels.push({
            id: model.id,
            name: model.name,
            provider: provider.name,
            capabilities: model.capabilities,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens,
          });
        }
      }
    }

    this.log.debug(
      {
        requiredCapabilities,
        preferredProviders,
        foundCount: matchingModels.length,
      },
      'Found models with capabilities'
    );

    return matchingModels;
  }

  /**
   * Find the best model for specific capabilities
   */
  async findBestModelForCapabilities(
    requiredCapabilities: ModelCapability[],
    options: {
      preferredProviders?: string[];
      preferSpeed?: boolean;
      preferQuality?: boolean;
      maxCost?: number;
    } = {}
  ): Promise<ModelWithCapability | null> {
    const models = await this.findModelsWithCapabilities(
      requiredCapabilities,
      options.preferredProviders
    );

    if (models.length === 0) {
      return null;
    }

    // Sort by preference
    // Priority order: more capabilities > larger context
    models.sort((a, b) => {
      // Prefer models with more capabilities (likely more powerful)
      if (a.capabilities.length !== b.capabilities.length) {
        return b.capabilities.length - a.capabilities.length;
      }

      // Prefer larger context window
      const aContext = a.contextWindow || 0;
      const bContext = b.contextWindow || 0;
      return bContext - aContext;
    });

    return models[0];
  }

  /**
   * Execute a request through the OrchestrationEngine with capability requirements
   *
   * This is the CORE method that ensures all requests go through:
   * - Triage Service
   * - Strategy Selection (15 strategies)
   * - Dynamic Model Selection
   * - Feedback Loop
   * - Quality Scoring
   * - Auto-Learning
   */
  async executeWithCapabilities(
    messages: ChatMessage[],
    options: CapabilityExecutionOptions
  ): Promise<CapabilityExecutionResult> {
    const startTime = Date.now();
    const requestId = nanoid();

    this.log.info(
      {
        requestId,
        requiredCapabilities: options.requiredCapabilities,
        organizationId: options.organizationId,
        taskType: options.taskType,
      },
      'Executing request through OrchestrationEngine with capability requirements'
    );

    try {
      const engine = this.getEngine();

      // Infer task type from capabilities if not provided
      const taskType = options.taskType || inferTaskTypeFromCapabilities(options.requiredCapabilities);

      // Build the ChatRequest with capability hints
      // The OrchestrationEngine's strategies will use these to select appropriate models
      const chatRequest: ChatRequest = {
        messages,
        max_tokens: options.maxCost ? Math.min(4000, Math.floor(options.maxCost * 10000)) : 4000,
        temperature: 0.7,
        // Ailin-specific fields for orchestration
        task_type: taskType,
        strategy: options.strategy as ExecutionStrategyName | undefined, // Let engine decide if not specified
        max_cost: options.maxCost,
        quality_target: options.qualityTarget,
        ailin_constraints: {
          requiredCapabilities: options.requiredCapabilities,
          preferredProviders: options.preferredProviders,
        },
      };

      // Execute through the full OrchestrationEngine pipeline
      // This includes: Triage → Strategy Selection → Model Selection → Execution → Feedback → Quality
      const result: OrchestrationResult = await engine.execute(
        chatRequest,
        options.organizationId,
        options.userId
      );

      const executionTimeMs = Date.now() - startTime;

      // Extract execution details
      const primaryExecution = result.modelsUsed.find((m) => m.role === 'primary') || result.modelsUsed[0];

      this.log.info(
        {
          requestId,
          strategyUsed: result.strategyUsed,
          modelsUsed: result.modelsUsed.length,
          qualityScore: result.qualityScore,
          executionTimeMs,
          taskType,
        },
        'OrchestrationEngine execution completed'
      );

      return {
        success: true,
        response: result.finalResponse,
        modelUsed: primaryExecution?.modelId,
        providerUsed: primaryExecution?.modelName?.split('/')[0], // Extract provider from model name
        strategyUsed: result.strategyUsed,
        modelsConsidered: result.modelsUsed.length,
        qualityScore: result.qualityScore,
        executionTimeMs,
        orchestrationMetadata: {
          taskType,
          requiredCapabilities: options.requiredCapabilities,
          triage: result.metadata?.triage,
          quality: result.metadata?.quality,
          modelsUsed: result.modelsUsed.map((m) => ({
            modelId: m.modelId,
            modelName: m.modelName,
            role: m.role,
            success: m.success,
          })),
        },
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;

      this.log.error(
        {
          requestId,
          error: error instanceof Error ? error.message : String(error),
          executionTimeMs,
        },
        'OrchestrationEngine execution failed'
      );

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error during orchestration',
        executionTimeMs,
      };
    }
  }

  /**
   * Execute a vision/multimodal request through OrchestrationEngine
   */
  async executeVisionRequest(
    imageData: string,
    prompt: string,
    options: {
      imageFormat?: 'base64' | 'url';
      mimeType?: string;
      organizationId: string;
      userId?: string;
    }
  ): Promise<CapabilityExecutionResult> {
    const { imageFormat = 'base64', mimeType = 'image/jpeg' } = options;

    // Build message with image
    const imageUrl = imageFormat === 'url' ? imageData : `data:${mimeType};base64,${imageData}`;

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: imageUrl },
          },
        ],
      },
    ];

    // Execute through OrchestrationEngine
    // The engine will automatically select models with vision capability
    return this.executeWithCapabilities(messages, {
      requiredCapabilities: ['vision', 'multimodal'],
      organizationId: options.organizationId,
      userId: options.userId,
      taskType: 'analysis',
    });
  }

  /**
   * Execute a web search request through OrchestrationEngine
   */
  async executeWebSearchRequest(
    query: string,
    options: {
      searchDepth?: 'basic' | 'deep';
      organizationId: string;
      userId?: string;
    }
  ): Promise<CapabilityExecutionResult> {
    const { searchDepth = 'basic' } = options;

    // Determine which capabilities to require
    const requiredCapabilities: ModelCapability[] =
      searchDepth === 'deep' ? ['deep_research', 'web_search'] : ['web_search'];

    // Build message for search
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a helpful assistant with access to real-time web search. Search the web and provide accurate, up-to-date information with sources when possible.',
      },
      {
        role: 'user',
        content: query,
      },
    ];

    // Execute through OrchestrationEngine
    // The engine will select models with web_search capability
    return this.executeWithCapabilities(messages, {
      requiredCapabilities,
      organizationId: options.organizationId,
      userId: options.userId,
      taskType: 'qa',
    });
  }

  /**
   * Get all available capabilities across all providers
   */
  async getAvailableCapabilities(): Promise<Map<ModelCapability, number>> {
    const engine = this.getEngine();
    const registry = engine.getProviderRegistry();
    const allProviders = await registry.getAllProviders();
    const capabilityCount = new Map<ModelCapability, number>();

    for (const provider of allProviders) {
      for (const model of provider.models) {
        for (const capability of model.capabilities) {
          const current = capabilityCount.get(capability) || 0;
          capabilityCount.set(capability, current + 1);
        }
      }
    }

    return capabilityCount;
  }

  /**
   * Check if a specific capability is available
   */
  async isCapabilityAvailable(capability: ModelCapability): Promise<boolean> {
    const models = await this.findModelsWithCapabilities([capability]);
    return models.length > 0;
  }

  /**
   * Get available strategies from the OrchestrationEngine
   */
  getAvailableStrategies(): Array<{ name: string; displayName: string; description: string }> {
    const engine = this.getEngine();
    return engine.getAvailableStrategies();
  }
}

// Singleton instance
let capabilityExecutionService: CapabilityExecutionService | null = null;

export function getCapabilityExecutionService(): CapabilityExecutionService {
  if (!capabilityExecutionService) {
    capabilityExecutionService = new CapabilityExecutionService();
  }
  return capabilityExecutionService;
}
