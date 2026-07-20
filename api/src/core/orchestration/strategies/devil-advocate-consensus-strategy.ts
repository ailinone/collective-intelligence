// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Devil's Advocate Consensus Strategy
 *
 * Operating principles:
 * - Anti-groupthink: forced dissent prevents premature consensus
 * - Anti-polarization: forced opposition prevents drift to extremes
 *
 * N-1 models propose, 1 model critiques, synthesizer incorporates valid criticisms.
 */

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import { resolvePreferredExecutor, assembleExecutors } from './preferred-model-helper';
import { PROMPTS, ADAPTIVE_DEPTH_DIRECTIVE } from '../prompts/sota-system-prompts';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
} from '@/types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'devil-advocate-consensus' });

const TIMEOUT_MS = Number(process.env.DEVIL_ADVOCATE_TIMEOUT_MS ?? 300_000);

export class DevilAdvocateConsensusStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'devil-advocate-consensus',
      name: 'devil-advocate-consensus',
      displayName: "Devil's Advocate Consensus",
      description: 'N-1 models propose, 1 critiques, synthesizer incorporates valid criticisms. Anti-groupthink by design.',
      minModels: 3,
      maxModels: 5,
      estimatedCostMultiplier: 4.0,
      estimatedQualityBoost: 0.30,
      estimatedDurationMultiplier: 3.0,
      suitableFor: ['analysis', 'code-review', 'debugging', 'refactoring', 'reasoning', 'documentation'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    return Promise.race([
      this.executeCore(request, context, startTime),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Devil advocate timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      ),
    ]);
  }

  private async executeCore(request: ChatRequest, context: OrchestrationContext, startTime: number): Promise<OrchestrationResult> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Devil advocate requires at least 3 models');

    // Roles: best = synthesizer, 2nd best = devil's advocate, rest = proposers
    // Caminho-C Q2 cross-strategy honor: pin biases the synthesizer slot.
    // Devil's-advocate role intentionally stays as next-best peer to keep
    // the dissent role from being captured by the user's chosen model.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn(
        { requestId: context.requestId, requestedModel: preference.requestedId, poolSize: models.length },
        "Devil's-advocate consensus: requested model not in operational pool — falling back to quality-sorted synthesizer",
      );
    }
    const sorted = assembleExecutors(
      preference,
      Math.min(5, models.length),
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    const synthesizer = sorted[0];
    const devilsAdvocate = sorted[1];
    const proposers = sorted.slice(2);

    const executions: ModelExecution[] = [];

    log.info({ synthesizer: synthesizer.id, devil: devilsAdvocate.id, proposers: proposers.map(p => p.id) }, 'Devil advocate: starting');

    // Observer: phase start
    this.emitObserverEvent(context, { type: 'phase_start', models: proposers.map(p => p.name || p.id), summary: `Devil's advocate: ${proposers.length} proposers + 1 critic + 1 synthesizer.` });

    // Phase 1: Proposers respond in parallel (blind) — via executeModel (bulkhead + retry + metrics)
    const reasoningEnabled = this.isReasoningEnabled(request);
    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;

    // F3-EXPAND: resolve slots + variant for proposer (same pattern as consensus)
    const promptSlots = process.env.ENABLE_PROMPT_SLOTS === 'true'
      ? (context.executionPlan ?? context.triage?.executionPlan)?.stages?.[0]?.promptSlots
      : undefined;
    const selectedVariant = this.selectPromptVariant('consensusVoter', context);
    const activeVariantId = selectedVariant?.id;

    const proposalPromises = proposers.map(async (model) => {
      if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) throw new Error(`No adapter for ${model.id}`);
      const basePrompt = selectedVariant
        ? selectedVariant.content
        : PROMPTS.consensusVoter(promptSlots);
      const proposalReq: ChatRequest = { ...request, messages: [{ role: 'system', content: this.withReasoningPrompt(basePrompt, request, model) }, ...request.messages] };
      const exec = hasTools
        ? await this.executeModelWithTools(adapter, model, proposalReq, 'proposer')
        : reasoningEnabled
          ? await this.executeModelWithReasoning(adapter, model, proposalReq, 'proposer')
          : await this.executeModel(adapter, model, proposalReq, 'proposer');
      // F3-EXPAND + F4-INT: tag execution for feedback loop (promptKey required for bandit reward)
      if (activeVariantId) {
        exec.promptVariantId = activeVariantId;
        exec.promptKey = 'consensusVoter';
      }
      if (promptSlots) {
        const { hashSlotValues } = await import('../prompts/prompt-slots');
        exec.promptSlotHash = hashSlotValues(promptSlots);
      }
      const rawContent = exec.response?.choices?.[0]?.message?.content;
      return { model, content: typeof rawContent === 'string' ? rawContent : '', exec };
    });

    const proposalResults = await Promise.allSettled(proposalPromises);
    const proposals: Array<{ name: string; content: string }> = [];
    for (const r of proposalResults) {
      if (r.status === 'fulfilled') {
        executions.push(r.value.exec);
        const c = r.value.content.trim();
        if (c) proposals.push({ name: r.value.model.displayName || r.value.model.id, content: c });
      }
    }

    if (proposals.length === 0) return this.emptyResult(startTime, executions);

    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const proposalsText = proposals.map((p, i) => `### Proposal ${i + 1} (${p.name}):\n${p.content}`).join('\n\n---\n\n');

    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 3, summary: `${proposals.length} proposals received. Devil's advocate critiquing.` });

    // Phase 2: Devil's advocate critiques — via executeModel
    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const devilAdapter = await this.getAdapterForModel(devilsAdvocate, context);
    let critique = '';
    if (devilAdapter) {
      const critiqueReq: ChatRequest = { ...request, messages: [{ role: 'system', content: PROMPTS.devilsAdvocate }, { role: 'user', content: `ORIGINAL QUESTION:\n${originalQ}\n\nPROPOSALS TO CRITIQUE:\n${proposalsText}` }] };
      const critiqueExec = await this.executeModel(devilAdapter, devilsAdvocate, critiqueReq, 'critic');
      executions.push(critiqueExec);
      const rawCritique = critiqueExec.response?.choices?.[0]?.message?.content;
      critique = typeof rawCritique === 'string' ? rawCritique : '';
    }

    this.emitObserverEvent(context, { type: 'round_complete', round: 2, totalRounds: 3, summary: 'Critique complete. Synthesizer producing final answer.' });
    this.emitObserverEvent(context, { type: 'synthesis_start', summary: 'Synthesizer merging proposals with critique.' });

    // Phase 3: Synthesizer — via executeWithLeader
    const synthAdapter = await this.getAdapterForModel(synthesizer, context);
    if (!synthAdapter) throw new Error(`No adapter for synthesizer ${synthesizer.id}`);
    const reasoningTraces = reasoningEnabled ? this.formatReasoningForSynthesizer(executions) : '';
    const synthReq: ChatRequest = { ...request, messages: [{ role: 'user', content: `Synthesize the BEST answer.\n\nORIGINAL QUESTION:\n${originalQ}\n\nPROPOSALS:\n${proposalsText}\n\nCRITIC'S REVIEW:\n${critique || '(none)'}${reasoningTraces}\n\nProduce the definitive answer.\n${ADAPTIVE_DEPTH_DIRECTIVE}` }] };
    const synthExec = await this.executeModel(synthAdapter, synthesizer, synthReq, 'synthesizer');
    executions.push(synthExec);

    return {
      finalResponse: synthExec.response,
      strategyUsed: 'devil-advocate-consensus',
      modelsUsed: executions,
      totalDuration: Date.now() - startTime,
      totalCost: executions.reduce((s, e) => s + (e.cost ?? 0), 0),
      metadata: {
        strategy: 'devil-advocate-consensus', proposers: proposers.length, proposals: proposals.length, devilsAdvocate: devilsAdvocate.id, synthesizer: synthesizer.id,
        ...(reasoningEnabled ? { reasoning_traces: executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) } : {}),
      },
    };
  }

  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Devil advocate requires at least 3 models');
    const preference = resolvePreferredExecutor(models, context, []);
    const sorted = assembleExecutors(
      preference,
      Math.min(5, models.length),
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    const synthesizer = sorted[0];
    const devilsAdvocate = sorted[1];
    const proposers = sorted.slice(2);
    const reasoningEnabled = this.isReasoningEnabled(request);
    const proposerSystemPrompt = this.withReasoningPrompt(PROMPTS.consensusVoter(), request);

    // Phase 1: proposers
    this.emitObserverEvent(context, { type: 'phase_start', models: proposers.map(p => p.name || p.id), summary: `Devil's advocate: ${proposers.length} proposers + 1 critic + 1 synthesizer.` });
    yield this.progressChunk(`${proposers.length} proposers responding...`, 0, 3);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const executions: ModelExecution[] = [];
    const proposals: Array<{ name: string; content: string }> = [];
    const proposalResults = await Promise.allSettled(proposers.map(async (model) => {
      if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) throw new Error(`No adapter for ${model.id}`);
      const proposalReq: ChatRequest = { ...request, messages: [{ role: 'system', content: proposerSystemPrompt }, ...request.messages] };
      const exec = reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, model, proposalReq, 'proposer')
        : await this.executeModel(adapter, model, proposalReq, 'proposer');
      const rawContent = exec.response?.choices?.[0]?.message?.content;
      return { model, content: typeof rawContent === 'string' ? rawContent : '', exec };
    }));
    for (const r of proposalResults) {
      if (r.status === 'fulfilled') {
        executions.push(r.value.exec);
        const c = typeof r.value.content === 'string' ? r.value.content.trim() : '';
        if (c) proposals.push({ name: r.value.model.displayName || r.value.model.id, content: c });
      }
    }
    if (proposals.length === 0) throw new Error('All proposers failed');

    // Phase 2: critique
    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 3, summary: `${proposals.length} proposals received. Devil's advocate critiquing.` });
    yield this.progressChunk(`Critique in progress...`, 1, 3);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const proposalsText = proposals.map((p, i) => `### Proposal ${i + 1} (${p.name}):\n${p.content}`).join('\n\n---\n\n');
    const critiqueReq: ChatRequest = { ...request, messages: [{ role: 'system', content: PROMPTS.devilsAdvocate }, { role: 'user', content: `ORIGINAL QUESTION:\n${originalQ}\n\nPROPOSALS TO CRITIQUE:\n${proposalsText}` }] };
    let critique = '';
    try {
      if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
      const devilAdapter = await this.getAdapterForModel(devilsAdvocate, context);
      if (!devilAdapter) throw new Error(`No adapter for devil`);
      const critiqueExec = await this.executeModel(devilAdapter, devilsAdvocate, critiqueReq, 'critic');
      executions.push(critiqueExec);
      const rawCritique = critiqueExec.response?.choices?.[0]?.message?.content;
      critique = typeof rawCritique === 'string' ? rawCritique : '';
    } catch { /* critique failure is non-fatal */ }

    // Phase 3: stream synthesis
    this.emitObserverEvent(context, { type: 'round_complete', round: 2, totalRounds: 3, summary: 'Critique complete. Synthesizer producing final answer.' });
    this.emitObserverEvent(context, { type: 'synthesis_start', summary: 'Synthesizer merging proposals with critique.' });
    yield this.progressChunk(`Synthesizing final answer...`, 2, 3);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const reasoningTraces = reasoningEnabled ? this.formatReasoningForSynthesizer(executions) : '';
    const synthReq: ChatRequest = { ...request, messages: [{ role: 'user', content: `Synthesize the BEST answer.\n\nORIGINAL QUESTION:\n${originalQ}\n\nPROPOSALS:\n${proposalsText}\n\nCRITIC'S REVIEW:\n${critique || '(none)'}${reasoningTraces}\n\nProduce the definitive answer.\n${ADAPTIVE_DEPTH_DIRECTIVE}` }] };

    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const synthAdapter = await this.getAdapterForModel(synthesizer, context);
    if (!synthAdapter) throw new Error(`No adapter for synthesizer`);

    // RESILIENT streaming: a bare for-await had NO deadline on the first token —
    // a stalled synthesizer hung the whole SSE stream indefinitely. Route through
    // the fallback-chain helper (first-chunk + idle deadlines, graceful degrade
    // to the raw proposals instead of a hard stream failure).
    yield* this.streamSynthesisWithFallback(
      synthReq,
      [{ adapter: synthAdapter, model: synthesizer }],
      () => proposalsText.slice(0, 4000),
    );

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Devil advocate synthesis complete.' });
    for (const c of await this.drainObserverChunks(context)) yield c;
  }

  private errorResponse(model: Model): ChatResponse {
    return { id: `error-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model.name, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop', logprobs: null }] };
  }

  private emptyResult(startTime: number, executions: ModelExecution[]): OrchestrationResult {
    return { finalResponse: this.errorResponse({ id: 'unknown', name: 'unknown' } as Model), strategyUsed: 'devil-advocate-consensus', modelsUsed: executions, totalDuration: Date.now() - startTime, totalCost: 0, metadata: { strategy: 'devil-advocate-consensus', error: 'all-failed' } };
  }
}
