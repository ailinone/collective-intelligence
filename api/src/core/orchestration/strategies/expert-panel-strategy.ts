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
import { resolvePreferredExecutor } from './preferred-model-helper';
import {
  persistExpertPanelRun,
  type ExpertPanelSignalInput,
} from '@/core/coordination/collective-run-repository';
import { buildEnsembleRequest } from '@/core/coordination/ensemble-coordinator-client';
import {
  runEnsembleInShadow,
  type ShadowEnsembleSnapshot,
} from '@/core/coordination/ensemble-coordinator-shadow';
import { nanoid } from 'nanoid';
import type {
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
  ModelExecution,
  Model,
  ModelRole,
} from '@/types';

interface InternalExecution {
  model: Model;
  modelId: string;
  modelName: string;
  response: ChatResponse;
  startTime: number;
  endTime: number;
  duration: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  cost: number;
  durationMs: number;
  success: boolean;
}

/**
 * Expert Panel Strategy
 *
 * Multiple specialized models act as "experts" in different domains.
 * Each expert analyzes the request and provides their recommendation.
 * A coordinator model synthesizes all expert inputs into a final response.
 *
 * Best for: Complex problems requiring multi-domain expertise
 *
 * Process:
 * 1. Detect required expertise domains (coding, architecture, testing, etc)
 * 2. Assign specialists to each domain
 * 3. Each expert analyzes the request from their perspective
 * 4. Coordinator synthesizes all expert inputs
 *
 * Example: For a refactoring request:
 * - Code Quality Expert: Reviews current code issues
 * - Performance Expert: Identifies performance bottlenecks
 * - Architecture Expert: Suggests structural improvements
 * - Testing Expert: Recommends testing strategy
 * - Coordinator: Synthesizes into cohesive refactoring plan
 */
export class ExpertPanelStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'expert-panel',
      name: 'expert-panel',
      displayName: 'Expert Panel',
      description:
        'Multiple specialized models provide domain expertise, coordinator synthesizes. Best for complex multi-domain problems.',
      minModels: 3, // At least 2 experts + 1 coordinator
      maxModels: 6, // Up to 5 experts + 1 coordinator
      estimatedCostMultiplier: 2.8, // Multiple experts + coordinator
      estimatedQualityBoost: 0.28, // +28% through diverse expertise
      estimatedDurationMultiplier: 1.5, // Sequential expert consultations
      suitableFor: ['refactoring', 'analysis', 'code-review', 'debugging', 'documentation'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startTime = Date.now();
    // Filter models by capabilities, quality, budget — no audio/image/embedding models
    const models = this.getEligibleModels(context);

    if (models.length < this.getMetadata().minModels!) {
      throw new Error(
        `Expert Panel requires at least ${this.getMetadata().minModels} eligible models; only ${models.length} passed quality/capability filters (from ${context.models.length} total)`
      );
    }

    // 1. Detect required expertise domains — delegate to triage when available
    const domains = this.detectExpertiseDomains(request, context);

    // 2. Select experts + coordinator. Caminho-C Q2 cross-strategy honor:
    //    if user pinned a model via request.model, the pin biases the
    //    coordinator slot (highest-status synthesizer role); experts then
    //    fill from the remaining pool to preserve provider diversity.
    const {
      coordinatorModel,
      expertModels,
      reason: panelReason,
      scheduler: panelScheduler,
    } = this.selectPanel(models, domains, context);

    // F4.1 audit substrate at the call site.
    this.log.info(
      {
        requestId: context.requestId,
        coordinator: coordinatorModel.id,
        expertCount: expertModels.length,
        panelScheduler,
        panelReason,
      },
      'Expert panel composed',
    );

    // Phase 2c shadow integration — fire ensemble in parallel without
    // blocking the heuristic. Snapshot lands on the synthesis signal's
    // decision_value.shadowEnsemble for F3.3 export. NEVER throws.
    let shadowSnapshot: ShadowEnsembleSnapshot | null = null;
    void runEnsembleInShadow(
      buildEnsembleRequest(
        'expert-panel',
        'panel-composition',
        {
          requestId: context.requestId,
          domains,
          coordinatorModelId: coordinatorModel.id,
          coordinatorProviderId: coordinatorModel.provider,
          expertCount: expertModels.length,
          experts: expertModels.map((m) => ({
            modelId: m.id,
            providerId: m.provider,
            quality: m.performance?.quality ?? null,
          })),
          taskType: context.taskType,
          complexity: context.triage?.complexity ?? null,
        },
      ),
      {
        heuristicDecisionForComparison: {
          role: 'coordinator',
          scheduler: panelScheduler,
          reason: panelReason,
        },
        onShadowResult: (snapshot) => {
          shadowSnapshot = snapshot;
        },
      },
    ).catch((err: unknown) => {
      this.log.debug({ err: String(err) }, 'shadow runner promise rejected silently');
    });

    // Observer: phase start
    this.emitObserverEvent(context, { type: 'phase_start', models: expertModels.map(m => m.name || m.id), summary: `Expert panel: ${domains.length} domains (${domains.join(', ')}). Consulting specialists.` });

    // 3. Consult each expert (parallel, independent)
    const expertConsultations = await this.consultExperts(request, expertModels, domains, context);

    // 3.5. Cross-review — each expert briefly reviews one other expert's output
    // This catches blind spots and contradictions BEFORE synthesis
    if (process.env.EXPERT_PANEL_CROSS_REVIEW !== 'false' && expertConsultations.length >= 2) {
      this.log.info({ experts: expertConsultations.length }, 'Expert panel: cross-review phase');
      // C3 dev fix (2026-06-09): run cross-reviews IN PARALLEL. Each reviewer i reviews a DIFFERENT,
      // already-completed reviewee (i+1 mod n) and writes only its OWN slot (reviewer.execution.crossReview)
      // — no read/write conflict between iterations — so the previous sequential `for` (3-5 serial HTTP
      // calls) needlessly serialized. ~9-20s saved on long-form.
      await Promise.all(expertConsultations.map(async (reviewer, i) => {
        const reviewee = expertConsultations[(i + 1) % expertConsultations.length];
        const revieweeContent = reviewee.execution.response?.choices?.[0]?.message?.content;
        const revieweeText = typeof revieweeContent === 'string' ? revieweeContent.slice(0, 1500) : '';
        if (!revieweeText || !this.getAdapterForModel) return;

        try {
          const model = reviewer.execution.model as import('@/types').Model;
          if (!model) return;
          const adapter = await this.getAdapterForModel(model, context);
          if (!adapter) return;

          const crossReviewReq: ChatRequest = {
            ...request,
            messages: [{
              role: 'user',
              content: `As a ${reviewer.domain} expert, briefly review this ${reviewee.domain} expert's analysis. Note any errors, missing considerations, or points that contradict your own analysis. Be concise (2-3 points max).\n\nTheir analysis:\n${revieweeText}`,
            }],
            max_tokens: 500,
          };
          const crossModelExec = await this.executeModel(adapter, model, crossReviewReq, 'reviewer');
          const crossContent = crossModelExec.response?.choices?.[0]?.message?.content;
          if (typeof crossContent === 'string' && crossContent.length > 20) {
            (reviewer.execution as { crossReview?: string }).crossReview = crossContent;
          }
        } catch { /* cross-review failure is non-fatal */ }
      }));
    }

    // Observer: experts done
    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 1, summary: `${expertConsultations.length} expert assessments received. Coordinator synthesizing.` });
    this.emitObserverEvent(context, { type: 'synthesis_start', modelName: coordinatorModel.name || coordinatorModel.id, summary: 'Coordinator integrating multi-domain expert inputs.' });

    // 4. Coordinator synthesizes expert inputs (now with cross-review notes)
    const finalResponse = await this.coordinateSynthesis(
      request,
      expertConsultations,
      coordinatorModel,
      context
    );

    // Observer: synthesis complete
    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: `Expert panel synthesis complete across ${domains.length} domains.` });

    // 5. Calculate metrics
    const duration = Date.now() - startTime;
    const totalCost = this.calculateTotalCost(expertConsultations, finalResponse.execution);
    const qualityScore = this.calculatePanelQualityScore(
      expertConsultations,
      finalResponse.execution
    );

    const allExecutions: ModelExecution[] = [
      ...expertConsultations.map((c) => ({
        modelId: c.execution.model.id,
        modelName: c.execution.model.name,
        role: `expert-${c.domain}` as ModelRole,
        request,
        response: c.execution.response,
        cost: c.execution.cost,
        durationMs: c.execution.duration,
        success: c.execution.success,
      })),
      {
        modelId: coordinatorModel.id,
        modelName: coordinatorModel.name,
        role: 'coordinator' as ModelRole,
        request,
        response: finalResponse.execution.response,
        cost: finalResponse.execution.cost,
        durationMs: finalResponse.execution.duration,
        success: finalResponse.execution.success,
      },
    ];

    // F4.1 audit-flow extension — persist when CI_COORDINATION_PERSIST_AUDIT
    // is on. Best-effort: any failure is logged inside persistExpertPanelRun.
    if (process.env.CI_COORDINATION_PERSIST_AUDIT === 'true' && context.organizationId) {
      try {
        const totalTokens =
          expertConsultations.reduce(
            (sum, c) => sum + c.execution.usage.prompt_tokens + c.execution.usage.completion_tokens,
            0,
          ) + finalResponse.execution.usage.prompt_tokens + finalResponse.execution.usage.completion_tokens;

        const participatingModels: ReadonlyArray<{ modelId: string; modelName: string; providerId: string }> = [
          ...expertConsultations.map((c) => ({
            modelId: c.execution.model.id,
            modelName: c.execution.model.name ?? c.execution.model.id,
            providerId: c.execution.model.provider,
          })),
          {
            modelId: coordinatorModel.id,
            modelName: coordinatorModel.name ?? coordinatorModel.id,
            providerId: coordinatorModel.provider,
          },
        ];

        const flatSignals: ExpertPanelSignalInput[] = [];
        // Round 1: expert consultations
        for (const c of expertConsultations) {
          const text = typeof c.execution.response?.choices?.[0]?.message?.content === 'string'
            ? c.execution.response.choices[0].message.content
            : '';
          flatSignals.push({
            round: 1,
            agentName: c.execution.modelName,
            modelId: c.execution.model.id,
            providerId: c.execution.model.provider,
            role: 'expert',
            decisionType: 'expert-opinion',
            text,
            domain: c.domain,
            durationMs: c.execution.duration,
            cost: c.execution.cost,
            inputTokens: c.execution.usage.prompt_tokens,
            outputTokens: c.execution.usage.completion_tokens,
          });
        }
        // Round 2: cross-reviews (when present — written in-place to expert.execution.crossReview)
        const crossReviewEnabled = process.env.EXPERT_PANEL_CROSS_REVIEW !== 'false' && expertConsultations.length >= 2;
        if (crossReviewEnabled) {
          for (let i = 0; i < expertConsultations.length; i++) {
            const reviewer = expertConsultations[i];
            const reviewee = expertConsultations[(i + 1) % expertConsultations.length];
            const crossReviewText = (reviewer.execution as { crossReview?: string }).crossReview;
            if (typeof crossReviewText === 'string' && crossReviewText.length > 0) {
              flatSignals.push({
                round: 2,
                agentName: reviewer.execution.modelName,
                modelId: reviewer.execution.model.id,
                providerId: reviewer.execution.model.provider,
                role: 'reviewer',
                decisionType: 'cross-review',
                text: crossReviewText,
                domain: reviewer.domain,
                reviewedExpert: reviewee.execution.modelName,
                durationMs: 0, // cross-review duration is rolled into the reviewer's consultation
                cost: 0,
                inputTokens: 0,
                outputTokens: 0,
              });
            }
          }
        }
        // Round 3: coordinator synthesis
        flatSignals.push({
          round: crossReviewEnabled ? 3 : 2,
          agentName: coordinatorModel.name ?? coordinatorModel.id,
          modelId: coordinatorModel.id,
          providerId: coordinatorModel.provider,
          role: 'coordinator',
          decisionType: 'synthesis',
          text: typeof finalResponse.execution.response?.choices?.[0]?.message?.content === 'string'
            ? finalResponse.execution.response.choices[0].message.content
            : '',
          durationMs: finalResponse.execution.duration,
          cost: finalResponse.execution.cost,
          inputTokens: finalResponse.execution.usage.prompt_tokens,
          outputTokens: finalResponse.execution.usage.completion_tokens,
          schedulerName: panelScheduler,
          decisionReason: panelReason,
          // Phase 2c shadow ensemble — closure-captured snapshot, null
          // when shadow disabled/timed-out/errored or hook hasn't fired
          // yet by persist time.
          shadowEnsemble: shadowSnapshot,
        });

        // C3 dev fix (2026-06-09): audit persistence off the hot path (fire-and-forget).
        void persistExpertPanelRun({
          organizationId: context.organizationId,
          requestId: context.requestId,
          runId: nanoid(),
          config: {
            expertCount: expertConsultations.length,
            domains,
            crossReviewEnabled,
          },
          panelScheduler,
          panelReason,
          stopReason: 'completed',
          totalCostUsd: totalCost,
          totalLatencyMs: duration,
          totalTokens,
          participatingModels,
          signals: flatSignals,
        }).catch(() => { /* audit persistence is non-critical and off the hot path */ });
      } catch (err) {
        this.log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'Expert-panel persistence threw — continuing',
        );
      }
    }

    return {
      strategyUsed: this.getMetadata().name,
      modelsUsed: allExecutions,
      finalResponse: finalResponse.execution.response,
      totalCost,
      totalDuration: duration,
      qualityScore,
      metadata: {
        domains: domains,
        expertCount: expertConsultations.length,
        expertRecommendations: expertConsultations.map((c) => ({
          domain: c.domain,
          model: c.execution.model.id,
          recommendation: this.extractRecommendation(c.execution.response),
        })),
        synthesisApproach: 'coordinator-integration',
        ...(this.isReasoningEnabled(request) ? {
          reasoning_traces: expertConsultations
            .filter(c => (c.execution as { reasoning?: string }).reasoning)
            .map(c => ({
              model_id: c.execution.modelId,
              model_name: c.execution.modelName,
              role: `expert-${c.domain}`,
              reasoning: (c.execution as { reasoning?: string }).reasoning,
              reasoning_tokens: (c.execution as { reasoningTokens?: number }).reasoningTokens,
            })),
        } : {}),
      },
    };
  }

  supportsStreaming(): boolean { return true; }

  async *executeStream(request: ChatRequest, context: OrchestrationContext): AsyncGenerator<ChatResponse, void, unknown> {
    const models = this.getEligibleModels(context);
    if (models.length < 3) throw new Error('Expert panel requires at least 3 models');
    const domains = this.detectExpertiseDomains(request, context);
    const { coordinatorModel, expertModels } = this.selectPanel(models, domains, context);

    this.emitObserverEvent(context, { type: 'phase_start', models: expertModels.map(m => m.name || m.id), summary: `Expert panel: ${domains.length} domains (${domains.join(', ')}).` });
    yield this.progressChunk(`Consulting ${expertModels.length} domain experts...`, 0, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Phase 1: consult experts (parallel)
    const expertConsultations = await this.consultExperts(request, expertModels, domains, context);

    this.emitObserverEvent(context, { type: 'round_complete', round: 1, totalRounds: 1, summary: `${expertConsultations.length} expert assessments received.` });
    this.emitObserverEvent(context, { type: 'synthesis_start', modelName: coordinatorModel.name || coordinatorModel.id, summary: 'Coordinator integrating expert inputs.' });
    yield this.progressChunk(`${expertConsultations.length} experts consulted, coordinator synthesizing...`, 1, 2);
    for (const c of await this.drainObserverChunks(context)) yield c;

    // Phase 2: stream coordinator synthesis
    if (!this.getAdapterForModel) throw new Error('getAdapterForModel not injected');
    const coordAdapter = await this.getAdapterForModel(coordinatorModel, context);
    if (!coordAdapter) throw new Error(`No adapter for coordinator`);

    const expertInputs = expertConsultations.map(c => {
      const content = safeResponseContent(c.execution.response);
      return `**${c.domain.toUpperCase()} EXPERT:**\n${content}`;
    }).join('\n\n---\n\n');

    let reasoningSection = '';
    if (this.isReasoningEnabled(request)) {
      const traces = expertConsultations
        .filter(c => (c.execution as { reasoning?: string }).reasoning)
        .map(c => `### ${c.domain.toUpperCase()} Expert:\n${(c.execution as { reasoning?: string }).reasoning}`).join('\n\n');
      if (traces) reasoningSection = `\n\n## Expert Reasoning Traces\n${traces}`;
    }

    const coordReq: ChatRequest = {
      ...request,
      messages: [
        { role: 'system', content: `${PROMPTS.expertCoordinator}\n\nEXPERT RECOMMENDATIONS:\n${expertInputs}${reasoningSection}\n\nSynthesize into a unified response.` },
        ...request.messages.filter(m => m.role !== 'system'),
      ],
    };

    // RESILIENT streaming: bare for-await had NO first-token deadline. Route
    // through the fallback-chain helper (first-chunk + idle deadlines, graceful
    // degrade to the raw expert inputs instead of a hard stream failure).
    yield* this.streamSynthesisWithFallback(
      coordReq,
      [{ adapter: coordAdapter, model: coordinatorModel }],
      () => expertInputs.slice(0, 4000),
    );

    this.emitObserverEvent(context, { type: 'synthesis_complete', summary: `Expert panel synthesis complete across ${domains.length} domains.` });
    for (const c of await this.drainObserverChunks(context)) yield c;
  }

  /**
   * Detect which expertise domains are needed for this request.
   *
   * Priority: triage execution plan > triage intent > fallback.
   * The triage model semantically analyzes the request and provides
   * roles/stages/capabilities — no regex pattern matching needed.
   */
  private detectExpertiseDomains(request: ChatRequest, context: OrchestrationContext): string[] {
    // 1. Triage execution plan — has explicit stages with roles and capabilities
    const plan = context.executionPlan;
    if (plan?.stages && plan.stages.length > 0) {
      const domains = plan.stages
        .map((stage) => stage.name)
        .filter((name) => name && name.length > 0);
      if (domains.length >= 2) {
        this.log.info({ source: 'triage-plan', domains }, 'Expert domains from triage execution plan');
        return domains.slice(0, 5);
      }
    }

    // 2. Triage model roles — has role assignments with preferred capabilities
    if (plan?.stages) {
      const roles = plan.stages.flatMap((s) => s.modelRoles || []);
      if (roles.length >= 2) {
        const domains = roles.map((r) => typeof r.role === 'string' ? r.role : 'specialist');
        this.log.info({ source: 'triage-roles', domains }, 'Expert domains from triage model roles');
        return [...new Set(domains)].slice(0, 5);
      }
    }

    // 3. Triage intent + complexity — derive domains from task classification
    const triage = context.triage;
    if (triage?.intent && triage.intent !== 'other') {
      const intent = triage.intent;
      const complexity = triage.complexity || 'medium';
      // Map task intent to expert domains — semantic, not regex
      const intentDomains: Record<string, string[]> = {
        'code-review': ['code-quality', 'architecture', 'testing'],
        'refactoring': ['code-quality', 'architecture', 'performance'],
        'debugging': ['debugging', 'testing', 'performance'],
        'analysis': ['architecture', 'performance', 'security'],
        'documentation': ['documentation', 'architecture', 'general'],
        'general': ['general', 'analysis', 'synthesis'],
        'creative': ['creative', 'synthesis', 'analysis'],
        'reasoning': ['logic', 'analysis', 'verification'],
        'math': ['mathematics', 'logic', 'verification'],
        'support': ['troubleshooting', 'documentation', 'general'],
      };
      const mapped = intentDomains[intent] || ['general', 'analysis', 'synthesis'];
      // High complexity gets more domains
      const count = complexity === 'high' ? 4 : complexity === 'medium' ? 3 : 2;
      const domains = mapped.slice(0, count);
      this.log.info({ source: 'triage-intent', intent, complexity, domains }, 'Expert domains from triage intent');
      return domains;
    }

    // 4. Fallback: generic domains when no triage available (e.g., experiment runner)
    this.log.info({ source: 'fallback' }, 'No triage data — using generic expert domains');
    return ['analysis', 'synthesis', 'verification'];
  }

  /**
   * Select coordinator + experts in a single call, honoring the user pin
   * if set. Caminho-C Q2 cross-strategy honor (2026-04-29):
   *
   *   - If `context.preferredModelIds[0]` is set AND the pinned model is
   *     in the operational pool, it becomes the COORDINATOR (highest-
   *     status role: synthesizes the panel's findings into the final
   *     answer). Experts are then drawn from the remaining pool to
   *     preserve provider diversity.
   *   - If pin is missing from the pool, log a warn and fall through to
   *     legacy quality-sort selection.
   *   - If no pin, behavior is identical to pre-migration.
   *
   * Why coordinator and not expert: the user said "use this model" —
   * the most visible role in the response is the coordinator's synthesis.
   * Putting the pin in an expert slot would dilute it into one of N voices.
   */
  /**
   * Pick coordinator + expert pool. Decision shape mirrors the F4.1
   * audit substrate (RoleDecision in tri-role-collective): the chosen
   * outcome plus the `reason` that fired and the `scheduler` identity.
   *
   * Reasons:
   *   - 'pinned'                          — user pin honored, coordinator = pinned model
   *   - 'pin-not-in-pool-quality-fallback' — pinned model missing, picked by quality
   *   - 'quality-fallback'                — no pin, picked by quality (default path)
   *
   * Scheduler is `'pin-or-quality'` (deterministic). A future F4.1
   * coordinator would emit its own scheduler tag and the rest of the
   * pipeline (logs, audit trail, future training) is already wired.
   */
  private selectPanel(
    availableModels: Model[],
    domains: string[],
    context: OrchestrationContext,
  ): {
    coordinatorModel: Model;
    expertModels: Model[];
    reason: 'pinned' | 'pin-not-in-pool-quality-fallback' | 'quality-fallback';
    scheduler: 'pin-or-quality';
  } {
    const preference = resolvePreferredExecutor(availableModels, context, []);

    if (preference.pinReason === 'pin-not-in-pool') {
      this.log.warn(
        {
          requestId: context.requestId,
          requestedModel: preference.requestedId,
          poolSize: availableModels.length,
          reason: 'pin-not-in-pool-quality-fallback',
          scheduler: 'pin-or-quality',
        },
        'Expert panel: requested model not in operational pool — falling back to quality-sort coordinator selection',
      );
    }

    if (preference.pinReason === 'pinned' && preference.pinnedExecutor) {
      // Pin honored: coordinator = pinned model, experts drawn from
      // fallbackPool (which already excludes the coordinator).
      const coordinatorModel = preference.pinnedExecutor;
      const expertModels = this.selectExperts(preference.fallbackPool as Model[], domains);
      return { coordinatorModel, expertModels, reason: 'pinned', scheduler: 'pin-or-quality' };
    }

    // Legacy path (no pin or pin missing from pool):
    const expertModels = this.selectExperts(availableModels, domains);
    const coordinatorModel = this.selectCoordinator(availableModels, expertModels);
    const reason: 'pin-not-in-pool-quality-fallback' | 'quality-fallback' =
      preference.pinReason === 'pin-not-in-pool' ? 'pin-not-in-pool-quality-fallback' : 'quality-fallback';
    return { coordinatorModel, expertModels, reason, scheduler: 'pin-or-quality' };
  }

  /**
   * Select expert models (diverse providers preferred)
   */
  private selectExperts(availableModels: Model[], domains: string[]): Model[] {
    // Minimum 3 experts — even if fewer domains detected, more perspectives improve quality
    const expertCount = Math.min(Math.max(domains.length, 3), 5);
    const experts: Model[] = [];
    const usedProviders = new Set<string>();

    // Select diverse models (prefer different providers)
    for (let i = 0; i < expertCount; i++) {
      const preferredProvider =
        usedProviders.size < availableModels.length
          ? availableModels.find((m) => !usedProviders.has(m.provider))
          : null;

      const expert = preferredProvider || availableModels[i % availableModels.length];
      experts.push(expert);
      usedProviders.add(expert.provider);
    }

    return experts;
  }

  /**
   * Select coordinator model (prefer high-quality model)
   */
  private selectCoordinator(availableModels: Model[], expertModels: Model[]): Model {
    // Prefer a model not used as an expert
    const unusedModels = availableModels.filter((m) => !expertModels.find((e) => e.id === m.id));

    // Select highest quality available
    const coordinator =
      unusedModels.length > 0
        ? unusedModels.sort((a, b) => {
            const aQuality = a.performance?.quality ?? 0.8;
            const bQuality = b.performance?.quality ?? 0.8;
            return Number(bQuality) - Number(aQuality);
          })[0]
        : availableModels[0];

    return coordinator;
  }

  /**
   * Consult each expert for their analysis
   */
  private async consultExperts(
    request: ChatRequest,
    expertModels: Model[],
    domains: string[],
    context: OrchestrationContext
  ): Promise<Array<{ domain: string; execution: InternalExecution }>> {
    const consultations = await Promise.allSettled(
      expertModels.map(async (model, index) => {
        const domain = domains[index] || 'general';
        if (!this.getAdapterForModel) {
          throw new Error('getAdapterForModel not injected by orchestration engine');
        }
        const adapter = await this.getAdapterForModel(model, context);
        if (!adapter) {
          throw new Error(`No adapter found for model: ${model.id}`);
        }

        // Create expert-specific prompt
        const expertRequest = this.createExpertRequest(request, domain);
        // C3 dev fix (2026-06-09): cap per-expert output (default 1200 tok, env override). Experts
        // produce FOCUSED assessments that the coordinator synthesizes — not full answers. Unbounded
        // specialist generations were the dominant cost keeping expert-panel at ~104s on long-form.
        // Honors a smaller user-set max_tokens.
        const expertCap = Number(process.env.EXPERT_PANEL_EXPERT_MAX_TOKENS) || 1200;
        const cappedExpertRequest = { ...expertRequest, max_tokens: Math.min(Number(expertRequest.max_tokens) || expertCap, expertCap) };

        const modelExec = this.isReasoningEnabled(request)
          ? await this.executeModelWithReasoning(adapter, model, cappedExpertRequest, 'specialist')
          : await this.executeModel(adapter, model, cappedExpertRequest, 'specialist');
        const response = modelExec.response;

        // Reasoning already extracted by executeModelWithReasoning
        const reasoning = modelExec.reasoning;
        const reasoningTokens = modelExec.reasoningTokens;
        // Internal execution format (richer than public ModelExecution).
        // Reuse modelExec's own measured cost/duration (already normalized
        // via executeModel's normalizeCost() call) instead of recomputing —
        // the previous hardcoded duration:0/durationMs:0 discarded real
        // per-subcall timing (Date.now() called twice back-to-back always
        // yields ~0), and the raw adapter.calculateCost() call bypassed the
        // $0-hub-cost estimation fallback. This is what fed the
        // hardness-detail export's internals CSV, which showed 100% of
        // expert-panel subcalls at "/0ms" including multi-dollar calls.
        const execution = {
          model,
          modelId: model.id,
          modelName: model.name,
          response,
          startTime: Date.now() - modelExec.durationMs,
          endTime: Date.now(),
          duration: modelExec.durationMs,
          usage: {
            prompt_tokens: response.usage?.prompt_tokens || 0,
            completion_tokens: response.usage?.completion_tokens || 0,
            total_tokens: response.usage?.total_tokens || 0,
          },
          cost: modelExec.cost,
          durationMs: modelExec.durationMs,
          success: true,
          reasoning,
          reasoningTokens,
        };

        return { domain, execution };
      })
    );

    // Filter successful consultations
    const successful = consultations
      .filter((result) => result.status === 'fulfilled')
      .map((result) => {
        if (result.status === 'fulfilled') {
          return result.value;
        }
        throw new Error('Expert consultation failed');
      });

    // Social Loafing detection (Ringelmann effect prevention):
    // Flag experts whose response is suspiciously short/generic relative to peers
    if (successful.length >= 2) {
      const MIN_EFFORT_RATIO = Number(process.env.EXPERT_PANEL_MIN_EFFORT_RATIO ?? 0.3);
      const lengths = successful.map(c => {
        const content = c.execution.response?.choices?.[0]?.message?.content;
        return typeof content === 'string' ? content.length : 0;
      });
      const avgLength = lengths.reduce((s, l) => s + l, 0) / lengths.length;
      for (let i = 0; i < successful.length; i++) {
        if (avgLength > 0 && lengths[i] < avgLength * MIN_EFFORT_RATIO) {
          this.log.warn({
            expert: successful[i].execution.modelId,
            domain: successful[i].domain,
            responseLength: lengths[i],
            avgLength: Math.round(avgLength),
            ratio: (lengths[i] / avgLength).toFixed(2),
          }, 'Expert panel: social loafing detected — requesting more thorough response');

          // Social Loafing Correction: re-execute with stronger prompt
          if (process.env.EXPERT_PANEL_CORRECT_LOAFING !== 'false') {
            try {
              const model = successful[i].execution.model as import('@/types').Model;
              if (this.getAdapterForModel && model) {
                const adapter = await this.getAdapterForModel(model, context);
                if (adapter) {
                  const retryRequest = this.createExpertRequest(request, successful[i].domain);
                  // Enhanced prompt demanding thoroughness
                  const enhancedRequest: ChatRequest = {
                    ...retryRequest,
                    messages: [
                      { role: 'system', content: 'IMPORTANT: Your previous response was insufficiently thorough. Provide a comprehensive, detailed analysis. Your output will be compared against other experts and scored.' },
                      ...retryRequest.messages,
                    ],
                  };
                  const retryExec = await this.executeModel(adapter, model, enhancedRequest, 'specialist');
                  const retryContent = retryExec.response?.choices?.[0]?.message?.content;
                  const retryLen = typeof retryContent === 'string' ? retryContent.length : 0;
                  if (retryLen > lengths[i]) {
                    // Update the execution with the better response
                    successful[i].execution.response = retryExec.response;
                    this.log.info({ expert: model.id, originalLen: lengths[i], retryLen }, 'Expert panel: loafing corrected — improved response accepted');
                  }
                }
              }
            } catch { /* retry failed — keep original */ }
          }
        }
      }
    }

    return successful;
  }

  /**
   * Create expert-specific request with domain focus
   */
  private createExpertRequest(originalRequest: ChatRequest, domain: string): ChatRequest {
    const expertPrompts: Record<string, string> = {
      'code-quality':
        'As a Code Quality Expert, analyze the following request focusing on code cleanliness, maintainability, best practices, and design patterns. Provide specific recommendations.',
      performance:
        'As a Performance Expert, analyze the following request focusing on speed, efficiency, resource usage, and optimization opportunities. Provide specific recommendations.',
      architecture:
        'As an Architecture Expert, analyze the following request focusing on system design, scalability, modularity, and architectural patterns. Provide specific recommendations.',
      testing:
        'As a Testing Expert, analyze the following request focusing on test coverage, quality assurance, testing strategies, and potential edge cases. Provide specific recommendations.',
      security:
        'As a Security Expert, analyze the following request focusing on vulnerabilities, authentication, authorization, data protection, and security best practices. Provide specific recommendations.',
      debugging:
        'As a Debugging Expert, analyze the following request focusing on identifying root causes, potential bugs, error handling, and debugging strategies. Provide specific recommendations.',
      general:
        'As a General Analysis Expert, provide a comprehensive analysis of the following request with specific recommendations.',
    };

    const baseInstruction = expertPrompts[domain] || expertPrompts['general'];
    const expertInstruction = this.withReasoningPrompt(baseInstruction, originalRequest);

    return {
      ...originalRequest,
      messages: [
        {
          role: 'system',
          content: expertInstruction,
        },
        ...originalRequest.messages,
      ],
    };
  }

  /**
   * Coordinator synthesizes all expert inputs
   */
  private async coordinateSynthesis(
    originalRequest: ChatRequest,
    expertConsultations: Array<{ domain: string; execution: InternalExecution }>,
    coordinatorModel: Model,
    context: OrchestrationContext
  ): Promise<{ execution: InternalExecution }> {
    if (!this.getAdapterForModel) {
      throw new Error('getAdapterForModel not injected by orchestration engine');
    }
    const adapter = await this.getAdapterForModel(coordinatorModel, context);
    if (!adapter) {
      throw new Error(`No adapter found for coordinator model: ${coordinatorModel.id}`);
    }

    // Compile expert recommendations
    const expertInputs = expertConsultations
      .map((consultation) => {
        const content = safeResponseContent(consultation.execution.response);
        return `**${consultation.domain.toUpperCase()} EXPERT:**\n${content}`;
      })
      .join('\n\n---\n\n');

    // Include reasoning traces from experts so coordinator understands HOW they reasoned
    let reasoningSection = '';
    if (this.isReasoningEnabled(originalRequest)) {
      const traces = expertConsultations
        .filter(c => (c.execution as { reasoning?: string }).reasoning)
        .map(c => `### ${c.domain.toUpperCase()} Expert — Reasoning:\n${(c.execution as { reasoning?: string }).reasoning}`)
        .join('\n\n');
      if (traces) {
        reasoningSection = `\n\n## Expert Reasoning Traces\nUse these to understand HOW each expert arrived at their recommendations:\n\n${traces}`;
      }
    }

    // Create synthesis request
    const synthesisRequest: ChatRequest = {
      ...originalRequest,
      messages: [
        {
          role: 'system',
          content: `${PROMPTS.expertCoordinator}

EXPERT RECOMMENDATIONS:
${expertInputs}${reasoningSection}

Synthesize these expert inputs into a unified, practical response that:
1. Integrates all relevant expert insights
2. Resolves any conflicts between recommendations
3. Prioritizes actionable steps
4. Provides a clear, implementable plan

Be concise but comprehensive.`,
        },
        ...originalRequest.messages.filter((m) => m.role !== 'system'),
      ],
    };

    const coordExec = await this.executeModel(adapter, coordinatorModel, synthesisRequest, 'coordinator');
    const response = coordExec.response;

    // Internal execution format (richer than public ModelExecution).
    // Reuse coordExec's own measured cost/duration — see the matching fix
    // in consultExperts() above for why hardcoding these to 0 was wrong.
    const execution = {
      model: coordinatorModel,
      modelId: coordinatorModel.id,
      modelName: coordinatorModel.name,
      response,
      startTime: Date.now() - coordExec.durationMs,
      endTime: Date.now(),
      duration: coordExec.durationMs,
      usage: {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
      },
      cost: coordExec.cost,
      durationMs: coordExec.durationMs,
      success: true,
    };

    return { execution };
  }

  /**
   * Extract key recommendation from expert response
   */
  private extractRecommendation(response: ChatResponse): string {
    const contentStr = safeResponseContent(response);

    // Extract first 200 chars as summary
    return contentStr.substring(0, 200).trim() + (contentStr.length > 200 ? '...' : '');
  }

  /**
   * Calculate total cost across all expert consultations
   */
  private calculateTotalCost(
    expertConsultations: Array<{ domain: string; execution: InternalExecution }>,
    coordinatorExecution: InternalExecution
  ): number {
    const expertCosts = expertConsultations.reduce((sum, c) => sum + c.execution.cost, 0);
    return expertCosts + coordinatorExecution.cost;
  }

  /**
   * Calculate quality score based on expert panel coverage
   */
  private calculatePanelQualityScore(
    expertConsultations: Array<{ domain: string; execution: InternalExecution }>,
    coordinatorExecution: InternalExecution
  ): number {
    let score = 0.7; // Base score

    // Bonus for multiple experts (+0.05 per expert, max +0.15)
    score += Math.min(expertConsultations.length * 0.05, 0.15);

    // Bonus for diverse domains (+0.03 per unique domain, max +0.15)
    const uniqueDomains = new Set(expertConsultations.map((c) => c.domain));
    score += Math.min(uniqueDomains.size * 0.03, 0.15);

    // Bonus for coordinator quality
    const coordinatorContentStr = safeResponseContent(coordinatorExecution.response);

    if (coordinatorContentStr.length > 500) score += 0.05;
    if (coordinatorContentStr.includes('```')) score += 0.05; // Has code examples

    return Math.min(score, 0.98); // Cap at 0.98
  }

  /**
   * Get last user message content
   */
  private getLastUserMessage(request: ChatRequest): string {
    const userMessages = request.messages.filter((m) => m.role === 'user');
    const lastMessage = userMessages[userMessages.length - 1];
    const content = lastMessage?.content || '';
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
}
