// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Collective Synthesis Aggregator
 *
 * F1.2 — Implements the LLM-mediated aggregation path declared as
 * `aggregationMethod = 'llm_synthesis'` in `CoordinationConfig`.
 *
 * Background:
 *   The numeric methods (`weighted_confidence`, `median`, `trimmed_mean`)
 *   in `sensitivity-aggregator.ts` are deterministic and cheap, but they
 *   collapse into majority-vote on textual sensitivities — losing the
 *   nuanced cross-agent reasoning that LLMs naturally produce. The
 *   `llm_synthesis` method preserves this signal by asking a coordinator
 *   model to fuse the agents' decision+sensitivity tuples into an
 *   updated coordination state.
 *
 * Until this module landed, `aggregateSignals(..., 'llm_synthesis')`
 * silently fell back to `hybrid` (see [sensitivity-aggregator.ts:313]).
 * That created a configuration honesty problem: operators that selected
 * `llm_synthesis` got `hybrid` behavior with no signal in the metrics.
 *
 * Design contract:
 *   1. Coordinator selection is the CALLER's responsibility (see
 *      `selectCoordinatorModel`). The aggregator receives a thin
 *      `CoordinatorExecutor` callback that already encloses the chosen
 *      adapter + model. This keeps `coordination/` free of provider /
 *      adapter / strategy concerns.
 *   2. EVERY untrusted text segment that flows into the synthesis prompt
 *      passes through `collective-prompt-safety` so a malicious or
 *      hallucinating signal cannot escape into the coordinator's system
 *      context.
 *   3. ALL failure modes — coordinator unavailable, timeout, parse
 *      error, budget exceeded — trigger a graceful fallback to a
 *      deterministic numeric aggregator (same shape, same contract).
 *      The fallback is the rule, not the exception: a synthesis call
 *      that fails MUST NOT block coordination from progressing.
 *   4. The LLM's reported `convergenceScore` and variable values are
 *      consumed verbatim, but `decisionFlipRate` is recomputed
 *      deterministically from the signals to prevent the coordinator
 *      from gaming the stop conditions.
 *
 * This module is async; the existing `aggregateSignals()` remains sync
 * and is called as the fallback path so callers can treat synthesis as
 * a drop-in upgrade without changing return-type expectations.
 */

import type { ChatRequest, ChatResponse, Model } from '@/types';
import type {
  CoordinationSignal,
  CoordinationState,
  SensitivityAggregationResult,
  VariableState,
  ConvergenceMetrics,
  CoordinationRisk,
  AggregationMethod,
} from './coordination-types';
import { aggregateSignals } from './sensitivity-aggregator';
import { extractResponseText } from './sensitivity-prompt-adapter';
import {
  sanitizeForPromptContext,
  sanitizeRiskDescription,
  sanitizeRiskSeverity,
  sanitizeVariableName,
  sanitizeVariableValue,
} from './collective-prompt-safety';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'collective-synthesis-aggregator' });

// ─── Public types ───────────────────────────────────────────────────────

/**
 * Result of one coordinator call. Mirrors the relevant subset of
 * `ModelExecution` so `coordination/` stays free of orchestration types.
 */
export interface CoordinatorExecutionResult {
  response: ChatResponse;
  cost: number;
  durationMs: number;
}

/**
 * Caller-supplied callback that runs ONE coordinator chat completion.
 * The strategy provides this closing over its `executeModel` so the
 * aggregator does not need to know about `ProviderAdapter` or about
 * the cost/feedback wiring already in `BaseStrategy.executeModel`.
 */
export type CoordinatorExecutor = (request: ChatRequest) => Promise<CoordinatorExecutionResult>;

/**
 * Strict-but-friendly options. All fields are required so callers must
 * make explicit decisions (no surprise defaults shifting between
 * versions).
 */
export interface CollectiveSynthesisOptions {
  /** Coordinator model id, used only for log/metric attribution. */
  coordinatorModelId: string;
  /** Hard cap on the synthesis cost in USD. */
  maxSynthesisCostUsd: number;
  /** Wall-clock timeout for the coordinator call in milliseconds. */
  timeoutMs: number;
  /**
   * Numeric aggregator to fall back to when synthesis cannot run or
   * its output cannot be parsed. `hybrid` and `weighted_confidence`
   * are the safest choices.
   */
  fallbackMethod: Exclude<AggregationMethod, 'llm_synthesis'>;
}

/**
 * Internal shape of a well-formed synthesis response. The parser
 * normalizes whatever the coordinator emits into this struct before
 * the aggregator translates it into `SensitivityAggregationResult`.
 */
interface SynthesisResponse {
  updatedVariables: Record<string, {
    value: unknown;
    confidence: number;
    rationale?: string;
  }>;
  convergenceScore: number;
  disagreementScore: number;
  stabilityScore: number;
  dominantVariables: string[];
  conflictingVariables: string[];
}

// ─── Coordinator selection ──────────────────────────────────────────────

/**
 * Pick a coordinator from the eligible pool. Returns `null` when no
 * suitable candidate exists; the caller MUST fall back to the numeric
 * aggregator in that case.
 *
 * Selection rule (deterministic, audit-friendly):
 *   1. Exclude the round's participants — using a participant model as
 *      coordinator would double-count its perspective and bias the
 *      fused state toward whichever agent already dominated.
 *   2. Prefer higher `performance.qualityScore` (better synthesis).
 *   3. Tie-break by lower `inputCostPer1k` so synthesis remains cheap
 *      even with multiple high-quality candidates.
 *
 * The "highest-quality non-participant" heuristic was chosen over
 * round-robin because synthesis is the SINGLE most-important LLM call
 * in the round (it shapes every subsequent decision); under-investing
 * here would defeat the point of `llm_synthesis`.
 */
export function selectCoordinatorModel(
  participants: ReadonlyArray<Model>,
  pool: ReadonlyArray<Model>,
): Model | null {
  if (pool.length === 0) return null;

  const participantIds = new Set<string>();
  for (const m of participants) participantIds.add(m.id);

  const candidates = pool.filter((m) => !participantIds.has(m.id));
  if (candidates.length === 0) return null;

  const ranked = [...candidates].sort((a, b) => {
    // `ModelPerformance.quality` is the canonical 0..1 quality score
    // (see api/src/types/index.ts). Older code referred to it as
    // `qualityScore` from a different Prisma metric type — using the
    // canonical name keeps this aggregator aligned with the rest of
    // the orchestration layer.
    const qa = Number.isFinite(a.performance?.quality) ? a.performance.quality : 0;
    const qb = Number.isFinite(b.performance?.quality) ? b.performance.quality : 0;
    if (qb !== qa) return qb - qa;

    const ca = Number.isFinite(a.inputCostPer1k) ? a.inputCostPer1k : Number.POSITIVE_INFINITY;
    const cb = Number.isFinite(b.inputCostPer1k) ? b.inputCostPer1k : Number.POSITIVE_INFINITY;
    return ca - cb;
  });

  return ranked[0] ?? null;
}

// ─── Prompt construction ────────────────────────────────────────────────

/**
 * Format a single signal as a compact, sanitized block suitable for
 * inclusion in the synthesis prompt. Every free-form field flows
 * through `collective-prompt-safety` to neutralize structural
 * injection (newlines, fence-breaks, template markers).
 */
function formatSignalForSynthesis(signal: CoordinationSignal, idx: number): string {
  const lines: string[] = [];
  lines.push(`Agent #${idx + 1} [${sanitizeVariableName(signal.agentId)}] (model=${sanitizeVariableName(signal.modelId)}):`);
  lines.push(`  Decision: type=${sanitizeForPromptContext(signal.decision.type, 60)}, confidence=${signal.decision.confidence.toFixed(2)}`);
  if (signal.decision.rationale) {
    lines.push(`  Rationale: ${sanitizeForPromptContext(signal.decision.rationale, 240)}`);
  }
  if (signal.sensitivities.length > 0) {
    lines.push('  Sensitivities:');
    for (const s of signal.sensitivities) {
      const trigger = sanitizeForPromptContext(s.trigger, 200);
      const rationale = sanitizeForPromptContext(s.rationale, 200);
      const variable = sanitizeVariableName(s.variable);
      // `direction` is a closed enum already validated by signal-validator
      // (increase | decrease | hold | block | unlock). The bounded
      // sanitization here is defense-in-depth in case the upstream
      // contract drifts; legitimate values are 8 chars or fewer so the
      // 16-char cap never truncates real data.
      const direction = sanitizeForPromptContext(s.direction, 16);
      const risk = s.risk ? sanitizeRiskSeverity(s.risk) : 'low';
      const delta = typeof s.expectedDelta === 'number' && Number.isFinite(s.expectedDelta)
        ? `, expectedDelta=${s.expectedDelta}`
        : '';
      lines.push(`    - var=${variable}, dir=${direction}${delta}, risk=${risk}, conf=${s.confidence.toFixed(2)}`);
      lines.push(`      trigger="${trigger}"`);
      lines.push(`      rationale="${rationale}"`);
    }
  }
  return lines.join('\n');
}

/**
 * Format the existing collective state as compact context. Mirrors
 * the structure used by `sensitivity-prompt-adapter.formatStateForPrompt`
 * but tuned for synthesis — drops the per-variable confidence/stability
 * detail (the coordinator will re-derive these) and surfaces risks more
 * prominently because they should weight the synthesis decision.
 */
function formatStateForSynthesis(state: CoordinationState): string {
  const parts: string[] = [];

  if (Object.keys(state.variables).length > 0) {
    parts.push('Existing variables:');
    for (const [name, varState] of Object.entries(state.variables)) {
      parts.push(
        `  - ${sanitizeVariableName(name)}: ${sanitizeVariableValue(varState.value)} (confidence ${varState.confidence.toFixed(2)})`,
      );
    }
  }

  if (state.risks.length > 0) {
    parts.push('Active risks:');
    for (const risk of state.risks.slice(0, 5)) {
      parts.push(`  - [${sanitizeRiskSeverity(risk.severity)}] ${sanitizeRiskDescription(risk.description)}`);
    }
  }

  if (parts.length === 0) {
    return '(no prior state — this is round 1)';
  }
  return parts.join('\n');
}

/**
 * Build the synthesis system prompt. The schema is explicit because
 * weaker coordinator models drift toward free-form prose without it.
 *
 * Exported for testability — the strategy does not need to call this
 * directly, but unit tests use it to assert that injection markers are
 * neutralized end-to-end.
 */
export function buildSynthesisPrompt(
  signals: CoordinationSignal[],
  state: CoordinationState,
): { system: string; user: string } {
  const stateContext = formatStateForSynthesis(state);
  const signalsBlock = signals.map((s, i) => formatSignalForSynthesis(s, i)).join('\n');

  const system = [
    'You are a sensitivity-aggregation coordinator in a multi-agent collective intelligence system.',
    '',
    'Your task is to fuse N agents\' decision+sensitivity signals into an updated coordination state.',
    '',
    'Strict rules:',
    '  1. Do NOT add facts that are not present in the supplied signals.',
    '  2. Down-weight signals whose sensitivities all point in the same direction with extreme confidence (>=0.99) — that is a herding signature.',
    '  3. When agents disagree on a variable\'s direction, mark it conflicting; do not silently pick one side.',
    '  4. Identify variables that block convergence (critical risks, persistent dissent).',
    '  5. Respond with VALID JSON ONLY, matching the schema below. No prose, no markdown.',
    '',
    'Output schema:',
    '{',
    '  "updatedVariables": {',
    '    "<variable-name>": {',
    '      "value": <number | string | boolean | object>,',
    '      "confidence": <0.0..1.0>,',
    '      "rationale": "<short, evidence-grounded explanation>"',
    '    }',
    '  },',
    '  "convergenceScore": <0.0..1.0 — overall agreement>,',
    '  "disagreementScore": <0.0..1.0 — fraction of agents disagreeing with majority>,',
    '  "stabilityScore": <0.0..1.0 — how stable the variables are vs prior round>,',
    '  "dominantVariables": ["<name>", ...],',
    '  "conflictingVariables": ["<name>", ...]',
    '}',
  ].join('\n');

  const user = [
    `Round ${state.round + 1} synthesis input.`,
    '',
    'Collective state so far:',
    stateContext,
    '',
    `Signals from ${signals.length} agent(s) in this round:`,
    signalsBlock,
    '',
    'Produce the updated coordination state JSON now.',
  ].join('\n');

  return { system, user };
}

// ─── Response parsing ───────────────────────────────────────────────────

function clamp01(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Best-effort extractor that locates the first balanced `{...}` block
 * in a string. The synthesis prompt asks for "JSON only" but weaker
 * coordinators occasionally wrap the JSON in markdown fences or prose.
 */
function extractJsonBlock(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fence = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) {
    const inner = fence[1].trim();
    if (inner.startsWith('{') && inner.endsWith('}')) return inner;
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.substring(first, last + 1);

  return null;
}

/**
 * Parse a coordinator response into a `SynthesisResponse`. Returns null
 * when the response is missing, malformed, or violates the schema. The
 * caller MUST treat null as a synthesis failure and fall back.
 *
 * Exported so unit tests can drive the parser without instantiating the
 * full executor pipeline.
 */
export function parseSynthesisResponse(rawText: string): SynthesisResponse | null {
  if (!rawText || typeof rawText !== 'string') return null;

  const jsonStr = extractJsonBlock(rawText);
  if (!jsonStr) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const rawVars = obj.updatedVariables;
  if (!rawVars || typeof rawVars !== 'object' || Array.isArray(rawVars)) return null;

  const updatedVariables: SynthesisResponse['updatedVariables'] = {};
  for (const [name, val] of Object.entries(rawVars as Record<string, unknown>)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    const v = val as Record<string, unknown>;
    const confidence = clamp01(v.confidence, 0.5);
    const rationale = typeof v.rationale === 'string' ? v.rationale : undefined;
    updatedVariables[name] = {
      value: v.value,
      confidence,
      rationale,
    };
  }

  return {
    updatedVariables,
    convergenceScore: clamp01(obj.convergenceScore, 0),
    disagreementScore: clamp01(obj.disagreementScore, 1),
    stabilityScore: clamp01(obj.stabilityScore, 0),
    dominantVariables: isStringArray(obj.dominantVariables) ? obj.dominantVariables : [],
    conflictingVariables: isStringArray(obj.conflictingVariables) ? obj.conflictingVariables : [],
  };
}

// ─── State transformation ───────────────────────────────────────────────

/**
 * Recompute decision-flip rate deterministically from signals. The
 * synthesis call may misreport agreement (the coordinator is a separate
 * LLM and could hallucinate); deriving the flip rate ourselves removes
 * one more vector for the coordinator to skew stop conditions.
 */
function computeDecisionFlipRate(
  signals: CoordinationSignal[],
  previousState: CoordinationState,
): number {
  if (previousState.round === 0) return 0;
  const previousRoundSignals = previousState.history.filter((s) => s.round === previousState.round);
  if (previousRoundSignals.length === 0) return 0;

  let flips = 0;
  for (const sig of signals) {
    const prev = previousRoundSignals.find((p) => p.agentId === sig.agentId);
    if (prev && prev.decision.type !== sig.decision.type) flips++;
  }
  return signals.length > 0 ? flips / signals.length : 0;
}

function buildVariableStateFromSynthesis(
  name: string,
  entry: SynthesisResponse['updatedVariables'][string],
  previous: VariableState | undefined,
  contributors: string[],
): VariableState {
  const stability = previous
    ? Math.max(0, 1 - Math.abs(entry.confidence - previous.confidence))
    : 1;
  return {
    value: entry.value as VariableState['value'],
    confidence: entry.confidence,
    updatedBy: contributors,
    rationale: entry.rationale ?? `synthesized via coordinator (${name})`,
    stability,
  };
}

/**
 * Translate a parsed `SynthesisResponse` into `SensitivityAggregationResult`.
 * Mirrors the structure returned by the deterministic `aggregateSignals`
 * path so the caller cannot tell — by shape alone — which path produced
 * the result.
 */
function applySynthesisToState(
  signals: CoordinationSignal[],
  previousState: CoordinationState,
  synthesis: SynthesisResponse,
  synthesisCostUsd: number,
  synthesisLatencyMs: number,
): SensitivityAggregationResult {
  const contributorIds = signals.map((s) => s.agentId);
  const newVariables: Record<string, VariableState> = { ...previousState.variables };

  for (const [name, entry] of Object.entries(synthesis.updatedVariables)) {
    newVariables[name] = buildVariableStateFromSynthesis(
      name,
      entry,
      previousState.variables[name],
      contributorIds,
    );
  }

  const stableVariables = synthesis.dominantVariables.filter((n) => Object.prototype.hasOwnProperty.call(newVariables, n));
  const unstableVariables = synthesis.conflictingVariables.filter((n) => Object.prototype.hasOwnProperty.call(newVariables, n));

  const decisionFlipRate = computeDecisionFlipRate(signals, previousState);

  const confidenceAvg = signals.length > 0
    ? signals.reduce((acc, s) => acc + s.decision.confidence, 0) / signals.length
    : 0;

  const convergence: ConvergenceMetrics = {
    score: synthesis.convergenceScore,
    decisionFlipRate,
    dissent: synthesis.disagreementScore,
    confidenceTrend: [...previousState.convergence.confidenceTrend, confidenceAvg],
    stableVariables,
    unstableVariables,
  };

  // Critical risks introduced by this round still propagate via the
  // signal-validator path (signals already carry sensitivity.risk). The
  // synthesis call does NOT introduce new risks unilaterally — that
  // would let the coordinator manufacture stop conditions.
  const newRisks: CoordinationRisk[] = [];
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

  const totalSignalCost = signals.reduce(
    (acc, s) => acc + (s.metrics?.estimatedCost ?? 0),
    0,
  );
  const maxSignalLatency = signals.reduce(
    (acc, s) => Math.max(acc, s.metrics?.latencyMs ?? 0),
    0,
  );
  const totalTokens = signals.reduce(
    (acc, s) => acc + (s.metrics?.inputTokens ?? 0) + (s.metrics?.outputTokens ?? 0),
    0,
  );

  const nextState: CoordinationState = {
    ...previousState,
    round: previousState.round + 1,
    variables: newVariables,
    convergence,
    risks: [...previousState.risks, ...newRisks],
    history: [...previousState.history, ...signals],
    totalCostUsd: previousState.totalCostUsd + totalSignalCost + synthesisCostUsd,
    totalLatencyMs: previousState.totalLatencyMs + Math.max(maxSignalLatency, synthesisLatencyMs),
    totalTokens: previousState.totalTokens + totalTokens,
  };

  return {
    nextState,
    dominantSignals: stableVariables,
    conflictingSignals: unstableVariables,
    updatedVariables: Object.keys(synthesis.updatedVariables),
    recommendedNextRound: synthesis.convergenceScore < previousState.limits.minConvergenceScore,
    risks: newRisks,
  };
}

// ─── Top-level synthesis call ───────────────────────────────────────────

/**
 * Promise wrapper that races a value against a wall-clock timeout.
 * Resolves to `null` on timeout (synthesis must fall back, not throw).
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Run an LLM-mediated synthesis aggregation. Returns the same
 * `SensitivityAggregationResult` shape produced by `aggregateSignals()`
 * so the caller is path-agnostic.
 *
 * On any failure (no signals, executor error, timeout, parse failure,
 * post-call cost over budget) the function falls back to the
 * deterministic numeric aggregator declared by `opts.fallbackMethod`.
 *
 * The function NEVER throws on synthesis errors — those are normal,
 * expected, and observed via metrics. It only throws if the fallback
 * itself throws (which `aggregateSignals` never does on valid input).
 */
export async function synthesizeViaCoordinator(
  signals: CoordinationSignal[],
  state: CoordinationState,
  executor: CoordinatorExecutor,
  opts: CollectiveSynthesisOptions,
): Promise<SensitivityAggregationResult> {
  if (signals.length === 0) {
    log.warn(
      { coordinatorModelId: opts.coordinatorModelId, runId: state.runId },
      'Synthesis received no signals — delegating to numeric aggregator',
    );
    return aggregateSignals(signals, state, opts.fallbackMethod);
  }

  const { system, user } = buildSynthesisPrompt(signals, state);
  const request: ChatRequest = {
    model: opts.coordinatorModelId,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: 1024,
  };

  let execution: CoordinatorExecutionResult | null;
  try {
    execution = await withTimeout(executor(request), opts.timeoutMs);
  } catch (err) {
    log.warn(
      {
        coordinatorModelId: opts.coordinatorModelId,
        runId: state.runId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Synthesis executor threw — falling back to numeric aggregator',
    );
    return aggregateSignals(signals, state, opts.fallbackMethod);
  }

  if (execution === null) {
    log.warn(
      { coordinatorModelId: opts.coordinatorModelId, runId: state.runId, timeoutMs: opts.timeoutMs },
      'Synthesis call timed out — falling back to numeric aggregator',
    );
    return aggregateSignals(signals, state, opts.fallbackMethod);
  }

  if (execution.cost > opts.maxSynthesisCostUsd) {
    log.warn(
      {
        coordinatorModelId: opts.coordinatorModelId,
        runId: state.runId,
        actualCostUsd: execution.cost,
        capUsd: opts.maxSynthesisCostUsd,
      },
      'Synthesis cost exceeded cap — discarding result and falling back',
    );
    return aggregateSignals(signals, state, opts.fallbackMethod);
  }

  const text = extractResponseText(execution.response);
  const parsed = parseSynthesisResponse(text);
  if (!parsed) {
    log.warn(
      {
        coordinatorModelId: opts.coordinatorModelId,
        runId: state.runId,
        responsePreview: text.slice(0, 200),
      },
      'Synthesis response was not parseable — falling back to numeric aggregator',
    );
    return aggregateSignals(signals, state, opts.fallbackMethod);
  }

  log.info(
    {
      coordinatorModelId: opts.coordinatorModelId,
      runId: state.runId,
      round: state.round + 1,
      synthesisCostUsd: execution.cost,
      synthesisLatencyMs: execution.durationMs,
      updatedVariables: Object.keys(parsed.updatedVariables).length,
      convergenceScore: parsed.convergenceScore,
    },
    'Synthesis completed successfully',
  );

  return applySynthesisToState(signals, state, parsed, execution.cost, execution.durationMs);
}
