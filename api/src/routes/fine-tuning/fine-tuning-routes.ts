// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Fine-tuning API Routes
 * OpenAI/Gemini-compatible fine-tuning endpoints
 * 
 * Features:
 * - Multi-provider orchestration (OpenAI, Google Gemini, Azure, etc.)
 * - Job management (create, list, cancel, delete)
 * - Event streaming
 * - Checkpoint management
 * - Training metrics tracking
 * 
 * NO HARDCODED MODELS - Base models selected dynamically
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { requireTenantContext } from '@/api/middleware/tenant-isolation-middleware';
import { FineTuningService } from '@/services/fine-tuning-service';
import type { RequestUserContext } from '@/types';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import type {
  CreateFineTuningJobRequest,
  ListFineTuningJobsRequest,
  GetFineTuningJobRequest,
  CancelFineTuningJobRequest,
  ListFineTuningEventsRequest,
  ListFineTuningCheckpointsRequest,
  DeleteFineTuningJobRequest,
} from '@/types/fine-tuning';

const log = logger.child({ module: 'fine-tuning-routes' });

/**
 * Helper to extract user context from authenticated request
 */
function getUserContext(request: FastifyRequest): RequestUserContext {
  const extendedRequest = request as ExtendedFastifyRequest;
  const user = extendedRequest.user as { userId?: string; organizationId?: string; email?: string; name?: string } | undefined;
  
  return {
    requestId: request.id,
    organizationId: extendedRequest.organizationId || user?.organizationId || '',
    userId: extendedRequest.userId || user?.userId || '',
  };
}

// ============================================
// Request Schemas
// ============================================

const FineTuningJobCreateSchema = z.object({
  training_file: z.string(),
  validation_file: z.string().optional(),
  model: z.string(),
  hyperparameters: z.object({
    n_epochs: z.union([z.number(), z.literal('auto')]).optional().default('auto'),
    batch_size: z.union([z.number(), z.literal('auto')]).optional().default('auto'),
    learning_rate_multiplier: z.union([z.number(), z.literal('auto')]).optional().default('auto'),
  }).optional(),
  suffix: z.string().max(40).optional(),
  integrations: z.array(z.object({
    type: z.string(),
    wandb: z.object({
      project: z.string(),
      name: z.string().optional(),
      entity: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }).optional(),
  })).optional(),
  seed: z.number().optional(),
});

// ============================================
// Register Routes
// ============================================

export async function registerFineTuningRoutes(server: FastifyInstance): Promise<void> {
  const fineTuningService = new FineTuningService();

  // ==========================================
  // POST /v1/fine_tuning/jobs
  // ==========================================
  server.post('/v1/fine_tuning/jobs', {
    schema: {
      tags: ['Fine-tuning'],
      summary: 'Create fine-tuning job',
      description: 'Creates a fine-tuning job with multi-provider orchestration. Automatically selects the best provider based on base model availability and cost.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['training_file', 'model'],
        properties: {
          training_file: { type: 'string', description: 'ID of uploaded training file (JSONL format)' },
          validation_file: { type: 'string', description: 'ID of uploaded validation file (optional)' },
          model: { type: 'string', description: 'Base model to fine-tune (e.g., "gpt-3.5-turbo", "gpt-4", "gemini-pro")' },
          hyperparameters: {
            type: 'object',
            description: 'Fine-tuning hyperparameters. All parameters support "auto" for automatic optimization.',
            properties: {
              n_epochs: { 
                oneOf: [{ type: 'number' }, { type: 'string', enum: ['auto'] }], 
                default: 'auto',
                description: 'Number of training epochs. Use "auto" for automatic selection based on dataset size.',
              },
              batch_size: { 
                oneOf: [{ type: 'number' }, { type: 'string', enum: ['auto'] }], 
                default: 'auto',
                description: 'Training batch size. Use "auto" for automatic selection.',
              },
              learning_rate_multiplier: { 
                oneOf: [{ type: 'number' }, { type: 'string', enum: ['auto'] }], 
                default: 'auto',
                description: 'Learning rate multiplier relative to base model. Use "auto" for automatic tuning.',
              },
            },
          },
          suffix: { type: 'string', maxLength: 40, description: 'Suffix for fine-tuned model name (max 40 characters)' },
          integrations: {
            type: 'array',
            description: 'Integration configurations for logging and monitoring (e.g., Weights & Biases)',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', description: 'Integration type (e.g., "wandb")' },
                wandb: {
                  type: 'object',
                  description: 'Weights & Biases integration configuration',
                  properties: {
                    project: { type: 'string', description: 'W&B project name' },
                    name: { type: 'string', description: 'Run name in W&B' },
                    entity: { type: 'string', description: 'W&B entity/team name' },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Tags for organizing runs' },
                  },
                },
              },
            },
          },
          seed: { type: 'integer', description: 'Random seed for reproducibility' },
        },
      },
      response: {
        200: {
          description: 'Fine-tuning job created successfully',
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['fine_tuning.job'] },
            model: { type: 'string' },
            created_at: { type: 'integer' },
            finished_at: { type: 'integer', nullable: true },
            fine_tuned_model: { type: 'string', nullable: true },
            hyperparameters: { type: 'object' },
            organization_id: { type: 'string' },
            result_files: { type: 'array', items: { type: 'string' } },
            status: { type: 'string', enum: ['validating_files', 'queued', 'running', 'succeeded', 'failed', 'cancelled'] },
            trained_tokens: { type: 'integer', nullable: true },
            training_file: { type: 'string' },
            validation_file: { type: 'string', nullable: true },
            error: { type: 'object', nullable: true },
          },
        },
        400: {
          description: 'Bad request (invalid training file or model)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_training_file", "invalid_model", "file_format_error")' },
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
          description: 'Resource not found (e.g., training file, job, or checkpoint not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "file_not_found", "job_not_found")' },
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
    preHandler: [authenticateRequest, requireTenantContext()],
    handler: async (request: FastifyRequest<{ Body: Omit<CreateFineTuningJobRequest, 'userContext' | 'requestId'> }>, reply: FastifyReply) => {
      const requestId = request.id;
      const userContext = getUserContext(request);

      try {
        const validated = FineTuningJobCreateSchema.parse(request.body);
        const createRequest: CreateFineTuningJobRequest = {
          ...validated,
          userContext,
          requestId,
        };
        const result = await fineTuningService.createJob(createRequest);

        return reply.send(result);
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'Unknown error';
        const statusCode = extractStatusCode(error) ?? 500;
        
        log.error({ requestId, error: errorMessage }, 'Create fine-tuning job failed');
        return reply.code(statusCode).send({
          error: { message: errorMessage, type: 'fine_tuning_error' },
        });
      }
    },
  });

  // GET /v1/fine_tuning/jobs
  server.get('/v1/fine_tuning/jobs', {
    schema: {
      tags: ['Fine-tuning'],
      summary: 'List fine-tuning jobs',
      description: 'Returns a list of fine-tuning jobs for the organization with pagination support',
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
            description: 'Number of jobs to return (1-100, default: 20)',
          },
          after: { 
            type: 'string', 
            description: 'Cursor for pagination (after this job ID)',
          },
          before: { 
            type: 'string', 
            description: 'Cursor for pagination (before this job ID)',
          },
        },
      },
      response: {
        200: {
          description: 'Fine-tuning jobs listed successfully',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'] },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Fine-tuning job ID' },
                  object: { type: 'string', enum: ['fine_tuning.job'], description: 'Object type identifier' },
                  model: { type: 'string', description: 'Base model ID used for fine-tuning' },
                  created_at: { type: 'integer', description: 'Unix timestamp when the job was created' },
                  status: { type: 'string', description: 'Job status: validating_files (validating), queued (waiting), running (training), succeeded (completed), failed (errors), cancelled (cancelled)' },
                  fine_tuned_model: { type: 'string', nullable: true, description: 'Fine-tuned model ID (available when status is succeeded, null otherwise)' },
                },
              },
            },
            has_more: { type: 'boolean', description: 'Whether more items are available beyond this page' },
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
        404: {
          description: 'Resource not found (e.g., training file, job, or checkpoint not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "file_not_found", "job_not_found")' },
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
    preHandler: [authenticateRequest, requireTenantContext()],
    handler: async (request: FastifyRequest<{ Querystring: { limit?: number; after?: string; before?: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const userContext = getUserContext(request);
      const { limit = 20, after, before } = request.query;

      try {
        const listRequest: ListFineTuningJobsRequest = {
          limit,
          after,
          before,
          userContext,
          requestId,
        };
        const result = await fineTuningService.listJobs(listRequest);
        return reply.send({ object: 'list', data: result.jobs, has_more: result.has_more });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ requestId, error: errorMessage }, 'List fine-tuning jobs failed');
        return reply.code(500).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/fine_tuning/jobs/{id}
  server.get('/v1/fine_tuning/jobs/:job_id', {
    schema: {
      tags: ['Fine-tuning'],
      summary: 'Get fine-tuning job',
      description: 'Retrieves information about a specific fine-tuning job',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['job_id'],
        properties: {
          job_id: { type: 'string', description: 'The ID of the fine-tuning job' },
        },
      },
      response: {
        200: {
          description: 'Fine-tuning job retrieved successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Fine-tuning job ID' },
            object: { type: 'string', enum: ['fine_tuning.job'], description: 'Object type identifier' },
            model: { type: 'string', description: 'Base model ID used for fine-tuning' },
            created_at: { type: 'integer', description: 'Unix timestamp when the job was created' },
            finished_at: { type: 'integer', nullable: true, description: 'Unix timestamp when the job finished (null if still in progress)' },
            fine_tuned_model: { type: 'string', nullable: true, description: 'Fine-tuned model ID (available when status is succeeded, null otherwise)' },
            hyperparameters: { type: 'object', description: 'Hyperparameters used for fine-tuning (learning rate, batch size, etc.)' },
            organization_id: { type: 'string', description: 'Organization ID that owns this job' },
            result_files: { type: 'array', items: { type: 'string', description: 'File ID containing training results' }, description: 'Array of file IDs containing training results and metrics' },
            status: { type: 'string', description: 'Job status: validating_files (validating), queued (waiting), running (training), succeeded (completed), failed (errors), cancelled (cancelled)' },
            trained_tokens: { type: 'integer', nullable: true, description: 'Total number of tokens processed during training (null if not yet calculated)' },
            training_file: { type: 'string', description: 'File ID of the training dataset' },
            validation_file: { type: 'string', nullable: true, description: 'File ID of the validation dataset (null if not provided)' },
            error: { type: 'object', nullable: true, description: 'Error details if job failed (null if successful or still in progress)' },
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
          description: 'Job not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the job was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "job_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { job_id: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const userContext = getUserContext(request);
      const { job_id } = request.params;

      try {
        const getRequest: GetFineTuningJobRequest = {
          jobId: job_id,
          userContext,
          requestId,
        };
        const result = await fineTuningService.getJob(getRequest);
        return reply.send(result);
      } catch (error: unknown) {
        return reply.code(404).send({ error: { message: 'Job not found' } });
      }
    },
  });

  // POST /v1/fine_tuning/jobs/{id}/cancel
  server.post('/v1/fine_tuning/jobs/:job_id/cancel', {
    schema: {
      tags: ['Fine-tuning'],
      summary: 'Cancel fine-tuning job',
      description: 'Cancels an in-progress fine-tuning job. Only jobs in "validating_files", "queued", or "running" status can be cancelled. Once cancelled, the job status changes to "cancelled" and no further processing occurs. Partial training progress is not saved, and any partially trained models are discarded.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['job_id'],
        properties: {
          job_id: { type: 'string', description: 'The ID of the fine-tuning job to cancel' },
        },
      },
      response: {
        200: {
          description: 'Fine-tuning job cancelled successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Fine-tuning job ID' },
            object: { type: 'string', enum: ['fine_tuning.job'], description: 'Object type identifier' },
            model: { type: 'string', description: 'Base model ID used for fine-tuning' },
            created_at: { type: 'integer', description: 'Unix timestamp when the job was created' },
            status: { type: 'string', enum: ['cancelled', 'cancelling'], description: 'Job status: cancelled (fully cancelled) or cancelling (cancellation in progress)' },
            fine_tuned_model: { type: 'string', nullable: true, description: 'Fine-tuned model ID (null if job was cancelled before completion)' },
          },
        },
        400: {
          description: 'Bad request (job cannot be cancelled - not in valid state)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating why the job cannot be cancelled (e.g., already completed, failed, or cancelled)' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_state")' },
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
          description: 'Job not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the job was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "job_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { job_id: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const userContext = getUserContext(request);
      const { job_id } = request.params;

      try {
        const cancelRequest: CancelFineTuningJobRequest = {
          jobId: job_id,
          userContext,
          requestId,
        };
        const result = await fineTuningService.cancelJob(cancelRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/fine_tuning/jobs/{id}/events
  server.get('/v1/fine_tuning/jobs/:job_id/events', {
    schema: {
      tags: ['Fine-tuning'],
      summary: 'List fine-tuning events',
      description: 'Returns a list of events for a fine-tuning job with pagination support',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['job_id'],
        properties: {
          job_id: { type: 'string', description: 'The ID of the fine-tuning job' },
        },
      },
      querystring: {
        type: 'object',
        required: [],
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Number of events to return' },
          after: { type: 'string', description: 'Cursor for pagination (after this ID)' },
          before: { type: 'string', description: 'Cursor for pagination (before this ID)' },
        },
      },
      response: {
        200: {
          description: 'Fine-tuning events listed successfully',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'] },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Event ID' },
                  object: { type: 'string', enum: ['fine_tuning.job.event'], description: 'Object type identifier' },
                  created_at: { type: 'integer', description: 'Unix timestamp when the event was created' },
                  level: { type: 'string', enum: ['info', 'warn', 'error'], description: 'Event severity level: info (informational), warn (warning), error (error)' },
                  message: { type: 'string', description: 'Event message describing what happened' },
                  data: { type: 'object', nullable: true, description: 'Additional event data (varies by event type)' },
                },
              },
            },
            has_more: { type: 'boolean', description: 'Whether more items are available beyond this page' },
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
        404: {
          description: 'Job not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the job was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "job_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { job_id: string }; Querystring: { limit?: number; after?: string; before?: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const userContext = getUserContext(request);
      const { job_id } = request.params;
      const { limit = 20, after, before } = request.query;

      try {
        const listEventsRequest: ListFineTuningEventsRequest = {
          jobId: job_id,
          limit,
          after,
          before,
          userContext,
          requestId,
        };
        const result = await fineTuningService.listEvents(listEventsRequest);
        return reply.send({ object: 'list', data: result.events, has_more: result.has_more });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/fine_tuning/jobs/{id}/checkpoints
  server.get('/v1/fine_tuning/jobs/:job_id/checkpoints', {
    schema: {
      tags: ['Fine-tuning'],
      summary: 'List fine-tuning checkpoints',
      description: 'Returns a list of checkpoints for a fine-tuning job with pagination support',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['job_id'],
        properties: {
          job_id: { type: 'string', description: 'The ID of the fine-tuning job' },
        },
      },
      querystring: {
        type: 'object',
        required: [],
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: 'Number of checkpoints to return' },
          after: { type: 'string', description: 'Cursor for pagination (after this ID)' },
          before: { type: 'string', description: 'Cursor for pagination (before this ID)' },
        },
      },
      response: {
        200: {
          description: 'Fine-tuning checkpoints listed successfully',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'] },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Checkpoint ID' },
                  object: { type: 'string', enum: ['fine_tuning.job.checkpoint'], description: 'Object type identifier' },
                  created_at: { type: 'integer', description: 'Unix timestamp when the checkpoint was created' },
                  fine_tuned_model_checkpoint: { type: 'string', description: 'Checkpoint model identifier' },
                  step_number: { type: 'integer', description: 'Training step number when this checkpoint was saved' },
                  metrics: { type: 'object', description: 'Training metrics at this checkpoint (loss, accuracy, etc.)' },
                },
              },
            },
            has_more: { type: 'boolean', description: 'Whether more items are available beyond this page' },
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
        404: {
          description: 'Job not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the job was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "job_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { job_id: string }; Querystring: { limit?: number; after?: string; before?: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const userContext = getUserContext(request);
      const { job_id } = request.params;
      const { limit = 10, after, before } = request.query;

      try {
        const listCheckpointsRequest: ListFineTuningCheckpointsRequest = {
          jobId: job_id,
          limit,
          after,
          before,
          userContext,
          requestId,
        };
        const result = await fineTuningService.listCheckpoints(listCheckpointsRequest);
        return reply.send({ object: 'list', data: result.checkpoints, has_more: result.has_more });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // DELETE /v1/fine_tuning/jobs/{id}
  server.delete('/v1/fine_tuning/jobs/:job_id', {
    schema: {
      tags: ['Fine-tuning'],
      summary: 'Delete fine-tuned model',
      description: 'Deletes a fine-tuned model. This action cannot be undone.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['job_id'],
        properties: {
          job_id: { type: 'string', description: 'The ID of the fine-tuning job to delete' },
        },
      },
      response: {
        200: {
          description: 'Fine-tuned model deleted successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Fine-tuning job ID' },
            object: { type: 'string', enum: ['fine_tuning.job'], description: 'Object type identifier' },
            deleted: { type: 'boolean', description: 'Deletion confirmation flag' },
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
          description: 'Job not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the job was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "job_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { job_id: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const userContext = getUserContext(request);
      const { job_id } = request.params;

      try {
        const deleteRequest: DeleteFineTuningJobRequest = {
          jobId: job_id,
          userContext,
          requestId,
        };
        const result = await fineTuningService.deleteJob(deleteRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  log.info('Fine-tuning API routes registered successfully');
}

