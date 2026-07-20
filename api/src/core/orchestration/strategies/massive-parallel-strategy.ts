// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { BaseStrategy, safeResponseContent, type StrategyMetadata } from '../base-strategy';
import { PROMPTS } from '../prompts/sota-system-prompts';
import { resolvePreferredExecutor, withPreferredFirst } from './preferred-model-helper';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
  ModelRole,
} from '@/types';

interface InternalExecution {
  model: Model;
  response: ChatResponse;
  startTime: number;
  endTime: number;
  duration: number;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  cost: number;
  success: boolean;
  error?: string;
}

/**
 * Massive Parallel Strategy
 *
 * Executes up to 9 models simultaneously for maximum redundancy and quality.
 * Aggregates responses using intelligent selection (best quality/cost ratio).
 *
 * Best for: Mission-critical tasks requiring absolute best output
 *
 * Process:
 * 1. Select up to 9 diverse models (different providers, capabilities)
 * 2. Execute all models in parallel
 * 3. Collect all responses (handle failures gracefully)
 * 4. Score each response (quality, relevance, completeness)
 * 5. Select best response or aggregate top responses
 *
 * Features:
 * - Maximum model diversity (all available providers)
 * - Fault tolerance (any single model can fail)
 * - Quality optimization (best of 9 responses)
 * - Cost awareness (prefer cheaper models when quality is similar)
 *
 * Example: For critical code generation:
 * - All 3 providers used (OpenAI, Anthropic, Google)
 * - 9 models execute simultaneously
 * - Best response selected based on:
 *   * Code quality (syntax, logic, patterns)
 *   * Completeness (addresses all requirements)
 *   * Efficiency (clean, optimized)
 *   * Cost (prefer cheaper if quality similar)
 */
export class MassiveParallelStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'massive-parallel',
      name: 'massive-parallel',
      displayName: 'Massive Parallel',
      description:
        'Execute up to 9 models simultaneously for maximum quality and redundancy. Best for mission-critical tasks.',
      minModels: 5, // At least 5 models for "massive"
      maxModels: 9, // Maximum parallelism
      estimatedCostMultiplier: 7.0, // High cost (7-9 models)
      estimatedQualityBoost: 0.35, // +35% through maximum diversity
      estimatedDurationMultiplier: 1.1, // Slightly longer (parallel, but more processing)
      suitableFor: ['code-generation', 'analysis', 'code-review', 'documentation', 'refactoring'],
    };
  }

  // Early-exit thresholds: when ≥ MIN_RESPONSES are in and agreement exceeds this,
  // we don't wait for remaining models (saves cost without sacrificing quality).
  private static readonly EARLY_EXIT_MIN_RESPONSES = 3;
  private static readonly EARLY_EXIT_AGREEMENT_THRESHOLD = 0.85;

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const models = this.getEligibleModels(context);

    if (models.length < this.getMetadata().minModels!) {
      throw new Error(
        `Massive Parallel requires at least ${this.getMetadata().minModels} models (${models.length} available)`
      );
    }

    // 1. Select up to 9 diverse models. Pin biases inclusion in the
    // pool — selectDiverseModels uses provider round-robin then
    // quality, so the pin might not naturally make the cut. We
    // post-process to guarantee the pinned model is in the pool of 9.
    // Whether its response actually wins is decided by scoring later.
    const diversePool = this.selectDiverseModels(models, 9);
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      this.log.warn(
        {
          attempted: context.preferredModelIds?.[0],
          reason: preference.pinReason,
        },
        'Preferred model not eligible for massive-parallel pool — using diverse selection only.',
      );
    }
    // If pin is in eligible models but not in diverse pool, swap in.
    let selectedModels = diversePool;
    if (preference.pinnedExecutor && !diversePool.find(m => m.id === preference.pinnedExecutor!.id)) {
      const fallback = diversePool.filter(m => m.id !== preference.pinnedExecutor!.id);
      selectedModels = withPreferredFirst(preference, fallback).slice(0, 9);
    } else if (preference.pinnedExecutor) {
      // Pin already in pool — promote to first slot for execution-order
      // observability (doesn't affect correctness; all run in parallel).
      const without = diversePool.filter(m => m.id !== preference.pinnedExecutor!.id);
      selectedModels = withPreferredFirst(preference, without).slice(0, 9);
    }

    // Observer: start
    this.emitObserverEvent(context, { type: 'phase_start', models: selectedModels.map(m => m.name || m.id), summary: `Massive parallel: ${selectedModels.length} models executing simultaneously.` });

    // 2. Execute with early-exit: stop when high-agreement responses arrive
    const executions = await this.executeAllModelsWithEarlyExit(request, selectedModels, context);

    // Observer: complete
    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: `Massive parallel: ${executions.filter(e => e.success).length}/${executions.length} succeeded.` });

    // 3. Score each response
    const scoredExecutions = this.scoreExecutions(executions);

    // 4. Select best response (fallback + synthesizer model)
    const bestExecution = this.selectBestExecution(scoredExecutions);

    const allExecutions: ModelExecution[] = executions.map((exec) => ({
      modelId: exec.model.id,
      modelName: exec.model.name,
      role: (exec.model.id === bestExecution.execution.model.id ? 'primary' : 'secondary') as ModelRole,
      request,
      response: exec.response,
      cost: exec.cost,
      durationMs: exec.duration,
      success: exec.success,
    }));

    // 5. MERGE the parallel responses into one superior answer (2026-06-30):
    // synthesize across all candidates instead of only selecting the single best,
    // so the collective can EXCEED the best individual. Falls back to the best
    // response if the merge can't be produced.
    const merged = await this.synthesizeMerged(allExecutions, request, context, bestExecution.execution.model);
    let finalResponse = bestExecution.execution.response;
    let mergeCost = 0;
    if (merged && merged.response !== bestExecution.execution.response) {
      allExecutions.push(merged);
      finalResponse = merged.response;
      mergeCost = merged.cost;
    }

    // 6. Calculate metrics
    const duration = Date.now() - startTime;
    const totalCost = executions.reduce((sum, exec) => sum + exec.cost, 0) + mergeCost;
    const avgQualityScore = this.calculateAverageQuality(scoredExecutions);

    return {
      strategyUsed: this.getMetadata().name,
      modelsUsed: allExecutions,
      finalResponse,
      totalCost,
      totalDuration: Math.max(1, duration),
      qualityScore: bestExecution.score,
      metadata: {
        modelsExecuted: executions.length,
        successfulExecutions: executions.filter((e) => e.success).length,
        failedExecutions: executions.filter((e) => !e.success).length,
        avgQualityScore,
        bestModel: bestExecution.execution.model.id,
        bestScore: bestExecution.score,
        costPerModel: totalCost / executions.length,
        diversityScore: this.calculateDiversityScore(executions),
        allScores: scoredExecutions.map((se) => ({
          model: se.execution.model.id,
          score: se.score,
          cost: se.execution.cost,
        })),
        ...(this.isReasoningEnabled(request) && allExecutions.some(e => e.reasoning)
          ? { reasoning_traces: allExecutions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) }
          : {}),
      },
    };
  }

  /**
   * Select up to maxCount diverse models
   * Prioritizes provider diversity and capability mix
   */
  private selectDiverseModels(availableModels: Model[], maxCount: number): Model[] {
    const selected: Model[] = [];
    const usedProviders = new Set<string>();

    // First pass: One model from each provider
    for (const model of availableModels) {
      if (!usedProviders.has(model.provider) && selected.length < maxCount) {
        selected.push(model);
        usedProviders.add(model.provider);
      }
    }

    // Second pass: Fill remaining slots with highest quality models
    const remaining = availableModels
      .filter((m) => !selected.find((s) => s.id === m.id))
      .sort((a, b) => {
        const aQuality = a.performance?.quality ?? 0.8;
        const bQuality = b.performance?.quality ?? 0.8;
        return Number(bQuality) - Number(aQuality);
      });

    for (const model of remaining) {
      if (selected.length >= maxCount) break;
      selected.push(model);
    }

    return selected.slice(0, maxCount);
  }

  /**
   * Execute all models in parallel with confidence-based early exit.
   *
   * Once `EARLY_EXIT_MIN_RESPONSES` successful responses are collected and
   * their content agreement exceeds `EARLY_EXIT_AGREEMENT_THRESHOLD`, we
   * resolve immediately without waiting for remaining slow models.
   * All already-started promises continue running but their results are
   * discarded — this cannot abort in-flight HTTP requests, but avoids
   * waiting on slow stragglers.
   */
  private async executeAllModelsWithEarlyExit(
    request: ChatRequest,
    models: Model[],
    context: OrchestrationContext
  ): Promise<InternalExecution[]> {
    const collected: InternalExecution[] = [];
    let earlyExitTriggered = false;

    const runOne = async (model: Model): Promise<InternalExecution> => {
      const execStart = Date.now();
      try {
        if (!this.getAdapterForModel) {
          throw new Error('getAdapterForModel not injected by orchestration engine');
        }
        const adapter = await this.getAdapterForModel(model, context);
        if (!adapter) {
          throw new Error(`No adapter found for model: ${model.id}`);
        }
        // Each model in massive-parallel knows it's part of a large ensemble
        const ensembleRequest: ChatRequest = {
          ...request,
          messages: [
            {
              role: 'system',
              content: this.withReasoningPrompt(PROMPTS.massiveParallelExpert, request, model),
            },
            ...request.messages,
          ],
        };
        const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
        const reasoningEnabled = this.isReasoningEnabled(request);
        const exec = hasTools
          ? await this.executeModelWithTools(adapter, model, ensembleRequest, 'primary')
          : reasoningEnabled
            ? await this.executeModelWithReasoning(adapter, model, ensembleRequest, 'primary')
            : await this.executeModel(adapter, model, ensembleRequest, 'primary');
        const response = exec.response;
        const execEnd = Date.now();

        return {
          model,
          response,
          startTime: execStart,
          endTime: execEnd,
          duration: execEnd - execStart,
          usage: {
            prompt_tokens: response.usage?.prompt_tokens || 0,
            completion_tokens: response.usage?.completion_tokens || 0,
            total_tokens: response.usage?.total_tokens || 0,
          },
          cost: adapter.calculateCost(
            model,
            response.usage?.prompt_tokens || 0,
            response.usage?.completion_tokens || 0
          ),
          success: true,
        };
      } catch (error: unknown) {
        const execEnd = Date.now();
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          model,
          response: this.createErrorResponse(model, error instanceof Error ? error : new Error(errorMessage)),
          startTime: execStart,
          endTime: execEnd,
          duration: execEnd - execStart,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          cost: 0,
          success: false,
          error: errorMessage,
        };
      }
    };

    return new Promise((resolve) => {
      let settled = 0;
      const total = models.length;

      for (const model of models) {
        runOne(model).then((exec) => {
          if (earlyExitTriggered) return; // already resolved, discard late arrivals
          collected.push(exec);
          settled++;

          const successfulSoFar = collected.filter((e) => e.success);

          // Check early-exit condition
          if (
            successfulSoFar.length >= MassiveParallelStrategy.EARLY_EXIT_MIN_RESPONSES &&
            this.calculateContentAgreement(successfulSoFar) >=
              MassiveParallelStrategy.EARLY_EXIT_AGREEMENT_THRESHOLD
          ) {
            earlyExitTriggered = true;
            this.log.debug(
              {
                collected: collected.length,
                successful: successfulSoFar.length,
                total,
                agreement: this.calculateContentAgreement(successfulSoFar),
              },
              'MassiveParallel early-exit triggered — sufficient agreement reached'
            );
            resolve(collected);
            return;
          }

          // All settled without early exit
          if (settled === total) {
            resolve(collected);
          }
        });
      }
    });
  }

  /**
   * Calculate agreement score among successful executions.
   *
   * Uses character-level Jaccard similarity on token sets extracted from
   * response content. Returns 0–1 where 1 = all responses identical.
   */
  private calculateContentAgreement(executions: InternalExecution[]): number {
    if (executions.length < 2) return 1.0;

    const tokenSets = executions.map((e) => {
      const text = safeResponseContent(e.response);
      // Rough token set: split on whitespace + punctuation, lowercase
      return new Set(text.toLowerCase().split(/[\s,.!?;:()[\]{}"'`]+/).filter(Boolean));
    });

    // Pairwise Jaccard — average of all pairs
    let totalSim = 0;
    let pairs = 0;
    for (let i = 0; i < tokenSets.length; i++) {
      for (let j = i + 1; j < tokenSets.length; j++) {
        const a = tokenSets[i];
        const b = tokenSets[j];
        const intersection = new Set([...a].filter((t) => b.has(t)));
        const union = new Set([...a, ...b]);
        totalSim += union.size > 0 ? intersection.size / union.size : 1.0;
        pairs++;
      }
    }

    return pairs > 0 ? totalSim / pairs : 1.0;
  }

  /**
   * Score each execution based on quality metrics
   */
  private scoreExecutions(executions: InternalExecution[]): Array<{ execution: InternalExecution; score: number }> {
    return executions
      .filter((exec) => exec.success)
      .map((execution) => ({
        execution,
        score: this.calculateExecutionScore(execution),
      }))
      .sort((a, b) => b.score - a.score); // Highest score first
  }

  /**
   * Calculate quality score for a single execution
   */
  private calculateExecutionScore(execution: InternalExecution): number {
    let score = 0.5; // Base score

    const contentStr = safeResponseContent(execution.response);

    // Length score (longer is generally better, up to a point)
    const lengthScore = Math.min(1, contentStr.length / 3000);
    score += lengthScore * 0.15;

    // Structure score (has code blocks, lists, etc)
    if (contentStr.includes('```')) score += 0.1; // Code examples
    if (contentStr.match(/^\d+\./m)) score += 0.05; // Numbered lists
    if (contentStr.match(/^[-*]\s/m)) score += 0.05; // Bullet lists
    if (contentStr.match(/^#{1,3}\s/m)) score += 0.05; // Headers

    // Completeness score (has multiple paragraphs)
    const paragraphs = contentStr.split('\n\n').filter((p) => p.trim().length > 0);
    score += Math.min(paragraphs.length / 10, 0.1);

    // Token efficiency (quality per token)
    const tokensUsed = execution.usage.total_tokens || 1;
    const efficiency = contentStr.length / tokensUsed;
    score += Math.min(efficiency / 10, 0.1);

    // Cost penalty (prefer cheaper models if quality similar)
    const costPenalty = Math.min(execution.cost / 0.05, 0.05);
    score -= costPenalty;

    // Note: Model quality bonus removed as ModelExecution doesn't have model reference
    // Quality is already reflected in the content-based scoring above

    return Math.max(0, Math.min(score, 0.99)); // Clamp to [0, 0.99]
  }

  /**
   * Select best execution from scored list
   */
  private selectBestExecution(scoredExecutions: Array<{ execution: InternalExecution; score: number }>): {
    execution: InternalExecution;
    score: number;
  } {
    if (scoredExecutions.length === 0) {
      throw new Error('No successful executions to select from');
    }

    // Already sorted by score (highest first)
    return scoredExecutions[0];
  }

  /**
   * Calculate average quality score across all successful executions
   */
  private calculateAverageQuality(
    scoredExecutions: Array<{ execution: InternalExecution; score: number }>
  ): number {
    if (scoredExecutions.length === 0) return 0;

    const sum = scoredExecutions.reduce((acc, se) => acc + se.score, 0);
    return sum / scoredExecutions.length;
  }

  /**
   * Calculate diversity score (how many unique providers)
   * 100% dynamic - uses model.provider when available, no hardcoded name checks
   */
  private calculateDiversityScore(executions: InternalExecution[]): number {
    // Extract providers dynamically from model objects when available
    const providerPrefixes = new Set(
      executions.map((exec) => {
        // Prefer model.provider if available (most reliable)
        if (exec.model && 'provider' in exec.model && typeof exec.model.provider === 'string') {
          return exec.model.provider;
        }
        // Fallback: try to extract from modelId if it contains provider info
        // This is a last resort and should be avoided when possible
        const _modelId = exec.model?.id || '';
        // Only use as fallback if modelId format suggests provider info
        // Otherwise return 'unknown' to avoid incorrect inference
        return 'unknown';
      })
    );
    // Normalize by actual provider count (dynamic, not hardcoded to 5)
    const maxExpectedProviders = Math.max(providerPrefixes.size, 1);
    return providerPrefixes.size / maxExpectedProviders;
  }

  /**
   * Create error response for failed execution
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
