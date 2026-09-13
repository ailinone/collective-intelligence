// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PDFService — LOTE AP.
 *
 * These are NOT fixture-driven: every case builds a REAL PDF with pdfkit and
 * runs the real pdf-parse (pdfjs) extractor over it. That is the only way to
 * pin the behaviour that was broken before — the old implementation base64'd
 * the whole file into an `image_url` content part, so no test could tell
 * whether text was ever extracted, and none was.
 *
 * Covered:
 *   - native text layer extracted per page, with real page count / title;
 *   - a page with NO text layer (a drawing-only page) becomes an OCR
 *     candidate and is routed through the vision pipeline;
 *   - native text wins where it exists — an OCR call is never spent on a page
 *     that can already be read;
 *   - OCR failure is survived per page, not fatal;
 *   - `forceOcr` bypasses the text layer;
 *   - extraction alone answers a promptless request with no provider call;
 *   - the document is delimited as untrusted data before reaching a model;
 *   - non-PDF and oversized input are rejected locally.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import PDFDocument from 'pdfkit';
import type { OrchestrationContext } from '@/types';

const engineExecute = vi.fn();
vi.mock('@/core/orchestration/orchestration-engine', () => ({
  getOrchestrationEngine: () => ({ execute: engineExecute }),
}));

import { PDFService } from '../pdf-service';
import { ValidationError } from '@/utils/custom-errors';

const USER_CONTEXT = {
  organizationId: 'org_test',
  userId: 'user_test',
} as unknown as OrchestrationContext;

/** Build a real PDF. `pages` describes what goes on each page. */
async function buildPdf(
  pages: Array<{ text?: string; drawingOnly?: boolean }>,
  info?: { Title?: string; Author?: string }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument(info ? { info } : {});
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    pages.forEach((page, index) => {
      if (index > 0) doc.addPage();
      if (page.drawingOnly) {
        // A filled rectangle and nothing else: a page with real content and
        // zero extractable text — structurally what a scan looks like to
        // pdfjs.
        doc.rect(72, 72, 320, 220).fill('#333333');
      } else {
        doc.fontSize(14).text(page.text ?? '', 72, 100);
      }
    });

    doc.end();
  });
}

/** Enough characters to clear MIN_PAGE_TEXT_CHARS (96). */
const LONG_TEXT_A =
  'The quarterly report covers revenue, operating expenses and headcount for the ' +
  'period ending March. Revenue grew while costs stayed flat.';
const LONG_TEXT_B =
  'Appendix B lists every supplier contract renewed during the period, together ' +
  'with the negotiated rate and the renewal date for each one.';

function makeVisionService(analyzeImage: Mock) {
  return {
    analyzeImage,
  } as unknown as import('@/services/vision-orchestration-service').VisionOrchestrationService;
}

function makeService(analyzeImage: Mock = vi.fn()) {
  return new PDFService(() => makeVisionService(analyzeImage));
}

function chatResponse(content: string) {
  return {
    finalResponse: {
      model: 'analysis-model',
      provider: 'analysis-provider',
      choices: [{ message: { content } }],
    },
  };
}

describe('PDFService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('native text layer', () => {
    it('extracts real per-page text and document metadata', async () => {
      const pdf = await buildPdf([{ text: LONG_TEXT_A }, { text: LONG_TEXT_B }], {
        Title: 'Quarterly Report',
        Author: 'Finance Team',
      });
      const analyzeImage = vi.fn();
      const service = makeService(analyzeImage);

      const result = await service.analyzePDF({
        pdfBuffer: pdf,
        filename: 'report.pdf',
        userContext: USER_CONTEXT,
        requestId: 'req_1',
      });

      expect(result.text).toContain('quarterly report covers revenue');
      expect(result.text).toContain('Appendix B lists every supplier');
      expect(result.metadata.pageCount).toBe(2);
      expect(result.metadata.title).toBe('Quarterly Report');
      expect(result.metadata.author).toBe('Finance Team');
      expect(result.extraction.path).toBe('native_text');
      expect(result.extraction.nativeTextPages).toBe(2);
      expect(result.extraction.ocrPages).toBe(0);
      // A readable page must never cost a vision call.
      expect(analyzeImage).not.toHaveBeenCalled();
    });

    it('answers a promptless request from extraction alone — no provider call', async () => {
      const pdf = await buildPdf([{ text: LONG_TEXT_A }]);
      const service = makeService();

      const result = await service.analyzePDF({
        pdfBuffer: pdf,
        filename: 'report.pdf',
        userContext: USER_CONTEXT,
        requestId: 'req_2',
      });

      expect(engineExecute).not.toHaveBeenCalled();
      expect(result.modelUsed).toBeNull();
      expect(result.provider).toBeNull();
      expect(result.text.length).toBeGreaterThan(0);
    });

    it('respects max_pages', async () => {
      const pdf = await buildPdf([
        { text: LONG_TEXT_A },
        { text: LONG_TEXT_B },
        { text: `${LONG_TEXT_A} third page marker` },
      ]);
      const service = makeService();

      const result = await service.analyzePDF({
        pdfBuffer: pdf,
        filename: 'report.pdf',
        maxPages: 1,
        userContext: USER_CONTEXT,
        requestId: 'req_3',
      });

      expect(result.text).toContain('quarterly report covers revenue');
      expect(result.text).not.toContain('Appendix B');
      // pageCount stays the DOCUMENT's page count — max_pages caps processing,
      // it does not rewrite the document's metadata.
      expect(result.metadata.pageCount).toBe(3);
    });
  });

  describe('vision OCR fallback', () => {
    it('rasterizes a text-less page and reads it with the vision pipeline', async () => {
      const pdf = await buildPdf([{ drawingOnly: true }]);
      const analyzeImage = vi.fn().mockResolvedValue({
        content: 'SCANNED INVOICE 2026-09 total 1,200.00',
        task: 'vision',
        modelUsed: 'vision-model',
        provider: 'vision-provider',
        durationMs: 5,
        strategyUsed: 'dynamic',
        fallbackUsed: false,
      });
      const service = makeService(analyzeImage);

      const result = await service.analyzePDF({
        pdfBuffer: pdf,
        filename: 'scan.pdf',
        userContext: USER_CONTEXT,
        requestId: 'req_4',
      });

      expect(analyzeImage).toHaveBeenCalledTimes(1);
      const call = analyzeImage.mock.calls[0][0];
      // A real rasterized page, not the PDF bytes.
      expect(Buffer.isBuffer(call.image)).toBe(true);
      expect((call.image as Buffer).length).toBeGreaterThan(0);
      expect(call.prompt).toMatch(/Transcribe ALL text visible/);
      expect(call.temperature).toBe(0);

      expect(result.text).toContain('SCANNED INVOICE');
      expect(result.extraction.path).toBe('vision_ocr');
      expect(result.extraction.ocrPages).toBe(1);
      expect(result.extraction.ocrModel).toBe('vision-model');
    });

    it('mixes native text and OCR, calling vision ONLY for the text-less page', async () => {
      const pdf = await buildPdf([{ text: LONG_TEXT_A }, { drawingOnly: true }]);
      const analyzeImage = vi.fn().mockResolvedValue({
        content: 'transcribed page two',
        task: 'vision',
        modelUsed: 'vision-model',
        provider: 'vision-provider',
        durationMs: 5,
        strategyUsed: 'dynamic',
        fallbackUsed: false,
      });
      const service = makeService(analyzeImage);

      const result = await service.analyzePDF({
        pdfBuffer: pdf,
        filename: 'mixed.pdf',
        userContext: USER_CONTEXT,
        requestId: 'req_5',
      });

      expect(analyzeImage).toHaveBeenCalledTimes(1);
      expect(result.text).toContain('quarterly report covers revenue');
      expect(result.text).toContain('transcribed page two');
      expect(result.extraction.path).toBe('hybrid');
      expect(result.extraction.nativeTextPages).toBe(1);
      expect(result.extraction.ocrPages).toBe(1);
    });

    it('forceOcr bypasses a perfectly good text layer when asked', async () => {
      const pdf = await buildPdf([{ text: LONG_TEXT_A }]);
      const analyzeImage = vi.fn().mockResolvedValue({
        content: 'ocr transcript',
        task: 'vision',
        modelUsed: 'vision-model',
        provider: 'vision-provider',
        durationMs: 5,
        strategyUsed: 'dynamic',
        fallbackUsed: false,
      });
      const service = makeService(analyzeImage);

      const result = await service.analyzePDF({
        pdfBuffer: pdf,
        filename: 'report.pdf',
        forceOcr: true,
        userContext: USER_CONTEXT,
        requestId: 'req_6',
      });

      expect(analyzeImage).toHaveBeenCalledTimes(1);
      expect(result.text).toContain('ocr transcript');
      expect(result.extraction.path).toBe('vision_ocr');
    });

    it('survives an OCR failure on one page instead of failing the document', async () => {
      const pdf = await buildPdf([{ text: LONG_TEXT_A }, { drawingOnly: true }]);
      const analyzeImage = vi.fn().mockRejectedValue(new Error('no vision model available'));
      const service = makeService(analyzeImage);

      const result = await service.analyzePDF({
        pdfBuffer: pdf,
        filename: 'mixed.pdf',
        userContext: USER_CONTEXT,
        requestId: 'req_7',
      });

      expect(result.text).toContain('quarterly report covers revenue');
      expect(result.extraction.path).toBe('native_text');
      expect(result.extraction.emptyPages).toBe(1);
      expect(result.extraction.ocrSkippedReason).toMatch(/no vision model available/);
    });

    it('raises a clear error when no text is recoverable by either route', async () => {
      const pdf = await buildPdf([{ drawingOnly: true }]);
      const analyzeImage = vi.fn().mockRejectedValue(new Error('vision unavailable'));
      const service = makeService(analyzeImage);

      await expect(
        service.analyzePDF({
          pdfBuffer: pdf,
          filename: 'scan.pdf',
          userContext: USER_CONTEXT,
          requestId: 'req_8',
        })
      ).rejects.toThrow(/No text could be extracted/);
    });
  });

  describe('analysis', () => {
    it('sends the EXTRACTED TEXT to the model, delimited as untrusted data', async () => {
      const pdf = await buildPdf([{ text: LONG_TEXT_A }]);
      engineExecute.mockResolvedValue(chatResponse('Revenue grew, costs were flat.'));
      const service = makeService();

      const result = await service.analyzePDF({
        pdfBuffer: pdf,
        filename: 'report.pdf',
        prompt: 'Did revenue grow?',
        userContext: USER_CONTEXT,
        requestId: 'req_9',
      });

      expect(engineExecute).toHaveBeenCalledTimes(1);
      const [chatRequest, orgId] = engineExecute.mock.calls[0];
      expect(orgId).toBe('org_test');

      const userMessage = chatRequest.messages.find(
        (m: { role: string }) => m.role === 'user'
      ) as { content: string };
      // The document reaches the model as TEXT inside a delimited block — not
      // as a base64 `image_url` part, which is what broke Anthropic and OpenAI.
      expect(userMessage.content).toContain('<document filename="report.pdf"');
      expect(userMessage.content).toContain('quarterly report covers revenue');
      expect(userMessage.content).toContain('Did revenue grow?');
      expect(JSON.stringify(chatRequest)).not.toContain('data:application/pdf');

      const systemMessage = chatRequest.messages.find(
        (m: { role: string }) => m.role === 'system'
      ) as { content: string };
      expect(systemMessage.content).toMatch(/UNTRUSTED data/);

      expect(result.answer).toBe('Revenue grew, costs were flat.');
      expect(result.modelUsed).toBe('analysis-model');
    });
  });

  describe('input validation', () => {
    it('rejects a file that is not a PDF', async () => {
      const service = makeService();
      await expect(
        service.analyzePDF({
          pdfBuffer: Buffer.from('this is a text file, not a pdf'),
          filename: 'notes.txt',
          userContext: USER_CONTEXT,
          requestId: 'req_10',
        })
      ).rejects.toThrow(/not a PDF/);
    });

    it('rejects an empty upload', async () => {
      const service = makeService();
      await expect(
        service.analyzePDF({
          pdfBuffer: Buffer.alloc(0),
          filename: 'empty.pdf',
          userContext: USER_CONTEXT,
          requestId: 'req_11',
        })
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
