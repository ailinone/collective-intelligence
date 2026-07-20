// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Double Diamond Meta-Strategy
 *
 * Operating principles:
 * - Double Diamond framework: divergent-convergent thinking cycles
 * - Problem-solution duality
 * - Phased gating: explore broadly, then converge with criteria
 *
 * Macro-strategy that composes existing strategies in 4 phases with gates:
 *   Diamond 1: Discover (diverge) → Define (converge) → problem statement
 *   Diamond 2: Develop (diverge) → Deliver (converge) → validated solution
 *
 * Each phase uses a different internal strategy:
 *   Discover → research-synthesize or swarm-explore
 *   Define → consensus or blind-debate
 *   Develop → swarm-explore or diversity-ensemble
 *   Deliver → critique-repair
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

const log = logger.child({ component: 'double-diamond-strategy' });
const TIMEOUT_MS = Number(process.env.DOUBLE_DIAMOND_TIMEOUT_MS ?? 180000);

export class DoubleDiamondStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'double-diamond',
      name: 'double-diamond',
      displayName: 'Double Diamond',
      description:
        'Four-phase macro-strategy: Discover→Define→Develop→Deliver. Best for ill-defined problems requiring structured problem-solution exploration.',
      minModels: 3,
      maxModels: 7,
      estimatedCostMultiplier: 10.0,
      estimatedQualityBoost: 0.40,
      estimatedDurationMultiplier: 6.0,
      suitableFor: ['analysis', 'creative', 'documentation', 'general'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    return Promise.race([
      this.executeCore(request, context, startTime),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Double Diamond timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
    ]);
  }

  private async executeCore(request: ChatRequest, context: OrchestrationContext, startTime: number): Promise<OrchestrationResult> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Double Diamond requires at least 3 models');

    // Caminho-C Q2 cross-strategy honor: pin biases sorted[0] which acts
    // as the convergence leader (definer + deliverer) across all four
    // diamond phases. Discoverers/developers stay as next-best peers
    // from the fallback pool to preserve divergent-thinking diversity.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      log.warn(
        { requestId: context.requestId, requestedModel: preference.requestedId, poolSize: models.length },
        'Double Diamond: requested model not in operational pool — falling back to quality-sorted leader',
      );
    }
    const sorted = assembleExecutors(
      preference,
      models.length,
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    const executions: ModelExecution[] = [];
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const reasoningEnabled = this.isReasoningEnabled(request);

    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');

    // Single-candidate-bail bug fix: walk `sorted` for the definer
    // adapter ONCE up front. The definer slot is reused across BOTH
    // converge phases (Define + Deliver), so the fallback choice must
    // be made before either phase runs — otherwise Define and Deliver
    // could end up on different models, breaking the intentional
    // continuity from problem-statement to solution-synthesis.
    let definer: Model = sorted[0];
    let definerAdapter = await this.getAdapterForModel(definer, context);
    if (!definerAdapter) {
      for (let i = 1; i < sorted.length; i++) {
        const candidate = sorted[i];
        const adapter = await this.getAdapterForModel(candidate, context);
        if (adapter) {
          log.warn(
            { requestId: context.requestId, primary: sorted[0].name, fallback: candidate.name },
            'Double Diamond definer: primary had no adapter, using fallback from sorted pool (Define + Deliver share this slot)'
          );
          definer = candidate;
          definerAdapter = adapter;
          break;
        }
      }
    }
    if (!definerAdapter) throw new Error('No operational definer in candidate pool');

    // ═══ DIAMOND 1: Problem Space ═══

    // Phase 1: DISCOVER (diverge) — research from multiple angles
    this.emitObserverEvent(context, { type: 'phase_start', models: sorted.slice(1, 4).map(m => m.name || m.id), summary: 'Diamond 1 — Discover: researching the problem space from multiple angles.' });

    const discoverers = sorted.slice(1, Math.min(4, sorted.length));
    const discoveries: string[] = [];

    const discoverPromises = discoverers.map(async (model) => {
      const adapter = await this.getAdapterForModel!(model, context);
      if (!adapter) return null;
      const discoverReq: ChatRequest = {
        ...request,
        messages: [{ role: 'system', content: this.withReasoningPrompt(PROMPTS.doubleDiamondDiscoverer, request, model) }, ...request.messages],
      };
      let exec = reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, model, discoverReq, 'discoverer')
        : await this.executeModel(adapter, model, discoverReq, 'discoverer');
      // Fallback if model failed
      if (!exec.success) {
        exec = await this.executeModelWithRetry(adapter, model, discoverReq, 'discoverer', context);
      }
      executions.push(exec);
      return exec.success ? (exec.response?.choices?.[0]?.message?.content ?? '') : '';
    });

    const discoverResults = await Promise.allSettled(discoverPromises);
    for (const r of discoverResults) {
      if (r.status === 'fulfilled' && typeof r.value === 'string' && r.value.trim()) discoveries.push(r.value);
    }

    if (discoveries.length === 0) throw new Error('Discovery phase failed');

    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 4, summary: `Discover: ${discoveries.length} perspectives gathered.` });

    // Phase 2: DEFINE (converge) — synthesize discoveries into problem statement
    this.emitObserverEvent(context, { type: 'synthesis_start', summary: 'Diamond 1 — Define: converging on problem definition.' });

    // definer/definerAdapter resolved up front (shared with Deliver).

    const discoveriesText = discoveries.map((d, i) => `### Discovery ${i + 1}:\n${d}`).join('\n\n---\n\n');
    const defineReq: ChatRequest = {
      ...request,
      messages: [
        { role: 'system', content: PROMPTS.doubleDiamondDefiner },
        { role: 'user', content: `ORIGINAL REQUEST:\n${originalQ}\n\nDISCOVERIES:\n${discoveriesText}\n\nDefine the CORE problem.` },
      ],
    };
    // executeModelWithRetry handles cross-provider failover when the
    // define call fails. If it fails entirely, the strategy can't
    // proceed (no problem statement to develop solutions for) — but
    // at least it tries the pool first.
    const defineExec = await this.executeModelWithRetry(definerAdapter, definer, defineReq, 'definer', context);
    executions.push(defineExec);
    const problemDefinition = defineExec.response?.choices?.[0]?.message?.content ?? '';

    this.emitObserverEvent(context, { type: 'round_complete', round: 2, totalRounds: 4, summary: 'Define: problem statement established.' });

    // ═══ DIAMOND 2: Solution Space ═══

    // Phase 3: DEVELOP (diverge) — generate diverse solutions
    this.emitObserverEvent(context, { type: 'phase_start', summary: 'Diamond 2 — Develop: generating diverse solutions.' });

    const ideators = sorted.slice(1, Math.min(4, sorted.length));
    const solutions: string[] = [];

    const developPromises = ideators.map(async (model) => {
      const adapter = await this.getAdapterForModel!(model, context);
      if (!adapter) return null;
      const developReq: ChatRequest = {
        ...request,
        messages: [
          { role: 'system', content: this.withReasoningPrompt(PROMPTS.doubleDiamondIdeator, request, model) },
          { role: 'user', content: `PROBLEM DEFINITION:\n${problemDefinition}\n\nORIGINAL CONTEXT:\n${originalQ}\n\nPropose 3-5 distinct solutions.` },
        ],
      };
      // Parity with Discover phase (line ~107): default branch uses
      // executeModelWithRetry for cross-provider failover. Reasoning
      // branch keeps its dedicated helper for reasoning_content
      // extraction shape.
      const exec = reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, model, developReq, 'ideator')
        : await this.executeModelWithRetry(adapter, model, developReq, 'ideator', context);
      executions.push(exec);
      return exec.response?.choices?.[0]?.message?.content ?? '';
    });

    const developResults = await Promise.allSettled(developPromises);
    for (const r of developResults) {
      if (r.status === 'fulfilled' && typeof r.value === 'string' && r.value.trim()) solutions.push(r.value);
    }

    this.emitObserverEvent(context, { type: 'round_complete', round: 3, totalRounds: 4, summary: `Develop: ${solutions.length} solution sets generated.` });

    // Phase 4: DELIVER (converge) — synthesize best solution
    this.emitObserverEvent(context, { type: 'synthesis_start', summary: 'Diamond 2 — Deliver: converging on best solution.' });

    const solutionsText = solutions.map((s, i) => `### Solution Set ${i + 1}:\n${s}`).join('\n\n---\n\n');
    const reasoningTraces = reasoningEnabled ? this.formatReasoningForSynthesizer(executions) : '';

    // R3: synthesizer prompt migrated to the SOTA catalog.
    const deliverReq: ChatRequest = {
      ...request,
      messages: [
        { role: 'system', content: PROMPTS.doubleDiamondSynthesizer },
        { role: 'user', content: `PROBLEM DEFINITION:\n${problemDefinition}\n\nSOLUTION PROPOSALS:\n${solutionsText}${reasoningTraces}\n\nProduce the definitive response.` },
      ],
    };
    // executeModelWithRetry: cross-provider failover for the final
    // synthesis call. The deliver phase is the response — failure here
    // would produce a strategy result with no finalResponse, so this
    // failover is critical.
    const deliverExec = await this.executeModelWithRetry(definerAdapter, definer, deliverReq, 'synthesizer', context);
    executions.push(deliverExec);

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Double Diamond complete: problem defined, solution synthesized.' });

    const reasoningTracesMeta = reasoningEnabled
      ? executions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens }))
      : undefined;

    return {
      finalResponse: deliverExec.response,
      strategyUsed: 'double-diamond',
      modelsUsed: executions,
      totalCost: executions.reduce((s, e) => s + e.cost, 0),
      totalDuration: Date.now() - startTime,
      metadata: {
        strategy: 'double-diamond',
        phases: ['discover', 'define', 'develop', 'deliver'],
        discoveries: discoveries.length,
        solutionSets: solutions.length,
        totalCalls: executions.length,
        ...(reasoningTracesMeta?.length ? { reasoning_traces: reasoningTracesMeta } : {}),
      },
    };
  }

  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Double Diamond requires at least 3 models');
    const preference = resolvePreferredExecutor(models, context, []);
    const sorted = assembleExecutors(
      preference,
      models.length,
      (a, b) => (b.performance?.quality ?? 0.5) - (a.performance?.quality ?? 0.5),
    );
    const originalQ = request.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const reasoningEnabled = this.isReasoningEnabled(request);
    const executions: ModelExecution[] = [];
    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');

    // Resolve definer up front (Define + Deliver share this slot).
    // Walk-through-sorted to handle null adapter on highest-quality
    // candidate. See execute() for rationale.
    let definer: Model = sorted[0];
    let definerAdapter = await this.getAdapterForModel(definer, context);
    if (!definerAdapter) {
      for (let i = 1; i < sorted.length; i++) {
        const candidate = sorted[i];
        const adapter = await this.getAdapterForModel(candidate, context);
        if (adapter) {
          log.warn(
            { requestId: context.requestId, primary: sorted[0].name, fallback: candidate.name },
            'Double Diamond definer (stream): primary had no adapter, using fallback from sorted pool'
          );
          definer = candidate;
          definerAdapter = adapter;
          break;
        }
      }
    }
    if (!definerAdapter) throw new Error('No operational definer in candidate pool');

    // D1.1: Discover
    this.emitObserverEvent(context, { type: 'phase_start', summary: 'Diamond 1 — Discover: exploring problem space.' });
    yield this.progressChunk('Diamond 1: Discovering problem space...', 0, 4);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const discoverers = sorted.slice(1, Math.min(4, sorted.length));
    const discoveries: string[] = [];
    await Promise.allSettled(discoverers.map(async (model) => {
      const adapter = await this.getAdapterForModel!(model, context);
      if (!adapter) return;
      const req: ChatRequest = { ...request, messages: [{ role: 'system', content: this.withReasoningPrompt(PROMPTS.doubleDiamondDiscoverer, request, model) }, ...request.messages] };
      // Parity with execute(): default branch uses retry for cross-
      // provider failover on transient discover-call failures.
      const exec = reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, model, req, 'discoverer')
        : await this.executeModelWithRetry(adapter, model, req, 'discoverer', context);
      executions.push(exec);
      const content = exec.response?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) discoveries.push(content);
    }));
    if (discoveries.length === 0) throw new Error('Discovery failed');

    // D1.2: Define
    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 4, summary: `${discoveries.length} discoveries. Defining problem.` });
    yield this.progressChunk('Diamond 1: Defining core problem...', 1, 4);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // definer/definerAdapter resolved up front (shared with Deliver).
    const discText = discoveries.map((d, i) => `### ${i + 1}:\n${d}`).join('\n\n---\n\n');
    // executeModelWithRetry: failover on transient define-call failures.
    const defineExec = await this.executeModelWithRetry(definerAdapter, definer, { ...request, messages: [{ role: 'system', content: PROMPTS.doubleDiamondDefiner }, { role: 'user', content: `REQUEST:\n${originalQ}\n\nDISCOVERIES:\n${discText}\n\nDefine the core problem.` }] }, 'definer', context);
    executions.push(defineExec);
    const problemDef = defineExec.response?.choices?.[0]?.message?.content ?? '';

    // D2.1: Develop
    this.emitObserverEvent(context, { type: 'round_complete', round: 2, totalRounds: 4, summary: 'Problem defined. Generating solutions.' });
    yield this.progressChunk('Diamond 2: Generating solutions...', 2, 4);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const solutions: string[] = [];
    await Promise.allSettled(discoverers.map(async (model) => {
      const adapter = await this.getAdapterForModel!(model, context);
      if (!adapter) return;
      const req: ChatRequest = { ...request, messages: [{ role: 'system', content: this.withReasoningPrompt(PROMPTS.doubleDiamondIdeator, request, model) }, { role: 'user', content: `PROBLEM:\n${problemDef}\n\nCONTEXT:\n${originalQ}\n\nPropose solutions.` }] };
      // Parity with execute() Develop phase: retry on default branch.
      const exec = reasoningEnabled
        ? await this.executeModelWithReasoning(adapter, model, req, 'ideator')
        : await this.executeModelWithRetry(adapter, model, req, 'ideator', context);
      executions.push(exec);
      const content = exec.response?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) solutions.push(content);
    }));

    // D2.2: Deliver (stream)
    this.emitObserverEvent(context, { type: 'round_complete', round: 3, totalRounds: 4, summary: `${solutions.length} solution sets. Synthesizing.` });
    this.emitObserverEvent(context, { type: 'synthesis_start', summary: 'Diamond 2 — Delivering final synthesis.' });
    yield this.progressChunk('Diamond 2: Synthesizing final answer...', 3, 4);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const solText = solutions.map((s, i) => `### ${i + 1}:\n${s}`).join('\n\n---\n\n');
    const traces = reasoningEnabled ? this.formatReasoningForSynthesizer(executions) : '';
    // Was a short ad-hoc string, inconsistent with the canonical
    // PROMPTS.doubleDiamondSynthesizer used by execute()'s non-streaming
    // deliver phase (which already carries ADAPTIVE_DEPTH_DIRECTIVE). Aligning
    // the two paths also picks up the depth directive here for free.
    const deliverReq: ChatRequest = { ...request, messages: [{ role: 'system', content: PROMPTS.doubleDiamondSynthesizer }, { role: 'user', content: `PROBLEM:\n${problemDef}\n\nSOLUTIONS:\n${solText}${traces}\n\nDefinitive answer.` }] };

    // RESILIENT streaming: bare for-await had NO first-token deadline. Route
    // through the fallback-chain helper (first-chunk + idle deadlines, graceful
    // degrade to the raw solutions instead of a hard stream failure).
    yield* this.streamSynthesisWithFallback(
      deliverReq,
      [{ adapter: definerAdapter, model: definer }],
      () => solText.slice(0, 4000),
    );

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Double Diamond complete.' });
    for (const c of await this.drainObserverChunks(context)) yield c;
  }
}
