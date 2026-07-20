// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Research-Synthesize Strategy
 *
 * Operating principles:
 * - Source triangulation: multiple independent sources increase reliability
 * - Evidence-ranking: claims weighted by strength of evidence
 * - Independent factual assessments converge to truth
 *
 * Flow:
 *   1. Extract research questions from user query
 *   2. 3-5 researchers investigate in parallel (blind, diverse providers)
 *   3. Evidence Ranker classifies claims by cross-researcher agreement
 *   4. Synthesizer produces final research summary with confidence levels
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

const log = logger.child({ component: 'research-synthesize-strategy' });
const TIMEOUT_MS = Number(process.env.RESEARCH_TIMEOUT_MS ?? 120000);

export class ResearchSynthesizeStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'research-synthesize',
      name: 'research-synthesize',
      displayName: 'Research & Synthesize',
      description:
        'Parallel research from multiple models with evidence ranking and confidence-based synthesis. Best for factual questions, comparisons, and analysis.',
      minModels: 3,
      maxModels: 7,
      estimatedCostMultiplier: 5.0,
      estimatedQualityBoost: 0.35,
      estimatedDurationMultiplier: 3.0,
      suitableFor: ['analysis', 'factual-qa', 'reasoning', 'general'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    return Promise.race([
      this.executeCore(request, context, startTime),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Research timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
    ]);
  }

  private async executeCore(request: ChatRequest, context: OrchestrationContext, startTime: number): Promise<OrchestrationResult> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Research-Synthesize requires at least 3 models');

    // Select: best model as ranker+synthesizer, rest as researchers
    // Caminho-C Q2 cross-strategy honor: pin biases the ranker+synthesizer
    // slot. Researchers are selected with provider-diversity preserved
    // from the fallback pool — keeps source-triangulation independent of
    // the synthesis leader.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn(
        { requestId: context.requestId, requestedModel: preference.requestedId, poolSize: models.length },
        'Research-synthesize: requested model not in operational pool — falling back to quality-sorted ranker',
      );
    }
    const sorted = assembleExecutors(
      preference,
      models.length,
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    const rankerSynthesizer = sorted[0];
    const researchers = this.selectDiverseResearchers(sorted.slice(1), Math.min(5, sorted.length - 1));
    const reasoningEnabled = this.isReasoningEnabled(request);
    const executions: ModelExecution[] = [];
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');

    log.info({ ranker: rankerSynthesizer.id, researchers: researchers.map(r => r.id) }, 'Research-Synthesize: starting');

    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: researchers.map(m => m.name || m.id),
      summary: `Research phase: ${researchers.length} investigators researching in parallel.`,
    });

    // Phase 1: Parallel research (blind)
    // Note: researchPrompt is shared but executeModelWithReasoning handles per-model native thinking
    const researchPrompt = this.withReasoningPrompt(PROMPTS.researchInvestigator(originalQ), request);
    const researchResults: Array<{ model: Model; content: string; exec: ModelExecution }> = [];

    const promises = researchers.map(async (model) => {
      if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) throw new Error(`No adapter for ${model.id}`);
      const researchReq: ChatRequest = {
        ...request,
        messages: [{ role: 'system', content: researchPrompt }, ...request.messages],
      };
      // Tool-aware: if request has tools (e.g., web_search), researchers can use them
      const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
      const exec = hasTools
        ? await this.executeModelWithTools(adapter, model, researchReq, 'researcher')
        : reasoningEnabled
          ? await this.executeModelWithReasoning(adapter, model, researchReq, 'researcher')
          : await this.executeModel(adapter, model, researchReq, 'researcher');
      const rawContent = exec.response?.choices?.[0]?.message?.content;
      const content = typeof rawContent === 'string' ? rawContent : '';
      return { model, content, exec };
    });

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled') {
        executions.push(r.value.exec);
        if (r.value.content.trim()) {
          researchResults.push(r.value);
        }
      }
    }

    if (researchResults.length === 0) throw new Error('All researchers failed');

    this.emitObserverEvent(context, {
      type: 'round_complete', round: 1, totalRounds: 3,
      summary: `${researchResults.length} research reports received. Ranking evidence.`,
    });

    // Phase 2: Evidence ranking
    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const rankerAdapter = await this.getAdapterForModel(rankerSynthesizer, context);
    if (!rankerAdapter) throw new Error(`No adapter for ranker`);

    const researchText = researchResults.map((r, i) =>
      `### Researcher ${i + 1} (${r.model.displayName || r.model.id}):\n${r.content}`
    ).join('\n\n---\n\n');

    const rankerReq: ChatRequest = {
      ...request,
      messages: [
        { role: 'system', content: PROMPTS.researchEvidenceRanker(researchResults.length) },
        { role: 'user', content: `ORIGINAL QUESTION:\n${originalQ}\n\nRESEARCH FINDINGS:\n${researchText}` },
      ],
      max_tokens: 2000,
    };
    const rankerExec = await this.executeModel(rankerAdapter, rankerSynthesizer, rankerReq, 'evidence-ranker');
    executions.push(rankerExec);
    const rankedEvidence = rankerExec.response?.choices?.[0]?.message?.content ?? '';

    this.emitObserverEvent(context, {
      type: 'round_complete', round: 2, totalRounds: 3,
      summary: 'Evidence ranked by confidence. Synthesizing final report.',
    });

    // Phase 3: Synthesis
    this.emitObserverEvent(context, { type: 'synthesis_start', summary: 'Synthesizer producing definitive research summary.' });

    const reasoningTraces = reasoningEnabled ? this.formatReasoningForSynthesizer(executions) : '';
    const synthReq: ChatRequest = {
      ...request,
      messages: [
        { role: 'system', content: PROMPTS.researchSynthesizer },
        { role: 'user', content: `ORIGINAL QUESTION:\n${originalQ}\n\nRANKED EVIDENCE:\n${rankedEvidence}${reasoningTraces}\n\nProduce the definitive research summary.` },
      ],
    };
    const synthExec = await this.executeModel(rankerAdapter, rankerSynthesizer, synthReq, 'synthesizer');
    executions.push(synthExec);

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: `Research complete. ${researchResults.length} sources, evidence ranked, synthesis produced.` });

    const reasoningTracesMeta = reasoningEnabled
      ? executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens }))
      : undefined;

    return {
      finalResponse: synthExec.response,
      strategyUsed: 'research-synthesize',
      modelsUsed: executions,
      totalCost: executions.reduce((s, e) => s + e.cost, 0),
      totalDuration: Date.now() - startTime,
      metadata: {
        strategy: 'research-synthesize',
        researchers: researchResults.length,
        phases: ['research', 'evidence-ranking', 'synthesis'],
        ...(reasoningTracesMeta?.length ? { reasoning_traces: reasoningTracesMeta } : {}),
      },
    };
  }

  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Research-Synthesize requires at least 3 models');
    const preference = resolvePreferredExecutor(models, context, []);
    const sorted = assembleExecutors(
      preference,
      models.length,
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    const rankerSynthesizer = sorted[0];
    const researchers = this.selectDiverseResearchers(sorted.slice(1), Math.min(5, sorted.length - 1));
    const reasoningEnabled = this.isReasoningEnabled(request);
    const executions: ModelExecution[] = [];
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');

    // Phase 1: Research
    this.emitObserverEvent(context, { type: 'phase_start', models: researchers.map(m => m.name || m.id), summary: `${researchers.length} researchers investigating.` });
    yield this.progressChunk(`${researchers.length} researchers investigating...`, 0, 3);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Note: researchPrompt is shared but executeModelWithReasoning handles per-model native thinking
    const researchPrompt = this.withReasoningPrompt(PROMPTS.researchInvestigator(originalQ), request);
    const researchResults: Array<{ model: Model; content: string }> = [];
    const promises = researchers.map(async (model) => {
      if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) throw new Error(`No adapter for ${model.id}`);
      const researchReq: ChatRequest = { ...request, messages: [{ role: 'system', content: researchPrompt }, ...request.messages] };
      const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
      const exec = hasTools
        ? await this.executeModelWithTools(adapter, model, researchReq, 'researcher')
        : reasoningEnabled
          ? await this.executeModelWithReasoning(adapter, model, researchReq, 'researcher')
          : await this.executeModel(adapter, model, researchReq, 'researcher');
      executions.push(exec);
      const rawC = exec.response?.choices?.[0]?.message?.content;
      return { model, content: typeof rawC === 'string' ? rawC : '' };
    });
    const results = await Promise.allSettled(promises);
    for (const r of results) { if (r.status === 'fulfilled' && r.value.content.trim()) researchResults.push(r.value); }
    if (researchResults.length === 0) throw new Error('All researchers failed');

    // Phase 2: Evidence ranking
    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 3, summary: `${researchResults.length} reports. Ranking evidence.` });
    yield this.progressChunk(`Ranking evidence from ${researchResults.length} sources...`, 1, 3);
    for (const c of await this.drainObserverChunks(context)) yield c;

    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const rankerAdapter = await this.getAdapterForModel(rankerSynthesizer, context);
    if (!rankerAdapter) throw new Error(`No adapter for ranker`);

    const researchText = researchResults.map((r, i) => `### Researcher ${i + 1}:\n${r.content}`).join('\n\n---\n\n');
    const rankerReq: ChatRequest = { ...request, messages: [{ role: 'system', content: PROMPTS.researchEvidenceRanker(researchResults.length) }, { role: 'user', content: `QUESTION:\n${originalQ}\n\nFINDINGS:\n${researchText}` }], max_tokens: 2000 };
    const rankerExec = await this.executeModel(rankerAdapter, rankerSynthesizer, rankerReq, 'evidence-ranker');
    executions.push(rankerExec);
    const rankedEvidence = rankerExec.response?.choices?.[0]?.message?.content ?? '';

    // Phase 3: Stream synthesis
    this.emitObserverEvent(context, { type: 'round_complete', round: 2, totalRounds: 3, summary: 'Evidence ranked. Synthesizing.' });
    this.emitObserverEvent(context, { type: 'synthesis_start', summary: 'Synthesizing definitive research report.' });
    yield this.progressChunk('Synthesizing research report...', 2, 3);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const reasoningTraces = reasoningEnabled ? this.formatReasoningForSynthesizer(executions) : '';
    const synthReq: ChatRequest = { ...request, messages: [{ role: 'system', content: PROMPTS.researchSynthesizer }, { role: 'user', content: `QUESTION:\n${originalQ}\n\nRANKED EVIDENCE:\n${rankedEvidence}${reasoningTraces}\n\nProduce definitive summary.` }] };
    // Resilient synthesis: degrade to the ranked evidence if the synthesizer's
    // provider fails, instead of killing the whole collective stream.
    yield* this.streamSynthesisWithFallback(
      synthReq,
      [{ adapter: rankerAdapter, model: rankerSynthesizer }],
      () => (typeof rankedEvidence === 'string' && rankedEvidence.trim().length > 0
        ? rankedEvidence
        : 'Research synthesis was unavailable (all providers failed).'),
    );

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Research synthesis complete.' });
    for (const c of await this.drainObserverChunks(context)) yield c;
  }

  private selectDiverseResearchers(models: Model[], count: number): Model[] {
    const byProvider = new Map<string, Model[]>();
    for (const m of models) { const p = m.provider || 'unknown'; if (!byProvider.has(p)) byProvider.set(p, []); byProvider.get(p)!.push(m); }
    const queues = [...byProvider.values()];
    const selected: Model[] = [];
    let qi = 0;
    while (selected.length < count && qi < count * queues.length) {
      const queue = queues[qi % queues.length];
      const idx = Math.floor(qi / queues.length);
      if (idx < queue.length && !selected.includes(queue[idx])) selected.push(queue[idx]);
      qi++;
    }
    return selected;
  }
}
