// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Swarm Explore Strategy
 *
 * Theoretical foundations:
 * - Swarm Intelligence (ant colony, bee foraging): parallel exploration
 * - Exploration-Exploitation trade-off: explore broadly, then exploit best
 * - Crowdsourcing: aggregate diverse approaches
 *
 * N models explore N different approaches in parallel.
 * Aggregator evaluates all approaches and synthesizes the best composite answer.
 * Ideal for open-ended problems with multiple valid solution paths.
 */

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import { narrowAs } from '@/utils/type-guards';
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

const log = logger.child({ component: 'swarm-explore' });
const TIMEOUT_MS = Number(process.env.SWARM_EXPLORE_TIMEOUT_MS ?? 300_000);

const EXPLORATION_ANGLES = [
  'Focus on the most practical and actionable approach. Prioritize simplicity and implementability.',
  'Focus on theoretical correctness and edge cases. Be thorough about failure modes and limitations.',
  'Focus on creative and unconventional solutions. Think outside the box — what would a contrarian expert suggest?',
  'Focus on efficiency and scalability. Optimize for performance, cost, and maintainability.',
  'Focus on safety, security, and robustness. What could go wrong? How to prevent it?',
];

export class SwarmExploreStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'swarm-explore',
      name: 'swarm-explore',
      displayName: 'Swarm Explore (Multi-Angle)',
      description: 'N models explore N different angles in parallel. Aggregator synthesizes best composite. Swarm intelligence.',
      minModels: 3,
      maxModels: 7,
      estimatedCostMultiplier: 5.0,
      estimatedQualityBoost: 0.35,
      estimatedDurationMultiplier: 2.5,
      suitableFor: ['analysis', 'creative', 'reasoning', 'architecture', 'general'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    return Promise.race([
      this.executeCore(request, context, startTime),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Swarm explore timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      ),
    ]);
  }

  private async executeCore(request: ChatRequest, context: OrchestrationContext, startTime: number): Promise<OrchestrationResult> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Swarm explore requires at least 3 models');

    const numExplorers = Math.min(5, models.length - 1); // Reserve 1 for aggregator
    // Caminho-C Q2 cross-strategy honor: pin biases the aggregator slot
    // (sorted[0]). Explorers stay as next-best peers — different angles
    // demand model diversity, so the user pin doesn't propagate into the
    // exploration phase.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn(
        { requestId: context.requestId, requestedModel: preference.requestedId, poolSize: models.length },
        'Swarm explore: requested model not in operational pool — falling back to quality-sorted aggregator',
      );
    }
    const sorted = assembleExecutors(
      preference,
      models.length,
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    const aggregator = sorted[0];
    const explorers = sorted.slice(1, 1 + numExplorers);

    const executions: ModelExecution[] = [];
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');

    log.info({ aggregator: aggregator.id, explorers: explorers.map(m => m.id), angles: numExplorers }, 'Swarm explore: launching parallel exploration');

    // Observer: phase start
    this.emitObserverEvent(context, { type: 'phase_start', models: explorers.map(m => m.name || m.id), summary: `Swarm exploration: ${explorers.length} explorers, each from a different angle.` });

    // Phase 1: Each explorer gets a different angle/perspective
    const reasoningEnabled = this.isReasoningEnabled(request);
    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    const promises = explorers.map(async (model, i) => {
      const angle = EXPLORATION_ANGLES[i % EXPLORATION_ANGLES.length];
      const explorerPrompt = this.withReasoningPrompt(PROMPTS.swarmExplorer(angle), request, model);
      const exploreReq: ChatRequest = { ...request, messages: [{ role: 'system', content: explorerPrompt }, ...request.messages] };
      if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) throw new Error(`No adapter for ${model.id}`);
      const exec = hasTools
        ? await this.executeModelWithTools(adapter, model, exploreReq, 'explorer')
        : reasoningEnabled
          ? await this.executeModelWithReasoning(adapter, model, exploreReq, 'explorer')
          : await this.executeModel(adapter, model, exploreReq, 'explorer');
      const rawContent = exec.response?.choices?.[0]?.message?.content;
      return { model, angle, content: typeof rawContent === 'string' ? rawContent : '', exec };
    });

    const results = await Promise.allSettled(promises);
    const explorations: Array<{ angle: string; content: string; model: string }> = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        executions.push(r.value.exec);
        if (r.value.content.trim()) {
          explorations.push({ angle: r.value.angle, content: r.value.content, model: r.value.model.displayName || r.value.model.id });
        }
      }
    }

    if (explorations.length === 0) return this.emptyResult(startTime, executions);

    // Observer: explorations complete
    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 1, summary: `${explorations.length} explorations complete from angles: ${explorations.map(e => e.angle.substring(0, 20)).join(', ')}.` });
    this.emitObserverEvent(context, { type: 'synthesis_start', modelName: aggregator.name || aggregator.id, summary: 'Aggregator synthesizing multi-angle explorations.' });

    // Phase 2: Aggregator synthesizes all explorations
    const explorationsText = explorations.map((e, i) =>
      `### Exploration ${i + 1} (${e.model})\nAngle: ${e.angle}\n\n${e.content}`
    ).join('\n\n---\n\n');

    const reasoningTraces = reasoningEnabled ? this.formatReasoningForSynthesizer(executions) : '';
    const aggReq: ChatRequest = { ...request, messages: [{ role: 'system', content: PROMPTS.swarmAggregator(explorations.length) }, { role: 'user', content: `ORIGINAL QUESTION:\n${originalQ}\n\nEXPLORATIONS:\n${explorationsText}${reasoningTraces}` }] };

    const _aggStart = Date.now();
    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const aggAdapter = await this.getAdapterForModel(aggregator, context);
    if (!aggAdapter) throw new Error(`No adapter for aggregator ${aggregator.id}`);
    const aggExec = await this.executeModel(aggAdapter, aggregator, aggReq, 'aggregator');
    executions.push(aggExec);

    return {
      finalResponse: aggExec.response, strategyUsed: 'swarm-explore', modelsUsed: executions,
      totalDuration: Date.now() - startTime, totalCost: executions.reduce((s, e) => s + (e.cost ?? 0), 0),
      metadata: {
        strategy: 'swarm-explore', explorers: explorers.length, successfulExplorations: explorations.length, angles: explorations.map(e => e.angle.substring(0, 30)), aggregator: aggregator.id,
        ...(reasoningEnabled ? { reasoning_traces: executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) } : {}),
      },
    };
  }

  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Swarm explore requires at least 3 models');
    const numExplorers = Math.min(4, models.length - 1);
    const preference = resolvePreferredExecutor(models, context, []);
    const sorted = assembleExecutors(
      preference,
      models.length,
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    const aggregator = sorted[0];
    const explorers = sorted.slice(1, 1 + numExplorers);
    const reasoningEnabled = this.isReasoningEnabled(request);
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');

    this.emitObserverEvent(context, { type: 'phase_start', models: explorers.map(m => m.name || m.id), summary: `Swarm: ${explorers.length} explorers from different angles.` });
    yield this.progressChunk(`${explorers.length} explorers investigating...`, 0, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const executions: ModelExecution[] = [];
    const explorations: Array<{ angle: string; content: string; model: string }> = [];
    const results = await Promise.allSettled(explorers.map(async (model, i) => {
      const angle = EXPLORATION_ANGLES[i % EXPLORATION_ANGLES.length];
      const explorerPrompt = this.withReasoningPrompt(PROMPTS.swarmExplorer(angle), request, model);
      const exploreReq: ChatRequest = { ...request, messages: [{ role: 'system', content: explorerPrompt }, ...request.messages] };
      if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) throw new Error(`No adapter for ${model.id}`);
      const exec = reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, model, exploreReq, 'explorer')
        : await this.executeModel(adapter, model, exploreReq, 'explorer');
      const rawContent = exec.response?.choices?.[0]?.message?.content;
      return { model, angle, content: typeof rawContent === 'string' ? rawContent : '', exec };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        executions.push(r.value.exec);
        if (typeof r.value.content === 'string' && r.value.content.trim()) explorations.push({ angle: r.value.angle, content: r.value.content, model: r.value.model.displayName || r.value.model.id });
      }
    }
    if (explorations.length === 0) throw new Error('All explorers failed');

    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 1, summary: `${explorations.length} explorations complete.` });
    this.emitObserverEvent(context, { type: 'synthesis_start', modelName: aggregator.name || aggregator.id, summary: 'Aggregator synthesizing.' });
    yield this.progressChunk(`Aggregating ${explorations.length} explorations...`, 1, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const explorationsText = explorations.map((e, i) => `### Exploration ${i + 1} (${e.model})\nAngle: ${e.angle}\n\n${e.content}`).join('\n\n---\n\n');
    const reasoningTraces = reasoningEnabled ? this.formatReasoningForSynthesizer(executions) : '';
    const aggReq: ChatRequest = { ...request, messages: [{ role: 'system', content: PROMPTS.swarmAggregator(explorations.length) }, { role: 'user', content: `ORIGINAL QUESTION:\n${originalQ}\n\nEXPLORATIONS:\n${explorationsText}${reasoningTraces}` }] };

    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const aggAdapter = await this.getAdapterForModel(aggregator, context);
    if (!aggAdapter) throw new Error(`No adapter for aggregator`);
    // RESILIENT streaming: bare for-await had NO first-token deadline. Route
    // through the fallback-chain helper (first-chunk + idle deadlines, graceful
    // degrade to the raw explorations instead of a hard stream failure).
    yield* this.streamSynthesisWithFallback(
      aggReq,
      [{ adapter: aggAdapter, model: aggregator }],
      () => explorationsText.slice(0, 4000),
    );

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Swarm aggregation complete.' });
    for (const c of await this.drainObserverChunks(context)) yield c;
  }

  private errorResponse(model: Model): ChatResponse {
    return { id: `error-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model.name, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop', logprobs: null }] };
  }

  private emptyResult(startTime: number, executions: ModelExecution[]): OrchestrationResult {
    return { finalResponse: this.errorResponse(narrowAs<Model>({ id: 'unknown', name: 'unknown' })), strategyUsed: 'swarm-explore', modelsUsed: executions, totalDuration: Date.now() - startTime, totalCost: 0, metadata: { strategy: 'swarm-explore', error: 'all-failed' } };
  }
}
