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
import { PDFService } from '@/services/pdf-service';
import { createOrchestrationContext } from '@/utils/orchestration-context';

const log = logger.child({ module: 'pdf-routes' });

export async function registerPDFRoutes(server: FastifyInstance): Promise<void> {
  const pdfService = new PDFService();

  // POST /v1/pdf/analyze
  server.post('/v1/pdf/analyze', {
    schema: {
      tags: ['PDF'],
      summary: 'Analyze PDF with AI',
      description: 'Uploads and analyzes PDF using models with PDF understanding (Claude, Gemini, etc.). Automatically selects the best model based on PDF complexity and analysis requirements.',
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
            description: 'Model ID or "auto" for intelligent selection. When "auto", Ailin selects the best model with PDF understanding capabilities.',
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
            answer: { type: 'string', nullable: true, description: 'Answer to prompt/question if provided' },
            metadata: {
              type: 'object',
              properties: {
                pageCount: { type: 'integer' },
                title: { type: 'string', nullable: true },
                author: { type: 'string', nullable: true },
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
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "missing_file", "invalid_file_format", "invalid_pdf")' },
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
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
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
                message: { type: 'string', description: 'Error message describing the server error' },
                type: { type: 'string', description: 'Error type (e.g., "server_error")' },
                code: { type: 'string', description: 'Error code (e.g., "internal_error")' },
              },
            },
          },
        },
      },
    },
    preHandler: authenticateRequest,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const userContext = createOrchestrationContext(request, {
        taskType: 'analysis',
        contextSize: 0,
      });
      
      try {
        // Handle multipart/form-data for PDF upload
        // Note: Requires @fastify/multipart plugin to be registered
        const multipartRequest = request as FastifyRequest & {
          file?: () => Promise<{ filename?: string; toBuffer: () => Promise<Buffer> } | undefined>;
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
        const body = request.body;
        const promptValue = body && typeof body === 'object' && 'prompt' in body && typeof (body as { prompt?: unknown }).prompt === 'string'
          ? (body as { prompt: string }).prompt
          : undefined;
        const modelValue = body && typeof body === 'object' && 'model' in body && typeof (body as { model?: unknown }).model === 'string'
          ? (body as { model: string }).model
          : undefined;

        const result = await pdfService.analyzePDF({
          pdfBuffer,
          filename,
          prompt: promptValue,
          model: modelValue,
          userContext,
          requestId: request.id,
        });

        return reply.send(result);
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
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

