// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — CollectiveRun Repository (F1.5)
 *
 * Persistence layer for `CollectiveRun` + `CollectiveSignal` Prisma rows.
 *
 * Why a dedicated repository:
 *   - Keeps `coordination/` decoupled from Prisma. The strategy passes
 *     pure domain objects (CoordinationState + CoordinationResult); the
 *     repository handles all the type-mapping into Prisma's
 *     Decimal/JsonValue requirements.
 *   - Centralizes the org-scoped read paths so an accidental cross-tenant
 *     read can only originate here, where it is tested.
 *   - Wraps transactional writes (run + signals) in a single transaction
 *     so a partial write never leaves orphan signals.
 *
 * Persistence is gated by `CoordinationConfig.persistAuditTrail = true`.
 * Default `false` means the strategy never touches the DB on the hot
 * path; flipping the flag for an org enables full audit-trail
 * persistence at the cost of one transactional write per run.
 */

import { Prisma } from '@/generated/prisma/index.js';
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import type {
  CoordinationConfig,
  CoordinationResult,
  CoordinationSignal,
  CoordinationState,
} from './coordination-types';
import type { CollectiveSpan } from './collective-trace';
import type { ShadowEnsembleSnapshot } from './ensemble-coordinator-shadow';

const log = logger.child({ component: 'collective-run-repository' });

// ─── Types ──────────────────────────────────────────────────────────────

export interface PersistCollectiveRunInput {
  organizationId: string;
  /** When the run originated from a chat completion, this links back to RequestLog.requestId. */
  requestId?: string;
  state: CoordinationState;
  result: CoordinationResult;
  config: CoordinationConfig;
  /**
   * F2.10 — Full CollectiveTrace spans for forensic analysis. Only
   * persisted when supplied. The repository stores them under
   * `run.metadata.collectiveTraceSpans`. Operators retrieve them via
   * `GET /v1/collective/runs/:id/trace`.
   */
  traceSpans?: ReadonlyArray<CollectiveSpan>;
}

export interface CollectiveRunRecord {
  id: string;
  organizationId: string;
  requestId: string | null;
  strategy: string;
  rounds: number;
  stopReason: string;
  convergenceScore: number;
  decisionFlipRate: number;
  dissent: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  totalTokens: number;
  finalDecisionType: string | null;
  finalConfidence: number | null;
  metadata: Prisma.JsonValue;
  config: Prisma.JsonValue;
  createdAt: Date;
}

export interface CollectiveSignalRecord {
  id: string;
  runId: string;
  round: number;
  agentId: string;
  modelId: string;
  providerId: string;
  role: string | null;
  decisionType: string;
  decisionValue: Prisma.JsonValue;
  decisionConfidence: number;
  decisionRationale: string | null;
  sensitivities: Prisma.JsonValue;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  createdAt: Date;
}

// ─── Type-safe coercions ────────────────────────────────────────────────

/**
 * Decimal-safe number extractor. Prisma returns `Decimal` objects from
 * `@db.Decimal` columns; the rest of the coordination layer works with
 * plain `number`. We coerce here once instead of leaking Decimal upward.
 *
 * Uses `.toNumber()` when present (Decimal contract) and falls back to
 * `Number(value)` for already-primitive callers (test fixtures, etc.).
 */
function toFiniteNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  // `Decimal.toNumber()` is the documented public API.
  const n = value.toNumber();
  return Number.isFinite(n) ? n : 0;
}

function toFiniteNumberOrNull(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return toFiniteNumber(value);
}

/**
 * Prisma's `JsonValue` type allows `null`, primitives, arrays, and
 * objects. The CoordinationConfig and metadata are plain serializable
 * objects, so we narrow them to `InputJsonValue` for the create path.
 *
 * Using `Prisma.InputJsonValue` (not `as`) keeps the cast surface zero.
 */
function asJsonInput(value: unknown): Prisma.InputJsonValue {
  // `JSON.stringify` then `JSON.parse` removes any non-serializable
  // values (functions, undefined, symbols) so the resulting object
  // strictly matches `InputJsonValue`. For a hot path we could skip
  // this round-trip, but persistence is gated by `persistAuditTrail`
  // so the cost is acceptable for the safety guarantee.
  const serialized = JSON.stringify(value ?? null);
  const parsed: unknown = JSON.parse(serialized);
  return parsed as Prisma.InputJsonValue;
}

// ─── Mapping helpers ────────────────────────────────────────────────────

/**
 * Build the `CollectiveRun` create payload from a CoordinationResult.
 * Pure function — exported for testability of the mapping logic.
 */
export function buildCollectiveRunCreatePayload(
  input: PersistCollectiveRunInput,
): Prisma.CollectiveRunUncheckedCreateInput {
  const { organizationId, requestId, state, result, config } = input;

  return {
    organizationId,
    requestId: requestId ?? null,
    strategy: state.strategy,
    config: asJsonInput({
      maxRounds: config.maxRounds,
      minConvergenceScore: config.minConvergenceScore,
      maxDecisionFlipRate: config.maxDecisionFlipRate,
      maxDissent: config.maxDissent,
      maxCostUsd: config.maxCostUsd,
      maxLatencyMs: config.maxLatencyMs,
      stopOnCriticalRisk: config.stopOnCriticalRisk,
      aggregationMethod: config.aggregationMethod,
      entropySeedEnabled: config.entropySeedEnabled,
    }),

    rounds: result.roundsExecuted,
    stopReason: result.stopReason,
    convergenceScore: new Prisma.Decimal(result.convergence.score.toFixed(3)),
    decisionFlipRate: new Prisma.Decimal(result.convergence.decisionFlipRate.toFixed(3)),
    dissent: new Prisma.Decimal(result.convergence.dissent.toFixed(3)),

    totalCostUsd: new Prisma.Decimal(result.totalCostUsd.toFixed(6)),
    totalLatencyMs: Math.round(result.totalLatencyMs),
    totalTokens: Math.round(result.totalTokens),

    finalDecisionType: result.decision.type,
    finalConfidence: new Prisma.Decimal(result.decision.confidence.toFixed(2)),

    metadata: asJsonInput({
      participatingModels: result.participatingModels,
      criticalVariables: result.criticalVariables,
      dominantSensitivities: result.dominantSensitivities.map((s) => ({
        variable: s.variable,
        direction: s.direction,
        confidence: s.confidence,
      })),
      dissentCount: result.dissent.length,
      stableVariables: result.convergence.stableVariables,
      unstableVariables: result.convergence.unstableVariables,
      // F2.10 — Full trace spans, when the caller supplied them. The
      // value is bounded by `CollectiveTrace.maxSpans` (default 256).
      ...(input.traceSpans && input.traceSpans.length > 0
        ? { collectiveTraceSpans: input.traceSpans.map((s) => ({ ...s })) }
        : {}),
    }),
  };
}

/**
 * Build per-signal create payloads from the run's history. Returns []
 * when there are no signals to persist.
 */
export function buildCollectiveSignalCreatePayloads(
  signals: ReadonlyArray<CoordinationSignal>,
): ReadonlyArray<Omit<Prisma.CollectiveSignalUncheckedCreateInput, 'runId'>> {
  return signals.map((s) => ({
    round: s.round,
    agentId: s.agentId,
    modelId: s.modelId,
    providerId: s.providerId,
    role: s.role ?? null,
    decisionType: s.decision.type,
    decisionValue: asJsonInput(s.decision.value),
    decisionConfidence: new Prisma.Decimal(s.decision.confidence.toFixed(2)),
    decisionRationale: s.decision.rationale ?? null,
    sensitivities: asJsonInput(s.sensitivities),
    latencyMs: s.metrics?.latencyMs ?? null,
    inputTokens: s.metrics?.inputTokens ?? null,
    outputTokens: s.metrics?.outputTokens ?? null,
    costUsd: s.metrics?.estimatedCost !== undefined
      ? new Prisma.Decimal(s.metrics.estimatedCost.toFixed(6))
      : null,
  }));
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Persist a completed coordination run. Wraps the run + signals
 * inserts in a single transaction so a partial write never leaves
 * orphan signals or a run with no audit data.
 *
 * Returns the persisted `runId` on success, `null` on any failure
 * (logged but never thrown — persistence MUST NOT block the
 * orchestration response). Callers should treat this as fire-and-
 * forget for the response path; the audit trail is best-effort.
 */
export async function persistCollectiveRun(
  input: PersistCollectiveRunInput,
): Promise<{ runId: string } | null> {
  if (!input.organizationId) {
    log.warn('persistCollectiveRun: missing organizationId — skipping persist');
    return null;
  }

  try {
    const runPayload = buildCollectiveRunCreatePayload(input);
    const signalPayloads = buildCollectiveSignalCreatePayloads(
      input.result.auditTrail ?? input.state.history,
    );

    const result = await prisma.$transaction(async (tx) => {
      const run = await tx.collectiveRun.create({
        data: runPayload,
      });

      if (signalPayloads.length > 0) {
        await tx.collectiveSignal.createMany({
          data: signalPayloads.map((p) => ({ ...p, runId: run.id })),
        });
      }

      return { runId: run.id };
    });

    log.info(
      {
        runId: result.runId,
        organizationId: input.organizationId,
        signalCount: signalPayloads.length,
        rounds: input.result.roundsExecuted,
      },
      'CollectiveRun persisted',
    );

    return result;
  } catch (error) {
    log.warn(
      {
        organizationId: input.organizationId,
        runId: input.state.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      'persistCollectiveRun failed — continuing without persistence',
    );
    return null;
  }
}

// ─── Tri-Role persistence (F4.1 prep) ───────────────────────────────────

/**
 * Per-turn record passed by tri-role-collective. Mirrors the strategy's
 * internal TurnRecord but kept structural so the repository does not
 * import from a strategy file.
 */
export interface TriRoleTurnInput {
  turn: number;
  role: 'planner' | 'solver' | 'auditor';
  modelId: string;
  providerId: string;
  responseText: string;
  cost: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  verdict?: { status: 'accept' | 'revise'; feedback: string; inferred: boolean };
  /** F4.1 audit substrate — captured by decideRoleForTurn. */
  schedulerName?: string;
  decisionReason?: string;
  /**
   * Phase 2c shadow ensemble snapshot — present when the shadow wire
   * fired for this turn (currently turn 1 only) AND the ensemble
   * responded before persistence. Null when shadow was disabled,
   * timed out, or failed. Persisted into decision_value.shadowEnsemble
   * for F3.3 export.
   */
  shadowEnsemble?: ShadowEnsembleSnapshot | null;
}

export interface PersistTriRoleRunInput {
  organizationId: string;
  /** Links back to RequestLog when the run originated from a chat completion. */
  requestId?: string;
  /** Run UUID generated by the strategy. */
  runId: string;
  /** Strategy config snapshot. */
  config: {
    maxTurns: number;
    maxCostUsd: number;
    maxLatencyMs: number;
    ambiguityResolution: 'accept' | 'revise';
  };
  /** Final outcome state. */
  stopReason: string;
  finalDecisionType: string;
  finalConfidence: number;
  /** Cumulative resource use. */
  totalCostUsd: number;
  totalLatencyMs: number;
  totalTokens: number;
  /** Models that played at least one turn. */
  participatingModels: ReadonlyArray<{ modelId: string; modelName: string; providerId: string }>;
  transcript: ReadonlyArray<TriRoleTurnInput>;
  /** F2.10 trace spans for the run, when available. */
  traceSpans?: ReadonlyArray<CollectiveSpan>;
}

/**
 * Build the tri-role `CollectiveRun` create payload. Pure function —
 * exported for unit-testability of the mapping logic.
 */
export function buildTriRoleRunCreatePayload(
  input: PersistTriRoleRunInput,
): Prisma.CollectiveRunUncheckedCreateInput {
  // tri-role has no parallel-signal convergence; we encode the
  // accept/no-accept outcome as 1/0 so the decimal column is still
  // queryable (e.g., "show me successful tri-role runs").
  const finalConvergenceScore = input.stopReason === 'accepted' ? 1 : 0;

  return {
    organizationId: input.organizationId,
    requestId: input.requestId ?? null,
    strategy: 'tri-role-collective',
    config: asJsonInput({
      maxTurns: input.config.maxTurns,
      maxCostUsd: input.config.maxCostUsd,
      maxLatencyMs: input.config.maxLatencyMs,
      ambiguityResolution: input.config.ambiguityResolution,
    }),

    rounds: input.transcript.length,
    stopReason: input.stopReason,
    convergenceScore: new Prisma.Decimal(finalConvergenceScore.toFixed(3)),
    decisionFlipRate: new Prisma.Decimal('0.000'),
    dissent: new Prisma.Decimal('0.000'),

    totalCostUsd: new Prisma.Decimal(input.totalCostUsd.toFixed(6)),
    totalLatencyMs: Math.round(input.totalLatencyMs),
    totalTokens: Math.round(input.totalTokens),

    finalDecisionType: input.finalDecisionType,
    finalConfidence: new Prisma.Decimal(input.finalConfidence.toFixed(2)),

    metadata: asJsonInput({
      participatingModels: input.participatingModels,
      // tri-role does not produce sensitivity vectors or critical-variable
      // analysis. We omit those keys (rather than storing empty arrays)
      // so downstream consumers can branch on presence.
      ...(input.traceSpans && input.traceSpans.length > 0
        ? { collectiveTraceSpans: input.traceSpans.map((s) => ({ ...s })) }
        : {}),
    }),
  };
}

/**
 * Build the tri-role per-turn `CollectiveSignal` create payloads. Pure
 * function — exported for testability.
 */
export function buildTriRoleSignalCreatePayloads(
  transcript: ReadonlyArray<TriRoleTurnInput>,
): ReadonlyArray<Omit<Prisma.CollectiveSignalUncheckedCreateInput, 'runId'>> {
  return transcript.map((t) => {
    // decisionType encodes role + verdict (when applicable) so the F3.3
    // export can stratify training data without parsing JSON.
    const decisionType =
      t.role === 'auditor' && t.verdict
        ? `verdict-${t.verdict.status}`
        : t.role;

    const decisionValue: Record<string, unknown> = {
      responseText: t.responseText,
      ...(t.verdict
        ? {
            verdict: {
              status: t.verdict.status,
              feedback: t.verdict.feedback,
              inferred: t.verdict.inferred,
            },
          }
        : {}),
      // F4.1 audit substrate — also stored at the signal level so a
      // downstream trainer doesn't need to cross-reference the
      // metadata.collectiveTraceSpans array to recover it.
      ...(t.schedulerName ? { schedulerName: t.schedulerName } : {}),
      ...(t.decisionReason ? { decisionReason: t.decisionReason } : {}),
      // Phase 2c shadow ensemble — null when shadow disabled/timed-out
      // /errored OR for non-turn-1 turns of tri-role (we only fire
      // shadow on turn 1). Null is preserved (not omitted) so F3.3
      // export gets a stable schema across all signal records.
      ...(t.shadowEnsemble !== undefined ? { shadowEnsemble: t.shadowEnsemble } : {}),
    };

    return {
      round: t.turn,
      agentId: `${t.role}-turn-${t.turn}`,
      modelId: t.modelId,
      providerId: t.providerId,
      role: t.role,
      decisionType,
      decisionValue: asJsonInput(decisionValue),
      // tri-role decisions are deterministic from the role + transcript
      // when the verdict is unambiguous. For inferred (ambiguous)
      // verdicts we lower the confidence to 0.5 so the trainer can
      // weight uncertain signals down.
      decisionConfidence: new Prisma.Decimal(
        t.verdict?.inferred ? '0.50' : '1.00',
      ),
      decisionRationale: t.verdict?.feedback ?? null,
      sensitivities: asJsonInput([]),
      latencyMs: t.durationMs,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      costUsd: new Prisma.Decimal(t.cost.toFixed(6)),
    };
  });
}

/**
 * Persist a tri-role-collective run + per-turn signals. Direct mapping
 * (no CoordinationState/CoordinationResult adapter) because tri-role's
 * data shape is genuinely different from sensitivity-consensus:
 *
 *   - tri-role is sequential, no parallel agents and no convergence
 *     across signals;
 *   - tri-role does not emit numeric sensitivities;
 *   - decision is "what role produced what answer/verdict", not "which
 *     consensus value did the agents settle on".
 *
 * The schema is general enough to host both via the `role` field and
 * the JSONB `decision_value` payload. Persistence is gated by
 * `process.env.CI_COORDINATION_PERSIST_AUDIT === 'true'` (same flag as
 * sensitivity-consensus) so operators flip both strategies at once.
 *
 * Returns the persisted runId on success, `null` on any failure (logged
 * but never thrown — persistence MUST NOT block the orchestration
 * response). Best-effort, fire-and-forget at the strategy level.
 */
export async function persistTriRoleRun(
  input: PersistTriRoleRunInput,
): Promise<{ runId: string } | null> {
  if (!input.organizationId) {
    log.warn('persistTriRoleRun: missing organizationId — skipping persist');
    return null;
  }

  try {
    const runPayload = buildTriRoleRunCreatePayload(input);
    const signalPayloads = buildTriRoleSignalCreatePayloads(input.transcript);

    const result = await prisma.$transaction(async (tx) => {
      const run = await tx.collectiveRun.create({ data: runPayload });

      if (signalPayloads.length > 0) {
        await tx.collectiveSignal.createMany({
          data: signalPayloads.map((p) => ({ ...p, runId: run.id })),
        });
      }

      return { runId: run.id };
    });

    log.info(
      {
        runId: result.runId,
        organizationId: input.organizationId,
        signalCount: signalPayloads.length,
        rounds: input.transcript.length,
        stopReason: input.stopReason,
      },
      'TriRoleRun persisted',
    );

    return result;
  } catch (error) {
    log.warn(
      {
        organizationId: input.organizationId,
        runId: input.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      'persistTriRoleRun failed — continuing without persistence',
    );
    return null;
  }
}

// ─── Debate persistence (F4.1 audit-flow extension) ─────────────────────

/**
 * One position taken by one debater within one round, OR the moderator's
 * synthesis. Structural shape so the repository stays decoupled from the
 * strategy's internal `DebateRound`/`DebateParticipant` types.
 */
export interface DebateSignalInput {
  round: number;
  agentName: string;
  modelId: string;
  providerId: string;
  role: 'debater' | 'moderator';
  /**
   * `'opening'`     — opening statement (round 1)
   * `'response'`    — response to other debaters (round ≥ 2)
   * `'synthesis'`   — moderator's final aggregate (last round)
   */
  decisionType: 'opening' | 'response' | 'synthesis';
  text: string;
  /** Name of the debater this position is responding to (when applicable). */
  respondingTo?: string;
  durationMs: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * F4.1 audit substrate — only the synthesis signal carries these,
   * because moderator selection is the central decision a future
   * coordinator would replace.
   */
  schedulerName?: string;
  decisionReason?: string;
  /**
   * Phase 2c shadow ensemble snapshot — only the synthesis signal
   * carries it (mirrors moderatorScheduler/moderatorReason placement).
   * Persisted into decision_value.shadowEnsemble for F3.3 export.
   */
  shadowEnsemble?: ShadowEnsembleSnapshot | null;
}

export interface PersistDebateRunInput {
  organizationId: string;
  requestId?: string;
  runId: string;
  config: {
    maxParticipants: number;
    numDebateRounds: number;
  };
  /** F4.1 moderator-selection audit captured by assignModeratorRole. */
  moderatorScheduler: string;
  moderatorReason: string;
  /**
   * `'completed'`  — moderator synthesis succeeded (default success path)
   * `'no_synthesis'` — synthesis failed before producing output
   * `'budget_exhausted'` — terminated before completion due to limits
   */
  stopReason: string;
  totalCostUsd: number;
  totalLatencyMs: number;
  totalTokens: number;
  participatingModels: ReadonlyArray<{ modelId: string; modelName: string; providerId: string }>;
  /**
   * Flat sequence of signals: one per debater-position, ending with one
   * moderator-synthesis signal. The strategy is responsible for ordering
   * them as (round 1 positions × N debaters, round 2 positions × N, …,
   * synthesis).
   */
  signals: ReadonlyArray<DebateSignalInput>;
  traceSpans?: ReadonlyArray<CollectiveSpan>;
}

/**
 * Build the `CollectiveRun` create payload for a debate run. Pure —
 * exported for unit-testability of the mapping logic.
 */
export function buildDebateRunCreatePayload(
  input: PersistDebateRunInput,
): Prisma.CollectiveRunUncheckedCreateInput {
  // Convergence semantics for debate: a "successful" run is one whose
  // moderator synthesis ran. Encode as 1.0/0.0 so downstream queries can
  // filter `convergence_score = 1` for the success cohort.
  const convergence = input.stopReason === 'completed' ? 1 : 0;

  return {
    organizationId: input.organizationId,
    requestId: input.requestId ?? null,
    strategy: 'debate',
    config: asJsonInput({
      maxParticipants: input.config.maxParticipants,
      numDebateRounds: input.config.numDebateRounds,
    }),
    rounds: input.config.numDebateRounds,
    stopReason: input.stopReason,
    convergenceScore: new Prisma.Decimal(convergence.toFixed(3)),
    decisionFlipRate: new Prisma.Decimal('0.000'),
    dissent: new Prisma.Decimal('0.000'),
    totalCostUsd: new Prisma.Decimal(input.totalCostUsd.toFixed(6)),
    totalLatencyMs: Math.round(input.totalLatencyMs),
    totalTokens: Math.round(input.totalTokens),
    finalDecisionType: 'synthesis',
    finalConfidence: new Prisma.Decimal('1.00'),
    metadata: asJsonInput({
      participatingModels: input.participatingModels,
      // F4.1 audit substrate at the run level (mirrored on the synthesis
      // signal). Stored both places so trainers can stratify either by
      // run or by per-signal granularity.
      moderatorScheduler: input.moderatorScheduler,
      moderatorReason: input.moderatorReason,
      ...(input.traceSpans && input.traceSpans.length > 0
        ? { collectiveTraceSpans: input.traceSpans.map((s) => ({ ...s })) }
        : {}),
    }),
  };
}

export function buildDebateSignalCreatePayloads(
  signals: ReadonlyArray<DebateSignalInput>,
): ReadonlyArray<Omit<Prisma.CollectiveSignalUncheckedCreateInput, 'runId'>> {
  return signals.map((s) => {
    const decisionValue: Record<string, unknown> = {
      text: s.text,
      ...(s.respondingTo ? { respondingTo: s.respondingTo } : {}),
      ...(s.schedulerName ? { schedulerName: s.schedulerName } : {}),
      ...(s.decisionReason ? { decisionReason: s.decisionReason } : {}),
      // Phase 2c shadow ensemble — only the synthesis signal carries a
      // non-null snapshot (mirrors moderatorScheduler/moderatorReason).
      ...(s.shadowEnsemble !== undefined ? { shadowEnsemble: s.shadowEnsemble } : {}),
    };
    return {
      round: s.round,
      agentId: `${s.role}-${s.agentName}-round-${s.round}`,
      modelId: s.modelId,
      providerId: s.providerId,
      role: s.role,
      decisionType: s.decisionType,
      decisionValue: asJsonInput(decisionValue),
      // Debate signals are model outputs without an explicit confidence
      // score. We default to 1.0; the moderator's synthesis is also 1.0
      // because the strategy treats a successful moderator output as
      // authoritative (Arrow's-theorem mitigation is logged but not
      // reflected in confidence).
      decisionConfidence: new Prisma.Decimal('1.00'),
      decisionRationale: null,
      sensitivities: asJsonInput([]),
      latencyMs: s.durationMs,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      costUsd: new Prisma.Decimal(s.cost.toFixed(6)),
    };
  });
}

/**
 * Persist a debate run + per-signal audit trail. Same gating as
 * persistCollectiveRun / persistTriRoleRun. Best-effort: any failure is
 * logged and returns null without blocking the orchestration response.
 */
export async function persistDebateRun(
  input: PersistDebateRunInput,
): Promise<{ runId: string } | null> {
  if (!input.organizationId) {
    log.warn('persistDebateRun: missing organizationId — skipping persist');
    return null;
  }

  try {
    const runPayload = buildDebateRunCreatePayload(input);
    const signalPayloads = buildDebateSignalCreatePayloads(input.signals);

    const result = await prisma.$transaction(async (tx) => {
      const run = await tx.collectiveRun.create({ data: runPayload });
      if (signalPayloads.length > 0) {
        await tx.collectiveSignal.createMany({
          data: signalPayloads.map((p) => ({ ...p, runId: run.id })),
        });
      }
      return { runId: run.id };
    });

    log.info(
      {
        runId: result.runId,
        organizationId: input.organizationId,
        signalCount: signalPayloads.length,
        stopReason: input.stopReason,
      },
      'DebateRun persisted',
    );

    return result;
  } catch (error) {
    log.warn(
      {
        organizationId: input.organizationId,
        runId: input.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      'persistDebateRun failed — continuing without persistence',
    );
    return null;
  }
}

// ─── Expert-Panel persistence (F4.1 audit-flow extension) ───────────────

/**
 * One per-expert consultation, one per cross-review (when present), and
 * one for the coordinator synthesis. Structural shape — repository
 * does not import from the strategy.
 */
export interface ExpertPanelSignalInput {
  /** 1 for consultations, 2 for cross-reviews, 3 for synthesis. */
  round: number;
  agentName: string;
  modelId: string;
  providerId: string;
  role: 'expert' | 'reviewer' | 'coordinator';
  decisionType: 'expert-opinion' | 'cross-review' | 'synthesis';
  text: string;
  /** Domain assigned to the expert (consultations only). */
  domain?: string;
  /** Name of expert being reviewed (cross-review only). */
  reviewedExpert?: string;
  durationMs: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  /** F4.1 audit on the synthesis signal only (panel-level decision). */
  schedulerName?: string;
  decisionReason?: string;
  /**
   * Phase 2c shadow ensemble snapshot — synthesis signal only.
   * Persisted into decision_value.shadowEnsemble for F3.3 export.
   */
  shadowEnsemble?: ShadowEnsembleSnapshot | null;
}

export interface PersistExpertPanelRunInput {
  organizationId: string;
  requestId?: string;
  runId: string;
  config: {
    expertCount: number;
    domains: ReadonlyArray<string>;
    crossReviewEnabled: boolean;
  };
  /** F4.1 panel-selection audit captured by selectPanel. */
  panelScheduler: string;
  panelReason: string;
  stopReason: string;
  totalCostUsd: number;
  totalLatencyMs: number;
  totalTokens: number;
  participatingModels: ReadonlyArray<{ modelId: string; modelName: string; providerId: string }>;
  signals: ReadonlyArray<ExpertPanelSignalInput>;
  traceSpans?: ReadonlyArray<CollectiveSpan>;
}

export function buildExpertPanelRunCreatePayload(
  input: PersistExpertPanelRunInput,
): Prisma.CollectiveRunUncheckedCreateInput {
  const convergence = input.stopReason === 'completed' ? 1 : 0;

  return {
    organizationId: input.organizationId,
    requestId: input.requestId ?? null,
    strategy: 'expert-panel',
    config: asJsonInput({
      expertCount: input.config.expertCount,
      domains: input.config.domains,
      crossReviewEnabled: input.config.crossReviewEnabled,
    }),
    rounds: input.config.crossReviewEnabled ? 3 : 2, // consultations, [cross-review], synthesis
    stopReason: input.stopReason,
    convergenceScore: new Prisma.Decimal(convergence.toFixed(3)),
    decisionFlipRate: new Prisma.Decimal('0.000'),
    dissent: new Prisma.Decimal('0.000'),
    totalCostUsd: new Prisma.Decimal(input.totalCostUsd.toFixed(6)),
    totalLatencyMs: Math.round(input.totalLatencyMs),
    totalTokens: Math.round(input.totalTokens),
    finalDecisionType: 'synthesis',
    finalConfidence: new Prisma.Decimal('1.00'),
    metadata: asJsonInput({
      participatingModels: input.participatingModels,
      domains: input.config.domains,
      panelScheduler: input.panelScheduler,
      panelReason: input.panelReason,
      ...(input.traceSpans && input.traceSpans.length > 0
        ? { collectiveTraceSpans: input.traceSpans.map((s) => ({ ...s })) }
        : {}),
    }),
  };
}

export function buildExpertPanelSignalCreatePayloads(
  signals: ReadonlyArray<ExpertPanelSignalInput>,
): ReadonlyArray<Omit<Prisma.CollectiveSignalUncheckedCreateInput, 'runId'>> {
  return signals.map((s) => {
    const decisionValue: Record<string, unknown> = {
      text: s.text,
      ...(s.domain ? { domain: s.domain } : {}),
      ...(s.reviewedExpert ? { reviewedExpert: s.reviewedExpert } : {}),
      ...(s.schedulerName ? { schedulerName: s.schedulerName } : {}),
      ...(s.decisionReason ? { decisionReason: s.decisionReason } : {}),
      // Phase 2c shadow ensemble — only the synthesis signal carries it.
      ...(s.shadowEnsemble !== undefined ? { shadowEnsemble: s.shadowEnsemble } : {}),
    };
    return {
      round: s.round,
      agentId: `${s.role}-${s.agentName}-round-${s.round}`,
      modelId: s.modelId,
      providerId: s.providerId,
      role: s.role,
      decisionType: s.decisionType,
      decisionValue: asJsonInput(decisionValue),
      decisionConfidence: new Prisma.Decimal('1.00'),
      decisionRationale: null,
      sensitivities: asJsonInput([]),
      latencyMs: s.durationMs,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      costUsd: new Prisma.Decimal(s.cost.toFixed(6)),
    };
  });
}

export async function persistExpertPanelRun(
  input: PersistExpertPanelRunInput,
): Promise<{ runId: string } | null> {
  if (!input.organizationId) {
    log.warn('persistExpertPanelRun: missing organizationId — skipping persist');
    return null;
  }

  try {
    const runPayload = buildExpertPanelRunCreatePayload(input);
    const signalPayloads = buildExpertPanelSignalCreatePayloads(input.signals);

    const result = await prisma.$transaction(async (tx) => {
      const run = await tx.collectiveRun.create({ data: runPayload });
      if (signalPayloads.length > 0) {
        await tx.collectiveSignal.createMany({
          data: signalPayloads.map((p) => ({ ...p, runId: run.id })),
        });
      }
      return { runId: run.id };
    });

    log.info(
      {
        runId: result.runId,
        organizationId: input.organizationId,
        signalCount: signalPayloads.length,
        stopReason: input.stopReason,
      },
      'ExpertPanelRun persisted',
    );

    return result;
  } catch (error) {
    log.warn(
      {
        organizationId: input.organizationId,
        runId: input.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      'persistExpertPanelRun failed — continuing without persistence',
    );
    return null;
  }
}

/**
 * Fetch a run by id, ENFORCING tenant isolation. Returns `null` when
 * the row does not exist OR when the org id does not match — the two
 * cases are deliberately indistinguishable to callers so a malicious
 * actor cannot enumerate run ids by probing for 403 vs 404.
 */
export async function getCollectiveRun(
  runId: string,
  organizationId: string,
): Promise<{ run: CollectiveRunRecord; signals: CollectiveSignalRecord[] } | null> {
  if (!runId || !organizationId) return null;

  try {
    const row = await prisma.collectiveRun.findFirst({
      where: { id: runId, organizationId },
      include: {
        signals: {
          orderBy: [
            { round: 'asc' },
            { createdAt: 'asc' },
          ],
        },
      },
    });

    if (!row) return null;

    const run: CollectiveRunRecord = {
      id: row.id,
      organizationId: row.organizationId,
      requestId: row.requestId,
      strategy: row.strategy,
      rounds: row.rounds,
      stopReason: row.stopReason,
      convergenceScore: toFiniteNumber(row.convergenceScore),
      decisionFlipRate: toFiniteNumber(row.decisionFlipRate),
      dissent: toFiniteNumber(row.dissent),
      totalCostUsd: toFiniteNumber(row.totalCostUsd),
      totalLatencyMs: row.totalLatencyMs,
      totalTokens: row.totalTokens,
      finalDecisionType: row.finalDecisionType,
      finalConfidence: toFiniteNumberOrNull(row.finalConfidence),
      metadata: row.metadata,
      config: row.config,
      createdAt: row.createdAt,
    };

    const signals: CollectiveSignalRecord[] = row.signals.map((s) => ({
      id: s.id,
      runId: s.runId,
      round: s.round,
      agentId: s.agentId,
      modelId: s.modelId,
      providerId: s.providerId,
      role: s.role,
      decisionType: s.decisionType,
      decisionValue: s.decisionValue,
      decisionConfidence: toFiniteNumber(s.decisionConfidence),
      decisionRationale: s.decisionRationale,
      sensitivities: s.sensitivities,
      latencyMs: s.latencyMs,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      costUsd: toFiniteNumberOrNull(s.costUsd),
      createdAt: s.createdAt,
    }));

    return { run, signals };
  } catch (error) {
    log.error(
      {
        runId,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      },
      'getCollectiveRun failed',
    );
    return null;
  }
}

/**
 * List runs for one request id, ENFORCING tenant isolation. A request
 * that triggered fallback may have multiple runs (the failed run +
 * the fallback run) — order by createdAt so the newest is first.
 */
export async function listCollectiveRunsByRequestId(
  requestId: string,
  organizationId: string,
  limit = 10,
): Promise<CollectiveRunRecord[]> {
  if (!requestId || !organizationId) return [];

  try {
    const rows = await prisma.collectiveRun.findMany({
      where: { requestId, organizationId },
      orderBy: [{ createdAt: 'desc' }],
      take: Math.max(1, Math.min(100, limit)),
    });

    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      requestId: row.requestId,
      strategy: row.strategy,
      rounds: row.rounds,
      stopReason: row.stopReason,
      convergenceScore: toFiniteNumber(row.convergenceScore),
      decisionFlipRate: toFiniteNumber(row.decisionFlipRate),
      dissent: toFiniteNumber(row.dissent),
      totalCostUsd: toFiniteNumber(row.totalCostUsd),
      totalLatencyMs: row.totalLatencyMs,
      totalTokens: row.totalTokens,
      finalDecisionType: row.finalDecisionType,
      finalConfidence: toFiniteNumberOrNull(row.finalConfidence),
      metadata: row.metadata,
      config: row.config,
      createdAt: row.createdAt,
    }));
  } catch (error) {
    log.error(
      {
        requestId,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      },
      'listCollectiveRunsByRequestId failed',
    );
    return [];
  }
}
