// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Sensitivity Consensus Strategy
 *
 * Iterative coordination strategy where models declare decisions + conditions
 * for change, the system aggregates into collective state, and models revise
 * based on state until convergence or budget exhaustion.
 *
 * This is NOT a replacement for consensus/debate/collaborative — it's an
 * optional strategy that adds sensitivity-based coordination to the CI stack.
 *
 * Feature-flagged: disabled by default (CI_SENSITIVITY_CONSENSUS_ENABLED).
 * Falls back to consensus strategy on failure.
 */

import { BaseStrategy, safeResponseContent, type StrategyMetadata } from '../base-strategy';
import { narrowAs } from '@/utils/type-guards';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
} from '@/types';
// `getResponseAggregator`/`ModelResponse` reserved for future synthesis hand-off — removed unused imports.
// `DEFAULT_COORDINATION_CONFIG` is consumed indirectly via getCoordinationConfigFromEnv.
import { resolvePreferredExecutor, withPreferredFirst } from './preferred-model-helper';
import {
  type CoordinationSignal,
  type CoordinationState,
  type CoordinationResult,
  type CoordinationLimits,
  type CoordinationConfig,
} from '@/core/coordination/coordination-types';
import { getCollectiveConfigForOrg } from '@/core/coordination/collective-feature-flags';
import {
  createInitialState,
  aggregateSignals,
} from '@/core/coordination/sensitivity-aggregator';
import {
  createInitialPerAgentStates,
  aggregatePerAgent,
  synthesizeSharedStateFromPerAgent,
  type PerAgentStateMap,
} from '@/core/coordination/per-agent-state';
import { createTopology, type CollectiveTopology } from '@/core/coordination/collective-topology';
import { CollectiveTrace, tracedSpan } from '@/core/coordination/collective-trace';
import {
  buildCoordinationSystemPrompt,
  buildCoordinationUserMessage,
  parseSignalResponse,
} from '@/core/coordination/sensitivity-prompt-adapter';
import {
  recordCoordinationRun,
  recordSignalParseFailure,
  recordCollectiveTrace,
  coordinationFallbackUsed,
  coordinationRoundDurationMs,
} from '@/core/coordination/coordination-metrics';
import { evaluateConvergence } from '@/core/coordination/convergence-evaluator';
import { estimateRoundCost } from '@/core/coordination/collective-cost-guardrail';
import {
  selectCoordinatorModel,
  synthesizeViaCoordinator,
} from '@/core/coordination/collective-synthesis-aggregator';
import { persistCollectiveRun } from '@/core/coordination/collective-run-repository';
import { nanoid } from 'nanoid';

// Strategies inherit `this.log` from BaseStrategy — no module-level logger needed.

export class SensitivityConsensusStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'sensitivity-consensus',
      name: 'sensitivity-consensus',
      displayName: 'Sensitivity Consensus',
      description:
        'Iterative coordination: models declare decisions + sensitivities, ' +
        'system aggregates into collective state, models revise until convergence.',
      minModels: 3,
      maxModels: 5,
      estimatedCostMultiplier: 4.0,
      estimatedQualityBoost: 0.35,
      estimatedDurationMultiplier: 2.5,
      suitableFor: ['analysis', 'code-review', 'architecture', 'decision-making', 'reasoning'],
    };
  }

  async execute(
    request: ChatRequest,
    context: OrchestrationContext,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const metadata = this.getMetadata();
    // F1.7 — per-tenant feature flag. Reads env defaults + overlays
    // overrides from `Organization.settings.collectiveConfig` (cached
    // 60s, falls back to env on any DB error). Operators can flip
    // `entropySeedEnabled`, `aggregationMethod`, `enabled`, etc. per
    // organization without redeploying.
    const config = await getCollectiveConfigForOrg(context.organizationId);

    const models = this.getEligibleModels(context);

    this.log.info(
      {
        strategy: metadata.name,
        requestId: context.requestId,
        taskType: context.taskType,
        eligibleModels: models.length,
        totalModels: context.models.length,
        configEnabled: config.enabled,
      },
      'Executing Sensitivity Consensus strategy',
    );

    if (models.length < metadata.minModels) {
      this.log.warn(
        {
          eligible: models.length,
          required: metadata.minModels,
          total: context.models.length,
        },
        'Insufficient eligible models for sensitivity-consensus — falling back to consensus',
      );
      return this.executeFallback(request, context);
    }

    // Explicit request honors the engine's no-silent-downgrade contract
    // (2026-07-04, c3-v4 defect B): a caller that names this strategy gets the
    // coordination loop even with the auto-selection flag off — in the v4 run
    // the arm silently fell back and never executed sensitivity-consensus at
    // all (judge 0.19 vs 0.67 for plain consensus on the same tasks). The
    // flag keeps gating triage/auto selection unchanged.
    const explicitlyRequested = request.strategy === 'sensitivity-consensus';
    if (!config.enabled && !explicitlyRequested) {
      this.log.info(
        { requestId: context.requestId },
        'Sensitivity consensus disabled via feature flag — falling back to consensus',
      );
      coordinationFallbackUsed.inc(
        { strategy: 'sensitivity-consensus', fallback_to: 'consensus' },
      );
      return this.executeFallback(request, context);
    }

    const numModels = Math.min(
      config.maxModelsPerRound,
      Math.max(config.minModelsPerRound, models.length),
    );
    const selectedModels = await this.selectDiverseModels(models, numModels, context);

    this.log.debug(
      {
        selectedModels: selectedModels.map(m => m.name),
        numModels: selectedModels.length,
      },
      'Models selected for sensitivity-consensus',
    );

    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: selectedModels.map(m => m.name),
      summary: `Sensitivity consensus starting with ${selectedModels.length} participants.`,
    });

    const runId = `coord-${nanoid(12)}`;
    const limits: CoordinationLimits = {
      maxRounds: config.maxRounds,
      maxCostUsd: config.maxCostUsd,
      maxLatencyMs: config.maxLatencyMs,
      minConvergenceScore: config.minConvergenceScore,
      maxDecisionFlipRate: config.maxDecisionFlipRate,
      maxDissent: config.maxDissent,
      stopOnCriticalRisk: config.stopOnCriticalRisk,
      minValidSignalsPerRound: Math.min(selectedModels.length, 2),
      detectStagnation: true,
    };

    const state = createInitialState(runId, 'sensitivity-consensus', limits);

    // F2.7 — CollectiveTrace per run. Captures structural phases
    // (init / per-round / synthesis / persist) without ever recording
    // chain-of-thought. The trace summary is exported in the result
    // metadata so the GET /v1/collective/runs/:id endpoint and the C3
    // benchmark report can surface it.
    const trace = new CollectiveTrace(runId);
    const initSpan = trace.startSpan('run_init', {
      attributes: {
        runId,
        strategy: 'sensitivity-consensus',
        modelCount: selectedModels.length,
        perAgentMode: config.perAgentStateEnabled,
        topologyKind: config.topologyKind,
        aggregationMethod: config.aggregationMethod,
      },
    });
    trace.endSpan(initSpan);

    try {
      const { result, executions } = await this.runCoordinationLoop(
        request,
        context,
        selectedModels,
        state,
        config,
        trace,
      );

      const totalDuration = Date.now() - startTime;

      this.recordCoordinationMetrics(result, context, totalDuration);

      // F1.5 — Persist run when explicitly enabled (default false). The
      // call is best-effort: a persistence failure logs but never
      // propagates to the response path.
      // F2.10 — When the audit trail is on, also persist the full
      // CollectiveTrace spans so the
      // `GET /v1/collective/runs/:id/trace` endpoint can serve them.
      // Spans are bounded by `CollectiveTrace.maxSpans` (default 256).
      if (config.persistAuditTrail) {
        await tracedSpan(trace, 'persist', async () => {
          await persistCollectiveRun({
            organizationId: context.organizationId,
            requestId: context.requestId,
            state,
            result,
            config,
            traceSpans: trace.getSpans(),
          });
        });
      }

      this.emitObserverEvent(context, {
        type: 'synthesis_complete',
        summary: `Coordination completed after ${result.roundsExecuted} rounds (reason: ${result.stopReason}).`,
      });

      trace.markComplete();
      // F2.11 — Surface trace structure to Prometheus so dashboards
      // can alert on rising abort / error rates without parsing the
      // metadata blob. Defensive: never throws.
      recordCollectiveTrace('sensitivity-consensus', trace.describe());

      return this.buildOrchestrationResult(
        result,
        executions,
        state,
        totalDuration,
        metadata,
        trace,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        {
          runId,
          round: state.round,
          error: errorMessage,
        },
        'Sensitivity consensus failed — falling back to consensus',
      );

      coordinationFallbackUsed.inc(
        { strategy: 'sensitivity-consensus', fallback_to: 'consensus' },
      );

      return this.executeFallback(request, context);
    }
  }

  private async runCoordinationLoop(
    request: ChatRequest,
    context: OrchestrationContext,
    models: Model[],
    initialState: CoordinationState,
    config: CoordinationConfig,
    trace: CollectiveTrace,
  ): Promise<{ result: CoordinationResult; executions: ModelExecution[] }> {
    let state = initialState;
    const allExecutions: ModelExecution[] = [];

    // F2.6 — Per-agent path init. When `config.perAgentStateEnabled`
    // is true, we maintain a local θᵢ per agent in addition to the
    // shared state. The shared state is synthesized from the per-agent
    // map at the end of every round (via coordinate-wise median) so
    // that downstream machinery (`evaluateConvergence`, stop checks,
    // result builder) works unchanged.
    //
    // Cost/latency/tokens are accumulated at the RUN level (one entry
    // per signal) instead of being summed per-agent — under sparse
    // topologies a signal visible to N agents would otherwise inflate
    // the bill N-fold.
    const perAgentMode = config.perAgentStateEnabled === true;
    const agentIds = models.map((m) => `agent-${m.id}`);
    const topology: CollectiveTopology | null = perAgentMode
      ? createTopology({
          kind: config.topologyKind,
          agents: agentIds,
        })
      : null;
    let perAgentStates: PerAgentStateMap | null = perAgentMode
      ? createInitialPerAgentStates(agentIds)
      : null;
    let runTotalCostUsd = 0;
    let runTotalLatencyMs = 0;
    let runTotalTokens = 0;
    const fullHistory: CoordinationSignal[] = [];

    while (state.round < state.limits.maxRounds) {
      const roundStartTime = Date.now();
      const roundNumber = state.round + 1;

      const roundSpanId = trace.startSpan('round_start', {
        attributes: {
          round: roundNumber,
          maxRounds: state.limits.maxRounds,
          perAgentMode,
          topologyKind: perAgentMode ? config.topologyKind : 'shared',
        },
      });

      this.log.debug(
        {
          runId: state.runId,
          round: roundNumber,
          maxRounds: state.limits.maxRounds,
          perAgentMode,
          topologyKind: perAgentMode ? config.topologyKind : 'shared',
        },
        'Starting coordination round',
      );

      // F0.4: Pre-flight cost guardrail. Abort BEFORE issuing this
      // round's API calls when the projected total (already-spent +
      // round estimate × safety-margin) would exceed `limits.maxCostUsd`.
      // The previous post-round check could overshoot by an entire
      // round when 5 expensive models were dispatched in parallel.
      const costEstimate = estimateRoundCost(models, request, state);
      if (costEstimate.exceedsLimit) {
        this.log.warn(
          {
            runId: state.runId,
            round: roundNumber,
            alreadySpentUsd: costEstimate.alreadySpentUsd,
            estimatedRoundCostUsd: costEstimate.estimatedRoundCostUsd,
            projectedTotalUsd: costEstimate.projectedTotalUsd,
            limitUsd: costEstimate.limitUsd,
          },
          'Aborting coordination round — projected cost exceeds budget',
        );
        trace.endSpan(roundSpanId, {
          status: 'cancelled',
          attributes: { stopReason: 'max_cost' },
        });
        return {
          result: this.buildCoordinationResult(
            state,
            models,
            allExecutions,
            'max_cost',
          ),
          executions: allExecutions,
        };
      }

      this.emitObserverEvent(context, {
        type: 'round_complete',
        round: roundNumber,
        totalRounds: state.limits.maxRounds,
        summary: `Round ${roundNumber}: requesting decisions + sensitivities from ${models.length} models.`,
      });

      const collectSpanId = trace.startSpan('collect_signals', {
        parentSpanId: roundSpanId,
        attributes: { round: roundNumber, modelCount: models.length },
      });
      const { signals, executions, parseFailures } = await this.collectSignals(
        request,
        context,
        models,
        state,
        roundNumber,
        config,
      );
      trace.endSpan(collectSpanId, {
        attributes: {
          signalCount: signals.length,
          parseFailures,
        },
      });

      allExecutions.push(...executions);

      if (parseFailures > 0) {
        this.log.warn(
          {
            runId: state.runId,
            round: roundNumber,
            parseFailures,
            totalModels: models.length,
          },
          'Some models returned unparseable signals',
        );
      }

      if (signals.length === 0) {
        this.log.warn(
          { runId: state.runId, round: roundNumber },
          'No valid signals in round — stopping',
        );

        trace.endSpan(roundSpanId, {
          status: 'cancelled',
          attributes: { stopReason: 'insufficient_valid_signals' },
        });
        return {
          result: this.buildCoordinationResult(
            state,
            models,
            allExecutions,
            'insufficient_valid_signals',
          ),
          executions: allExecutions,
        };
      }

      // Run-level cost / latency / tokens — counted ONCE per signal
      // regardless of who saw it.
      for (const sig of signals) {
        runTotalCostUsd += sig.metrics?.estimatedCost ?? 0;
        runTotalTokens += (sig.metrics?.inputTokens ?? 0) + (sig.metrics?.outputTokens ?? 0);
      }
      const maxRoundLatency = signals.reduce(
        (acc, s) => Math.max(acc, s.metrics?.latencyMs ?? 0),
        0,
      );
      runTotalLatencyMs += maxRoundLatency;
      fullHistory.push(...signals);

      // Critical risks accumulate from any signal's sensitivities. The
      // shared-state aggregator does this internally; we mirror it here
      // for the per-agent path so the synthesized state carries the
      // same risks.
      const newRisks: import('@/core/coordination/coordination-types').CoordinationRisk[] = [];
      for (const sig of signals) {
        for (const sens of sig.sensitivities) {
          if (sens.risk === 'critical') {
            newRisks.push({
              type: `critical_sensitivity_${sens.variable}`,
              severity: 'critical',
              description: sens.rationale,
              sourceSignalIds: [sig.id],
            });
          }
        }
      }

      let aggregationResult: import('@/core/coordination/coordination-types').SensitivityAggregationResult;

      const aggregateSpanId = trace.startSpan('aggregate', {
        parentSpanId: roundSpanId,
        attributes: {
          method: config.aggregationMethod,
          mode: perAgentMode ? 'per_agent' : 'shared',
          signalCount: signals.length,
        },
      });

      if (perAgentMode && perAgentStates && topology) {
        // F2.6 — Per-agent path. Each agent updates its own θᵢ from
        // signals visible under the topology. Then we synthesize the
        // shared state via coordinate-wise median so the rest of the
        // loop (convergence evaluation, stop conditions, result
        // building) continues to work unchanged.
        const { nextStates, perAgentResults } = aggregatePerAgent(
          perAgentStates,
          signals,
          topology,
          config.aggregationMethod,
          state.limits,
          'sensitivity-consensus',
          state.runId,
        );
        perAgentStates = nextStates;

        const cumulativeRisks = [...state.risks, ...newRisks];
        state = synthesizeSharedStateFromPerAgent({
          runId: state.runId,
          strategy: 'sensitivity-consensus',
          perAgentStates: nextStates,
          currentRoundSignals: signals,
          fullHistory,
          runTotalCostUsd,
          runTotalLatencyMs,
          runTotalTokens,
          limits: state.limits,
          round: roundNumber,
          cumulativeRisks,
          priorConfidenceTrend: state.convergence.confidenceTrend,
        });

        // Aggregation result for diagnostic logging — derived from the
        // per-agent step. Dominant/conflicting variable lists come from
        // the synthesized state's stable/unstable buckets.
        aggregationResult = {
          nextState: state,
          dominantSignals: state.convergence.stableVariables,
          conflictingSignals: state.convergence.unstableVariables,
          updatedVariables: Object.keys(state.variables),
          recommendedNextRound: state.convergence.score < state.limits.minConvergenceScore,
          risks: newRisks,
        };

        // Log per-agent fan-out at debug level so operators can inspect
        // how each agent's view diverged from the median.
        for (const [agentId, result] of perAgentResults) {
          this.log.debug(
            {
              runId: state.runId,
              round: roundNumber,
              agentId,
              dominant: result.dominantSignals,
              conflicting: result.conflictingSignals,
            },
            'Per-agent aggregation step',
          );
        }
      } else {
        // F1.2: When the operator selected `llm_synthesis`, route the
        // round through the LLM-mediated synthesis path. The numeric
        // aggregator stays in place as a graceful fallback for every
        // failure mode (no coordinator available, executor error,
        // timeout, parse failure, post-call cost over cap).
        aggregationResult =
          config.aggregationMethod === 'llm_synthesis'
            ? await this.runSynthesisAggregation(signals, state, models, context, config)
            : aggregateSignals(signals, state, config.aggregationMethod);

        state = aggregationResult.nextState;
      }

      trace.endSpan(aggregateSpanId, {
        attributes: {
          dominantCount: aggregationResult.dominantSignals.length,
          conflictingCount: aggregationResult.conflictingSignals.length,
        },
      });

      const convergenceSpanId = trace.startSpan('convergence_evaluate', {
        parentSpanId: roundSpanId,
      });
      const evaluation = evaluateConvergence(state);
      trace.endSpan(convergenceSpanId, {
        attributes: {
          convergenceScore: evaluation.convergenceScore,
          herdingDetected: evaluation.herdingDetected,
          poisoningDetected: evaluation.sensitivityPoisoningDetected,
          shouldStop: evaluation.shouldStop,
          stopReason: evaluation.stopReason ?? 'continuing',
        },
      });

      coordinationRoundDurationMs.observe(
        { strategy: 'sensitivity-consensus', round: String(roundNumber) },
        Date.now() - roundStartTime,
      );

      this.log.info(
        {
          runId: state.runId,
          round: roundNumber,
          convergenceScore: evaluation.convergenceScore.toFixed(3),
          dominantVariables: aggregationResult.dominantSignals,
          conflictingVariables: aggregationResult.conflictingSignals,
          shouldStop: evaluation.shouldStop,
          stopReason: evaluation.stopReason,
          herdingDetected: evaluation.herdingDetected,
          poisoningDetected: evaluation.sensitivityPoisoningDetected,
        },
        'Coordination round completed',
      );

      if (evaluation.shouldStop && evaluation.stopReason) {
        trace.endSpan(roundSpanId, {
          attributes: { stopReason: evaluation.stopReason, terminating: true },
        });
        return {
          result: this.buildCoordinationResult(
            state,
            models,
            allExecutions,
            evaluation.stopReason,
          ),
          executions: allExecutions,
        };
      }

      trace.endSpan(roundSpanId, {
        attributes: { stopReason: 'continuing' },
      });
    }

    return {
      result: this.buildCoordinationResult(
        state,
        models,
        allExecutions,
        'max_rounds',
      ),
      executions: allExecutions,
    };
  }

  /**
   * F1.2 — LLM-mediated synthesis aggregation. Resolves a coordinator
   * model from the eligible pool (excluding round participants), wraps
   * `executeModel` in a `CoordinatorExecutor` callback, and delegates
   * to `synthesizeViaCoordinator`.
   *
   * Every failure path inside the synthesis aggregator is silent and
   * falls back to `weighted_confidence`. Failures BEFORE the synthesis
   * call (no coordinator, no adapter, no `getAdapterForModel`) are
   * handled here with the same semantics: log + numeric fallback.
   */
  private async runSynthesisAggregation(
    signals: CoordinationSignal[],
    state: CoordinationState,
    participants: Model[],
    context: OrchestrationContext,
    config: CoordinationConfig,
  ): Promise<ReturnType<typeof aggregateSignals>> {
    const eligible = this.getEligibleModels(context);
    const coordinator = selectCoordinatorModel(participants, eligible);

    if (!coordinator) {
      this.log.warn(
        { runId: state.runId, eligibleCount: eligible.length, participantCount: participants.length },
        'Synthesis: no eligible non-participant coordinator — using weighted_confidence',
      );
      return aggregateSignals(signals, state, 'weighted_confidence');
    }

    if (!this.getAdapterForModel) {
      this.log.warn(
        { runId: state.runId },
        'Synthesis: getAdapterForModel not injected — using weighted_confidence',
      );
      return aggregateSignals(signals, state, 'weighted_confidence');
    }

    const adapter = await this.getAdapterForModel(coordinator, context);
    if (!adapter) {
      this.log.warn(
        { runId: state.runId, coordinatorModelId: coordinator.id },
        'Synthesis: adapter unavailable for coordinator — using weighted_confidence',
      );
      return aggregateSignals(signals, state, 'weighted_confidence');
    }

    return synthesizeViaCoordinator(
      signals,
      state,
      async (request) => {
        const start = Date.now();
        const execution = await this.executeModel(adapter, coordinator, request, 'coordinator');
        return {
          response: execution.response,
          cost: execution.cost,
          durationMs: Date.now() - start,
        };
      },
      {
        coordinatorModelId: coordinator.id,
        // 20% of the run-level budget reserved for synthesis. The
        // coordination cost guardrail (F0.4) accounts for participant
        // calls; this cap is the additional ceiling on the one
        // synthesis call per round.
        maxSynthesisCostUsd: Math.max(0.01, config.maxCostUsd * 0.2),
        timeoutMs: Math.min(15000, config.maxLatencyMs),
        fallbackMethod: 'weighted_confidence',
      },
    );
  }

  private async collectSignals(
    request: ChatRequest,
    context: OrchestrationContext,
    models: Model[],
    state: CoordinationState,
    round: number,
    config: CoordinationConfig,
  ): Promise<{
    signals: CoordinationSignal[];
    executions: ModelExecution[];
    parseFailures: number;
  }> {
    const signals: CoordinationSignal[] = [];
    const executions: ModelExecution[] = [];
    let parseFailures = 0;

    const coordinationPromises = models.map(async (model) => {
      try {
        if (!this.getAdapterForModel) {
          throw new Error('getAdapterForModel not injected');
        }
        const adapter = await this.getAdapterForModel(model, context);
        if (!adapter) {
          throw new Error(`No adapter for model: ${model.id}`);
        }

        const systemPrompt = buildCoordinationSystemPrompt(
          undefined,
          round,
          state.round > 0 ? state : undefined,
          { entropySeedEnabled: config.entropySeedEnabled },
        );
        const userMessage = buildCoordinationUserMessage(request.messages);

        const coordinationRequest: ChatRequest = {
          ...request,
          model: model.id,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.3,
          max_tokens: 2048,
        };

        const callStart = Date.now();
        const execution = await this.executeModel(
          adapter,
          model,
          coordinationRequest,
          'coordinator',
        );
        const callDuration = Date.now() - callStart;

        executions.push(execution);

        if (!execution.success) {
          parseFailures++;
          recordSignalParseFailure('sensitivity-consensus', model.id);
          return;
        }

        const responseText = safeResponseContent(execution.response);
        if (!responseText) {
          parseFailures++;
          recordSignalParseFailure('sensitivity-consensus', model.id);
          return;
        }

        const metrics = {
          latencyMs: callDuration,
          inputTokens: execution.response?.usage?.prompt_tokens ?? 0,
          outputTokens: execution.response?.usage?.completion_tokens ?? 0,
          estimatedCost: execution.cost,
        };

        const parsed = parseSignalResponse(
          responseText,
          state.runId,
          round,
          `agent-${model.id}`,
          model.id,
          model.provider ?? adapter.getName(),
          undefined,
          metrics,
        );

        if (parsed.signal) {
          signals.push(parsed.signal);
        } else {
          parseFailures++;
          recordSignalParseFailure('sensitivity-consensus', model.id);
          this.log.debug(
            {
              modelId: model.id,
              round,
              parseError: parsed.parseError,
              responsePreview: responseText.substring(0, 200),
            },
            'Failed to parse signal from model response',
          );
        }
      } catch (error) {
        parseFailures++;
        this.log.warn(
          {
            modelId: model.id,
            round,
            error: error instanceof Error ? error.message : String(error),
          },
          'Model failed during coordination signal collection',
        );
      }
    });

    await Promise.all(coordinationPromises);

    return { signals, executions, parseFailures };
  }

  private async executeFallback(
    request: ChatRequest,
    context: OrchestrationContext,
  ): Promise<OrchestrationResult> {
    const { ConsensusStrategy } = await import('./consensus-strategy');
    const fallback = new ConsensusStrategy();

    const adapterResolver = this.getAdapterForModel;
    if (adapterResolver) {
      // `getAdapterForModel` is a runtime augmentation injected by the
      // orchestration engine — `protected` on the base, but we need to
      // forward it to the fallback strategy instance. Route through
      // `narrowAs<>` so the lint rule against `as unknown as` stays clean
      // and the access-modifier widening is documented at one auditable site.
      narrowAs<{ getAdapterForModel?: typeof adapterResolver }>(fallback).getAdapterForModel =
        adapterResolver.bind(this);
    }

    return fallback.execute(request, context);
  }

  private buildCoordinationResult(
    state: CoordinationState,
    models: Model[],
    executions: ModelExecution[],
    stopReason: CoordinationResult['stopReason'],
  ): CoordinationResult {
    const lastRoundSignals = state.history.filter(s => s.round === state.round);
    const majorityDecision = this.getMajorityDecision(lastRoundSignals);
    const dissent = this.extractDissent(lastRoundSignals, majorityDecision);
    const criticalVariables = this.extractCriticalVariables(state);
    const dominantSensitivities = this.extractDominantSensitivities(state);

    const finalResponseText = this.generateFinalResponseText(
      state,
      majorityDecision,
      dissent,
      criticalVariables,
      stopReason,
    );

    return {
      decision: majorityDecision ?? {
        type: 'indeterminate',
        value: null,
        confidence: 0,
        rationale: 'No majority decision reached',
      },
      participatingModels: models.map(m => ({
        modelId: m.id,
        modelName: m.name,
        providerId: m.provider ?? 'unknown',
      })),
      convergence: state.convergence,
      roundsExecuted: state.round,
      stopReason,
      criticalVariables,
      dominantSensitivities,
      dissent,
      finalResponseText,
      totalCostUsd: state.totalCostUsd,
      totalLatencyMs: state.totalLatencyMs,
      totalTokens: state.totalTokens,
      auditTrail: state.history,
    };
  }

  private getMajorityDecision(
    signals: CoordinationSignal[],
  ): CoordinationResult['decision'] | null {
    if (signals.length === 0) return null;

    const decisionCounts: Record<string, { count: number; totalConfidence: number; signal: CoordinationSignal }> = {};
    for (const sig of signals) {
      const type = sig.decision.type;
      if (!decisionCounts[type]) {
        decisionCounts[type] = { count: 0, totalConfidence: 0, signal: sig };
      }
      decisionCounts[type].count++;
      decisionCounts[type].totalConfidence += sig.decision.confidence;
    }

    const majority = Object.entries(decisionCounts)
      .sort((a, b) => b[1].count - a[1].count)[0];

    if (!majority) return null;

    const avgConfidence = majority[1].totalConfidence / majority[1].count;

    return {
      type: majority[0],
      value: majority[1].signal.decision.value,
      confidence: avgConfidence,
      rationale: majority[1].signal.decision.rationale,
    };
  }

  private extractDissent(
    signals: CoordinationSignal[],
    majority: CoordinationResult['decision'] | null,
  ): CoordinationResult['dissent'] {
    if (!majority || signals.length === 0) return [];

    return signals
      .filter(s => s.decision.type !== majority.type)
      .map(s => ({
        agentId: s.agentId,
        modelId: s.modelId,
        decision: s.decision,
        rationale: s.decision.rationale ?? 'No rationale provided',
      }));
  }

  private extractCriticalVariables(state: CoordinationState): string[] {
    const critical: string[] = [];

    for (const [name, varState] of Object.entries(state.variables)) {
      if (varState.stability < 0.5 && varState.confidence > 0.5) {
        critical.push(name);
      }
    }

    for (const risk of state.risks) {
      if (risk.severity === 'high' || risk.severity === 'critical') {
        const match = risk.type.match(/critical_sensitivity_(.+)/);
        if (match && !critical.includes(match[1])) {
          critical.push(match[1]);
        }
      }
    }

    return [...new Set(critical)];
  }

  private extractDominantSensitivities(
    state: CoordinationState,
  ): CoordinationResult['dominantSensitivities'] {
    const lastRound = state.history.filter(s => s.round === state.round);
    if (lastRound.length === 0) return [];

    const variableSensMap = new Map<string, { count: number; sensitivity: typeof lastRound[0]['sensitivities'][0] }>();

    for (const sig of lastRound) {
      for (const sens of sig.sensitivities) {
        const existing = variableSensMap.get(sens.variable);
        if (!existing || existing.count < 1) {
          variableSensMap.set(sens.variable, { count: 1, sensitivity: sens });
        } else {
          existing.count++;
        }
      }
    }

    return [...variableSensMap.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(v => v.sensitivity);
  }

  private generateFinalResponseText(
    state: CoordinationState,
    decision: CoordinationResult['decision'] | null,
    dissent: CoordinationResult['dissent'],
    criticalVariables: string[],
    stopReason: string,
  ): string {
    const parts: string[] = [];

    if (decision) {
      parts.push(`**Decision: ${decision.type}** (confidence: ${(decision.confidence * 100).toFixed(0)}%)`);
      if (decision.rationale) {
        parts.push(`Rationale: ${decision.rationale}`);
      }
    }

    parts.push('');
    parts.push(`**Coordination:** ${state.round} round(s), stopped due to ${stopReason.replace(/_/g, ' ')}.`);
    parts.push(`Convergence score: ${state.convergence.score.toFixed(2)}`);

    if (criticalVariables.length > 0) {
      parts.push('');
      parts.push(`**Critical variables:** ${criticalVariables.join(', ')}`);
    }

    if (dissent.length > 0) {
      parts.push('');
      parts.push('**Dissenting positions:**');
      for (const d of dissent.slice(0, 3)) {
        parts.push(`- ${d.modelId}: ${d.decision.type} (confidence: ${(d.decision.confidence * 100).toFixed(0)}%) — ${d.rationale}`);
      }
    }

    return parts.join('\n');
  }

  private async selectDiverseModels(
    models: Model[],
    count: number,
    context?: OrchestrationContext,
  ): Promise<Model[]> {
    const preference = context
      ? resolvePreferredExecutor(models, context, [])
      : undefined;

    const pool = preference?.pinnedExecutor
      ? models.filter(m => m.id !== preference.pinnedExecutor!.id)
      : models;
    const remainingCount = preference?.pinnedExecutor
      ? Math.max(0, count - 1)
      : count;

    const byProvider: Record<string, Model[]> = {};
    for (const model of pool) {
      const provider = model.provider || 'unknown';
      if (!byProvider[provider]) byProvider[provider] = [];
      byProvider[provider].push(model);
    }

    const selected: Model[] = [];
    const providers = Object.keys(byProvider);
    let providerIndex = 0;

    while (selected.length < remainingCount && selected.length < pool.length) {
      const provider = providers[providerIndex % providers.length];
      const providerModels = byProvider[provider];
      if (providerModels && providerModels.length > 0) {
        const candidate = providerModels.find(m => !selected.includes(m));
        if (candidate) selected.push(candidate);
      }
      providerIndex++;
      if (providerIndex > providers.length * remainingCount) break;
    }

    if (selected.length < remainingCount) {
      for (const model of pool) {
        if (!selected.includes(model) && selected.length < remainingCount) {
          selected.push(model);
        }
      }
    }

    return preference ? withPreferredFirst(preference, selected) : selected;
  }

  private buildOrchestrationResult(
    coordResult: CoordinationResult,
    executions: ModelExecution[],
    state: CoordinationState,
    totalDuration: number,
    metadata: StrategyMetadata,
    trace?: CollectiveTrace,
  ): OrchestrationResult {
    const completionWords = coordResult.finalResponseText.split(/\s+/).filter(Boolean).length;
    const completionTokens = Math.ceil(completionWords * 1.3);

    const finalResponse: ChatResponse = {
      id: `coord-${nanoid(10)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'sensitivity-consensus',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: coordResult.finalResponseText,
          },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: state.totalTokens,
        completion_tokens: completionTokens,
        total_tokens: state.totalTokens + completionTokens,
      },
    };

    return {
      strategyUsed: metadata.name,
      // Each ModelExecution in `executions` carries the actual per-call request
      // and response from that model in that round — preserving round-level
      // observability instead of collapsing all calls into the synthesized
      // final response (which was the previous bug).
      modelsUsed: executions,
      finalResponse,
      totalCost: coordResult.totalCostUsd,
      totalDuration,
      qualityScore: coordResult.decision.confidence,
      metadata: {
        strategyId: metadata.id,
        coordinationRunId: state.runId,
        roundsExecuted: coordResult.roundsExecuted,
        stopReason: coordResult.stopReason,
        convergenceScore: coordResult.convergence.score,
        decisionType: coordResult.decision.type,
        decisionConfidence: coordResult.decision.confidence,
        criticalVariables: coordResult.criticalVariables,
        dissentCount: coordResult.dissent.length,
        dominantSensitivities: coordResult.dominantSensitivities.map(s => ({
          variable: s.variable,
          direction: s.direction,
          confidence: s.confidence,
        })),
        totalCostUsd: coordResult.totalCostUsd,
        totalTokens: coordResult.totalTokens,
        participatingModels: coordResult.participatingModels.map(m => m.modelId),
        ...(coordResult.auditTrail ? { coordinationAuditTrail: true } : {}),
        // F2.7 — CollectiveTrace summary. We expose the per-phase
        // describe() output (counts only) instead of every span so
        // the metadata blob stays bounded; the full span list is
        // available in-process via the trace object if a future
        // endpoint wants to surface it.
        ...(trace
          ? {
              collectiveTrace: trace.describe(),
            }
          : {}),
      },
    };
  }

  private recordCoordinationMetrics(
    result: CoordinationResult,
    context: OrchestrationContext,
    totalDurationMs: number,
  ): void {
    try {
      recordCoordinationRun({
        strategy: 'sensitivity-consensus',
        taskType: context.taskType ?? 'general',
        rounds: result.roundsExecuted,
        convergenceScore: result.convergence.score,
        stopReason: result.stopReason,
        totalCostUsd: result.totalCostUsd,
        totalLatencyMs: totalDurationMs,
        totalTokens: result.totalTokens,
        signalCount: result.auditTrail?.length ?? 0,
        validSignalCount: result.auditTrail?.filter(s =>
          s.decision && s.sensitivities && s.sensitivities.length > 0
        ).length ?? 0,
        parseFailureCount: 0,
        conflictCount: result.convergence.unstableVariables.length,
        finalQuality: result.decision.confidence,
        modelDisagreement: result.convergence.dissent,
        // F0.1 fix: stableVariables/unstableVariables are `string[]` (variable
        // names). Object.keys on an array gives stringified indices whose count
        // happens to equal the length — the call worked by coincidence but
        // misrepresented intent. Use `.length` directly for both arms.
        variableCount: result.convergence.stableVariables.length + result.convergence.unstableVariables.length,
        variableStabilityAvg: result.convergence.score,
      });
    } catch (error) {
      this.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to record coordination metrics',
      );
    }
  }
}
