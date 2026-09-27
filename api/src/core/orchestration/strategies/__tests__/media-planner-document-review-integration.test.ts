// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration: MediaPlannerStrategy → DocumentReviewStrategy → 3 real
 * DocumentJudgeEvaluator instances, over a REAL multi-page PDF built with
 * pdfkit and extracted by the REAL PDFService (real pdf-parse/pdfjs). Only
 * the judge CLIENTS are mocked (no real provider call, no real cost) — this
 * is the local-fixture integration test called for in the design spec's
 * Section C testing policy; the real-money batch (real critic-model calls)
 * is a separate, explicitly flagged step, never run automatically.
 */
import { describe, it, expect, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import type { ChatRequest, OrchestrationContext } from '@/types';
import type { CapabilityInvoker } from '@/core/orchestration/capability-invoker';
import type { CapabilityModeResult } from '@/routes/capabilities/capabilities-routes';

const engineExecute = vi.fn();
vi.mock('@/core/orchestration/orchestration-engine', () => ({
  getOrchestrationEngine: () => ({ execute: engineExecute }),
}));

const persistMediaPlanRunMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../media-planner-repository', () => ({
  persistMediaPlanRun: (...args: unknown[]) => persistMediaPlanRunMock(...args),
}));

const { MediaPlannerStrategy } = await import('../media-planner-strategy');
const { DocumentReviewStrategy } = await import('../document-review-strategy');
const { DocumentJudgeEvaluator } = await import('../evaluation/document-judge-evaluator');
const { PDFService } = await import('@/services/pdf-service');
import type { DocumentJudgeClient } from '../evaluation/document-judge-evaluator.types';

const USER_CONTEXT = { organizationId: 'org-test', userId: 'user-test' } as unknown as OrchestrationContext;

async function buildThreePagePdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Each page's text must clear PDFService's MIN_PAGE_TEXT_CHARS (96) so
    // every page takes the native-text path — never the vision-OCR
    // fallback, which would need a real (or separately mocked) vision
    // provider this test deliberately has none of. See
    // api/src/services/__tests__/pdf-service.test.ts's own LONG_TEXT_A/B
    // fixtures for the same constraint.
    doc.fontSize(14).text(
      'This master service agreement is effective January 1 and governs the relationship ' +
        'between the parties. The total contract value stated in this agreement is $100,000.',
      72,
      100
    );
    doc.addPage();
    doc.fontSize(14).text(
      'Payment schedule: the total contract value referenced above is actually $120,000, ' +
        'payable in four equal installments over the twelve month term of this agreement.',
      72,
      100
    );
    doc.addPage();
    doc.fontSize(14).text(
      'Both parties agree to be bound by the terms and conditions described above, and each ' +
        'representative signing below confirms authority to execute this agreement.',
      72,
      100
    );
    doc.end();
  });
}

function makeInvoker(chat: ReturnType<typeof vi.fn>): CapabilityInvoker {
  return {
    chat,
    transcribe: vi.fn().mockRejectedValue(new Error('not implemented')),
    synthesize: vi.fn().mockRejectedValue(new Error('not implemented')),
    translate: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateVideo: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateImage: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateFile: vi.fn().mockRejectedValue(new Error('not implemented')),
  };
}

function chatJson(value: unknown) {
  return {
    id: 'r',
    object: 'chat.completion' as const,
    created: 0,
    model: 'planner-model',
    choices: [
      { index: 0, message: { role: 'assistant' as const, content: JSON.stringify(value) }, finish_reason: 'stop' as const, logprobs: null },
    ],
  };
}

describe('MediaPlannerStrategy + DocumentReviewStrategy — real PDF, real extraction, mocked critics', () => {
  it('cites the REAL page number of a real inconsistency planted in the fixture', async () => {
    const pdfBuffer = await buildThreePagePdf();
    const pdfService = new PDFService();

    // The factual_accuracy critic "finds" the $100,000 vs $120,000
    // contradiction planted on page 2 above — mocked client, but the
    // page number it cites must survive real extraction untouched.
    const factualClient: DocumentJudgeClient = {
      judgeDocument: vi.fn().mockResolvedValue({
        score: 0.2,
        verdict: 'fail',
        issues: [{ location: 2, severity: 'critical', description: 'contract value contradicts page 1 ($100,000 vs $120,000)' }],
      }),
    };
    const silentClient: DocumentJudgeClient = {
      judgeDocument: vi.fn().mockResolvedValue({ score: 0.9, verdict: 'pass', issues: [] }),
    };

    const baseConfig = { enabled: true, judgeModelId: 'judge-model', maxCostUsd: 0.01, timeoutMs: 5000, rubricVersion: 'v1' };
    const documentReviewExecutor = new DocumentReviewStrategy({
      critics: [
        { role: 'factual_accuracy', evaluator: new DocumentJudgeEvaluator({ ...baseConfig, criticRole: 'factual_accuracy' }, factualClient) },
        { role: 'required_clause_presence', evaluator: new DocumentJudgeEvaluator({ ...baseConfig, criticRole: 'required_clause_presence' }, silentClient) },
        { role: 'tone', evaluator: new DocumentJudgeEvaluator({ ...baseConfig, criticRole: 'tone' }, silentClient) },
      ],
    });

    // Synthesis call (getOrchestrationEngine().execute) — echo the single
    // finding back verbatim, grouped by its real page.
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
                      {
                        severity: 'critical',
                        description: 'contract value contradicts page 1 ($100,000 vs $120,000)',
                        sourceCritics: ['factual_accuracy'],
                      },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      },
      totalCost: 0.001,
    });

    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'capability_call', capability: 'pdf_understanding', body: {} }))
      .mockResolvedValueOnce(chatJson({ kind: 'final', content: 'Found a contract value mismatch on page 2.', unmetConstraints: [] }));

    const context: OrchestrationContext = {
      organizationId: 'org-test',
      userId: 'user-test',
      requestId: 'req-integration',
      models: [],
      taskType: 'analysis',
      contextSize: 1000,
      invoker: makeInvoker(invokerChat),
    };

    const capabilityDispatcher = vi.fn().mockImplementation(async (plan) => {
      const analysis = await pdfService.analyzePDF({
        pdfBuffer,
        filename: 'contract.pdf',
        userContext: USER_CONTEXT,
        requestId: 'req-integration-pdf',
      });
      const result: CapabilityModeResult = {
        data: { text: analysis.text, metadata: analysis.metadata, extraction: analysis.extraction },
        executionPath: 'tool_pipeline',
      };
      expect(plan.id).toBe('pdf_understanding');
      return { result, fallbackUsed: false };
    });

    const strategy = new MediaPlannerStrategy({ capabilityDispatcher, documentReviewExecutor, maxTurns: 2 });
    const chatRequest: ChatRequest = { model: 'auto', messages: [{ role: 'user', content: 'review this contract' }] };
    const result = await strategy.execute(chatRequest, context);

    expect(factualClient.judgeDocument).toHaveBeenCalledTimes(1);
    const factualCall = (factualClient.judgeDocument as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // The REAL extracted text (not a fixture string) must contain both real
    // page markers before it ever reaches the critic.
    expect(factualCall.documentText).toContain('[page 1]');
    expect(factualCall.documentText).toContain('[page 2]');
    expect(factualCall.documentText).toContain('[page 3]');
    expect(factualCall.documentText).toContain('$100,000');
    expect(factualCall.documentText).toContain('$120,000');

    const plan = result.metadata.plan as Array<{ outcome: Record<string, unknown> }>;
    const reviewOutcome = plan[0].outcome;
    expect(reviewOutcome.type).toBe('document_review_result');
    expect(reviewOutcome.pageCount).toBe(3);
    expect(reviewOutcome.issueCount).toBe(1);
    expect(reviewOutcome.summary).toContain('Page 2:');
    expect(result.metadata.stopReason).toBe('final');
  });
});
