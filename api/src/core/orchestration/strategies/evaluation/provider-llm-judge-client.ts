// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderLLMJudgeClient
 *
 * Concrete `LLMJudgeClient` that runs the rubric prompt through one of
 * the project's existing provider adapters. Single responsibility: turn
 * an `LLMJudgeInput` into a parsed `LLMJudgeRawResult` (or throw / signal
 * malformed). It does NOT decide whether to call the judge — that gate
 * lives in `LLMJudgeEvaluator` (enabled, budget, model id, client
 * present). This class assumes all gates have already passed when its
 * `judge()` method is invoked.
 *
 * Parsing contract:
 *   - The raw judge output is routed through the SHARED `normalizeJudgeOutput`
 *     (`@/core/quality/judge-schema`) used by the consensus / experiment /
 *     arbitration judges, so this path gets the same tolerant salvage that
 *     recovers ~half of production judge scores strict parsing would drop
 *     (0-100 rescale, `overallScore`/`overall` aliases, `confidence` as a
 *     string, regex salvage of JSON truncated mid-`reasoning`). The rubric's
 *     richer fields (`verdict`, `rationale`, `subScores`) that the shared
 *     schema does not model are extracted leniently on top. A malformed judge
 *     STILL throws (only when NO score is salvageable) so the evaluator wraps
 *     it into an "unavailable" result without crashing the consensus pipeline.
 *   - Every outcome (parsed / salvaged / each failure class) emits an
 *     operability judge metric — counter by verdict+parseClass, latency +
 *     score histograms — so this path is no longer a silent second contract.
 *
 * Hard safety properties:
 *   - No prompt text is logged. Only the rubric version, judge model id,
 *     latency, and parsed numeric outputs.
 *   - No DB writes.
 *   - Temperature pinned to 0 for determinism. max_tokens capped at 600.
 */
import { logger } from '@/utils/logger';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ChatRequest, ChatResponse } from '@/types';
import { normalizeJudgeOutput } from '@/core/quality/judge-schema';
import {
  METRIC_NAMES,
  incrementCounter,
  observeHistogram,
} from '@/core/operability/metrics';
import type {
  LLMJudgeClient,
  LLMJudgeInput,
  LLMJudgeRawResult,
} from './llm-judge-evaluator.types';

const log = logger.child({ component: 'provider-llm-judge-client' });

/** `where` tag threaded into the shared judge normalizer for metric attribution. */
const JUDGE_NORMALIZE_WHERE = 'provider-llm-judge-client';

/**
 * How the raw judge output was turned into a verdict — recorded on the judge
 * metric so operators can see the drift/salvage profile of this path:
 *   - `ok`            — content parsed as clean JSON and normalized.
 *   - `salvaged`      — JSON was truncated/malformed; the shared normalizer's
 *                       regex salvage recovered the score (the prod failure
 *                       where a slow judge got cut mid-`reasoning`).
 *   - `empty`         — the provider returned no parseable content.
 *   - `unrecoverable` — content present but not even a score could be salvaged.
 *   - `provider_error`— the provider call itself threw.
 *   - `model_not_found` — the judge model id did not resolve in the registry.
 */
type JudgeParseClass =
  | 'ok'
  | 'salvaged'
  | 'empty'
  | 'unrecoverable'
  | 'provider_error'
  | 'model_not_found';

const RUBRIC_PREFIX =
  'You are an impartial code/output judge. Score the candidate output on a strict rubric. ' +
  'Return ONLY a single JSON object with these fields, no markdown, no commentary:\n' +
  '  score: number in [0, 1] — overall quality\n' +
  '  verdict: "pass" | "fail" | "uncertain"\n' +
  '  confidence: number in [0, 1]\n' +
  '  rationale: short string (under 200 chars)\n' +
  '  subScores: { correctness, completeness, instructionAdherence, formatAdherence, grounding, safety, reasoningQuality } — each in [0, 1]\n' +
  'A "pass" requires that the candidate actually addresses the user request correctly. A "fail" means the candidate is wrong, off-topic, unsafe, or empty. ' +
  'Use "uncertain" only when you genuinely cannot tell without executing the code.';

export interface ProviderLLMJudgeClientOptions {
  readonly registry: ProviderRegistry;
  /** Pinned temperature for judge calls. Default 0. */
  readonly temperature?: number;
  /** Max tokens for the JSON response. Default 600. */
  readonly maxTokens?: number;
}

export class ProviderLLMJudgeClient implements LLMJudgeClient {
  constructor(private readonly opts: ProviderLLMJudgeClientOptions) {}

  async judge(input: LLMJudgeInput): Promise<LLMJudgeRawResult> {
    const resolved = await this.opts.registry.findModel(input.judgeModelId);
    if (!resolved) {
      recordJudgeMetric({ parseClass: 'model_not_found', verdict: 'none' });
      throw new Error(`judge_model_not_found:${input.judgeModelId}`);
    }

    const userBlock = buildUserBlock(input);
    const judgeRequest: ChatRequest = {
      model: resolved.model.id,
      messages: [
        { role: 'system', content: `${RUBRIC_PREFIX}\nrubric_version=${input.rubricVersion}` },
        { role: 'user', content: userBlock },
      ],
      temperature: this.opts.temperature ?? 0,
      max_tokens: this.opts.maxTokens ?? 600,
      stream: false,
    };

    const t0 = Date.now();
    let response: ChatResponse;
    try {
      response = await resolved.adapter.chatCompletion(judgeRequest);
    } catch (err) {
      recordJudgeMetric({ parseClass: 'provider_error', verdict: 'none', latencyMs: Date.now() - t0 });
      log.warn(
        {
          judgeModelId: input.judgeModelId,
          rubricVersion: input.rubricVersion,
          latencyMs: Date.now() - t0,
          error: errorMessage(err),
        },
        'judge provider call failed',
      );
      throw err;
    }
    const latencyMs = Date.now() - t0;

    const rawContent = extractJsonContent(response);
    if (!rawContent) {
      recordJudgeMetric({ parseClass: 'empty', verdict: 'none', latencyMs });
      log.warn(
        { judgeModelId: input.judgeModelId, rubricVersion: input.rubricVersion, latencyMs },
        'judge returned no parseable content',
      );
      throw new Error('judge_response_empty');
    }

    // Route the judge output through the SHARED tolerant normalizer. Pass the
    // parsed object when the JSON is clean; otherwise pass the raw string so
    // `normalizeJudgeOutput`'s regex salvage can recover a truncated/malformed
    // response instead of us hard-failing on `JSON.parse` (the old contract
    // threw `judge_response_not_json` here and dropped a recoverable score).
    const cleanObject = tryParseObject(rawContent);
    let result: LLMJudgeRawResult;
    try {
      result = coerceRawResult(cleanObject ?? rawContent);
    } catch (err) {
      recordJudgeMetric({ parseClass: 'unrecoverable', verdict: 'none', latencyMs });
      log.warn(
        { judgeModelId: input.judgeModelId, rubricVersion: input.rubricVersion, latencyMs },
        'judge output unrecoverable after tolerant salvage',
      );
      throw err;
    }
    const parseClass: JudgeParseClass = cleanObject ? 'ok' : 'salvaged';

    // Cost-accounting integrity (TIER 0): the judge call is billable. Compute
    // its cost via the same mechanism the strategies use
    // (adapter.calculateCost). Missing usage ⇒ 0 (never throw). Attaching it
    // here stops the cost being discarded by `coerceRawResult` (which only sees
    // the parsed JSON, not the response usage).
    let costUsd = 0;
    try {
      const usage = response.usage;
      costUsd = Math.max(0, resolved.adapter.calculateCost(
        resolved.model,
        usage?.prompt_tokens || 0,
        usage?.completion_tokens || 0,
      )) || 0;
    } catch {
      costUsd = 0;
    }
    const resultWithCost: LLMJudgeRawResult = { ...result, costUsd };

    recordJudgeMetric({
      parseClass,
      verdict: result.verdict,
      latencyMs,
      score: result.score,
    });
    log.info(
      {
        judgeModelId: input.judgeModelId,
        rubricVersion: input.rubricVersion,
        latencyMs,
        verdict: result.verdict,
        score: result.score,
        confidence: result.confidence,
        parseClass,
        costUsd,
      },
      'judge completed',
    );
    return resultWithCost;
  }
}

// ─── pure helpers (exported for tests) ──────────────────────────────────

function buildUserBlock(input: LLMJudgeInput): string {
  const taskHeader = [
    input.task.taskType ? `task_type=${input.task.taskType}` : '',
    input.task.expectedFormat ? `expected_format=${input.task.expectedFormat}` : '',
    input.role ? `role=${input.role}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const excerpt = input.task.userMessageExcerpt ?? '';
  return [
    taskHeader,
    excerpt ? `user_request_excerpt:\n${excerpt}` : '',
    'candidate_output:',
    input.output,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function extractJsonContent(response: ChatResponse): string | null {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) return null;
  // The judge model may wrap the JSON in markdown fences. Strip them.
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Or it may emit pure JSON with leading prose. Try the first { ... }.
  const braceStart = content.indexOf('{');
  const braceEnd = content.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    return content.slice(braceStart, braceEnd + 1).trim();
  }
  return content.trim();
}

/**
 * Turn a raw judge payload (parsed object OR raw string) into an
 * `LLMJudgeRawResult`, TOLERANTLY.
 *
 * The numeric `score` (and `confidence`) come from the SHARED
 * `normalizeJudgeOutput` so this path inherits the same salvage the rest of
 * the system uses (0-100 rescale, `overallScore`/`overall` aliases, `confidence`
 * as a string, and — when a raw string is passed — regex salvage of JSON
 * truncated mid-`reasoning`). The rubric's `verdict`, `rationale`, and
 * `subScores`, which the shared `JudgeVerdict` schema does not model, are
 * extracted leniently on top:
 *   - `verdict`: preserved verbatim when the judge emits a valid
 *     `pass`/`fail`/`uncertain`; otherwise `uncertain` — the honest default per
 *     `EvaluationVerdict` semantics ("ran but lacks objective evidence to
 *     commit"). We do NOT fabricate a pass/fail from a score threshold.
 *   - `subScores` / `rationale`: best-effort; absent on salvaged/truncated input.
 *
 * Throws ONLY when not even a score can be recovered, preserving the
 * throw-on-malformed contract the evaluator relies on to emit `unavailable`.
 */
export function coerceRawResult(parsed: unknown): LLMJudgeRawResult {
  const normalized = normalizeJudgeOutput(parsed, { where: JUDGE_NORMALIZE_WHERE });
  if (!normalized) {
    throw new Error('judge_response_unparseable');
  }

  const obj = asObject(parsed);
  const explicitVerdict = obj ? extractVerdict(obj) : undefined;
  if (!explicitVerdict) {
    log.debug(
      { score: normalized.score },
      'judge verdict missing/invalid — defaulting to uncertain',
    );
  }

  const rationale = (obj ? extractRationale(obj) : undefined) ?? normalized.summary;

  return {
    score: normalized.score,
    verdict: explicitVerdict ?? 'uncertain',
    confidence: normalized.confidence,
    shortRationale: rationale,
    subScores: obj ? extractSubScores(obj) : undefined,
  };
}

// ─── tolerant field extraction (rubric fields not modelled by JudgeVerdict) ──

/** Coerce a parsed object or a JSON string into a plain object, else undefined. */
function asObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') return tryParseObject(raw);
  return undefined;
}

/**
 * Parse a JSON string to a plain object, tolerating leading/trailing prose by
 * slicing to the outermost braces. Returns undefined on any failure (e.g. the
 * JSON was truncated) — NEVER throws.
 */
function tryParseObject(raw: string): Record<string, unknown> | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const slice = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  try {
    const v: unknown = JSON.parse(slice);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function extractVerdict(o: Record<string, unknown>): LLMJudgeRawResult['verdict'] | undefined {
  const v = o.verdict;
  return v === 'pass' || v === 'fail' || v === 'uncertain' ? v : undefined;
}

function extractRationale(o: Record<string, unknown>): string | undefined {
  const r = o.rationale ?? o.shortRationale;
  return typeof r === 'string' && r.length > 0 ? r.slice(0, 200) : undefined;
}

function extractSubScores(o: Record<string, unknown>): LLMJudgeRawResult['subScores'] {
  const s = o.subScores;
  if (typeof s !== 'object' || s === null) return undefined;
  const r = s as Record<string, unknown>;
  return {
    correctness: toNumber(r.correctness),
    completeness: toNumber(r.completeness),
    instructionAdherence: toNumber(r.instructionAdherence),
    formatAdherence: toNumber(r.formatAdherence),
    grounding: toNumber(r.grounding),
    safety: toNumber(r.safety),
    reasoningQuality: toNumber(r.reasoningQuality),
  };
}

// ─── judge metric emission ──────────────────────────────────────────────────

/**
 * Emit the operability judge metric. Never throws — metrics must not break the
 * judge path. `verdict='none'` marks a call that produced no verdict (a failure
 * class). Latency/score are omitted when not yet known (e.g. model_not_found).
 */
function recordJudgeMetric(opts: {
  parseClass: JudgeParseClass;
  verdict: LLMJudgeRawResult['verdict'] | 'none';
  latencyMs?: number;
  score?: number;
}): void {
  try {
    incrementCounter(METRIC_NAMES.LLM_JUDGE_RESULT_TOTAL, {
      verdict: opts.verdict,
      parseClass: opts.parseClass,
    });
    if (opts.latencyMs !== undefined) {
      observeHistogram(METRIC_NAMES.LLM_JUDGE_LATENCY_MS, opts.latencyMs, {
        verdict: opts.verdict,
      });
    }
    if (opts.score !== undefined) {
      observeHistogram(METRIC_NAMES.LLM_JUDGE_SCORE, opts.score, { verdict: opts.verdict });
    }
  } catch {
    // Observability is best-effort; a metrics backend hiccup must not fail a judge call.
  }
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
