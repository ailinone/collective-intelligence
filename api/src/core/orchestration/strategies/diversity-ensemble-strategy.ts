// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Diversity Ensemble Strategy
 *
 * Operating principles:
 * - Diversity-yields-better-aggregation: diverse ensemble beats homogeneous expert
 * - Weak-tie information flow: distant connections bring novel information
 * - Independent diverse voters converge to truth
 *
 * Selects N models maximizing CROSS-PROVIDER diversity (not just cheapest).
 * Parallel execution + weighted synthesis by the highest-quality model.
 */

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import { narrowAs } from '@/utils/type-guards';
import { resolvePreferredExecutor, withPreferredFirst } from './preferred-model-helper';
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

const log = logger.child({ component: 'diversity-ensemble' });
const TIMEOUT_MS = Number(process.env.DIVERSITY_ENSEMBLE_TIMEOUT_MS ?? 300_000);

export class DiversityEnsembleStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'diversity-ensemble',
      name: 'diversity-ensemble',
      displayName: 'Diversity Ensemble (Page Theorem)',
      description: 'Selects N models maximizing cross-provider diversity. Parallel execution + weighted synthesis.',
      minModels: 3,
      maxModels: 7,
      estimatedCostMultiplier: 4.0,
      estimatedQualityBoost: 0.30,
      estimatedDurationMultiplier: 2.0,
      suitableFor: ['analysis', 'reasoning', 'creative', 'general'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    return Promise.race([
      this.executeCore(request, context, startTime),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Diversity ensemble timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      ),
    ]);
  }

  private async executeCore(request: ChatRequest, context: OrchestrationContext, startTime: number): Promise<OrchestrationResult> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Diversity ensemble requires at least 3 models');

    // Select maximally diverse models (round-robin across providers)
    // Caminho-C Q2 cross-strategy honor: when the user pins a model,
    // force-include it in the diverse set as the synthesizer. Diversity
    // selection runs on the fallback pool, then withPreferredFirst
    // prepends the pin — preserves provider-diversity semantics for the
    // remaining slots while honoring user intent at the synthesizer role.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn(
        { requestId: context.requestId, requestedModel: preference.requestedId, poolSize: models.length },
        'Diversity ensemble: requested model not in operational pool — falling back to selectMaxDiversity',
      );
    }
    const targetCount = Math.min(5, models.length);
    const diverseFromFallback = this.selectMaxDiversity(
      preference.fallbackPool as Model[],
      preference.pinnedExecutor ? Math.max(2, targetCount - 1) : targetCount,
    );
    const diverse = withPreferredFirst(preference, diverseFromFallback);
    const synthesizer = preference.pinnedExecutor
      ?? [...diverse].sort((a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5))[0];
    const respondents = diverse.filter(m => m.id !== synthesizer.id);

    const executions: ModelExecution[] = [];

    log.info({ synthesizer: synthesizer.id, respondents: respondents.map(m => m.id), providers: [...new Set(diverse.map(m => m.provider))] }, 'Diversity ensemble: starting');

    // Observer: phase start
    this.emitObserverEvent(context, { type: 'phase_start', models: respondents.map(m => m.name || m.id), summary: `Diversity ensemble: ${respondents.length} respondents from ${[...new Set(diverse.map(m => m.provider))].length} providers responding in parallel.` });

    // Phase 1: All respond in parallel
    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    const reasoningEnabled = this.isReasoningEnabled(request);
    const promises = respondents.map(async (model) => {
      if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) throw new Error(`No adapter for ${model.id}`);
      const diverseReq: ChatRequest = { ...request, messages: [{ role: 'system', content: this.withReasoningPrompt(PROMPTS.diversityRespondent, request, model) }, ...request.messages] };
      const exec = hasTools
        ? await this.executeModelWithTools(adapter, model, diverseReq, 'respondent')
        : reasoningEnabled
          ? await this.executeModelWithReasoning(adapter, model, diverseReq, 'respondent')
          : await this.executeModel(adapter, model, diverseReq, 'respondent');
      const rawContent = exec.response?.choices?.[0]?.message?.content;
      return { model, content: typeof rawContent === 'string' ? rawContent : '', exec };
    });

    const results = await Promise.allSettled(promises);
    const responses: Array<{ name: string; content: string; provider: string }> = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        executions.push(r.value.exec);
        if (r.value.content.trim()) {
          responses.push({ name: r.value.model.displayName || r.value.model.id, content: r.value.content, provider: r.value.model.provider || 'unknown' });
        }
      }
    }

    if (responses.length === 0) return this.emptyResult(startTime, executions);

    // Observer: responses collected
    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 1, summary: `${responses.length} diverse perspectives collected. Synthesizer merging.` });
    this.emitObserverEvent(context, { type: 'synthesis_start', modelName: synthesizer.name || synthesizer.id, summary: 'Synthesizer merging maximally diverse perspectives.' });

    // Phase 2: Synthesizer merges diverse perspectives
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const respText = responses.map((r, i) => `### Perspective ${i + 1} (${r.name}, provider: ${r.provider}):\n${r.content}`).join('\n\n---\n\n');

    const reasoningTraces = this.isReasoningEnabled(request) ? this.formatReasoningForSynthesizer(executions) : '';
    const synthReq: ChatRequest = { ...request, messages: [{ role: 'system', content: PROMPTS.consensusSynthesizer }, { role: 'user', content: `ORIGINAL QUESTION:\n${originalQ}\n\nDIVERSE PERSPECTIVES:\n${respText}${reasoningTraces}` }] };

    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const synthAdapter = await this.getAdapterForModel(synthesizer, context);
    if (!synthAdapter) throw new Error(`No adapter for synthesizer ${synthesizer.id}`);
    const synthExec = await this.executeModel(synthAdapter, synthesizer, synthReq, 'synthesizer');
    executions.push(synthExec);

    const uniqueProviders = [...new Set(diverse.map(m => m.provider))];
    return {
      finalResponse: synthExec.response, strategyUsed: 'diversity-ensemble', modelsUsed: executions,
      totalDuration: Date.now() - startTime, totalCost: executions.reduce((s, e) => s + (e.cost ?? 0), 0),
      metadata: {
        strategy: 'diversity-ensemble', diversityScore: uniqueProviders.length / diverse.length, providers: uniqueProviders, respondents: respondents.length,
        ...(reasoningEnabled ? { reasoning_traces: executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) } : {}),
      },
    };
  }

  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Diversity ensemble requires at least 3 models');
    const preference = resolvePreferredExecutor(models, context, []);
    const targetCount = Math.min(5, models.length);
    const diverseFromFallback = this.selectMaxDiversity(
      preference.fallbackPool as Model[],
      preference.pinnedExecutor ? Math.max(2, targetCount - 1) : targetCount,
    );
    const diverse = withPreferredFirst(preference, diverseFromFallback);
    const synthesizer = preference.pinnedExecutor
      ?? [...diverse].sort((a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5))[0];
    const respondents = diverse.filter(m => m.id !== synthesizer.id);
    const reasoningEnabled = this.isReasoningEnabled(request);

    this.emitObserverEvent(context, { type: 'phase_start', models: respondents.map(m => m.name || m.id), summary: `Diversity ensemble: ${respondents.length} respondents from ${[...new Set(diverse.map(m => m.provider))].length} providers.` });
    yield this.progressChunk(`${respondents.length} diverse models responding...`, 0, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const executions: ModelExecution[] = [];
    const responses: Array<{ name: string; content: string }> = [];
    const results = await Promise.allSettled(respondents.map(async (model) => {
      if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) throw new Error(`No adapter for ${model.id}`);
      const diverseReq: ChatRequest = { ...request, messages: [{ role: 'system', content: this.withReasoningPrompt(PROMPTS.diversityRespondent, request, model) }, ...request.messages] };
      const exec = reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, model, diverseReq, 'respondent')
        : await this.executeModel(adapter, model, diverseReq, 'respondent');
      const rawContent = exec.response?.choices?.[0]?.message?.content;
      return { model, content: typeof rawContent === 'string' ? rawContent : '', exec };
    }));
    for (const r of results) { if (r.status === 'fulfilled') { executions.push(r.value.exec); const c = typeof r.value.content === 'string' ? r.value.content.trim() : ''; if (c) responses.push({ name: r.value.model.displayName || r.value.model.id, content: c }); } }
    if (responses.length === 0) throw new Error('All respondents failed');

    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 1, summary: `${responses.length} diverse perspectives collected.` });
    this.emitObserverEvent(context, { type: 'synthesis_start', modelName: synthesizer.name || synthesizer.id, summary: 'Synthesizer merging diverse perspectives.' });
    yield this.progressChunk(`Synthesizing ${responses.length} perspectives...`, 1, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const respText = responses.map((r, i) => `### Perspective ${i + 1} (${r.name}):\n${r.content}`).join('\n\n---\n\n');
    const reasoningTraces = reasoningEnabled ? this.formatReasoningForSynthesizer(executions) : '';
    const synthReq: ChatRequest = { ...request, messages: [{ role: 'system', content: PROMPTS.consensusSynthesizer }, { role: 'user', content: `ORIGINAL QUESTION:\n${originalQ}\n\nDIVERSE PERSPECTIVES:\n${respText}${reasoningTraces}` }] };

    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const synthAdapter = await this.getAdapterForModel(synthesizer, context);
    if (!synthAdapter) throw new Error(`No adapter for synthesizer`);
    // RESILIENT streaming: bare for-await had NO first-token deadline. Route
    // through the fallback-chain helper (first-chunk + idle deadlines, graceful
    // degrade to the raw perspectives instead of a hard stream failure).
    yield* this.streamSynthesisWithFallback(
      synthReq,
      [{ adapter: synthAdapter, model: synthesizer }],
      () => respText.slice(0, 4000),
    );

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Diversity synthesis complete.' });
    for (const c of await this.drainObserverChunks(context)) yield c;
  }

  private selectMaxDiversity(models: Model[], count: number): Model[] {
    const byProvider = new Map<string, Model[]>();
    for (const m of models) { const p = m.provider || 'unknown'; if (!byProvider.has(p)) byProvider.set(p, []); byProvider.get(p)!.push(m); }
    for (const ms of byProvider.values()) ms.sort((a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5));
    const queues = [...byProvider.values()];
    queues.sort((a, b) => (b[0]?.performance?.quality ?? 0.5) - (a[0]?.performance?.quality ?? 0.5));
    const selected: Model[] = [];
    let qi = 0;
    while (selected.length < count) {
      const queue = queues[qi % queues.length];
      const idx = Math.floor(qi / queues.length);
      if (idx < queue.length && !selected.includes(queue[idx])) selected.push(queue[idx]);
      qi++;
      if (qi > count * queues.length * 2) break;
    }
    return selected;
  }

  private errorResponse(model: Model): ChatResponse {
    return { id: `error-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model.name, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop', logprobs: null }] };
  }

  private emptyResult(startTime: number, executions: ModelExecution[]): OrchestrationResult {
    return { finalResponse: this.errorResponse(narrowAs<Model>({ id: 'unknown', name: 'unknown' })), strategyUsed: 'diversity-ensemble', modelsUsed: executions, totalDuration: Date.now() - startTime, totalCost: 0, metadata: { strategy: 'diversity-ensemble', error: 'all-failed' } };
  }
}
