// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Safety Quorum Strategy
 *
 * Operating principles:
 * - Quorum sensing: coordinate response at signal threshold
 * - Majority rule is optimal for binary safety decisions
 * - Independent voters with >50% accuracy converge to truth
 *
 * N models independently assess safety via majority vote.
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

const log = logger.child({ component: 'safety-quorum' });

const TIMEOUT_MS = Number(process.env.SAFETY_QUORUM_TIMEOUT_MS ?? 120_000);

export class SafetyQuorumStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'safety-quorum',
      name: 'safety-quorum',
      displayName: 'Safety Quorum (Majority Vote)',
      description: 'N models independently assess safety via majority vote. Quorum-sensing + majority-rule optimality.',
      minModels: 3,
      maxModels: 5,
      estimatedCostMultiplier: 3.0,
      estimatedQualityBoost: 0.15,
      estimatedDurationMultiplier: 1.5,
      suitableFor: ['analysis', 'general'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    return Promise.race([
      this.executeCore(request, context, startTime),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Safety quorum timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      ),
    ]);
  }

  private async executeCore(request: ChatRequest, context: OrchestrationContext, startTime: number): Promise<OrchestrationResult> {
    const allEligible = this.getEligibleModels(context);
    const models = allEligible.slice(0, 5);
    const quorumSize = Math.min(models.length, 3);
    // Pin biases inclusion in the voting panel — the user's chosen
    // voter should participate. Verdict tallying treats every voter
    // equally (majority-rule optimality: each vote weighs the same),
    // so the pin doesn't bias the outcome, only the panel composition.
    const preference = resolvePreferredExecutor(allEligible, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn(
        {
          attempted: context.preferredModelIds?.[0],
          reason: preference.pinReason,
        },
        'Preferred model not eligible for safety quorum — using top-N voters.',
      );
    }
    const fallbackPanel = preference.pinnedExecutor
      ? models.filter(m => m.id !== preference.pinnedExecutor!.id)
      : models;
    const selected = withPreferredFirst(preference, fallbackPanel).slice(0, quorumSize);
    const executions: ModelExecution[] = [];

    log.info({ quorumSize, models: selected.map(m => m.id) }, 'Safety quorum: starting parallel assessment');

    // Observer: phase start
    this.emitObserverEvent(context, { type: 'phase_start', models: selected.map(m => m.name || m.id), summary: `Safety quorum: ${quorumSize} voters assessing safety independently.` });

    // All models respond in parallel
    const promises = selected.map(async (model) => {
      try {
        if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
        const adapter = await this.getAdapterForModel(model, context);
        if (!adapter) throw new Error(`No adapter for ${model.id}`);
        const safetyPrompt = this.withReasoningPrompt(PROMPTS.safetyVoter, request);
        const safetyRequest: ChatRequest = { ...request, messages: [{ role: 'system', content: safetyPrompt }, ...request.messages] };
        const exec = this.isReasoningEnabled(request)
          ? await this.executeModelWithReasoning(adapter, model, safetyRequest, 'voter')
          : await this.executeModel(adapter, model, safetyRequest, 'voter');
        const rawContent = exec.response?.choices?.[0]?.message?.content;
        return { model, content: typeof rawContent === 'string' ? rawContent : '', exec };
      } catch (err) {
        const exec: ModelExecution = { modelId: model.id, modelName: model.name, role: 'voter', request, response: this.errorResponse(model), cost: 0, durationMs: 0, success: false, error: String(err) };
        return { model, content: '', exec };
      }
    });

    const results = await Promise.allSettled(promises);
    const responses: Array<{ model: Model; content: string; exec: ModelExecution }> = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        executions.push(r.value.exec);
        if (r.value.exec.success && r.value.content) {
          responses.push({ model: r.value.model, content: r.value.content, exec: r.value.exec });
        }
      }
    }

    if (responses.length === 0) return this.emptyResult(startTime, executions);

    // Observer: votes collected
    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 1, summary: `${responses.length} safety assessments received. Classifying votes.` });

    // Classify: refusal vs compliant
    const refusals = responses.filter(r => this.isRefusal(r.content));
    const compliant = responses.filter(r => !this.isRefusal(r.content));
    const majorityRefused = refusals.length > compliant.length;

    log.info({ total: responses.length, refusals: refusals.length, compliant: compliant.length, verdict: majorityRefused ? 'REFUSED' : 'ALLOWED' }, 'Safety quorum: vote complete');

    // Observer: verdict
    this.emitObserverEvent(context, { type: 'quality_assessment', summary: `Safety quorum verdict: ${majorityRefused ? 'REFUSED' : 'ALLOWED'} (${refusals.length} refusals, ${compliant.length} compliant).` });

    // Select best response based on majority verdict
    const best = majorityRefused
      ? refusals.sort((a, b) => b.content.length - a.content.length)[0]
      : compliant.sort((a, b) => b.content.length - a.content.length)[0];

    return {
      finalResponse: best.exec.response!,
      strategyUsed: 'safety-quorum',
      modelsUsed: executions,
      totalDuration: Date.now() - startTime,
      totalCost: executions.reduce((s, e) => s + (e.cost ?? 0), 0),
      metadata: {
        strategy: 'safety-quorum', quorumSize, refusals: refusals.length, compliant: compliant.length, verdict: majorityRefused ? 'refused' : 'allowed',
        ...(this.isReasoningEnabled(request) ? { reasoning_traces: executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) } : {}),
      },
    };
  }

  // Intentionally buffered, not real per-token streaming (audited
  // 2026-07-11 alongside the other 12 strategies): the response shown to
  // the user is the longest response on the WINNING side of a majority
  // vote across all voters — which side wins, and which voter's response
  // is longest, are both only known after every voter has finished.
  // Streaming a single voter live could ship a refusal when the quorum
  // ultimately allows (or vice versa).
  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    const allEligible = this.getEligibleModels(context);
    const models = allEligible.slice(0, 5);
    const quorumSize = Math.min(models.length, 3);
    // Same pin-as-inclusion semantics as execute() — see comment there.
    const preference = resolvePreferredExecutor(allEligible, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn(
        {
          attempted: context.preferredModelIds?.[0],
          reason: preference.pinReason,
        },
        'Preferred model not eligible for safety quorum stream — using top-N voters.',
      );
    }
    const fallbackPanel = preference.pinnedExecutor
      ? models.filter(m => m.id !== preference.pinnedExecutor!.id)
      : models;
    const selected = withPreferredFirst(preference, fallbackPanel).slice(0, quorumSize);

    this.emitObserverEvent(context, { type: 'phase_start', models: selected.map(m => m.name || m.id), summary: `Safety quorum: ${quorumSize} voters assessing.` });
    yield this.progressChunk(`${quorumSize} safety voters assessing...`, 0, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const safetyPrompt = this.withReasoningPrompt(PROMPTS.safetyVoter, request);
    const responses: Array<{ content: string; response: ChatResponse }> = [];

    await Promise.allSettled(selected.map(async (model) => {
      if (!this.getAdapterForModel) return;
      const adapter = await this.getAdapterForModel(model, context);
      if (!adapter) return;
      const safetyReq: ChatRequest = { ...request, messages: [{ role: 'system', content: safetyPrompt }, ...request.messages] };
      const exec = await this.executeModel(adapter, model, safetyReq, 'voter');
      const content = exec.response?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) responses.push({ content, response: exec.response });
    }));

    if (responses.length === 0) throw new Error('All safety voters failed');

    const refusals = responses.filter(r => this.isRefusal(r.content));
    const compliant = responses.filter(r => !this.isRefusal(r.content));
    const majorityRefused = refusals.length > compliant.length;

    this.emitObserverEvent(context, { type: 'quality_assessment', summary: `Verdict: ${majorityRefused ? 'REFUSED' : 'ALLOWED'} (${refusals.length} refusals, ${compliant.length} compliant).` });
    yield this.progressChunk(`Safety verdict: ${majorityRefused ? 'refused' : 'allowed'}`, 1, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const best = majorityRefused
      ? refusals.sort((a, b) => b.content.length - a.content.length)[0]
      : compliant.sort((a, b) => b.content.length - a.content.length)[0];

    yield best.response;
  }

  private isRefusal(content: string): boolean {
    return /i (?:can'?t|cannot|won'?t|will not|am unable to)|sorry,?\s+(?:but\s+)?i|(?:inappropriate|unethical|harmful|dangerous|illegal)|against (?:my|the) (?:guidelines|policies)/i.test(content);
  }

  private errorResponse(model: Model): ChatResponse {
    return { id: `error-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model.name, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop', logprobs: null }] };
  }

  private emptyResult(startTime: number, executions: ModelExecution[]): OrchestrationResult {
    return { finalResponse: this.errorResponse({ id: 'unknown', name: 'unknown' } as Model), strategyUsed: 'safety-quorum', modelsUsed: executions, totalDuration: Date.now() - startTime, totalCost: 0, metadata: { strategy: 'safety-quorum', error: 'all-failed' } };
  }
}
