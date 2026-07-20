// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Multi-Hop QA Strategy
 *
 * Decomposes complex questions into sub-questions with dependency DAG,
 * executes in topological order with context accumulation, and synthesizes.
 *
 * Unlike war-room (parallel independent sub-tasks), multi-hop is SEQUENTIAL
 * with context flow: answer to Q1 feeds into Q3 that depends on Q1.
 *
 * Flow:
 *   1. Decomposer breaks question into sub-questions with dependencies (JSON)
 *   2. Topological sort determines execution order
 *   3. Independent questions execute in parallel
 *   4. Dependent questions execute after their dependencies, with accumulated context
 *   5. Synthesizer combines all sub-answers into final response
 */

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
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

const log = logger.child({ component: 'multi-hop-qa-strategy' });
const TIMEOUT_MS = Number(process.env.MULTI_HOP_TIMEOUT_MS ?? 120000);

interface SubQuestion {
  id: string;
  question: string;
  depends_on: string[];
}

interface SubAnswer {
  id: string;
  question: string;
  answer: string;
}

export class MultiHopQAStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'multi-hop-qa',
      name: 'multi-hop-qa',
      displayName: 'Multi-Hop QA',
      description:
        'Decomposes complex questions into sub-questions with dependencies, executes in topological order with context accumulation.',
      minModels: 2,
      maxModels: 5,
      estimatedCostMultiplier: 4.0,
      estimatedQualityBoost: 0.35,
      estimatedDurationMultiplier: 4.0,
      suitableFor: ['reasoning', 'factual-qa', 'analysis', 'general'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    return Promise.race([
      this.executeCore(request, context, startTime),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Multi-hop timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
    ]);
  }

  private async executeCore(request: ChatRequest, context: OrchestrationContext, startTime: number): Promise<OrchestrationResult> {
    const prep = await this.decomposeAndAnswer(request, context);

    if (prep.mode === 'direct') {
      return {
        finalResponse: prep.directExec.response,
        strategyUsed: 'multi-hop-qa',
        modelsUsed: prep.executions,
        totalCost: prep.executions.reduce((s, e) => s + e.cost, 0),
        totalDuration: Date.now() - startTime,
        metadata: { strategy: 'multi-hop-qa', hops: 0, fallback: true },
      };
    }

    this.emitObserverEvent(context, { type: 'synthesis_start', summary: `Synthesizing ${prep.subQuestionsCount} sub-answers into final response.` });

    // synthesizer/synthAdapter resolved up front (shared with decomposer).
    // executeModelWithRetry: cross-provider failover on synthesis failure.
    // The synthesizer call IS the response — failure here would tank the
    // whole strategy, so retry is critical.
    const synthExec = await this.executeModelWithRetry(prep.decomposerAdapter, prep.synthesizer, prep.synthReq, 'synthesizer', context);
    prep.executions.push(synthExec);

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: `Multi-hop complete: ${prep.subQuestionsCount} sub-questions, ${prep.hops} hops, ${prep.executions.length} model calls.` });

    const reasoningTracesMeta = prep.reasoningEnabled
      ? prep.executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens }))
      : undefined;

    return {
      finalResponse: synthExec.response,
      strategyUsed: 'multi-hop-qa',
      modelsUsed: prep.executions,
      totalCost: prep.executions.reduce((s, e) => s + e.cost, 0),
      totalDuration: Date.now() - startTime,
      metadata: {
        strategy: 'multi-hop-qa',
        subQuestions: prep.subQuestionsCount,
        hops: prep.hops,
        completedQuestions: prep.subQuestionsCount,
        questionIds: prep.questionIds,
        ...(reasoningTracesMeta?.length ? { reasoning_traces: reasoningTracesMeta } : {}),
      },
    };
  }

  /**
   * Shared by executeCore() (buffered) and executeStream() (real token
   * streaming, added 2026-07-11): phases 1+2 — decompose into sub-questions
   * and answer them in topological order — are IDENTICAL for both paths.
   * Only phase 3 (the synthesis call) differs: buffered executeModelWithRetry
   * vs. streamSynthesisWithFallback. Returns either a 'direct' answer (when
   * decomposition failed/degenerated to zero sub-questions — that IS the
   * final answer, already executed) or everything needed to run/stream the
   * synthesis call.
   */
  private async decomposeAndAnswer(
    request: ChatRequest,
    context: OrchestrationContext,
  ): Promise<
    | { mode: 'direct'; directExec: ModelExecution; executions: ModelExecution[] }
    | {
        mode: 'synthesize';
        synthReq: ChatRequest;
        decomposerAdapter: import('@/providers/base/provider-adapter').ProviderAdapter;
        synthesizer: Model;
        executions: ModelExecution[];
        subQuestionsCount: number;
        questionIds: string[];
        hops: number;
        reasoningEnabled: boolean;
      }
  > {
    const models = this.getEligibleModels(context);
    if (models.length < 2) throw new Error('Multi-Hop QA requires at least 2 models');

    // Caminho-C Q2 cross-strategy honor: pin biases the decomposer +
    // synthesizer slots (sorted[0]). The pinned model also leads the
    // `answerers` array — answers from the user's chosen model carry
    // intent through the topological sort.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn(
        { requestId: context.requestId, requestedModel: preference.requestedId, poolSize: models.length },
        'Multi-hop QA: requested model not in operational pool — falling back to quality-sorted decomposer',
      );
    }
    const sorted = assembleExecutors(
      preference,
      models.length,
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    // decomposer and synthesizer are LITERALLY the same model
    // (both = sorted[0]). Resolve once up front with walk-through-sorted
    // so both phases share the same fallback choice and adapter handle.
    // `let` bindings allow rebinding when sorted[0]'s adapter is null.
    let decomposer: Model = sorted[0];
    const answerers = sorted.slice(0, Math.min(5, sorted.length));
    const reasoningEnabled = this.isReasoningEnabled(request);
    const executions: ModelExecution[] = [];
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');

    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');

    // Single-candidate-bail bug fix: walk `sorted` for the decomposer/
    // synthesizer adapter rather than hard-failing on sorted[0]. A
    // partial-coverage outage on the highest-quality model used to kill
    // the strategy before decomposition could even start.
    let decomposerAdapter = await this.getAdapterForModel(decomposer, context);
    if (!decomposerAdapter) {
      for (let i = 1; i < sorted.length; i++) {
        const candidate = sorted[i];
        const adapter = await this.getAdapterForModel(candidate, context);
        if (adapter) {
          log.warn(
            { requestId: context.requestId, primary: sorted[0].name, fallback: candidate.name },
            'Multi-hop QA decomposer/synthesizer: primary had no adapter, using fallback (Decompose + Synthesize share this slot)'
          );
          decomposer = candidate;
          decomposerAdapter = adapter;
          break;
        }
      }
    }
    if (!decomposerAdapter) throw new Error('No operational decomposer in candidate pool');
    const synthesizer = decomposer; // Same model both phases — preserved by walk-through.

    this.emitObserverEvent(context, { type: 'phase_start', models: sorted.slice(0, 3).map(m => m.name || m.id), summary: 'Multi-Hop QA: decomposing question into sub-questions.' });

    // Phase 1: Decompose question into sub-questions with dependencies

    const decomposeReq: ChatRequest = {
      ...request,
      messages: [
        { role: 'system', content: PROMPTS.multiHopDecomposer },
        ...request.messages,
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1000,
      temperature: 0.2,
    };
    // executeModelWithRetry: cross-provider failover on transient
    // decomposer-call failures. Decomposition is the gate to the entire
    // strategy — if all retries fail, we fall through to single-pass.
    const decomposeExec = await this.executeModelWithRetry(decomposerAdapter, decomposer, decomposeReq, 'decomposer', context);
    executions.push(decomposeExec);

    // Parse sub-questions
    let subQuestions: SubQuestion[] = [];
    try {
      const content = decomposeExec.response?.choices?.[0]?.message?.content;
      if (typeof content === 'string') {
        // JSON.parse → unknown. Either bare array or object with `questions` /
        // `sub_questions`. Filter to validated SubQuestion shape so downstream
        // is type-safe.
        const parsed: unknown = JSON.parse(content);
        const rawList: unknown[] = Array.isArray(parsed)
          ? parsed
          : (typeof parsed === 'object' && parsed !== null
              ? (Array.isArray((parsed as { questions?: unknown }).questions)
                  ? (parsed as { questions: unknown[] }).questions
                  : Array.isArray((parsed as { sub_questions?: unknown }).sub_questions)
                    ? (parsed as { sub_questions: unknown[] }).sub_questions
                    : [])
              : []);
        subQuestions = rawList.filter(
          (q): q is SubQuestion =>
            typeof q === 'object' && q !== null && typeof (q as { question?: unknown }).question === 'string',
        );
      }
    } catch {
      log.warn('Failed to parse decomposition, falling back to single-pass');
    }

    if (subQuestions.length === 0) {
      // Fallback: answer directly (decomposition failed). Use retry to
      // give the direct path the same cross-provider failover budget.
      const directExec = reasoningEnabled
        ? await this.executeModelWithReasoning(decomposerAdapter, decomposer, request, 'primary')
        : await this.executeModelWithRetry(decomposerAdapter, decomposer, request, 'primary', context);
      executions.push(directExec);
      return { mode: 'direct', directExec, executions };
    }

    this.emitObserverEvent(context, {
      type: 'round_complete', round: 1, totalRounds: subQuestions.length + 2,
      summary: `Decomposed into ${subQuestions.length} sub-questions.`,
    });

    // Phase 2: Topological execution with context accumulation
    const answers = new Map<string, SubAnswer>();
    const completed = new Set<string>();

    // Topological sort: process questions whose dependencies are all satisfied
    let iteration = 0;
    const maxIterations = subQuestions.length + 1;

    while (completed.size < subQuestions.length && iteration < maxIterations) {
      iteration++;

      // Find questions ready to execute (all dependencies satisfied)
      const ready = subQuestions.filter(q =>
        !completed.has(q.id) &&
        q.depends_on.every(dep => completed.has(dep))
      );

      if (ready.length === 0) {
        log.warn({ completed: completed.size, total: subQuestions.length }, 'No ready questions — possible cycle in dependencies');
        break;
      }

      // Execute ready questions in parallel
      const hopPromises = ready.map(async (sq) => {
        // Build context from previous answers
        const previousAnswers = sq.depends_on
          .filter(dep => answers.has(dep))
          .map(dep => {
            const a = answers.get(dep)!;
            return `### ${a.id}: ${a.question}\n${a.answer}`;
          })
          .join('\n\n');

        // Round-robin answerer selection. If the picked answerer has no
        // operational adapter (provider key missing, model disabled,
        // circuit OPEN), walk forward through `sorted` looking for the
        // next operational candidate rather than failing this hop. This
        // preserves topological progress when a single provider is down.
        let answerer = answerers[completed.size % answerers.length];
        let adapter = await this.getAdapterForModel!(answerer, context);
        if (!adapter) {
          for (let i = 0; i < sorted.length; i++) {
            const candidate = sorted[i];
            if (candidate.id === answerer.id) continue;
            const a = await this.getAdapterForModel!(candidate, context);
            if (a) {
              log.warn(
                { requestId: context.requestId, hopId: sq.id, primary: answerer.name, fallback: candidate.name },
                'Multi-hop answerer: primary had no adapter, using fallback from sorted pool'
              );
              answerer = candidate;
              adapter = a;
              break;
            }
          }
        }
        if (!adapter) throw new Error(`No operational answerer in candidate pool for hop ${sq.id}`);

        const answerReq: ChatRequest = {
          ...request,
          messages: [
            { role: 'system', content: this.withReasoningPrompt(PROMPTS.multiHopAnswerer(sq.id, sq.question, previousAnswers), request, answerer) },
            { role: 'user', content: sq.question },
          ],
        };

        // Default branch uses executeModelWithRetry for cross-provider
        // failover. With-tools and with-reasoning branches keep their
        // dedicated helpers — specialized response-shape handling.
        const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
        const exec = hasTools
          ? await this.executeModelWithTools(adapter, answerer, answerReq, 'answerer')
          : reasoningEnabled
            ? await this.executeModelWithReasoning(adapter, answerer, answerReq, 'answerer')
            : await this.executeModelWithRetry(adapter, answerer, answerReq, 'answerer', context);

        executions.push(exec);

        const answerContent = exec.response?.choices?.[0]?.message?.content;
        const answer = typeof answerContent === 'string' ? answerContent : '';

        return { sq, answer };
      });

      const results = await Promise.allSettled(hopPromises);
      for (const r of results) {
        if (r.status === 'fulfilled') {
          answers.set(r.value.sq.id, {
            id: r.value.sq.id,
            question: r.value.sq.question,
            answer: r.value.answer,
          });
          completed.add(r.value.sq.id);
        }
      }

      this.emitObserverEvent(context, {
        type: 'round_complete',
        round: iteration + 1,
        totalRounds: subQuestions.length + 2,
        summary: `Hop ${iteration}: ${ready.length} sub-questions answered (${completed.size}/${subQuestions.length} complete).`,
      });
    }

    // Phase 3 request build only — execution (buffered vs streamed) is owned
    // by the two callers (executeCore / executeStream) so each can use its
    // own delivery mechanism against the SAME inputs.
    const allAnswersText = [...answers.values()]
      .map(a => `### ${a.id}: ${a.question}\n${a.answer}`)
      .join('\n\n---\n\n');

    const reasoningTraces = reasoningEnabled ? this.formatReasoningForSynthesizer(executions) : '';

    const synthReq: ChatRequest = {
      ...request,
      messages: [
        { role: 'system', content: PROMPTS.multiHopSynthesizer(answers.size) },
        { role: 'user', content: `ORIGINAL QUESTION:\n${originalQ}\n\nSUB-ANSWERS:\n${allAnswersText}${reasoningTraces}\n\nSynthesize into the definitive answer.` },
      ],
    };

    return {
      mode: 'synthesize',
      synthReq,
      decomposerAdapter,
      synthesizer,
      executions,
      subQuestionsCount: subQuestions.length,
      questionIds: subQuestions.map(q => q.id),
      hops: iteration,
      reasoningEnabled,
    };
  }

  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    // Phase 1+2 (decompose + topological hop answering) stay non-streaming —
    // genuinely parallel/sequential model calls with no single "final answer"
    // shape to stream. Phase 3 (the primary synthesis call) IS the final
    // answer and now streams real tokens. The degenerate 'direct' fallback
    // (decomposition JSON failed to parse) stays buffered — it's a rare edge
    // case that reuses executeModelWithReasoning's specialized reasoning-
    // extraction handling, which streaming doesn't replicate; not worth the
    // added complexity for a path that rarely triggers.
    this.emitObserverEvent(context, { type: 'phase_start', summary: 'Multi-Hop QA: decomposing and answering.' });
    yield this.progressChunk('Decomposing question...', 0, 3);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const prep = await this.decomposeAndAnswer(request, context);

    if (prep.mode === 'direct') {
      yield this.progressChunk('Decomposition degenerated — answering directly.', 2, 3);
      for (const c of await this.drainObserverChunks(context)) yield c;
      yield prep.directExec.response;
      for (const c of await this.drainObserverChunks(context)) yield c;
      return;
    }

    yield this.progressChunk(`${prep.hops} reasoning hops complete. Synthesizing...`, 2, 3);
    for (const c of await this.drainObserverChunks(context)) yield c;

    this.emitObserverEvent(context, { type: 'synthesis_start', summary: `Synthesizing ${prep.subQuestionsCount} sub-answers into final response.` });

    // A genuine multi-source synthesis (combines N sub-answers) — same
    // category as the 8 collective strategies fixed earlier, NOT a
    // single-model passthrough. Keeps the default (opt-in) synthesis cap
    // behavior instead of skipSynthesisCap.
    yield* this.streamSynthesisWithFallback(
      prep.synthReq,
      [{ adapter: prep.decomposerAdapter, model: prep.synthesizer }],
      () => prep.synthReq.messages[prep.synthReq.messages.length - 1]?.content as string ?? '',
    );

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: `Multi-hop complete: ${prep.subQuestionsCount} sub-questions, ${prep.hops} hops.` });
    for (const c of await this.drainObserverChunks(context)) yield c;
  }
}
