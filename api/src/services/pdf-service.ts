// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PDF Service
 * Manages PDF processing via models with PDF understanding
 * 
 * REAL IMPLEMENTATION - Uses models with PDF capability (Gemini, Claude)
 */

import { logger } from '@/utils/logger';
import { ModelRepository } from '@/services/model-repository';
import { getOrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import type { OrchestrationContext } from '@/types';
import type { ChatRequest } from '@/types';

const log = logger.child({ service: 'pdf' });

export interface PDFAnalysisOptions {
  pdfBuffer: Buffer;
  filename: string;
  prompt?: string;
  model?: string; // undefined = auto-select
  userContext: OrchestrationContext;
  requestId: string;
}

export interface PDFAnalysisResult {
  text: string;
  summary?: string;
  extractedData?: Record<string, unknown>;
  modelUsed: string;
  provider: string;
  durationMs: number;
}

export class PDFService {
  private modelRepo: ModelRepository;

  constructor() {
    this.modelRepo = new ModelRepository();
  }

  async analyzePDF(options: PDFAnalysisOptions): Promise<PDFAnalysisResult> {
    const { pdfBuffer, filename, prompt, model, userContext, requestId } = options;
    const startTime = Date.now();

    log.info({ requestId, filename, pdfSize: pdfBuffer.length, hasPrompt: !!prompt }, 'PDF analysis started');

    try {
      // Step 1: Convert PDF to base64 for model input
      const pdfBase64 = pdfBuffer.toString('base64');
      const dataUrl = `data:application/pdf;base64,${pdfBase64}`;

      // Step 2: Select model with PDF capability
      const models = await this.modelRepo.searchModels({
        capabilities: ['pdf_understanding', 'multimodal'],
        status: 'active',
      });

      // Filter by model ID if specified
      const filteredModels = model
        ? models.filter((m) => m.id === model || m.name === model)
        : models;

      if (filteredModels.length === 0) {
        throw new Error('No models with PDF understanding capability available. Ensure at least one provider with PDF support (Gemini, Claude) is configured.');
      }

      // Step 3: Candidate chain. Every other modality (audio/images/video/
      // moderations) retries across ranked candidates; PDF used to pin
      // filteredModels[0] with NO fallback — one degraded provider meant the
      // whole endpoint failed (and, when that provider was merely slow, the
      // request stalled with no alternative). An EXPLICIT model request stays
      // pinned (no silent substitution); auto-select tries up to
      // PDF_MAX_CANDIDATES in catalog order.
      const maxCandidates = model ? 1 : Number(process.env.PDF_MAX_CANDIDATES) || 3;
      const candidates = filteredModels.slice(0, maxCandidates);

      const analysisPrompt = prompt || `Analyze this PDF file (${filename}). Extract all text content and provide a summary.`;

      const orchestrationEngine = getOrchestrationEngine();
      if (!orchestrationEngine) {
        throw new Error('OrchestrationEngine not initialized');
      }

      let lastError: unknown = null;
      for (const selectedModel of candidates) {
        log.info({ requestId, modelId: selectedModel.id, provider: selectedModel.provider }, 'Selected model for PDF analysis');

        const chatRequest: ChatRequest = {
          model: selectedModel.id,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: analysisPrompt,
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: dataUrl,
                  },
                },
              ],
            },
          ],
          temperature: 0.3,
          max_tokens: 4000,
        };

        try {
          const response = await orchestrationEngine.execute(
            chatRequest,
            userContext.organizationId,
            userContext.userId
          );

          const durationMs = Date.now() - startTime;

          const content = response.finalResponse.choices[0]?.message?.content;
          const text = typeof content === 'string'
            ? content
            : (Array.isArray(content)
              ? content.map((c) => {
                  if (typeof c === 'string') return c;
                  if (c && typeof c === 'object' && 'text' in c) return (c as { text: string }).text;
                  return '';
                }).join(' ')
              : '');

          // Try to extract structured data if response contains JSON
          let extractedData: Record<string, unknown> | undefined;
          try {
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              extractedData = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
            }
          } catch {
            // Not JSON, ignore
          }

          log.info({ requestId, durationMs, textLength: text.length, modelId: selectedModel.id }, 'PDF analysis completed');

          return {
            text,
            summary: extractedData?.summary as string | undefined,
            extractedData,
            modelUsed: selectedModel.id,
            provider: selectedModel.provider,
            durationMs,
          };
        } catch (candidateError: unknown) {
          lastError = candidateError;
          const errorMessage = candidateError instanceof Error ? candidateError.message : String(candidateError);
          log.warn(
            { requestId, modelId: selectedModel.id, provider: selectedModel.provider, error: errorMessage },
            'PDF analysis candidate failed — trying next'
          );
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error(`All PDF analysis candidates failed (${candidates.length} tried)`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, error: errorMessage }, 'PDF analysis failed');
      throw error;
    }
  }
}

