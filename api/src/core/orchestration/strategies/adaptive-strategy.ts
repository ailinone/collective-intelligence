// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import { resolvePreferredExecutor } from './preferred-model-helper';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
} from '@/types';
import { autoLearningSystem } from '@/core/learning/auto-learning-system';

/**
 * Adaptive Routing Strategy
 *
 * Routes to the best-performing strategy based on learned execution data.
 * When the learning system has sufficient data (sample_count >= 5) for the
 * current (task_type, complexity) pair, it uses the empirically best strategy.
 * Falls back to heuristic rules when no learned data is available.
 *
 * Best for: General tasks where historical execution data can guide selection
 */
export class AdaptiveStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'adaptive',
      name: 'adaptive',
      displayName: 'Adaptive Routing',
      description:
        'Routes to the empirically best strategy based on learned execution data. Falls back to heuristics when no data is available.',
      minModels: 2,
      maxModels: 5,
      estimatedCostMultiplier: 1.5,
      estimatedQualityBoost: 0.15,
      estimatedDurationMultiplier: 1.2,
      suitableFor: ['general', 'code-generation', 'analysis'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();

    // Observer: start
    this.emitObserverEvent(context, { type: 'phase_start', summary: 'Adaptive: analyzing request to select best strategy.' });

    // 1. Analyze request characteristics
    const analysis = this.analyzeRequest(request);

    // 2. Try learning-driven recommendation first
    const recommendation = await autoLearningSystem.getStrategyRecommendation(
      analysis.type,
      analysis.complexity
    );

    let selectedStrategy: string;
    let selectionMethod: 'learning' | 'heuristic';

    if (recommendation && recommendation.confidence >= 0.3) {
      selectedStrategy = recommendation.strategy;
      selectionMethod = 'learning';

      // Dynamic quorum (Quorum Sensing): when confidence is moderate (0.3-0.6),
      // prefer multi-model strategies over single-model for robustness
      const QUORUM_ESCALATION_THRESHOLD = Number(process.env.ADAPTIVE_QUORUM_THRESHOLD ?? 0.6);
      if (recommendation.confidence < QUORUM_ESCALATION_THRESHOLD && selectedStrategy === 'single') {
        // Low confidence on "single" = high uncertainty. Escalate to collective.
        selectedStrategy = analysis.complexity === 'complex' ? 'collaborative' : 'consensus';
        this.log.info(
          {
            originalStrategy: 'single',
            escalatedTo: selectedStrategy,
            confidence: recommendation.confidence,
            reason: 'Dynamic quorum: low confidence single → collective escalation',
          },
          'Adaptive: quorum escalation triggered'
        );
      }

      this.log.debug(
        {
          strategy: selectedStrategy,
          confidence: recommendation.confidence,
          expectedQuality: recommendation.expectedQuality,
          sampleSize: recommendation.sampleSize,
          taskType: analysis.type,
          complexity: analysis.complexity,
        },
        'Using learning-driven strategy recommendation'
      );
    } else {
      selectedStrategy = this.selectHeuristicStrategy(analysis, context);
      selectionMethod = 'heuristic';
    }

    // 3. Execute with selected strategy
    const execution = await this.executeWithStrategy(request, context, selectedStrategy);

    const duration = Date.now() - startTime;

    return {
      strategyUsed: this.getMetadata().name,
      modelsUsed: execution.modelsUsed,
      finalResponse: execution.response,
      totalCost: execution.cost,
      totalDuration: duration,
      qualityScore: execution.qualityScore,
      metadata: {
        requestAnalysis: analysis,
        selectedSubStrategy: selectedStrategy,
        selectionMethod,
        learningConfidence: recommendation?.confidence ?? 0,
        learningExpectedQuality: recommendation?.expectedQuality ?? null,
        learningSampleSize: recommendation?.sampleSize ?? 0,
        adaptiveReason:
          selectionMethod === 'learning'
            ? `Learning-driven: ${selectedStrategy} (${recommendation!.sampleSize} samples, confidence ${(recommendation!.confidence * 100).toFixed(0)}%)`
            : `Heuristic: ${selectedStrategy} based on ${analysis.complexity} complexity and ${analysis.type} type`,
        ...(execution.modelsUsed.some(e => e.reasoning)
          ? { reasoning_traces: execution.modelsUsed.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) }
          : {}),
      },
    };
  }

  /**
   * Analyze request characteristics
   */
  private analyzeRequest(request: ChatRequest): {
    complexity: 'simple' | 'moderate' | 'complex';
    type: string;
    size: number;
  } {
    const content = this.getLastUserMessage(request);
    const words = content.split(/\s+/).length;

    let complexity: 'simple' | 'moderate' | 'complex' = 'simple';
    if (words > 100 || /architecture|system|design|refactor/i.test(content)) {
      complexity = 'complex';
    } else if (words > 30 || /analyze|review|improve/i.test(content)) {
      complexity = 'moderate';
    }

    let type = 'general';
    if (/code|function|class|implement/i.test(content)) type = 'code-generation';
    if (/review|analyze|check/i.test(content)) type = 'analysis';
    if (/bug|error|fix|debug/i.test(content)) type = 'debugging';

    return { complexity, type, size: words };
  }

  /**
   * Heuristic fallback when no learned data is available
   */
  private selectHeuristicStrategy(
    analysis: { complexity: string; type: string; size: number },
    context: OrchestrationContext
  ): string {
    // Data-driven heuristic (based on frozen benchmark results):
    // - debate: 0.780 avg quality, best absolute performer (14/18 perfect scores)
    // - consensus: 0.863 avg but 11% success rate (fragile)
    // - collaborative: 0.663 avg, 4% success (unreliable)
    // - single: fast but lower quality in complex tasks
    //
    // Strategy: use debate for complex tasks (proven best), single for simple,
    // blind-debate for reasoning/factual tasks (independence matters)

    if (context.budget && context.budget < 0.005) return 'cost-cascade';

    // P0 strategies: route based on quality target and modality
    const qualityTarget = context.qualityTarget ?? 0;
    if (qualityTarget >= 0.9 && analysis.complexity !== 'simple') return 'critique-repair';
    if (analysis.type === 'factual-qa' && analysis.complexity === 'complex') return 'research-synthesize';

    if (analysis.complexity === 'complex') {
      // Complex tasks benefit most from multi-model deliberation
      if (analysis.type === 'reasoning' || analysis.type === 'factual-qa') return 'blind-debate';
      return 'debate';
    }

    if (analysis.complexity === 'moderate') {
      if (analysis.type === 'creative') return 'diversity-ensemble';
      if (analysis.type === 'documentation') return 'stigmergic-refinement';
      if (context.budget && context.budget < 0.01) return 'cost-cascade';
      return 'debate';
    }

    // Simple tasks: single model is sufficient and faster
    return 'single';
  }

  /**
   * Delegate execution to the real sub-strategy.
   * Falls back to a direct single-model call only when the sibling strategy is unavailable.
   */
  private async executeWithStrategy(
    request: ChatRequest,
    context: OrchestrationContext,
    strategyName: string
  ): Promise<{
    response: ChatResponse;
    cost: number;
    qualityScore: number;
    modelsUsed: ModelExecution[];
  }> {
    // Try to resolve the actual strategy and delegate
    const sibling = this.getSiblingStrategy?.(strategyName);
    if (sibling) {
      this.log.debug({ delegateTo: strategyName }, 'Adaptive delegating to real sub-strategy');
      const result = await sibling.execute(request, context);
      return {
        response: result.finalResponse,
        cost: result.totalCost,
        qualityScore: result.qualityScore ?? 0.8,
        modelsUsed: result.modelsUsed,
      };
    }

    // Fallback: sibling not found (should not happen in production).
    // Pin biases the single-model decision here. Helper resolves the
    // pin if eligible; otherwise we fall back to highest-quality.
    this.log.warn({ strategyName }, 'Sibling strategy not found — falling back to direct model call');
    const eligible = this.getEligibleModels(context);
    const preference = resolvePreferredExecutor(eligible, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      this.log.warn(
        {
          attempted: context.preferredModelIds?.[0],
          reason: preference.pinReason,
        },
        'Preferred model not eligible for adaptive fallback — using highest-quality.',
      );
    }
    const model = preference.pinnedExecutor ?? this.selectBestModel(eligible);
    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected by orchestration engine');
    }
    const adapter = await this.getAdapterForModel(model, context);
    if (!adapter) {
      throw new Error(`No adapter found for model: ${model.id}`);
    }

    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    const reasoningEnabled = this.isReasoningEnabled(request);
    const execution = hasTools
      ? await this.executeModelWithTools(adapter, model, request, 'primary')
      : reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, model, request, 'primary')
        : await this.executeModel(adapter, model, request, 'primary');

    return {
      response: execution.response,
      cost: execution.cost,
      qualityScore: 0.8,
      modelsUsed: [execution],
    };
  }

  private selectBestModel(models: Model[]): Model {
    return [...models].sort((a, b) => {
      const aQuality = a.performance?.quality || 0.8;
      const bQuality = b.performance?.quality || 0.8;
      return bQuality - aQuality;
    })[0];
  }

  private getLastUserMessage(request: ChatRequest): string {
    const userMessages = request.messages.filter((m) => m.role === 'user');
    const lastMessage = userMessages[userMessages.length - 1];
    const content = lastMessage?.content || '';
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
}
