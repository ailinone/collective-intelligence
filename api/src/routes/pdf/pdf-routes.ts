// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PDF Processing Routes
 * Claude/Gemini-compatible PDF understanding
 *
 * Features:
 * - PDF upload and parsing
 * - Multi-model orchestration (Claude, Gemini with PDF support)
 * - Text extraction, Q&A, summarization
 *
 * NO HARDCODED - Dynamic model selection based on PDF capabilities
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { rejectAnonymousGuestKeyPreHandler } from '@/services/anonymous-quota-gate';
import { rejectChatFreeTierKeyPreHandler } from '@/services/free-tier-quota-gate';
import { PDFService } from '@/services/pdf-service';
import { createOrchestrationContext } from '@/utils/orchestration-context';

const log = logger.child({ module: 'pdf-routes' });

/**
 * Read a text field off a `@fastify/multipart` file part.
 *
 * In stream mode the non-file parts that arrived BEFORE the file are attached
 * to it as `fields`, each a `{ value }` wrapper (or an array of them when the
 * field repeats). Nothing here assumes the field exists — a caller sending
 * only the file is the normal case.
 */
function readMultipartField(
  fields: Record<string, unknown> | undefined,
  name: string
): string | undefined {
  const raw = fields?.[name];
  if (raw === undefined || raw === null) return undefined;

  const entry: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  if (entry && typeof entry === 'object' && 'value' in entry) {
    const value = (entry as { value?: unknown }).value;
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return undefined;
  }

  return typeof entry === 'string' && entry.trim().length > 0 ? entry.trim() : undefined;
}

export async function registerPDFRoutes(server: FastifyInstance): Promise<void> {
  const pdfService = new PDFService();

  // POST /v1/pdf/analyze
  server.post('/v1/pdf/analyze', {
    // Skip body schema validation for multipart/form-data endpoints.
    // Fastify's JSON schema validator runs BEFORE the multipart parser and rejects
    // raw form-data bytes as invalid JSON objects. Validation is done in the handler.
    validatorCompiler: () => () => true,
    schema: {
      tags: ['PDF'],
      summary: 'Analyze PDF with AI',
      description:
        'Uploads and analyzes PDF using models with PDF understanding (Claude, Gemini, etc.). Automatically selects the best model based on PDF complexity and analysis requirements.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      consumes: ['multipart/form-data'],
      body: {
        type: 'object',
        required: ['file'],
        properties: {
          file: {
            type: 'string',
            format: 'binary',
            description: 'PDF file to analyze',
          },
          prompt: {
            type: 'string',
            description: 'Optional prompt/question about the PDF content',
          },
          model: {
            type: 'string',
            default: 'auto',
            description:
              'Model ID or "auto" for intelligent selection. When "auto", Ailin selects the best model with PDF understanding capabilities.',
          },
          max_pages: {
            type: 'integer',
            minimum: 1,
            description: 'Cap the number of pages processed. Omit to process the whole document.',
          },
          force_ocr: {
            type: 'boolean',
            default: false,
            description:
              'Rasterize every page and read it with a vision model, ignoring the native text layer. ' +
              'Only useful for documents whose embedded text is known to be wrong.',
          },
        },
      },
      response: {
        200: {
          description: 'PDF analyzed successfully',
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Extracted text from PDF' },
            summary: { type: 'string', nullable: true, description: 'AI-generated summary' },
            answer: {
              type: 'string',
              nullable: true,
              description: 'Answer to prompt/question if provided',
            },
            metadata: {
              type: 'object',
              properties: {
                pageCount: { type: 'integer' },
                title: { type: 'string', nullable: true },
                author: { type: 'string', nullable: true },
              },
            },
            extraction: {
              type: 'object',
              description:
                'How the document text was obtained: `native_text` (embedded text layer), ' +
                '`vision_ocr` (pages rasterized and read by a vision model), or `hybrid`.',
              additionalProperties: true,
              properties: {
                path: { type: 'string' },
                nativeTextPages: { type: 'integer' },
                ocrPages: { type: 'integer' },
                emptyPages: { type: 'integer' },
                truncated: { type: 'boolean' },
              },
            },
            _ailin: {
              type: 'object',
              properties: {
                model_used: { type: 'string' },
                provider_used: { type: 'string' },
                duration_ms: { type: 'number' },
              },
            },
          },
        },
        400: {
          description: 'Bad request (invalid file or missing file)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'Error message describing the validation failure',
                },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: {
                  type: 'string',
                  description:
                    'Error code (e.g., "missing_file", "invalid_file_format", "invalid_pdf")',
                },
              },
            },
          },
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., PDF processing service unavailable)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'Error message indicating the requested resource was not found',
                },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'Error message describing the server error',
                },
                type: { type: 'string', description: 'Error type (e.g., "server_error")' },
                code: { type: 'string', description: 'Error code (e.g., "internal_error")' },
              },
            },
          },
        },
      },
    },
    preHandler: [
      authenticateRequest,
      rejectAnonymousGuestKeyPreHandler,
      rejectChatFreeTierKeyPreHandler,
    ],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const userContext = createOrchestrationContext(request, {
        taskType: 'analysis',
        contextSize: 0,
      });

      try {
        // Handle multipart/form-data for PDF upload
        // Note: Requires @fastify/multipart plugin to be registered
        const multipartRequest = request as FastifyRequest & {
          file?: () => Promise<
            | {
                filename?: string;
                toBuffer: () => Promise<Buffer>;
                fields?: Record<string, unknown>;
              }
            | undefined
          >;
        };
        const data = multipartRequest.file ? await multipartRequest.file() : undefined;

        if (!data) {
          return reply.code(400).send({
            error: {
              message: 'PDF file is required. Ensure @fastify/multipart plugin is registered.',
              type: 'invalid_request_error',
            },
          });
        }

        const pdfBuffer = await data.toBuffer();
        const filename = data.filename || 'document.pdf';

        // `@fastify/multipart` is registered in STREAM mode (no
        // `attachFieldsToBody`), so `request.body` is `undefined` on this
        // route and the previous body-based extraction meant the documented
        // `prompt` and `model` form fields were silently unreachable — every
        // request ran the default summarization prompt with auto model
        // selection no matter what the caller sent. The fields live on the
        // file part's `fields` map instead.
        const promptValue = readMultipartField(data.fields, 'prompt');
        const modelRaw = readMultipartField(data.fields, 'model');
        const modelValue = modelRaw && modelRaw !== 'auto' ? modelRaw : undefined;
        const maxPagesRaw = readMultipartField(data.fields, 'max_pages');
        const maxPages = maxPagesRaw !== undefined ? Number(maxPagesRaw) : undefined;
        const forceOcr = readMultipartField(data.fields, 'force_ocr') === 'true';

        const result = await pdfService.analyzePDF({
          pdfBuffer,
          filename,
          ...(promptValue ? { prompt: promptValue } : {}),
          ...(modelValue ? { model: modelValue } : {}),
          ...(maxPages !== undefined && Number.isFinite(maxPages) ? { maxPages } : {}),
          ...(forceOcr ? { forceOcr: true } : {}),
          userContext,
          requestId: request.id,
        });

        // Response shaped to the route's declared 200 schema. The previous
        // handler returned the raw service result, whose keys (`modelUsed`,
        // `provider`, `durationMs`) did not match the documented envelope at
        // all — the OpenAPI contract and the wire disagreed.
        return reply.send({
          text: result.text,
          summary: result.summary ?? null,
          answer: result.answer ?? null,
          metadata: {
            pageCount: result.metadata.pageCount,
            title: result.metadata.title ?? null,
            author: result.metadata.author ?? null,
          },
          extraction: result.extraction,
          _ailin: {
            model_used: result.modelUsed,
            provider_used: result.provider,
            duration_ms: result.durationMs,
          },
        });
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } =
          await import('@/utils/type-guards');

        const errorMessage = getErrorMessage(error);
        const statusCode = extractStatusCode(error) ?? 500;
        const errorType = extractErrorType(error) ?? 'internal_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'internal_error';
        log.error({ error: errorMessage, requestId: request.id }, 'PDF analysis failed');
        return reply.code(statusCode).send({
          error: {
            message: errorMessage,
            type: errorType,
            code: errorCode,
          },
        });
      }
    },
  });

  log.info('PDF API routes registered successfully');
}
