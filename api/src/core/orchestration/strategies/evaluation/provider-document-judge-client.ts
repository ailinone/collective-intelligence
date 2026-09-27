// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderDocumentJudgeClient
 *
 * Concrete `DocumentJudgeClient` that runs a text-only rubric prompt (no
 * image/frame parts — this is the document/PDF critic, always text) through
 * one of the project's existing provider adapters. Same single
 * responsibility as `ProviderMediaJudgeClient`/`ProviderLLMJudgeClient`: it
 * does NOT decide whether to call the judge — that gate lives in
 * `DocumentJudgeEvaluator` (enabled, budget, model id, client present).
 *
 * Parsing contract: reuses `coerceRawResult`/`extractJsonContent`/`asObject`
 * from `./provider-llm-judge-client` for the score/verdict/confidence/
 * subScores fields, and separately, tolerantly extracts `issues` on top —
 * dropping any malformed entry rather than fabricating a page number or
 * description for it.
 *
 * Hard safety properties (same as the other provider judge clients):
 *   - No prompt text is logged. Only rubric version, critic role, judge
 *     model id, latency, and parsed numeric outputs.
 *   - No DB writes.
 *   - Temperature pinned to 0 for determinism.
 */
import { logger } from '@/utils/logger';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ChatRequest, ChatResponse } from '@/types';
import type { DocumentCriticIssue, DocumentIssueSeverity } from './strategy-output-evaluator';
import { asObject, coerceRawResult, extractJsonContent } from './provider-llm-judge-client';
import type {
  DocumentCriticRole,
  DocumentJudgeClient,
  DocumentJudgeInput,
  DocumentJudgeRawResult,
} from './document-judge-evaluator.types';

const log = logger.child({ component: 'provider-document-judge-client' });

const RUBRIC_HEADER =
  'You are an impartial document-review judge. Score the candidate document (its full text, with ' +
  '"[page N]" markers) on a strict rubric. Return ONLY a single JSON object with these fields, no ' +
  'markdown, no commentary:\n' +
  '  score: number in [0, 1] — overall document quality on THIS critic axis\n' +
  '  verdict: "pass" | "fail" | "uncertain"\n' +
  '  confidence: number in [0, 1]\n' +
  '  rationale: short string (under 200 chars)\n' +
  '  issues: array of { location: number, severity: "critical"|"major"|"minor", description: string } — ' +
  'one entry per problem found on THIS critic axis. location is the page number from the "[page N]" ' +
  'marker nearest the problem (for an issue about something MISSING, cite the page where it should ' +
  'have appeared, e.g. the last page). Return an empty array when nothing is wrong.\n' +
  '  subScores: { correctness, completeness, instructionAdherence, formatAdherence, grounding, safety, reasoningQuality } — each in [0, 1]\n' +
  'Use "uncertain" only when the document genuinely does not let you tell.';

/** Per-critic rubric focus, appended to the shared header. Asymmetric
 *  visibility: each critic only ever sees this one framing, never the
 *  other critics' verdicts. */
const CRITIC_RUBRIC_FOCUS: Record<DocumentCriticRole, string> = {
  factual_accuracy:
    'Focus axis: FACTUAL ACCURACY. Flag claims, numbers, or dates that are internally inconsistent ' +
    '(e.g. a total that does not sum, a date that contradicts another date in the document) or that ' +
    'contradict well-established facts. Ignore tone and missing boilerplate clauses.',
  required_clause_presence:
    'Focus axis: REQUIRED CLAUSE PRESENCE. Flag standard clauses a document of this kind should ' +
    'contain but does not (e.g. termination, governing law, confidentiality, indemnification, a ' +
    'signature block for a contract-like document). Ignore factual correctness and tone.',
  tone:
    'Focus axis: TONE. Flag passages whose tone/register is inconsistent with the rest of the ' +
    'document or inappropriate for its apparent purpose (e.g. a formal contract that suddenly reads ' +
    'casually). Ignore factual correctness and missing clauses.',
};

export interface ProviderDocumentJudgeClientOptions {
  readonly registry: ProviderRegistry;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export class ProviderDocumentJudgeClient implements DocumentJudgeClient {
  constructor(private readonly opts: ProviderDocumentJudgeClientOptions) {}

  async judgeDocument(input: DocumentJudgeInput): Promise<DocumentJudgeRawResult> {
    const resolved = await this.opts.registry.findModel(input.judgeModelId);
    if (!resolved) {
      throw new Error(`document_judge_model_not_found:${input.judgeModelId}`);
    }

    const systemPrompt =
      `${RUBRIC_HEADER}\n${CRITIC_RUBRIC_FOCUS[input.criticRole]}\nrubric_version=${input.rubricVersion}`;
    const userContent = [
      input.task.taskType ? `task_type=${input.task.taskType}` : '',
      input.task.userMessageExcerpt ? `user_request_excerpt:\n${input.task.userMessageExcerpt}` : '',
      'document_text:',
      input.documentText,
    ]
      .filter(Boolean)
      .join('\n\n');

    const judgeRequest: ChatRequest = {
      model: resolved.model.id,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: this.opts.temperature ?? 0,
      max_tokens: this.opts.maxTokens ?? 900,
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
          criticRole: input.criticRole,
          latencyMs: Date.now() - t0,
          error: errorMessage(err),
        },
        'document judge provider call failed'
      );
      throw err;
    }
    const latencyMs = Date.now() - t0;

    const rawContent = extractJsonContent(response);
    if (!rawContent) {
      log.warn(
        {
          judgeModelId: input.judgeModelId,
          rubricVersion: input.rubricVersion,
          criticRole: input.criticRole,
          latencyMs,
        },
        'document judge returned no parseable content'
      );
      throw new Error('document_judge_response_empty');
    }

    const result = coerceDocumentRawResult(rawContent);

    let costUsd = 0;
    try {
      const usage = response.usage;
      costUsd =
        Math.max(
          0,
          resolved.adapter.calculateCost(
            resolved.model,
            usage?.prompt_tokens || 0,
            usage?.completion_tokens || 0
          )
        ) || 0;
    } catch {
      costUsd = 0;
    }
    const resultWithCost: DocumentJudgeRawResult = { ...result, costUsd };

    log.info(
      {
        judgeModelId: input.judgeModelId,
        rubricVersion: input.rubricVersion,
        criticRole: input.criticRole,
        latencyMs,
        verdict: result.verdict,
        score: result.score,
        issueCount: result.issues.length,
        costUsd,
      },
      'document judge completed'
    );
    return resultWithCost;
  }
}

// ─── pure helpers (exported for tests) ──────────────────────────────────

/**
 * Turn a raw judge payload (parsed object OR raw string) into a
 * `DocumentJudgeRawResult`. Reuses `coerceRawResult` for the
 * score/verdict/confidence/subScores fields it already tolerantly extracts,
 * and separately extracts `issues` — dropping any malformed entry rather
 * than fabricating a page number or description for it. Throws only when
 * `coerceRawResult` throws (no score salvageable at all).
 */
export function coerceDocumentRawResult(parsed: unknown): DocumentJudgeRawResult {
  const base = coerceRawResult(parsed);
  const obj = asObject(parsed);
  const issues = obj ? extractIssues(obj) : [];
  return { ...base, issues };
}

function extractIssues(o: Record<string, unknown>): DocumentCriticIssue[] {
  const raw = o.issues;
  if (!Array.isArray(raw)) return [];
  const out: DocumentCriticIssue[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const location = toPositiveInt(rec.location ?? rec.page);
    const description = typeof rec.description === 'string' ? rec.description.trim() : '';
    if (location === undefined || description.length === 0) continue;
    const severity: DocumentIssueSeverity =
      rec.severity === 'critical' || rec.severity === 'major' || rec.severity === 'minor'
        ? rec.severity
        : 'minor';
    out.push({ location, severity, description });
  }
  return out;
}

function toPositiveInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
