// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Batch API Routes
 * OpenAI/Claude/Gemini-compatible batch processing endpoints
 * 
 * Features:
 * - Async batch processing of chat/embedding/moderation requests
 * - JSONL input/output format
 * - Job status tracking
 * - Results download
 * - Cost optimization (50% discount for batch requests)
 * 
 * NO HARDCODED - All model selection via batch job definitions
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { BatchService } from '@/services/batch-service';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { createOrchestrationContext } from '@/utils/orchestration-context';

const log = logger.child({ module: 'batches-routes' });

// ============================================
// Request Schemas (OpenAI-compatible)
// ============================================

const BatchCreateSchema = z.object({
  input_file_id: z.string(),
  endpoint: z.enum(['/v1/chat/completions', '/v1/embeddings', '/v1/moderations']),
  completion_window: z.enum(['24h']).default('24h'),
  metadata: z.record(z.string()).optional(),
});

// ============================================
// Types
// ============================================

interface BatchCreateRequest {
  input_file_id: string;
  endpoint: string;
  completion_window: string;
  metadata?: Record<string, string>;
}

// ============================================
// Register Routes
// ============================================

export async function registerBatchesRoutes(server: FastifyInstance): Promise<void> {
  const batchService = new BatchService();

  // ==========================================
  // POST /v1/batches
  // ==========================================
  server.post('/v1/batches', {
    schema: {
      tags: ['Batches'],
      summary: 'Create batch job',
      description: 'Creates a batch processing job from a .jsonl file. The batch will be processed asynchronously within the specified completion window (typically 24 hours). Cost is typically 50% less than synchronous requests.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['input_file_id', 'endpoint', 'completion_window'],
        properties: {
          input_file_id: { 
            type: 'string',
            description: 'ID of uploaded .jsonl file containing batch requests',
          },
          endpoint: { 
            type: 'string', 
            enum: ['/v1/chat/completions', '/v1/embeddings', '/v1/moderations'],
            description: 'API endpoint to process requests against',
          },
          completion_window: { 
            type: 'string', 
            enum: ['24h'],
            default: '24h',
            description: 'Time window for batch completion',
          },
          metadata: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Optional metadata to attach to the batch',
          },
        },
      },
      response: {
        200: {
          description: 'Batch created successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Batch ID' },
            object: { type: 'string', enum: ['batch'], description: 'Object type' },
            endpoint: { type: 'string', enum: ['/v1/chat/completions', '/v1/embeddings', '/v1/moderations'], description: 'API endpoint for batch processing' },
            errors: { type: 'object', nullable: true, description: 'Errors object (null initially)' },
            input_file_id: { type: 'string', description: 'ID of input file' },
            completion_window: { type: 'string', enum: ['24h'], description: 'Completion window' },
            status: { type: 'string', enum: ['validating', 'in_progress', 'finalizing', 'completed', 'expired', 'failed', 'cancelled', 'cancelling'], description: 'Batch status' },
            output_file_id: { type: 'string', nullable: true, description: 'ID of output file (when completed)' },
            error_file_id: { type: 'string', nullable: true, description: 'ID of error file (if errors occurred)' },
            created_at: { type: 'integer', description: 'Unix timestamp of batch creation' },
            in_progress_at: { type: 'integer', nullable: true, description: 'Unix timestamp when batch started processing' },
            expires_at: { type: 'integer', nullable: true, description: 'Unix timestamp when batch expires' },
            finalizing_at: { type: 'integer', nullable: true, description: 'Unix timestamp when batch started finalizing' },
            completed_at: { type: 'integer', nullable: true, description: 'Unix timestamp when batch completed' },
            failed_at: { type: 'integer', nullable: true, description: 'Unix timestamp when batch failed' },
            expired_at: { type: 'integer', nullable: true, description: 'Unix timestamp when batch expired' },
            cancelling_at: { type: 'integer', nullable: true, description: 'Unix timestamp when batch cancellation started' },
            cancelled_at: { type: 'integer', nullable: true, description: 'Unix timestamp when batch was cancelled' },
            request_counts: {
              type: 'object',
              nullable: true,
              description: 'Request count statistics (null if not yet calculated)',
              properties: {
                total: { type: 'integer', description: 'Total number of requests in the batch' },
                completed: { type: 'integer', description: 'Number of successfully completed requests' },
                failed: { type: 'integer', description: 'Number of failed requests' },
              },
            },
            metadata: { type: 'object', nullable: true, additionalProperties: { type: 'string' }, description: 'Optional metadata' },
          },
        },
        400: {
          description: 'Bad request (invalid input file or endpoint)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_parameter", "invalid_file_format")' },
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
          description: 'Resource not found (e.g., input file ID not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the referenced resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "file_not_found")' },
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
    handler: async (request: FastifyRequest<{ Body: BatchCreateRequest }>, reply: FastifyReply) => {
      const requestId = request.id;
      const extendedRequest = request as ExtendedFastifyRequest;
      const userContext = extendedRequest.userContext || createOrchestrationContext(request);

      log.info({ requestId, input_file_id: request.body.input_file_id, endpoint: request.body.endpoint }, 'Batch create request received');

      try {
        const validated = BatchCreateSchema.parse(request.body);

        const result = await batchService.createBatch({
          inputFileId: validated.input_file_id,
          endpoint: validated.endpoint,
          completionWindow: validated.completion_window,
          metadata: validated.metadata,
          userContext,
          requestId,
        });

        return reply.send({
          id: result.id,
          object: 'batch',
          endpoint: result.endpoint,
          errors: null,
          input_file_id: result.input_file_id,
          completion_window: result.completion_window,
          status: result.status,
          output_file_id: result.output_file_id,
          error_file_id: result.error_file_id,
          created_at: result.created_at,
          in_progress_at: result.in_progress_at,
          expires_at: result.expires_at,
          finalizing_at: result.finalizing_at,
          completed_at: result.completed_at,
          failed_at: result.failed_at,
          expired_at: result.expired_at,
          cancelling_at: result.cancelling_at,
          cancelled_at: result.cancelled_at,
          request_counts: result.request_counts,
          metadata: result.metadata,
        });
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'Batch create failed';
        const statusCode = extractStatusCode(error) ?? 500;
        const errorType = extractErrorType(error) ?? 'batch_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'internal_error';
        
        log.error({ requestId, error: errorMessage }, 'Batch create failed');
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

  // ==========================================
  // GET /v1/batches/{batch_id}
  // ==========================================
  server.get('/v1/batches/:batch_id', {
    schema: {
      tags: ['Batches'],
      summary: 'Retrieve batch status',
      description: 'Retrieves detailed information about a specific batch job, including status, progress, request counts, timestamps, and result file IDs. Use this endpoint to monitor batch processing and check completion status.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['batch_id'],
        properties: {
          batch_id: { type: 'string', description: 'The ID of the batch to retrieve' },
        },
      },
      response: {
        200: {
          description: 'Batch status retrieved successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Batch ID' },
            object: { type: 'string', enum: ['batch'], description: 'Object type identifier' },
            endpoint: { type: 'string', description: 'API endpoint being processed by this batch (e.g., "/v1/chat/completions")' },
            input_file_id: { type: 'string', description: 'ID of the input file containing batch requests' },
            completion_window: { type: 'string', description: 'Time window for batch completion (e.g., "24h")' },
            status: { type: 'string', description: 'Batch status: validating (validating input), in_progress (processing), finalizing (completing), completed (success), expired (timeout), failed (errors), cancelled (user cancelled), cancelling (cancellation in progress)' },
            output_file_id: { type: 'string', nullable: true, description: 'ID of the output file with batch results (null if not completed)' },
            error_file_id: { type: 'string', nullable: true, description: 'ID of the error file with failed requests (null if no errors)' },
            created_at: { type: 'integer', description: 'Unix timestamp when the batch was created' },
            in_progress_at: { type: 'integer', nullable: true, description: 'Unix timestamp when processing started (null if not started)' },
            expires_at: { type: 'integer', nullable: true, description: 'Unix timestamp when the batch expires (null if no expiration)' },
            finalizing_at: { type: 'integer', nullable: true, description: 'Unix timestamp when finalization started (null if not finalizing)' },
            completed_at: { type: 'integer', nullable: true, description: 'Unix timestamp when batch completed successfully (null if not completed)' },
            failed_at: { type: 'integer', nullable: true, description: 'Unix timestamp when batch failed (null if not failed)' },
            expired_at: { type: 'integer', nullable: true, description: 'Unix timestamp when batch expired (null if not expired)' },
            cancelling_at: { type: 'integer', nullable: true, description: 'Unix timestamp when cancellation started (null if not cancelling)' },
            cancelled_at: { type: 'integer', nullable: true, description: 'Unix timestamp when batch was cancelled (null if not cancelled)' },
            request_counts: { type: 'object', nullable: true, description: 'Statistics about batch requests (total, completed, failed counts)' },
            metadata: { type: 'object', nullable: true, description: 'Metadata key-value pairs associated with the batch' },
          },
        },
        400: {
          description: 'Bad request (invalid parameters)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_parameter")' },
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
          description: 'Batch not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the batch was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "batch_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { batch_id: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const extendedRequest = request as ExtendedFastifyRequest;
      const userContext = extendedRequest.userContext || createOrchestrationContext(request);
      const { batch_id } = request.params;

      log.info({ requestId, batch_id }, 'Get batch request received');

      try {
        const result = await batchService.getBatch({
          batchId: batch_id,
          userContext,
          requestId,
        });

        return reply.send({
          id: result.id,
          object: 'batch',
          endpoint: result.endpoint,
          input_file_id: result.input_file_id,
          completion_window: result.completion_window,
          status: result.status,
          output_file_id: result.output_file_id,
          error_file_id: result.error_file_id,
          created_at: result.created_at,
          in_progress_at: result.in_progress_at,
          expires_at: result.expires_at,
          finalizing_at: result.finalizing_at,
          completed_at: result.completed_at,
          failed_at: result.failed_at,
          expired_at: result.expired_at,
          cancelling_at: result.cancelling_at,
          cancelled_at: result.cancelled_at,
          request_counts: result.request_counts,
          metadata: result.metadata,
        });
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'Batch not found';
        const statusCode = extractStatusCode(error) ?? 404;
        const errorType = extractErrorType(error) ?? 'batch_not_found_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'not_found';
        
        log.error({ requestId, batch_id, error: errorMessage }, 'Get batch failed');
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

  // ==========================================
  // POST /v1/batches/{batch_id}/cancel
  // ==========================================
  server.post('/v1/batches/:batch_id/cancel', {
    schema: {
      tags: ['Batches'],
      summary: 'Cancel batch',
      description: 'Cancels an in-progress batch. The batch will finish processing requests that are already in flight.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['batch_id'],
        properties: {
          batch_id: { type: 'string', description: 'The ID of the batch to cancel' },
        },
      },
      response: {
        200: {
          description: 'Batch cancelled successfully',
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['batch'] },
            status: { type: 'string', enum: ['cancelling', 'cancelled'] },
            cancelling_at: { type: 'integer', nullable: true },
          },
        },
        400: { description: 'Batch cannot be cancelled (not in valid state)', type: 'object', properties: { error: { type: 'object', properties: { message: { type: 'string' }, type: { type: 'string' }, code: { type: 'string' } } } } },
        404: { description: 'Batch not found', type: 'object', properties: { error: { type: 'object', properties: { message: { type: 'string' }, type: { type: 'string' }, code: { type: 'string' } } } } },
        500: { description: 'Internal server error', type: 'object', properties: { error: { type: 'object', properties: { message: { type: 'string' }, type: { type: 'string' }, code: { type: 'string' } } } } },
      },
    },
    preHandler: authenticateRequest,
    handler: async (request: FastifyRequest<{ Params: { batch_id: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const extendedRequest = request as ExtendedFastifyRequest;
      const userContext = extendedRequest.userContext || createOrchestrationContext(request);
      const { batch_id } = request.params;

      log.info({ requestId, batch_id }, 'Cancel batch request received');

      try {
        const result = await batchService.cancelBatch({
          batchId: batch_id,
          userContext,
          requestId,
        });

        return reply.send({
          id: result.id,
          object: 'batch',
          status: result.status,
          cancelling_at: result.cancelling_at,
        });
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'Batch not found';
        const statusCode = extractStatusCode(error) ?? 404;
        const errorType = extractErrorType(error) ?? 'batch_not_found_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'not_found';
        
        log.error({ requestId, batch_id, error: errorMessage }, 'Cancel batch failed');
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

  // ==========================================
  // GET /v1/batches
  // ==========================================
  server.get('/v1/batches', {
    schema: {
      tags: ['Batches'],
      summary: 'List batches',
      description: 'Returns a paginated list of batch jobs for the organization. Supports cursor-based pagination using `after` parameter. Use this endpoint to monitor all batch processing jobs and their current status.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      querystring: {
        type: 'object',
        required: [],
        properties: {
          limit: { 
            type: 'integer', 
            minimum: 1, 
            maximum: 100, 
            default: 20,
            description: 'Number of batches to return (1-100, default: 20)',
          },
          after: { 
            type: 'string',
            description: 'Cursor for pagination (after this batch ID)',
          },
        },
      },
      response: {
        200: {
          description: 'Batches listed successfully',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'], description: 'Object type identifier' },
            data: {
              type: 'array',
              description: 'Array of batch objects',
              items: {
                type: 'object',
                description: 'Batch object containing status and metadata',
                properties: {
                  id: { type: 'string', description: 'Unique batch ID' },
                  object: { type: 'string', enum: ['batch'], description: 'Object type identifier' },
                  endpoint: { type: 'string', description: 'API endpoint being processed by this batch (e.g., "/v1/chat/completions", "/v1/embeddings")' },
                  status: { type: 'string', description: 'Batch status: validating (validating input file), in_progress (processing), finalizing (completing), completed (success), expired (timeout), failed (errors occurred), cancelled (user cancelled), cancelling (cancellation in progress)' },
                  created_at: { type: 'integer', description: 'Unix timestamp when the batch was created' },
                  completed_at: { type: 'integer', nullable: true, description: 'Unix timestamp when the batch completed successfully (null if not completed or failed)' },
                },
              },
            },
            has_more: { type: 'boolean', description: 'Whether there are more batches available beyond this page (true if additional pages exist)' },
          },
        },
        400: {
          description: 'Bad request (invalid query parameters)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_parameter")' },
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
    handler: async (request: FastifyRequest<{ Querystring: { limit?: number; after?: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const extendedRequest = request as ExtendedFastifyRequest;
      const userContext = extendedRequest.userContext || createOrchestrationContext(request);
      const { limit = 20, after } = request.query;

      log.info({ requestId, limit }, 'List batches request received');

      try {
        const result = await batchService.listBatches({
          limit,
          after,
          userContext,
          requestId,
        });

        return reply.send({
          object: 'list',
          data: result.batches,
          has_more: result.has_more,
        });
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'List batches failed';
        const statusCode = extractStatusCode(error) ?? 500;
        const errorType = extractErrorType(error) ?? 'batch_list_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'internal_error';
        
        log.error({ requestId, error: errorMessage }, 'List batches failed');
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

  log.info('Batch API routes registered successfully');
}

