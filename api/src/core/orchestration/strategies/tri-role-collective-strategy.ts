// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Tri-Role Collective Strategy (F2.1)
 *
 * A cyclical multi-turn coordination strategy where each turn assigns
 * one model from the eligible pool to one of three roles:
 *
 *   • Planner — decomposes the task, names the success criteria, and
 *     issues a high-level plan. Runs first.
 *   • Solver  — produces concrete output that satisfies the plan
 *     against the original user message.
 *   • Auditor — reviews the most recent Solver output, returns a
 *     verdict (ACCEPT or REVISE) plus optional feedback. ACCEPT
 *     terminates the run; REVISE loops back to a new Solver turn
 *     with the auditor's feedback in context.
 *
 * The strategy is "additive without training" — we deliberately do
 * NOT depend on a small coordinator language model with a learned
 * head (that is the F4.B path of the roadmap). Instead the role
 * sequence is a deterministic state machine and model selection is
 * round-robin over the eligible pool, with the Auditor forced to
 * differ from the most-recent Solver to avoid self-rubber-stamp.
 *
 * Comparison with the existing strategies in the registry:
 *   - `critique-repair` is similar in spirit but uses a single model
 *     in two roles. tri-role uses three independent models, one per
 *     role, with a forced separation of duties.
 *   - `expert-panel` decomposes by domain expertise. tri-role
 *     decomposes by epistemic role (planning vs execution vs review)
 *     which is orthogonal.
 *   - `consensus`/`debate` aggregate parallel model output. tri-role
 *     is sequential and produces ONE final answer, not an aggregation.
 *
 * Configuration via env (all optional, sensible defaults):
 *   CI_TRI_ROLE_MAX_TURNS         (default 5; hard upper bound 10)
 *   CI_TRI_ROLE_MAX_COST_USD      (default 0.30)
 *   CI_TRI_ROLE_MAX_LATENCY_MS    (default 60000)
 *   CI_TRI_ROLE_AUDITOR_THRESHOLD (default "accept" — accept-bias when
 *                                  verdict is ambiguous; alternative
 *                                  "revise" makes the strategy more
 *                                  conservative).
 */

import { BaseStrategy, type StrategyMetadata } from '../base-strategy';
import { narrowAs } from '@/utils/type-guards';
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelExecution,
  OrchestrationContext,
  OrchestrationResult,
} from '@/types';
import { resolvePreferredExecutor, withPreferredFirst } from './preferred-model-helper';
import { sanitizeForPromptContext } from '@/core/coordination/collective-prompt-safety';
import { estimateRoundCost } from '@/core/coordination/collective-cost-guardrail';
import { CollectiveTrace } from '@/core/coordination/collective-trace';
import { recordCollectiveTrace } from '@/core/coordination/coordination-metrics';
import type { CoordinationState, CoordinationLimits } from '@/core/coordination/coordination-types';
import { persistTriRoleRun } from '@/core/coordination/collective-run-repository';
import { buildEnsembleRequest } from '@/core/coordination/ensemble-coordinator-client';
import {
  runEnsembleInShadow,
  type ShadowEnsembleSnapshot,
} from '@/core/coordination/ensemble-coordinator-shadow';
import { nanoid } from 'nanoid';

// ─── Roles ──────────────────────────────────────────────────────────────

export const TRI_ROLES = ['planner', 'solver', 'auditor'] as const;
export type TriRole = (typeof TRI_ROLES)[number];

// ─── Configuration ──────────────────────────────────────────────────────

const HARD_MAX_TURNS_CAP = 10;

interface TriRoleConfig {
  maxTurns: number;
  maxCostUsd: number;
  maxLatencyMs: number;
  /** When the auditor verdict is genuinely ambiguous, default to this. */
  ambiguityResolution: 'accept' | 'revise';
}

function readTriRoleConfig(): TriRoleConfig {
  const env = (key: string, fallback: string): string => process.env[key] ?? fallback;
  const ambiguity = env('CI_TRI_ROLE_AUDITOR_THRESHOLD', 'accept');
  return {
    maxTurns: Math.max(3, Math.min(HARD_MAX_TURNS_CAP, parseInt(env('CI_TRI_ROLE_MAX_TURNS', '5'), 10))),
    maxCostUsd: parseFloat(env('CI_TRI_ROLE_MAX_COST_USD', '0.30')),
    maxLatencyMs: parseInt(env('CI_TRI_ROLE_MAX_LATENCY_MS', '60000'), 10),
    ambiguityResolution: ambiguity === 'revise' ? 'revise' : 'accept',
  };
}

// ─── Turn record + verdict ──────────────────────────────────────────────

interface TurnRecord {
  turn: number;
  role: TriRole;
  model: Model;
  responseText: string;
  cost: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  verdict?: AuditorVerdict;
  /**
   * F4.1 audit substrate — copied from the RoleDecision so the per-turn
   * persistence record carries the scheduler identity + reason without
   * forcing consumers to cross-reference the trace span attributes.
   */
  schedulerName?: string;
  decisionReason?: string;
}

export interface AuditorVerdict {
  status: 'accept' | 'revise';
  /** Free-form feedback the auditor included, sanitized for prompt re-use. */
  feedback: string;
  /** True when the verdict was inferred under ambiguity (no clean ACCEPT/REVISE). */
  inferred: boolean;
}

// ─── Verdict parser ─────────────────────────────────────────────────────

const ACCEPT_PATTERN = /\bACCEPT(?:ED)?\b/i;
const REVISE_PATTERN = /\bREVISE\b|\bREJECT(?:ED)?\b|\bREQUEST_CHANGES\b/i;

/**
 * Parse the auditor's response into a verdict. Tolerant: looks for
 * ACCEPT or REVISE/REJECT tokens anywhere in the text. When both
 * appear (or neither), `ambiguityResolution` decides.
 *
 * Exported for testability — the strategy uses it internally.
 */
export function parseAuditorVerdict(
  rawResponse: string,
  ambiguityResolution: 'accept' | 'revise',
): AuditorVerdict {
  if (!rawResponse || typeof rawResponse !== 'string') {
    return { status: ambiguityResolution, feedback: '', inferred: true };
  }

  const text = rawResponse.trim();
  const hasAccept = ACCEPT_PATTERN.test(text);
  const hasRevise = REVISE_PATTERN.test(text);

  // Sanitize the feedback so it can be safely re-embedded in the next
  // Solver turn's system prompt without acting as injection.
  const feedback = sanitizeForPromptContext(text, 1500);

  if (hasAccept && !hasRevise) {
    return { status: 'accept', feedback, inferred: false };
  }
  if (hasRevise && !hasAccept) {
    return { status: 'revise', feedback, inferred: false };
  }

  // Both or neither — ambiguous. Default per config.
  return { status: ambiguityResolution, feedback, inferred: true };
}

// ─── Role decision (state machine) ──────────────────────────────────────

/**
 * Structured role decision — exposes the rationale alongside the role
 * pick so the trace + F3.3 export can record WHY each turn played the
 * role it did. This is the audit substrate that the future F4.1 model
 * coordinator will plug into: when a learned scheduler replaces the
 * fixed state machine, it will produce the same shape and the rest of
 * the pipeline (trace, export, training feedback) is already wired.
 */
export interface RoleDecision {
  role: TriRole;
  /** Short stable token identifying which branch of the state machine fired. */
  reason: string;
  /**
   * Identifier for the scheduler that produced this decision. The fixed
   * state machine emits `'fixed-state-machine'`; a future model-based
   * scheduler would emit e.g. `'ailin-coordinator-1b'`.
   */
  scheduler: string;
}

/**
 * Pure function — decides which role the next turn should play and why.
 *
 * Sequence:
 *   turn 1 → planner            (reason: turn-1-fixed)
 *   turn 2 → solver             (reason: turn-2-fixed)
 *   turn 3 → auditor            (reason: after-solver)
 *   auditor REVISE → solver     (reason: after-revise)
 *   solver → auditor            (reason: after-solver)
 *   ...
 *
 * Exported for testability.
 */
export function decideRoleForTurn(
  turn: number,
  transcript: ReadonlyArray<TurnRecord>,
): RoleDecision {
  const SCHEDULER = 'fixed-state-machine';

  if (turn === 1) return { role: 'planner', reason: 'turn-1-fixed', scheduler: SCHEDULER };
  if (turn === 2) return { role: 'solver', reason: 'turn-2-fixed', scheduler: SCHEDULER };

  // Turn ≥ 3 — alternate auditor / solver based on the previous turn.
  const previous = transcript[transcript.length - 1];
  if (!previous) return { role: 'auditor', reason: 'no-prev-turn', scheduler: SCHEDULER };
  if (previous.role === 'solver') return { role: 'auditor', reason: 'after-solver', scheduler: SCHEDULER };
  if (previous.role === 'auditor' && previous.verdict?.status === 'revise') {
    return { role: 'solver', reason: 'after-revise', scheduler: SCHEDULER };
  }
  // Default: auditor (defensive — keeps the loop terminating)
  return { role: 'auditor', reason: 'default-fallback', scheduler: SCHEDULER };
}

// ─── Model selection (round-robin with auditor-vs-solver split) ─────────

/**
 * Pick the model for a given turn. Round-robin keyed on turn index so
 * different roles see different models when the pool size permits.
 * For the Auditor turn we explicitly avoid reusing the most-recent
 * Solver's model — auditing your own work is the failure mode the
 * three-role split is designed to prevent.
 *
 * Exported for testability.
 */
export function pickModelForTurn(
  pool: ReadonlyArray<Model>,
  role: TriRole,
  transcript: ReadonlyArray<TurnRecord>,
  turn: number,
): Model {
  if (pool.length === 0) {
    throw new Error('tri-role-collective: empty model pool');
  }
  if (pool.length === 1) return pool[0];

  // Default: round-robin by turn.
  let idx = (turn - 1) % pool.length;
  let candidate = pool[idx];

  if (role === 'auditor') {
    const lastSolver = [...transcript].reverse().find((t) => t.role === 'solver');
    if (lastSolver && candidate.id === lastSolver.model.id) {
      // Step to the next slot to break the tie. We try every other slot
      // before giving up — for small pools this terminates in ≤2 steps.
      for (let step = 1; step < pool.length; step++) {
        idx = (idx + 1) % pool.length;
        candidate = pool[idx];
        if (candidate.id !== lastSolver.model.id) break;
      }
    }
  }

  return candidate;
}

// ─── Role-specific system prompts ───────────────────────────────────────

const PLANNER_INSTRUCTIONS = [
  'You are the Planner in a three-role collective intelligence system.',
  '',
  'Your task: read the user request and produce a SHORT, structured plan that the Solver will follow.',
  '',
  'Output strictly:',
  '  GOAL: <one-sentence statement of what success looks like>',
  '  STEPS:',
  '    1. <action>',
  '    2. <action>',
  '    ...',
  '  SUCCESS_CRITERIA: <bulleted, verifiable criteria the Auditor can check against>',
  '',
  'Do not solve the task yourself. Do not produce code or final answers. Only the plan.',
].join('\n');

const SOLVER_INSTRUCTIONS_BASE = [
  'You are the Solver in a three-role collective intelligence system.',
  '',
  'A Planner has produced a plan. Read the plan and the original request, then produce the final answer that satisfies the plan and the request.',
  '',
  'Be complete and direct. Do not restate the plan; just deliver the answer.',
].join('\n');

const AUDITOR_INSTRUCTIONS = [
  'You are the Auditor in a three-role collective intelligence system.',
  '',
  "Read the original request, the Planner's plan, and the Solver's most recent answer.",
  '',
  'Your task is to decide if the answer fully satisfies the plan and the original request.',
  '',
  'Respond on the FIRST line with EXACTLY one of:',
  '  VERDICT: ACCEPT',
  '  VERDICT: REVISE',
  '',
  'After the verdict line, provide a SHORT (under 100 words) justification.',
  'If REVISE, the justification must include actionable feedback the Solver can use.',
  'If ACCEPT, briefly note why the answer is sufficient.',
].join('\n');

function buildPlannerRequest(originalRequest: ChatRequest): ChatRequest {
  const userText = extractLatestUserText(originalRequest);
  return {
    ...originalRequest,
    messages: [
      { role: 'system', content: PLANNER_INSTRUCTIONS },
      { role: 'user', content: `Original request:\n${sanitizeForPromptContext(userText, 4000)}\n\nProduce the plan now.` },
    ],
    temperature: 0.3,
    max_tokens: 800,
  };
}

function buildSolverRequest(
  originalRequest: ChatRequest,
  transcript: ReadonlyArray<TurnRecord>,
): ChatRequest {
  const planner = transcript.find((t) => t.role === 'planner');
  const lastAuditor = [...transcript].reverse().find((t) => t.role === 'auditor');
  const userText = extractLatestUserText(originalRequest);

  const plan = planner ? sanitizeForPromptContext(planner.responseText, 2000) : '(no plan available)';
  const feedback = lastAuditor?.verdict?.status === 'revise'
    ? `\n\nThe Auditor previously requested revision. Their feedback:\n${lastAuditor.verdict.feedback}\n\nIncorporate the feedback in this revised answer.`
    : '';

  return {
    ...originalRequest,
    messages: [
      { role: 'system', content: SOLVER_INSTRUCTIONS_BASE },
      {
        role: 'user',
        content:
          `Original request:\n${sanitizeForPromptContext(userText, 4000)}\n\n` +
          `Plan:\n${plan}${feedback}\n\nProduce the answer now.`,
      },
    ],
    temperature: originalRequest.temperature ?? 0.5,
    max_tokens: originalRequest.max_tokens ?? 2048,
  };
}

function buildAuditorRequest(
  originalRequest: ChatRequest,
  transcript: ReadonlyArray<TurnRecord>,
): ChatRequest {
  const planner = transcript.find((t) => t.role === 'planner');
  const lastSolver = [...transcript].reverse().find((t) => t.role === 'solver');
  const userText = extractLatestUserText(originalRequest);

  const plan = planner ? sanitizeForPromptContext(planner.responseText, 2000) : '(no plan available)';
  const answer = lastSolver ? sanitizeForPromptContext(lastSolver.responseText, 4000) : '(no answer yet)';

  return {
    ...originalRequest,
    messages: [
      { role: 'system', content: AUDITOR_INSTRUCTIONS },
      {
        role: 'user',
        content:
          `Original request:\n${sanitizeForPromptContext(userText, 2000)}\n\n` +
          `Plan:\n${plan}\n\n` +
          `Solver's answer:\n${answer}\n\n` +
          'Provide your verdict now.',
      },
    ],
    temperature: 0.2,
    max_tokens: 400,
  };
}

function extractLatestUserText(request: ChatRequest): string {
  const userMessages = request.messages.filter((m) => m.role === 'user');
  const last = userMessages[userMessages.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    const parts = last.content
      .filter((p) => p && typeof p === 'object')
      .map((p) => {
        const text = (p as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      });
    return parts.join('\n');
  }
  return '';
}

function safeResponseText(response: ChatResponse | undefined): string {
  if (!response || !Array.isArray(response.choices) || response.choices.length === 0) return '';
  const message = response.choices[0]?.message;
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    const parts = message.content
      .filter((p) => p && typeof p === 'object')
      .map((p) => {
        const text = (p as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      });
    return parts.join('');
  }
  return '';
}

// ─── Final response assembly ────────────────────────────────────────────

function buildFinalResponseText(transcript: ReadonlyArray<TurnRecord>): string {
  const lastAccepted = [...transcript]
    .reverse()
    .find((t) => t.role === 'auditor' && t.verdict?.status === 'accept');

  if (lastAccepted) {
    // The latest Solver before the accepting Auditor IS the accepted answer.
    const lastSolverBeforeAccept = [...transcript]
      .filter((t) => t.turn < lastAccepted.turn && t.role === 'solver')
      .pop();
    if (lastSolverBeforeAccept) return lastSolverBeforeAccept.responseText;
  }

  // No Auditor accepted — return the latest Solver output as best-effort
  // and prepend a short note indicating the budget was exhausted.
  const lastSolver = [...transcript].reverse().find((t) => t.role === 'solver');
  if (lastSolver) {
    return `[tri-role-collective: turn budget exhausted without auditor acceptance]\n\n${lastSolver.responseText}`;
  }

  return '[tri-role-collective: no solver output produced]';
}

// ─── Strategy ───────────────────────────────────────────────────────────

const TRI_ROLE_MIN_MODELS = 2;
const TRI_ROLE_MAX_MODELS = 6;

export class TriRoleCollectiveStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return {
      id: 'tri-role-collective',
      name: 'tri-role-collective',
      displayName: 'Tri-Role Collective',
      description:
        'Cyclical Planner → Solver → Auditor with revise loop until acceptance. ' +
        'Three-role separation prevents self-review bias; opt-in via strategy name. ' +
        'Additive — uses existing pool models in roles via system prompt, no training required.',
      minModels: TRI_ROLE_MIN_MODELS,
      maxModels: TRI_ROLE_MAX_MODELS,
      estimatedCostMultiplier: 3.5,
      estimatedQualityBoost: 0.30,
      estimatedDurationMultiplier: 2.5,
      suitableFor: ['analysis', 'code-generation', 'code-review', 'reasoning', 'architecture'],
    };
  }

  async execute(
    request: ChatRequest,
    context: OrchestrationContext,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const metadata = this.getMetadata();
    const config = readTriRoleConfig();

    const eligible = this.getEligibleModels(context);
    if (eligible.length < TRI_ROLE_MIN_MODELS) {
      this.log.warn(
        { eligible: eligible.length, required: TRI_ROLE_MIN_MODELS },
        'tri-role-collective: insufficient eligible models — falling back to consensus',
      );
      return this.executeFallback(request, context);
    }

    const pool = this.orderPoolForTriRole(eligible, context);

    this.log.info(
      {
        strategy: metadata.name,
        requestId: context.requestId,
        eligibleModels: pool.length,
        maxTurns: config.maxTurns,
      },
      'Executing Tri-Role Collective strategy',
    );

    this.emitObserverEvent(context, {
      type: 'phase_start',
      models: pool.slice(0, TRI_ROLE_MAX_MODELS).map((m) => m.name),
      summary: `Tri-Role Collective starting: Planner → Solver → Auditor cycle (max ${config.maxTurns} turns).`,
    });

    const runId = `tri-${nanoid(10)}`;
    const transcript: TurnRecord[] = [];
    const executions: ModelExecution[] = [];

    // F2.7 — CollectiveTrace per run. Tri-Role's loop is shorter than
    // sensitivity-consensus (≤ maxTurns ≈ 5 spans) so the trace
    // overhead is negligible; the structural visibility is high
    // (one span per turn, parented under the run-init span).
    const trace = new CollectiveTrace(runId);
    const initSpanId = trace.startSpan('run_init', {
      attributes: {
        runId,
        strategy: 'tri-role-collective',
        modelCount: pool.length,
        maxTurns: config.maxTurns,
      },
    });
    trace.endSpan(initSpanId);

    try {
      let totalCostUsd = 0;
      let stopReason: 'accepted' | 'max_turns' | 'max_cost' | 'max_latency' | 'no_solver' = 'max_turns';
      // Phase 2c shadow snapshot — populated on turn 1 by the
      // onShadowResult hook, then attached to the turn-1 TriRoleTurnInput
      // when the run persists. Null while shadow disabled or pending.
      let shadowSnapshot: ShadowEnsembleSnapshot | null = null;

      for (let turn = 1; turn <= config.maxTurns; turn++) {
        // Cost guardrail (pre-flight). The estimator was built for the
        // sensitivity-consensus parallel pattern; we adapt it by passing
        // a single-element pool for the per-turn projection.
        const decision = decideRoleForTurn(turn, transcript);
        const role = decision.role;
        const model = pickModelForTurn(pool, role, transcript, turn);

        // Phase 2c shadow integration — fire ensemble in parallel only on
        // turn 1 to avoid noisy multi-trace runs. Turn 1 is the highest-
        // signal decision (the planner choice that frames the rest of the
        // run); subsequent turns follow the deterministic state machine
        // and are predictable from turn 1 + transcript shape. NEVER throws.
        if (turn === 1) {
          void runEnsembleInShadow(
            buildEnsembleRequest(
              'tri-role-collective',
              'role-for-turn',
              {
                requestId: context.requestId,
                turn,
                transcriptLength: transcript.length,
                taskType: context.taskType,
                complexity: context.triage?.complexity ?? null,
                poolSize: pool.length,
                maxTurns: config.maxTurns,
              },
            ),
            {
              heuristicDecisionForComparison: {
                role,
                scheduler: decision.scheduler,
                reason: decision.reason,
              },
              onShadowResult: (snapshot) => {
                shadowSnapshot = snapshot;
              },
            },
          ).catch((err: unknown) => {
            this.log.debug({ err: String(err) }, 'shadow runner promise rejected silently');
          });
        }

        const turnSpanId = trace.startSpan('round_start', {
          attributes: {
            turn,
            role,
            modelId: model.id,
            // F4.1 audit substrate — preserves which scheduler made the
            // decision and why. The fixed state machine emits stable
            // reason tokens; a future model coordinator emits its own.
            schedulerName: decision.scheduler,
            decisionReason: decision.reason,
          },
        });

        const guardState: CoordinationState = {
          runId,
          strategy: 'tri-role-collective',
          round: 0,
          variables: {},
          convergence: {
            score: 0,
            decisionFlipRate: 0,
            dissent: 0,
            confidenceTrend: [],
            stableVariables: [],
            unstableVariables: [],
          },
          risks: [],
          history: [],
          limits: this.synthLimits(config),
          totalCostUsd,
          totalLatencyMs: Date.now() - startTime,
          totalTokens: 0,
        };
        const turnRequest =
          role === 'planner'
            ? buildPlannerRequest(request)
            : role === 'solver'
              ? buildSolverRequest(request, transcript)
              : buildAuditorRequest(request, transcript);

        const projection = estimateRoundCost([model], turnRequest, guardState);
        if (projection.exceedsLimit) {
          this.log.warn(
            {
              runId,
              turn,
              role,
              alreadySpentUsd: totalCostUsd,
              projectedTotalUsd: projection.projectedTotalUsd,
              limitUsd: projection.limitUsd,
            },
            'tri-role: aborting next turn — projected cost exceeds budget',
          );
          trace.endSpan(turnSpanId, {
            status: 'cancelled',
            attributes: { stopReason: 'max_cost' },
          });
          stopReason = 'max_cost';
          break;
        }

        if (Date.now() - startTime >= config.maxLatencyMs) {
          this.log.warn(
            { runId, turn, role, latencyMs: Date.now() - startTime, limitMs: config.maxLatencyMs },
            'tri-role: latency budget exceeded — stopping',
          );
          trace.endSpan(turnSpanId, {
            status: 'cancelled',
            attributes: { stopReason: 'max_latency' },
          });
          stopReason = 'max_latency';
          break;
        }

        if (!this.getAdapterForModel) {
          throw new Error('getAdapterForModel not injected');
        }
        const adapter = await this.getAdapterForModel(model, context);
        if (!adapter) {
          throw new Error(`No adapter for model: ${model.id}`);
        }

        const turnStart = Date.now();
        const execution = await this.executeModel(adapter, model, turnRequest, role);
        executions.push(execution);
        totalCostUsd += execution.cost;

        const responseText = safeResponseText(execution.response);
        const inputTokens = execution.response?.usage?.prompt_tokens ?? 0;
        const outputTokens = execution.response?.usage?.completion_tokens ?? 0;

        const record: TurnRecord = {
          turn,
          role,
          model,
          responseText,
          cost: execution.cost,
          durationMs: Date.now() - turnStart,
          inputTokens,
          outputTokens,
          // F4.1 audit substrate carried from the role decision.
          schedulerName: decision.scheduler,
          decisionReason: decision.reason,
        };

        if (role === 'auditor') {
          record.verdict = parseAuditorVerdict(responseText, config.ambiguityResolution);
        }

        transcript.push(record);

        this.emitObserverEvent(context, {
          type: 'round_complete',
          round: turn,
          totalRounds: config.maxTurns,
          modelId: model.id,
          modelName: model.name,
          summary:
            role === 'auditor' && record.verdict
              ? `Turn ${turn} (${role}, ${model.name}): verdict ${record.verdict.status}`
              : `Turn ${turn} (${role}, ${model.name})`,
        });

        if (role === 'auditor' && record.verdict?.status === 'accept') {
          trace.endSpan(turnSpanId, {
            attributes: {
              cost: execution.cost,
              durationMs: record.durationMs,
              verdict: 'accept',
              stopReason: 'accepted',
            },
          });
          stopReason = 'accepted';
          break;
        }

        trace.endSpan(turnSpanId, {
          attributes: {
            cost: execution.cost,
            durationMs: record.durationMs,
            verdict: record.verdict?.status ?? 'n/a',
          },
        });
      }

      // Validate we have at least one Solver in the transcript — if not,
      // the budget was exhausted before any solving happened.
      const hasSolver = transcript.some((t) => t.role === 'solver');
      if (!hasSolver) stopReason = 'no_solver';

      const finalResponseText = buildFinalResponseText(transcript);
      const totalDuration = Date.now() - startTime;

      this.emitObserverEvent(context, {
        type: 'synthesis_complete',
        summary: `Tri-Role Collective finished after ${transcript.length} turns (${stopReason}).`,
      });

      trace.markComplete();
      // F2.11 — Per-run trace metrics for Prometheus.
      recordCollectiveTrace('tri-role-collective', trace.describe());

      // F4.1 prep — persist the run + per-turn signals when the global
      // coordination audit flag is on. Best-effort: a persistence failure
      // logs and returns null, never breaks the orchestration response.
      // The flag matches sensitivity-consensus so operators flip both
      // strategies' audit trail at once.
      if (process.env.CI_COORDINATION_PERSIST_AUDIT === 'true' && context.organizationId) {
        const finalConfidence =
          stopReason === 'accepted' ? 1.0 : stopReason === 'no_solver' ? 0.0 : 0.5;
        const finalDecisionType =
          stopReason === 'accepted' ? 'auditor-accept' : stopReason;

        // Unique participating models across the transcript. preserve
        // first-occurrence order so the audit trail is deterministic.
        const seen = new Set<string>();
        const participatingModels = transcript.flatMap((t) => {
          if (seen.has(t.model.id)) return [];
          seen.add(t.model.id);
          return [{
            modelId: t.model.id,
            modelName: t.model.name ?? t.model.id,
            providerId: t.model.providerId,
          }];
        });

        const totalTokens = transcript.reduce(
          (sum, t) => sum + t.inputTokens + t.outputTokens,
          0,
        );

        await persistTriRoleRun({
          organizationId: context.organizationId,
          requestId: context.requestId,
          runId,
          config: {
            maxTurns: config.maxTurns,
            maxCostUsd: config.maxCostUsd,
            maxLatencyMs: config.maxLatencyMs,
            ambiguityResolution: config.ambiguityResolution,
          },
          stopReason,
          finalDecisionType,
          finalConfidence,
          totalCostUsd,
          totalLatencyMs: totalDuration,
          totalTokens,
          participatingModels,
          transcript: transcript.map((t) => ({
            turn: t.turn,
            role: t.role,
            modelId: t.model.id,
            providerId: t.model.providerId,
            responseText: t.responseText,
            cost: t.cost,
            durationMs: t.durationMs,
            inputTokens: t.inputTokens,
            outputTokens: t.outputTokens,
            verdict: t.verdict,
            schedulerName: t.schedulerName,
            decisionReason: t.decisionReason,
            // Phase 2c shadow ensemble — only turn 1 carries it (the only
            // turn we fire shadow on). The closure-captured snapshot is
            // null when shadow disabled/timed-out/errored or when the
            // hook hasn't fired yet by persist time.
            shadowEnsemble: t.turn === 1 ? shadowSnapshot : null,
          })),
          traceSpans: trace.getSpans(),
        });
      }

      return this.assembleOrchestrationResult(
        finalResponseText,
        transcript,
        executions,
        totalCostUsd,
        totalDuration,
        stopReason,
        runId,
        metadata,
        trace,
      );
    } catch (error) {
      this.log.error(
        {
          runId,
          turnsCompleted: transcript.length,
          error: error instanceof Error ? error.message : String(error),
        },
        'tri-role-collective failed — falling back to consensus',
      );
      return this.executeFallback(request, context);
    }
  }

  private async executeFallback(
    request: ChatRequest,
    context: OrchestrationContext,
  ): Promise<OrchestrationResult> {
    const { ConsensusStrategy } = await import('./consensus-strategy');
    const fallback = new ConsensusStrategy();
    const adapterResolver = this.getAdapterForModel;
    if (adapterResolver) {
      // Same `narrowAs` channel sensitivity-consensus-strategy uses to
      // forward the runtime-injected `getAdapterForModel`. Centralising
      // the access-modifier widening at one auditable site keeps the
      // lint rule against `as unknown as` clean.
      narrowAs<{ getAdapterForModel?: typeof adapterResolver }>(fallback).getAdapterForModel =
        adapterResolver.bind(this);
    }
    return fallback.execute(request, context);
  }

  /**
   * Synthesize a CoordinationLimits-shaped struct so we can reuse the
   * cost guardrail (estimateRoundCost) without coupling tri-role to
   * the full coordination config.
   */
  private synthLimits(config: TriRoleConfig): CoordinationLimits {
    return {
      maxRounds: config.maxTurns,
      minConvergenceScore: 0,
      maxDecisionFlipRate: 1,
      maxDissent: 1,
      stopOnCriticalRisk: false,
      minValidSignalsPerRound: 1,
      detectStagnation: false,
      maxCostUsd: config.maxCostUsd,
      maxLatencyMs: config.maxLatencyMs,
    };
  }

  /**
   * Order the eligible pool for tri-role: try to honour the user's
   * preferred-model pin first (BaseStrategy convention), then keep
   * the existing relative order. Preserving order makes the
   * round-robin selection deterministic and reproducible across runs.
   */
  private orderPoolForTriRole(eligible: Model[], context: OrchestrationContext): Model[] {
    const preference = resolvePreferredExecutor(eligible, context, []);
    if (!preference) return eligible.slice(0, TRI_ROLE_MAX_MODELS);
    const remainder = preference.pinnedExecutor
      ? eligible.filter((m) => m.id !== preference.pinnedExecutor!.id)
      : eligible;
    return withPreferredFirst(preference, remainder).slice(0, TRI_ROLE_MAX_MODELS);
  }

  private assembleOrchestrationResult(
    finalResponseText: string,
    transcript: TurnRecord[],
    executions: ModelExecution[],
    totalCostUsd: number,
    totalDuration: number,
    stopReason: string,
    runId: string,
    metadata: StrategyMetadata,
    trace?: CollectiveTrace,
  ): OrchestrationResult {
    const completionWords = finalResponseText.split(/\s+/).filter(Boolean).length;
    const completionTokens = Math.ceil(completionWords * 1.3);
    const totalInputTokens = transcript.reduce((acc, t) => acc + t.inputTokens, 0);

    const finalResponse: ChatResponse = {
      id: `tri-${nanoid(10)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'tri-role-collective',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: finalResponseText },
          finish_reason: stopReason === 'accepted' ? 'stop' : 'length',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: totalInputTokens,
        completion_tokens: completionTokens,
        total_tokens: totalInputTokens + completionTokens,
      },
    };

    const auditorTurns = transcript.filter((t) => t.role === 'auditor');
    const lastAuditor = auditorTurns[auditorTurns.length - 1];

    return {
      strategyUsed: metadata.name,
      modelsUsed: executions,
      finalResponse,
      totalCost: totalCostUsd,
      totalDuration,
      qualityScore: stopReason === 'accepted' ? 0.9 : 0.6,
      metadata: {
        strategyId: metadata.id,
        runId,
        turnsExecuted: transcript.length,
        stopReason,
        roleSequence: transcript.map((t) => t.role),
        plannerModelId: transcript.find((t) => t.role === 'planner')?.model.id,
        finalSolverModelId: [...transcript].reverse().find((t) => t.role === 'solver')?.model.id,
        finalAuditorModelId: lastAuditor?.model.id,
        finalAuditorVerdict: lastAuditor?.verdict?.status,
        verdictInferred: lastAuditor?.verdict?.inferred ?? false,
        totalCostUsd,
        ...(trace ? { collectiveTrace: trace.describe() } : {}),
      },
    };
  }
}
