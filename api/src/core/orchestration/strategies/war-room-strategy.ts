// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * War Room Strategy
 *
 * Decomposes complex tasks into sub-problems, assigns specialist roles to
 * models, executes all specialists in parallel, runs a critique pass on
 * their outputs, and synthesizes into a unified final response.
 *
 * Architecture:
 *   1. Commander: decomposes the task into sub-tasks
 *   2. Specialists: each sub-task assigned to the best-fit model (parallel)
 *   3. Critic: identifies gaps, contradictions, quality issues
 *   4. Synthesizer: merges all specialist outputs + critique into a final response
 *
 * Best for: Large, complex tasks that benefit from divide-and-conquer (architecture
 * reviews, multi-file refactors, incident post-mortems, comprehensive analysis).
 *
 * Cost: High (4× to 6× single model — commander + specialists + critic + synthesizer)
 * Quality: Very high for complex tasks where no single model has complete expertise.
 */

import { BaseStrategy, safeResponseContent, type StrategyMetadata } from '../base-strategy';
import { resolvePreferredExecutor, assembleExecutors } from './preferred-model-helper';
import { PROMPTS } from '../prompts/sota-system-prompts';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
  ModelRole,
} from '@/types';

export class WarRoomStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'war-room',
      name: 'war-room',
      displayName: 'War Room',
      description:
        'Decomposes tasks into sub-problems, assigns specialists in parallel, critiques outputs, and synthesizes. For complex, high-stakes tasks.',
      minModels: 3,
      maxModels: 7,
      estimatedCostMultiplier: 5.0,
      estimatedQualityBoost: 0.35,
      estimatedDurationMultiplier: 2.5,
      suitableFor: ['analysis', 'code-review', 'code-generation', 'refactoring', 'debugging'],
    };
  }

  supportsStreaming(): boolean {
    return true;
  }

  async *executeStream(
    request: ChatRequest,
    context: OrchestrationContext
  ): AsyncGenerator<ChatResponse, void, unknown> {
    const models = this.getEligibleModels(context);
    if (models.length < this.getMetadata().minModels!) {
      throw new Error(`War Room requires at least ${this.getMetadata().minModels} models`);
    }

    // Caminho-C Q2 cross-strategy honor: pin biases the commander slot
    // (sorted[0]) — the role that decomposes the task. Synthesizer and
    // critic stay as next-best peers from the fallback pool, preserving
    // independence between decomposition author and final synthesis.
    const preference = resolvePreferredExecutor(models, context, []);
    const sorted = assembleExecutors(
      preference,
      models.length,
      (a, b) => (b.performance?.quality || 0.8) - (a.performance?.quality || 0.8),
    );
    const commander = sorted[0];
    const synthesizer = sorted.length > 1 ? sorted[1] : sorted[0];
    const critic = sorted.length > 2 ? sorted[2] : sorted[0];
    const specialistPool = sorted.slice(1).slice(0, 5);

    // Phase 1: Decompose
    this.emitObserverEvent(context, { type: 'phase_start', models: sorted.slice(0, 4).map(m => m.name || m.id), summary: `War room: commander + ${specialistPool.length} specialists + critic + synthesizer.` });
    yield this.progressChunk('Commander decomposing task into sub-tasks...', 1, 5);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const decomposition = await this.decompose(request, commander, context);
    const subTasks = decomposition.subTasks;

    if (subTasks.length === 0) {
      yield decomposition.execution.response;
      return;
    }

    // Phase 2: Specialists
    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 4, summary: `Commander decomposed into ${subTasks.length} sub-tasks.` });
    yield this.progressChunk(`Executing ${subTasks.length} specialists in parallel...`, 2, 5);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const specialistResults = await this.executeSpecialists(request, subTasks, specialistPool, context);

    // Phase 3: Critique
    this.emitObserverEvent(context, { type: 'round_complete', round: 2, totalRounds: 4, summary: `${specialistResults.length} specialists done. Critic reviewing.` });
    yield this.progressChunk('Critic reviewing specialist outputs...', 3, 5);
    for (const c of await this.drainObserverChunks(context)) yield c;

    await this.critique(request, subTasks, specialistResults, critic, context);

    // Phase 4: Stream synthesis token-by-token
    this.emitObserverEvent(context, { type: 'round_complete', round: 3, totalRounds: 4, summary: 'Critique done. Synthesizing.' });
    this.emitObserverEvent(context, { type: 'synthesis_start', summary: 'Synthesizer producing final response.' });
    yield this.progressChunk('Synthesizing final response...', 4, 5);
    for (const c of await this.drainObserverChunks(context)) yield c;

    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected');
    }
    const synthAdapter = await this.getAdapterForModel(synthesizer, context);
    if (!synthAdapter) {
      throw new Error(`No adapter for synthesizer: ${synthesizer.id}`);
    }

    const specialistSummary = specialistResults
      .map((r, i) => {
        const text = safeResponseContent(r.execution.response);
        return `## Sub-task ${i + 1}: ${r.subTask}\n${text.slice(0, 3000)}`;
      })
      .join('\n\n---\n\n');

    const synthesisRequest: ChatRequest = {
      ...request,
      stream: true,
      model: synthesizer.id,
      messages: [
        {
          role: 'system' as const,
          content:
            PROMPTS.warRoomSynthesizer,
        },
        {
          role: 'user' as const,
          content: `Original request:\n${this.getLastUserMessage(request)}\n\nSpecialist outputs:\n${specialistSummary}`,
        },
      ],
    };

    // RESILIENT streaming: a bare for-await on a single adapter had NO deadline
    // on the first token — a stalled synthesizer provider hung the whole SSE
    // stream indefinitely (until the provider's own timeout, if any). Route
    // through the fallback-chain helper (first-chunk + idle deadlines, other
    // war-room executors as fallback synthesizers, graceful degrade instead of
    // a hard stream failure).
    const fallbackCandidates: Array<{ adapter: import('@/providers/base/provider-adapter').ProviderAdapter; model: Model }> =
      [{ adapter: synthAdapter, model: synthesizer }];
    if (this.getAdapterForModel) {
      const extraModels = [critic, ...specialistPool].filter((m) => m.id !== synthesizer.id);
      const seen = new Set([synthesizer.id]);
      for (const m of extraModels) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        try {
          const adapter = await this.getAdapterForModel(m, context);
          if (adapter) fallbackCandidates.push({ adapter, model: m });
        } catch { /* skip unavailable candidate */ }
      }
    }
    yield* this.streamSynthesisWithFallback(
      synthesisRequest,
      fallbackCandidates,
      () => specialistSummary.slice(0, 4000),
    );

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'War room synthesis complete.' });
    for (const c of await this.drainObserverChunks(context)) yield c;
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const models = this.getEligibleModels(context);

    if (models.length < this.getMetadata().minModels!) {
      throw new Error(`War Room requires at least ${this.getMetadata().minModels} models (${models.length} available)`);
    }

    // Select roles: commander (highest quality), specialists (diverse), critic, synthesizer
    // Pin biases commander; see executeStream comment for full rationale.
    const preference = resolvePreferredExecutor(models, context, []);
    if (preference.pinReason === 'pin-not-in-pool') {
      this.log.warn(
        { requestId: context.requestId, requestedModel: preference.requestedId, poolSize: models.length },
        'War room: requested model not in operational pool — falling back to quality-sorted commander',
      );
    }
    const sorted = assembleExecutors(
      preference,
      models.length,
      (a, b) => (b.performance?.quality || 0.8) - (a.performance?.quality || 0.8),
    );
    const commander = sorted[0];
    const synthesizer = sorted.length > 1 ? sorted[1] : sorted[0];
    const critic = sorted.length > 2 ? sorted[2] : sorted[0];
    const specialistPool = sorted.slice(1).slice(0, 5); // up to 5 specialists

    const allExecutions: ModelExecution[] = [];

    // Observer: phase start
    this.emitObserverEvent(context, { type: 'phase_start', models: sorted.slice(0, 4).map(m => m.name || m.id), summary: `War room: commander decomposes, ${specialistPool.length} specialists, 1 critic, 1 synthesizer.` });

    // === Phase 1: Commander decomposes the task ===
    const decomposition = await this.decompose(request, commander, context);
    allExecutions.push(decomposition.execution);
    const subTasks = decomposition.subTasks;

    if (subTasks.length === 0) {
      // Commander couldn't decompose → fall back to single execution
      return {
        strategyUsed: this.getMetadata().name,
        modelsUsed: allExecutions,
        finalResponse: decomposition.execution.response,
        totalCost: decomposition.execution.cost,
        totalDuration: Date.now() - startTime,
        qualityScore: 0.7,
        metadata: { phase: 'decompose_failed', subTasks: 0 },
      };
    }

    // Observer: decomposition complete
    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 4, summary: `Commander decomposed into ${subTasks.length} sub-tasks. Specialists executing.` });

    // === Phase 2: Assign and execute specialists in parallel ===
    const specialistResults = await this.executeSpecialists(
      request, subTasks, specialistPool, context
    );
    for (const sr of specialistResults) {
      allExecutions.push(sr.execution);
    }

    // Observer: specialists done
    this.emitObserverEvent(context, { type: 'round_complete', round: 2, totalRounds: 4, summary: `${specialistResults.length} specialists completed. Critic reviewing.` });

    // === Phase 3: Critique pass ===
    const critiqueExecution = await this.critique(
      request, subTasks, specialistResults, critic, context
    );
    allExecutions.push(critiqueExecution);

    // === Phase 3.5: Rework — specialists refine based on critique ===
    // Data insight: war-room scored 0.495 partly because specialists never see critique feedback.
    // This phase gives each specialist a chance to address the critic's issues.
    if (process.env.WAR_ROOM_ENABLE_REWORK !== 'false' && critiqueExecution.success) {
      const critiqueContent = critiqueExecution.response?.choices?.[0]?.message?.content;
      const critiqueText = typeof critiqueContent === 'string' ? critiqueContent : '';
      if (critiqueText.length > 50) { // Only rework if critique has substance
        this.log.info({ subTasks: subTasks.length }, 'War-room: rework phase — specialists refining based on critique');
        const reworkPromises = specialistResults.map(async (sr, i) => {
          const specialist = sr.execution.modelId ? specialistPool.find(m => m.id === sr.execution.modelId) : specialistPool[i % specialistPool.length];
          if (!specialist || !this.getAdapterForModel) return sr;
          try {
            const adapter = await this.getAdapterForModel(specialist, context);
            if (!adapter) return sr;
            const originalContent = sr.execution.response?.choices?.[0]?.message?.content;
            const originalText = typeof originalContent === 'string' ? originalContent : '';
            // R3: specialist-rework prompt migrated to the SOTA catalog.
            const reworkRequest: ChatRequest = {
              ...request,
              messages: [
                {
                  role: 'system' as const,
                  content: PROMPTS.warRoomSpecialistRework,
                },
                {
                  role: 'user' as const,
                  content: `Your assigned sub-task: ${sr.subTask}\n\nYour previous response:\n${originalText.slice(0, 2000)}\n\nCritic's feedback:\n${critiqueText.slice(0, 1500)}\n\nProvide your improved response:`,
                },
              ],
            };
            const reworkExec = await this.executeSingleModel(specialist, reworkRequest, 'reworker' as ModelRole, context);
            allExecutions.push(reworkExec);
            if (reworkExec.success) {
              return { subTask: sr.subTask, execution: reworkExec }; // Replace with improved version
            }
            return sr; // Keep original if rework failed
          } catch { return sr; }
        });
        const reworked = await Promise.all(reworkPromises);
        // Replace specialistResults with reworked versions where successful
        for (let i = 0; i < reworked.length && i < specialistResults.length; i++) {
          specialistResults[i] = reworked[i];
        }
      }
    }

    // Observer: critique + rework done
    this.emitObserverEvent(context, { type: 'round_complete', round: 3, totalRounds: 4, summary: 'Critique and rework phases complete. Synthesizer producing final response.' });
    this.emitObserverEvent(context, { type: 'synthesis_start', summary: 'Synthesizer merging specialist outputs with critique feedback.' });

    // === Phase 4: Synthesize final response ===
    const synthesisExecution = await this.synthesize(
      request, subTasks, specialistResults, critiqueExecution, synthesizer, context
    );
    allExecutions.push(synthesisExecution);

    // Observer: synthesis complete
    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: `War room complete. ${allExecutions.length} total model calls across 4 phases.` });

    const totalCost = allExecutions.reduce((s, e) => s + e.cost, 0);
    const duration = Date.now() - startTime;

    return {
      strategyUsed: this.getMetadata().name,
      modelsUsed: allExecutions,
      finalResponse: synthesisExecution.response,
      totalCost,
      totalDuration: duration,
      qualityScore: 0.9,
      metadata: {
        subTasks: subTasks.length,
        specialistsUsed: specialistResults.length,
        phases: ['decompose', 'specialists', 'critique', 'synthesize'],
        commanderModel: commander.id,
        criticModel: critic.id,
        synthesizerModel: synthesizer.id,
        ...(this.isReasoningEnabled(request)
          ? { reasoning_traces: allExecutions.filter(e => e.reasoning).map(e => ({ model_id: e.modelId, model_name: e.modelName, role: e.role, reasoning: e.reasoning, reasoning_tokens: e.reasoningTokens })) }
          : {}),
      },
    };
  }

  // ---- Internal phases ----

  private async decompose(
    request: ChatRequest,
    commander: Model,
    context: OrchestrationContext
  ): Promise<{ execution: ModelExecution; subTasks: string[] }> {
    const userContent = this.getLastUserMessage(request);
    const decomposeRequest: ChatRequest = {
      ...request,
      messages: [
        {
          role: 'system' as const,
          content:
            'You are a task decomposition commander. Break the following task into 2–5 independent sub-tasks ' +
            'that can be worked on in parallel by different specialists. ' +
            'Respond with a JSON array of objects: [{"id": 1, "task": "description", "specialization": "code|analysis|review|design"}]. ' +
            'If the task is simple enough for a single pass, return an empty array [].',
        },
        { role: 'user' as const, content: userContent },
      ],
      max_tokens: 1000,
    };

    const execution = await this.executeSingleModel(commander, decomposeRequest, 'coordinator' as ModelRole, context);

    // Parse sub-tasks from commander response
    const contentStr = safeResponseContent(execution.response);
    let subTasks: string[] = [];

    try {
      const jsonMatch = contentStr.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Array<{ task?: string; id?: number }>;
        subTasks = parsed
          .filter((t) => t && typeof t.task === 'string')
          .map((t) => t.task!)
          .slice(0, 5);
      }
    } catch {
      // If JSON parsing fails, try line-based parsing
      subTasks = contentStr
        .split('\n')
        .filter((l) => /^\d+[\.\)]\s/.test(l.trim()))
        .map((l) => l.replace(/^\d+[\.\)]\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 5);
    }

    return { execution, subTasks };
  }

  private async executeSpecialists(
    originalRequest: ChatRequest,
    subTasks: string[],
    specialists: Model[],
    context: OrchestrationContext
  ): Promise<Array<{ subTask: string; execution: ModelExecution }>> {
    const tasks = subTasks.map((subTask, i) => {
      const specialist = specialists[i % specialists.length]; // Round-robin
      const specialistPrompt = this.withReasoningPrompt(PROMPTS.warRoomSpecialist(subTask), originalRequest, specialist);
      const specialistRequest: ChatRequest = {
        ...originalRequest,
        messages: [
          {
            role: 'system' as const,
            content: specialistPrompt,
          },
          {
            role: 'user' as const,
            content: `Original request context:\n${this.getLastUserMessage(originalRequest)}\n\n---\nYour assigned sub-task:\n${subTask}`,
          },
        ],
      };
      return { subTask, specialist, request: specialistRequest };
    });

    const results = await Promise.allSettled(
      tasks.map(async (t) => {
        const execution = await this.executeSingleModel(t.specialist, t.request, 'secondary' as ModelRole, context);
        return { subTask: t.subTask, execution };
      })
    );

    return results
      .filter((r): r is PromiseFulfilledResult<{ subTask: string; execution: ModelExecution }> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((r) => r.execution.success);
  }

  private async critique(
    originalRequest: ChatRequest,
    subTasks: string[],
    specialistResults: Array<{ subTask: string; execution: ModelExecution }>,
    critic: Model,
    context: OrchestrationContext
  ): Promise<ModelExecution> {
    const specialistSummary = specialistResults
      .map((r, i) => {
        const text = safeResponseContent(r.execution.response);
        return `## Sub-task ${i + 1}: ${r.subTask}\n${text.slice(0, 2000)}`;
      })
      .join('\n\n---\n\n');

    const critiqueRequest: ChatRequest = {
      ...originalRequest,
      messages: [
        {
          role: 'system' as const,
          content:
            PROMPTS.warRoomCritic,
        },
        {
          role: 'user' as const,
          content: `Original task:\n${this.getLastUserMessage(originalRequest)}\n\nSub-tasks:\n${subTasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nSpecialist outputs:\n${specialistSummary}`,
        },
      ],
      max_tokens: 1500,
    };

    return this.executeSingleModel(critic, critiqueRequest, 'reviewer' as ModelRole, context);
  }

  private async synthesize(
    originalRequest: ChatRequest,
    subTasks: string[],
    specialistResults: Array<{ subTask: string; execution: ModelExecution }>,
    critiqueExecution: ModelExecution,
    synthesizer: Model,
    context: OrchestrationContext
  ): Promise<ModelExecution> {
    const specialistSummary = specialistResults
      .map((r, i) => {
        const text = safeResponseContent(r.execution.response);
        return `## Sub-task ${i + 1}: ${r.subTask}\n${text.slice(0, 3000)}`;
      })
      .join('\n\n---\n\n');

    const critiqueText = safeResponseContent(critiqueExecution.response);

    // Include reasoning traces from specialists so synthesizer can see HOW they reasoned
    const allSpecialistExecutions = specialistResults.map(r => r.execution);
    const reasoningTraces = this.isReasoningEnabled(originalRequest)
      ? this.formatReasoningForSynthesizer(allSpecialistExecutions)
      : '';

    const synthesisRequest: ChatRequest = {
      ...originalRequest,
      messages: [
        {
          role: 'system' as const,
          content: PROMPTS.warRoomSynthesizer,
        },
        {
          role: 'user' as const,
          content: `Original request:\n${this.getLastUserMessage(originalRequest)}\n\nSpecialist outputs:\n${specialistSummary}\n\nCritique (address these issues):\n${critiqueText.slice(0, 2000)}${reasoningTraces}`,
        },
      ],
    };

    return this.executeSingleModel(synthesizer, synthesisRequest, 'primary' as ModelRole, context);
  }

  private async executeSingleModel(
    model: Model,
    request: ChatRequest,
    role: ModelRole,
    context: OrchestrationContext
  ): Promise<ModelExecution> {
    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected by orchestration engine');
    }
    const adapter = await this.getAdapterForModel(model, context);
    if (!adapter) {
      throw new Error(`No adapter found for model: ${model.id}`);
    }
    // Tool-aware execution: if request has tools, use executeModelWithTools for tool loop
    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    if (hasTools) {
      return this.executeModelWithTools(adapter, model, request, role);
    }
    return this.isReasoningEnabled(request)
      ? this.executeModelWithReasoning(adapter, model, request, role)
      : this.executeModel(adapter, model, request, role);
  }

  private getLastUserMessage(request: ChatRequest): string {
    const userMessages = request.messages.filter((m) => m.role === 'user');
    const lastMessage = userMessages[userMessages.length - 1];
    const content = lastMessage?.content || '';
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
}
