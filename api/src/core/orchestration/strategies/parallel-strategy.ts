// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 2: Parallel Execution
 * Executes 2 models in parallel and selects the best response
 * Provides redundancy and quality improvement
 */

import { BaseStrategy, safeResponseContent, type StrategyMetadata } from '../base-strategy';
import { PROMPTS } from '../prompts/sota-system-prompts';
import { resolvePreferredExecutor } from './preferred-model-helper';
import { PoolBuilder } from '@/core/pool/pool-builder';
import type {
  ChatRequest,
  ChatResponse,
  ModelCapability,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
  TaskType,
  ImageContent,
  Tool,
} from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { getTaskType } from '@/types/chat-request-extended';

/**
 * Parallel Strategy
 *
 * Execution Flow:
 * 1. Select 2 complementary models
 * 2. Execute both in parallel
 * 3. Evaluate both responses
 * 4. Return the better response
 *
 * Use Cases:
 * - Critical requests (high availability)
 * - Quality-focused requests
 * - When provider redundancy is needed
 * - Medium complexity tasks
 *
 * Cost: ~2x (2 models)
 * Quality: +10-15% (best of 2)
 * Speed: Same as slowest model (parallel execution)
 */
export class ParallelStrategy extends BaseStrategy {
  /**
   * Get strategy metadata
   */
  getMetadata(): StrategyMetadata {
    return {
      id: 'strategy-2',
      name: 'parallel',
      displayName: 'Parallel Execution',
      description:
        'Executes 2 models in parallel and selects the best response. Provides redundancy and quality improvement.',
      minModels: 2,
      maxModels: 2,
      estimatedCostMultiplier: 2.0,
      estimatedQualityBoost: 0.12, // ~12% quality improvement
      estimatedDurationMultiplier: 1.1, // Slightly slower due to evaluation overhead
      suitableFor: [
        'code-generation',
        'code-review',
        'debugging',
        'refactoring',
        'analysis',
        'documentation',
      ],
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
      'Executing Parallel strategy'
    );

    // Select 2 best models
    const selectedModels = await this.selectModels(request, context);

    if (selectedModels.length < 2) {
      throw new Error('Parallel strategy requires at least 2 models');
    }

    this.log.debug(
      {
        models: selectedModels.map((m) => ({
          name: m.model.name,
          provider: m.adapter.getName(),
        })),
      },
      'Models selected for parallel execution'
    );

    // Observer: start
    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: selectedModels.map(m => m.model.name || m.model.id),
      summary: `Parallel: ${selectedModels.length} models competing.`,
    });

    // Enhance request with competitive framing + reasoning if enabled
    const reasoningEnabled = this.isReasoningEnabled(request);
    const enhancedRequest: ChatRequest = {
      ...request,
      messages: [
        {
          role: 'system',
          content: reasoningEnabled
            ? this.withReasoningPrompt(PROMPTS.parallelCompetitor, request)
            : PROMPTS.parallelCompetitor,
        },
        ...request.messages,
      ],
    };

    // Execute both models in parallel
    let executions = await this.executeModelsInParallel([
      {
        adapter: selectedModels[0].adapter,
        model: selectedModels[0].model,
        request: enhancedRequest,
        role: 'primary',
      },
      {
        adapter: selectedModels[1].adapter,
        model: selectedModels[1].model,
        request: enhancedRequest,
        role: 'secondary',
      },
    ]);

    // Check if at least one execution succeeded
    let successful = executions.filter((e) => e.success);
    // B fix (2026-06-11): if EVERY fanned-out provider failed (401/402/empty),
    // retry the fan-out ONCE with a fresh model pair that EXCLUDES the providers
    // that just failed, before giving up. Routes the collective around dead
    // gateways to (ideally funded) alternatives instead of throwing a 500. If the
    // retry still fails, the throw is now caught by the engine recovery (fix A).
    if (successful.length === 0) {
      const failedProviders = selectedModels
        .map((m) => m.adapter.getName().toLowerCase())
        .filter(Boolean);
      const retryModels = await this.selectModels(request, context, failedProviders);
      if (retryModels.length >= 2) {
        this.log.warn(
          {
            requestId: context.requestId,
            failedProviders,
            retryProviders: retryModels.map((m) => m.adapter.getName()),
          },
          'All parallel executions failed — retrying fan-out with fresh providers (excluding failed)'
        );
        executions = await this.executeModelsInParallel([
          { adapter: retryModels[0].adapter, model: retryModels[0].model, request: enhancedRequest, role: 'primary' },
          { adapter: retryModels[1].adapter, model: retryModels[1].model, request: enhancedRequest, role: 'secondary' },
        ]);
        successful = executions.filter((e) => e.success);
      }
    }
    if (successful.length === 0) {
      throw new Error('All parallel executions failed');
    }

    this.log.debug(
      {
        total: executions.length,
        successful: successful.length,
        failed: executions.length - successful.length,
      },
      'Parallel executions completed'
    );

    // Observer: complete
    this.emitObserverEvent(context, {
      type: 'synthesis_complete',
      summary: `Parallel complete: ${successful.length}/${executions.length} succeeded.`,
    });

    // Select best response
    const bestExecution = this.selectBestExecution(executions);

    // Calculate total cost and duration
    const totalCost = executions.reduce((sum, e) => sum + e.cost, 0);
    const totalDuration = Date.now() - startTime;

    // Build result
    const result: OrchestrationResult = {
      strategyUsed: metadata.name,
      modelsUsed: executions,
      finalResponse: {
        ...bestExecution.response,
        model: request.model || 'Ailin¹ Model', // Model abstraction
      },
      totalCost,
      totalDuration,
      qualityScore: this.calculateQualityScore(bestExecution),
      metadata: {
        strategyId: metadata.id,
        modelCount: executions.length,
        successfulExecutions: successful.length,
        failedExecutions: executions.length - successful.length,
        selectedExecution: bestExecution.modelName,
        parallelExecutions: executions.map((e) => ({
          model: e.modelName,
          success: e.success,
          duration: e.durationMs,
          cost: e.cost,
        })),
        ...(this.isReasoningEnabled(request) && executions.some(e => e.reasoning)
          ? { reasoning_traces: executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) }
          : {}),
      },
    };

    this.log.info(
      {
        strategy: metadata.name,
        requestId: context.requestId,
        duration: totalDuration,
        cost: totalCost,
        qualityScore: result.qualityScore,
        selectedModel: bestExecution.modelName,
      },
      'Parallel strategy completed'
    );

    return result;
  }

  // Intentionally buffered, not real per-token streaming (audited
  // 2026-07-11 alongside the other 12 strategies): both candidates run to
  // completion before `selectBestExecution` picks the winner by score +
  // length + finish_reason. Which of the 2 wins is unknown until BOTH are
  // done, so neither can be streamed live without risking the client
  // receiving tokens for the response that loses the comparison.
  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    this.emitObserverEvent(context, { type: 'phase_start', summary: 'Parallel: 2 models competing.' });
    yield this.progressChunk('2 models executing in parallel...', 0, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const result = await this.execute(request, context);

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Parallel: best response selected.' });
    yield this.progressChunk('Best response selected.', 1, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    yield result.finalResponse;
  }

  /**
   * Select 2 complementary models
   *
   * Selection strategy:
   * 1. Select best model for the task (primary)
   * 2. Select complementary model (different provider/architecture)
   */
  private async selectModels(
    request: ChatRequest,
    context: OrchestrationContext,
    // B fix (2026-06-11): on an all-failed fan-out, the caller re-selects while
    // excluding the providers that just failed (401/402/empty), so the retry
    // lands on different — ideally funded — providers instead of the dead ones.
    excludeProviderNames: readonly string[] = []
  ): Promise<Array<{ model: Model; adapter: ProviderAdapter }>> {
    const { models } = context;

    if (models.length < 2) {
      return [];
    }

    // 🚨 CRITICAL INTEGRATION: Use DynamicModelSelector for parallel strategy
    // Selects 2 optimal models from ALL  available models
    try {
      const { getDynamicModelSelector } = await import('../../selection/dynamic-model-selector.js');
      const selector = getDynamicModelSelector();

      const taskType = getTaskType(request) || context.taskType || 'chat';
      const complexity = this.calculateComplexity(request);
      const contextSize = this.estimateContextSize(request);

      // ✅ IMPORTANT: Extract requirements from request for intelligent filtering
      const requiredCapabilities = this.extractRequiredCapabilities(request);
      const requiredTools = this.extractRequiredTools(request);
      const requiredEndpoint = this.extractRequiredEndpoint(request);

      // ✅ CRITICAL: Pass null to enable automatic database search based on requirements
      // This ensures ALL 500+ models are considered, not just those passed in context
      const rawSelected = await selector.selectModels(
        null, // ✅ null = automatic search from database based on requirements
        {
          taskType: taskType as TaskType,
          complexity,
          contextSize,
          preferSpeed: context.preferSpeed,
          maxCost: context.maxCost,
          qualityTarget: context.qualityTarget,
          requiredCapabilities,
          requiredTools,
          requiredEndpoint,
          // B: exclude providers that failed on the previous fan-out.
          excludeProviders: excludeProviderNames.length ? [...excludeProviderNames] : undefined,
        },
        context,
        // C: over-provision (6, not 2) so the operability filter below can drop
        // known-bad gateways and still leave ≥2 candidates for the fan-out.
        6
      );

      // C fix (2026-06-11): drop providers the health registry has poisoned
      // (D feeds it: 401/402/empty → shouldSkipNearZero) BEFORE the fan-out, so
      // the collective doesn't waste a slot on a known-dead gateway. Never
      // collapses the pool below 2 — falls back to the raw selector order if the
      // filter would be too aggressive (e.g. cold start, all-unknown).
      let selectedModels = rawSelected;
      try {
        const { shouldSkipNearZero } = await import('@/core/operability');
        const healthy = rawSelected.filter(
          (s) => !shouldSkipNearZero(
            {
              providerId: (
                (typeof s.model.metadata?.executionProvider === 'string' && s.model.metadata.executionProvider) ||
                s.model.provider || ''
              ).toLowerCase(),
              modelId: s.model.id,
            },
            { silent: true },
          ).skip
        );
        if (healthy.length >= 2) {
          selectedModels = healthy;
        }
      } catch { /* operability module unavailable — use raw selection */ }

      if (selectedModels.length >= 2) {
        // Pin biases the primary slot. selector.selectModels already
        // returned its top-N picks; we just reorder so the user's pin
        // wins if it's in that pool. If pin missed the pool, log and
        // accept the selector's ordering — second-class fallback.
        const selectedJustModels = selectedModels.map(s => s.model);
        const preference = resolvePreferredExecutor(selectedJustModels, context, []);
        if (preference.pinReason === 'pin-not-in-pool') {
          this.log.warn(
            {
              attempted: context.preferredModelIds?.[0],
              reason: preference.pinReason,
              pool: selectedJustModels.map(m => m.id),
            },
            'Preferred model not in DynamicModelSelector pool — falling back to selector primary.',
          );
        }
        const orderedScored = preference.pinnedExecutor
          ? [
              selectedModels.find(s => s.model.id === preference.pinnedExecutor!.id)!,
              ...selectedModels.filter(s => s.model.id !== preference.pinnedExecutor!.id),
            ]
          : selectedModels;

        const selected = [];

        for (const selectedModel of orderedScored.slice(0, 2)) {
          if (!this.getAdapterForModel) {
            throw new Error('getAdapterForModel not injected by orchestration engine');
          }
          const adapter = await this.getAdapterForModel(selectedModel.model, context);
          if (!adapter) {
            throw new Error(`No adapter found for model: ${selectedModel.model.id}`);
          }
          if (adapter) {
            selected.push({ model: selectedModel.model, adapter });

            this.log.debug(
              {
                selectedModel: selectedModel.model.name,
                provider: selectedModel.model.provider,
                score: selectedModel.score,
                capabilities: selectedModel.model.capabilities,
              },
              'Parallel strategy selected model via DynamicModelSelector'
            );
          }
        }

        if (selected.length >= 2) {
          this.log.info(
            {
              primary: selected[0].model.name,
              secondary: selected[1].model.name,
              totalModelsConsidered: models.length,
              taskType,
              pinned: preference.pinnedExecutor?.id ?? null,
              pinReason: preference.pinReason,
            },
            'DynamicModelSelector chose 2 optimal models for parallel execution'
          );

          return selected;
        }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        { error: errorMessage },
        'DynamicModelSelector failed in parallel strategy, using fallback'
      );
    }

    // Fallback to original scoring if DynamicModelSelector fails
    this.log.warn(
      {
        totalModelsAvailable: models.length,
        taskType: ('task_type' in request && typeof request.task_type === 'string' ? request.task_type : undefined) || context.taskType,
      },
      'Using fallback scoring for parallel strategy'
    );

    // Score all models. context.models is intentionally unfiltered by
    // modality (see the "no pre-filtering" note in orchestration-engine.ts)
    // — capability filtering is expected to happen downstream, which the
    // primary DynamicModelSelector path above does via its own
    // chat-capability gate. This fallback previously scored `models`
    // directly with no capability check at all, letting a video/image/
    // audio-only model win a slot on a text task. Apply the same modality
    // filter the primary path relies on before scoring.
    const chatCapableModels = new PoolBuilder(models).filterByModality('chat').build().models;
    if (chatCapableModels.length < 2) {
      return [];
    }
    const scoredModels = chatCapableModels.map((model) => ({
      model,
      score: this.scoreModelForParallel(model, request, context),
    }));

    // Sort by score descending
    scoredModels.sort((a, b) => b.score - a.score);

    // Pin biases the primary slot in the fallback path too. We resolve
    // against the eligible (non-zero-score) subset so a pinned model
    // that fails capability/budget filters is still treated as
    // ineligible (pin-not-in-pool path).
    const eligibleModels = scoredModels.filter(s => s.score > 0).map(s => s.model);
    const fallbackPreference = resolvePreferredExecutor(eligibleModels, context, []);
    if (fallbackPreference.pinReason === 'pin-not-in-pool') {
      this.log.warn(
        {
          attempted: context.preferredModelIds?.[0],
          reason: fallbackPreference.pinReason,
        },
        'Preferred model failed parallel-fallback eligibility — falling back to score-sorted primary.',
      );
    }

    // Select top model — pin if eligible, else highest-score
    let primary = scoredModels[0];
    if (fallbackPreference.pinnedExecutor) {
      const pinnedScored = scoredModels.find(
        s => s.model.id === fallbackPreference.pinnedExecutor!.id,
      );
      if (pinnedScored) primary = pinnedScored;
    }
    if (primary.score === 0) {
      return [];
    }

    // Select complementary model (different provider, but not the primary)
    const primaryProvider = primary.model.provider;
    let secondary = scoredModels.find(
      (m) => m.model.id !== primary.model.id && m.model.provider !== primaryProvider && m.score > 0,
    );

    // If no different provider found, just use second best (excluding primary)
    if (!secondary) {
      secondary = scoredModels.find(s => s.model.id !== primary.model.id && s.score > 0);
      if (!secondary || secondary.score === 0) {
        return [];
      }
    }

    // Get adapters from injected method
    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected by orchestration engine');
    }
    const primaryAdapter = await this.getAdapterForModel(primary.model, context);
    const secondaryAdapter = await this.getAdapterForModel(secondary.model, context);
    if (!primaryAdapter || !secondaryAdapter) {
      throw new Error('Failed to get adapters for parallel execution');
    }

    const selected = [];
    if (primaryAdapter) {
      selected.push({ model: primary.model, adapter: primaryAdapter });
    }
    if (secondaryAdapter) {
      selected.push({ model: secondary.model, adapter: secondaryAdapter });
    }

    return selected;
  }

  /**
   * Score a model for parallel execution
   * Similar to single model scoring but considers parallelization benefits
   */
  private scoreModelForParallel(
    model: Model,
    request: ChatRequest,
    context: OrchestrationContext
  ): number {
    let score = 0.5; // Base score

    // Check context window
    if (context.contextSize > model.contextWindow) {
      return 0;
    }

    // Boost for higher quality models
    score += model.performance.quality * 0.3;

    // Boost for faster models (parallel benefits from speed)
    const normalizedSpeed = 1 - model.performance.latencyMs / 5000; // Normalize to 0-1
    score += Math.max(0, normalizedSpeed) * 0.1;

    // Task-specific boosting based on capabilities, not model names
    // 100% dynamic - no hardcoded model names
    switch (context.taskType) {
      case 'code-generation':
      case 'code-review':
        // Prefer models with code-related capabilities
        if (model.capabilities.includes('code_generation') || model.capabilities.includes('code_interpreter')) {
          score += 0.15;
        }
        if (model.capabilities.includes('function_calling')) {
          score += 0.05; // Bonus for function calling
        }
        break;

      case 'debugging':
      case 'refactoring':
        // Prefer models with code generation and reasoning capabilities
        if (model.capabilities.includes('code_generation') || model.capabilities.includes('code_interpreter')) {
          score += 0.1;
        }
        if (model.capabilities.includes('reasoning')) {
          score += 0.05; // Bonus for reasoning capability
        }
        // Bonus for high quality models (from performance metrics)
        if (model.performance?.quality && model.performance.quality > 0.9) {
          score += 0.1;
        }
        break;
    }

    // Check capabilities
    if (request.tools && request.tools.length > 0) {
      if (!model.capabilities.includes('function_calling')) {
        return 0;
      }
    }

    // Check vision
    const hasImages = request.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')
    );
    if (hasImages && !model.capabilities.includes('vision')) {
      return 0;
    }

    // Budget check (parallel uses 2 models, so budget / 2 per model)
    if (context.budget) {
      const estimatedCost = this.calculateEstimatedCost([model], context.contextSize, 1000);

      if (estimatedCost * 2 > context.budget) {
        // Total cost would exceed budget
        return 0;
      }
    }

    return Math.min(1, score);
  }

  /**
   * Select best execution from parallel results
   *
   * Selection criteria:
   * 1. Must be successful
   * 2. Higher quality score
   * 3. Longer, more detailed response (tie-breaker)
   */
  private selectBestExecution(executions: ModelExecution[]): ModelExecution {
    // Filter successful
    const successful = executions.filter((e) => e.success);

    if (successful.length === 0) {
      throw new Error('No successful executions');
    }

    if (successful.length === 1) {
      return successful[0];
    }

    // Score each execution
    const scored = successful.map((execution) => ({
      execution,
      score: this.scoreExecution(execution),
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored[0].execution;
  }

  /**
   * Score an execution for selection
   */
  private scoreExecution(execution: ModelExecution): number {
    let score = 0;

    // Base quality score
    score += this.calculateQualityScore(execution) * 0.7;

    // Content length (longer = more detailed, usually better)
    const contentStr = safeResponseContent(execution.response);
    const lengthScore = Math.min(1, contentStr.length / 2000); // Normalize to 2000 chars
    score += lengthScore * 0.2;

    // Completeness (did it finish naturally?)
    if (execution.response?.choices?.[0]?.finish_reason === 'stop') {
      score += 0.1;
    }

    return score;
  }

  /**
   * Calculate request complexity for DynamicModelSelector
   */
  private calculateComplexity(request: ChatRequest): 'low' | 'medium' | 'high' {
    const messageCount = request.messages?.length || 0;
    const totalContentLength =
      request.messages?.reduce((sum, msg) => sum + (msg.content?.toString() || '').length, 0) || 0;
    const hasTools = (request.tools?.length || 0) > 0;
    const hasVision =
      request.messages?.some(
        (msg) =>
          typeof msg.content === 'object' &&
          Array.isArray(msg.content) &&
          msg.content.some((c): c is ImageContent => 
            typeof c === 'object' &&
            c !== null &&
            'type' in c &&
            c.type === 'image_url'
          )
      ) || false;

    // High complexity indicators
    if (hasVision || hasTools || messageCount > 10 || totalContentLength > 10000) {
      return 'high';
    }

    // Medium complexity indicators
    if (messageCount > 5 || totalContentLength > 5000) {
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

    // Rough estimation: ~4 chars per token
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
        return content.some((c) => this.isImageContent(c));
      }
      return this.isImageContent(content);
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

    if (capabilities?.includes('image_generation')) {
      return 'images';
    }
    if (capabilities?.some((cap): boolean => 
      typeof cap === 'string' && (cap === 'text_to_speech' || cap.includes('speech'))
    )) {
      return 'audio_speech';
    }
    if (capabilities?.some((cap): boolean => 
      typeof cap === 'string' && cap === 'realtime'
    )) {
      return 'realtime';
    }

    return undefined;
  }
}
