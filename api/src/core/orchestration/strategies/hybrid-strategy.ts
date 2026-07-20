// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 5: Hybrid Execution
 * Combines parallel and sequential approaches for optimal cost-quality balance
 * Smart strategy that adapts based on task complexity
 */

import { BaseStrategy, safeResponseContent, type StrategyMetadata } from '../base-strategy';
import type {
  ChatRequest,
  ChatMessage,
  MessageContent,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
  ChatResponse,
} from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { assembleExecutors, resolvePreferredExecutor } from './preferred-model-helper';

/**
 * Type guard for TextContent
 */
function isTextContent(part: MessageContent): part is { type: 'text'; text: string } {
  return part.type === 'text' && 'text' in part && typeof part.text === 'string';
}

/**
 * Hybrid Strategy
 *
 * Execution Flow:
 * 1. Fast model does initial analysis (cheap)
 * 2. Based on complexity, execute either:
 *    a) Simple: Single premium model
 *    b) Complex: 2 premium models in parallel
 * 3. Select best result
 * 4. Return optimized response
 *
 * Use Cases:
 * - Mixed-complexity workloads
 * - Cost-quality optimization
 * - When complexity is unknown
 * - General-purpose tasks
 *
 * Cost: 1.5-2.5x (adaptive based on complexity)
 * Quality: +15-20% (adaptive quality)
 * Speed: 1.5-2.5x (adaptive)
 */
export class HybridStrategy extends BaseStrategy {
  /**
   * Get strategy metadata
   */
  getMetadata(): StrategyMetadata {
    return {
      id: 'strategy-5',
      name: 'hybrid',
      displayName: 'Hybrid Execution',
      description:
        'Combines sequential and parallel approaches. Analyzes complexity first, then adapts execution strategy for optimal cost-quality balance.',
      minModels: 2,
      maxModels: 3,
      estimatedCostMultiplier: 2.0, // Average of adaptive range
      estimatedQualityBoost: 0.17, // ~17% average
      estimatedDurationMultiplier: 2.0,
      suitableFor: [
        'code-generation',
        'refactoring',
        'debugging',
        'analysis',
        'documentation',
        'general',
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
      'Executing Hybrid strategy'
    );

    // Select models
    const selectedModels = await this.selectModels(request, context);

    if (selectedModels.length < 2) {
      throw new Error('Hybrid strategy requires at least 2 models');
    }

    const analyzer = selectedModels[0]; // Fast model for analysis
    const executors = selectedModels.slice(1); // 1-2 premium models

    this.log.debug(
      {
        analyzer: analyzer.model.name,
        executors: executors.map((m) => m.model.name),
      },
      'Models selected for hybrid execution'
    );

    const executions: ModelExecution[] = [];

    // Observer: start
    this.emitObserverEvent(context, { type: 'phase_start', models: [analyzer.model.name, ...executors.map(e => e.model.name)].filter(Boolean) as string[], summary: 'Hybrid: analyzing complexity then adapting execution.' });

    // PHASE 1: Analyze complexity
    this.log.debug('Phase 1: Complexity analysis');
    const analysisRequest = this.createComplexityAnalysisRequest(request);
    const reasoningEnabled = this.isReasoningEnabled(request);
    const analysisExecution = reasoningEnabled
      ? await this.executeModelWithReasoning(analyzer.adapter, analyzer.model, analysisRequest, 'pre-analyzer')
      : await this.executeModel(analyzer.adapter, analyzer.model, analysisRequest, 'pre-analyzer');
    executions.push(analysisExecution);

    // Determine complexity
    const complexity = analysisExecution.success
      ? this.assessComplexity(analysisExecution.response)
      : 'medium';

    this.log.debug({ complexity }, 'Complexity assessed');

    // PHASE 2: Execute based on complexity
    let finalExecution: ModelExecution;

    if (complexity === 'simple' && executors.length >= 1) {
      // Simple: Use single premium model
      this.log.debug('Phase 2: Simple task - single execution');
      finalExecution = await this.executeModel(executors[0].adapter, executors[0].model, request, 'primary');
      executions.push(finalExecution);
    } else if (complexity === 'complex' && executors.length >= 2) {
      // Complex: Use parallel execution
      this.log.debug('Phase 2: Complex task - parallel execution');

      const parallelExecutions = await this.executeModelsInParallel([
        {
          adapter: executors[0].adapter,
          model: executors[0].model,
          request,
          role: 'primary',
        },
        {
          adapter: executors[1].adapter,
          model: executors[1].model,
          request,
          role: 'secondary',
        },
      ]);

      executions.push(...parallelExecutions);

      // Select best
      finalExecution = this.selectBestExecution(parallelExecutions);
    } else {
      // Default: Use first executor
      this.log.debug('Phase 2: Default - single execution');
      finalExecution = await this.executeModel(executors[0].adapter, executors[0].model, request, 'primary');
      executions.push(finalExecution);
    }

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: `Hybrid: ${complexity} path executed.` });

    if (!finalExecution.success) {
      // Fallback: retry with alternate models before giving up
      const failedModel = executors[0];
      const retryExec = await this.executeModelWithRetry(failedModel.adapter, failedModel.model, request, 'primary', context);
      executions.push(retryExec);
      if (retryExec.success) {
        finalExecution = retryExec;
      } else {
        throw new Error('Execution failed');
      }
    }

    const totalDuration = Date.now() - startTime;
    const totalCost = Math.max(0, executions.reduce((sum, e) => sum + (e.cost || 0), 0));

    // Calculate quality (hybrid gets adaptive boost)
    const baseQuality = this.calculateQualityScore(finalExecution);
    const qualityBoost = complexity === 'complex' ? 1.2 : 1.15;
    const qualityScore = Math.min(1, baseQuality * qualityBoost);

    const result: OrchestrationResult = {
      strategyUsed: metadata.name,
      modelsUsed: executions,
      finalResponse: {
        ...finalExecution.response,
        model: request.model || 'Ailin¹ Model',
      },
      totalCost,
      totalDuration,
      qualityScore,
      metadata: {
        strategyId: metadata.id,
        modelCount: selectedModels.length,
        executionCount: executions.length,
        complexity,
        executionMode:
          complexity === 'simple' ? 'single' : complexity === 'complex' ? 'parallel' : 'default',
        ...(this.isReasoningEnabled(request) && executions.some(e => e.reasoning)
          ? { reasoning_traces: executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) }
          : {}),
      },
    };

    this.log.info(
      {
        strategy: metadata.name,
        requestId: context.requestId,
        complexity,
        executionMode: result.metadata.executionMode,
        duration: totalDuration,
        cost: totalCost,
        qualityScore,
      },
      'Hybrid strategy completed'
    );

    return result;
  }

  /**
   * Select models: 1 fast analyzer + 1-2 premium executors
   *
   * Caminho-C Q2 closure: when the user supplied an explicit model (now
   * carried on `context.preferredModelIds[0]` by buildContext), pin it as
   * the primary executor instead of letting quality-sort pick something
   * else. The analyzer is still selected by latency+cost — that's a
   * complexity-classification step which doesn't need to be "the user's
   * choice", and using a cheap+fast analyzer for that step is exactly the
   * point of the hybrid strategy. We just stop silently substituting the
   * user's executor.
   */
  private async selectModels(
    request: ChatRequest,
    context: OrchestrationContext
  ): Promise<Array<{ model: Model; adapter: ProviderAdapter }>> {
    const { models } = context;

    // Select fast analyzer
    const analyzer = models
      .filter((m) => m.performance.latencyMs < 2000)
      .sort((a, b) => a.inputCostPer1k - b.inputCostPer1k)[0];

    if (!analyzer) {
      return [];
    }

    // Caminho-C Q2 (extended 2026-04-29): honor user-specified executor via
    // the shared `resolvePreferredExecutor` helper. The helper encodes the
    // exact contract: if `context.preferredModelIds[0]` is set AND the
    // pinned model is in the operational pool AND not in `excludeIds`, it
    // becomes the primary executor; otherwise we fall through to legacy
    // quality-sort selection so the user still gets an answer rather than
    // a 404. The same helper is the canonical pattern for every multi-
    // model strategy (see preferred-model-honor-coverage.test.ts).
    const preference = resolvePreferredExecutor(models, context, [analyzer.id]);

    if (preference.pinReason === 'pin-not-in-pool') {
      // The user pinned a model but it isn't in the operational pool —
      // filtered for health/balance/capability gates, typo, or wrong
      // namespace. Log the substitution so it isn't silent; the
      // response itself still proceeds with the quality-sorted fallback.
      this.log.warn(
        {
          requestId: context.requestId,
          requestedModel: preference.requestedId,
          analyzerId: analyzer.id,
          poolSize: models.length,
        },
        'Hybrid strategy: requested model not in operational pool — falling back to quality-sort selection',
      );
    } else if (preference.pinReason === 'pin-collision-excluded') {
      // The pinned model collided with the analyzer pick. The user's
      // intent is preserved at the analyzer slot (so the model still
      // runs) but we note that it didn't apply at the executor slot.
      this.log.info(
        {
          requestId: context.requestId,
          requestedModel: preference.requestedId,
          analyzerId: analyzer.id,
        },
        'Hybrid strategy: requested model already serving as analyzer — executor picks via quality-sort',
      );
    }

    const executors = assembleExecutors(
      preference,
      2,
      (a, b) => b.performance.quality - a.performance.quality,
    );

    if (executors.length === 0) {
      return [];
    }

    // Get adapters
    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected by orchestration engine');
    }
    const allModels = [analyzer, ...executors];
    const adapters = await Promise.all(
      allModels.map((m) => this.getAdapterForModel!(m, context))
    );

    return allModels
      .map((model, i) => ({ model, adapter: adapters[i] }))
      .filter((m): m is { model: Model; adapter: ProviderAdapter } => 
        m.adapter !== null && m.adapter !== undefined
      );
  }

  /**
   * Create complexity analysis request
   */
  private createComplexityAnalysisRequest(originalRequest: ChatRequest): ChatRequest {
    const lastMessage = originalRequest.messages[originalRequest.messages.length - 1];
    const userContent =
      typeof lastMessage.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);

    const analysisMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'Analyze task complexity. Answer SIMPLE, MEDIUM, or COMPLEX based on: code complexity, dependencies, testing needs, and potential edge cases.',
      },
      {
        role: 'user',
        content: `Analyze complexity of this task:\n${userContent}\n\nAnswer: SIMPLE, MEDIUM, or COMPLEX`,
      },
    ];

    return {
      ...originalRequest,
      messages: analysisMessages,
      max_tokens: 50,
      temperature: 0.1,
    };
  }

  /**
   * Assess complexity from analysis response
   */
  private assessComplexity(analysisResponse: ChatResponse): 'simple' | 'medium' | 'complex' {
    const message = analysisResponse.choices[0]?.message;
    if (!message) return 'medium';
    
    let content = '';
    if (typeof message.content === 'string') {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      content = message.content
        .map((part: MessageContent) => {
          if (isTextContent(part)) {
            return part.text;
          }
          return '';
        })
        .join('');
    }
    const contentUpper = content.toUpperCase();

    if (contentUpper.includes('SIMPLE')) return 'simple';
    if (contentUpper.includes('COMPLEX')) return 'complex';
    return 'medium';
  }

  /**
   * Create review request
   */
  private createReviewRequest(originalRequest: ChatRequest, response: ChatResponse): ChatRequest {
    const content = safeResponseContent(response);

    return {
      ...originalRequest,
      messages: [
        {
          role: 'system',
          content: 'Review this solution briefly. List issues or say OK.',
        },
        {
          role: 'user',
          content: `Solution:\n${content}`,
        },
      ],
      max_tokens: 200,
    };
  }

  /**
   * Create refinement request
   */
  private createRefinementRequest(
    originalRequest: ChatRequest,
    primaryResponse: ChatResponse,
    reviewResponse: ChatResponse
  ): ChatRequest {
    const primary = safeResponseContent(primaryResponse);
    const review = safeResponseContent(reviewResponse);

    return {
      ...originalRequest,
      messages: [
        ...originalRequest.messages,
        {
          role: 'assistant',
          content: primary,
        },
        {
          role: 'system',
          content: `Feedback: ${review}\n\nRefine your solution.`,
        },
      ],
    };
  }

  /**
   * Create validation request
   */
  private createValidationRequest(originalRequest: ChatRequest, finalResponse: ChatResponse): ChatRequest {
    const content = safeResponseContent(finalResponse);

    return {
      ...originalRequest,
      messages: [
        {
          role: 'system',
          content: 'Validate quality. Answer: PASS or FAIL with one-line reason.',
        },
        {
          role: 'user',
          content: `Validate:\n${content}`,
        },
      ],
      max_tokens: 50,
    };
  }

  /**
   * Select best execution from multiple
   */
  private selectBestExecution(executions: ModelExecution[]): ModelExecution {
    const successful = executions.filter((e) => e.success);

    if (successful.length === 0) {
      throw new Error('No successful executions');
    }

    if (successful.length === 1) {
      return successful[0];
    }

    // Score and select best
    const scored = successful.map((e) => ({
      execution: e,
      score: this.calculateQualityScore(e),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored[0].execution;
  }
}
