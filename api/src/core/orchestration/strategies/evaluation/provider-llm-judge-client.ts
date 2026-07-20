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
 * Hard safety properties:
 *   - No prompt text is logged. Only the rubric version, judge model id,
 *     latency, and parsed numeric outputs.
 *   - No DB writes.
 *   - On timeout / parse failure, throws an Error — the evaluator
 *     wraps that into an "unavailable" result without crashing the
 *     consensus pipeline.
 *   - Temperature pinned to 0 for determinism. max_tokens capped at 600.
 */
import { logger } from '@/utils/logger';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ChatRequest, ChatResponse } from '@/types';
import type {
  LLMJudgeClient,
  LLMJudgeInput,
  LLMJudgeRawResult,
} from './llm-judge-evaluator.types';

const log = logger.child({ component: 'provider-llm-judge-client' });

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

    const raw = extractJsonContent(response);
    if (!raw) {
      log.warn(
        { judgeModelId: input.judgeModelId, rubricVersion: input.rubricVersion, latencyMs },
        'judge returned no parseable content',
      );
      throw new Error('judge_response_empty');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('judge_response_not_json');
    }

    const result = coerceRawResult(parsed);

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

    log.info(
      {
        judgeModelId: input.judgeModelId,
        rubricVersion: input.rubricVersion,
        latencyMs,
        verdict: result.verdict,
        score: result.score,
        confidence: result.confidence,
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

export function coerceRawResult(parsed: unknown): LLMJudgeRawResult {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('judge_response_not_object');
  }
  const o = parsed as Record<string, unknown>;
  const score = toNumber(o.score);
  if (score === undefined || score < 0 || score > 1) {
    throw new Error('judge_response_score_out_of_range');
  }
  const verdict = o.verdict;
  if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'uncertain') {
    throw new Error('judge_response_verdict_invalid');
  }
  const confidence = toNumber(o.confidence);
  const rationale = typeof o.rationale === 'string' ? o.rationale.slice(0, 200) : undefined;
  const subScoresRaw = o.subScores;
  let subScores: LLMJudgeRawResult['subScores'];
  if (typeof subScoresRaw === 'object' && subScoresRaw !== null) {
    const s = subScoresRaw as Record<string, unknown>;
    subScores = {
      correctness: toNumber(s.correctness),
      completeness: toNumber(s.completeness),
      instructionAdherence: toNumber(s.instructionAdherence),
      formatAdherence: toNumber(s.formatAdherence),
      grounding: toNumber(s.grounding),
      safety: toNumber(s.safety),
      reasoningQuality: toNumber(s.reasoningQuality),
    };
  }
  return {
    score,
    verdict,
    confidence: confidence !== undefined && confidence >= 0 && confidence <= 1 ? confidence : undefined,
    shortRationale: rationale,
    subScores,
  };
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
