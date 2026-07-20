// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Stigmergic Refinement Strategy
 *
 * Operating principles:
 * - Stigmergic coordination: indirect coordination via shared artifacts
 * - Wiki-style refinement: incremental improvement without destruction
 * - Team-development progression: formation → conflict → normalization → performance
 *
 * Model 1 → draft. Model 2 → refines (sees draft). Model 3 → critiques.
 * Model 4 (synthesizer) → final version incorporating all refinements.
 * Each model builds on the previous without destroying it.
 */

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import { narrowAs } from '@/utils/type-guards';
import { resolvePreferredExecutor, assembleExecutors } from './preferred-model-helper';
import { PROMPTS, ADAPTIVE_DEPTH_DIRECTIVE } from '../prompts/sota-system-prompts';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  ModelRole,
  Model,
} from '@/types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'stigmergic-refinement' });
const TIMEOUT_MS = Number(process.env.STIGMERGIC_TIMEOUT_MS ?? 300_000);

export class StigmergicRefinementStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'stigmergic-refinement',
      name: 'stigmergic-refinement',
      displayName: 'Stigmergic Refinement (Wiki-style)',
      description: 'Sequential refinement: draft → refine → critique → synthesize. Each model builds on prior work.',
      minModels: 3,
      maxModels: 4,
      estimatedCostMultiplier: 4.0,
      estimatedQualityBoost: 0.35,
      estimatedDurationMultiplier: 4.0,
      suitableFor: ['documentation', 'creative', 'analysis', 'code-review', 'refactoring'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    return Promise.race([
      this.executeCore(request, context, startTime),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Stigmergic refinement timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      ),
    ]);
  }

  private async executeCore(request: ChatRequest, context: OrchestrationContext, startTime: number): Promise<OrchestrationResult> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Stigmergic refinement requires at least 3 models');

    // Caminho-C Q2 cross-strategy honor: pin biases the synthesizer slot
    // (sorted[0]) — the role that produces the final answer. The pipeline
    // upstream (drafter → refiner → critic) stays as next-best peers from
    // the fallback pool to preserve refinement diversity.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn(
        { requestId: context.requestId, requestedModel: preference.requestedId, poolSize: models.length },
        'Stigmergic refinement: requested model not in operational pool — falling back to quality-sorted synthesizer',
      );
    }
    const sorted = assembleExecutors(
      preference,
      Math.min(4, models.length),
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    const [synthesizer, critic, refiner, drafter] = sorted.length >= 4 ? sorted : [sorted[0], sorted[1], sorted[2], sorted[Math.min(2, sorted.length - 1)]];

    const executions: ModelExecution[] = [];
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');

    log.info({ drafter: drafter.id, refiner: refiner.id, critic: critic.id, synthesizer: synthesizer.id }, 'Stigmergic refinement: starting');

    // Observer: phase start
    this.emitObserverEvent(context, { type: 'phase_start', models: [drafter, refiner, critic, synthesizer].map(m => m.name || m.id), summary: 'Stigmergic refinement: drafter → refiner → critic → synthesizer pipeline.' });

    // Phase 1: Drafter produces initial draft
    const draft = await this.callModel(drafter, { ...request, messages: [{ role: 'system', content: PROMPTS.stigmergicDrafter() }, ...request.messages] }, 'drafter', context, executions);
    if (!draft) return this.emptyResult(startTime, executions);

    // Observer: draft done
    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 4, summary: 'Initial draft produced. Refiner improving.' });

    // Phase 2: Refiner improves the draft
    const refined = await this.callModel(refiner, { ...request, messages: [{ role: 'system', content: PROMPTS.stigmergicRefiner }, { role: 'user', content: `ORIGINAL QUESTION:\n${originalQ}\n\nDRAFT TO REFINE:\n${draft}\n\nProduce the improved version.` }] }, 'refiner', context, executions);
    if (!refined) return this.emptyResult(startTime, executions);

    // Observer: refinement done
    this.emitObserverEvent(context, { type: 'round_complete', round: 2, totalRounds: 4, summary: 'Refinement complete. Critic reviewing.' });

    // Phase 3: Critic reviews — prompt migrated to the SOTA catalog (R3).
    const critique = await this.callModel(
      critic,
      { ...request, messages: [{ role: 'system', content: PROMPTS.stigmergicCritic(originalQ, refined) }, { role: 'user', content: 'Produce the critique.' }] },
      'critic',
      context,
      executions,
    );

    // Observer: critique done
    this.emitObserverEvent(context, { type: 'round_complete', round: 3, totalRounds: 4, summary: 'Critique complete. Synthesizer producing final version.' });
    this.emitObserverEvent(context, { type: 'synthesis_start', summary: 'Synthesizer merging refined output with critic feedback.' });

    // Phase 4: Synthesizer produces final version
    // Include reasoning traces from drafter/refiner/critic so synthesizer understands their logic
    const reasoningTraces = this.isReasoningEnabled(request) ? this.formatReasoningForSynthesizer(executions) : '';
    const synthPrompt = critique
      ? `Produce the final version incorporating the critic's feedback.\n\nORIGINAL QUESTION:\n${originalQ}\n\nCURRENT VERSION:\n${refined}\n\nCRITIC'S FEEDBACK:\n${critique}${reasoningTraces}\n\nProduce the definitive final answer.\n${ADAPTIVE_DEPTH_DIRECTIVE}`
      : `Produce the final polished version.\n\nORIGINAL QUESTION:\n${originalQ}\n\nCURRENT VERSION:\n${refined}${reasoningTraces}\n\nPolish and finalize.\n${ADAPTIVE_DEPTH_DIRECTIVE}`;

    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const synthAdapter = await this.getAdapterForModel(synthesizer, context);
    if (!synthAdapter) throw new Error(`No adapter for ${synthesizer.id}`);
    const synthExec = await this.executeModel(synthAdapter, synthesizer, { ...request, messages: [{ role: 'user', content: synthPrompt }] }, 'synthesizer');
    executions.push(synthExec);

    return {
      finalResponse: synthExec.response, strategyUsed: 'stigmergic-refinement', modelsUsed: executions,
        totalDuration: Date.now() - startTime, totalCost: executions.reduce((s, e) => s + (e.cost ?? 0), 0),
        metadata: {
          strategy: 'stigmergic-refinement', phases: 4, drafter: drafter.id, refiner: refiner.id, critic: critic.id, synthesizer: synthesizer.id,
          ...(this.isReasoningEnabled(request) ? { reasoning_traces: executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) } : {}),
        },
      };
  }

  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Stigmergic refinement requires at least 3 models');
    const preference = resolvePreferredExecutor(models, context, []);
    const sorted = assembleExecutors(
      preference,
      Math.min(4, models.length),
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    const [synthesizer, critic, refiner, drafter] = sorted.length >= 4 ? sorted : [sorted[0], sorted[1], sorted[2], sorted[Math.min(2, sorted.length - 1)]];
    const executions: ModelExecution[] = [];
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');

    this.emitObserverEvent(context, { type: 'phase_start', models: [drafter, refiner, critic, synthesizer].map(m => m.name || m.id), summary: 'Stigmergic: drafter → refiner → critic → synthesizer.' });
    yield this.progressChunk('Drafting initial response...', 0, 4);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Phase 1: Draft
    const drafterReq: ChatRequest = { ...request, messages: [{ role: 'system' as const, content: PROMPTS.stigmergicDrafter() }, ...request.messages] };
    let draft = await this.callModel(drafter, drafterReq, 'drafter', context, executions);
    if (!draft) {
      // Fallback: retry with alternate models
      const drafterAdapter = await this.getAdapterForModel!(drafter, context);
      if (drafterAdapter) {
        const retryExec = await this.executeModelWithRetry(drafterAdapter, drafter, drafterReq, 'drafter', context);
        executions.push(retryExec);
        const retryContent = retryExec.response?.choices?.[0]?.message?.content;
        if (retryExec.success && typeof retryContent === 'string') draft = retryContent;
      }
    }
    if (!draft) throw new Error('Drafter failed');

    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 4, summary: 'Draft complete. Refiner improving.' });
    yield this.progressChunk('Refining draft...', 1, 4);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Phase 2: Refine
    const refinerReq: ChatRequest = { ...request, messages: [{ role: 'system' as const, content: PROMPTS.stigmergicRefiner }, { role: 'user' as const, content: `ORIGINAL:\n${originalQ}\n\nDRAFT:\n${draft}\n\nImprove it.` }] };
    let refined = await this.callModel(refiner, refinerReq, 'refiner', context, executions);
    if (!refined) {
      // Fallback: retry with alternate models
      const refinerAdapter = await this.getAdapterForModel!(refiner, context);
      if (refinerAdapter) {
        const retryExec = await this.executeModelWithRetry(refinerAdapter, refiner, refinerReq, 'refiner', context);
        executions.push(retryExec);
        const retryContent = retryExec.response?.choices?.[0]?.message?.content;
        if (retryExec.success && typeof retryContent === 'string') refined = retryContent;
      }
    }
    if (!refined) throw new Error('Refiner failed');

    this.emitObserverEvent(context, { type: 'round_complete', round: 2, totalRounds: 4, summary: 'Refinement complete. Critic reviewing.' });
    yield this.progressChunk('Critic reviewing...', 2, 4);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Phase 3: Critique
    const critique = await this.callModel(critic, { ...request, messages: [{ role: 'user', content: `Review this response. Identify issues.\n\nORIGINAL:\n${originalQ}\n\nRESPONSE:\n${refined}\n\nProvide feedback.` }] }, 'critic', context, executions);

    this.emitObserverEvent(context, { type: 'round_complete', round: 3, totalRounds: 4, summary: 'Critique done. Synthesizing final version.' });
    this.emitObserverEvent(context, { type: 'synthesis_start', summary: 'Synthesizer producing final version.' });
    yield this.progressChunk('Synthesizing final answer...', 3, 4);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Phase 4: Stream synthesis
    const reasoningTraces = this.isReasoningEnabled(request) ? this.formatReasoningForSynthesizer(executions) : '';
    const synthPrompt = critique
      ? `Final version.\n\nORIGINAL:\n${originalQ}\n\nCURRENT:\n${refined}\n\nCRITIC:\n${critique}${reasoningTraces}\n\nProduce definitive answer.\n${ADAPTIVE_DEPTH_DIRECTIVE}`
      : `Polish.\n\nORIGINAL:\n${originalQ}\n\nCURRENT:\n${refined}${reasoningTraces}\n\nFinalize.\n${ADAPTIVE_DEPTH_DIRECTIVE}`;

    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const synthAdapter = await this.getAdapterForModel(synthesizer, context);
    if (!synthAdapter) throw new Error(`No adapter for synthesizer`);
    // RESILIENT streaming: bare for-await had NO first-token deadline. Route
    // through the fallback-chain helper (first-chunk + idle deadlines, graceful
    // degrade to the already-refined draft instead of a hard stream failure).
    yield* this.streamSynthesisWithFallback(
      { ...request, messages: [{ role: 'user', content: synthPrompt }] },
      [{ adapter: synthAdapter, model: synthesizer }],
      () => refined.slice(0, 4000),
    );

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Stigmergic refinement complete.' });
    for (const c of await this.drainObserverChunks(context)) yield c;
  }

  private async callModel(model: Model, request: ChatRequest, role: string, context: OrchestrationContext, executions: ModelExecution[]): Promise<string | null> {
    const execStart = Date.now();
    try {
      if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) throw new Error(`No adapter for ${model.id}`);

      // Wrap system prompt with reasoning if enabled
      const reasoningEnabled = this.isReasoningEnabled(request);
      // Wrap system prompt with reasoning if enabled + per-model native thinking detection
      const reqWithReasoning = reasoningEnabled && request.messages[0]?.role === 'system'
        ? { ...request, messages: [{ ...request.messages[0], content: this.withReasoningPrompt(typeof request.messages[0].content === 'string' ? request.messages[0].content : '', request, model) }, ...request.messages.slice(1)] }
        : request;

      const exec = reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, model, reqWithReasoning, role as ModelRole)
        : await this.executeModel(adapter, model, reqWithReasoning, role as ModelRole);

      executions.push(exec);
      const rawContent = exec.response?.choices?.[0]?.message?.content;
      return typeof rawContent === 'string' ? rawContent : null;
    } catch (err) {
      executions.push({ modelId: model.id, modelName: model.name, role: role as ModelRole, request, response: this.errorResponse(model), cost: 0, durationMs: Date.now() - execStart, success: false, error: String(err) });
      return null;
    }
  }

  private errorResponse(model: Model): ChatResponse {
    return { id: `error-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model.name, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop', logprobs: null }] };
  }

  private emptyResult(startTime: number, executions: ModelExecution[]): OrchestrationResult {
    return { finalResponse: this.errorResponse(narrowAs<Model>({ id: 'unknown', name: 'unknown' })), strategyUsed: 'stigmergic-refinement', modelsUsed: executions, totalDuration: Date.now() - startTime, totalCost: 0, metadata: { strategy: 'stigmergic-refinement', error: 'phase-failed' } };
  }
}
