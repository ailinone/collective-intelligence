// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Systems trace — the per-request processing history mirrored to Ailin Systems
 * (ailin.systems) so operators can audit a request from triage to output.
 *
 * Two planes, deliberately separate (ailinone/systems ADR-003):
 *
 *   1. STRUCTURE (always sent): `stages[]` — triage, strategy selection, each
 *      participant (role, provider/model, latency, tokens, cost, evaluator
 *      verdict/score/outlier), quality scoring, the final decision and the
 *      observer events. Only scalars on systems' attribute allowlist; no text
 *      derived from the user's data. Same privacy class as the flat row we
 *      already push.
 *
 *   2. CONTENT (on by default, kill switch): `trace_payloads[]` — the input,
 *      each participant's output, narration text and the final output. Built
 *      unless SYSTEMS_TRACE_CONTENT is set to anything other than an
 *      affirmative value (see isContentCaptureEnabled). Systems additionally
 *      requires its own SYSTEMS_TRACE_CONTENT_ENABLED + a dedicated key and
 *      stores it sealed; with either side off — or the key missing — the
 *      content is dropped, never stored in the clear.
 *
 * Pure functions: no I/O, never throw (a trace gap must not touch a request).
 */

import type { ChatRequest, ModelExecution, OrchestrationResult } from '@/types';

/** Systems caps `stages[]` at 32 and `trace_payloads[]` at 40 per request. */
export const MAX_STAGES = 32;
export const MAX_PAYLOADS = 40;
/** Systems truncates a payload at 64 KiB after redaction; do not ship more than it keeps. */
const MAX_PAYLOAD_CHARS = 60_000;
/**
 * Aggregate ceiling for one request's content. The request logger keeps up to
 * 1000 entries queued while the database is unreachable, so a per-request size
 * limited only per payload would multiply into real memory. The final output
 * and the input are kept first (see applyPayloadBudget).
 */
export const MAX_TOTAL_PAYLOAD_CHARS = 400_000;

/** Same shape ci already validates for inbound X-Correlation-Id (request-context.ts). */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export type AttributeValue = string | number | boolean;

/** Wire format of one stage in POST /ingest/batch → `stages[]`. */
export interface SystemsStage {
  sequence: number;
  name: string;
  stage_type: string;
  status: string;
  provider?: string;
  model?: string;
  duration_ms?: number;
  started_offset_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  estimated_cost_usd?: number;
  retry_count?: number;
  error_type?: string;
  attributes?: Record<string, AttributeValue>;
}

export interface SystemsPayload {
  kind: 'input' | 'output' | 'stage_output' | 'narration' | 'reasoning';
  stage_sequence?: number;
  text: string;
}

export interface SystemsTrace {
  correlationId?: string;
  stages: SystemsStage[];
  payloads?: SystemsPayload[];
}

const CONTENT_CAPTURE_AFFIRMATIVE = new Set(['true', '1', 'yes', 'on']);

/**
 * Content capture is ON by default (unset or blank). It is a privacy control,
 * so the kill switch fails SAFE: any explicit value that is not clearly
 * affirmative — `false`, `0`, `off`, but also a typo such as `flase` —
 * disables capture instead of silently leaving it on.
 */
export function isContentCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SYSTEMS_TRACE_CONTENT;
  if (raw === undefined || raw.trim() === '') return true;
  return CONTENT_CAPTURE_AFFIRMATIVE.has(raw.trim().toLowerCase());
}

/**
 * Keep the request's content inside MAX_TOTAL_PAYLOAD_CHARS. The final output
 * is the highest-value payload, then the input, then the stages in order; the
 * payload that crosses the budget is truncated, the rest are dropped.
 */
export function applyPayloadBudget(
  payloads: SystemsPayload[],
  budget: number = MAX_TOTAL_PAYLOAD_CHARS
): SystemsPayload[] {
  const priority = (p: SystemsPayload): number =>
    p.kind === 'output' ? 0 : p.kind === 'input' ? 1 : 2;
  const ranked = payloads
    .map((payload, order) => ({ payload, order }))
    .sort((a, b) => priority(a.payload) - priority(b.payload) || a.order - b.order);
  let remaining = budget;
  const kept: Array<{ payload: SystemsPayload; order: number }> = [];
  for (const entry of ranked) {
    if (remaining <= 0) break;
    const text =
      entry.payload.text.length > remaining
        ? entry.payload.text.slice(0, remaining)
        : entry.payload.text;
    remaining -= text.length;
    kept.push({ payload: { ...entry.payload, text }, order: entry.order });
  }
  return kept.sort((a, b) => a.order - b.order).map((entry) => entry.payload);
}

export function safeCorrelationId(value: unknown): string | undefined {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value) ? value : undefined;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Drop undefined/empty values so the wire attributes stay minimal. */
function attrs(input: Record<string, unknown>): Record<string, AttributeValue> | undefined {
  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && value.length > 0) out[key] = value.slice(0, 200);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Reduce a free-text provider error to a short code. Provider error messages
 * can echo request content, so the message itself never leaves ci.
 */
export function classifyError(raw: unknown): string | undefined {
  const text = str(raw);
  if (!text) return undefined;
  const lower = text.toLowerCase();
  const http = /\b(?:http[ _-]?)?(4\d\d|5\d\d)\b/.exec(lower);
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('abort'))
    return 'timeout';
  if (lower.includes('rate limit') || lower.includes('rate_limit') || lower.includes('429'))
    return 'rate_limited';
  if (lower.includes('empty')) return 'empty_response';
  if (http) return `http_${http[1]}`;
  return 'execution_error';
}

function splitProvider(modelId: string): { provider?: string; model: string } {
  const colon = modelId.indexOf(':');
  return colon > 0
    ? { provider: modelId.slice(0, colon), model: modelId.slice(colon + 1) }
    : { model: modelId };
}

type StageType = 'participant' | 'synthesizer' | 'judge' | 'fallback';

function stageTypeForRole(role: unknown): StageType {
  const r = String(role ?? '').toLowerCase();
  if (r === 'synthesizer' || r === 'aggregator' || r === 'coordinator') return 'synthesizer';
  if (r === 'judge' || r === 'adjudicator' || r === 'arbitrator' || r === 'auditor') return 'judge';
  if (r === 'fallback' || r === 'fallback_single') return 'fallback';
  return 'participant';
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = rec(part);
        return p && typeof p.text === 'string' ? p.text : p?.type ? `[${String(p.type)}]` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function clip(text: string): string {
  return text.length > MAX_PAYLOAD_CHARS ? text.slice(0, MAX_PAYLOAD_CHARS) : text;
}

function renderInput(request: ChatRequest | undefined): string {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  return clip(
    messages
      .map(
        (m) =>
          `[${String((m as { role?: unknown }).role ?? 'unknown')}] ${messageText((m as { content?: unknown }).content)}`
      )
      .join('\n\n')
  );
}

function responseText(response: unknown): string {
  const choices = rec(response)?.choices;
  const first = Array.isArray(choices) ? rec(choices[0]) : undefined;
  return messageText(rec(first?.message)?.content);
}

interface Draft {
  stage: Omit<SystemsStage, 'sequence'>;
  /** Lower number = kept first when the stage cap forces a cut. */
  priority: number;
  payloads?: Array<Omit<SystemsPayload, 'stage_sequence'>>;
}

/** Match each consensus participant artifact to its execution, in order, by model id. */
function artifactMatcher(consensus: Rec | undefined): (modelId: string) => Rec | undefined {
  const outputs = Array.isArray(consensus?.participantOutputs)
    ? (consensus?.participantOutputs as unknown[])
    : [];
  const used = new Set<number>();
  return (modelId) => {
    for (let i = 0; i < outputs.length; i++) {
      const artifact = rec(outputs[i]);
      if (!used.has(i) && artifact?.modelId === modelId) {
        used.add(i);
        return artifact;
      }
    }
    return undefined;
  };
}

function participantDraft(
  exec: ModelExecution,
  artifact: Rec | undefined,
  capture: boolean
): Draft {
  const { provider: fromId, model } = splitProvider(exec.modelId);
  const verdict = str(artifact?.evaluatorVerdict);
  const usage = exec.response?.usage;
  const output = capture ? responseText(exec.response) : '';
  return {
    priority: 2,
    stage: {
      name: exec.modelName || model,
      stage_type: stageTypeForRole(exec.role),
      status: exec.success ? 'success' : 'error',
      provider: exec.provider ?? fromId,
      model,
      duration_ms: Math.max(0, Math.round(exec.durationMs ?? 0)),
      input_tokens: usage?.prompt_tokens,
      output_tokens: usage?.completion_tokens,
      estimated_cost_usd: num(exec.cost),
      error_type: exec.success ? undefined : classifyError(exec.error),
      attributes: attrs({
        role: String(exec.role ?? ''),
        verdict,
        score: num(artifact?.individualScore),
        outlier: artifact?.outlier === true ? true : undefined,
        error_code: exec.success ? undefined : classifyError(exec.error),
      }),
    },
    payloads: output ? [{ kind: 'stage_output', text: clip(output) }] : undefined,
  };
}

/**
 * Build the trace of one completed orchestration. Never throws: a malformed
 * result yields the stages that could be derived (possibly none).
 */
export function buildSystemsTrace(
  result: OrchestrationResult,
  request: ChatRequest | undefined,
  options: { correlationId?: string; captureContent?: boolean } = {}
): SystemsTrace {
  const capture = options.captureContent ?? isContentCaptureEnabled();
  const trace: SystemsTrace = {
    correlationId: safeCorrelationId(options.correlationId),
    stages: [],
  };
  try {
    const meta = rec(result.metadata) ?? {};
    const triage = rec(meta.triage);
    const consensus = rec(meta.consensusArtifacts);
    const quality = rec(meta.quality);
    const finalSelection = rec(consensus?.finalSelection);
    const fallbackChain = Array.isArray(meta.fallback_chain)
      ? (meta.fallback_chain as unknown[]).filter(str)
      : [];
    const drafts: Draft[] = [];

    if (triage) {
      drafts.push({
        priority: 0,
        stage: {
          name: 'Triage',
          stage_type: 'triage',
          status: 'success',
          estimated_cost_usd: num(triage.costUsd),
          attributes: attrs({
            intent: str(triage.intent),
            complexity: str(triage.complexity),
            priority: str(triage.priority),
            route: str(triage.route),
            confidence: num(triage.confidence),
            triage_source: str(triage.source),
          }),
        },
        // The triage rationale is text derived from the user's request: content plane only.
        payloads:
          capture && str(triage.reason)
            ? [{ kind: 'reasoning', text: clip(String(triage.reason)) }]
            : undefined,
      });
    }

    const resolved = str(meta.resolved_strategy) ?? str(result.strategyUsed);
    drafts.push({
      priority: 0,
      stage: {
        name: `Strategy: ${resolved ?? 'unknown'}`,
        stage_type: 'strategy_selection',
        status: 'success',
        attributes: attrs({
          selection_source: str(meta.decision_source),
          requested_strategy: str(meta.requested_strategy),
          resolved_strategy: resolved,
        }),
      },
    });

    const matchArtifact = artifactMatcher(consensus);
    const executions = Array.isArray(result.modelsUsed) ? result.modelsUsed : [];
    for (const exec of executions) {
      drafts.push(participantDraft(exec, matchArtifact(exec.modelId), capture));
    }

    if (quality) {
      drafts.push({
        priority: 1,
        stage: {
          name: 'Quality scoring',
          stage_type: 'quality',
          status: 'success',
          attributes: attrs({
            judge_method: str(quality.method),
            judge_score: num(quality.judgeScore),
            score: num(quality.score),
            confidence: num(quality.confidence),
          }),
        },
        payloads:
          capture && str(quality.reasoning)
            ? [{ kind: 'reasoning', text: clip(String(quality.reasoning)) }]
            : undefined,
      });
    }

    const outputText = capture ? responseText(result.finalResponse) : '';
    drafts.push({
      priority: 0,
      stage: {
        name: 'Final decision',
        stage_type: 'decider',
        status: 'success',
        duration_ms: 0,
        attributes: attrs({
          final_decider: str(meta.final_decider_model_id),
          final_source: str(finalSelection?.source),
          fallback_triggered: finalSelection?.fallbackTriggered === true ? true : undefined,
          fallback_from: fallbackChain.length > 1 ? String(fallbackChain[0]) : undefined,
          fallback_to:
            fallbackChain.length > 1 ? String(fallbackChain[fallbackChain.length - 1]) : undefined,
          degraded: meta.degraded === true ? true : undefined,
          participants_executed: executions.length,
        }),
      },
      payloads: outputText ? [{ kind: 'output', text: clip(outputText) }] : undefined,
    });

    const narrations = Array.isArray(meta.observer_narrations)
      ? (meta.observer_narrations as unknown[])
      : [];
    for (const raw of narrations) {
      const n = rec(raw);
      const event = str(n?.event);
      if (!n || !event) continue;
      const payloads: Array<Omit<SystemsPayload, 'stage_sequence'>> = [];
      if (capture && str(n.narration))
        payloads.push({ kind: 'narration', text: clip(String(n.narration)) });
      if (capture && str(n.reasoning))
        payloads.push({ kind: 'reasoning', text: clip(String(n.reasoning)) });
      drafts.push({
        priority: 3,
        stage: {
          name: `Observer: ${event}`,
          stage_type: 'narration',
          status: 'success',
          duration_ms: num(n.duration_ms),
          attributes: attrs({ event }),
        },
        payloads: payloads.length ? payloads : undefined,
      });
    }

    // Over the cap: keep the structural stages first, then trim the tail of the
    // lowest-priority group, preserving execution order for what remains.
    let kept = drafts.map((draft, order) => ({ draft, order }));
    if (kept.length > MAX_STAGES) {
      kept = [...kept]
        .sort((a, b) => a.draft.priority - b.draft.priority || a.order - b.order)
        .slice(0, MAX_STAGES)
        .sort((a, b) => a.order - b.order);
    }

    const payloads: SystemsPayload[] = [];
    if (capture) {
      const input = renderInput(request);
      if (input) payloads.push({ kind: 'input', text: input });
    }
    kept.forEach(({ draft }, sequence) => {
      trace.stages.push({ sequence, ...draft.stage });
      for (const p of draft.payloads ?? []) payloads.push({ ...p, stage_sequence: sequence });
    });
    // The request-level output is the highest-value payload: keep it under the cap.
    const outputIndex = payloads.findIndex((p) => p.kind === 'output');
    if (payloads.length > MAX_PAYLOADS && outputIndex >= 0) {
      const [output] = payloads.splice(outputIndex, 1);
      payloads.length = Math.min(payloads.length, MAX_PAYLOADS - 1);
      payloads.push(output);
    }
    if (payloads.length > 0) trace.payloads = applyPayloadBudget(payloads.slice(0, MAX_PAYLOADS));
  } catch {
    // Telemetry only: whatever was built stays; the request path is untouched.
  }
  return trace;
}

/** Trace for the fast single-model streaming path (no orchestration result exists). */
export function buildSingleStreamTrace(input: {
  correlationId?: string;
  provider: string;
  modelId: string;
  durationMs: number;
  fallbackAttempts: number;
  request?: ChatRequest;
  outputText?: string;
  captureContent?: boolean;
}): SystemsTrace {
  const capture = input.captureContent ?? isContentCaptureEnabled();
  const { provider: fromId, model } = splitProvider(input.modelId);
  const trace: SystemsTrace = {
    correlationId: safeCorrelationId(input.correlationId),
    stages: [
      {
        sequence: 0,
        name: model,
        stage_type: 'participant',
        status: 'success',
        provider: input.provider || fromId,
        model,
        duration_ms: Math.max(0, Math.round(input.durationMs)),
        retry_count: Math.max(0, input.fallbackAttempts),
        attributes: attrs({ role: 'primary', attempt: input.fallbackAttempts + 1 }),
      },
    ],
  };
  if (capture) {
    const payloads: SystemsPayload[] = [];
    const prompt = renderInput(input.request);
    if (prompt) payloads.push({ kind: 'input', text: prompt });
    if (input.outputText) payloads.push({ kind: 'output', text: clip(input.outputText) });
    if (payloads.length) trace.payloads = payloads;
  }
  return trace;
}
