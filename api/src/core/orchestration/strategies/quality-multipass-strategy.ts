// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { BaseStrategy, safeResponseContent, type StrategyMetadata } from '../base-strategy';
import { ADAPTIVE_DEPTH_DIRECTIVE } from '../prompts/sota-system-prompts';
import {
  JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS,
  normalizeJudgeOutput,
} from '@/core/quality/judge-schema';
import { resolvePreferredExecutor } from './preferred-model-helper';
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
 * Quality-First Multi-Pass Strategy
 *
 * Iteratively refines responses through multiple passes with validators.
 * Prioritizes maximum quality through systematic improvement cycles.
 *
 * Best for: High-stakes outputs requiring exceptional quality
 *
 * Process:
 * 1. Generate initial response (primary model)
 * 2. Validate quality (validator model)
 * 3. If quality sufficient → Done
 * 4. If issues found → Refine (with validator feedback)
 * 5. Repeat until quality threshold met or max passes reached
 *
 * Example Flow:
 * Pass 1: GPT-4o generates code
 * ↓
 * Validator: Claude checks quality (finds: missing error handling)
 * ↓
 * Pass 2: GPT-4o refines with feedback (adds error handling)
 * ↓
 * Validator: Quality threshold met ✅
 *
 * Typical Result: +40% quality improvement over single-pass
 */
export class QualityMultiPassStrategy extends BaseStrategy {
  private readonly MAX_PASSES = 3; // Maximum refinement iterations
  private readonly QUALITY_THRESHOLD = 0.85; // High quality target

  getMetadata(): StrategyMetadata {
    return {
      id: 'quality-multipass',
      name: 'quality-multipass',
      displayName: 'Quality-First Multi-Pass',
      description:
        'Iteratively refine responses through multiple passes with validators. Maximum quality through systematic improvement.',
      minModels: 2, // Primary + validator
      maxModels: 3, // Primary + 2 validators
      estimatedCostMultiplier: 2.5, // Multiple passes
      estimatedQualityBoost: 0.4, // +40% through refinement
      estimatedDurationMultiplier: 2.0, // Multiple iterations
      suitableFor: ['code-generation', 'code-review', 'documentation', 'refactoring', 'analysis'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const models = this.getEligibleModels(context);

    if (models.length < this.getMetadata().minModels!) {
      throw new Error(
        `Quality Multi-Pass requires at least ${this.getMetadata().minModels} models (${models.length} available)`
      );
    }

    // Select models. Caminho-C Q2 cross-strategy honor (2026-04-29):
    // pin biases the PRIMARY (generator) — refinement passes reuse the
    // same primary, so honoring the pin here means the user's model
    // generates each pass. Validator stays as a different model
    // (anti-bias guarantee) and is unaffected by the pin.
    let primaryModel = this.selectPrimaryModel(models, context);
    const validatorModel = this.selectValidatorModel(models, primaryModel);

    const passes: Array<{
      passNumber: number;
      generation: ModelExecution;
      validation?: ModelExecution;
      qualityScore: number;
      issues?: string[];
    }> = [];

    let currentRequest = request;
    let qualityThreshold = context.qualityTarget || this.QUALITY_THRESHOLD;
    let bestExecution: ModelExecution | null = null;
    let bestQualityScore = 0;

    // Observer: start
    this.emitObserverEvent(context, { type: 'phase_start', models: [primaryModel.name || primaryModel.id, validatorModel.name || validatorModel.id], summary: `Quality multipass: up to ${this.MAX_PASSES} refinement passes.` });

    // Multi-pass refinement loop
    for (let passNumber = 1; passNumber <= this.MAX_PASSES; passNumber++) {
      this.log.info({ passNumber, maxPasses: this.MAX_PASSES }, 'Starting refinement pass');

      // Generate response
      const generation = await this.generateResponse(primaryModel, currentRequest, context);

      // If generation failed, try a different primary model for remaining passes
      if (!generation.success) {
        this.log.warn({ passNumber, model: primaryModel.name }, 'Generation failed, selecting alternate model');
        passes.push({ passNumber, generation, qualityScore: 0 });
        // Pick next best model that's different from the failed one
        const alternate = models.find(m =>
          m.id !== primaryModel.id &&
          (m.balanceStatus === 'has-credits' || m.balanceStatus === 'local' || m.balanceStatus === 'unknown')
        );
        if (alternate) primaryModel = alternate;
        continue;
      }

      // Validate quality
      const validation = await this.validateResponse(validatorModel, request, generation, context);

      const qualityScore = this.extractQualityScore(validation);
      const issues = this.extractIssues(validation);

      passes.push({
        passNumber,
        generation,
        validation,
        qualityScore,
        issues,
      });

      this.log.info(
        {
          passNumber,
          qualityScore,
          qualityThreshold,
          issuesFound: issues.length,
        },
        'Pass completed'
      );

      // Track best result
      if (qualityScore > bestQualityScore) {
        bestQualityScore = qualityScore;
        bestExecution = generation;
      }

      // Check if quality met
      if (qualityScore >= qualityThreshold) {
        this.log.info(
          { passNumber, qualityScore, qualityThreshold },
          'Quality threshold met, stopping refinement'
        );
        break;
      }

      // Prepare refinement request for next pass
      if (passNumber < this.MAX_PASSES) {
        currentRequest = this.createRefinementRequest(request, generation, issues);
      }
    }

    if (!bestExecution) {
      throw new Error('No successful generation in multi-pass');
    }

    // Final synthesis pass: polish the best draft using full refinement context
    if (passes.length > 1) {
      const polishExecution = await this.generateFinalSynthesis(
        primaryModel,
        request,
        bestExecution,
        passes.length,
        context
      );
      if (polishExecution.success) {
        bestExecution = polishExecution;
        passes.push({
          passNumber: passes.length + 1,
          generation: polishExecution,
          qualityScore: bestQualityScore,
          issues: [],
        });
      }
    }

    // Calculate metrics
    const duration = Date.now() - startTime;
    const totalCost = passes.reduce(
      (sum, pass) => sum + pass.generation.cost + (pass.validation?.cost || 0),
      0
    );

    const allExecutions: ModelExecution[] = passes.flatMap((pass) => {
      const execs: ModelExecution[] = [];

      // Add generation execution
      execs.push({
        modelId: pass.generation.modelId,
        modelName: pass.generation.modelName,
        role: (pass.generation === bestExecution ? 'primary' : 'refiner') as ModelRole,
        request,
        response: pass.generation.response,
        cost: pass.generation.cost,
        durationMs: pass.generation.durationMs,
        success: pass.generation.success,
      });

      // Add validation execution if exists
      if (pass.validation) {
        execs.push({
          modelId: pass.validation.modelId,
          modelName: pass.validation.modelName,
          role: 'validator' as ModelRole,
          request,
          response: pass.validation.response,
          cost: pass.validation.cost,
          durationMs: pass.validation.durationMs,
          success: pass.validation.success,
        });
      }

      return execs;
    });

    return {
      strategyUsed: this.getMetadata().name,
      modelsUsed: allExecutions,
      finalResponse: bestExecution.response,
      totalCost,
      totalDuration: duration,
      qualityScore: bestQualityScore,
      metadata: {
        totalPasses: passes.length,
        qualityImprovement:
          passes.length > 1 ? passes[passes.length - 1].qualityScore - passes[0].qualityScore : 0,
        finalQualityScore: bestQualityScore,
        qualityThreshold,
        qualityMet: bestQualityScore >= qualityThreshold,
        passes: passes.map((pass) => ({
          passNumber: pass.passNumber,
          qualityScore: pass.qualityScore,
          issuesFound: pass.issues?.length || 0,
          generationCost: pass.generation.cost,
          validationCost: pass.validation?.cost || 0,
        })),
        ...(this.isReasoningEnabled(request) && allExecutions.some(e => e.reasoning)
          ? { reasoning_traces: allExecutions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) }
          : {}),
      },
    };
  }

  supportsStreaming(): boolean {
    return true;
  }

  /**
   * Hybrid streaming for quality-multipass:
   *   Phase 1 — refinement loop (non-stream) + progress chunks per pass
   *   Phase 2 — final synthesis pass streamed token-by-token
   */
  async *executeStream(
    request: ChatRequest,
    context: OrchestrationContext
  ): AsyncGenerator<ChatResponse, void, unknown> {
    const models = this.getEligibleModels(context);
    if (models.length < this.getMetadata().minModels!) {
      throw new Error(`Quality Multi-Pass requires at least ${this.getMetadata().minModels} models`);
    }

    const primaryModel = this.selectPrimaryModel(models, context);
    const validatorModel = this.selectValidatorModel(models, primaryModel);
    const qualityThreshold = context.qualityTarget || this.QUALITY_THRESHOLD;
    let bestExecution: ModelExecution | null = null;
    let bestQualityScore = 0;
    let currentRequest = request;

    yield this.progressChunk(
      `Starting iterative refinement (up to ${this.MAX_PASSES} passes)...`,
      0,
      this.MAX_PASSES + 1
    );

    for (let pass = 1; pass <= this.MAX_PASSES; pass++) {
      const generation = await this.generateResponse(primaryModel, currentRequest, context);
      const validation = await this.validateResponse(validatorModel, request, generation, context);
      const qualityScore = this.extractQualityScore(validation);
      const issues = this.extractIssues(validation);

      if (qualityScore > bestQualityScore) {
        bestQualityScore = qualityScore;
        bestExecution = generation;
      }

      yield this.progressChunk(
        `Pass ${pass}/${this.MAX_PASSES} — quality: ${(qualityScore * 100).toFixed(0)}%`,
        pass,
        this.MAX_PASSES + 1
      );

      if (qualityScore >= qualityThreshold) break;
      if (pass < this.MAX_PASSES) {
        currentRequest = this.createRefinementRequest(request, generation, issues);
      }
    }

    if (!bestExecution) {
      throw new Error('No successful generation in multi-pass stream');
    }

    // Phase 2: stream final polished synthesis
    yield this.progressChunk('Generating final polished version...', this.MAX_PASSES, this.MAX_PASSES + 1);

    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected');
    }
    const primaryAdapter = await this.getAdapterForModel(primaryModel, context);
    if (!primaryAdapter) {
      throw new Error(`No adapter found for model: ${primaryModel.id}`);
    }

    const finalRequest = this.buildFinalSynthesisRequest(request, bestExecution, this.MAX_PASSES);
    // RESILIENT streaming: bare for-await had NO first-token deadline. Route
    // through the fallback-chain helper (first-chunk + idle deadlines, graceful
    // degrade to the best pass already generated instead of a hard stream failure).
    yield* this.streamSynthesisWithFallback(
      finalRequest,
      [{ adapter: primaryAdapter, model: primaryModel }],
      () => safeResponseContent(bestExecution.response).slice(0, 4000),
    );
  }

  /**
   * Generate final polished synthesis pass (used by both execute and executeStream)
   */
  private async generateFinalSynthesis(
    model: Model,
    request: ChatRequest,
    bestExecution: ModelExecution,
    passCount: number,
    context: OrchestrationContext
  ): Promise<ModelExecution> {
    const finalRequest = this.buildFinalSynthesisRequest(request, bestExecution, passCount);
    return this.generateResponse(model, finalRequest, context);
  }

  /**
   * Build the final synthesis request (shared by execute and executeStream)
   */
  private buildFinalSynthesisRequest(
    request: ChatRequest,
    bestExecution: ModelExecution,
    passCount: number
  ): ChatRequest {
    const contentStr = safeResponseContent(bestExecution.response);

    return {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant' as const, content: contentStr },
        {
          role: 'user' as const,
          content: `Based on ${passCount} refinement iterations, produce the final polished version. Incorporate all improvements made during refinement. Be complete, precise, and professional.\n${ADAPTIVE_DEPTH_DIRECTIVE}`,
        },
      ],
    };
  }

  /**
   * Select primary generation model — prefer high quality, but honor
   * the user pin if set. Caminho-C Q2 cross-strategy honor (2026-04-29):
   * the pin overrides the balance/quality sort because user intent
   * is the strongest signal we have. If pin isn't in pool (filtered
   * for health/balance/capability gates), log warn and fall through
   * to legacy selection.
   */
  private selectPrimaryModel(models: Model[], context?: OrchestrationContext): Model {
    if (context) {
      const preference = resolvePreferredExecutor(models, context, []);
      if (preference.pinReason === 'pin-not-in-pool') {
        this.log.warn(
          {
            requestId: context.requestId,
            requestedModel: preference.requestedId,
            poolSize: models.length,
          },
          'Quality multipass: requested model not in operational pool — falling back to balance/quality sort',
        );
      }
      if (preference.pinnedExecutor) return preference.pinnedExecutor;
    }
    return [...models].sort((a, b) => {
      // Prefer models with known credits or local over unknown/no-credits
      const balancePriority = (m: Model) => {
        const bs = m.balanceStatus || 'unknown';
        if (bs === 'has-credits' || bs === 'local') return 2;
        if (bs === 'unknown') return 1;
        return 0; // no-credits
      };
      const aBal = balancePriority(a);
      const bBal = balancePriority(b);
      if (aBal !== bBal) return bBal - aBal;
      // Then by quality
      const aQuality = a.performance?.quality ?? 0.8;
      const bQuality = b.performance?.quality ?? 0.8;
      return Number(bQuality) - Number(aQuality);
    })[0];
  }

  /**
   * Select validator model (prefer different provider from primary)
   */
  private selectValidatorModel(models: Model[], primaryModel: Model): Model {
    const differentProvider = models.find(
      (m) => m.provider !== primaryModel.provider && m.id !== primaryModel.id
    );
    return differentProvider || models.find((m) => m.id !== primaryModel.id) || models[0];
  }

  /**
   * Generate response with primary model
   */
  private async generateResponse(
    model: Model,
    request: ChatRequest,
    context: OrchestrationContext
  ): Promise<ModelExecution> {
    const _execStart = Date.now();
    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected by orchestration engine');
    }
    const adapter = await this.getAdapterForModel(model, context);
    if (!adapter) {
      throw new Error(`No adapter found for model: ${model.id}`);
    }
    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    const reasoningEnabled = this.isReasoningEnabled(request);
    let exec = hasTools
      ? await this.executeModelWithTools(adapter, model, request, 'primary')
      : reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, model, request, 'primary')
        : await this.executeModel(adapter, model, request, 'primary');
    // Fallback if primary model failed
    if (!exec.success) {
      exec = await this.executeModelWithRetry(adapter, model, request, 'primary', context);
    }
    return exec;
  }

  /**
   * Validate response quality
   */
  private async validateResponse(
    validatorModel: Model,
    originalRequest: ChatRequest,
    generation: ModelExecution,
    context: OrchestrationContext
  ): Promise<ModelExecution> {
    const contentStr = safeResponseContent(generation.response);

    // J-Final (Lote 4): validator prompt now asks for canonical JudgeVerdict
    // JSON. Parsers route through `normalizeJudgeOutput` so the legacy
    // `QUALITY_SCORE: N\nISSUES:` text format remains accepted (back-compat)
    // but is no longer the requested contract.
    const validationRequest: ChatRequest = {
      messages: [
        {
          role: 'system',
          content:
            `You are a quality validator. Evaluate the following response and emit a canonical JudgeVerdict.\n\n` +
            `Original Request: ${this.getLastUserMessage(originalRequest)}\n\n` +
            `Response to Validate:\n${contentStr}\n\n` +
            `${JUDGE_OUTPUT_CONTRACT_INSTRUCTIONS}`,
        },
        {
          role: 'user',
          content: 'Please validate the response.',
        },
      ],
      model: validatorModel.id,
    };

    return await this.generateResponse(validatorModel, validationRequest, context);
  }

  /**
   * Extract quality score from validation response via the unified judge
   * schema. Accepts canonical JudgeVerdict JSON first, falls back through
   * `normalizeJudgeOutput`'s legacy adapters, and finally the heuristic.
   */
  private extractQualityScore(validation: ModelExecution): number {
    const contentStr = safeResponseContent(validation.response);
    const verdict = normalizeJudgeOutput(contentStr, {
      where: 'quality-multipass.validator',
    });
    if (verdict) return verdict.score;

    // Back-compat: legacy `QUALITY_SCORE: N` text with 0-100 range.
    const scoreMatch = contentStr.match(/QUALITY_SCORE:\s*(\d+)/i);
    if (scoreMatch) {
      const score = parseInt(scoreMatch[1], 10);
      return score / 100;
    }

    // Fallback: calculate based on content
    return this.calculateQualityScore(validation);
  }

  /**
   * Extract issues from validation response. Prefers `issues[].description`
   * from the canonical JudgeVerdict; falls back to the legacy
   * `ISSUES:\n- ...` bullet list for older models.
   */
  private extractIssues(validation: ModelExecution): string[] {
    const contentStr = safeResponseContent(validation.response);

    const verdict = normalizeJudgeOutput(contentStr, {
      where: 'quality-multipass.validator-issues',
    });
    if (verdict && verdict.issues.length > 0) {
      return verdict.issues.map((i) => i.description);
    }

    const issuesMatch = contentStr.match(/ISSUES:\s*([\s\S]*?)(?:\n\n|$)/i);
    if (!issuesMatch) return [];

    return issuesMatch[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('-'))
      .map((line) => line.substring(1).trim())
      .filter((issue) => issue.length > 0);
  }

  /**
   * Create refinement request with validator feedback
   */
  private createRefinementRequest(
    originalRequest: ChatRequest,
    previousGeneration: ModelExecution,
    issues: string[]
  ): ChatRequest {
    const contentStr = safeResponseContent(previousGeneration.response);

    const refinementPrompt = `Please refine your previous response addressing the following issues:

${issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

Previous Response:
${contentStr}

Provide an improved version that addresses all issues while maintaining the good aspects.`;

    return {
      ...originalRequest,
      messages: [
        ...originalRequest.messages,
        {
          role: 'assistant',
          content: contentStr,
        },
        {
          role: 'user',
          content: refinementPrompt,
        },
      ],
    };
  }

  /**
   * Get last user message content
   */
  private getLastUserMessage(request: ChatRequest): string {
    const userMessages = request.messages.filter((m) => m.role === 'user');
    const lastMessage = userMessages[userMessages.length - 1];
    const content = lastMessage?.content || '';
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
}
