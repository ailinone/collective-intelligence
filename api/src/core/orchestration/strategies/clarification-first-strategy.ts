// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Clarification-First Strategy
 *
 * Operating principles:
 * - Design-thinking "empathize" phase
 * - Requirements engineering: elicitation before execution
 * - Conversational maxims: ensure mutual understanding
 *
 * Assesses prompt ambiguity, generates clarification questions if needed,
 * then delegates to the most appropriate strategy with enriched context.
 *
 * Flow:
 *   1. Analyzer evaluates ambiguity (0-1 score)
 *   2. If clear (< threshold): delegate immediately to best strategy
 *   3. If ambiguous: 2 independent Questioners generate clarification questions
 *   4. Synthesizer merges into max 5 non-redundant questions
 *   5. Return questions to user (special response type)
 *   6. On re-submission with answers: re-triage with enriched context
 */

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import { isObject } from '@/utils/type-guards';
import { resolvePreferredExecutor, assembleExecutors } from './preferred-model-helper';
import { PROMPTS } from '../prompts/sota-system-prompts';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
} from '@/types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'clarification-first-strategy' });
const AMBIGUITY_THRESHOLD = Number(process.env.CLARIFICATION_THRESHOLD ?? 0.4);

export class ClarificationFirstStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'clarification-first',
      name: 'clarification-first',
      displayName: 'Clarification-First',
      description:
        'Assesses prompt ambiguity and generates clarification questions before execution. Reduces wasted computation on ambiguous requests.',
      minModels: 2,
      maxModels: 4,
      estimatedCostMultiplier: 2.0,
      estimatedQualityBoost: 0.30,
      estimatedDurationMultiplier: 1.5,
      suitableFor: ['general', 'analysis', 'creative', 'documentation'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const analysis = await this.analyzeAmbiguity(request, context);

    // Early exit: prompt is clear enough
    if (!analysis.needsClarification) {
      log.info({ ambiguityScore: analysis.ambiguityScore }, 'Prompt clear, no clarification needed');

      const directRequest = this.withPeerReviewPrompt(request);
      const directExec = this.isReasoningEnabled(request)
        ? await this.executeModelWithReasoning(analysis.analyzerAdapter, analysis.analyzer, directRequest, 'primary')
        : await this.executeModel(analysis.analyzerAdapter, analysis.analyzer, directRequest, 'primary');
      const executions = [...analysis.executions, directExec];

      this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Prompt was clear. Direct response generated.' });

      return {
        finalResponse: directExec.response,
        strategyUsed: 'clarification-first',
        modelsUsed: executions,
        totalCost: executions.reduce((s, e) => s + e.cost, 0),
        totalDuration: Date.now() - startTime,
        metadata: {
          strategy: 'clarification-first',
          ambiguity_score: analysis.ambiguityScore,
          clarification_needed: false,
          early_exit: true,
          ...(this.isReasoningEnabled(request) && executions.some(e => e.reasoning)
            ? { reasoning_traces: executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) }
            : {}),
        },
      };
    }

    return this.executeClarificationQuestions(request, context, startTime, analysis);
  }

  /**
   * Shared by execute() (buffered) and executeStream() (real token
   * streaming, added 2026-07-11): phase 1 — ambiguity analysis — is
   * IDENTICAL for both paths and determines which branch runs next.
   */
  private async analyzeAmbiguity(
    request: ChatRequest,
    context: OrchestrationContext,
  ): Promise<{
    analyzer: Model;
    questioners: Model[];
    synthesizer: Model;
    analyzerAdapter: import('@/providers/base/provider-adapter').ProviderAdapter;
    executions: ModelExecution[];
    ambiguityScore: number;
    needsClarification: boolean;
  }> {
    const models = this.getEligibleModels(context);
    if (models.length < 2) throw new Error('Clarification-First requires at least 2 models');

    // Caminho-C Q2 cross-strategy honor: pin biases the analyzer/synthesizer
    // slot (the leader role). Questioners stay as the next-best peers from
    // the fallback pool so question-generation diversity is preserved.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn(
        { requestId: context.requestId, requestedModel: preference.requestedId, poolSize: models.length },
        'Clarification-first: requested model not in operational pool — falling back to quality-sorted analyzer',
      );
    }
    const sorted = assembleExecutors(
      preference,
      models.length,
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    const analyzer = sorted[0];
    const questioners = sorted.slice(1, 3); // 1-2 questioners
    const synthesizer = sorted[0]; // reuse analyzer as synthesizer

    const executions: ModelExecution[] = [];

    // Observer: start
    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: [analyzer, ...questioners].map(m => m.name || m.id),
      summary: 'Clarification-First: analyzing prompt ambiguity.',
    });

    // Phase 1: Analyze ambiguity
    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const analyzerAdapter = await this.getAdapterForModel(analyzer, context);
    if (!analyzerAdapter) throw new Error(`No adapter for analyzer ${analyzer.id}`);

    const analyzerRequest: ChatRequest = {
      ...request,
      messages: [
        { role: 'system', content: PROMPTS.clarificationAnalyzer },
        ...request.messages,
      ],
      response_format: { type: 'json_object' },
      max_tokens: 300,
      temperature: 0.1,
    };

    const analyzerExec = await this.executeModel(analyzerAdapter, analyzer, analyzerRequest, 'analyzer');
    executions.push(analyzerExec);

    // Parse ambiguity assessment
    let ambiguityScore = 0;
    let needsClarification = false;
    try {
      const content = analyzerExec.response?.choices?.[0]?.message?.content;
      if (typeof content === 'string') {
        const parsed: unknown = JSON.parse(content);
        if (typeof parsed === 'object' && parsed !== null) {
          const obj = parsed as { ambiguity_score?: unknown; needs_clarification?: unknown };
          ambiguityScore = typeof obj.ambiguity_score === 'number' ? obj.ambiguity_score : 0;
          needsClarification = obj.needs_clarification === true || ambiguityScore >= AMBIGUITY_THRESHOLD;
        }
      }
    } catch {
      log.debug('Failed to parse analyzer output, treating as clear');
    }

    this.emitObserverEvent(context, {
      type: 'round_complete',
      round: 1, totalRounds: needsClarification ? 3 : 1,
      summary: `Ambiguity score: ${ambiguityScore.toFixed(2)}. ${needsClarification ? 'Generating clarification questions.' : 'Prompt is clear, delegating.'}`,
    });

    return { analyzer, questioners, synthesizer, analyzerAdapter, executions, ambiguityScore, needsClarification };
  }

  /**
   * Phase 2+3 (only reached when analyzeAmbiguity found the prompt
   * ambiguous): generate clarification questions from N questioners and
   * synthesize into one deduplicated list. Shared by execute() and
   * executeStream() — this path stays buffered in both since the output is
   * short (max_tokens: 500) and streaming it adds no perceptible value.
   */
  private async executeClarificationQuestions(
    request: ChatRequest,
    context: OrchestrationContext,
    startTime: number,
    analysis: {
      analyzer: Model;
      questioners: Model[];
      synthesizer: Model;
      analyzerAdapter: import('@/providers/base/provider-adapter').ProviderAdapter;
      executions: ModelExecution[];
      ambiguityScore: number;
    },
  ): Promise<OrchestrationResult> {
    const { analyzer, questioners, synthesizer, analyzerAdapter, ambiguityScore } = analysis;
    const executions = analysis.executions;

    // Phase 2: Generate clarification questions (parallel blind)
    log.info({ ambiguityScore, questionerCount: questioners.length }, 'Generating clarification questions');

    const questionSets: string[] = [];
    const questionPromises = questioners.map(async (model) => {
      if (!this.getAdapterForModel) return;
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) return;
      const qRequest: ChatRequest = {
        ...request,
        messages: [
          { role: 'system', content: PROMPTS.clarificationQuestioner },
          ...request.messages,
        ],
        max_tokens: 500,
      };
      const exec = await this.executeModel(adapter, model, qRequest, 'questioner');
      executions.push(exec);
      const content = exec.response?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) questionSets.push(content);
    });
    await Promise.allSettled(questionPromises);

    if (questionSets.length === 0) {
      // Fallback: couldn't generate questions, respond directly
      const directExec = await this.executeModel(analyzerAdapter, analyzer, request, 'primary');
      executions.push(directExec);
      return {
        finalResponse: directExec.response,
        strategyUsed: 'clarification-first',
        modelsUsed: executions,
        totalCost: executions.reduce((s, e) => s + e.cost, 0),
        totalDuration: Date.now() - startTime,
        metadata: { strategy: 'clarification-first', ambiguity_score: ambiguityScore, clarification_needed: true, questions_generated: false },
      };
    }

    this.emitObserverEvent(context, {
      type: 'round_complete', round: 2, totalRounds: 3,
      summary: `${questionSets.length} question sets generated. Synthesizing.`,
    });

    // Phase 3: Synthesize questions
    const allQuestions = questionSets.join('\n\n---\n\n');
    const synthRequest: ChatRequest = {
      ...request,
      messages: [
        { role: 'system', content: PROMPTS.clarificationSynthesizer(questionSets.length) },
        { role: 'user', content: `ORIGINAL REQUEST:\n${request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n')}\n\nQUESTION SETS:\n${allQuestions}` },
      ],
      max_tokens: 500,
    };
    const synthExec = await this.executeModel(analyzerAdapter, synthesizer, synthRequest, 'synthesizer');
    executions.push(synthExec);

    // Coerce ChatMessage.content (`string | MessageContent[]`) into a flat
    // string for the clarification metadata, which is typed as `string`.
    // For MessageContent arrays, concatenate any `text`-typed fragments.
    const rawContent = synthExec.response?.choices?.[0]?.message?.content;
    const finalQuestions: string = typeof rawContent === 'string'
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent
            .map((part) =>
              typeof part === 'string'
                ? part
                : isObject(part) && part['type'] === 'text' && typeof part['text'] === 'string'
                  ? part['text']
                  : ''
            )
            .join('\n')
        : '';

    this.emitObserverEvent(context, {
      type: 'synthesis_complete',
      summary: `Clarification questions ready for user.`,
    });

    // Build clarification response
    const clarificationResponse: ChatResponse = {
      id: `clar-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: synthesizer.name || 'clarification-first',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: `I'd like to make sure I give you the best possible answer. Could you help me understand a few things?\n\n${finalQuestions}\n\nOnce you provide these details, I'll be able to give you a much more targeted and useful response.`,
        },
        finish_reason: 'stop',
        logprobs: null,
      }],
      ailin_metadata: {
        type: 'clarification',
        ambiguity_score: ambiguityScore,
        questions: finalQuestions,
      },
    };

    return {
      finalResponse: clarificationResponse,
      strategyUsed: 'clarification-first',
      modelsUsed: executions,
      totalCost: executions.reduce((s, e) => s + e.cost, 0),
      totalDuration: Date.now() - startTime,
      metadata: {
        strategy: 'clarification-first',
        ambiguity_score: ambiguityScore,
        clarification_needed: true,
        questions_count: typeof finalQuestions === 'string' ? finalQuestions.split('\n').filter((l: string) => /^\d/.test(l.trim())).length : 0,
        ...(this.isReasoningEnabled(request) && executions.some(e => e.reasoning)
          ? { reasoning_traces: executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) }
          : {}),
      },
    };
  }

  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    const startTime = Date.now();
    this.emitObserverEvent(context, { type: 'phase_start', summary: 'Clarification-First: analyzing ambiguity.' });
    yield this.progressChunk('Analyzing request clarity...', 0, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const analysis = await this.analyzeAmbiguity(request, context);

    yield this.progressChunk('Analysis complete.', 1, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    if (!analysis.needsClarification) {
      // Prompt is clear: this is a genuine single-answer delegation, safe
      // to stream live — no post-hoc decision discards it.
      log.info({ ambiguityScore: analysis.ambiguityScore }, 'Prompt clear, no clarification needed (streaming)');
      const directRequest = this.withPeerReviewPrompt(request);
      yield* this.streamSynthesisWithFallback(
        directRequest,
        [{ adapter: analysis.analyzerAdapter, model: analysis.analyzer }],
        () => '',
        { throwOnTotalFailure: true, skipSynthesisCap: true },
      );
      for (const c of await this.drainObserverChunks(context)) yield c;
      return;
    }

    // Ambiguous: question generation stays buffered (short output, no
    // value in streaming it) — run and yield the whole result at once.
    const result = await this.executeClarificationQuestions(request, context, startTime, analysis);
    for (const c of await this.drainObserverChunks(context)) yield c;
    yield result.finalResponse;
  }
}
