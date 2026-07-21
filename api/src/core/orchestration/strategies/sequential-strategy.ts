// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 3: Sequential with Pre-Analysis
 * Uses 2 models sequentially: fast model for analysis, premium model for execution
 * Optimizes quality by analyzing task first
 */

import { BaseStrategy, safeResponseContent, type StrategyMetadata } from '../base-strategy';
import { resolvePreferredExecutor } from './preferred-model-helper';
import { PoolBuilder } from '@/core/pool/pool-builder';
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  ModelCapability,
  OrchestrationContext,
  OrchestrationResult,
  Model,
  TaskType,
  ImageContent,
  Tool,
} from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { getTaskType } from '@/types/chat-request-extended.js';

/**
 * Sequential Strategy with Pre-Analysis
 *
 * Execution Flow:
 * 1. Fast model analyzes the request and creates execution plan
 * 2. Premium model executes based on the plan
 * 3. Return result from premium model
 *
 * Use Cases:
 * - Complex code generation
 * - Refactoring tasks
 * - Architecture decisions
 * - When planning improves quality
 *
 * Cost: ~1.2x (cheap pre-analyzer + premium executor)
 * Quality: +18% (better planning = better execution)
 * Speed: 1.8x slower (sequential)
 */
export class SequentialStrategy extends BaseStrategy {
  /**
   * Get strategy metadata
   */
  getMetadata(): StrategyMetadata {
    return {
      id: 'strategy-3',
      name: 'sequential',
      displayName: 'Sequential with Pre-Analysis',
      description:
        'Uses fast model for analysis, then premium model for execution. Improves quality through planning.',
      minModels: 2,
      maxModels: 2,
      estimatedCostMultiplier: 1.2,
      estimatedQualityBoost: 0.18, // ~18% quality improvement
      estimatedDurationMultiplier: 1.8, // Sequential = slower
      suitableFor: ['code-generation', 'refactoring', 'debugging', 'analysis'],
    };
  }

  /**
   * Execute strategy
   */
  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const metadata = this.getMetadata();

    this.log.info(
      {
        strategy: metadata.name,
        requestId: context.requestId,
        taskType: context.taskType,
      },
      'Executing Sequential strategy'
    );

    // Select models: fast analyzer + premium executor
    const selectedModels = await this.selectModels(request, context);

    if (selectedModels.length < 2) {
      throw new Error('Sequential strategy requires at least 2 models');
    }

    const analyzer = selectedModels[0]; // Fast, cheap model
    const executor = selectedModels[1]; // Premium model

    this.log.debug(
      {
        analyzer: analyzer.model.name,
        executor: executor.model.name,
      },
      'Models selected for sequential execution'
    );

    // Observer: start
    this.emitObserverEvent(context, { type: 'phase_start', models: [analyzer.model.name, executor.model.name].filter(Boolean) as string[], summary: 'Sequential: analyzer → executor pipeline.' });

    // PHASE 1: Pre-analysis
    const analysisRequest = this.createAnalysisRequest(request);
    const reasoningEnabled = this.isReasoningEnabled(request);
    const analysisExecution = reasoningEnabled
      ? await this.executeModelWithReasoning(analyzer.adapter, analyzer.model, analysisRequest, 'pre-analyzer')
      : await this.executeModel(analyzer.adapter, analyzer.model, analysisRequest, 'pre-analyzer');

    if (!analysisExecution.success) {
      this.log.warn('Pre-analysis failed, falling back to direct execution');

      // Fallback: execute directly with premium model
      const directExecution = await this.executeModel(executor.adapter, executor.model, request, 'primary');

      const totalDuration = Date.now() - startTime;

      return {
        strategyUsed: metadata.name,
        modelsUsed: [analysisExecution, directExecution],
        finalResponse: directExecution.response,
        totalCost: analysisExecution.cost + directExecution.cost,
        totalDuration,
        qualityScore: this.calculateQualityScore(directExecution),
        metadata: {
          strategyId: metadata.id,
          modelCount: 2,
          analysisStatus: 'failed',
          fallback: true,
        },
      };
    }

    this.log.debug(
      {
        analysisCost: analysisExecution.cost,
        analysisDuration: analysisExecution.durationMs,
      },
      'Pre-analysis complete'
    );

    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 2, summary: 'Analysis complete. Executor running.' });

    // PHASE 2: Execution with plan
    const executionRequest = this.createExecutionRequest(request, analysisExecution.response);
    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;

    let executionExecution = hasTools
      ? await this.executeModelWithTools(executor.adapter, executor.model, executionRequest, 'primary')
      : reasoningEnabled
        ? await this.executeModelWithReasoning(executor.adapter, executor.model, executionRequest, 'primary')
        : await this.executeModel(executor.adapter, executor.model, executionRequest, 'primary');

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Sequential execution complete.' });

    if (!executionExecution.success) {
      // Fallback: retry with alternate models before giving up
      const retryExec = await this.executeModelWithRetry(executor.adapter, executor.model, executionRequest, 'primary', context);
      if (retryExec.success) {
        executionExecution = retryExec;
      } else {
        throw new Error(`Execution failed: ${executionExecution.error}`);
      }
    }

    const totalDuration = Date.now() - startTime;

    // Build result
    const result: OrchestrationResult = {
      strategyUsed: metadata.name,
      modelsUsed: [analysisExecution, executionExecution],
      finalResponse: {
        ...executionExecution.response,
        model: request.model || 'Ailin¹ Model',
      },
      totalCost: analysisExecution.cost + executionExecution.cost,
      totalDuration,
      qualityScore: this.calculateQualityScore(executionExecution),
      metadata: {
        strategyId: metadata.id,
        modelCount: 2,
        analysisModel: analyzer.model.name,
        executionModel: executor.model.name,
        analysisCost: analysisExecution.cost,
        executionCost: executionExecution.cost,
        phaseDurations: {
          analysis: analysisExecution.durationMs,
          execution: executionExecution.durationMs,
        },
        ...(() => { const execs = [analysisExecution, executionExecution]; return this.isReasoningEnabled(request) && execs.some(e => e.reasoning) ? { reasoning_traces: execs.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) } : {}; })(),
      },
    };

    this.log.info(
      {
        strategy: metadata.name,
        requestId: context.requestId,
        duration: totalDuration,
        cost: result.totalCost,
        qualityScore: result.qualityScore,
      },
      'Sequential strategy completed'
    );

    return result;
  }

  /**
   * Select analyzer and executor models
   * ✅ Uses DynamicModelSelector for intelligent selection from ALL 500+ models
   *
   * Selection:
   * 1. Analyzer: Fast and cheap model
   * 2. Executor: Best quality model within budget
   */
  private async selectModels(
    request: ChatRequest,
    context: OrchestrationContext
  ): Promise<Array<{ model: Model; adapter: ProviderAdapter }>> {
    const { models } = context;

    // ✅ DELEGATION: Use DynamicModelSelector for intelligent selection
    try {
      const { getDynamicModelSelector } = await import('../../selection/dynamic-model-selector.js');
      const selector = getDynamicModelSelector();

      const taskType = getTaskType(request) || context.taskType || 'chat';
      const complexity = this.calculateComplexity(request);
      const contextSize = this.estimateContextSize(request);
      const requiredCapabilities = this.extractRequiredCapabilities(request);
      const requiredTools = this.extractRequiredTools(request);
      const requiredEndpoint = this.extractRequiredEndpoint(request);

      // Select analyzer: fast and cheap
      const analyzerModels = await selector.selectModels(
        null, // ✅ null = automatic search from database
        {
          taskType: taskType as TaskType,
          complexity: 'low', // Analyzer needs to be fast
          contextSize,
          preferSpeed: true, // Prioritize speed for analyzer
          maxCost: context.maxCost,
          qualityTarget: 0.7, // Lower quality target for analyzer
          requiredCapabilities,
          requiredTools,
          requiredEndpoint,
        },
        context,
        1
      );

      // Select executor: high quality
      const executorModels = await selector.selectModels(
        null, // ✅ null = automatic search from database
        {
          taskType: taskType as TaskType,
          complexity,
          contextSize,
          preferSpeed: false, // Prioritize quality for executor
          maxCost: context.maxCost,
          qualityTarget: context.qualityTarget || 0.9, // High quality target
          requiredCapabilities,
          requiredTools,
          requiredEndpoint,
        },
        context,
        1
      );

      if (analyzerModels.length > 0 && executorModels.length > 0) {
        const analyzer = analyzerModels[0];
        let executor = executorModels[0];

        // Pin biases the executor slot (the premium model). Analyzer
        // stays fast/cheap by design — pinning a premium model there
        // would defeat the strategy's cost-saving purpose.
        const executorPool = executorModels.map(m => m.model);
        const preference = resolvePreferredExecutor(executorPool, context, []);
        if (preference.pinReason === 'pin-not-in-pool') {
          this.log.warn(
            {
              attempted: context.preferredModelIds?.[0],
              reason: preference.pinReason,
              executorPool: executorPool.map(m => m.id),
            },
            'Preferred model not in executor pool — falling back to selector primary executor.',
          );
        }
        if (preference.pinnedExecutor) {
          const pinnedScored = executorModels.find(
            m => m.model.id === preference.pinnedExecutor!.id,
          );
          if (pinnedScored) executor = pinnedScored;
        }

        // Ensure different models
        if (analyzer.model.id === executor.model.id && models.length > 1) {
          // If same model, try to get a different one for executor
          const alternativeExecutors = await selector.selectModels(
            null,
            {
              taskType: taskType as TaskType,
              complexity,
              contextSize,
              preferSpeed: false,
              maxCost: context.maxCost,
              qualityTarget: context.qualityTarget || 0.9,
              requiredCapabilities,
              requiredTools,
              requiredEndpoint,
            },
            context,
            2
          );
          const alternativeExecutor = alternativeExecutors.find(
            (m) => m.model.id !== analyzer.model.id
          );
          if (alternativeExecutor) {
            executor.model = alternativeExecutor.model;
            executor.score = alternativeExecutor.score;
            executor.reason = alternativeExecutor.reason;
          }
        }

        if (!this.getAdapterForModel) {
          throw new Error('getAdapterForModel not injected by orchestration engine');
        }
        const analyzerAdapter = await this.getAdapterForModel(analyzer.model, context);
        const executorAdapter = await this.getAdapterForModel(executor.model, context);

        const selected = [];
        if (analyzerAdapter) {
          selected.push({ model: analyzer.model, adapter: analyzerAdapter });
        }
        if (executorAdapter) {
          selected.push({ model: executor.model, adapter: executorAdapter });
        }

        if (selected.length >= 2) {
          this.log.info(
            {
              analyzer: analyzer.model.name,
              executor: executor.model.name,
              totalModelsConsidered: '500+',
            },
            'Sequential strategy selected 2 models via DynamicModelSelector'
          );
          return selected;
        }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        { error: errorMessage },
        'DynamicModelSelector failed in sequential strategy, using fallback'
      );
    }

    // Fallback: Original logic if DynamicModelSelector fails.
    // context.models is intentionally unfiltered by modality (see the "no
    // pre-filtering" note in orchestration-engine.ts) — capability
    // filtering is expected to happen downstream. The primary path above
    // gets that via DynamicModelSelector's own chat-capability gate, but
    // this fallback previously scored `models` directly with no capability
    // check at all: scoreAsAnalyzer/scoreAsExecutor rank purely on
    // contextWindow/latency/cost/quality, none of which exclude a
    // video/image/audio-only model. Apply the same modality filter the
    // primary path relies on before scoring.
    const chatCapableModels = new PoolBuilder(models).filterByModality('chat').build().models;
    if (chatCapableModels.length < 2) {
      return [];
    }

    const analyzerCandidates = chatCapableModels
      .map((model) => ({
        model,
        score: this.scoreAsAnalyzer(model, context),
      }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score);

    if (analyzerCandidates.length === 0) {
      return [];
    }

    const analyzer = analyzerCandidates[0];

    const executorCandidates = chatCapableModels
      .map((model) => ({
        model,
        score: this.scoreAsExecutor(model, request, context),
      }))
      .filter((m) => m.score > 0 && m.model.id !== analyzer.model.id)
      .sort((a, b) => b.score - a.score);

    if (executorCandidates.length === 0) {
      return [];
    }

    // Pin biases the executor slot in the fallback path too.
    const executorPool = executorCandidates.map(c => c.model);
    const fallbackPreference = resolvePreferredExecutor(executorPool, context, []);
    if (fallbackPreference.pinReason === 'pin-not-in-pool') {
      this.log.warn(
        {
          attempted: context.preferredModelIds?.[0],
          reason: fallbackPreference.pinReason,
        },
        'Preferred model failed sequential-fallback executor eligibility — using highest-score executor.',
      );
    }
    let executor = executorCandidates[0];
    if (fallbackPreference.pinnedExecutor) {
      const pinnedCand = executorCandidates.find(
        c => c.model.id === fallbackPreference.pinnedExecutor!.id,
      );
      if (pinnedCand) executor = pinnedCand;
    }

    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected by orchestration engine');
    }
    const analyzerAdapter = await this.getAdapterForModel(analyzer.model, context);
    const executorAdapter = await this.getAdapterForModel(executor.model, context);

    const selected = [];
    if (analyzerAdapter) {
      selected.push({ model: analyzer.model, adapter: analyzerAdapter });
    }
    if (executorAdapter) {
      selected.push({ model: executor.model, adapter: executorAdapter });
    }

    return selected;
  }

  /**
   * Score model as pre-analyzer
   * Prefer: fast, cheap models
   */
  private scoreAsAnalyzer(model: Model, context: OrchestrationContext): number {
    let score = 0.5;

    // Check context window
    if (context.contextSize > model.contextWindow) {
      return 0;
    }

    // Prefer faster models
    const speedScore = 1 - model.performance.latencyMs / 5000;
    score += Math.max(0, speedScore) * 0.3;

    // Prefer cheaper models
    const avgCost = (model.inputCostPer1k + model.outputCostPer1k) / 2;
    if (avgCost < 0.001)
      score += 0.3; // Very cheap
    else if (avgCost < 0.005) score += 0.1; // Cheap

    // Prefer fast, cost-efficient models for analyzer role
    // 100% dynamic - no hardcoded model names
    const latencyMs = model.performance?.latencyMs || 0;
    if (latencyMs > 0 && latencyMs < 1000) {
      score += 0.1; // Fast models
    }
    // avgCost already declared above, reuse it
    if (avgCost > 0 && avgCost < 0.001) {
      score += 0.1; // Very cost-efficient models
    }

    return Math.min(1, score);
  }

  /**
   * Score model as executor
   * Prefer: high quality models
   */
  private scoreAsExecutor(model: Model, request: ChatRequest, context: OrchestrationContext): number {
    let score = 0.5;

    // Check context window
    if (context.contextSize > model.contextWindow) {
      return 0;
    }

    // Prefer higher quality
    score += model.performance.quality * 0.4;

    // Task-specific boosting
    switch (context.taskType) {
      case 'code-generation':
      case 'refactoring':
        // Prefer models with code generation capabilities
        // 100% dynamic - no hardcoded model names
        if (model.capabilities.includes('code_generation') || model.capabilities.includes('code_interpreter')) {
          score += 0.15;
        }
        if (model.capabilities.includes('function_calling')) {
          score += 0.05; // Bonus for function calling
        }
        // Bonus for high quality models (from performance metrics)
        if (model.performance?.quality && model.performance.quality > 0.9) {
          score += 0.1;
        }
        break;
    }

    // Check budget
    if (context.budget) {
      const estimatedCost = this.calculateEstimatedCost(
        [model],
        context.contextSize,
        2000 // Assume larger output for execution
      );

      if (estimatedCost * 1.2 > context.budget) {
        return 0; // Too expensive (account for analyzer cost)
      }
    }

    return Math.min(1, score);
  }

  /**
   * Create analysis request
   * Ask fast model to analyze and plan
   */
  private createAnalysisRequest(originalRequest: ChatRequest): ChatRequest {
    const lastMessage = originalRequest.messages[originalRequest.messages.length - 1];
    const userContent =
      typeof lastMessage.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);

    const analysisMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          "You are a helpful AI assistant that analyzes programming tasks and creates execution plans. Analyze the user's request and provide a brief plan for how to approach it. Focus on key steps and considerations.",
      },
      {
        role: 'user',
        content: `Analyze this task and create a brief execution plan:\n\n${userContent}`,
      },
    ];

    return {
      ...originalRequest,
      messages: analysisMessages,
      max_tokens: 500, // Limit analysis length
      temperature: 0.3, // More focused
    };
  }

  /**
   * Create execution request with analysis context
   */
  private createExecutionRequest(
    originalRequest: ChatRequest,
    analysisResponse: ChatResponse
  ): ChatRequest {
    const analysisContent = safeResponseContent(analysisResponse);

    // Add analysis as context to original request
    const enhancedMessages: ChatMessage[] = [
      ...originalRequest.messages,
      {
        role: 'system',
        content: `Analysis and execution plan:\n${analysisContent}\n\nNow execute the task following this plan.`,
      },
    ];

    return {
      ...originalRequest,
      messages: enhancedMessages,
    };
  }

  /**
   * Calculate request complexity for DynamicModelSelector
   */
  private calculateComplexity(request: ChatRequest): 'low' | 'medium' | 'high' {
    const messageCount = request.messages?.length || 0;
    const totalContentLength =
      request.messages?.reduce((sum, msg) => sum + (msg.content?.toString() || '').length, 0) || 0;

    if (messageCount > 10 || totalContentLength > 50000) {
      return 'high';
    }
    if (messageCount > 5 || totalContentLength > 20000) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Estimate context size in tokens for DynamicModelSelector
   */
  private estimateContextSize(request: ChatRequest): number {
    const totalChars =
      request.messages?.reduce((sum, msg) => sum + (msg.content?.toString() || '').length, 0) || 0;
    return Math.ceil(totalChars / 4);
  }

  /**
   * Type guard for ImageContent
   */
  private isImageContent(content: unknown): content is ImageContent {
    return (
      typeof content === 'object' &&
      content !== null &&
      'type' in content &&
      (content.type === 'image_url' || content.type === 'image')
    );
  }

  /**
   * Extract required capabilities from request
   */
  private extractRequiredCapabilities(request: ChatRequest): ModelCapability[] | undefined {
    const capabilities: ModelCapability[] = [];

    if (request.tools && request.tools.length > 0) {
      capabilities.push('function_calling');
    }

    const hasImages = request.messages.some((msg) => {
      const content = msg.content;
      if (typeof content === 'string') return false;
      if (Array.isArray(content)) {
        return content.some(
          (c) =>
            typeof c === 'object' &&
            c !== null &&
            (this.isImageContent(c))
        );
      }
      return false;
    });

    if (hasImages) {
      capabilities.push('vision', 'multimodal');
    }

    return capabilities.length > 0 ? capabilities : undefined;
  }

  /**
   * Extract required tools from request
   */
  private extractRequiredTools(request: ChatRequest): string[] | undefined {
    if (!request.tools || request.tools.length === 0) {
      return undefined;
    }

    return request.tools
      .map((tool) => {
        if (typeof tool === 'object' && tool !== null) {
          if ('function' in tool && typeof tool.function === 'object' && tool.function !== null) {
            const toolObj = tool as Tool;
            if (
              'function' in toolObj &&
              typeof toolObj.function === 'object' &&
              toolObj.function !== null &&
              'name' in toolObj.function &&
              typeof toolObj.function.name === 'string'
            ) {
              return toolObj.function.name;
            }
          }
          if ('type' in tool && typeof tool === 'object' && tool !== null) {
            const toolObj = tool as Tool;
            if (toolObj.type === 'function') {
              return toolObj.type;
            }
          }
        }
        return null;
      })
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
  }

  /**
   * Extract required endpoint from request
   */
  private extractRequiredEndpoint(request: ChatRequest): string | undefined {
    const capabilities = this.extractRequiredCapabilities(request);

    if (capabilities?.some((cap): boolean => 
      typeof cap === 'string' && cap.includes('image_generation')
    )) {
      return 'images';
    }
    if (capabilities?.some((cap): boolean => 
      typeof cap === 'string' && (cap.includes('speech') || cap.includes('audio'))
    )) {
      return 'audio_speech';
    }
    if (capabilities?.some((cap): boolean => 
      typeof cap === 'string' && cap.includes('realtime')
    )) {
      return 'realtime';
    }

    return undefined;
  }
}
