// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Blind Debate Strategy
 *
 * Operating principles:
 * - Independence preservation: each model responds without seeing peers'
 *   answers (anti-cascade — prevents herding behavior)
 * - Parallel adjudication: independent votes converge to truth
 *
 * All models respond in PARALLEL (blind), then adjudicator synthesizes.
 */

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import { PROMPTS } from '../prompts/sota-system-prompts';
import { resolvePreferredExecutor, withPreferredFirst } from './preferred-model-helper';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
} from '@/types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'blind-debate-strategy' });

const TIMEOUT_MS = Number(process.env.BLIND_DEBATE_TIMEOUT_MS ?? 300_000);

export class BlindDebateStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'blind-debate',
      name: 'blind-debate',
      displayName: 'Blind Debate (Independent Parallel)',
      description: 'Multiple models respond independently in parallel, then adjudicator synthesizes. Independence-preservation principle (anti-cascade).',
      minModels: 3,
      maxModels: 7,
      estimatedCostMultiplier: 4.0,
      estimatedQualityBoost: 0.30,
      estimatedDurationMultiplier: 2.5,
      suitableFor: ['analysis', 'reasoning', 'code-review', 'debugging', 'documentation', 'refactoring'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    return Promise.race([
      this.executeCore(request, context, startTime),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Blind debate timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      ),
    ]);
  }

  private async executeCore(
    request: ChatRequest,
    context: OrchestrationContext,
    startTime: number,
  ): Promise<OrchestrationResult> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Blind debate requires at least 3 models');

    const numModels = Math.min(5, models.length);
    const selected = await this.selectDiverseModels(models, numModels);

    // Pin biases the adjudicator slot (final synthesizer). Respondents
    // intentionally stay as next-best peers — the independence-preservation
    // principle requires the jury form opinions without external bias.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn({
        attempted: context.preferredModelIds?.[0],
        reason: preference.pinReason,
      }, 'Preferred model not eligible — falling back to quality-sorted adjudicator.');
    }
    const fallbackSelected = preference.pinnedExecutor
      ? selected.filter(m => m.id !== preference.pinnedExecutor!.id)
      : selected;
    const sortedFallback = [...fallbackSelected].sort((a, b) =>
      (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    const sorted = withPreferredFirst(preference, sortedFallback);
    const adjudicator = sorted[0];
    const respondents = sorted.slice(1);

    log.info({
      adjudicator: adjudicator.id,
      respondents: respondents.map(m => m.id),
    }, 'Blind debate: starting parallel responses');

    const executions: ModelExecution[] = [];

    // Observer: phase start
    this.emitObserverEvent(context, { type: 'phase_start', models: respondents.map(m => m.name || m.id), summary: `Blind debate: ${respondents.length} respondents answering independently in parallel.` });

    // Phase 1: ALL respondents answer in PARALLEL (blind)
    // F3-EXPAND: resolve slots + variant for blind respondent (same pattern as consensus)
    const promptSlots = process.env.ENABLE_PROMPT_SLOTS === 'true'
      ? (context.executionPlan ?? context.triage?.executionPlan)?.stages?.[0]?.promptSlots
      : undefined;
    const selectedVariant = this.selectPromptVariant('blindRespondent', context);
    const activeVariantId = selectedVariant?.id;

    const basePrompt = selectedVariant
      ? selectedVariant.content
      : PROMPTS.blindRespondent(promptSlots);
    const blindSystemPrompt = this.withReasoningPrompt(basePrompt, request);
    const blindRequest: ChatRequest = {
      ...request,
      messages: [
        { role: 'system', content: blindSystemPrompt },
        ...request.messages,
      ],
    };
    const reasoningEnabled = this.isReasoningEnabled(request);

    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    const responsePromises = respondents.map(async (model) => {
      if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) throw new Error(`No adapter for ${model.id}`);
      const exec = hasTools
        ? await this.executeModelWithTools(adapter, model, blindRequest, 'respondent')
        : reasoningEnabled
          ? await this.executeModelWithReasoning(adapter, model, blindRequest, 'respondent')
          : await this.executeModel(adapter, model, blindRequest, 'respondent');
      // F3-EXPAND + F4-INT: tag execution for feedback loop (promptKey required for bandit reward)
      if (activeVariantId) {
        exec.promptVariantId = activeVariantId;
        exec.promptKey = 'blindRespondent';
      }
      if (promptSlots) {
        const { hashSlotValues } = await import('../prompts/prompt-slots');
        exec.promptSlotHash = hashSlotValues(promptSlots);
      }
      const rawContent = exec.response?.choices?.[0]?.message?.content;
      return { model, content: typeof rawContent === 'string' ? rawContent : '', exec };
    });

    const results = await Promise.allSettled(responsePromises);
    const successfulResponses: Array<{ modelName: string; content: string }> = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        executions.push(result.value.exec);
        const content = typeof result.value.content === 'string' ? result.value.content.trim() : '';
        if (content) {
          successfulResponses.push({ modelName: result.value.model.displayName || result.value.model.id, content });
        }
      }
    }

    if (successfulResponses.length === 0) {
      return this.emptyResult(startTime, executions);
    }

    // Observer: responses collected
    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 1, summary: `${successfulResponses.length} independent responses collected. Adjudicator synthesizing.` });
    this.emitObserverEvent(context, { type: 'synthesis_start', modelName: adjudicator.name || adjudicator.id, summary: 'Adjudicator evaluating and synthesizing independent responses.' });

    // Phase 2: Adjudicator synthesizes
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const responsesText = successfulResponses.map((r, i) => `### Response ${i + 1} (${r.modelName}):\n${r.content}`).join('\n\n---\n\n');

    // Include reasoning traces if enabled — adjudicator sees HOW each respondent reasoned
    const reasoningTraces = reasoningEnabled ? this.formatReasoningForSynthesizer(executions) : '';

    const synthesisRequest: ChatRequest = {
      ...request,
      messages: [{
        role: 'user',
        content: `${PROMPTS.blindAdjudicator(successfulResponses.length)}\n\nORIGINAL QUESTION:\n${originalQ}\n\nINDEPENDENT RESPONSES:\n${responsesText}${reasoningTraces}`,
      }],
    };

    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const adjAdapter = await this.getAdapterForModel(adjudicator, context);
    if (!adjAdapter) throw new Error(`No adapter for adjudicator ${adjudicator.id}`);
    const adjExec = await this.executeModel(adjAdapter, adjudicator, synthesisRequest, 'adjudicator');
    executions.push(adjExec);

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Adjudicator produced definitive answer.' });

    return {
      finalResponse: adjExec.response,
      strategyUsed: 'blind-debate',
      modelsUsed: executions,
      totalDuration: Date.now() - startTime,
      totalCost: executions.reduce((s, e) => s + (e.cost ?? 0), 0),
      metadata: {
        strategy: 'blind-debate', respondents: respondents.length, successfulResponses: successfulResponses.length, adjudicator: adjudicator.id, independencePreserved: true,
        ...(reasoningEnabled ? { reasoning_traces: executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) } : {}),
      },
    };
  }

  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Blind debate requires at least 3 models');
    const selected = await this.selectDiverseModels(models, Math.min(5, models.length));
    // Pin biases the adjudicator slot (same rationale as execute()).
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn({
        attempted: context.preferredModelIds?.[0],
        reason: preference.pinReason,
      }, 'Preferred model not eligible — falling back to quality-sorted adjudicator.');
    }
    const fallbackSelected = preference.pinnedExecutor
      ? selected.filter(m => m.id !== preference.pinnedExecutor!.id)
      : selected;
    const sortedFallback = [...fallbackSelected].sort((a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5));
    const sorted = withPreferredFirst(preference, sortedFallback);
    const adjudicator = sorted[0];
    const respondents = sorted.slice(1);

    // Phase 1: blind responses (parallel)
    this.emitObserverEvent(context, { type: 'phase_start', models: respondents.map(m => m.name || m.id), summary: `Blind debate: ${respondents.length} respondents answering independently.` });
    yield this.progressChunk(`${respondents.length} models responding independently...`, 0, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Note: model param omitted here because blindSystemPrompt is shared across all respondents.
    // Native thinking is detected per-model in executeModelWithReasoning() instead.
    const blindSystemPrompt = this.withReasoningPrompt(PROMPTS.blindRespondent(), request);
    const blindRequest: ChatRequest = { ...request, messages: [{ role: 'system', content: blindSystemPrompt }, ...request.messages] };
    const reasoningEnabled = this.isReasoningEnabled(request);
    const executions: ModelExecution[] = [];
    const successfulResponses: Array<{ modelName: string; content: string }> = [];

    const results = await Promise.allSettled(respondents.map(async (model) => {
      if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) throw new Error(`No adapter for ${model.id}`);
      const exec = reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, model, blindRequest, 'respondent')
        : await this.executeModel(adapter, model, blindRequest, 'respondent');
      const rawContent = exec.response?.choices?.[0]?.message?.content;
      return { model, content: typeof rawContent === 'string' ? rawContent : '', exec };
    }));

    for (const r of results) {
      if (r.status === 'fulfilled') {
        executions.push(r.value.exec);
        const content = typeof r.value.content === 'string' ? r.value.content.trim() : '';
        if (content) successfulResponses.push({ modelName: r.value.model.displayName || r.value.model.id, content });
      }
    }

    if (successfulResponses.length === 0) throw new Error('All respondents failed');

    // Observer + progress: responses collected
    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 1, summary: `${successfulResponses.length} independent responses received.` });
    yield this.progressChunk(`${successfulResponses.length} responses collected, adjudicator synthesizing...`, 1, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Phase 2: stream adjudicator synthesis
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const responsesText = successfulResponses.map((r, i) => `### Response ${i + 1} (${r.modelName}):\n${r.content}`).join('\n\n---\n\n');
    const reasoningTraces = reasoningEnabled ? this.formatReasoningForSynthesizer(executions) : '';

    const synthesisRequest: ChatRequest = {
      ...request,
      messages: [{
        role: 'user',
        content: `${PROMPTS.blindAdjudicator(successfulResponses.length)}\n\nORIGINAL QUESTION:\n${originalQ}\n\nINDEPENDENT RESPONSES:\n${responsesText}${reasoningTraces}`,
      }],
    };

    this.emitObserverEvent(context, { type: 'synthesis_start', modelName: adjudicator.name || adjudicator.id, summary: 'Adjudicator synthesizing.' });
    for (const c of await this.drainObserverChunks(context)) yield c;

    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const adjAdapter = await this.getAdapterForModel(adjudicator, context);
    if (!adjAdapter) throw new Error(`No adapter for adjudicator`);

    // Resilient synthesis: if the adjudicator's provider fails before producing
    // output, degrade to the strongest independent response instead of killing
    // the whole collective stream.
    yield* this.streamSynthesisWithFallback(
      synthesisRequest,
      [{ adapter: adjAdapter, model: adjudicator }],
      () => successfulResponses.reduce(
        (best, r) => (r.content.length > best.length ? r.content : best),
        successfulResponses[0].content,
      ),
    );

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Adjudicator synthesis complete.' });
    for (const c of await this.drainObserverChunks(context)) yield c;
  }

  private async selectDiverseModels(models: Model[], count: number): Promise<Model[]> {
    // Round-robin across providers for maximum diversity
    const byProvider = new Map<string, Model[]>();
    for (const m of models) {
      const p = m.provider || 'unknown';
      if (!byProvider.has(p)) byProvider.set(p, []);
      byProvider.get(p)!.push(m);
    }
    const queues = [...byProvider.values()].map(ms => ms.sort((a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5)));
    const selected: Model[] = [];
    let qi = 0;
    while (selected.length < count) {
      const queue = queues[qi % queues.length];
      const idx = Math.floor(qi / queues.length);
      if (idx < queue.length) selected.push(queue[idx]);
      qi++;
      if (qi > count * queues.length) break;
    }
    return selected;
  }

  private errorResponse(model: Model): ChatResponse {
    return { id: `error-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model.name, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop', logprobs: null }] };
  }

  private emptyResult(startTime: number, executions: ModelExecution[]): OrchestrationResult {
    return { finalResponse: this.errorResponse({ id: 'unknown', name: 'unknown' } as Model), strategyUsed: 'blind-debate', modelsUsed: executions, totalDuration: Date.now() - startTime, totalCost: 0, metadata: { strategy: 'blind-debate', error: 'all-failed' } };
  }
}
