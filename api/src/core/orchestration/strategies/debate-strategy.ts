// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Multi-Turn Debate Strategy
 *
 * Implements a debate-style orchestration where multiple models engage
 * in a structured dialogue to arrive at a high-quality consensus.
 *
 * This strategy is particularly effective for:
 * - Complex reasoning tasks
 * - Controversial or nuanced topics
 * - Decision-making with trade-offs
 * - Creative problem-solving
 *
 * Flow:
 *   1. Present problem to all debate participants
 *   2. Each model presents initial position
 *   3. Models respond to each other's positions (debate rounds)
 *   4. Moderator synthesizes consensus or best argument
 *   5. Quality validation and final response
 *
 * This is a cornerstone of the Collective Intelligence system,
 * demonstrating true inter-model collaboration beyond simple routing.
 */

import type {
  ChatRequest,
  ChatMessage,
  ChatResponse,
  Model,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
} from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { PROMPTS } from '../prompts/sota-system-prompts';
import { BaseStrategy, safeResponseContent, type StrategyMetadata } from '../base-strategy';
import { getDynamicModelSelector } from '@/core/selection/dynamic-model-selector';
import { resolvePreferredExecutor } from './preferred-model-helper';
import {
  persistDebateRun,
  type DebateSignalInput,
} from '@/core/coordination/collective-run-repository';
import {
  buildEnsembleRequest,
} from '@/core/coordination/ensemble-coordinator-client';
import {
  runEnsembleInShadow,
  type ShadowEnsembleSnapshot,
} from '@/core/coordination/ensemble-coordinator-shadow';
import { logger } from '@/utils/logger';
import { nanoid } from 'nanoid';

const log = logger.child({ component: 'debate-strategy' });

/**
 * Debate participant with their position
 */
interface DebateParticipant {
  model: Model;
  adapter: ProviderAdapter;
  role: 'debater' | 'moderator';
  name: string;
  positions: string[]; // All positions taken during debate
}

/**
 * Debate round result
 */
interface DebateRound {
  roundNumber: number;
  positions: Array<{
    participant: string;
    position: string;
    respondingTo?: string;
  }>;
  durationMs: number;
}

/**
 * Multi-Turn Debate Strategy
 */
export class DebateStrategy extends BaseStrategy {
  private modelSelector = getDynamicModelSelector();

  getMetadata(): StrategyMetadata {
    return {
      id: 'debate',
      name: 'debate',
      displayName: 'Multi-Turn Debate',
      description:
        'Multiple models engage in structured debate to arrive at best solution',
      minModels: 3,
      maxModels: 5,
      estimatedCostMultiplier: 4.0,
      estimatedQualityBoost: 0.35,
      estimatedDurationMultiplier: 5.0,
      suitableFor: [
        'analysis',
        'code-review',
        'refactoring',
        'debugging',
        'documentation',
      ],
    };
  }

  async execute(
    request: ChatRequest,
    context: OrchestrationContext
  ): Promise<OrchestrationResult> {
    const DEBATE_TIMEOUT_MS = Number(process.env.DEBATE_TIMEOUT_MS ?? 90_000);
    return Promise.race([
      this.executeCore(request, context),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Debate timeout after ${DEBATE_TIMEOUT_MS}ms`)),
          DEBATE_TIMEOUT_MS
        )
      ),
    ]);
  }

  private async executeCore(
    request: ChatRequest,
    context: OrchestrationContext
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const requestId = nanoid();

    log.info(
      {
        requestId,
        taskType: context.taskType,
      },
      'Starting multi-turn debate strategy'
    );

    const debatePlan = this.buildDebatePlan(request, context);

    // 1. Select debate participants (3-5 diverse models)
    const participants = await this.selectParticipants(
      context,
      debatePlan.maxParticipants
    );

    if (participants.length < 3) {
      throw new Error('Debate strategy requires at least 3 models');
    }

    const { moderator, debaters, reason: moderatorReason, scheduler: moderatorScheduler } =
      this.assignModeratorRole(participants, context);

    log.info(
      {
        requestId,
        moderator: moderator.name,
        debaters: debaters.map((d) => d.name),
        plannedRounds: debatePlan.numDebateRounds,
        plannedParticipants: debatePlan.maxParticipants,
        // F4.1 audit substrate at the call site.
        moderatorScheduler,
        moderatorReason,
      },
      'Debate participants selected'
    );

    // Phase 2c shadow integration — fire ensemble in parallel without
    // blocking the heuristic decision path. The result is logged for
    // offline divergence analysis and persisted into the synthesis
    // signal's `decisionValue.shadowEnsemble` (if it lands before
    // persistDebateRun runs) so F3.3 export carries both heuristic
    // and ensemble decisions side-by-side. NEVER throws.
    let shadowSnapshot: ShadowEnsembleSnapshot | null = null;
    void runEnsembleInShadow(
      buildEnsembleRequest(
        'debate',
        'moderator-selection',
        {
          requestId,
          participantCount: participants.length,
          participants: participants.map((p) => ({
            modelId: p.model.id,
            providerId: p.model.provider,
            quality: p.model.performance?.quality ?? null,
          })),
          taskType: context.taskType,
          complexity: context.triage?.complexity ?? null,
          plannedRounds: debatePlan.numDebateRounds,
        },
      ),
      {
        heuristicDecisionForComparison: {
          role: 'moderator',
          scheduler: moderatorScheduler,
          reason: moderatorReason,
        },
        onShadowResult: (snapshot) => {
          shadowSnapshot = snapshot;
        },
      },
    ).catch((err: unknown) => {
      // Defensive — runEnsembleInShadow already swallows errors, this
      // catch is a final safety net so an unhandled rejection can never
      // bubble to the strategy.
      log.debug({ err: String(err) }, 'shadow runner promise rejected silently');
    });

    const allExecutions: ModelExecution[] = [];
    const debateRounds: DebateRound[] = [];
    let totalCost = 0;

    // Observer: emit phase start
    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: participants.map(p => p.name),
      summary: `Debate started with ${debaters.length} debaters and 1 moderator. ${debatePlan.numDebateRounds} rounds planned.`,
    });

    // 2. Opening statements - each debater presents initial position
    const openingRound = await this.conductOpeningRound(
      request,
      debaters,
      context,
      requestId
    );

    debateRounds.push(openingRound.round);
    allExecutions.push(...openingRound.executions);
    totalCost += openingRound.executions.reduce((sum, e) => sum + e.cost, 0);

    // Observer: emit round complete for opening
    this.emitObserverEvent(context, {
      type: 'round_complete',
      round: 0,
      totalRounds: debatePlan.numDebateRounds,
      summary: `Opening statements from ${openingRound.round.positions.length} debaters received.`,
    });

    // 3. Debate rounds - each debater responds to others
    // C3 P0.2: Skip debate rounds when ablated — opening + synthesis only
    const numDebateRounds = context.ablationFlags?.disabled?.has('debate-rounds')
      ? 0
      : debatePlan.numDebateRounds;

    for (let roundNum = 1; roundNum <= numDebateRounds; roundNum++) {
      const debateRound = await this.conductDebateRound(
        request,
        debaters,
        debateRounds,
        roundNum,
        context,
        requestId
      );

      debateRounds.push(debateRound.round);
      allExecutions.push(...debateRound.executions);
      totalCost += debateRound.executions.reduce((sum, e) => sum + e.cost, 0);

      // Observer: emit round complete
      this.emitObserverEvent(context, {
        type: 'round_complete',
        round: roundNum,
        totalRounds: numDebateRounds,
        summary: `Round ${roundNum}/${numDebateRounds} complete. ${debateRound.round.positions.length} responses.`,
      });
    }

    // Observer: synthesis start
    this.emitObserverEvent(context, {
      type: 'synthesis_start',
      modelId: moderator.model.id,
      modelName: moderator.name,
      summary: `Moderator synthesizing ${debateRounds.length} rounds of debate.`,
    });

    // 4. Moderator synthesis - summarize debate and select best answer
    // Pass allExecutions so moderator can see reasoning traces (if enabled)
    const synthesis = await this.moderatorSynthesis(
      request,
      moderator,
      debateRounds,
      context,
      requestId,
      allExecutions,
    );

    // Observer: synthesis complete
    this.emitObserverEvent(context, {
      type: 'synthesis_complete',
      summary: `Moderator synthesis complete. Final answer produced from ${allExecutions.length} total model calls.`,
    });

    allExecutions.push(synthesis.execution);
    totalCost += synthesis.execution.cost;

    const totalDuration = Date.now() - startTime;

    // Arrow theorem mitigation: log if moderator may have overridden majority
    // The moderator is a single-point aggregator (potential "dictator" per Arrow's theorem)
    // We can't fully prevent this without multi-synthesizer, but we can detect and log it
    if (debateRounds.length > 0) {
      const lastRound = debateRounds[debateRounds.length - 1];
      const positionCount = lastRound.positions?.length ?? 0;
      log.info(
        {
          requestId,
          moderator: moderator.model.id,
          debaterCount: participants.length - 1,
          roundCount: debateRounds.length,
          finalPositions: positionCount,
          arrowWarning: 'Single moderator synthesizes — see blind-debate strategy for independent parallel alternative',
        },
        'Debate: moderator synthesis complete (Arrow single-aggregator pattern)'
      );
    }

    log.info(
      {
        requestId,
        totalRounds: debateRounds.length,
        totalCost,
        totalDuration,
      },
      'Debate strategy completed'
    );

    // F4.1 audit-flow extension — persist when CI_COORDINATION_PERSIST_AUDIT
    // is on. Best-effort: any failure is logged inside persistDebateRun
    // and returns null without blocking the orchestration response.
    if (process.env.CI_COORDINATION_PERSIST_AUDIT === 'true' && context.organizationId) {
      try {
        const totalTokens = allExecutions.reduce(
          (sum, e) =>
            sum + (e.response?.usage?.prompt_tokens ?? 0) + (e.response?.usage?.completion_tokens ?? 0),
          0,
        );
        const participatingModels = participants.map((p) => ({
          modelId: p.model.id,
          modelName: p.name,
          providerId: p.model.provider,
        }));
        const nameToParticipant = new Map(participants.map((p) => [p.name, p]));

        const flatSignals: DebateSignalInput[] = [];
        for (const round of debateRounds) {
          for (const pos of round.positions) {
            const participant = nameToParticipant.get(pos.participant);
            if (!participant) continue; // defensive — shouldn't happen
            const exec = allExecutions.find(
              (e) => e.modelId === participant.model.id && e.role !== 'moderator',
            );
            flatSignals.push({
              round: round.roundNumber + 1, // 1-indexed
              agentName: participant.name,
              modelId: participant.model.id,
              providerId: participant.model.provider,
              role: 'debater',
              decisionType: round.roundNumber === 0 ? 'opening' : 'response',
              text: pos.position,
              respondingTo: pos.respondingTo,
              durationMs: Math.round(round.durationMs / Math.max(1, round.positions.length)),
              cost: exec?.cost ?? 0,
              inputTokens: exec?.response?.usage?.prompt_tokens ?? 0,
              outputTokens: exec?.response?.usage?.completion_tokens ?? 0,
            });
          }
        }
        // Synthesis signal (one final entry from the moderator)
        flatSignals.push({
          round: debateRounds.length + 1,
          agentName: moderator.name,
          modelId: moderator.model.id,
          providerId: moderator.model.provider,
          role: 'moderator',
          decisionType: 'synthesis',
          text: typeof synthesis.execution.response?.choices?.[0]?.message?.content === 'string'
            ? synthesis.execution.response.choices[0].message.content
            : '',
          durationMs: synthesis.execution.durationMs ?? 0,
          cost: synthesis.execution.cost ?? 0,
          inputTokens: synthesis.execution.response?.usage?.prompt_tokens ?? 0,
          outputTokens: synthesis.execution.response?.usage?.completion_tokens ?? 0,
          // F4.1 audit fields embedded on the synthesis signal so trainers
          // can stratify by signal directly without joining to the run.
          schedulerName: moderatorScheduler,
          decisionReason: moderatorReason,
          // Phase 2c — non-null when the shadow ensemble call landed
          // before persist; null otherwise. Reading shadowSnapshot here
          // is a closure read (no await) so persistence is never
          // delayed waiting on shadow latency.
          shadowEnsemble: shadowSnapshot,
        });

        // C3 dev fix (2026-06-09): audit persistence off the hot path (fire-and-forget). It is
        // already env-gated + best-effort and never read back on the request path; awaiting it
        // blocked the response while writing to a possibly-contended pool.
        void persistDebateRun({
          organizationId: context.organizationId,
          requestId: context.requestId,
          runId: requestId,
          config: {
            maxParticipants: debatePlan.maxParticipants,
            numDebateRounds: debatePlan.numDebateRounds,
          },
          moderatorScheduler,
          moderatorReason,
          stopReason: 'completed',
          totalCostUsd: totalCost,
          totalLatencyMs: totalDuration,
          totalTokens,
          participatingModels,
          signals: flatSignals,
        }).catch(() => { /* audit persistence is non-critical and off the hot path */ });
      } catch (err) {
        log.warn(
          { requestId, error: err instanceof Error ? err.message : String(err) },
          'Debate persistence threw — continuing',
        );
      }
    }

    // Collect reasoning traces for metadata (if enabled)
    const reasoningTraces = this.isReasoningEnabled(request)
      ? allExecutions
          .filter(e => e.reasoning)
          .map(e => ({
            model_id: e.modelId,
            model_name: e.modelName,
            role: e.role,
            reasoning: e.reasoning,
            reasoning_tokens: e.reasoningTokens,
          }))
      : undefined;

    return {
      finalResponse: synthesis.execution.response,
      strategyUsed: 'debate',
      modelsUsed: allExecutions,
      totalCost,
      totalDuration,
      metadata: {
        debate: {
          moderator: moderator.name,
          debaters: debaters.map((d) => d.name),
          rounds: debateRounds.length,
          plan: debatePlan,
          debateHistory: debateRounds.map((r) => ({
            round: r.roundNumber,
            positions: r.positions.length,
          })),
        },
        ...(reasoningTraces?.length ? { reasoning_traces: reasoningTraces } : {}),
      },
    };
  }

  supportsStreaming(): boolean {
    return true;
  }

  /**
   * Hybrid streaming execution for debate:
   *   Phase 1 — run debate rounds (non-stream, parallel where possible) + yield progress chunks
   *   Phase 2 — stream moderator synthesis token-by-token
   */
  async *executeStream(
    request: ChatRequest,
    context: OrchestrationContext
  ): AsyncGenerator<ChatResponse, void, unknown> {
    const debatePlan = this.buildDebatePlan(request, context);
    const participants = await this.selectParticipants(context, debatePlan.maxParticipants);

    if (participants.length < 3) {
      throw new Error('Debate strategy requires at least 3 models');
    }

    const { moderator, debaters } = this.assignModeratorRole(participants, context);

    const numRounds = debatePlan.numDebateRounds;
    const totalSteps = numRounds + 2; // opening + rounds + synthesis
    const requestId = nanoid();

    // Phase start + observer
    this.emitObserverEvent(context, { type: 'phase_start', models: participants.map(p => p.name), summary: `Debate with ${debaters.length} debaters, ${numRounds} rounds planned.` });
    yield this.progressChunk(`Debate started with ${participants.length} models`, 0, totalSteps);
    for (const c of await this.drainObserverChunks(context)) yield c;

    const debateRounds: DebateRound[] = [];

    // Opening round — stream observer narration DURING the round (it runs ~25s;
    // drainWhile delivers the phase_start narration the moment it's ready instead
    // of after the whole round, killing the ~27s of client silence).
    const openingRound = yield* this.drainWhile(
      context,
      this.conductOpeningRound(request, debaters, context, requestId),
    );
    debateRounds.push(openingRound.round);
    this.emitObserverEvent(context, { type: 'round_complete', round: 0, totalRounds: numRounds, summary: `Opening: ${openingRound.round.positions.length} positions.` });
    yield this.progressChunk(`Opening statements from ${debaters.length} models`, 1, totalSteps);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Debate rounds
    for (let r = 1; r <= numRounds; r++) {
      // Stream narration DURING each debate round too (same rationale as above).
      const round = yield* this.drainWhile(
        context,
        this.conductDebateRound(request, debaters, debateRounds, r, context, requestId),
      );
      debateRounds.push(round.round);
      this.emitObserverEvent(context, { type: 'round_complete', round: r, totalRounds: numRounds, summary: `Round ${r}/${numRounds}: ${round.round.positions.length} responses.` });
      yield this.progressChunk(`Round ${r}/${numRounds} complete`, r + 1, totalSteps);
      for (const c of await this.drainObserverChunks(context)) yield c;
    }

    // Synthesis
    this.emitObserverEvent(context, { type: 'synthesis_start', modelName: moderator.name, summary: 'Moderator synthesizing debate.' });
    yield this.progressChunk('Synthesizing final answer...', numRounds + 1, totalSteps);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Phase 2: stream moderator synthesis token-by-token — RESILIENT. If the
    // moderator's provider fails before producing output (the runtime provider
    // cascade: 401/402/403/404), fall back to the other debaters as synthesizer;
    // if all fail, degrade to the strongest debate position rather than killing
    // the whole collective stream ("Collective strategy stream failed").
    const synthesisRequest = this.buildSynthesisRequest(request, moderator, debateRounds);
    const synthesizers = [
      { adapter: moderator.adapter, model: moderator.model },
      ...debaters
        .filter((d) => d.name !== moderator.name)
        .map((d) => ({ adapter: d.adapter, model: d.model })),
    ];
    yield* this.streamSynthesisWithFallback(
      synthesisRequest,
      synthesizers,
      () => this.buildDegradedSynthesis(debateRounds),
    );

    // Final observer drain
    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: 'Debate synthesis complete.' });
    for (const c of await this.drainObserverChunks(context)) yield c;
  }

  /**
   * Build the synthesis request for the moderator (shared by execute and executeStream)
   */
  private buildSynthesisRequest(
    request: ChatRequest,
    moderator: DebateParticipant,
    debateRounds: DebateRound[],
    allExecutions?: ModelExecution[],
  ): ChatRequest {
    const debateHistory = this.buildDebateHistory(debateRounds);

    // If reasoning is enabled, include reasoning traces so the moderator
    // can see HOW each debater arrived at their position — not just WHAT they said
    const reasoningTraces = allExecutions && this.isReasoningEnabled(request)
      ? this.formatReasoningForSynthesizer(allExecutions)
      : '';

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: PROMPTS.debateModerator(moderator.name),
      },
      ...(request.messages || []),
      {
        role: 'assistant',
        content: `Complete Debate History:\n${debateHistory}${reasoningTraces}`,
      },
      {
        role: 'user',
        content:
          'As the moderator, synthesize this debate into a final, comprehensive answer that represents the best of all arguments presented.',
      },
    ];

    // Cap the final synthesis length (honors an explicit client max_tokens; else a
    // sane default) so an open-ended question doesn't yield a 10-13k-char answer
    // that dominates wall-clock. Covers the non-streaming path; the streaming path
    // is capped inside streamSynthesisWithFallback.
    return this.capSynthesisRequest({ ...request, model: moderator.model.id, messages });
  }

  /**
   * Build a degraded synthesis answer from the debate positions — used only when
   * EVERY synthesizer provider is unavailable. Returns the most substantive
   * position so the client still gets a real answer instead of a hard error.
   */
  private buildDegradedSynthesis(debateRounds: DebateRound[]): string {
    const latest = debateRounds[debateRounds.length - 1]?.positions ?? [];
    const source = latest.length > 0 ? latest : debateRounds.flatMap((r) => r.positions);
    const pool = source
      .map((p) => p.position)
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    if (pool.length === 0) {
      return 'The debate could not be synthesized: all model providers were unavailable for this request.';
    }
    // Prefer the longest (most substantive) position.
    return pool.reduce((best, p) => (p.length > best.length ? p : best), pool[0]);
  }

  /**
   * Assign moderator + debater roles. Caminho-C Q2 cross-strategy honor
   * (2026-04-29): if the user pinned a model via `request.model` AND it's
   * among the selected participants, that participant becomes the
   * MODERATOR (the highest-status synthesis role) — even if quality
   * ranking would have picked someone else. The user's intent shapes
   * the most visible voice in the debate output. If the pin is absent
   * from the participant set (filtered out, didn't survive selection),
   * we log an info and fall back to the legacy quality-sort moderator
   * pick so the debate still has a synthesizer.
   */
  /**
   * Structured moderator-selection decision (F4.1 audit substrate).
   *
   * Shape mirrors `RoleDecision` from tri-role-collective: the chosen
   * outcome plus the `reason` that fired and the `scheduler` identity
   * that produced the decision. The current implementation is
   * `'pin-or-quality'` (deterministic heuristic). When a future F4.1
   * coordinator replaces the heuristic with a learned policy, it emits
   * its own `scheduler` tag and the rest of the pipeline (audit
   * trail, F3.3 export, training stratification) is already wired.
   */
  private assignModeratorRole(
    participants: DebateParticipant[],
    context: OrchestrationContext,
  ): {
    moderator: DebateParticipant;
    debaters: DebateParticipant[];
    reason: 'pinned' | 'pin-not-in-pool-quality-fallback' | 'quality-fallback';
    scheduler: 'pin-or-quality';
  } {
    // Resolve pin against the participant model pool (NOT context.models —
    // the participants are already filtered to those that passed
    // capability/health/balance gates AND have an adapter wired).
    const participantModels = participants.map((p) => p.model);
    const preference = resolvePreferredExecutor(participantModels, context, []);

    let moderator: DebateParticipant | undefined;
    let reason: 'pinned' | 'pin-not-in-pool-quality-fallback' | 'quality-fallback' = 'quality-fallback';

    if (preference.pinReason === 'pinned' && preference.pinnedExecutor) {
      moderator = participants.find((p) => p.model.id === preference.pinnedExecutor!.id);
      if (moderator) {
        reason = 'pinned';
        log.info(
          {
            requestId: context.requestId,
            requestedModel: preference.requestedId,
            participantCount: participants.length,
            reason,
            scheduler: 'pin-or-quality',
          },
          'Debate strategy: requested model assigned as moderator',
        );
      }
    } else if (preference.pinReason === 'pin-not-in-pool') {
      reason = 'pin-not-in-pool-quality-fallback';
      log.warn(
        {
          requestId: context.requestId,
          requestedModel: preference.requestedId,
          participantCount: participants.length,
          reason,
          scheduler: 'pin-or-quality',
        },
        'Debate strategy: requested model not among debate participants — moderator picked by quality',
      );
    }

    // Fallback: highest-quality participant becomes moderator.
    if (!moderator) {
      moderator = [...participants].sort(
        (a, b) => (b.model.performance?.quality || 0) - (a.model.performance?.quality || 0)
      )[0];
    }

    moderator.role = 'moderator';
    const debaters = participants.filter((p) => p !== moderator);
    return { moderator, debaters, reason, scheduler: 'pin-or-quality' };
  }

  /**
   * Select diverse debate participants
   */
  private async selectParticipants(
    context: OrchestrationContext,
    maxParticipants: number = 5
  ): Promise<DebateParticipant[]> {
    // Filter models by capabilities, quality, budget — no audio/image/embedding models
    let availableModels = this.getEligibleModels(context);

    // If no models in context, select dynamically
    if (!availableModels || availableModels.length < 3) {
      const selected = await this.modelSelector.selectModels(
        null,
        {
          taskType: context.taskType,
          complexity: context.triage?.complexity || 'high',
          contextSize: context.contextSize || 4000,
          qualityTarget: context.qualityTarget || 0.9,
        },
        context,
        maxParticipants
      );

      availableModels = selected.map((s) => s.model);
    }

    // Create participants with adapters
    const participants: DebateParticipant[] = [];

    for (const model of availableModels.slice(0, maxParticipants)) {
      const adapter = await this.getModelAdapter(model, context);
      if (adapter) {
        participants.push({
          model,
          adapter,
          role: 'debater',
          name: model.displayName || model.name,
          positions: [],
        });
      }
    }

    return participants;
  }

  private buildDebatePlan(
    request: ChatRequest,
    context: OrchestrationContext
  ): { maxParticipants: number; numDebateRounds: number } {
    const maxTokens =
      typeof request.max_tokens === 'number' ? request.max_tokens : 512;
    const promptChars = (request.messages || []).reduce((total, message) => {
      if (typeof message.content === 'string') {
        return total + message.content.length;
      }
      if (Array.isArray(message.content)) {
        return (
          total +
          message.content.reduce((inner, item) => {
            if (item.type === 'text') {
              return inner + item.text.length;
            }
            return inner;
          }, 0)
        );
      }
      return total;
    }, 0);

    const lowComplexity = context.triage?.complexity === 'low';
    const highComplexity = context.triage?.complexity === 'high';
    const shortPrompt = promptChars <= 220;
    const mediumPrompt = promptChars <= 1200;
    const latencySensitive =
      context.preferSpeed || maxTokens <= 320 || mediumPrompt || (shortPrompt && lowComplexity);
    const highQualityTarget =
      typeof context.qualityTarget === 'number' && context.qualityTarget >= 0.95;

    const deepDebate = highQualityTarget && highComplexity && maxTokens > 320 && !latencySensitive;
    const maxParticipants = deepDebate ? 5 : highComplexity && !latencySensitive ? 4 : 3;
    const numDebateRounds = deepDebate ? 3 : highComplexity && !latencySensitive ? 2 : 1;

    return {
      maxParticipants: Math.max(3, Math.min(5, maxParticipants)),
      numDebateRounds: Math.max(1, Math.min(3, numDebateRounds)),
    };
  }

  /**
   * Get adapter for a model
   */
  private async getModelAdapter(
    model: Model,
    context: OrchestrationContext
  ): Promise<ProviderAdapter | null> {
    if (this.getAdapterForModel) {
      return this.getAdapterForModel(model, context);
    }

    // Fallback to provider registry
    const { getProviderRegistry } = await import('@/providers/provider-registry.js');
    const registry = getProviderRegistry();
    const result = await registry.findModel(model.id);
    return result?.adapter || null;
  }

  /**
   * Conduct opening round - each debater presents initial position
   */
  private async conductOpeningRound(
    request: ChatRequest,
    debaters: DebateParticipant[],
    context: OrchestrationContext,
    requestId: string
  ): Promise<{
    round: DebateRound;
    executions: ModelExecution[];
  }> {
    const startTime = Date.now();
    const positions: DebateRound['positions'] = [];
    const executions: ModelExecution[] = [];

    log.debug({ requestId, debaterCount: debaters.length }, 'Conducting opening round');

    // Emit a per-debater "now presenting" event UP FRONT so the observer has
    // continuous content to narrate DURING this ~25s round. The local narrator
    // processes these sequentially (~7s each), so drainWhile() streams them spread
    // across the round instead of the client sitting in silence until it ends.
    debaters.forEach((debater, i) => {
      this.emitObserverEvent(context, {
        type: 'model_response',
        round: 0,
        modelName: debater.name,
        summary: `Analyst ${i + 1} of ${debaters.length} is forming their opening position.`,
      });
    });

    // Execute in parallel for speed
    const reasoningEnabled = this.isReasoningEnabled(request);
    const openingPromises = debaters.map(async (debater) => {
      const systemPrompt = this.withReasoningPrompt(
        PROMPTS.debateOpening(debater.name),
        request,
        debater.model,
      );
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: systemPrompt,
        },
        ...(request.messages || []),
        {
          role: 'user',
          content: 'Present your initial position on this topic.',
        },
      ];

      const openingRequest = { ...request, messages };
      const execution = await this.boundModelExecution(
        () =>
          reasoningEnabled
            ? this.executeModelWithReasoning(debater.adapter, debater.model, openingRequest, 'primary')
            : this.executeModel(debater.adapter, debater.model, openingRequest, 'primary'),
        { adapter: debater.adapter, model: debater.model, request: openingRequest, role: 'primary' },
      );

      if (execution.success) {
        const position = this.extractContent(execution.response);
        debater.positions.push(position);

        return {
          participant: debater.name,
          position,
          execution,
        };
      }

      return null;
    });

    const results = await Promise.all(openingPromises);

    for (const result of results) {
      if (result) {
        positions.push({
          participant: result.participant,
          position: result.position,
        });
        executions.push(result.execution);
      }
    }

    return {
      round: {
        roundNumber: 0,
        positions,
        durationMs: Date.now() - startTime,
      },
      executions,
    };
  }

  /**
   * Conduct debate round - debaters respond to each other
   */
  private async conductDebateRound(
    request: ChatRequest,
    debaters: DebateParticipant[],
    previousRounds: DebateRound[],
    roundNumber: number,
    context: OrchestrationContext,
    requestId: string
  ): Promise<{
    round: DebateRound;
    executions: ModelExecution[];
  }> {
    const startTime = Date.now();
    const positions: DebateRound['positions'] = [];
    const executions: ModelExecution[] = [];

    log.debug({ requestId, roundNumber }, 'Conducting debate round');

    // Build debate history
    const debateHistory = this.buildDebateHistory(previousRounds);

    // C3 dev fix (2026-06-09): run all debaters in this round IN PARALLEL. `respondingTo` is derived
    // from PREVIOUS rounds (previousRounds), NOT the current round, so within-round debaters do not
    // depend on each other — they were serializing on each other's HTTP calls for no reason (e.g. 2
    // rounds × 3 debaters = 6 serial model calls → 2 parallel waves, ~8-20s saved on long-form).
    // Order of positions/executions is preserved by mapping first, then appending in debater order.
    const reasoningEnabled = this.isReasoningEnabled(request);
    const roundResults = await Promise.all(
      debaters.map(async (debater) => {
        const otherPositions = previousRounds
          .flatMap((r) => r.positions)
          .filter((p) => p.participant !== debater.name);
        const respondingTo =
          otherPositions.length > 0 ? otherPositions[otherPositions.length - 1] : null;
        const roundSystemPrompt = this.withReasoningPrompt(
          PROMPTS.debateRound(debater.name, roundNumber),
          request,
          debater.model,
        );
        const messages: ChatMessage[] = [
          { role: 'system', content: roundSystemPrompt },
          ...(request.messages || []),
          { role: 'assistant', content: `Debate History:\n${debateHistory}` },
          {
            role: 'user',
            content: respondingTo
              ? `Respond to ${respondingTo.participant}'s argument: "${respondingTo.position.substring(0, Number(process.env.DEBATE_REBUTTAL_EXCERPT_CHARS) || 2000)}..."`
              : 'Continue the debate with your refined position.',
          },
        ];
        // C3 dev fix (2026-06-09): cap each debater turn (default 900 tok, env override). Debate turns
        // are arguments the moderator synthesizes — they don't each need a full long-form answer, and
        // unbounded turns dominate wall-clock. Honors a smaller user-set max_tokens.
        const debateCap = Number(process.env.DEBATE_TURN_MAX_TOKENS) || 900;
        const debaterReq = { ...request, messages, max_tokens: Math.min(Number(request.max_tokens) || debateCap, debateCap) };
        const execution = await this.boundModelExecution(
          () =>
            reasoningEnabled
              ? this.executeModelWithReasoning(debater.adapter, debater.model, debaterReq, 'primary')
              : this.executeModel(debater.adapter, debater.model, debaterReq, 'primary'),
          { adapter: debater.adapter, model: debater.model, request: debaterReq, role: 'primary' },
        );
        return { debater, execution, respondingTo };
      }),
    );
    for (const { debater, execution, respondingTo } of roundResults) {
      if (execution.success) {
        const position = this.extractContent(execution.response);
        debater.positions.push(position);
        positions.push({
          participant: debater.name,
          position,
          respondingTo: respondingTo?.participant,
        });
        executions.push(execution);
      }
    }

    return {
      round: {
        roundNumber,
        positions,
        durationMs: Date.now() - startTime,
      },
      executions,
    };
  }

  /**
   * Moderator synthesizes debate and produces final answer
   */
  private async moderatorSynthesis(
    request: ChatRequest,
    moderator: DebateParticipant,
    debateRounds: DebateRound[],
    context: OrchestrationContext,
    requestId: string,
    allExecutions?: ModelExecution[],
  ): Promise<{
    execution: ModelExecution;
    consensus: string;
  }> {
    log.debug({ requestId, moderator: moderator.name }, 'Moderator synthesizing debate');

    const synthesisRequest = this.buildSynthesisRequest(request, moderator, debateRounds, allExecutions);

    const execution = await this.executeModel(moderator.adapter, moderator.model, synthesisRequest, 'coordinator');

    const consensus = execution.success ? this.extractContent(execution.response) : '[DEGRADED] Moderator synthesis failed';

    return {
      execution,
      consensus,
    };
  }

  /**
   * Build formatted debate history
   */
  private buildDebateHistory(rounds: DebateRound[]): string {
    const parts: string[] = [];

    for (const round of rounds) {
      parts.push(`\n=== ${round.roundNumber === 0 ? 'Opening Statements' : `Round ${round.roundNumber}`} ===\n`);

      for (const position of round.positions) {
        const responding = position.respondingTo
          ? ` (responding to ${position.respondingTo})`
          : '';
        parts.push(`**${position.participant}**${responding}:\n${position.position}\n`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Extract text content from response
   */
  private extractContent(response: ChatResponse | null | undefined): string {
    return safeResponseContent(response);
  }
}

