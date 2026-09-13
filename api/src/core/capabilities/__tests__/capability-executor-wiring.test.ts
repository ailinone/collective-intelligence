// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * capability-executor-wiring.test.ts — LOTE AP (2026-09-05)
 *
 * A capability's `executionPath` is a PROMISE about which executor will run
 * it. Before this batch several capabilities broke that promise in two
 * different ways, and neither had a guard:
 *
 *   - `vision`, `image_captioning`, `visual_question_answering` declared
 *     `native_adapter` first while `executeNativeAdapterMode` had no branch
 *     for any of them, so every request threw `No native adapter executor
 *     available`, logged a failed attempt, and silently fell through to chat.
 *     `image_upscale` / `image_denoise` inherited the same broken default
 *     from the `capability.includes('image')` heuristic.
 *   - `reranking`, `retrieval` and `pdf_understanding` declared plain
 *     `['orchestration']`, which is a chat model — an executor that cannot
 *     perform any of those three operations, but will happily return prose
 *     that looks like it did.
 *
 * This suite pins both halves: the declared path, and the deliberate ABSENCE
 * of a chat fallback where chat cannot honestly stand in.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCapabilityExecutionPlan } from '../capability-registry';
import type { ModelCapability } from '@/types';

const ROUTES_SOURCE = readFileSync(
  join(__dirname, '../../../routes/capabilities/capabilities-routes.ts'),
  'utf-8'
);

function plan(capability: string) {
  const found = getCapabilityExecutionPlan(capability);
  expect(found, `no execution plan for ${capability}`).toBeDefined();
  return found!;
}

describe('capability executor wiring — declared path matches a real executor', () => {
  describe('vision family', () => {
    const VISION_FAMILY: ModelCapability[] = [
      'vision',
      'image_captioning',
      'visual_question_answering',
    ];

    it.each(VISION_FAMILY)('%s declares native_adapter first', (capability) => {
      expect(plan(capability).executionPath[0]).toBe('native_adapter');
    });

    it('the native adapter executor has a branch that covers the whole family', () => {
      // The routing set is what turns the declaration into an executor.
      expect(ROUTES_SOURCE).toMatch(/const VISION_CAPABILITIES = new Set<ModelCapability>\(\[/);
      for (const capability of VISION_FAMILY) {
        expect(ROUTES_SOURCE).toContain(`'${capability}',`);
      }
      expect(ROUTES_SOURCE).toMatch(/if \(VISION_CAPABILITIES\.has\(capability\)\)/);
      expect(ROUTES_SOURCE).toMatch(/executeVisionCapability\(/);
    });

    it('keeps orchestration as a legitimate second choice', () => {
      // Unlike rerank/retrieval, a chat model with vision CAN answer these —
      // the orchestration fallback here is honest, not a papering-over.
      for (const capability of VISION_FAMILY) {
        expect(plan(capability).executionPath).toContain('orchestration');
      }
    });
  });

  describe('image enhancement', () => {
    const ENHANCEMENT: ModelCapability[] = ['image_upscale', 'image_denoise'];

    it.each(ENHANCEMENT)('%s declares native_adapter first', (capability) => {
      expect(plan(capability).executionPath[0]).toBe('native_adapter');
    });

    it('the native adapter executor routes enhancement to its own service method', () => {
      expect(ROUTES_SOURCE).toMatch(
        /const IMAGE_ENHANCEMENT_CAPABILITIES = new Set<ModelCapability>\(\['image_upscale', 'image_denoise'\]\)/
      );
      expect(ROUTES_SOURCE).toMatch(/if \(IMAGE_ENHANCEMENT_CAPABILITIES\.has\(capability\)\)/);
      expect(ROUTES_SOURCE).toMatch(/services\.image\.enhanceImage\(/);
    });
  });

  describe('reranking', () => {
    it('runs on the native adapter path', () => {
      expect(plan('reranking').executionPath).toEqual(['native_adapter']);
    });

    it('has NO chat-orchestration fallback', () => {
      // An LLM asked to score documents is a different, unordered, pricier
      // operation. Falling back to it would return a plausible non-answer.
      expect(plan('reranking').executionPath).not.toContain('orchestration');
    });

    it('resolves from its alias', () => {
      expect(plan('rerank').id).toBe('reranking');
    });

    it('the dispatcher has a reranking branch backed by the real service', () => {
      expect(ROUTES_SOURCE).toMatch(/if \(capability === 'reranking'\)/);
      expect(ROUTES_SOURCE).toMatch(/getRerankOrchestrationService\(\)\.rerank\(/);
    });
  });

  describe('retrieval', () => {
    it('runs on the tool pipeline, against a real vector store', () => {
      expect(plan('retrieval').executionPath).toEqual(['tool_pipeline']);
      expect(plan('retrieval').dependencies).toContain('vector_store_or_file_index');
      expect(plan('retrieval').dependencies).toContain('embedder');
    });

    it('has NO chat-orchestration fallback', () => {
      // A chat model with no corpus attached cannot retrieve anything.
      expect(plan('retrieval').executionPath).not.toContain('orchestration');
    });

    it('resolves from its RAG alias', () => {
      expect(plan('rag').id).toBe('retrieval');
    });

    it('the dispatcher has a retrieval branch backed by the real service', () => {
      expect(ROUTES_SOURCE).toMatch(/if \(capability === 'retrieval'\)/);
      expect(ROUTES_SOURCE).toMatch(/getRetrievalOrchestrationService\(\)\.retrieve\(/);
    });
  });

  describe('pdf_understanding', () => {
    it('runs the extraction pipeline before any chat fallback', () => {
      const executionPath = plan('pdf_understanding').executionPath;
      expect(executionPath[0]).toBe('tool_pipeline');
      // Chat stays available last: a provider that CAN ingest a document
      // natively still has a path once extraction has been tried.
      expect(executionPath).toContain('orchestration');
      expect(executionPath.indexOf('tool_pipeline')).toBeLessThan(
        executionPath.indexOf('orchestration')
      );
    });

    it('declares the extractor and the vision pipeline as dependencies', () => {
      const dependencies = plan('pdf_understanding').dependencies;
      expect(dependencies).toContain('pdf_text_extractor');
      expect(dependencies).toContain('vision_pipeline');
    });

    it('resolves from its OCR alias', () => {
      expect(plan('ocr').id).toBe('pdf_understanding');
      expect(plan('document_understanding').id).toBe('pdf_understanding');
    });

    it('the dispatcher hands PDFs to the PDF service, not to a chat message', () => {
      expect(ROUTES_SOURCE).toMatch(/if \(capability === 'pdf_understanding'\)/);
      expect(ROUTES_SOURCE).toMatch(/services\.pdf\.analyzePDF\(/);
    });
  });
});
