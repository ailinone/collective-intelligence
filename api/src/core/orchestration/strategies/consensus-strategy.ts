// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { BaseStrategy, safeResponseContent, type StrategyMetadata } from '../base-strategy';
import { PROMPTS } from '../prompts/sota-system-prompts';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
} from '@/types';
import { getResponseAggregator, type ModelResponse } from '@/core/aggregation/response-aggregator';
import { buildEnsembleRequest } from '@/core/coordination/ensemble-coordinator-client';
import { runEnsembleInShadow } from '@/core/coordination/ensemble-coordinator-shadow';
import { logger } from '@/utils/logger';
import { narrowAs } from '@/utils/type-guards';
import { resolvePreferredExecutor, withPreferredFirst } from './preferred-model-helper';
import {
  type EvaluationResult,
  type StrategyEvaluationTask,
  type StrategyOutputEvaluator,
  validationStatusForMode,
} from './evaluation/strategy-output-evaluator';
import { UnavailableStrategyOutputEvaluator } from './evaluation/unavailable-evaluator';
import {
  detectOutlier,
  type OutlierDetectionResult,
} from './consensus/consensus-outlier-detector';
import {
  selectFinal,
  type FinalSelectionResult,
} from './consensus/consensus-final-selector';
import { selectWithVerification } from '../verification/verified-selection';
import { extractFinalAnswer, selfConsistency } from '../verification/best-of-n-verifier';
import type {
  ConsensusParticipantArtifact,
  ConsensusPlanParityArtifact,
  ConsensusStrategyArtifacts,
  ConsensusEffectiveStrategyId,
  JudgeSelectionSource,
  ParticipantFailureReason,
  PlanSource,
  SynthesizerSelectionSource,
} from './consensus/consensus-artifacts';
import type { ConsensusExecutionPlan } from './consensus-execution-planner';

const log = logger.child({ component: 'consensus-strategy' });

/**
 * Production default evaluator. Deliberately refuses to assign a quality score
 * (validationStatus = 'unavailable') so consensus decisions are never silently
 * justified by a length heuristic. A real evaluator (structural / task-specific
 * / llm_judge / composite / mock) is injected via `setEvaluator()` by the
 * orchestration engine, or via `setEvaluatorForTesting()` in unit tests.
 */
const DEFAULT_CONSENSUS_EVALUATOR: StrategyOutputEvaluator =
  new UnavailableStrategyOutputEvaluator();

/**
 * Consensus Building Strategy
 *
 * Multiple models vote on the best approach, consensus reached through majority.
 * Reduces individual model bias through democratic selection.
 *
 * Best for: Decision-making tasks requiring balanced judgment
 */
export class ConsensusStrategy extends BaseStrategy {
  /**
   * Quality evaluator used to score voter and synthesis outputs. Unset until
   * injected; reads fall back to `DEFAULT_CONSENSUS_EVALUATOR` (Unavailable),
   * which never fabricates a score.
   */
  private evaluator?: StrategyOutputEvaluator;

  /**
   * Inject a real evaluator (structural, task-specific, llm_judge, composite).
   * Called by the orchestration engine after building the evaluator from
   * environment config (see evaluator-factory / evaluator-config).
   */
  setEvaluator(evaluator: StrategyOutputEvaluator): void {
    this.evaluator = evaluator;
  }

  /**
   * Test-only alias for {@link setEvaluator}. Kept distinct so test wiring is
   * grep-able and can never be mistaken for a production injection point.
   */
  setEvaluatorForTesting(evaluator: StrategyOutputEvaluator): void {
    this.evaluator = evaluator;
  }

  /**
   * Resolve the active evaluator, falling back to the Unavailable default when
   * none was injected.
   */
  protected getEvaluator(): StrategyOutputEvaluator {
    return this.evaluator ?? DEFAULT_CONSENSUS_EVALUATOR;
  }

  getMetadata(): StrategyMetadata {
    return {
      id: 'consensus',
      name: 'consensus',
      displayName: 'Consensus Building',
      description: 'Multiple models vote on best approach. Democratic selection reduces bias.',
      minModels: 3,
      maxModels: 5,
      estimatedCostMultiplier: 3.5,
      estimatedQualityBoost: 0.25,
      estimatedDurationMultiplier: 1.3,
      suitableFor: ['analysis', 'code-review', 'debugging'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const metadata = this.getMetadata();

    // ─── Strategy 01C.0.1 — plan-to-execution wiring ──────────────────
    // If the chat-request-processor attached a `ConsensusExecutionPlan`
    // to `request.consensusPlan` (populated by ModelRoleResolver via
    // the dry-run service), use it as the source of truth for voter
    // selection AND judge selection. This wires the dynamic role
    // discovery layer into the live execution path.
    //
    // When no plan is attached, fall back to the legacy path
    // (selectDiverseModels) and record planSource='legacy_selection'.
    const plan = readConsensusPlan(request);
    let planSource: PlanSource = 'none';
    let plannedParticipantModelIds: readonly string[] = [];
    let plannedSynthesizerModelId: string | undefined;
    let plannedJudgeModelId: string | undefined;
    let plannedFallbackModelId: string | undefined;
    if (plan) {
      planSource = 'dynamic_role_resolver';
      plannedParticipantModelIds = plan.participants.map((p) => p.model.id);
      plannedSynthesizerModelId = plan.synthesizer?.model.id;
      plannedJudgeModelId = plan.judge?.model.id;
      plannedFallbackModelId = plan.fallbackSingle?.model.id;
    }

    // Filter models by capabilities, quality, budget — no audio/image/embedding models
    const models = this.getEligibleModels(context);

    this.log.info(
      {
        strategy: metadata.name,
        requestId: context.requestId,
        taskType: context.taskType,
        eligibleModels: models.length,
        totalModels: context.models.length,
        planSource,
        plannedParticipantCount: plannedParticipantModelIds.length,
      },
      'Executing Consensus strategy'
    );

    if (models.length < 3 && !plan) {
      throw new Error(`Consensus requires at least 3 eligible models; only ${models.length} passed quality/capability filters (from ${context.models.length} total)`);
    }

    // Voter selection — plan wins when present, legacy diversity otherwise.
    let selectedModels: Model[];
    if (plan && plan.participants.length >= 3) {
      // Honor the plan's participants exactly. They were already
      // operability-filtered by the resolver.
      selectedModels = plan.participants.map((p) => p.model);
      planSource = 'dynamic_role_resolver';
    } else {
      // Legacy path (or plan with too-few participants — degraded).
      const numModels = Math.min(5, Math.max(3, models.length));
      selectedModels = await this.selectDiverseModels(models, numModels, context);
      planSource = plan ? 'legacy_selection' : 'none';
    }

    this.log.debug(
      {
        selectedModels: selectedModels.map((m) => m.name),
        numModels: selectedModels.length,
      },
      'Models selected for consensus voting'
    );

    // Observer: phase start
    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: selectedModels.map(m => m.name),
      summary: `Consensus voting started with ${selectedModels.length} independent voters.`,
    });

    // Execute all models in parallel.
    // Note: per-voter outputs are derived from `executions` directly
    // in the scoring block below — we no longer maintain a parallel
    // `modelResponses` array here (refactored 2026-05-12 to support
    // the score-then-decide pipeline).
    const executions: ModelExecution[] = [];

    const reasoningEnabled = this.isReasoningEnabled(request);

    // Lote 6: resolve prompt slots from triage execution plan (if feature-flagged ON)
    const promptSlots = process.env.ENABLE_PROMPT_SLOTS === 'true'
      ? (context.executionPlan ?? context.triage?.executionPlan)?.stages?.[0]?.promptSlots
      : undefined;

    // Lote 6: try prompt variant selection via LinUCB bandit (if feature-flagged ON).
    // selectPromptVariant returns PromptVariant | null (not a wrapper object).
    const selectedVariant = this.selectPromptVariant('consensusVoter', context);
    const activeVariantId = selectedVariant?.id;

    const executionPromises = selectedModels.map(async (model) => {
      try {
        if (!this.getAdapterForModel) {
          throw new Error('getAdapterForModel not injected by orchestration engine');
        }
        const adapter = await this.getAdapterForModel(model, context);
        if (!adapter) {
          throw new Error(`No adapter found for model: ${model.id}`);
        }
        // Independent-voter framing: each voter needs clear independent framing.
        // Lote 6: if the bandit selected a variant, use its content;
        // otherwise use the canonical prompt (optionally augmented by slots).
        const basePrompt = selectedVariant
          ? selectedVariant.content
          : PROMPTS.consensusVoter(promptSlots);
        const voterSystemPrompt = this.withReasoningPrompt(basePrompt, request, model);
        const voterRequest: ChatRequest = {
          ...request,
          messages: [
            { role: 'system', content: voterSystemPrompt },
            ...request.messages,
          ],
        };

        // Use BaseStrategy.executeModel() for bulkhead, retry, metrics, tracing
        const execution = reasoningEnabled
          ? await this.executeModelWithReasoning(adapter, model, voterRequest, 'voter')
          : await this.executeModel(adapter, model, voterRequest, 'voter');

        // Lote 6: tag execution with variant/slot metadata for the feedback loop.
        // F4-INT: promptKey is required alongside promptVariantId for the bandit
        // to know which arm to reward. Without it, the feedback collector silently
        // skips the bandit update.
        if (activeVariantId) {
          execution.promptVariantId = activeVariantId;
          execution.promptKey = 'consensusVoter';
        }
        if (promptSlots) {
          const { hashSlotValues } = await import('../prompts/prompt-slots');
          execution.promptSlotHash = hashSlotValues(promptSlots);
        }

        executions.push(execution);

        return execution;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.log.error({ error: errorMessage, model: model.name }, 'Model execution failed in consensus');

        const execution: ModelExecution = {
          modelId: model.id,
          modelName: model.name,
          role: 'voter',
          request,
          response: {
            id: `error-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model.name,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: '' },
              finish_reason: 'stop',
              logprobs: null,
            }],
          },
          cost: 0,
          durationMs: 0,
          success: false,
          error: errorMessage,
        };

        executions.push(execution);
        return execution;
      }
    });

    await Promise.all(executionPromises);

    // ─── Evaluate each voter via the injected (or default) evaluator ───
    // The default is `UnavailableStrategyOutputEvaluator`, which refuses
    // to emit quality scores and forces `validationStatus = 'unavailable'`
    // in the artifact. A real judge (LLM rubric / task-specific) MUST be
    // injected via `setEvaluator()` for consensus decisions to be
    // quantitatively justified.
    const evaluator = this.getEvaluator();
    const evalTask = this.buildEvaluationTask(request, context);

    // Evaluate all voters CONCURRENTLY (2026-07-03). This loop was sequential,
    // putting N judge sub-calls in SERIES on the response path — the dominant
    // avoidable stage in measured consensus latency (frozen v3 data: consensus
    // 149.9s vs single 6-19s). Evaluations are independent and order is
    // preserved by map(); voter count is bounded (3-5), so concurrent judge
    // calls stay within provider limits.
    const evaluated: EvaluatedVoterRecord[] = await Promise.all(
      executions.map(async (e) => {
        const output = e.success ? (safeResponseContent(e.response) ?? '') : '';
        const evaluation = await evaluator.evaluate({
          task: evalTask,
          output,
          modelId: e.modelId,
          executionFailed: !e.success,
          executionError: e.success ? undefined : (e.error ?? 'execution_failed'),
          strategyName: 'consensus',
          role: 'voter',
          // Plan-driven judge id flows through to LLMJudgeEvaluator; other
          // evaluators ignore the field by contract.
          judgeModelOverride: plannedJudgeModelId,
        });
        const outlierDetection = detectOutlier({
          executionFailed: !e.success,
          evaluation,
          modelId: e.modelId,
        });
        return { execution: e, output, evaluation, outlierDetection };
      }),
    );

    const successes = evaluated.filter((v) => v.execution.success);
    const validVoters = evaluated.filter(
      (v) => v.execution.success && !v.outlierDetection.outlier,
    );

    if (successes.length === 0) {
      throw new Error('Consensus requires at least 1 successful model execution');
    }

    // bestIndividual is picked from VALID voters when any exist; otherwise
    // falls through to "best of successful (any verdict)" so the strategy
    // can still produce a response in the degraded path. Score may be
    // `undefined` when the evaluator doesn't emit numeric scores.
    const bestPool = validVoters.length > 0 ? validVoters : successes;
    const bestVoter = pickBestVoter(bestPool);

    const participantOutputs = evaluated.map(toParticipantArtifact);
    // Cost computed across the voter executions. The synthesizer/coordinator
    // sub-call cost (when one runs) is folded in below on the synthesis path
    // (cost-accounting integrity, TIER 0). The degraded path runs no
    // synthesizer, so this voters-only total is already correct there.
    const votersTotalCost = executions.reduce((sum, e) => sum + e.cost, 0);

    const reasoningTraces = this.isReasoningEnabled(request)
      ? executions
          .filter((e) => e.reasoning)
          .map((e) => ({
            model_id: e.modelId,
            model_name: e.modelName,
            role: e.role,
            reasoning: e.reasoning,
            reasoning_tokens: e.reasoningTokens,
          }))
      : undefined;

    // ─── Degraded path: < 2 valid voters means synthesis isn't viable ──
    if (validVoters.length < 2) {
      const degradedReason =
        validVoters.length === 0
          ? 'no_valid_voters_after_outlier_filter'
          : 'only_one_valid_voter';

      this.log.warn(
        {
          requestId: context.requestId,
          totalExecutions: executions.length,
          successfulExecutions: successes.length,
          validExecutions: validVoters.length,
          reason: degradedReason,
          scoringMode: evaluator.mode,
        },
        'Consensus degraded: insufficient valid voters — falling back to best individual',
      );

      this.emitObserverEvent(context, {
        type: 'synthesis_complete',
        summary: `Synthesis skipped (degraded: ${degradedReason}); using best individual.`,
      });

      const executedParticipantModelIds = selectedModels.map((m) => m.id);
      // Hybrid parity (Strategy 01C.0.2) — compute per-planned success
      // info even in the degraded branch.
      const { successFlags, failureReasons } = computeHybridParityForPlan({
        plannedParticipantModelIds,
        evaluated,
        planSource,
      });
      const planParity = buildPlanParityArtifact({
        planSource,
        plannedParticipantModelIds,
        executedParticipantModelIds,
        plannedParticipantExecutionSuccess: successFlags,
        plannedParticipantFailureReasons: failureReasons,
        effectiveParticipantCount: validVoters.length,
        plannedSynthesizerModelId,
        executedSynthesizerModelId: undefined, // no synthesis in degraded path
        synthesizerSelectionSource: 'unavailable',
        plannedJudgeModelId,
        executedJudgeModelId: plannedJudgeModelId,
        plannedFallbackModelId,
        executedFallbackModelId: bestVoter.execution.modelId,
        evaluatorMode: evaluator.mode,
        minRequiredParticipants: metadata.minModels,
      });
      const artifacts: ConsensusStrategyArtifacts = {
        strategyName: 'consensus',
        effectiveStrategyId: 'consensus_degraded_best_individual',
        scoringMode: evaluator.mode,
        evaluatorId: evaluator.id,
        validationStatus:
          bestVoter.evaluation.validationStatus ?? validationStatusForMode(evaluator.mode),
        participantOutputs,
        synthesis: {
          inputParticipantCount: validVoters.length,
        },
        bestIndividual: {
          modelId: bestVoter.execution.modelId,
          score: bestVoter.evaluation.score,
          outputLength: bestVoter.output.length,
        },
        finalSelection: {
          source: 'best_individual',
          fallbackTriggered: true,
          fallbackReason: degradedReason,
          finalScore: bestVoter.evaluation.score,
          comparable: false,
        },
        partialDegradation: true,
        partialDegradationReason: degradedReason,
        planParity,
      };

      return {
        strategyUsed: metadata.name,
        modelsUsed: executions,
        finalResponse: bestVoter.execution.response,
        totalCost: votersTotalCost,
        totalDuration: Date.now() - startTime,
        qualityScore: bestVoter.evaluation.score ?? 0,
        metadata: {
          strategyId: metadata.id,
          effectiveStrategyId: 'consensus_degraded_best_individual' as ConsensusEffectiveStrategyId,
          votingModels: selectedModels.map((m) => m.id),
          consensusReached: false,
          aggregationMethod: 'best_individual_fallback',
          consensusArtifacts: artifacts,
          ...(reasoningTraces?.length ? { reasoning_traces: reasoningTraces } : {}),
        },
      };
    }

    // ─── Pre-synthesis short-circuits (2026-07-03) ──────────────────────
    // Skip the synthesizer + its evaluation when a stronger-than-judge signal
    // already determines the answer:
    //   1. objective checker (context.answerVerifier): a voter whose extracted
    //      answer PASSES verification outranks any unverified synthesis;
    //   2. voter agreement at/above CONSENSUS_AGREEMENT_EXIT_THRESHOLD
    //      (default 1.0 = unanimity): synthesizing N copies of the same answer
    //      adds latency and cost, not quality.
    // Disabled under CONSENSUS_STRICT_PLAN_EXECUTION — operators validating a
    // plan need the pipeline to run exactly as planned.
    if (process.env.CONSENSUS_STRICT_PLAN_EXECUTION !== 'true') {
      const shortCircuit = this.detectPreSynthesisShortCircuit(context, validVoters);
      if (shortCircuit) {
        this.log.info(
          {
            requestId: context.requestId,
            effectiveStrategyId: shortCircuit.effectiveStrategyId,
            reason: shortCircuit.fallbackReason,
            voterModelId: shortCircuit.voter.execution.modelId,
            confidence: shortCircuit.confidence,
          },
          'Consensus pre-synthesis short-circuit: skipping synthesizer',
        );
        this.emitObserverEvent(context, {
          type: 'synthesis_complete',
          summary: shortCircuit.observerSummary,
        });

        const { successFlags, failureReasons } = computeHybridParityForPlan({
          plannedParticipantModelIds,
          evaluated,
          planSource,
        });
        const planParity = buildPlanParityArtifact({
          planSource,
          plannedParticipantModelIds,
          executedParticipantModelIds: selectedModels.map((m) => m.id),
          plannedParticipantExecutionSuccess: successFlags,
          plannedParticipantFailureReasons: failureReasons,
          effectiveParticipantCount: validVoters.length,
          plannedSynthesizerModelId,
          executedSynthesizerModelId: undefined, // deliberately skipped
          synthesizerSelectionSource: 'skipped_short_circuit',
          synthesisSkippedByShortCircuit: true,
          plannedJudgeModelId,
          executedJudgeModelId: plannedJudgeModelId,
          plannedFallbackModelId,
          executedFallbackModelId: bestVoter.execution.modelId,
          evaluatorMode: evaluator.mode,
          minRequiredParticipants: metadata.minModels,
        });

        const artifacts: ConsensusStrategyArtifacts = {
          strategyName: 'consensus',
          effectiveStrategyId: shortCircuit.effectiveStrategyId,
          scoringMode: evaluator.mode,
          evaluatorId: evaluator.id,
          validationStatus:
            shortCircuit.voter.evaluation.validationStatus ?? validationStatusForMode(evaluator.mode),
          participantOutputs,
          synthesis: {
            // Synthesis deliberately skipped — no synthesizer subcall, no score.
            inputParticipantCount: validVoters.length,
          },
          bestIndividual: {
            modelId: bestVoter.execution.modelId,
            score: bestVoter.evaluation.score,
            outputLength: bestVoter.output.length,
          },
          ...(shortCircuit.verification ? { verification: shortCircuit.verification } : {}),
          ...(shortCircuit.agreement ? { agreementShortCircuit: shortCircuit.agreement } : {}),
          finalSelection: {
            source: shortCircuit.source,
            fallbackTriggered: false,
            fallbackReason: shortCircuit.fallbackReason,
            finalScore: shortCircuit.voter.evaluation.score,
            comparable: false,
          },
          partialDegradation: validVoters.length < metadata.minModels,
          partialDegradationReason:
            validVoters.length < metadata.minModels ? 'fewer_valid_voters_than_min' : undefined,
          planParity,
        };

        return {
          strategyUsed: metadata.name,
          modelsUsed: executions,
          finalResponse: shortCircuit.voter.execution.response,
          totalCost: votersTotalCost,
          totalDuration: Date.now() - startTime,
          qualityScore: shortCircuit.voter.evaluation.score ?? shortCircuit.confidence,
          metadata: {
            strategyId: metadata.id,
            effectiveStrategyId: shortCircuit.effectiveStrategyId,
            votingModels: selectedModels.map((m) => m.id),
            consensusReached: shortCircuit.source === 'agreement_individual',
            aggregationMethod: shortCircuit.source,
            consensusArtifacts: artifacts,
            ...(reasoningTraces?.length ? { reasoning_traces: reasoningTraces } : {}),
          },
        };
      }
    }

    this.log.info(
      {
        totalExecutions: executions.length,
        successfulExecutions: successes.length,
        validExecutions: validVoters.length,
        scoringMode: evaluator.mode,
      },
      'All models executed, starting synthesis aggregation',
    );

    this.emitObserverEvent(context, {
      type: 'round_complete',
      round: 1, totalRounds: 1,
      summary: `${validVoters.length} valid voter responses collected. Starting synthesis.`,
    });

    this.emitObserverEvent(context, {
      type: 'synthesis_start',
      summary: 'Coordinator synthesizing voter responses into unified answer.',
    });

    // Phase 2c shadow integration — non-streaming execute() path. NEVER throws.
    void runEnsembleInShadow(
      buildEnsembleRequest(
        'consensus',
        'synthesis-coordinator',
        {
          requestId: context.requestId,
          voterCount: validVoters.length,
          voterModelIds: validVoters.map((v) => v.execution.modelId),
          taskType: context.taskType,
          qualityThreshold: context.qualityTarget || 0.8,
          path: 'non-streaming',
        },
      ),
      {
        heuristicDecisionForComparison: {
          role: 'synthesizer',
          scheduler: 'aggregator-synthesis',
          reason: 'aggregator-default',
        },
      },
    ).catch((err: unknown) => {
      log.debug({ err: String(err) }, 'shadow runner promise rejected silently');
    });

    // Synthesis runs on VALID (non-outlier) responses only.
    const synthesisInputs: ModelResponse[] = validVoters.map((v) => ({
      modelId: v.execution.modelId,
      modelName: v.execution.modelName,
      response: v.execution.response,
      cost: v.execution.cost,
      durationMs: v.execution.durationMs,
      success: true,
    }));
    const aggregator = getResponseAggregator();
    const aggregated = await aggregator.aggregate(synthesisInputs, 'synthesis', {
      requestId: context.requestId,
      taskType: context.taskType,
      qualityThreshold: context.qualityTarget || 0.8,
      // Forward the client's max_tokens so the coordinator honors it (up to 128k)
      // instead of the aggregator's fallback default.
      maxTokens: Number(request.max_tokens) > 0 ? Number(request.max_tokens) : undefined,
    });

    // Cost-accounting integrity (TIER 0): the synthesizer/coordinator is a real
    // paid LLM sub-call. Track it as a first-class ModelExecution so (a)
    // totalCost includes it and (b) the cost-accounting invariant
    // totalCost === sum(modelsUsed.cost) holds.
    const synthesizerCost = aggregated.cost ?? 0;
    if (synthesizerCost > 0 || aggregated.coordinator) {
      const synthExecution: ModelExecution = {
        modelId: aggregated.coordinator?.id ?? 'consensus-synthesizer',
        modelName: aggregated.coordinator?.name ?? 'consensus-synthesizer',
        role: 'coordinator',
        request,
        response: aggregated.response,
        cost: synthesizerCost,
        durationMs: 0,
        success: true,
      };
      executions.push(synthExecution);
    }
    const totalCost = executions.reduce((sum, e) => sum + e.cost, 0);

    // Evaluate synthesis with the SAME evaluator so comparison is apples-
    // to-apples. role='synthesis' lets the evaluator apply a synthesis-
    // specific rubric if it has one.
    const synthesisText = safeResponseContent(aggregated.response) ?? '';
    const synthesisEvaluation = await evaluator.evaluate({
      task: evalTask,
      output: synthesisText,
      executionFailed: false,
      strategyName: 'consensus',
      role: 'synthesis',
      judgeModelOverride: plannedJudgeModelId,
    });

    let selection: FinalSelectionResult = selectFinal({
      synthesisAvailable: true,
      synthesisEvaluation,
      bestIndividualScore: bestVoter.evaluation.score,
      bestIndividualModelId: bestVoter.execution.modelId,
    });

    // ─── Best-of-N verification (#2): an objective checker beats the judge ──
    // Only when the request carries an `answerVerifier` (verifiable task). A
    // verified voter overrides an unverified synthesis; a verified synthesis
    // stands; no checker signal leaves the judge-driven decision untouched.
    let finalVoter = bestVoter;
    let verificationArtifact: ConsensusStrategyArtifacts['verification'];
    if (context.answerVerifier) {
      const verified = selectWithVerification({
        synthesisText,
        candidateTexts: validVoters.map((v) => v.output),
        checker: context.answerVerifier,
        among: context.answerVerifierAmong,
        scope: context.answerVerifierScope,
        // Judge scores rank equally-verified passers (code/full-scope: the binary
        // structural floor passes several candidates; serve the BEST, not the first).
        candidateScores: validVoters.map((v) => v.evaluation.score),
        completionAnyOf: context.answerVerifierCompletionAnyOf,
        candidateTruncated: validVoters.map((v) => responseTruncated(v.execution.response)),
        synthesisTruncated: responseTruncated(aggregated.response),
      });
      const verifiedVoter =
        verified.decision === 'override_to_voter' && verified.voterIndex !== undefined
          ? validVoters[verified.voterIndex]
          : undefined;
      verificationArtifact = {
        decision: verified.decision,
        method: verified.verify.method,
        confidence: verified.verify.confidence,
        verifiedCount: verified.verify.verifiedCount,
        totalCount: verified.verify.totalCount,
        synthesisVerified: verified.synthesisVerified,
        verifiedModelId: verifiedVoter?.execution.modelId,
      };
      if (verifiedVoter) {
        finalVoter = verifiedVoter;
        selection = {
          source: 'verified_individual',
          fallbackTriggered: false,
          fallbackReason: 'checker_verified_voter_over_unverified_synthesis',
          finalScore: verifiedVoter.evaluation.score,
          comparable: false,
        };
        this.log.info(
          {
            requestId: context.requestId,
            verifiedModelId: verifiedVoter.execution.modelId,
            verifiedCount: verified.verify.verifiedCount,
            totalCount: verified.verify.totalCount,
            confidence: verified.verify.confidence,
          },
          'Consensus verification override: checker-verified voter beats unverified synthesis',
        );
      }
    }

    const partialDegradation = validVoters.length < metadata.minModels;
    const partialDegradationReason = partialDegradation
      ? 'fewer_valid_voters_than_min'
      : undefined;

    const executedParticipantModelIds = selectedModels.map((m) => m.id);
    // Strategy 01C.0.2 — Hybrid parity. Per-planned success flags +
    // classified failure reasons.
    const { successFlags, failureReasons } = computeHybridParityForPlan({
      plannedParticipantModelIds,
      evaluated,
      planSource,
    });
    // The synthesizer the aggregator actually used (when it emits the id).
    // The aggregator should echo back the coordinator id in
    // `metadata.coordinatorModelId`; when it doesn't (e.g., simple synthesis
    // or test mock) we fall back to the planned id so plan-parity holds.
    const executedSynthesizerModelId =
      (aggregated.metadata as { coordinatorModelId?: string } | undefined)?.coordinatorModelId
      ?? plannedSynthesizerModelId;
    // Judge id flows through judgeModelOverride; record the planned id as
    // executed when an override was sent.
    const executedJudgeModelId = plannedJudgeModelId;
    const executedFallbackModelId = bestVoter.execution.modelId;
    const planParity = buildPlanParityArtifact({
      planSource,
      plannedParticipantModelIds,
      executedParticipantModelIds,
      plannedParticipantExecutionSuccess: successFlags,
      plannedParticipantFailureReasons: failureReasons,
      effectiveParticipantCount: validVoters.length,
      plannedSynthesizerModelId,
      executedSynthesizerModelId,
      plannedJudgeModelId,
      executedJudgeModelId,
      plannedFallbackModelId,
      executedFallbackModelId,
      evaluatorMode: evaluator.mode,
      minRequiredParticipants: metadata.minModels,
    });
    const baseArtifactFields = {
      scoringMode: evaluator.mode,
      evaluatorId: evaluator.id,
      validationStatus:
        synthesisEvaluation.validationStatus ?? validationStatusForMode(evaluator.mode),
      participantOutputs: participantOutputs as readonly ConsensusParticipantArtifact[],
      synthesis: {
        inputParticipantCount: validVoters.length,
        score: synthesisEvaluation.score,
        verdict: synthesisEvaluation.verdict,
        confidence: aggregated.confidence,
        outputLength: synthesisText.length,
        synthesizerModelId: executedSynthesizerModelId,
      },
      bestIndividual: {
        modelId: bestVoter.execution.modelId,
        score: bestVoter.evaluation.score,
        outputLength: bestVoter.output.length,
      },
      ...(verificationArtifact ? { verification: verificationArtifact } : {}),
      planParity,
    };

    this.log.info(
      {
        strategy: metadata.name,
        requestId: context.requestId,
        duration: Date.now() - startTime,
        cost: totalCost,
        confidence: aggregated.confidence,
        scoringMode: evaluator.mode,
        synthesisScore: synthesisEvaluation.score,
        bestIndividualScore: bestVoter.evaluation.score,
        selection,
      },
      'Consensus strategy completed',
    );

    this.emitObserverEvent(context, {
      type: 'synthesis_complete',
      summary: selection.fallbackTriggered
        ? `Synthesis underperformed best individual (${selection.fallbackReason}); falling back.`
        : `Consensus reached with confidence ${aggregated.confidence.toFixed(2)}.`,
    });

    // Strategy 01C.0.3 — strict plan execution. When the env flag is
    // set AND the plan diverged at execution time (planExecutionDegraded),
    // throw BEFORE returning a usable result. Operators running validation
    // can't accept silent degradation.
    if (process.env.CONSENSUS_STRICT_PLAN_EXECUTION === 'true' && planParity.planExecutionDegraded) {
      this.log.error(
        {
          requestId: context.requestId,
          planSource: planParity.planSource,
          planExecutionDegraded: planParity.planExecutionDegraded,
          planExecutionDegradationReason: planParity.planExecutionDegradationReason,
          participantModelsMatchPlan: planParity.participantModelsMatchPlan,
          synthesizerMatchesPlan: planParity.synthesizerMatchesPlan,
          judgeModelMatchesPlan: planParity.judgeModelMatchesPlan,
          successfulParticipantCount: planParity.successfulParticipantCount,
        },
        'Consensus strict-plan-execution: refusing to return a degraded result',
      );
      throw Object.assign(
        new Error(
          `Consensus strict-plan-execution: ${planParity.planExecutionDegradationReason ?? 'plan_diverged'}`,
        ),
        {
          code: 'consensus_strict_plan_execution_blocked',
          statusCode: 503,
          planParity,
        },
      );
    }

    return this.buildResult({
      metadata,
      executions,
      selectedModels,
      totalCost,
      startTime,
      aggregated,
      selection,
      baseArtifactFields,
      // The voter served when selection.source !== 'synthesis': the judge's best
      // individual on fallback, or the checker-verified voter on verification override.
      bestVoter: finalVoter,
      reasoningTraces,
      partialDegradation,
      partialDegradationReason,
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /**
   * Pre-synthesis short-circuit detection (2026-07-03). Returns the voter to
   * serve directly — skipping the synthesizer subcall and its evaluation —
   * when a signal stronger than the judge already determines the answer, or
   * null to proceed to synthesis. Checker outranks agreement: an objective
   * verification is evidence; agreement is only redundancy.
   */
  private detectPreSynthesisShortCircuit(
    context: OrchestrationContext,
    validVoters: readonly EvaluatedVoterRecord[],
  ): PreSynthesisShortCircuit | null {
    // 1) Objective checker — the best-of-N verification lever (#2).
    if (context.answerVerifier) {
      const verified = selectWithVerification({
        synthesisText: null, // no synthesis yet — voters-only decision
        candidateTexts: validVoters.map((v) => v.output),
        checker: context.answerVerifier,
        among: context.answerVerifierAmong,
        scope: context.answerVerifierScope,
        // Same passer re-ranking as the post-synthesis site: serve the best
        // equally-verified passer, not the first in voter order.
        candidateScores: validVoters.map((v) => v.evaluation.score),
        completionAnyOf: context.answerVerifierCompletionAnyOf,
        candidateTruncated: validVoters.map((v) => responseTruncated(v.execution.response)),
      });
      if (verified.decision === 'override_to_voter' && verified.voterIndex !== undefined) {
        const voter = validVoters[verified.voterIndex];
        return {
          voter,
          source: 'verified_individual',
          effectiveStrategyId: 'consensus_verified_individual',
          fallbackReason: 'checker_verified_voter_pre_synthesis',
          confidence: verified.verify.confidence,
          verification: {
            decision: verified.decision,
            method: verified.verify.method,
            confidence: verified.verify.confidence,
            verifiedCount: verified.verify.verifiedCount,
            totalCount: verified.verify.totalCount,
            synthesisVerified: false,
            verifiedModelId: voter.execution.modelId,
          },
          observerSummary:
            `Synthesis skipped: checker-verified answer from ${voter.execution.modelId} ` +
            `(${verified.verify.verifiedCount}/${verified.verify.totalCount} candidates passed).`,
        };
      }
    }

    // 2) Voter agreement. Default threshold 1.0 (unanimity among parseable
    // answers): a synthesis over N identical answers cannot disagree with
    // them, so running it buys latency and cost, not quality. Tune via
    // CONSENSUS_AGREEMENT_EXIT_THRESHOLD (>1 disables); minimum parseable
    // voters via CONSENSUS_AGREEMENT_EXIT_MIN_VOTERS (default 3).
    const threshold = Number(process.env.CONSENSUS_AGREEMENT_EXIT_THRESHOLD ?? 1.0);
    const minParseable = Number(process.env.CONSENSUS_AGREEMENT_EXIT_MIN_VOTERS ?? 3);
    if (threshold <= 1 && validVoters.length >= minParseable) {
      const answers = validVoters.map((v) => extractFinalAnswer(v.output));
      const parseable = answers.filter((a): a is string => a != null);
      if (parseable.length >= minParseable) {
        const { answer, agreement } = selfConsistency(answers);
        if (answer != null && agreement >= threshold) {
          const voterIndex = answers.findIndex((a) => a === answer);
          const voter = validVoters[voterIndex];
          return {
            voter,
            source: 'agreement_individual',
            effectiveStrategyId: 'consensus_agreement_individual',
            fallbackReason: 'voter_agreement_pre_synthesis',
            confidence: agreement,
            agreement: {
              agreement,
              parseableCount: parseable.length,
              voterCount: validVoters.length,
            },
            observerSummary:
              `Synthesis skipped: ${(agreement * 100).toFixed(0)}% voter agreement on the same ` +
              `answer (${parseable.length}/${validVoters.length} parseable).`,
          };
        }
      }
    }

    return null;
  }

  private buildEvaluationTask(
    request: ChatRequest,
    context: OrchestrationContext,
  ): StrategyEvaluationTask {
    const lastUserMsg = [...request.messages].reverse().find((m) => m.role === 'user');
    const userMessageExcerpt = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content.slice(0, 200)
      : undefined;
    const taskType = typeof context.taskType === 'string' ? context.taskType : undefined;
    return {
      taskType,
      userMessageExcerpt,
      expectedFormat: inferExpectedFormat(taskType),
    };
  }

  private buildResult(args: {
    readonly metadata: StrategyMetadata;
    readonly executions: ModelExecution[];
    readonly selectedModels: Model[];
    readonly totalCost: number;
    readonly startTime: number;
    readonly aggregated: { response: ChatResponse; confidence: number; metadata: unknown };
    readonly selection: FinalSelectionResult;
    readonly baseArtifactFields: Omit<ConsensusStrategyArtifacts, 'strategyName' | 'effectiveStrategyId' | 'finalSelection' | 'partialDegradation' | 'partialDegradationReason'>;
    readonly bestVoter: { execution: ModelExecution; output: string; evaluation: EvaluationResult };
    readonly reasoningTraces: unknown[] | undefined;
    readonly partialDegradation: boolean;
    readonly partialDegradationReason: string | undefined;
  }): OrchestrationResult {
    const effective: ConsensusEffectiveStrategyId =
      args.selection.source === 'verified_individual'
        ? 'consensus_verified_individual'
        : args.selection.source === 'best_individual'
          ? 'consensus_fallback_best_individual'
          : 'consensus';

    const finalResponse =
      args.selection.source === 'synthesis'
        ? args.aggregated.response
        : args.bestVoter.execution.response;

    const qualityScore =
      args.selection.source === 'synthesis'
        ? args.aggregated.confidence
        : (args.bestVoter.evaluation.score ?? 0);

    const artifacts: ConsensusStrategyArtifacts = {
      strategyName: 'consensus',
      effectiveStrategyId: effective,
      ...args.baseArtifactFields,
      finalSelection: args.selection,
      partialDegradation: args.partialDegradation,
      partialDegradationReason: args.partialDegradationReason,
    };

    const aggregationMethod =
      args.selection.source === 'synthesis'
        ? 'synthesis'
        : args.selection.source === 'verified_individual'
          ? 'verified_individual'
          : 'best_individual_fallback';

    return {
      strategyUsed: args.metadata.name,
      modelsUsed: args.executions,
      finalResponse,
      totalCost: args.totalCost,
      totalDuration: Date.now() - args.startTime,
      qualityScore,
      metadata: {
        strategyId: args.metadata.id,
        effectiveStrategyId: effective,
        votingModels: args.selectedModels.map((m) => m.id),
        consensusReached:
          args.selection.source === 'synthesis' && args.aggregated.confidence >= 0.6,
        aggregationMethod,
        aggregationMetadata: args.aggregated.metadata,
        consensusArtifacts: artifacts,
        ...(args.reasoningTraces?.length ? { reasoning_traces: args.reasoningTraces } : {}),
      },
    };
  }

  supportsStreaming(): boolean {
    // Streaming is disabled until the evaluator/outlier/fallback pipeline
    // is wired into the streaming path. Engines MUST fall back to
    // execute() for consensus. See `executeStream()` below for the
    // explicit block + rationale.
    return false;
  }

  /**
   * Streaming path is BLOCKED.
   *
   * The previous streaming implementation fanned-out + synthesised without
   * going through the evaluator, outlier detector, or final-selector —
   * meaning it could silently emit a synthesis response that the
   * non-streaming execute() would have rejected via best-individual
   * fallback. Until parity is implemented, calling executeStream()
   * throws explicitly so callers don't accidentally bypass evaluation.
   *
   * Engines should check `supportsStreaming()` before calling this path
   * (it returns false). If you reach this method, that contract was
   * violated upstream.
   */
  async *executeStream(
    _request: ChatRequest,
    _context: OrchestrationContext
  ): AsyncGenerator<ChatResponse, void, unknown> {
    throw new Error(
      'ConsensusStrategy.executeStream() is disabled: streaming would bypass the ' +
        'evaluator/outlier/fallback pipeline. Engines must use execute() until ' +
        'streaming parity lands. supportsStreaming() returns false to enforce this.',
    );
    // Original streaming body removed (deletion preserves the property
    // that there is exactly ONE runtime path through consensus, and it
    // goes through evaluator + outlier + fallback). Re-enabling streaming
    // requires implementing the full pipeline in the streaming variant.
    // Unreachable (the throw above always fires). Kept only to satisfy the
    // require-yield lint rule; narrowAs is the sanctioned cast (no `as unknown as`).
    yield* narrowAs<AsyncGenerator<ChatResponse, void, unknown>>([]);
  }

  /**
   * Select diverse models for consensus
   * Ensures variety in model families and capabilities.
   *
   * Caminho-C Q2 cross-strategy honor (2026-04-29): if the user pinned a
   * model via `request.model` (surfaced on `context.preferredModelIds[0]`
   * by buildContext), the pin is honored as the FIRST voter — preserving
   * the user's intent — and the remaining slots are filled by the
   * provider-diversity round-robin so consensus retains its anti-bias
   * guarantee. If the pinned model isn't in the operational pool
   * (filtered for health/balance/capability gates, typo, namespace
   * mismatch), we log a warn and fall through to legacy selection so
   * the user gets an answer instead of a 404.
   */
  private async selectDiverseModels(
    models: Model[],
    count: number,
    context?: OrchestrationContext,
  ): Promise<Model[]> {
    const preference = context
      ? resolvePreferredExecutor(models, context, [])
      : undefined;

    if (preference?.pinReason === 'pin-not-in-pool') {
      this.log.warn(
        {
          requestId: context?.requestId,
          requestedModel: preference.requestedId,
          poolSize: models.length,
        },
        'Consensus strategy: requested model not in operational pool — falling back to provider-diverse selection',
      );
    }

    // The pool we run diversity selection on excludes the pinned model
    // (if present) so we don't double-count it. The pin gets prepended
    // back at the end via withPreferredFirst.
    const pool = preference?.pinnedExecutor
      ? models.filter((m) => m.id !== preference.pinnedExecutor!.id)
      : models;
    const remainingCount = preference?.pinnedExecutor
      ? Math.max(0, count - 1)
      : count;

    // Group remaining models by provider
    const byProvider: Record<string, Model[]> = {};

    for (const model of pool) {
      const provider = model.provider || 'unknown';
      if (!byProvider[provider]) {
        byProvider[provider] = [];
      }
      byProvider[provider].push(model);
    }

    // Select one model from each provider (round-robin)
    const selected: Model[] = [];
    const providers = Object.keys(byProvider);
    let providerIndex = 0;

    while (selected.length < remainingCount && selected.length < pool.length) {
      const provider = providers[providerIndex % providers.length];
      const providerModels = byProvider[provider];

      if (providerModels && providerModels.length > 0) {
        // Select best model from this provider that hasn't been selected
        const candidate = providerModels.find((m) => !selected.includes(m));
        if (candidate) {
          selected.push(candidate);
        }
      }

      providerIndex++;

      // Safety: Break if we've cycled through all providers
      if (providerIndex > providers.length * remainingCount) {
        break;
      }
    }

    // If still need more, add remaining models
    if (selected.length < remainingCount) {
      for (const model of pool) {
        if (!selected.includes(model) && selected.length < remainingCount) {
          selected.push(model);
        }
      }
    }

    // Prepend the pinned executor (if any) at index 0 so the user's
    // model is the FIRST voter — keeps user intent visible in audit logs
    // and the response ordering.
    return preference
      ? withPreferredFirst(preference, selected)
      : selected;
  }
}

// ─── Module-level helpers (kept outside the class so they're trivially
//     testable as pure functions and don't carry `this` baggage) ──────

type EvaluatedVoterRecord = {
  readonly execution: ModelExecution;
  readonly output: string;
  readonly evaluation: EvaluationResult;
  readonly outlierDetection: OutlierDetectionResult;
};

/**
 * Provider-reported truncation (finish_reason='length') for a reply. Feeds the
 * 'full'-scope completeness gate in verified selection: a clipped artifact still
 * contains the structural needles (they sit in its first few hundred bytes) but
 * is non-runnable, so it must never be SELECTED as the verified winner.
 */
function responseTruncated(response: ChatResponse | undefined): boolean {
  return response?.choices?.some((c) => c.finish_reason === 'length') === true;
}

/** Decision payload of `detectPreSynthesisShortCircuit` (2026-07-03). */
type PreSynthesisShortCircuit = {
  readonly voter: EvaluatedVoterRecord;
  readonly source: 'verified_individual' | 'agreement_individual';
  readonly effectiveStrategyId: ConsensusEffectiveStrategyId;
  readonly fallbackReason: string;
  /** Checker pass-rate or agreement ratio — used as qualityScore fallback. */
  readonly confidence: number;
  readonly verification?: ConsensusStrategyArtifacts['verification'];
  readonly agreement?: ConsensusStrategyArtifacts['agreementShortCircuit'];
  readonly observerSummary: string;
};

/**
 * Pick the voter with the highest score. Voters with `undefined` scores
 * are ranked LAST (treated as `-Infinity` for ordering purposes), so a
 * voter that has a score always beats one that doesn't. When no voter
 * has a score, the first survivor wins — stable, deterministic for a
 * given input order.
 */
function pickBestVoter<T extends EvaluatedVoterRecord>(pool: readonly T[]): T {
  return pool.reduce((acc, cur) => {
    const a = acc.evaluation.score ?? -Infinity;
    const b = cur.evaluation.score ?? -Infinity;
    return b > a ? cur : acc;
  });
}

function toParticipantArtifact(v: EvaluatedVoterRecord): ConsensusParticipantArtifact {
  return {
    modelId: v.execution.modelId,
    modelName: v.execution.modelName,
    success: v.execution.success,
    error: v.execution.success ? undefined : (v.execution.error ?? 'execution_failed'),
    latencyMs: typeof v.execution.durationMs === 'number' ? v.execution.durationMs : undefined,
    costUsd: typeof v.execution.cost === 'number' ? v.execution.cost : undefined,
    individualScore: v.execution.success ? v.evaluation.score : undefined,
    evaluatorVerdict: v.execution.success ? v.evaluation.verdict : undefined,
    outlier: v.outlierDetection.outlier ? true : undefined,
    outlierReason: v.outlierDetection.outlierReason,
    outputLength: v.output.length > 0 ? v.output.length : undefined,
  };
}

function inferExpectedFormat(
  taskType: string | undefined,
): 'json' | 'code' | 'reasoning' | 'free_text' | undefined {
  if (!taskType) return undefined;
  const t = taskType.toLowerCase();
  if (t.indexOf('json') !== -1) return 'json';
  if (t.indexOf('code') !== -1) return 'code';
  if (t.indexOf('reasoning') !== -1 || t.indexOf('analysis') !== -1) return 'reasoning';
  return undefined;
}

/**
 * Strategy 01C.0.1 — extract the consensus execution plan from a
 * chat request. The dry-run service and chat-request-processor
 * attach the plan as `request.consensusPlan` via structural typing.
 * We never mutate the request; this helper just narrows the cast.
 */
export function readConsensusPlan(
  request: ChatRequest,
): ConsensusExecutionPlan | undefined {
  const r = request as ChatRequest & { consensusPlan?: ConsensusExecutionPlan };
  if (!r.consensusPlan) return undefined;
  if (r.consensusPlan.strategyName !== 'consensus') return undefined;
  return r.consensusPlan;
}

/**
 * Strategy 01C.0.2 — compute per-planned-participant success flags
 * and failure reasons. The strategy ALREADY ran every model in
 * `plannedParticipantModelIds` (because plan.participants seeded
 * selectedModels) — we just look up each planned id in `evaluated`
 * and report success = (executed.success && !outlier).
 *
 * When planSource !== 'dynamic_role_resolver' (legacy/no plan), we
 * return empty arrays — the artifact builder will fill in vacuous
 * success=true defaults so downstream SOTA gates ignore the field.
 */
export function computeHybridParityForPlan(input: {
  readonly plannedParticipantModelIds: readonly string[];
  readonly evaluated: ReadonlyArray<{
    readonly execution: { modelId: string; success: boolean; error?: string };
    readonly outlierDetection: { outlier: boolean; outlierReason?: string };
  }>;
  readonly planSource: PlanSource;
}): {
  successFlags: readonly boolean[];
  failureReasons: readonly (ParticipantFailureReason | undefined)[];
} {
  if (input.planSource !== 'dynamic_role_resolver' || input.plannedParticipantModelIds.length === 0) {
    return { successFlags: [], failureReasons: [] };
  }
  const byId = new Map<string, (typeof input.evaluated)[number]>();
  for (const e of input.evaluated) byId.set(e.execution.modelId, e);
  const successFlags: boolean[] = [];
  const failureReasons: (ParticipantFailureReason | undefined)[] = [];
  for (const id of input.plannedParticipantModelIds) {
    const e = byId.get(id);
    if (!e) {
      // Plan asked for this id but execution never ran it — counts as failure.
      successFlags.push(false);
      failureReasons.push('unknown');
      continue;
    }
    const success = e.execution.success && !e.outlierDetection.outlier;
    successFlags.push(success);
    failureReasons.push(
      success
        ? undefined
        : classifyParticipantFailure({
            executionSuccess: e.execution.success,
            executionError: e.execution.error,
            outlier: e.outlierDetection.outlier,
            outlierReason: e.outlierDetection.outlierReason,
          }),
    );
  }
  return { successFlags, failureReasons };
}

/**
 * Strategy 01C.0.2 — classify a participant's failure into one of the
 * fixed reason buckets. Reads `execution.error` (when execution failed)
 * or `outlierDetection.outlierReason` (when execution succeeded but
 * the output was rejected by the evaluator/structural filter).
 *
 * Mapping intentionally biases toward provider-side root causes when
 * the error string carries clear signals — operators need to see "this
 * was a provider 402, not a strategy bug".
 */
export function classifyParticipantFailure(input: {
  readonly executionSuccess: boolean;
  readonly executionError?: string;
  readonly outlier: boolean;
  readonly outlierReason?: string;
}): ParticipantFailureReason | undefined {
  if (input.executionSuccess && !input.outlier) return undefined;
  if (!input.executionSuccess) {
    const err = (input.executionError ?? '').toLowerCase();
    if (err.indexOf('402') !== -1 || err.indexOf('no credit') !== -1 || err.indexOf('insufficient') !== -1) {
      return 'no_credits';
    }
    if (err.indexOf('401') !== -1 || err.indexOf('auth') !== -1 || err.indexOf('unauthor') !== -1) {
      return 'auth_failed';
    }
    if (err.indexOf('429') !== -1 || err.indexOf('rate') !== -1 || err.indexOf('quota') !== -1) {
      return 'rate_limited';
    }
    if (err.indexOf('timeout') !== -1 || err.indexOf('timed out') !== -1) {
      return 'timeout';
    }
    if (err.indexOf('not found') !== -1 || err.indexOf('404') !== -1 || err.indexOf('model_not_found') !== -1) {
      return 'model_not_found';
    }
    if (err.indexOf('unsupported') !== -1) return 'unsupported_model';
    if (err.indexOf('invalid') !== -1) return 'invalid_response';
    if (err.indexOf('exception') !== -1) return 'exception';
    if (err.length === 0) return 'unknown';
    return 'provider_error';
  }
  // Execution succeeded but voter was flagged as outlier.
  if (input.outlier) {
    if (input.outlierReason === 'empty_output') return 'empty_response';
    if (input.outlierReason === 'invalid_json') return 'invalid_response';
    return 'outlier_rejected';
  }
  return undefined;
}

/**
 * Build the plan-parity artifact. Reports planned-vs-executed for
 * every role the plan filled, plus the judge-selection source so
 * operators can tell whether a static env id was used.
 *
 * Strategy 01C.0.2 — Hybrid parity: also computes per-planned
 * execution success, classified failure reasons, and the
 * planExecutionDegraded SOTA gate. The minRequiredParticipants
 * argument controls the gate threshold (default 3 for `consensus`).
 */
export function buildPlanParityArtifact(input: {
  readonly planSource: PlanSource;
  readonly plannedParticipantModelIds: readonly string[];
  readonly executedParticipantModelIds: readonly string[];
  /** Per-planned: did the planned voter run AND return a usable output?
   *  Aligns 1:1 with `plannedParticipantModelIds`. */
  readonly plannedParticipantExecutionSuccess?: readonly boolean[];
  /** Per-planned failure reason; aligns 1:1 with the array above. */
  readonly plannedParticipantFailureReasons?: readonly (ParticipantFailureReason | undefined)[];
  /** Count of voters that passed outlier-filter — drives synthesis viability. */
  readonly effectiveParticipantCount?: number;
  readonly plannedSynthesizerModelId?: string;
  readonly executedSynthesizerModelId?: string;
  readonly synthesizerSelectionSource?: SynthesizerSelectionSource;
  /** True when a pre-synthesis short-circuit deliberately skipped the planned
   *  synthesizer (checker-verified voter / voter agreement). The skip is an
   *  optimization, not a degradation — suppresses `synthesizer_mismatch`. */
  readonly synthesisSkippedByShortCircuit?: boolean;
  readonly plannedJudgeModelId?: string;
  readonly executedJudgeModelId?: string;
  readonly plannedFallbackModelId?: string;
  readonly executedFallbackModelId?: string;
  readonly evaluatorMode: string;
  /** SOTA threshold — default 3 (consensus minimum). */
  readonly minRequiredParticipants?: number;
}): ConsensusPlanParityArtifact {
  const participantsMatch =
    input.plannedParticipantModelIds.length > 0
      ? setsEqual(input.plannedParticipantModelIds, input.executedParticipantModelIds)
      : input.planSource !== 'dynamic_role_resolver';

  const successFlags =
    input.plannedParticipantExecutionSuccess ??
    input.plannedParticipantModelIds.map(() => true); // legacy/no-plan: treat as success
  const failureReasons =
    input.plannedParticipantFailureReasons ??
    input.plannedParticipantModelIds.map(() => undefined);
  const successfulCount = successFlags.filter(Boolean).length;
  const failedCount = successFlags.length - successfulCount;
  const effectiveCount = input.effectiveParticipantCount ?? successfulCount;

  const synthesizerMatch = input.plannedSynthesizerModelId
    ? input.plannedSynthesizerModelId === input.executedSynthesizerModelId
    : input.planSource !== 'dynamic_role_resolver';
  const judgeMatch = input.plannedJudgeModelId
    ? input.plannedJudgeModelId === input.executedJudgeModelId
    : input.planSource !== 'dynamic_role_resolver';
  const fallbackMatch = input.plannedFallbackModelId
    ? input.plannedFallbackModelId === input.executedFallbackModelId
    : input.planSource !== 'dynamic_role_resolver';

  let judgeSelectionSource: JudgeSelectionSource;
  if (input.evaluatorMode === 'unavailable') {
    judgeSelectionSource = 'unavailable';
  } else if (input.plannedJudgeModelId) {
    judgeSelectionSource = 'dynamic_role_resolver';
  } else {
    judgeSelectionSource = 'env_fallback';
  }

  let synthesizerSelectionSource: SynthesizerSelectionSource;
  if (input.synthesizerSelectionSource) {
    synthesizerSelectionSource = input.synthesizerSelectionSource;
  } else if (!input.plannedSynthesizerModelId && !input.executedSynthesizerModelId) {
    synthesizerSelectionSource = 'unavailable';
  } else if (input.plannedSynthesizerModelId && !input.executedSynthesizerModelId) {
    synthesizerSelectionSource = 'unavailable';
  } else if (!input.plannedSynthesizerModelId && input.executedSynthesizerModelId) {
    synthesizerSelectionSource = 'legacy_aggregator';
  } else if (synthesizerMatch) {
    synthesizerSelectionSource = 'dynamic_role_resolver';
  } else {
    synthesizerSelectionSource = 'mismatch';
  }

  // SOTA gate — Hybrid parity policy:
  //   degraded if plan was offered AND
  //     - successful planned count < min, OR
  //     - effective participant count < min, OR
  //     - synthesizer was planned but didn't match, OR
  //     - judge was planned but didn't match.
  const minRequired = input.minRequiredParticipants ?? 3;
  let planExecutionDegraded = false;
  let planExecutionDegradationReason: string | undefined;
  if (input.planSource === 'dynamic_role_resolver') {
    if (successfulCount < minRequired) {
      planExecutionDegraded = true;
      planExecutionDegradationReason = 'insufficient_successful_participants';
    } else if (effectiveCount < minRequired) {
      planExecutionDegraded = true;
      planExecutionDegradationReason = 'insufficient_effective_participants';
    } else if (
      input.plannedSynthesizerModelId &&
      !synthesizerMatch &&
      !input.synthesisSkippedByShortCircuit
    ) {
      planExecutionDegraded = true;
      planExecutionDegradationReason = 'synthesizer_mismatch';
    } else if (input.plannedJudgeModelId && !judgeMatch) {
      planExecutionDegraded = true;
      planExecutionDegradationReason = 'judge_mismatch';
    }
  }

  return {
    planSource: input.planSource,
    plannedParticipantModelIds: input.plannedParticipantModelIds,
    executedParticipantModelIds: input.executedParticipantModelIds,
    participantModelsMatchPlan: participantsMatch,
    plannedParticipantExecutionSuccess: successFlags,
    plannedParticipantFailureReasons: failureReasons,
    successfulParticipantCount: successfulCount,
    failedParticipantCount: failedCount,
    effectiveParticipantCount: effectiveCount,
    plannedSynthesizerModelId: input.plannedSynthesizerModelId,
    executedSynthesizerModelId: input.executedSynthesizerModelId,
    synthesizerMatchesPlan: synthesizerMatch,
    synthesizerSelectionSource,
    plannedJudgeModelId: input.plannedJudgeModelId,
    executedJudgeModelId: input.executedJudgeModelId,
    judgeModelMatchesPlan: judgeMatch,
    plannedFallbackModelId: input.plannedFallbackModelId,
    executedFallbackModelId: input.executedFallbackModelId,
    fallbackMatchesPlan: fallbackMatch,
    judgeSelectionSource,
    planExecutionDegraded,
    planExecutionDegradationReason,
  };
}

function setsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}
