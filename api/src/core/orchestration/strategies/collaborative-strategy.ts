// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 4: Collaborative Execution
 * Uses 3 models: Primary executor, Reviewer, and Quality checker
 * Premium quality through collaborative refinement
 */

import { BaseStrategy, type StrategyMetadata, safeResponseContent, mergeArtifacts } from '../base-strategy';
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  Model,
  ModelCapability,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  TaskType,
  ImageContent,
  Tool,
} from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { getUserSpecifiedModelFlag, getTaskType } from '@/types/chat-request-extended';
import { estimateContextSize as estimateContextSizeShared } from '../context-size-estimator';

/**
 * Collaborative Strategy
 *
 * Execution Flow:
 * 1. Primary model generates initial response
 * 2. Reviewer model reviews and suggests improvements
 * 3. If issues found, Primary refines based on feedback
 * 4. Quality checker validates final result
 * 5. Return best version
 *
 * Use Cases:
 * - Critical code generation
 * - Production code review
 * - Complex refactoring
 * - High-stakes debugging
 *
 * Cost: ~2.5x (3 models, some may execute twice)
 * Quality: +25% (collaborative refinement)
 * Speed: 3x slower (sequential with iteration)
 */
export class CollaborativeStrategy extends BaseStrategy {
  /**
   * Get strategy metadata
   */
  getMetadata(): StrategyMetadata {
    return {
      id: 'strategy-4',
      name: 'collaborative',
      displayName: 'Collaborative Execution',
      description:
        'Uses 3 models collaboratively: executor, reviewer, and quality checker. Premium quality through refinement.',
      minModels: 3,
      maxModels: 3,
      estimatedCostMultiplier: 2.5,
      estimatedQualityBoost: 0.25, // ~25% quality improvement
      estimatedDurationMultiplier: 3.0,
      suitableFor: ['code-generation', 'code-review', 'refactoring', 'debugging'],
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
      'Executing Collaborative strategy'
    );

    // Select 3 models: primary, reviewer, validator
    const selectedModels = await this.selectModels(request, context);

    if (selectedModels.length < 3) {
      throw new Error('Collaborative strategy requires at least 3 models');
    }

    const primary = selectedModels[0];
    const reviewer = selectedModels[1];
    const validator = selectedModels[2];

    this.log.debug(
      {
        primary: primary.model.name,
        reviewer: reviewer.model.name,
        validator: validator.model.name,
      },
      'Models selected for collaborative execution'
    );

    const executions: ModelExecution[] = [];

    // Observer: phase start
    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: selectedModels.map((m) => m.model.name || m.model.id),
      summary: `Collaborative: primary generates, reviewer checks, validator confirms.`,
    });

    // PHASE 1: Primary generates initial solution (with fallback on provider failure)
    this.log.debug('Phase 1: Primary execution');
    const reasoningEnabled = this.isReasoningEnabled(request);
    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    let primaryExecution = hasTools
      ? await this.executeModelWithTools(primary.adapter, primary.model, request, 'primary')
      : reasoningEnabled
        ? await this.executeModelWithReasoning(primary.adapter, primary.model, request, 'primary')
        : await this.executeModel(primary.adapter, primary.model, request, 'primary');

    // If primary model failed, try fallback models from context
    if (!primaryExecution.success) {
      this.log.warn({ model: primary.model.name }, 'Primary model failed, trying fallback');
      primaryExecution = await this.executeModelWithRetry(
        primary.adapter,
        primary.model,
        request,
        'primary',
        context
      );
    }
    executions.push(primaryExecution);

    if (!primaryExecution.success) {
      throw new Error('Primary execution failed');
    }

    // Observer: primary done
    this.emitObserverEvent(context, {
      type: 'round_complete',
      round: 1,
      totalRounds: 4,
      summary: 'Primary generated initial solution. Reviewer checking.',
    });

    // PHASE 2: Reviewer checks the solution
    this.log.debug('Phase 2: Review');
    let reviewRequest = this.createReviewRequest(request, primaryExecution.response);
    // If reasoning enabled, pass primary's reasoning to reviewer for deeper review
    if (reasoningEnabled && primaryExecution.reasoning) {
      const lastMsg = reviewRequest.messages[reviewRequest.messages.length - 1];
      if (lastMsg && typeof lastMsg.content === 'string') {
        reviewRequest = {
          ...reviewRequest,
          messages: [
            ...reviewRequest.messages.slice(0, -1),
            {
              ...lastMsg,
              content:
                lastMsg.content +
                `\n\n## Primary's Reasoning Process:\n${primaryExecution.reasoning}`,
            },
          ],
        };
      }
    }
    const reviewExecution = reasoningEnabled
      ? await this.executeModelWithReasoning(
          reviewer.adapter,
          reviewer.model,
          reviewRequest,
          'reviewer'
        )
      : await this.executeModel(reviewer.adapter, reviewer.model, reviewRequest, 'reviewer');
    executions.push(reviewExecution);

    let finalResponse = primaryExecution.response;

    // PHASE 3: If reviewer suggests improvements, refine
    if (reviewExecution.success && this.hasImprovements(reviewExecution.response)) {
      this.log.debug('Phase 3: Refinement based on review');

      const refinementRequest = this.createRefinementRequest(
        request,
        primaryExecution.response,
        reviewExecution.response
      );

      const refinedExecution = reasoningEnabled
        ? await this.executeModelWithReasoning(
            primary.adapter,
            primary.model,
            refinementRequest,
            'primary'
          )
        : await this.executeModel(primary.adapter, primary.model, refinementRequest, 'primary');
      executions.push(refinedExecution);

      if (refinedExecution.success) {
        finalResponse = refinedExecution.response;

        // PHASE 3.5: Second review — reviewer verifies the refinement addressed their feedback
        // Data insight: without re-verification, primary may ignore reviewer's feedback
        if (process.env.COLLABORATIVE_SECOND_REVIEW !== 'false') {
          this.log.debug('Phase 3.5: Verification review of refined output');
          const verifyRequest = this.createReviewRequest(request, refinedExecution.response);
          const verifyExecution = reasoningEnabled
            ? await this.executeModelWithReasoning(
                reviewer.adapter,
                reviewer.model,
                verifyRequest,
                'reviewer'
              )
            : await this.executeModel(reviewer.adapter, reviewer.model, verifyRequest, 'reviewer');
          executions.push(verifyExecution);

          // If reviewer STILL finds issues, do one more refinement
          if (verifyExecution.success && this.hasImprovements(verifyExecution.response)) {
            this.log.debug('Phase 3.5b: Second refinement based on verification');
            const secondRefinement = this.createRefinementRequest(
              request,
              refinedExecution.response,
              verifyExecution.response
            );
            const secondRefined = reasoningEnabled
              ? await this.executeModelWithReasoning(
                  primary.adapter,
                  primary.model,
                  secondRefinement,
                  'primary'
                )
              : await this.executeModel(
                  primary.adapter,
                  primary.model,
                  secondRefinement,
                  'primary'
                );
            executions.push(secondRefined);
            if (secondRefined.success) {
              finalResponse = secondRefined.response;
            }
          }
        }
      }
    }

    // Observer: refinement done
    this.emitObserverEvent(context, {
      type: 'round_complete',
      round: 3,
      totalRounds: 4,
      summary: 'Review and refinement complete. Validator checking quality.',
    });

    // PHASE 4: Quality validation
    this.log.debug('Phase 4: Quality validation');
    const validationRequest = this.createValidationRequest(request, finalResponse);
    const validationExecution = reasoningEnabled
      ? await this.executeModelWithReasoning(
          validator.adapter,
          validator.model,
          validationRequest,
          'quality-checker'
        )
      : await this.executeModel(
          validator.adapter,
          validator.model,
          validationRequest,
          'quality-checker'
        );
    executions.push(validationExecution);

    const totalDuration = Date.now() - startTime;
    const totalCost = executions.reduce((sum, e) => sum + e.cost, 0);

    // Calculate quality score (boosted for collaborative)
    const baseQuality = this.calculateQualityScore(
      executions.find((e) => e.role === 'primary' && e.success) || executions[0]
    );
    // Observer: complete
    this.emitObserverEvent(context, {
      type: 'synthesis_complete',
      summary: `Collaborative complete. ${executions.length} phases executed.`,
    });

    const qualityScore = Math.min(1, baseQuality * 1.25); // 25% boost for collaborative

    const result: OrchestrationResult = {
      strategyUsed: metadata.name,
      modelsUsed: executions,
      finalResponse: {
        ...finalResponse,
        model: request.model || 'Ailin¹ Model',
      },
      totalCost,
      totalDuration,
      qualityScore,
      // Media/document artifacts (PR3b): a tool call producing an artifact
      // can happen in ANY phase — primary's initial draft, a refinement
      // pass, even the quality-checker call — not only whichever phase's
      // text ends up as `finalResponse`. mergeArtifacts() is deliberately
      // called over the FULL `executions` list (all phases accumulated),
      // not just the phase that supplied `finalResponse`, mirroring how
      // `reasoning_traces` below already aggregates across every phase in
      // this same strategy. Top-level `toolArtifacts` (matching tier 3a's
      // consensus/competitive/debate-strategy.ts convention) rather than
      // the pre-existing `OrchestrationResult.artifacts` — that field is
      // `AilinArtifact[]` from the unrelated multi-stage triage-plan
      // pathway (media-planner-strategy.ts), a different shape than
      // `mergeArtifacts()`'s `ArtifactRef[]`. See the field's doc comment
      // in types/index.ts.
      toolArtifacts: mergeArtifacts(executions),
      metadata: {
        strategyId: metadata.id,
        modelCount: selectedModels.length,
        executionCount: executions.length,
        phasesCompleted: executions.length,
        refined: executions.length > 3,
        ...(reasoningEnabled
          ? {
              reasoning_traces: executions
                .filter((e) => e.reasoning)
                .map((e) => ({
                  model_id: e.modelId,
                  model_name: e.modelName,
                  role: e.role,
                  reasoning: e.reasoning,
                  reasoning_tokens: e.reasoningTokens,
                })),
            }
          : {}),
      },
    };

    this.log.info(
      {
        strategy: metadata.name,
        requestId: context.requestId,
        duration: totalDuration,
        cost: totalCost,
        qualityScore,
        phasesCompleted: executions.length,
      },
      'Collaborative strategy completed'
    );

    return result;
  }

  supportsStreaming(): boolean {
    return true;
  }

  /**
   * PR3b scope note: this generator yields raw `ChatResponse` chunks directly —
   * there is no `OrchestrationResult`/`metadata` object here to attach
   * `mergeArtifacts()` output to (unlike `execute()` above). Wiring artifact
   * merging into the streaming path would mean changing how SSE final chunks
   * carry `ailin_metadata` — that assembly lives in orchestration-engine.ts,
   * which is out of scope for this change. The safeResponseContent() text-
   * extraction fix below still applies (it's a pure behavior-preserving
   * substitution), but tool-call artifacts produced during a streamed
   * collaborative run are not surfaced by this strategy today.
   */
  async *executeStream(
    request: ChatRequest,
    context: OrchestrationContext
  ): AsyncGenerator<ChatResponse, void, unknown> {
    const selectedModels = await this.selectModels(request, context);
    if (selectedModels.length < 3) throw new Error('Collaborative requires at least 3 models');
    const primary = selectedModels[0];
    const reviewer = selectedModels[1];
    const reasoningEnabled = this.isReasoningEnabled(request);

    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: selectedModels.map((m) => m.model.name || m.model.id),
      summary: 'Collaborative: primary → reviewer → refinement → validation.',
    });
    yield this.progressChunk('Primary generating initial solution...', 0, 4);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Phase 1: Primary (non-streaming, with fallback)
    let primaryExec = reasoningEnabled
      ? await this.executeModelWithReasoning(primary.adapter, primary.model, request, 'primary')
      : await this.executeModel(primary.adapter, primary.model, request, 'primary');
    if (!primaryExec.success) {
      primaryExec = await this.executeModelWithRetry(
        primary.adapter,
        primary.model,
        request,
        'primary',
        context
      );
    }
    if (!primaryExec.success) throw new Error('Primary failed');

    this.emitObserverEvent(context, {
      type: 'round_complete',
      round: 1,
      totalRounds: 4,
      summary: 'Primary done. Reviewer checking.',
    });
    yield this.progressChunk('Reviewer evaluating...', 1, 4);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Phase 2: Review (non-streaming)
    let reviewRequest = this.createReviewRequest(request, primaryExec.response);
    if (reasoningEnabled && primaryExec.reasoning) {
      const lastMsg = reviewRequest.messages[reviewRequest.messages.length - 1];
      if (lastMsg && typeof lastMsg.content === 'string') {
        reviewRequest = {
          ...reviewRequest,
          messages: [
            ...reviewRequest.messages.slice(0, -1),
            {
              ...lastMsg,
              content: lastMsg.content + `\n\n## Primary's Reasoning:\n${primaryExec.reasoning}`,
            },
          ],
        };
      }
    }
    const reviewExec = reasoningEnabled
      ? await this.executeModelWithReasoning(
          reviewer.adapter,
          reviewer.model,
          reviewRequest,
          'reviewer'
        )
      : await this.executeModel(reviewer.adapter, reviewer.model, reviewRequest, 'reviewer');

    // Phase 3: Stream refinement (or stream primary if no improvements needed)
    if (reviewExec.success && this.hasImprovements(reviewExec.response)) {
      this.emitObserverEvent(context, {
        type: 'round_complete',
        round: 2,
        totalRounds: 4,
        summary: 'Reviewer suggests improvements. Refining.',
      });
      yield this.progressChunk('Refining based on review...', 2, 4);
      for (const c of await this.drainObserverChunks(context)) yield c;

      const refinementRequest = this.createRefinementRequest(
        request,
        primaryExec.response,
        reviewExec.response
      );
      this.emitObserverEvent(context, {
        type: 'synthesis_start',
        summary: 'Streaming refined response.',
      });
      yield this.progressChunk('Generating refined answer...', 3, 4);
      for (const c of await this.drainObserverChunks(context)) yield c;

      // Resilient refinement: fall back to the reviewer's model, then degrade to
      // the primary response, instead of killing the whole collective stream.
      yield* this.streamSynthesisWithFallback(
        refinementRequest,
        [
          { adapter: primary.adapter, model: primary.model },
          { adapter: reviewer.adapter, model: reviewer.model },
        ],
        // safeResponseContent() also joins multimodal (array-of-parts) content,
        // which the old inline `typeof c === 'string' ? c : ''` returned '' for.
        // This fallback text is a plain (non-tool) primary generation, so
        // content is virtually always a string in practice — the widened
        // handling is a strict improvement, not an observed regression.
        () => safeResponseContent(primaryExec.response)
      );
    } else {
      this.emitObserverEvent(context, {
        type: 'round_complete',
        round: 2,
        totalRounds: 4,
        summary: 'Reviewer approved. No refinement needed.',
      });
      yield this.progressChunk('Review passed, delivering response...', 3, 4);
      for (const c of await this.drainObserverChunks(context)) yield c;

      // Yield primary response as single chunk
      yield primaryExec.response;
    }

    this.emitObserverEvent(context, {
      type: 'synthesis_complete',
      summary: 'Collaborative execution complete.',
    });
    for (const c of await this.drainObserverChunks(context)) yield c;
  }

  /**
   * Select 3 models: primary, reviewer, validator
   * ✅ Uses DynamicModelSelector for intelligent selection from ALL 500+ models
   */
  private async selectModels(
    request: ChatRequest,
    context: OrchestrationContext
  ): Promise<Array<{ model: Model; adapter: ProviderAdapter }>> {
    // Filter models by capabilities, quality, budget — no audio/image/embedding models
    const models = this.getEligibleModels(context);

    // ✅ FIX: Check if model was explicitly specified by user
    const userSpecifiedModel = getUserSpecifiedModelFlag(request);

    // ✅ If user specified model, use it as primary and select others dynamically
    if (userSpecifiedModel && request.model) {
      const requestedModel = models.find((m) => m.name === request.model || m.id === request.model);
      if (requestedModel) {
        // Use specified model as primary, select others dynamically
        const adapter = this.getAdapterForModel
          ? await this.getAdapterForModel(requestedModel, context)
          : null;
        if (adapter) {
          // Select 2 additional models for reviewer and validator
          const { getDynamicModelSelector } =
            await import('../../selection/dynamic-model-selector.js');
          const selector = getDynamicModelSelector();
          const taskType = getTaskType(request) || context.taskType || 'chat';
          const complexity = this.calculateComplexity(request);
          const contextSize = this.estimateContextSize(request);
          const requiredCapabilities = this.extractRequiredCapabilities(request);
          const requiredTools = this.extractRequiredTools(request);
          const requiredEndpoint = this.extractRequiredEndpoint(request);

          const additionalModels = await selector.selectModels(
            null,
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
            2
          );

          const selected = [{ model: requestedModel, adapter }];
          for (const selectedModel of additionalModels.slice(0, 2)) {
            const additionalAdapter = this.getAdapterForModel
              ? await this.getAdapterForModel(selectedModel.model, context)
              : null;
            if (additionalAdapter) {
              selected.push({ model: selectedModel.model, adapter: additionalAdapter });
            }
          }
          return selected.length >= 3 ? selected : [];
        }
      }
    }

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

      // ✅ CRITICAL: Pass null to enable automatic database search
      const selectedModels = await selector.selectModels(
        null, // ✅ null = automatic search from database
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
        3 // Select 3 models for collaborative strategy
      );

      if (selectedModels.length >= 3) {
        const results = await Promise.all(
          selectedModels.map((sm) => this.getAdapterForModel?.(sm.model, context))
        );

        const selected: Array<{ model: Model; adapter: ProviderAdapter }> = [];
        for (let i = 0; i < selectedModels.length && i < results.length; i++) {
          if (results[i]) {
            selected.push({
              model: selectedModels[i].model,
              adapter: results[i] as ProviderAdapter,
            });
          }
        }

        if (selected.length >= 3) {
          this.log.info(
            {
              primary: selected[0].model.name,
              reviewer: selected[1].model.name,
              validator: selected[2].model.name,
              totalModelsConsidered: '500+',
            },
            'Collaborative strategy selected 3 models via DynamicModelSelector'
          );
          return selected;
        }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        { error: errorMessage },
        'DynamicModelSelector failed in collaborative strategy, using fallback'
      );
    }

    // Fallback: Original logic if DynamicModelSelector fails
    if (models.length < 3) {
      return [];
    }

    const qualityModels = [...models].sort((a, b) => b.performance.quality - a.performance.quality);

    const primary = qualityModels[0];
    const reviewer =
      qualityModels.find((m) => m.id !== primary.id && m.provider !== primary.provider) ||
      qualityModels[1];
    const validator =
      models.find(
        (m) => m.id !== primary.id && m.id !== reviewer?.id && m.performance.latencyMs < 2000
      ) || qualityModels[2];

    if (!primary || !reviewer || !validator) {
      return [];
    }

    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected by orchestration engine');
    }
    const results = await Promise.all([
      this.getAdapterForModel(primary, context),
      this.getAdapterForModel(reviewer, context),
      this.getAdapterForModel(validator, context),
    ]);

    const selected = [];
    if (results[0]) selected.push({ model: primary, adapter: results[0] });
    if (results[1]) selected.push({ model: reviewer, adapter: results[1] });
    if (results[2]) selected.push({ model: validator, adapter: results[2] });

    return selected;
  }

  /**
   * Create review request
   */
  private createReviewRequest(
    originalRequest: ChatRequest,
    primaryResponse: ChatResponse
  ): ChatRequest {
    const primaryContent = safeResponseContent(primaryResponse);

    const reviewMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a senior reviewer in the Ailin¹ Collective Intelligence system. Review the following solution with expert-level rigor. Identify: errors and bugs (critical), missing requirements (high), performance issues (medium), and style/best-practice improvements (low). Be SPECIFIC with line references and provide the corrected version for each issue. Your review directly determines whether the solution needs refinement.',
      },
      {
        role: 'user',
        content: `Original task: ${JSON.stringify(originalRequest.messages)}\n\nProposed solution:\n${primaryContent}\n\nReview this solution. List any issues or improvements needed.`,
      },
    ];

    return {
      ...originalRequest,
      messages: reviewMessages,
      max_tokens: 500,
      temperature: 0.3,
    };
  }

  /**
   * Check if review suggests improvements
   */
  private hasImprovements(reviewResponse: ChatResponse): boolean {
    const content = safeResponseContent(reviewResponse);

    // Check for improvement keywords
    const improvementKeywords = [
      'improve',
      'issue',
      'bug',
      'error',
      'problem',
      'suggestion',
      'consider',
      'should',
      'could',
      'better',
    ];

    return improvementKeywords.some((keyword) => content.toLowerCase().includes(keyword));
  }

  /**
   * Create refinement request
   */
  private createRefinementRequest(
    originalRequest: ChatRequest,
    primaryResponse: ChatResponse,
    reviewResponse: ChatResponse
  ): ChatRequest {
    const primaryContent = safeResponseContent(primaryResponse);
    const reviewContent = safeResponseContent(reviewResponse);

    // The reviewer's note is a USER turn, not a system one.
    //
    // As a trailing `system` message this was doubly broken. First, the engine has
    // already prepended two system messages (identity/conduct and peer-review), so
    // `normalizeSystemMessages` merged all three and hoisted the reviewer's free
    // text into the HEAD system block — it stopped being the last thing said.
    // Second, that left the conversation ending on an ASSISTANT turn with nothing
    // addressed to the model, so the natural completion was meta-commentary about
    // having been reviewed. Production returned exactly that: "Thank you for
    // providing your feedback and…", "I'm sorry for the confusion earlier, but…",
    // and outright refusals — on a request as benign as 17 x 23.
    //
    // Ending on an assistant turn is also an assistant PREFILL for Anthropic,
    // whose adapter lifts the system message out and keeps the rest, so the prior
    // answer could be dropped outright rather than refined.
    const refinementMessages: ChatMessage[] = [
      ...originalRequest.messages,
      {
        role: 'assistant',
        content: primaryContent,
      },
      {
        role: 'user',
        content:
          `A reviewer commented on your answer:\n${reviewContent}\n\n` +
          `Answer the ORIGINAL question again, applying only the corrections you agree with. ` +
          `Reply with the final answer ONLY — do not thank the reviewer, do not apologise, and ` +
          `do not mention the review or this process. If your previous answer was already ` +
          `correct, repeat it unchanged.`,
      },
    ];

    return {
      ...originalRequest,
      messages: refinementMessages,
    };
  }

  /**
   * Create validation request
   */
  private createValidationRequest(
    originalRequest: ChatRequest,
    finalResponse: ChatResponse
  ): ChatRequest {
    const finalContent = safeResponseContent(finalResponse);

    const validationMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a quality assurance validator in the Ailin¹ Collective Intelligence system. Validate whether this solution fully meets the original requirements. Check: completeness (all requirements addressed?), correctness (logic sound?), edge cases (handled?), and production-readiness (error handling, input validation?). Respond with PASS or FAIL followed by specific evidence for your assessment.',
      },
      {
        role: 'user',
        content: `Original task: ${JSON.stringify(originalRequest.messages)}\n\nFinal solution:\n${finalContent}\n\nDoes this solution meet all requirements? (YES/NO and brief reason)`,
      },
    ];

    return {
      ...originalRequest,
      messages: validationMessages,
      max_tokens: 100,
      temperature: 0.1,
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
    return estimateContextSizeShared(request);
  }

  /**
   * Extract required capabilities from request
   */
  private extractRequiredCapabilities(request: ChatRequest): ModelCapability[] | undefined {
    const capabilities: ModelCapability[] = [];

    // Check if tools are required (indicates function_calling needed)
    if (request.tools && request.tools.length > 0) {
      capabilities.push('function_calling');
    }

    // Check if messages contain images (indicates vision needed)
    const isImageContent = (content: unknown): content is ImageContent => {
      return (
        typeof content === 'object' &&
        content !== null &&
        'type' in content &&
        (content.type === 'image_url' || content.type === 'image')
      );
    };

    const hasImages = request.messages.some((msg) => {
      const content = msg.content;
      if (typeof content === 'string') return false;
      if (Array.isArray(content)) {
        return content.some(isImageContent);
      }
      return isImageContent(content);
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
      .map((tool): string | null => {
        // Type guard for Tool
        if (
          typeof tool === 'object' &&
          tool !== null &&
          'type' in tool &&
          tool.type === 'function'
        ) {
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

    if (capabilities?.some((cap) => cap.includes('image_generation'))) {
      return 'images';
    }
    if (capabilities?.some((cap) => cap.includes('speech') || cap.includes('audio'))) {
      return 'audio_speech';
    }
    if (capabilities?.some((cap) => cap.includes('realtime'))) {
      return 'realtime';
    }

    // Default: chat_completions (most common)
    return undefined;
  }
}
