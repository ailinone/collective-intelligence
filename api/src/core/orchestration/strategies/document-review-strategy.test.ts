// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DocumentReviewStrategy — critic fan-out + synthesis tests.
 *
 * Critics are mocked `StrategyOutputEvaluator`s (no real client, no real
 * cost) — this file proves the fan-out/reconciliation SHAPE, not any real
 * judge behavior (that's document-judge-evaluator.test.ts /
 * provider-document-judge-client.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrchestrationContext } from '@/types';
import type { EvaluationResult, StrategyOutputEvaluator } from './evaluation/strategy-output-evaluator';

const engineExecute = vi.fn();
vi.mock('@/core/orchestration/orchestration-engine', () => ({
  getOrchestrationEngine: () => ({ execute: engineExecute }),
}));

const { DocumentReviewStrategy, groupIssuesDeterministically, parseSynthesisReport } = await import(
  './document-review-strategy'
);
import type { DocumentReviewRequest } from './document-review-strategy';

const USER_CONTEXT = { organizationId: 'org-test', userId: 'user-test' } as unknown as OrchestrationContext;

function makeEvaluator(result: EvaluationResult): StrategyOutputEvaluator {
  return { mode: result.scoringMode, id: `mock-${result.evaluatorId}`, evaluate: vi.fn().mockResolvedValue(result) };
}

function baseResult(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    scoringMode: 'llm_judge',
    evaluatorId: 'mock',
    score: 0.8,
    verdict: 'pass',
    structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
    validationStatus: 'fully_validated',
    issues: [],
    judgeCostUsd: 0.001,
    ...overrides,
  };
}

function baseRequest(overrides: Partial<DocumentReviewRequest> = {}): DocumentReviewRequest {
  return {
    documentText: '[page 1]\nSome text.\n\n[page 2]\nMore text.',
    pageCount: 2,
    filename: 'doc.pdf',
    userContext: USER_CONTEXT,
    requestId: 'req-1',
    ...overrides,
  };
}

describe('DocumentReviewStrategy — zero critics', () => {
  it('degrades explicitly instead of silently returning nothing', async () => {
    const strategy = new DocumentReviewStrategy({ critics: [] });
    const result = await strategy.execute(baseRequest());
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('no_document_critics_configured');
    expect(result.reportByPage).toEqual([]);
    expect(result.totalCostUsd).toBe(0);
    expect(engineExecute).not.toHaveBeenCalled();
  });
});

describe('DocumentReviewStrategy — no issues found', () => {
  it('skips the synthesis call entirely when every critic returns zero issues', async () => {
    const critics = [
      { role: 'factual_accuracy' as const, evaluator: makeEvaluator(baseResult()) },
      { role: 'required_clause_presence' as const, evaluator: makeEvaluator(baseResult()) },
      { role: 'tone' as const, evaluator: makeEvaluator(baseResult()) },
    ];
    const strategy = new DocumentReviewStrategy({ critics });
    const result = await strategy.execute(baseRequest());
    expect(result.totalIssueCount).toBe(0);
    expect(result.reportByPage).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(engineExecute).not.toHaveBeenCalled();
    expect(result.totalCostUsd).toBeCloseTo(0.003, 5);
    for (const c of critics) {
      expect(c.evaluator.evaluate).toHaveBeenCalledTimes(1);
      const calledWith = (c.evaluator.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledWith.output).toBe(baseRequest().documentText);
    }
  });
});

beforeEach(() => {
  engineExecute.mockReset();
});

describe('DocumentReviewStrategy — issues found, synthesis succeeds', () => {
  it('runs all 3 critics independently, then one synthesis call grouping issues by page', async () => {
    const critics = [
      {
        role: 'factual_accuracy' as const,
        evaluator: makeEvaluator(
          baseResult({ issues: [{ location: 2, severity: 'critical', description: 'total does not sum' }] })
        ),
      },
      {
        role: 'required_clause_presence' as const,
        evaluator: makeEvaluator(
          baseResult({ issues: [{ location: 2, severity: 'major', description: 'missing governing law clause' }] })
        ),
      },
      { role: 'tone' as const, evaluator: makeEvaluator(baseResult()) },
    ];
    engineExecute.mockResolvedValue({
      finalResponse: {
        model: 'synth-model',
        choices: [
          {
            message: {
              content: JSON.stringify({
                pages: [
                  {
                    page: 2,
                    issues: [
                      { severity: 'critical', description: 'total does not sum', sourceCritics: ['factual_accuracy'] },
                      {
                        severity: 'major',
                        description: 'missing governing law clause',
                        sourceCritics: ['required_clause_presence'],
                      },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      },
      totalCost: 0.002,
    });

    const strategy = new DocumentReviewStrategy({ critics });
    const result = await strategy.execute(baseRequest());

    expect(engineExecute).toHaveBeenCalledTimes(1);
    expect(result.reportByPage).toEqual([
      {
        page: 2,
        issues: [
          { severity: 'critical', description: 'total does not sum', sourceCritics: ['factual_accuracy'] },
          { severity: 'major', description: 'missing governing law clause', sourceCritics: ['required_clause_presence'] },
        ],
      },
    ]);
    expect(result.totalIssueCount).toBe(2);
    expect(result.reportText).toContain('Page 2:');
    expect(result.totalCostUsd).toBeCloseTo(0.002 + 0.001 + 0.001 + 0.001, 5);
  });
});

describe('DocumentReviewStrategy — synthesis returns unparseable JSON', () => {
  it('falls back to a deterministic page-grouping of the raw critic issues', async () => {
    const critics = [
      {
        role: 'factual_accuracy' as const,
        evaluator: makeEvaluator(baseResult({ issues: [{ location: 1, severity: 'minor', description: 'odd phrasing' }] })),
      },
    ];
    engineExecute.mockResolvedValue({
      finalResponse: { model: 'synth-model', choices: [{ message: { content: 'not json at all' } }] },
      totalCost: 0,
    });

    const strategy = new DocumentReviewStrategy({ critics });
    const result = await strategy.execute(baseRequest());

    expect(result.reportByPage).toEqual([
      { page: 1, issues: [{ severity: 'minor', description: 'odd phrasing', sourceCritics: ['factual_accuracy'] }] },
    ]);
  });
});

describe('DocumentReviewStrategy — synthesis call throws', () => {
  it('falls back to deterministic grouping instead of propagating the error', async () => {
    const critics = [
      {
        role: 'tone' as const,
        evaluator: makeEvaluator(baseResult({ issues: [{ location: 3, severity: 'minor', description: 'casual aside' }] })),
      },
    ];
    engineExecute.mockRejectedValue(new Error('synthesis model unavailable'));

    const strategy = new DocumentReviewStrategy({ critics });
    const result = await strategy.execute(baseRequest());

    expect(result.reportByPage).toEqual([
      { page: 3, issues: [{ severity: 'minor', description: 'casual aside', sourceCritics: ['tone'] }] },
    ]);
  });
});

describe('groupIssuesDeterministically', () => {
  it('groups by page ascending, preserving every issue', () => {
    const grouped = groupIssuesDeterministically([
      { role: 'tone', issue: { location: 3, severity: 'minor', description: 'a' } },
      { role: 'factual_accuracy', issue: { location: 1, severity: 'critical', description: 'b' } },
    ]);
    expect(grouped.map((p) => p.page)).toEqual([1, 3]);
  });
});

describe('parseSynthesisReport', () => {
  it('returns undefined for non-JSON text', () => {
    expect(parseSynthesisReport('no json here')).toBeUndefined();
  });

  it('drops a page entry with no valid issues', () => {
    const out = parseSynthesisReport(JSON.stringify({ pages: [{ page: 1, issues: [] }] }));
    expect(out).toEqual([]);
  });
});
