// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DocumentReviewStrategy — the document/PDF sibling of `MediaConsensusStrategy`
 * (media-consensus-strategy.ts), for the MediaPlanner completion design's
 * Section C ("Document/PDF generalization").
 *
 * Reuses the SAME independent-critic-evaluation SHAPE `MediaConsensusStrategy`
 * established (role-differentiated critics run independently — asymmetric
 * visibility, no live debate — then reconciled after the fact), applied to
 * extracted PDF text instead of video/image frames:
 *   - Three text-only critics (`factual_accuracy`, `required_clause_presence`,
 *     `tone`) each judge the SAME assembled document text independently via
 *     `DocumentJudgeEvaluator`, returning page-anchored `issues`
 *     (`EvaluationResult.issues`, see `evaluation/strategy-output-evaluator.ts`).
 *   - UNLIKE `reconcileCriticResults` (a pure weighted-average function —
 *     right for a single numeric quality score), grouping free-text issues
 *     by page and de-duplicating overlapping citations across three critics
 *     is not a numeric reduction. `synthesize()` is therefore a real
 *     SYNTHESIS LLM CALL (one call, not a critic — it never scores anything,
 *     it only reorganizes what the critics already found), reusing the same
 *     `getOrchestrationEngine().execute()` path `PDFService.analyzeText`
 *     already uses, not a new judge-client abstraction.
 *   - When synthesis is skipped (no issues) or its JSON is unparseable, a
 *     deterministic fallback groups the critics' raw issues by page in
 *     code — the report is NEVER empty or crashed just because one LLM call
 *     returned malformed JSON.
 *
 * Zero critics configured (the safe default until real critics are wired,
 * mirroring `MediaConsensusStrategy`'s `critics: []` production default) is
 * a supported, explicit degrade — never a crash, never a fabricated report.
 */
import { getOrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import type { ChatRequest, OrchestrationContext } from '@/types';
import { logger } from '@/utils/logger';
import type {
  DocumentCriticIssue,
  EvaluationResult,
  StrategyOutputEvaluator,
} from './evaluation/strategy-output-evaluator';
import type { DocumentCriticRole } from './evaluation/document-judge-evaluator.types';

const log = logger.child({ component: 'document-review-strategy' });

export interface DocumentCriticConfig {
  readonly role: DocumentCriticRole;
  readonly evaluator: StrategyOutputEvaluator;
}

export interface DocumentReviewRequest {
  readonly documentText: string;
  readonly pageCount: number;
  readonly filename: string;
  readonly userMessageExcerpt?: string;
  readonly userContext: OrchestrationContext;
  readonly requestId: string;
}

export interface DocumentReviewPageIssue {
  readonly severity: 'critical' | 'major' | 'minor';
  readonly description: string;
  readonly sourceCritics: readonly DocumentCriticRole[];
}

export interface DocumentReviewReportPage {
  readonly page: number;
  readonly issues: readonly DocumentReviewPageIssue[];
}

export interface DocumentReviewResult {
  readonly criticResults: ReadonlyArray<{ readonly role: DocumentCriticRole; readonly result: EvaluationResult }>;
  readonly reportByPage: readonly DocumentReviewReportPage[];
  readonly totalIssueCount: number;
  /** Plain-text rendering of `reportByPage`, ALWAYS well-formed even when
   *  synthesis fails — this is what feeds the planner's transcript. */
  readonly reportText: string;
  /** Critic judge calls + the one synthesis call, combined. */
  readonly totalCostUsd: number;
  readonly totalDurationMs: number;
  readonly degraded: boolean;
  readonly degradedReason?: string;
}

/** Structural mirror of what the planner needs — see `media-planner-types.ts`. */
export interface DocumentReviewExecutor {
  execute(request: DocumentReviewRequest): Promise<DocumentReviewResult>;
}

export class DocumentReviewStrategy implements DocumentReviewExecutor {
  private readonly critics: readonly DocumentCriticConfig[];
  private readonly synthesisModelId: string | undefined;

  constructor(
    deps: { readonly critics?: readonly DocumentCriticConfig[]; readonly synthesisModelId?: string } = {}
  ) {
    this.critics = deps.critics ?? [];
    this.synthesisModelId = deps.synthesisModelId;
  }

  async execute(request: DocumentReviewRequest): Promise<DocumentReviewResult> {
    const startTime = Date.now();

    if (this.critics.length === 0) {
      return {
        criticResults: [],
        reportByPage: [],
        totalIssueCount: 0,
        reportText: 'Document critics not configured — extraction only, no review performed.',
        totalCostUsd: 0,
        totalDurationMs: Date.now() - startTime,
        degraded: true,
        degradedReason: 'no_document_critics_configured',
      };
    }

    const evalTask = { userMessageExcerpt: request.userMessageExcerpt ?? request.documentText.slice(0, 200) };

    const criticResults = await Promise.all(
      this.critics.map(async (critic) => ({
        role: critic.role,
        result: await critic.evaluator.evaluate({
          task: evalTask,
          output: request.documentText,
          strategyName: 'document-review',
          role: 'voter' as const,
        }),
      }))
    );

    const criticCostUsd = criticResults.reduce((sum, c) => sum + (c.result.judgeCostUsd ?? 0), 0);

    const flatIssues: Array<{ role: DocumentCriticRole; issue: DocumentCriticIssue }> = [];
    for (const { role, result } of criticResults) {
      for (const issue of result.issues ?? []) {
        flatIssues.push({ role, issue });
      }
    }

    if (flatIssues.length === 0) {
      return {
        criticResults,
        reportByPage: [],
        totalIssueCount: 0,
        reportText: 'No issues found by any critic.',
        totalCostUsd: criticCostUsd,
        totalDurationMs: Date.now() - startTime,
        degraded: false,
      };
    }

    const synthesis = await this.synthesize(flatIssues, request);

    return {
      criticResults,
      reportByPage: synthesis.reportByPage,
      totalIssueCount: flatIssues.length,
      reportText: renderReportText(synthesis.reportByPage),
      totalCostUsd: criticCostUsd + synthesis.costUsd,
      totalDurationMs: Date.now() - startTime,
      degraded: false,
    };
  }

  /**
   * ONE synthesis LLM call (not a critic) that groups/de-duplicates the
   * critics' raw issues by page. Reuses `getOrchestrationEngine().execute()`
   * exactly like `PDFService.analyzeText` — plain chat dispatch, no
   * judge-client abstraction, because this step never scores anything.
   *
   * Implemented fully in Task 5 — this task leaves it unreachable (every
   * test here has `flatIssues.length === 0`), so a stub that throws if ever
   * called is intentional and will be replaced in the next task.
   */
  private async synthesize(
    flatIssues: ReadonlyArray<{ role: DocumentCriticRole; issue: DocumentCriticIssue }>,
    request: DocumentReviewRequest
  ): Promise<{ reportByPage: readonly DocumentReviewReportPage[]; costUsd: number }> {
    const engine = getOrchestrationEngine();
    if (!engine) {
      log.warn(
        { requestId: request.requestId },
        'orchestration engine unavailable — using deterministic fallback grouping'
      );
      return { reportByPage: groupIssuesDeterministically(flatIssues), costUsd: 0 };
    }

    const issuesJson = JSON.stringify(
      flatIssues.map(({ role, issue }) => ({
        sourceCritic: role,
        page: issue.location,
        severity: issue.severity,
        description: issue.description,
      }))
    );

    const chatRequest: ChatRequest = {
      model: this.synthesisModelId && this.synthesisModelId !== 'auto' ? this.synthesisModelId : 'auto',
      messages: [
        {
          role: 'system',
          content:
            'You reconcile independent document-review findings into one report. You do NOT judge or ' +
            'score anything new — only group and de-duplicate what is given. Return ONLY a single JSON ' +
            'object: { "pages": [ { "page": number, "issues": [ { "severity": "critical"|"major"|"minor", ' +
            '"description": string, "sourceCritics": string[] } ] } ] }, sorted by page ascending. Merge ' +
            'issues that describe the same underlying problem on the same page into one entry, listing ' +
            'every critic that raised it in "sourceCritics". Never invent an issue not present in the input.',
        },
        {
          role: 'user',
          content: `filename="${request.filename}" pages=${request.pageCount}\n\nfindings:\n${issuesJson}`,
        },
      ],
      temperature: 0,
      max_tokens: 2000,
    };

    try {
      const response = await engine.execute(chatRequest, request.userContext.organizationId, request.userContext.userId);
      const content = response.finalResponse.choices[0]?.message?.content;
      const text = typeof content === 'string' ? content : '';
      const parsed = parseSynthesisReport(text);
      if (!parsed) {
        log.warn(
          { requestId: request.requestId },
          'synthesis returned unparseable JSON — using deterministic fallback grouping'
        );
        return { reportByPage: groupIssuesDeterministically(flatIssues), costUsd: response.totalCost ?? 0 };
      }
      return { reportByPage: parsed, costUsd: response.totalCost ?? 0 };
    } catch (err) {
      log.warn(
        { requestId: request.requestId, error: err instanceof Error ? err.message : String(err) },
        'synthesis call failed — using deterministic fallback grouping'
      );
      return { reportByPage: groupIssuesDeterministically(flatIssues), costUsd: 0 };
    }
  }
}

// ─── pure helpers (exported for tests) ─────────────────────────────────

/** Deterministic, LLM-free grouping — the fallback when synthesis is
 *  skipped or its output can't be trusted. Never drops an issue. */
export function groupIssuesDeterministically(
  flatIssues: ReadonlyArray<{ role: DocumentCriticRole; issue: DocumentCriticIssue }>
): DocumentReviewReportPage[] {
  const byPage = new Map<number, DocumentReviewPageIssue[]>();
  for (const { role, issue } of flatIssues) {
    const list = byPage.get(issue.location) ?? [];
    list.push({ severity: issue.severity, description: issue.description, sourceCritics: [role] });
    byPage.set(issue.location, list);
  }
  return Array.from(byPage.entries())
    .sort(([a], [b]) => a - b)
    .map(([page, issues]) => ({ page, issues }));
}

/** Tolerantly parses the synthesis model's JSON report. Returns `undefined`
 *  (never throws) on anything unparseable — the caller falls back to
 *  `groupIssuesDeterministically`. */
export function parseSynthesisReport(text: string): DocumentReviewReportPage[] | undefined {
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart < 0 || braceEnd <= braceStart) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(braceStart, braceEnd + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { pages?: unknown }).pages)) {
    return undefined;
  }
  const pages = (parsed as { pages: unknown[] }).pages;
  const out: DocumentReviewReportPage[] = [];
  for (const p of pages) {
    if (typeof p !== 'object' || p === null) continue;
    const rec = p as Record<string, unknown>;
    const page = typeof rec.page === 'number' && Number.isFinite(rec.page) ? Math.round(rec.page) : undefined;
    if (page === undefined || !Array.isArray(rec.issues)) continue;
    const issues: DocumentReviewPageIssue[] = [];
    for (const i of rec.issues) {
      if (typeof i !== 'object' || i === null) continue;
      const irec = i as Record<string, unknown>;
      const description = typeof irec.description === 'string' ? irec.description.trim() : '';
      if (!description) continue;
      const severity =
        irec.severity === 'critical' || irec.severity === 'major' || irec.severity === 'minor'
          ? irec.severity
          : 'minor';
      const sourceCritics = Array.isArray(irec.sourceCritics)
        ? irec.sourceCritics.filter(
            (c): c is DocumentCriticRole => c === 'factual_accuracy' || c === 'required_clause_presence' || c === 'tone'
          )
        : [];
      issues.push({ severity, description, sourceCritics });
    }
    if (issues.length > 0) out.push({ page, issues });
  }
  return out.sort((a, b) => a.page - b.page);
}

function renderReportText(reportByPage: readonly DocumentReviewReportPage[]): string {
  if (reportByPage.length === 0) return 'No issues found by any critic.';
  return reportByPage
    .map((p) => {
      const issuesText = p.issues
        .map((i) => `[${i.severity}] ${i.description} (flagged by: ${i.sourceCritics.join(', ') || 'unknown'})`)
        .join('; ');
      return `Page ${p.page}: ${issuesText}`;
    })
    .join('\n');
}
