// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 6: Competitive Execution
 * Multiple models compete, arbiter selects best result
 * Maximum quality through competition
 */

import { BaseStrategy, safeResponseContent, type StrategyMetadata } from '../base-strategy';
import { PROMPTS } from '../prompts/sota-system-prompts';
import { resolvePreferredExecutor } from './preferred-model-helper';
import {
  normalizeJudgeOutput,
  JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS,
} from '@/core/quality/judge-schema';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
} from '@/types';

/**
 * Competitive Strategy
 *
 * Execution Flow:
 * 1. Select 2-3 competing models (different providers/capabilities)
 * 2. Execute same request on all models in parallel
 * 3. Select best model as arbiter (premium, different provider)
 * 4. Arbiter evaluates all responses and selects best
 * 5. Return best response with quality metadata
 *
 * Cost: 2.5-3.5x (2-3 competitors + 1 arbiter)
 * Quality: +30% (competition + expert evaluation)
 * Use Cases: Critical decisions, code review, high-stakes content
 */
export class CompetitiveStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'competitive',
      name: 'competitive',
      displayName: 'Competitive Execution',
      description:
        'Multiple models compete, arbiter selects best. Maximum quality through competition.',
      minModels: 3, // 2 competitors + 1 arbiter
      maxModels: 4, // 3 competitors + 1 arbiter
      estimatedCostMultiplier: 3.0,
      estimatedQualityBoost: 0.3, // +30% quality
      estimatedDurationMultiplier: 1.2, // Slightly slower (arbiter evaluation)
      suitableFor: ['code-review', 'analysis', 'documentation', 'qa'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();

    try {
      // Select competitors and arbiter
      const { competitors, arbiter } = await this.selectCompetitorsAndArbiter(
        this.getEligibleModels(context),
        request,
        context
      );

      if (competitors.length < 2 || !arbiter) {
        throw new Error(
          'Insufficient models for competitive strategy (need 2 competitors + 1 arbiter)'
        );
      }

      this.log.info(
        {
          competitors: competitors.map((c) => c.name),
          arbiter: arbiter.name,
        },
        'Starting competitive execution'
      );

      // Observer: start
      this.emitObserverEvent(context, {
        type: 'phase_start',
        models: competitors.map(c => c.name || c.id),
        summary: `Competitive: ${competitors.length} models racing, arbiter will judge.`,
      });

      const reasoningEnabled = this.isReasoningEnabled(request);
      const hasTools = Array.isArray(request.tools) && request.tools.length > 0;

      // Execute on all competitors in parallel via executeModel (adds bulkhead, retry, metrics)
      const competitorExecutions = await Promise.allSettled(
        competitors.map(async (model) => {
          if (!this.getAdapterForModel) {
            throw new Error('getAdapterForModel not injected by orchestration engine');
          }
          const adapter = await this.getAdapterForModel(model, context);
          if (!adapter) {
            throw new Error(`Adapter not found for model ${model.name}`);
          }

          const competitiveRequest: ChatRequest = {
            ...request,
            messages: [
              { role: 'system', content: this.withReasoningPrompt(PROMPTS.parallelCompetitor, request, model) },
              ...request.messages,
            ],
          };

          return hasTools
            ? this.executeModelWithTools(adapter, model, competitiveRequest, 'primary')
            : reasoningEnabled
              ? this.executeModelWithReasoning(adapter, model, competitiveRequest, 'primary')
              : this.executeModel(adapter, model, competitiveRequest, 'primary');
        })
      );

      // Extract successful executions
      const successfulExecutions: ModelExecution[] = [];
      for (const result of competitorExecutions) {
        if (result.status === 'fulfilled') {
          successfulExecutions.push(result.value);
        }
      }

      if (successfulExecutions.length === 0) {
        throw new Error('All competitor models failed');
      }

      // Observer: competitors done
      this.emitObserverEvent(context, {
        type: 'round_complete', round: 1, totalRounds: 2,
        summary: `${successfulExecutions.length} competitors responded. Arbiter evaluating.`,
      });

      this.log.debug(
        {
          successfulCount: successfulExecutions.length,
          totalAttempted: competitors.length,
        },
        'Competitor executions completed'
      );

      // MERGE the competitors into one superior answer (2026-06-30): the arbiter
      // now SYNTHESIZES the best of all responses instead of selecting one winner,
      // so competition can EXCEED the best individual. Falls back to selecting the
      // best response if a merge can't be produced.
      if (!this.getAdapterForModel) {
        throw new Error('getAdapterForModel not injected by orchestration engine');
      }

      this.emitObserverEvent(context, { type: 'synthesis_start', modelName: arbiter.name || arbiter.id, summary: 'Arbiter merging competitor responses.' });

      const merged = await this.synthesizeMerged(successfulExecutions, request, context, arbiter);

      let finalExecution: ModelExecution;
      let arbiterCost = 0;
      const allExecutions: ModelExecution[] = [...successfulExecutions];
      let selectionReason: string;
      if (merged && merged !== successfulExecutions[0]) {
        finalExecution = merged;
        arbiterCost = merged.cost;
        allExecutions.push(merged);
        selectionReason = 'Arbiter merge synthesis';
        this.emitObserverEvent(context, { type: 'synthesis_complete', summary: `Merged ${successfulExecutions.length} competitor responses into one.` });
      } else {
        // Fallback: select the best response via the legacy arbiter.
        const arbitrationRequest = this.createArbitrationRequest(request, successfulExecutions);
        const arbiterAdapter = await this.getAdapterForModel(arbiter, context);
        if (!arbiterAdapter) {
          throw new Error(`Adapter not found for arbiter model ${arbiter.name}`);
        }
        const arbiterExec = await this.executeModel(arbiterAdapter, arbiter, arbitrationRequest, 'arbitrator');
        const selectedIndex = this.parseArbiterSelection(arbiterExec.response, successfulExecutions.length);
        finalExecution = successfulExecutions[selectedIndex] || successfulExecutions[0];
        arbiterCost = arbiterExec.cost;
        allExecutions.push(arbiterExec);
        selectionReason = 'Arbiter selection (merge unavailable)';
        this.emitObserverEvent(context, { type: 'synthesis_complete', summary: `Arbiter selected ${finalExecution.modelName}.` });
      }

      // Calculate costs
      const totalCost = successfulExecutions.reduce((sum, exec) => sum + exec.cost, 0);
      const totalDuration = Date.now() - startTime;

      this.log.info(
        {
          competitors: successfulExecutions.length,
          finalModel: finalExecution.modelName,
          totalCost: totalCost + arbiterCost,
          duration: totalDuration,
        },
        'Competitive execution completed'
      );

      return {
        strategyUsed: 'competitive',
        modelsUsed: allExecutions,
        finalResponse: finalExecution.response,
        totalCost: totalCost + arbiterCost,
        totalDuration,
        qualityScore: 0.95, // High quality from competition
        metadata: {
          competitorCount: successfulExecutions.length,
          arbiterModel: arbiter.name,
          selectedCompetitor: finalExecution.modelName,
          selectionReason,
          ...(reasoningEnabled && allExecutions.some(e => e.reasoning)
            ? { reasoning_traces: allExecutions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) }
            : {}),
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.log.error({ error: errorMessage }, 'Competitive execution failed');
      throw errorObj;
    }
  }

  /**
   * Select competitors and arbiter
   */
  private async selectCompetitorsAndArbiter(
    models: Model[],
    request: ChatRequest,
    context: OrchestrationContext
  ): Promise<{
    competitors: Model[];
    arbiter: Model;
  }> {
    // Need at least 3 models
    if (models.length < 3) {
      throw new Error('Need at least 3 models for competitive strategy');
    }

    const requiresTools = Array.isArray(request.tools) && request.tools.length > 0;
    const supportsTools = (model: Model): boolean =>
      !requiresTools || (Array.isArray(model.capabilities) && model.capabilities.includes('function_calling'));

    const sortedModels = [...models]
      .filter((model) => supportsTools(model))
      .sort((a, b) => {
        if (context.preferSpeed) {
          return (a.performance.latencyMs ?? 0) - (b.performance.latencyMs ?? 0);
        }
        return (b.performance.quality ?? 0) - (a.performance.quality ?? 0);
      });
    const candidatePool = sortedModels.length > 0 ? sortedModels : models;

    // Pin biases competitor inclusion. The arbiter is intentionally
    // selected from a different provider for impartiality, so the
    // pin maps to a competitor slot, not the arbiter. We ensure the
    // pinned model is in the competitors list even if provider
    // diversity would have skipped it.
    const preference = resolvePreferredExecutor(candidatePool, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      this.log.warn(
        {
          attempted: context.preferredModelIds?.[0],
          reason: preference.pinReason,
        },
        'Preferred model not eligible (capability/tools-filtered) — falling back to provider-diverse competitors.',
      );
    }

    // Select 2-3 competitors from different providers
    const competitors: Model[] = [];
    const usedProviders = new Set<string>();

    // First slot: honor pin if eligible.
    if (preference.pinnedExecutor) {
      competitors.push(preference.pinnedExecutor);
      usedProviders.add(preference.pinnedExecutor.provider);
    }

    for (const model of candidatePool) {
      if (competitors.length >= 3) break;
      if (preference.pinnedExecutor && model.id === preference.pinnedExecutor.id) continue;

      // Prefer different providers for diversity
      if (!usedProviders.has(model.provider)) {
        competitors.push(model);
        usedProviders.add(model.provider);
      }
    }

    // If we don't have enough from different providers, add more
    if (competitors.length < 2) {
      for (const model of candidatePool) {
        if (competitors.length >= 3) break;
        if (!competitors.includes(model)) {
          competitors.push(model);
        }
      }
    }

    // Select arbiter: highest quality model from different provider than competitors
    const competitorProviders = new Set(competitors.map((c) => c.provider));
    const arbiterCandidates = candidatePool.filter(
      (m) => !competitorProviders.has(m.provider) && !competitors.includes(m)
    );

    let arbiter;
    if (arbiterCandidates.length > 0) {
      // Pick highest quality arbiter
      arbiter = arbiterCandidates.reduce((best, current) =>
        current.performance.quality > best.performance.quality ? current : best
      );
    } else {
      // If no different provider, use highest quality not already competing
      arbiter = candidatePool
        .filter((m) => !competitors.includes(m))
        .reduce((best, current) =>
          current.performance.quality > best.performance.quality ? current : best
        );
    }

    if (!arbiter && models.length >= 3) {
      // Last resort: use any high-quality model
      arbiter = models.reduce((best, current) =>
        current.performance.quality > best.performance.quality ? current : best
      );
    }

    return { competitors, arbiter };
  }

  /**
   * Create arbitration request
   */
  private createArbitrationRequest(
    originalRequest: ChatRequest,
    executions: ModelExecution[]
  ): ChatRequest {
    // Build arbitration prompt
    const responsesText = executions
      .map((exec, index) => {
        const contentStr = safeResponseContent(exec.response);
        return `
### Response ${index + 1} (from ${exec.modelName}):
${contentStr}
`;
      })
      .join('\n');

    // R2: the arbiter now emits canonical JudgeVerdict JSON. The legacy
    // `BEST: N / REASON: ...` free text format was the worst offender in the
    // audit — it was impossible to compare against other judges and every
    // consumer had to hand-roll a regex parser. `normalizeJudgeOutput` still
    // accepts the legacy shape as a fallback for older fine-tuned models,
    // but the prompt now asks for the canonical contract first.
    const arbitrationPrompt = `You are an expert arbiter evaluating multiple AI responses to select the best one.

Original Request:
${originalRequest.messages[originalRequest.messages.length - 1].content}

Here are ${executions.length} responses from different AI models (0-based index):

${responsesText}

Evaluate all responses on accuracy, completeness, clarity, usefulness, and code quality (if applicable).
Identify which response is best and set \`winnerIndex\` to its 0-based index (0..${executions.length - 1}).

${JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS}`;

    return {
      messages: [
        {
          role: 'user',
          content: arbitrationPrompt,
        },
      ],
      temperature: 0.3, // Low temperature for consistent evaluation
      max_tokens: 200,
    };
  }

  /**
   * Parse arbiter's selection. Routes the raw response through the unified
   * `normalizeJudgeOutput` helper so canonical JSON, legacy dimensional JSON,
   * legacy 0-100 scores, and legacy `BEST: N / REASON: ...` text all produce
   * the same shape. Returns the winning 0-based index, or 0 as a last-resort
   * fallback (logged).
   */
  private parseArbiterSelection(response: ChatResponse, maxIndex: number): number {
    const contentStr = safeResponseContent(response);
    const verdict = normalizeJudgeOutput(contentStr, {
      where: 'competitive-strategy.arbiter',
      candidateCount: maxIndex,
    });
    if (verdict && typeof verdict.winnerIndex === 'number') {
      const idx = verdict.winnerIndex;
      if (idx >= 0 && idx < maxIndex) return idx;
    }
    this.log.warn(
      { arbitrationResponse: contentStr.slice(0, 300) },
      'Failed to parse arbiter selection via unified judge schema, defaulting to first',
    );
    return 0;
  }
}
