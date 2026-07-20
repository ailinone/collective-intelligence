// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Persona Exploration Strategy
 *
 * Creates 10-20 distinct personas with explicit backgrounds, biases, and
 * expertise domains. Each persona responds to the same question from their
 * unique perspective. An aggregator synthesizes the most valuable insights.
 *
 * Unlike diversity-ensemble (which uses different MODELS for diversity),
 * persona exploration uses different PROMPTS on the same or different models
 * to generate cognitive diversity via role-playing.
 *
 * Best for: creative problems, product design, strategic analysis, brainstorming,
 * scenarios where multiple stakeholder perspectives matter.
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

const log = logger.child({ component: 'persona-exploration-strategy' });
const TIMEOUT_MS = Number(process.env.PERSONA_TIMEOUT_MS ?? 120000);

const DEFAULT_PERSONAS = [
  'You are a startup CTO who values speed, iteration, and pragmatic solutions over perfection.',
  'You are a security auditor who sees vulnerabilities and risks that others miss.',
  'You are a behavioral economist who thinks in terms of incentives, biases, and game theory.',
  'You are a UX designer who prioritizes human experience, accessibility, and simplicity.',
  'You are a venture capitalist evaluating market opportunity, scalability, and competitive moats.',
  'You are a systems engineer who thinks about reliability, fault tolerance, and operational cost.',
  'You are a data scientist who demands evidence, metrics, and statistical rigor.',
  'You are a regulatory compliance officer focused on legal risks and governance.',
  'You are a customer success manager who thinks from the end-user frustration perspective.',
  'You are a DevOps engineer who cares about deployment, monitoring, and incident response.',
  'You are a product manager who balances user needs, business goals, and technical constraints.',
  'You are a creative director who values novelty, aesthetics, and emotional impact.',
];

export class PersonaExplorationStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'persona-exploration',
      name: 'persona-exploration',
      displayName: 'Persona Exploration',
      description:
        'Multiple distinct personas (startup CTO, security auditor, economist, UX designer...) each analyze from their perspective. Aggregator synthesizes best insights.',
      minModels: 2,
      maxModels: 5,
      estimatedCostMultiplier: 6.0,
      estimatedQualityBoost: 0.30,
      estimatedDurationMultiplier: 3.0,
      suitableFor: ['creative', 'analysis', 'general', 'documentation'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    return Promise.race([
      this.executeCore(request, context, startTime),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Persona exploration timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
    ]);
  }

  private async executeCore(request: ChatRequest, context: OrchestrationContext, startTime: number): Promise<OrchestrationResult> {
    const prep = await this.gatherPersonaPerspectives(request, context);

    this.emitObserverEvent(context, { type: 'synthesis_start', modelName: prep.activeAggregator.name || prep.activeAggregator.id, summary: 'Aggregating persona perspectives.' });

    // executeModelWithRetry handles cross-provider failover on execution
    // failure (rate limit, 5xx, etc.) — the perspectives have already
    // been gathered, so the aggregator failing alone shouldn't tank the
    // whole strategy when other models in `context.models` could synthesize.
    const aggExec = await this.executeModelWithRetry(prep.aggAdapter, prep.activeAggregator, prep.aggReq, 'aggregator', context);
    prep.executions.push(aggExec);

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: `Persona aggregation complete: ${prep.perspectivesCount} perspectives synthesized.` });

    const reasoningTracesMeta = prep.reasoningEnabled
      ? prep.executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens }))
      : undefined;

    return {
      finalResponse: aggExec.response,
      strategyUsed: 'persona-exploration',
      modelsUsed: prep.executions,
      totalCost: prep.executions.reduce((s, e) => s + e.cost, 0),
      totalDuration: Date.now() - startTime,
      metadata: {
        strategy: 'persona-exploration',
        personas: prep.perspectivesCount,
        personaLabels: prep.personaLabels,
        ...(reasoningTracesMeta?.length ? { reasoning_traces: reasoningTracesMeta } : {}),
      },
    };
  }

  /**
   * Shared by executeCore() (buffered) and executeStream() (real token
   * streaming, added 2026-07-11): phase 1 — gathering all persona
   * perspectives — is IDENTICAL for both paths. Only phase 2 (the
   * aggregation call) differs. Returns everything needed to run/stream that
   * call.
   */
  private async gatherPersonaPerspectives(
    request: ChatRequest,
    context: OrchestrationContext,
  ): Promise<{
    aggReq: ChatRequest;
    aggAdapter: import('@/providers/base/provider-adapter').ProviderAdapter;
    activeAggregator: Model;
    executions: ModelExecution[];
    perspectivesCount: number;
    personaLabels: string[];
    reasoningEnabled: boolean;
  }> {
    const models = this.getEligibleModels(context);
    if (models.length < 2) throw new Error('Persona exploration requires at least 2 models');

    // Caminho-C Q2 cross-strategy honor: pin biases the aggregator slot
    // and is INCLUDED in the explorer pool — the user's chosen model
    // contributes a persona-perspective response, then aggregates them.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn(
        { requestId: context.requestId, requestedModel: preference.requestedId, poolSize: models.length },
        'Persona exploration: requested model not in operational pool — falling back to quality-sorted aggregator',
      );
    }
    const sorted = assembleExecutors(
      preference,
      models.length,
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    const aggregator = sorted[0];
    const explorerModels = sorted.slice(0, Math.min(4, sorted.length));
    const numPersonas = Math.min(DEFAULT_PERSONAS.length, explorerModels.length * 3); // 3 personas per model
    const selectedPersonas = DEFAULT_PERSONAS.slice(0, numPersonas);
    const reasoningEnabled = this.isReasoningEnabled(request);
    const executions: ModelExecution[] = [];
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');

    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');

    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: explorerModels.map(m => m.name || m.id),
      summary: `Persona exploration: ${numPersonas} personas across ${explorerModels.length} models.`,
    });

    // Phase 1: Each persona responds in parallel
    const perspectives: Array<{ persona: string; content: string }> = [];

    const promises = selectedPersonas.map(async (persona, i) => {
      const model = explorerModels[i % explorerModels.length]; // Round-robin
      const adapter = await this.getAdapterForModel!(model, context);
      if (!adapter) throw new Error(`No adapter for ${model.id}`);

      const personaPrompt = this.withReasoningPrompt(PROMPTS.personaExplorer(persona), request, model);
      const personaReq: ChatRequest = {
        ...request,
        messages: [{ role: 'system', content: personaPrompt }, ...request.messages],
      };

      const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
      const exec = hasTools
        ? await this.executeModelWithTools(adapter, model, personaReq, 'explorer')
        : reasoningEnabled
          ? await this.executeModelWithReasoning(adapter, model, personaReq, 'explorer')
          : await this.executeModel(adapter, model, personaReq, 'explorer');

      return { persona, content: exec.response?.choices?.[0]?.message?.content ?? '', exec };
    });

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled') {
        executions.push(r.value.exec);
        const content = typeof r.value.content === 'string' ? r.value.content.trim() : '';
        if (content) perspectives.push({ persona: r.value.persona.substring(0, 80), content });
      }
    }

    if (perspectives.length === 0) throw new Error('All personas failed');

    this.emitObserverEvent(context, {
      type: 'round_complete', round: 1, totalRounds: 2,
      summary: `${perspectives.length} persona perspectives gathered. Aggregating.`,
    });

    // Phase 2: build the aggregator request. synthesis_start is emitted by
    // the caller (executeCore/executeStream) once the active aggregator —
    // post fallback-resolution below — is actually known.
    const perspectivesText = perspectives.map((p, i) =>
      `### Persona ${i + 1}: ${p.persona}\n${p.content}`
    ).join('\n\n---\n\n');

    const reasoningTraces = reasoningEnabled ? this.formatReasoningForSynthesizer(executions) : '';

    const aggReq: ChatRequest = {
      ...request,
      messages: [
        { role: 'system', content: PROMPTS.personaAggregator(perspectives.length) },
        { role: 'user', content: `ORIGINAL QUESTION:\n${originalQ}\n\nPERSPECTIVES:\n${perspectivesText}${reasoningTraces}` },
      ],
    };

    // Walk `sorted` to find an aggregator with an operational adapter.
    // Single-candidate-bail bug fix: previously this hard-failed when
    // `sorted[0]`'s adapter resolution returned null (provider key
    // missing, model not enabled, circuit OPEN), even though the next
    // sorted candidate would have been viable. Now we degrade through
    // the pool so transient or partial-coverage outages don't kill the
    // whole strategy after the personas already produced perspectives.
    let activeAggregator: Model = aggregator;
    let aggAdapter = await this.getAdapterForModel(activeAggregator, context);
    if (!aggAdapter) {
      for (let i = 1; i < sorted.length; i++) {
        activeAggregator = sorted[i];
        aggAdapter = await this.getAdapterForModel(activeAggregator, context);
        if (aggAdapter) {
          log.warn(
            { requestId: context.requestId, primary: aggregator.name, fallback: activeAggregator.name },
            'Persona aggregator: primary had no adapter, using fallback from sorted pool'
          );
          break;
        }
      }
    }
    if (!aggAdapter) throw new Error('No operational aggregator in candidate pool');

    return {
      aggReq,
      aggAdapter,
      activeAggregator,
      executions,
      perspectivesCount: perspectives.length,
      personaLabels: perspectives.map(p => p.persona),
      reasoningEnabled,
    };
  }

  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    this.emitObserverEvent(context, { type: 'phase_start', summary: 'Persona exploration: gathering diverse perspectives.' });
    yield this.progressChunk('Gathering persona perspectives...', 0, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const prep = await this.gatherPersonaPerspectives(request, context);

    this.emitObserverEvent(context, { type: 'synthesis_start', modelName: prep.activeAggregator.name || prep.activeAggregator.id, summary: `Aggregating ${prep.perspectivesCount} perspectives.` });
    yield this.progressChunk(`${prep.perspectivesCount} perspectives collected. Synthesizing...`, 1, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Genuine multi-perspective synthesis (like multi-hop-qa) — gets the
    // default capSynthesisRequest opt-in-cap behavior, not skipSynthesisCap.
    const fallbackText = prep.aggReq.messages[prep.aggReq.messages.length - 1]?.content;
    yield* this.streamSynthesisWithFallback(
      prep.aggReq,
      [{ adapter: prep.aggAdapter, model: prep.activeAggregator }],
      () => (typeof fallbackText === 'string' ? fallbackText.slice(0, 4000) : ''),
    );

    for (const c of await this.drainObserverChunks(context)) yield c;
  }
}
