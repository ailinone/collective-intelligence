// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * MediaPlannerStrategy (LOTE AT, Part 2) — a thin agentic sequencing layer
 * over the existing capability surface.
 *
 * Per the published architecture (§3.1): treats each capability as a
 * callable tool dispatched through `executeCapabilityByPlan`
 * (non-generation actions) or `MediaConsensusStrategy` (generation-heavy
 * steps — a video, an image), running a BOUNDED turn loop whose final
 * response schema hard-requires an `unmetConstraints[]` field.
 *
 * Gated entirely behind `MEDIA_PLANNER_ENABLED` (default false) — see
 * `media-planner-gate.ts`'s `resolveMediaPlanRouting`, the single choke
 * point every caller must go through. With the flag off, that function
 * short-circuits before any heuristic text-scanning runs, so this class is
 * never reached.
 *
 * ── Part 1 dependency (feat/media-consensus-strategy-lote-at) ──────────
 * This file was built against `origin/main`, which does NOT yet contain
 * Part 1's `MediaConsensusStrategy`. Rather than import a file that
 * doesn't exist on this branch, generation actions are dispatched through
 * the STRUCTURAL `MediaConsensusExecutor` interface declared in
 * `media-planner-types.ts` (a verified mirror of Part 1's real public
 * shape — see that file's doc comment). `MediaPlannerDeps.mediaConsensusExecutor`
 * is optional; when absent (true today, on `main`), a `generate` action
 * degrades to an `unmetConstraints` entry instead of throwing — the same
 * fail-open-on-missing-dependency posture the rest of this architecture
 * commits to for LOTE AS's not-yet-landed catalog fields. Once Part 1
 * merges, the caller wiring this strategy up (see the new route in
 * `capabilities-routes.ts`) should construct a real `MediaConsensusStrategy`
 * and pass it in — no change needed here, by construction.
 */
import { nanoid } from 'nanoid';
import type {
  AilinArtifact,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  OrchestrationResult,
} from '@/types';
import { BaseStrategy, safeResponseContent, type StrategyMetadata } from '../base-strategy';
import {
  getCapabilityExecutionPlan,
  listCapabilityDefinitions,
  type CapabilityExecutionPlan,
} from '@/core/capabilities/capability-registry';
import {
  getCapabilityExecutionService,
  type CapabilityExecutionResult,
  type CapabilityExecutionService,
} from '@/services/capability-execution-service';
import type {
  CapabilityModeResult,
  CapabilityRequestBody,
} from '@/routes/capabilities/capabilities-routes';
import { config } from '@/config';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import { findNativeCollapseModel } from './media-planner-gate';
import { persistMediaPlanRun } from './media-planner-repository';
import {
  MEDIA_GENERATION_CAPABILITIES,
  PlannerActionSchema,
  type MediaConsensusExecutor,
  type PlannerAction,
  type PlannerBudget,
  type PlannerState,
  type PlannerStopReason,
  type PlannerTurn,
  type PlannerTurnOutcome,
} from './media-planner-types';

const log = logger.child({ component: 'media-planner-strategy' });

// ─── Dependency injection ──────────────────────────────────────────────

/**
 * Dispatch one non-generation capability through the UNMODIFIED
 * `executeCapabilityByPlan` (capabilities-routes.ts). The route layer binds
 * `envelope` / the live `FastifyRequest` / `requestId` / the constructed
 * services object via closure — this strategy never sees any of those, it
 * only supplies `plan` + `body` per action, exactly like the HTTP dispatch
 * loop already does for each entry in `plan.executionPath`.
 */
export type CapabilityDispatcher = (
  plan: CapabilityExecutionPlan,
  body: CapabilityRequestBody
) => Promise<{ result: CapabilityModeResult; fallbackUsed: boolean }>;

export interface MediaPlannerDeps {
  readonly capabilityDispatcher?: CapabilityDispatcher;
  readonly mediaConsensusExecutor?: MediaConsensusExecutor;
  /** Falls back to the real singleton (`getCapabilityExecutionService()`) —
   *  only overridden in tests. */
  readonly capabilityExecutionService?: Pick<CapabilityExecutionService, 'executeWithCapabilities'>;
  /** Overrides `config.mediaPlanner.maxTurns` for this instance (tests). */
  readonly maxTurns?: number;
  /** Overrides `config.mediaPlanner.costCeilingMultiplier` for this instance (tests). */
  readonly costCeilingMultiplier?: number;
  /** Forwarded to `mediaConsensusExecutor.execute()` as `candidateCount` when set. */
  readonly candidateCount?: number;
  /** Injectable clock for deterministic duration assertions in tests. */
  readonly now?: () => number;
}

// ─── Small local helpers ────────────────────────────────────────────────

function extractLastUserText(request: ChatRequest): string {
  const messages = request.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .filter(Boolean)
        .join(' ');
    }
  }
  return '';
}

function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

function buildChatResponse(
  content: string,
  model: string,
  finishReason: 'stop' | 'length' = 'stop'
): ChatResponse {
  return {
    id: `media-plan-${nanoid()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  };
}

function summarizeTurnForTranscript(turn: PlannerTurn): string {
  const outcome = turn.outcome;
  switch (outcome.type) {
    case 'capability_result':
      return `Turn ${turn.turnIndex}: called capability "${outcome.capability}" — ${outcome.success ? 'succeeded' : 'failed'} (${outcome.summary})`;
    case 'generation_result':
      return `Turn ${turn.turnIndex}: generated via "${outcome.capability}" — ${outcome.success ? 'succeeded' : 'failed'}${outcome.degraded ? ' (degraded)' : ''} (${outcome.summary})`;
    case 'native_collapse':
      return `Turn ${turn.turnIndex}: model "${outcome.modelId}" natively satisfies constraints for "${outcome.capability}" — skipped decomposition (${outcome.summary})`;
    case 'final':
      return `Turn ${turn.turnIndex}: final response produced (unmetConstraints: ${outcome.unmetConstraints.length > 0 ? outcome.unmetConstraints.join('; ') : 'none'})`;
    case 'error':
      return `Turn ${turn.turnIndex}: error — ${outcome.message}`;
  }
}

// ─── System prompt + tool manifest ─────────────────────────────────────

interface PlannerToolManifestEntry {
  readonly capability: string;
  readonly kind: 'generate' | 'capability_call';
  readonly maturity: string;
}

/**
 * Built dynamically from the LIVE capability registry
 * (`listCapabilityDefinitions()`, itself derived from `CAPABILITY_OVERRIDES`
 * in `capability-registry.ts`) — never a hardcoded capability list. Only
 * capabilities the registry marks `supportsExecute` are offered as tools.
 */
export function buildPlannerToolManifest(): PlannerToolManifestEntry[] {
  return listCapabilityDefinitions()
    .filter((definition) => definition.supportsExecute)
    .map((definition) => ({
      capability: definition.id,
      kind: MEDIA_GENERATION_CAPABILITIES.has(definition.id) ? 'generate' : 'capability_call',
      maturity: definition.maturity,
    }));
}

function buildPlannerSystemPrompt(
  manifest: readonly PlannerToolManifestEntry[],
  turnIndex: number,
  maxTurns: number
): string {
  const generateTools = manifest.filter((t) => t.kind === 'generate');
  const callTools = manifest.filter((t) => t.kind === 'capability_call');
  return [
    'You are the planning layer for a multi-modal media composition request.',
    'You decompose the request into a bounded sequence of tool calls and finish with a single JSON final response.',
    '',
    `This is turn ${turnIndex + 1} of at most ${maxTurns}.`,
    '',
    'Available generation tools (dispatched through a multi-candidate, judged consensus pipeline):',
    generateTools.map((t) => `- ${t.capability} (${t.maturity})`).join('\n') || '(none)',
    '',
    'Available non-generation capability tools:',
    callTools.map((t) => `- ${t.capability} (${t.maturity})`).join('\n') || '(none)',
    '',
    'Respond with EXACTLY ONE JSON object, no prose, no markdown fences, matching one of:',
    '  {"kind":"generate","capability":"video_generation"|"image_generation","prompt":"...","constraints"?:{"durationSec"?:{"minSec"?:number,"maxSec"?:number},"resolution"?:{"width"?:number,"height"?:number,"tolerancePct"?:number},"requireAudioTrack"?:boolean},"reasoning"?:"..."}',
    '  {"kind":"capability_call","capability":"<one of the non-generation tools above>","body"?:{...arbitrary capability-specific fields...},"reasoning"?:"..."}',
    '  {"kind":"final","content":"...user-facing answer...","unmetConstraints":["...describe each constraint you could NOT satisfy, or an empty array if none"],"reasoning"?:"..."}',
    '',
    'CRITICAL: "unmetConstraints" is REQUIRED on the final action — never omit it. If a capability the user asked for genuinely does not exist in the tool lists above (e.g. a dedicated music-generation capability), do NOT invent a call for it — name it in "unmetConstraints" instead.',
    'Only ever emit "final" once every constraint you can address has been addressed, or you judge further tool calls would not help.',
  ].join('\n');
}

// ─── The strategy ───────────────────────────────────────────────────────

export class MediaPlannerStrategy extends BaseStrategy {
  constructor(private readonly deps: MediaPlannerDeps = {}) {
    super();
  }

  getMetadata(): StrategyMetadata {
    return {
      id: 'media-planner',
      name: 'media-planner',
      displayName: 'Media Composition Planner',
      description:
        'Agentic sequencing layer that decomposes a multi-modal media request into a bounded loop of capability calls and media-generation consensus rounds. Gated behind MEDIA_PLANNER_ENABLED; not part of the normal triage-selectable strategy set.',
      minModels: 1,
      maxModels: 1,
      estimatedCostMultiplier: 3.0,
      estimatedQualityBoost: 0.2,
      estimatedDurationMultiplier: 4.0,
      suitableFor: ['analysis', 'creative'],
    };
  }

  async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
    const startedAt = this.deps.now?.() ?? Date.now();
    const maxTurns = this.deps.maxTurns ?? config.mediaPlanner.maxTurns;
    const costCeilingMultiplier = this.deps.costCeilingMultiplier ?? config.mediaPlanner.costCeilingMultiplier;
    const requestId = context.requestId || nanoid();

    const state: PlannerState = {
      originalRequest: extractLastUserText(request),
      turns: [],
      artifacts: [],
      budget: { maxTurns, costCeilingMultiplier } satisfies PlannerBudget,
    };

    log.info(
      { requestId, maxTurns, costCeilingMultiplier, organizationId: context.organizationId },
      'MediaPlannerStrategy starting bounded turn loop'
    );

    let finalContent: string | undefined;
    let unmetConstraints: string[] = [];
    let stopReason: PlannerStopReason = 'turn_cap_exhausted';
    let totalJudgeCostUsd = 0;
    let baselineCallCostUsd = 0;

    for (let turnIndex = 0; turnIndex < maxTurns; turnIndex++) {
      const turnStartedAt = this.deps.now?.() ?? Date.now();
      let action: PlannerAction | undefined;
      let rawActionParseError: string | undefined;

      try {
        action = await this.decideNextAction(context, state, turnIndex, maxTurns);
      } catch (err) {
        rawActionParseError = getErrorMessage(err);
      }

      if (!action) {
        state.turns.push({
          turnIndex,
          action: undefined,
          rawActionParseError,
          outcome: { type: 'error', message: rawActionParseError ?? 'planner produced no action' },
          durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
          costUsd: 0,
        });
        continue; // consume the turn but keep the loop bounded — don't hard-abort on one bad parse
      }

      if (action.kind === 'final') {
        finalContent = action.content;
        unmetConstraints = [...action.unmetConstraints];
        state.turns.push({
          turnIndex,
          action,
          outcome: { type: 'final', unmetConstraints: action.unmetConstraints },
          durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
          costUsd: 0,
        });
        stopReason = 'final';
        break;
      }

      if (action.kind === 'generate') {
        const collapse = findNativeCollapseModel(context.models, action.capability, action.constraints);
        if (collapse) {
          const outcome = await this.runNativeCollapse(action, collapse.model.id, context, turnIndex, state);
          state.turns.push({
            turnIndex,
            action,
            outcome,
            durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
            costUsd: 0,
          });
          continue;
        }

        if (!this.deps.mediaConsensusExecutor) {
          const summary =
            'MediaConsensusStrategy dependency not wired (LOTE AT Part 1 — feat/media-consensus-strategy-lote-at — has not merged/been injected yet)';
          state.turns.push({
            turnIndex,
            action,
            outcome: { type: 'generation_result', capability: action.capability, success: false, summary, hasArtifact: false },
            durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
            costUsd: 0,
          });
          continue;
        }

        const consensusResult = await this.deps.mediaConsensusExecutor.execute({
          capability: action.capability,
          prompt: action.prompt,
          stageName: `media-plan-turn-${turnIndex}`,
          stageIndex: turnIndex,
          constraints: action.constraints,
          candidateCount: this.deps.candidateCount,
          userContext: context,
          requestId: `${requestId}-turn-${turnIndex}`,
        });

        if (consensusResult.bestArtifact) state.artifacts.push(consensusResult.bestArtifact);
        totalJudgeCostUsd += consensusResult.totalJudgeCostUsd;
        if (baselineCallCostUsd === 0 && consensusResult.totalJudgeCostUsd > 0) {
          baselineCallCostUsd = consensusResult.totalJudgeCostUsd;
        }

        state.turns.push({
          turnIndex,
          action,
          outcome: {
            type: 'generation_result',
            capability: action.capability,
            success: !consensusResult.degraded,
            summary: consensusResult.degraded
              ? `degraded: ${consensusResult.degradedReason ?? 'all candidates failed'}`
              : `best candidate #${consensusResult.bestCandidateIndex} selected from ${consensusResult.candidates.length} generated`,
            degraded: consensusResult.degraded,
            hasArtifact: Boolean(consensusResult.bestArtifact),
          },
          durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
          costUsd: consensusResult.totalJudgeCostUsd,
        });

        // Cost ceiling (§8): a MULTIPLIER of a single call's own cost, never
        // a fixed dollar figure. Every media-generation artifact in this
        // codebase reports cost_usd=0 uniformly today (a pre-existing gap,
        // not introduced here — see Part 1's MediaConsensusResult doc
        // comment), so the only non-zero signal currently available is
        // judge cost; the ceiling activates once a real baseline > 0 is
        // observed and is a no-op until then (provisional, see PlannerBudget doc).
        if (baselineCallCostUsd > 0 && totalJudgeCostUsd > costCeilingMultiplier * baselineCallCostUsd) {
          stopReason = 'cost_ceiling_exhausted';
          break;
        }
        continue;
      }

      // action.kind === 'capability_call'
      if (!this.deps.capabilityDispatcher) {
        state.turns.push({
          turnIndex,
          action,
          outcome: {
            type: 'capability_result',
            capability: action.capability,
            success: false,
            summary: 'capability dispatcher not wired',
          },
          durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
          costUsd: 0,
        });
        continue;
      }

      const plan = getCapabilityExecutionPlan(action.capability);
      if (!plan) {
        state.turns.push({
          turnIndex,
          action,
          outcome: {
            type: 'capability_result',
            capability: action.capability,
            success: false,
            summary: `unknown capability "${action.capability}" — not in the live capability registry`,
          },
          durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
          costUsd: 0,
        });
        continue;
      }

      try {
        const { result, fallbackUsed } = await this.deps.capabilityDispatcher(
          plan,
          (action.body ?? {}) as CapabilityRequestBody
        );
        state.turns.push({
          turnIndex,
          action,
          outcome: {
            type: 'capability_result',
            capability: plan.id,
            success: true,
            summary: `dispatched via ${result.executionPath}`,
            executionPath: result.executionPath,
            fallbackUsed,
          },
          durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
          costUsd: 0,
        });
      } catch (err) {
        state.turns.push({
          turnIndex,
          action,
          outcome: {
            type: 'capability_result',
            capability: plan.id,
            success: false,
            summary: getErrorMessage(err),
          },
          durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
          costUsd: 0,
        });
      }
    }

    if (stopReason !== 'final') {
      unmetConstraints = [
        ...unmetConstraints,
        stopReason === 'cost_ceiling_exhausted'
          ? 'planner stopped: cost ceiling exhausted before a final response was produced'
          : 'planner stopped: turn budget exhausted before a final response was produced',
      ];
      finalContent = this.synthesizeDegradedSummary(state, unmetConstraints);
    }

    const totalDuration = (this.deps.now?.() ?? Date.now()) - startedAt;

    await persistMediaPlanRun({
      organizationId: context.organizationId,
      userId: context.userId,
      requestId,
      state,
      stopReason,
      totalCostUsd: totalJudgeCostUsd,
      totalDurationMs: totalDuration,
      unmetConstraints,
    });

    return {
      strategyUsed: 'media-planner',
      modelsUsed: [],
      finalResponse: buildChatResponse(finalContent ?? '', this.getMetadata().name),
      totalCost: totalJudgeCostUsd,
      totalDuration,
      ...(stopReason === 'final' ? {} : { qualityScore: 0 }),
      metadata: {
        mediaPlanner: true,
        turnsExecuted: state.turns.length,
        maxTurns,
        stopReason,
        unmetConstraints,
        plan: state.turns.map((turn) => ({
          turnIndex: turn.turnIndex,
          actionKind: turn.action?.kind,
          outcome: turn.outcome,
          durationMs: turn.durationMs,
          costUsd: turn.costUsd,
        })),
        ...(stopReason === 'final' ? {} : { degraded: true, degraded_reason: `media_planner_${stopReason}` }),
      },
      artifacts: state.artifacts.length > 0 ? state.artifacts : undefined,
    };
  }

  // ─── Turn mechanics ─────────────────────────────────────────────────

  private async decideNextAction(
    context: OrchestrationContext,
    state: PlannerState,
    turnIndex: number,
    maxTurns: number
  ): Promise<PlannerAction> {
    const manifest = buildPlannerToolManifest();
    const systemPrompt = buildPlannerSystemPrompt(manifest, turnIndex, maxTurns);
    const transcript = state.turns.map(summarizeTurnForTranscript).join('\n') || '(no actions taken yet)';
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Original request:\n${state.originalRequest}\n\nTranscript so far:\n${transcript}\n\nRespond with a single JSON action object as instructed.`,
      },
    ];

    const raw = await this.callPlannerModel(messages, context);
    const parsedJson: unknown = JSON.parse(stripJsonCodeFence(raw));
    return PlannerActionSchema.parse(parsedJson);
  }

  /**
   * The planner's own reasoning call — routed through "the existing chat
   * CapabilityExecutionService, no new model-calling code path" per the
   * architecture. Prefers `context.invoker.chat()` when available: it is
   * the SAME underlying chat machinery, but additionally supports
   * `responseFormat: 'json_object'` and `strategy: 'single'` (both already
   * relied on by `generateFile()` in `capability-invoker.ts` for exactly
   * this "force structured JSON, never re-enter the full triage pipeline"
   * need — reusing that documented lesson rather than rediscovering it).
   * Falls back to `CapabilityExecutionService.executeWithCapabilities`
   * directly when no invoker is present in this context.
   */
  private async callPlannerModel(messages: ChatMessage[], context: OrchestrationContext): Promise<string> {
    if (context.invoker) {
      const response = await context.invoker.chat(messages, {
        temperature: 0.2,
        responseFormat: 'json_object',
        strategy: 'single',
      });
      return safeResponseContent(response);
    }

    const service = this.deps.capabilityExecutionService ?? getCapabilityExecutionService();
    const result: CapabilityExecutionResult = await service.executeWithCapabilities(messages, {
      requiredCapabilities: ['chat'],
      organizationId: context.organizationId,
      userId: context.userId,
      taskType: 'analysis',
      strategy: 'single',
    });
    if (!result.success || !result.response) {
      throw new Error(result.error ?? 'MediaPlannerStrategy: planner model call failed');
    }
    return safeResponseContent(result.response);
  }

  /**
   * §3.3 native joint-collapse: a single model already satisfies every
   * stated constraint, so skip `MediaConsensusStrategy` entirely and issue
   * one direct call through the existing `CapabilityInvoker`
   * (`generateVideo` / `generateImage` — already on `main`, no Part 1
   * dependency) pinned to that model.
   */
  private async runNativeCollapse(
    action: Extract<PlannerAction, { kind: 'generate' }>,
    modelId: string,
    context: OrchestrationContext,
    turnIndex: number,
    state: PlannerState
  ): Promise<PlannerTurnOutcome> {
    const invoker = context.invoker;
    if (!invoker) {
      return {
        type: 'native_collapse',
        capability: action.capability,
        modelId,
        summary: 'native collapse skipped: no CapabilityInvoker in this context',
        hasArtifact: false,
      };
    }
    try {
      if (action.capability === 'video_generation') {
        const result = await invoker.generateVideo({
          prompt: action.prompt,
          model: modelId,
          duration: action.constraints?.durationSec?.minSec ?? action.constraints?.durationSec?.maxSec,
        });
        const video = result.videos[0];
        if (video && (video.url || video.b64_json)) {
          state.artifacts.push({
            modality: 'video',
            stage_name: `media-plan-turn-${turnIndex}`,
            stage_index: turnIndex,
            url: video.url,
            b64_json: video.b64_json,
            provider: result.provider,
            model: result.model,
          } satisfies AilinArtifact);
          return {
            type: 'native_collapse',
            capability: action.capability,
            modelId,
            summary: `single native call satisfied all stated constraints`,
            hasArtifact: true,
          };
        }
        return {
          type: 'native_collapse',
          capability: action.capability,
          modelId,
          summary: 'native collapse call returned no usable output',
          hasArtifact: false,
        };
      }

      const result = await invoker.generateImage({ prompt: action.prompt, model: modelId });
      const image = result.images[0];
      if (image && (image.url || image.b64_json)) {
        state.artifacts.push({
          modality: 'image',
          stage_name: `media-plan-turn-${turnIndex}`,
          stage_index: turnIndex,
          url: image.url,
          b64_json: image.b64_json,
          revised_prompt: image.revised_prompt,
          provider: result.provider,
          model: result.model,
        } satisfies AilinArtifact);
        return {
          type: 'native_collapse',
          capability: action.capability,
          modelId,
          summary: 'single native call satisfied all stated constraints',
          hasArtifact: true,
        };
      }
      return {
        type: 'native_collapse',
        capability: action.capability,
        modelId,
        summary: 'native collapse call returned no usable output',
        hasArtifact: false,
      };
    } catch (err) {
      return {
        type: 'native_collapse',
        capability: action.capability,
        modelId,
        summary: `native collapse call failed: ${getErrorMessage(err)}`,
        hasArtifact: false,
      };
    }
  }

  private synthesizeDegradedSummary(state: PlannerState, unmetConstraints: readonly string[]): string {
    const producedArtifacts = state.artifacts.length;
    const lines = [
      `The media composition plan for "${state.originalRequest}" did not reach a final response.`,
      producedArtifacts > 0
        ? `${producedArtifacts} artifact(s) were produced before stopping.`
        : 'No artifacts were produced before stopping.',
      `Unmet: ${unmetConstraints.join('; ')}`,
    ];
    return lines.join(' ');
  }
}
