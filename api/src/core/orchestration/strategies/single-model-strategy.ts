// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 1: Single Model
 * Uses a single model for the entire request
 * Simplest and fastest strategy, baseline for comparison
 */

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import type {
  ChatRequest,
  OrchestrationContext,
  OrchestrationResult,
  Model,
  ModelExecution,
  ModelCapability,
  TaskType,
  ImageContent,
  Tool,
} from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { getUserSpecifiedModelFlag, getTaskType } from '@/types/chat-request-extended.js';

/**
 * Single Model Strategy
 *
 * Execution Flow:
 * 1. Select best model for the task
 * 2. Execute request with selected model
 * 3. Return response
 *
 * Use Cases:
 * - Simple queries
 * - Time-sensitive requests
 * - Budget-constrained requests
 * - When a specific model is requested
 *
 * Cost: Baseline (1x)
 * Quality: Baseline
 * Speed: Fastest
 */
export class SingleModelStrategy extends BaseStrategy {
  /**
   * Get strategy metadata
   */
  getMetadata(): StrategyMetadata {
    return {
      id: 'strategy-1',
      name: 'single',
      displayName: 'Single Model',
      description: 'Uses a single model for the entire request. Fast and cost-effective.',
      minModels: 1,
      maxModels: 1,
      estimatedCostMultiplier: 1.0,
      estimatedQualityBoost: 0.0, // Baseline
      estimatedDurationMultiplier: 1.0,
      suitableFor: [
        'general',
        'qa',
        'code-generation',
        'documentation',
        'analysis',
        'debugging',
        'refactoring',
        'testing',
        'code-review',
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
      'Executing Single Model strategy'
    );

    const userSpecifiedModel =
      getUserSpecifiedModelFlag(request) && Boolean(request.model) && request.model !== 'auto';
    // Even user-specified models get retries — if the selected provider fails (402/403),
    // findModel will try other providers for the same model ID dynamically.
    const maxAttempts = userSpecifiedModel ? 3 : 5;
    const excludedModelIds = new Set<string>();
    const attempts: ModelExecution[] = [];
    let execution: ModelExecution | null = null;
    let selectedProviderName: string | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const selectedModel = await this.selectBestModel(request, context, excludedModelIds);

      if (!selectedModel) {
        break;
      }

      excludedModelIds.add(selectedModel.model.id);

      this.log.debug(
        {
          selectedModel: selectedModel.model.name,
          provider: selectedModel.adapter.getName(),
          attempt: attempt + 1,
          maxAttempts,
        },
        'Model selected'
      );

      const requestWithSelectedModel: ChatRequest = {
        ...request,
        model: selectedModel.model.id,
      };

      // Self-critique loop when quality_target >= 0.9 (self-improving single model)
      // Tool execution when request has tools
      const qualityTarget = context.qualityTarget ?? 0;
      const hasTools = Array.isArray(request.tools) && request.tools.length > 0;

      // Observer: emit execution start
      this.emitObserverEvent(context, {
        type: 'phase_start',
        models: [selectedModel.model.name || selectedModel.model.id],
        summary: `Single model execution: ${selectedModel.model.name || selectedModel.model.id}.${qualityTarget >= 0.9 ? ' Self-critique enabled.' : ''}${hasTools ? ' Tool execution enabled.' : ''}`,
      });
      const reasoningEnabled = this.isReasoningEnabled(request);
      const currentExecution = hasTools
        ? await this.executeModelWithTools(selectedModel.adapter, selectedModel.model, requestWithSelectedModel, 'primary')
        : qualityTarget >= 0.9
          ? await this.selfCritiqueLoop(selectedModel.adapter, selectedModel.model, requestWithSelectedModel, 'primary', qualityTarget)
          : reasoningEnabled
            ? await this.executeModelWithReasoning(selectedModel.adapter, selectedModel.model, requestWithSelectedModel, 'primary')
            : await this.executeModel(selectedModel.adapter, selectedModel.model, requestWithSelectedModel, 'primary');
      attempts.push(currentExecution);

      if (currentExecution.success) {
        execution = currentExecution;
        selectedProviderName = selectedModel.adapter.getName();

        // Observer: emit completion
        this.emitObserverEvent(context, {
          type: 'synthesis_complete',
          summary: `Single model response generated.${currentExecution.reasoning ? ' Self-critique applied.' : ''}`,
        });

        break;
      }

      // Detect balance/payment errors — try same model via different provider
      const errMsg = (currentExecution.error || '').toLowerCase();
      const isBalanceError = errMsg.includes('402') || errMsg.includes('403') ||
        errMsg.includes('insufficient') || errMsg.includes('balance') ||
        errMsg.includes('quota') || errMsg.includes('credit');

      if (isBalanceError && userSpecifiedModel && this.getAdapterForModel) {
        // Try same model ID via provider-registry fallback (tries all providers)
        const { modelCatalogService } = await import('@/services/model-catalog-service');
        const allEntries = await modelCatalogService.getAllEntriesForModel(selectedModel.model.id);
        const failedProvider = selectedModel.adapter.getName().toLowerCase();
        for (const entry of allEntries) {
          if (entry.provider.toLowerCase() === failedProvider) continue;
          const altAdapter = await this.getAdapterForModel(entry, context);
          if (!altAdapter) continue;
          this.log.info(
            { model: entry.id, fromProvider: failedProvider, toProvider: entry.provider },
            'Retrying user-specified model via alternative provider'
          );
          const retryExec = await this.executeModel(altAdapter, entry, { ...request, model: entry.id }, 'primary');
          attempts.push(retryExec);
          if (retryExec.success) {
            execution = retryExec;
            selectedProviderName = altAdapter.getName();
            break;
          }
        }
        if (execution?.success) break;
      }

      this.log.warn(
        {
          requestId: context.requestId,
          model: selectedModel.model.name,
          provider: selectedModel.adapter.getName(),
          error: currentExecution.error,
          attempt: attempt + 1,
          maxAttempts,
          isBalanceError,
        },
        'Single strategy execution failed, trying next candidate'
      );
    }

    if (!execution) {
      const lastError = attempts[attempts.length - 1]?.error || 'No suitable model available';
      throw new Error(`Model execution failed: ${lastError}`);
    }

    const totalDuration = Date.now() - startTime;
    const totalCost = attempts.reduce((sum, item) => sum + (item.cost || 0), 0);

    // Build result
    const result: OrchestrationResult = {
      strategyUsed: metadata.name,
      modelsUsed: attempts,
      finalResponse: execution.response,
      totalCost,
      totalDuration,
      qualityScore: this.calculateQualityScore(execution),
      metadata: {
        strategyId: metadata.id,
        modelCount: attempts.length,
        selectedModel: execution.modelName,
        selectedProvider: selectedProviderName || 'unknown',
        ...(execution.reasoning ? { reasoning_traces: [{ model_id: execution.modelId, model_name: execution.modelName, role: execution.role, reasoning: execution.reasoning, reasoning_tokens: execution.reasoningTokens }] } : {}),
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
      'Single Model strategy completed'
    );

    return result;
  }

  supportsStreaming(): boolean {
    return true;
  }

  /**
   * Genuine token-by-token streaming for the single-model strategy.
   *
   * Why this exists: `/v1/chat/completions` never actually calls this — it has
   * its OWN bespoke streaming path in chat-routes.ts (candidate fallback chain +
   * first-chunk/idle deadlines, tuned separately). But `orchestrationEngine
   * .executeStream()` (used by e.g. /v1/responses) dispatches purely on
   * `strategy.supportsStreaming()`, and single-model NOT overriding it (the
   * BaseStrategy default is `false`) meant those callers silently fell back to
   * the fully-buffered `execute()` path: the client got ZERO tokens until the
   * ENTIRE generation finished, no matter the request's `stream: true`.
   *
   * Builds the SAME ranked candidate list execute() resolves (via repeated
   * selectBestModel() calls, excluding each prior pick), then streams through
   * `streamSynthesisWithFallback` for first-chunk + idle deadlines and
   * candidate fallback — `throwOnTotalFailure: true` because, unlike a
   * collective, there is no partial multi-model output to degrade to; the
   * caller should see a real error, matching execute()'s throw contract.
   */
  async *executeStream(
    request: ChatRequest,
    context: OrchestrationContext,
    // Test/tuning hook only — orchestrationEngine.executeStream() calls this
    // with 2 args, so production always uses streamSynthesisWithFallback's
    // tuned default (6000ms as of 2026-07-11).
    opts?: { firstChunkTimeoutMs?: number; idleTimeoutMs?: number }
  ): AsyncGenerator<import('@/types').ChatResponse, void, unknown> {
    const userSpecifiedModel =
      getUserSpecifiedModelFlag(request) && Boolean(request.model) && request.model !== 'auto';
    const maxAttempts = userSpecifiedModel ? 3 : 5;
    const excludedModelIds = new Set<string>();
    const candidates: Array<{ adapter: ProviderAdapter; model: Model }> = [];

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const selected = await this.selectBestModel(request, context, excludedModelIds);
      if (!selected) break;
      excludedModelIds.add(selected.model.id);
      candidates.push({ adapter: selected.adapter, model: selected.model });
    }

    if (candidates.length === 0) {
      throw new Error('Model execution failed: No suitable model available');
    }

    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: candidates.map((c) => c.model.name || c.model.id),
      summary: `Single model execution: ${candidates[0].model.name || candidates[0].model.id}.`,
    });

    yield* this.streamSynthesisWithFallback(
      request,
      candidates,
      () => '',
      { ...opts, throwOnTotalFailure: true, skipSynthesisCap: true },
    );

    this.emitObserverEvent(context, {
      type: 'synthesis_complete',
      summary: 'Single model response generated.',
    });
  }

  /**
   * Select best model for the task
   *
   * Selection criteria:
   * 1. If model specified in request, use it
   * 2. Otherwise, select based on:
   *    - Task type
   *    - Context size
   *    - Budget constraints
   *    - Model capabilities
   *    - Quality target
   */
  async planStreaming(
    request: ChatRequest,
    context: OrchestrationContext
  ): Promise<{ model: Model; adapter: ProviderAdapter } | null> {
    return this.selectBestModel(request, context, new Set());
  }

  protected async selectBestModel(
    request: ChatRequest,
    context: OrchestrationContext,
    excludedModelIds: Set<string> = new Set()
  ): Promise<{ model: Model; adapter: ProviderAdapter } | null> {
    // Speculative selection (2026-07-14): the engine may have already
    // resolved a model+adapter concurrently with the triage LLM call (see
    // resolveSpeculativeSingleSelection in orchestration-engine.ts). Reuse it
    // instead of re-running DynamicModelSelector — but never on a retry
    // (excludedModelIds non-empty means a prior candidate just failed, so the
    // precomputed pick is either the one that failed or stale either way).
    if (
      context.precomputedModelSelection &&
      excludedModelIds.size === 0 &&
      !excludedModelIds.has(context.precomputedModelSelection.model.id)
    ) {
      this.log.info(
        { model: context.precomputedModelSelection.model.name, reason: 'Reused speculative parallel selection' },
        'Using precomputed model selection'
      );
      return context.precomputedModelSelection;
    }

    const { models } = context;

    if (models.length === 0) {
      this.log.warn('No models available for selection');
      return null;
    }

    // Check if model was explicitly specified by user
    const userSpecifiedModel = getUserSpecifiedModelFlag(request);
    // Only use request.model if it was explicitly specified by user and not auto
    // Otherwise, delegate to DynamicModelSelector for intelligent selection
    if (userSpecifiedModel && request.model && request.model !== 'auto') {
      const requestedModel = models.find(
        (m) =>
          !excludedModelIds.has(m.id) &&
          (m.name === request.model || m.id === request.model)
      );

      if (requestedModel) {
        // Use injected adapter getter
        const adapter = this.getAdapterForModel
          ? await this.getAdapterForModel(requestedModel, context)
          : null;
        if (adapter) {
          this.log.info(
            {
              model: requestedModel.name,
              provider: requestedModel.provider,
              reason: 'User-specified model',
              totalModelsAvailable: models.length,
            },
            'Using user-specified model (delegation disabled)'
          );
          return { model: requestedModel, adapter };
        } else {
          this.log.warn(
            {
              model: request.model,
              reason: 'Adapter not found for user-specified model',
            },
            'Falling back to dynamic selection'
          );
        }
      } else {
        this.log.warn(
          {
            model: request.model,
            reason: 'User-specified model not found in available models',
            totalModelsAvailable: models.length,
          },
          'Falling back to dynamic selection'
        );
      }
    }

    // ✅ DELEGATION: Use DynamicModelSelector for intelligent model selection
    // This ensures ALL 500+ registered models are considered based on real performance data
    try {
      const { getDynamicModelSelector } = await import('../../selection/dynamic-model-selector.js');
      const selector = getDynamicModelSelector();

      // Extract task_type from request (sent by CLI) or use context default
      const taskType = getTaskType(request) || context.taskType || 'chat';
      const complexity = this.calculateComplexity(request);
      const contextSize = this.estimateContextSize(request);

      // ✅ IMPORTANT: Extract requirements from request + context for intelligent filtering
      const requiredCapabilities = this.extractRequiredCapabilities(request, context);
      const requiredTools = this.extractRequiredTools(request);
      const requiredEndpoint = this.extractRequiredEndpoint(request);

      // ✅ CRITICAL: Pass null to enable automatic database search based on requirements
      // This ensures ALL 500+ models are considered, not just those passed in context
      const selectedModels = await selector.selectModels(
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
        },
        context,
        Math.max(5, excludedModelIds.size + 3)
      );

      if (selectedModels.length > 0) {
        const rankedCandidates = [...selectedModels];
        const stableCandidates = rankedCandidates.filter((candidate) => {
          const realtime = candidate.realTimePerformance;
          if (realtime) {
            if (typeof realtime.reliability === 'number' && realtime.reliability < 0.75) {
              return false;
            }
            if (typeof realtime.latencyMs === 'number' && realtime.latencyMs > 20_000) {
              return false;
            }
            return true;
          }

          const historical = candidate.historicalPerformance;
          if (!historical || historical.sampleSize < 5) {
            return false;
          }
          return historical.successRate >= 0.8 && historical.avgLatency <= 20_000;
        });

        let candidatePool =
          stableCandidates.length > 0 ? stableCandidates : rankedCandidates;
        candidatePool = candidatePool.filter(
          (candidate) => !excludedModelIds.has(candidate.model.id)
        );

        if (candidatePool.length === 0 && stableCandidates.length > 0) {
          candidatePool = rankedCandidates.filter(
            (candidate) => !excludedModelIds.has(candidate.model.id)
          );
          this.log.info(
            {
              excludedModelCount: excludedModelIds.size,
              stableCandidateCount: stableCandidates.length,
              rankedCandidateCount: rankedCandidates.length,
            },
            'Stable dynamic candidates exhausted, falling back to ranked candidates'
          );
        }

        if (candidatePool.length === 0) {
          this.log.warn(
            {
              excludedModelCount: excludedModelIds.size,
              rankedCandidateCount: rankedCandidates.length,
            },
            'No dynamic candidates left after exclusions'
          );
        }

        if (context.preferSpeed) {
          candidatePool = [...candidatePool].sort((left, right) => {
            const leftLatency =
              left.realTimePerformance?.latencyMs ??
              left.historicalPerformance?.avgLatency ??
              left.model.performance?.latencyMs ??
              Number.POSITIVE_INFINITY;
            const rightLatency =
              right.realTimePerformance?.latencyMs ??
              right.historicalPerformance?.avgLatency ??
              right.model.performance?.latencyMs ??
              Number.POSITIVE_INFINITY;
            return leftLatency - rightLatency;
          });
        }

        // Get adapter for the selected model
        if (!this.getAdapterForModel) {
          throw new Error('getAdapterForModel not injected by orchestration engine');
        }

        for (const selectedModel of candidatePool.slice(0, 5)) {
          const adapter = await this.getAdapterForModel(selectedModel.model, context);
          if (!adapter) {
            continue;
          }

          this.log.info(
            {
              selectedModel: selectedModel.model.name,
              provider: selectedModel.model.provider,
              score: selectedModel.score,
              reason: selectedModel.reason,
              taskType,
              totalModelsConsidered: models.length,
              modelCapabilities: selectedModel.model.capabilities,
              candidatePoolSize: candidatePool.length,
              usedStablePool: stableCandidates.length > 0,
              preferSpeed: context.preferSpeed,
            },
            'DynamicModelSelector chose optimal model from  available models'
          );

          return { model: selectedModel.model, adapter };
        }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        { error: errorMessage },
        'DynamicModelSelector failed, falling back to local scoring'
      );
    }

    // Fallback to original local scoring if DynamicModelSelector fails
    this.log.warn(
      {
        taskType: ('task_type' in request && typeof request.task_type === 'string' ? request.task_type : undefined) || context.taskType,
        totalModelsAvailable: models.length,
      },
      'Using fallback local scoring - DynamicModelSelector unavailable'
    );

    const selectableModels = models.filter((model) => !excludedModelIds.has(model.id));
    if (selectableModels.length === 0) {
      return null;
    }

    const scoredModels = selectableModels.map((model) => ({
      model,
      score: this.scoreModel(model, request, context),
    }));

    // Sort by score descending
    scoredModels.sort((a, b) => b.score - a.score);

    // Use injected adapter getter
    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected by orchestration engine');
    }

    for (const candidate of scoredModels) {
      if (candidate.score === 0) {
        break;
      }
      const adapter = await this.getAdapterForModel(candidate.model, context);
      if (!adapter) {
        continue;
      }
      return { model: candidate.model, adapter };
    }

    return null;
  }

  /**
   * Score a model for this request
   * Returns 0-1 score, higher is better
   */
  protected scoreModel(model: Model, request: ChatRequest, context: OrchestrationContext): number {
    let score = 0.5; // Base score

    // Check context window
    if (context.contextSize > model.contextWindow) {
      return 0; // Cannot use this model
    }

    // Boost score for models with higher quality
    const qualityScore = Number.isFinite(Number(model.performance?.quality))
      ? Number(model.performance?.quality)
      : 0;
    score += qualityScore * 0.3;

    // Task-specific boosting based on capabilities, not model names
    // 100% dynamic - no hardcoded model names
    switch (context.taskType) {
      case 'code-generation':
      case 'code-review':
      case 'debugging':
      case 'refactoring':
        // Prefer models with code-related capabilities
        if (model.capabilities.includes('code_generation') || model.capabilities.includes('code_interpreter')) {
          score += 0.2;
        }
        if (model.capabilities.includes('function_calling')) {
          score += 0.1; // Bonus for function calling capability
        }
        break;

      case 'analysis':
      case 'documentation':
        // Prefer models with reasoning and analysis capabilities
        if (model.capabilities.includes('reasoning') || model.capabilities.includes('analysis')) {
          score += 0.15;
        }
        // Bonus for high quality models (from performance metrics, not names)
        if (qualityScore > 0.9) {
          score += 0.1;
        }
        break;

      case 'qa':
      case 'general': {
        // Prefer fast models (low latency) and cost-efficient models
        const latencyMs = model.performance?.latencyMs || 0;
        if (latencyMs > 0 && latencyMs < 1000) {
          score += 0.1; // Fast models
        }
        // Cost efficiency bonus (lower cost = higher score)
        const avgCost = (model.inputCostPer1k + model.outputCostPer1k) / 2;
        if (avgCost > 0 && avgCost < 0.01) {
          score += 0.1; // Very cost-efficient models
        }
        break;
      }
    }

    // Check required capabilities
    if (request.tools && request.tools.length > 0) {
      if (!model.capabilities.includes('function_calling')) {
        return 0; // Cannot use this model
      }
      score += 0.1; // Boost for function calling capability
    }

    // Check for vision requirement
    const hasImages = request.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')
    );
    if (hasImages) {
      if (!model.capabilities.includes('vision')) {
        return 0; // Cannot use this model
      }
      score += 0.1;
    }

    // Consider budget
    if (context.budget) {
      const estimatedCost = this.calculateEstimatedCost(
        [model],
        context.contextSize,
        1000 // Assume 1k output tokens
      );

      if (estimatedCost > context.budget) {
        return 0; // Too expensive
      }

      // Prefer models that use budget efficiently
      const budgetUtilization = estimatedCost / context.budget;
      if (budgetUtilization > 0.5 && budgetUtilization < 0.9) {
        score += 0.1;
      }
    }

    // Consider quality target
    if (context.qualityTarget && context.qualityTarget > 0.9) {
      // High quality target - prefer best models
      if (qualityScore >= 0.95) {
        score += 0.2;
      }
    }

    return Math.min(1, score);
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
  private extractRequiredCapabilities(request: ChatRequest, context?: import('@/types').OrchestrationContext): ModelCapability[] | undefined {
    // Start with context-required capabilities if available (from triage or inference).
    // Non-text modalities (image_generation, audio_generation, etc.) override the
    // default chat/text baseline — you can't generate images with a text-only model.
    const NON_TEXT_CAPS = new Set([
      'image_generation', 'image_editing', 'video_generation', 'video_editing',
      'audio_generation', 'text_to_speech', 'vision', 'multimodal', 'computer_use',
    ]);

    const contextCaps = context?.requiredCapabilities ?? [];
    const hasNonTextRequirement = contextCaps.some(cap => NON_TEXT_CAPS.has(cap));

    const capabilities: ModelCapability[] = hasNonTextRequirement
      ? [...contextCaps] as ModelCapability[] // Use context caps directly (no chat/text baseline)
      : ['chat', 'text_generation'];          // Default text baseline

    if (request.stream) {
      capabilities.push('streaming');
    }

    // Check if tools are required (indicates function_calling needed)
    if (request.tools && request.tools.length > 0) {
      capabilities.push('function_calling');
    }

    // Check if messages contain images (indicates vision needed)
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

    return Array.from(new Set(capabilities));
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
    // Determine endpoint based on capabilities and tools
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

    // Default: chat_completions (most common)
    return undefined;
  }
}

