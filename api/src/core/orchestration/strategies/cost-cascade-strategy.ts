// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import { resolvePreferredExecutor, assembleExecutors } from './preferred-model-helper';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
  ModelRole,
} from '@/types';

/**
 * Cost-Optimized Cascade Strategy
 *
 * Tries cheaper models first, escalates to expensive ones only if needed.
 * Maximizes cost savings while ensuring quality requirements are met.
 *
 * Best for: Cost-sensitive tasks with flexible quality requirements
 *
 * Process:
 * 1. Sort models by cost (cheapest first)
 * 2. Try cheapest model
 * 3. Evaluate quality of response
 * 4. If quality sufficient → Done (massive savings)
 * 5. If quality insufficient → Escalate to next tier
 * 6. Continue until quality threshold met or budget exhausted
 *
 * Quality Evaluation:
 * - Length (comprehensive responses preferred)
 * - Structure (code blocks, lists, headers)
 * - Completeness (addresses all aspects of request)
 * - Confidence indicators (hedging language vs confident)
 *
 * Example Flow:
 * 1. Try DeepSeek Chat ($0.00014/1k) → Quality: 0.75 (good enough) → Done!
 * 2. If not: Try Gemini Flash ($0.000075/1k) → Quality: 0.82 → Done!
 * 3. If not: Try GPT-4o Mini ($0.00015/1k) → Quality: 0.87 → Done!
 * 4. Last resort: GPT-4o ($0.005/1k) → Quality: 0.95 → Done
 *
 * Typical Savings: 70-95% cost reduction vs always using premium models
 */
export class CostCascadeStrategy extends BaseStrategy {
  private readonly QUALITY_THRESHOLD_BASE = 0.7; // Minimum acceptable quality
  private readonly QUALITY_INCREMENT = 0.05; // Quality must improve by this much to justify cost

  getMetadata(): StrategyMetadata {
    return {
      id: 'cost-cascade',
      name: 'cost-cascade',
      displayName: 'Cost-Optimized Cascade',
      description:
        'Try cheap models first, escalate to expensive ones only if needed. Optimizes for maximum cost savings while meeting quality requirements.',
      minModels: 2, // Need at least 2 tiers
      maxModels: 5, // Up to 5 escalation tiers
      estimatedCostMultiplier: 0.3, // 70% savings on average
      estimatedQualityBoost: 0.0, // Quality varies (meets threshold)
      estimatedDurationMultiplier: 1.3, // Slightly slower (multiple attempts)
      suitableFor: ['general', 'code-generation', 'documentation', 'analysis', 'qa'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const models = this.getEligibleModels(context);

    if (models.length < this.getMetadata().minModels!) {
      throw new Error(
        `Cost Cascade requires at least ${this.getMetadata().minModels} models (${models.length} available)`
      );
    }

    // 1. Sort models by cost (cheapest first), honoring user pin if any.
    //    Caminho-C Q2 cross-strategy honor (2026-04-29): if the user
    //    pinned a model via request.model, that model becomes the FIRST
    //    cascade attempt — even if it's expensive — because the user's
    //    intent overrides cost optimization. The escalation logic still
    //    applies: if pinned model fails the quality threshold, the
    //    cascade continues through the remaining cost-sorted candidates.
    //    If pinned id isn't in the operational pool, log warn and fall
    //    through to legacy cost-only sort.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      this.log.warn(
        {
          requestId: context.requestId,
          requestedModel: preference.requestedId,
          poolSize: models.length,
        },
        'Cost cascade: requested model not in operational pool — falling back to cost-sort cascade',
      );
    }
    // Cap cascade depth at the strategy's declared maxModels (2026-07-04,
    // c3-v4 defect C): the cascade used to walk the ENTIRE eligible pool
    // sequentially — with hub models tying at $0 the cost-sort degenerates to
    // pool order, and two dead rungs (~180s each through adapter retries)
    // already blow any client budget. 5 bounded rungs either reach a live
    // model or fail fast.
    const maxRungs = Math.min(models.length, this.getMetadata().maxModels ?? 5);
    const sortedModels = assembleExecutors(
      preference,
      maxRungs,
      (a, b) => this.effectiveCost(a) - this.effectiveCost(b),
    );

    // 2. Determine quality threshold
    const qualityThreshold = context.qualityTarget || this.QUALITY_THRESHOLD_BASE;

    // Observer: start
    this.emitObserverEvent(context, { type: 'phase_start', models: sortedModels.slice(0, 3).map(m => m.name || m.id), summary: `Cost cascade: trying cheapest first, escalating if needed.` });

    // 3. Cascade through models until quality met
    interface ExecutionAttempt {
      model: Model;
      modelId: string;
      modelName: string;
      response: ChatResponse;
      startTime: number;
      endTime: number;
      duration: number;
      cost: number;
      durationMs: number;
      success: boolean;
      qualityScore?: number;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      error?: string;
    }
    const attempts: ExecutionAttempt[] = [];
    let bestExecution: ExecutionAttempt | null = null;
    let qualityMet = false;

    for (const model of sortedModels) {
      // Try this model
      const execution = await this.tryModel(model, request, context);
      attempts.push(execution);

      // Evaluate quality - convert to ModelExecution for calculateQualityScore
      const modelExecution: ModelExecution = {
        modelId: execution.modelId,
        modelName: execution.modelName,
        role: 'primary',
        request,
        response: execution.response,
        cost: execution.cost,
        durationMs: execution.durationMs,
        success: execution.success,
        error: execution.error,
      };
      const qualityScore = this.calculateQualityScore(modelExecution);
      execution.qualityScore = qualityScore;

      // Only consider successful executions
      if (!execution.success) {
        continue; // Skip failed executions
      }

      // Check if quality threshold met
      if (qualityScore >= qualityThreshold) {
        bestExecution = execution;
        qualityMet = true;
        this.log.info(
          {
            model: model.id,
            qualityScore,
            qualityThreshold,
            cost: execution.cost,
            attemptNumber: attempts.length,
          },
          'Quality threshold met, stopping cascade'
        );
        break;
      }

      // Check if improvement justifies next tier
      if (bestExecution) {
        const improvement = qualityScore - (bestExecution.qualityScore || 0);
        const costIncrease = execution.cost - bestExecution.cost;

        this.log.info(
          {
            model: model.id,
            qualityScore,
            improvement,
            costIncrease,
          },
          'Evaluating next tier'
        );
      }

      // Track best so far (only successful executions)
      if (!bestExecution || qualityScore > (bestExecution.qualityScore || 0)) {
        bestExecution = execution;
      }

      // Stop if budget exhausted
      const totalCost = attempts.reduce((sum, exec) => sum + exec.cost, 0);
      if (context.budget && totalCost >= context.budget) {
        this.log.warn(
          {
            totalCost,
            budget: context.budget,
          },
          'Budget exhausted, stopping cascade'
        );
        break;
      }
    }

    if (!bestExecution) {
      throw new Error('No successful executions in cost cascade');
    }

    // 4. Calculate metrics
    const duration = Date.now() - startTime;
    const totalCost = attempts.reduce((sum, exec) => sum + exec.cost, 0);
    const avgCost = totalCost / attempts.length;

    // Calculate savings vs premium model
    const premiumModel = sortedModels[sortedModels.length - 1]; // Most expensive
    const premiumCost = this.estimateCost(
      premiumModel,
      bestExecution.usage.prompt_tokens,
      bestExecution.usage.completion_tokens
    );
    const savingsPercent = premiumCost > 0 ? ((premiumCost - totalCost) / premiumCost) * 100 : 0;

    const allExecutions: ModelExecution[] = attempts.map((exec) => {
      const role: ModelRole = exec === bestExecution ? 'primary' : 'secondary';
      const execution: ModelExecution = {
        modelId: exec.model.id,
        modelName: exec.model.name,
        role,
        request,
        response: exec.response,
        cost: exec.cost,
        durationMs: exec.durationMs,
        success: exec.success,
      };
      if (exec.error) {
        execution.error = exec.error;
      }
      return execution;
    });

    return {
      strategyUsed: this.getMetadata().name,
      modelsUsed: allExecutions,
      finalResponse: bestExecution.response,
      totalCost,
      totalDuration: duration,
      qualityScore: bestExecution.qualityScore || 0,
      metadata: {
        cascadeLevels: attempts.length,
        qualityThreshold,
        qualityMet,
        bestModel: bestExecution.model.id,
        bestQualityScore: bestExecution.qualityScore,
        avgCostPerAttempt: avgCost,
        totalSavings: premiumCost - totalCost,
        savingsPercent: Math.round(savingsPercent * 100) / 100,
        premiumModelCost: premiumCost,
        allAttempts: attempts.map((exec) => ({
          model: exec.modelId || exec.model?.id || 'unknown',
          qualityScore: exec.qualityScore || 0,
          cost: exec.cost,
          success: exec.success,
        })),
        ...(this.isReasoningEnabled(request) && allExecutions.some(e => e.reasoning)
          ? { reasoning_traces: allExecutions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) }
          : {}),
      },
    };
  }

  /**
   * Sort models by cost (cheapest first).
   *
   * Important: `cost = 0` is AMBIGUOUS in this codebase — it means either:
   *   1. Genuinely free (local / self-hosted / ollama)
   *   2. Missing pricing metadata (common on cloud hub variants where the
   *      discovery step didn't populate input/output prices)
   *
   * Treating case (2) as "cheapest" was the root cause of hubs with ZEROED
   * OUT accounts being tried first while native providers with real pricing
   * (and real credit) never got a chance. The cascade would exhaust itself
   * on HTTP 402/403 from all dead hubs before reaching the working native.
   *
   * Fix: keep case (1) at the top (truly free = preferred), but push case
   * (2) to the BOTTOM (unknown cost = treat as expensive until proven
   * otherwise). Case (1) is detected by the provider name — self-hosted,
   * local, ollama all indicate actually-free models.
   */
  private sortModelsByCost(models: Model[]): Model[] {
    return [...models].sort((a, b) => {
      const aCost = this.effectiveCost(a);
      const bCost = this.effectiveCost(b);
      return aCost - bCost;
    });
  }

  private effectiveCost(model: Model): number {
    const rawCost = (Number(model.inputCostPer1k) + Number(model.outputCostPer1k)) / 2;
    if (rawCost > 0) return rawCost;
    // Ambiguous zero — decide based on provider type.
    const provider = (model.provider || '').toLowerCase();
    const isTrulyFree =
      provider === 'self-hosted' ||
      provider === 'ollama' ||
      provider.startsWith('local-') ||
      provider.includes('local');
    if (isTrulyFree) return 0;
    // Unknown-cost cloud model — push to the bottom of the cascade so
    // models with real pricing (and, usually, real credit) are tried first.
    return Number.MAX_SAFE_INTEGER;
  }

  /**
   * Try a single model
   * Returns internal execution format with extra fields
   */
  private async tryModel(
    model: Model,
    request: ChatRequest,
    context: OrchestrationContext
  ): Promise<{
    model: Model;
    modelId: string;
    modelName: string;
    response: ChatResponse;
    startTime: number;
    endTime: number;
    duration: number;
    cost: number;
    durationMs: number;
    success: boolean;
    qualityScore?: number;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    error?: string;
  }> {
    const execStart = Date.now();

    try {
      if (!this.getAdapterForModel) {
        throw new Error('getAdapterForModel not injected by orchestration engine');
      }
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) {
        throw new Error(`No adapter found for model: ${model.id}`);
      }
      const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
      const reasoningEnabled = this.isReasoningEnabled(request);
      // Per-rung deadline (2026-07-04, c3-v4 defect C): the cascade is
      // SEQUENTIAL, so an unbounded rung rides the adapter's internal
      // ~60s×3-retry budget (~180s) and one dead route burns the caller's
      // whole window (all 32 normal-task cost-cascade rows timed out at
      // ~300s with $0). boundModelExecution returns a failed ModelExecution
      // on timeout; hasUsableAssistantResponse below then escalates to the
      // next rung. Worst case: maxRungs × collectiveModelTimeoutMs.
      const exec = await this.boundModelExecution(
        () =>
          hasTools
            ? this.executeModelWithTools(adapter, model, request, 'primary')
            : reasoningEnabled
              ? this.executeModelWithReasoning(adapter, model, request, 'primary')
              : this.executeModel(adapter, model, request, 'primary'),
        { adapter, model, request, role: 'primary' },
        this.collectiveModelTimeoutMs(),
      );
      const response = exec.response;
      const execEnd = Date.now();
      const usage = {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
      };
      const cost = Math.max(
        0,
        adapter.calculateCost(model, usage.prompt_tokens, usage.completion_tokens)
      );
      const hasUsableResponse = this.hasUsableAssistantResponse(response);
      const executionError = hasUsableResponse
        ? undefined
        : 'Provider returned empty assistant response';

      // Internal execution format
      const execution = {
        model,
        modelId: model.id,
        modelName: model.name,
        response,
        startTime: execStart,
        endTime: execEnd,
        duration: execEnd - execStart,
        usage,
        cost,
        durationMs: execEnd - execStart,
        success: hasUsableResponse,
        error: executionError,
        qualityScore: 0, // Will be set later
      };

      return execution;
    } catch (error: unknown) {
      const execEnd = Date.now();
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.log.error(
        {
          model: model.id,
          error: errorMessage,
        },
        'Model execution failed in cascade'
      );

      // Internal execution format for errors
      const errorObj = error instanceof Error ? error : new Error(errorMessage);
      const execution = {
        model,
        modelId: model.id,
        modelName: model.name,
        response: this.createErrorResponse(model, errorObj),
        startTime: execStart,
        endTime: execEnd,
        duration: execEnd - execStart,
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
        cost: 0,
        durationMs: execEnd - execStart,
        success: false,
        error: errorMessage,
        qualityScore: 0,
      };

      return execution;
    }
  }

  /**
   * Estimate cost for a model
   */
  private estimateCost(model: Model, inputTokens: number, outputTokens: number): number {
    const inputRate = Math.max(0, Number(model.inputCostPer1k) || 0);
    const outputRate = Math.max(0, Number(model.outputCostPer1k) || 0);
    const cost = (inputTokens / 1000) * inputRate
               + (outputTokens / 1000) * outputRate;
    return Math.max(0, cost);
  }

  /**
   * Create error response
   */
  private createErrorResponse(model: Model, error: Error): ChatResponse {
    return {
      id: `error-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model.id,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `Error: ${error.message}`,
          },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }
}
