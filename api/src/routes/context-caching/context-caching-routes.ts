// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Context Caching Routes
 * Claude/Gemini-compatible prompt/context caching API
 *
 * Features:
 * - Long context caching (up to 1M tokens)
 * - TTL configuration (5min, 1h, 24h)
 * - Cost optimization
 * - Organization-scoped caching
 *
 * NO HARDCODED MODELS - All caching is model-agnostic
 * NO MOCKS/STUBS - Real implementation with Redis + PostgreSQL
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import {
  ContextCachingService,
  type CacheTTL,
  type CreateCachedContextParams,
  type GetCachedContextParams,
  type ListCachedContextsParams,
  type DeleteCachedContextParams,
  type UseCachedContextParams,
} from '@/services/context-caching-service';
import { createOrchestrationContext } from '@/utils/orchestration-context';
import type { ChatMessage } from '@/types';

const log = logger.child({ module: 'context-caching-routes' });

// ==
// Request Schemas
// ==

const CreateCachedContextSchema = z.object({
  name: z.string().min(1).max(256),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'function', 'tool']),
      content: z.union([
        z.string(),
        z.array(
          z.union([
            z.object({ type: z.literal('text'), text: z.string() }),
            z.object({
              type: z.literal('image_url'),
              image_url: z.object({
                url: z.string(),
                detail: z.enum(['low', 'high', 'auto']).optional(),
              }),
            }),
          ])
        ),
      ]),
      name: z.string().optional(),
      tool_call_id: z.string().optional(),
    })
  ),
  ttl: z.enum(['5min', '1h', '24h']).optional().default('1h'),
  metadata: z.record(z.string()).optional(),
});

const _UseCachedContextSchema = z.object({
  context_id: z.string(),
  additional_messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'function', 'tool']),
        content: z.union([
          z.string(),
          z.array(
            z.union([
              z.object({ type: z.literal('text'), text: z.string() }),
              z.object({
                type: z.literal('image_url'),
                image_url: z.object({
                  url: z.string(),
                  detail: z.enum(['low', 'high', 'auto']).optional(),
                }),
              }),
            ])
          ),
        ]),
        name: z.string().optional(),
        tool_call_id: z.string().optional(),
      })
    )
    .optional(),
});

// ==
// Route Registration
// ==

export async function registerContextCachingRoutes(server: FastifyInstance): Promise<void> {
  const contextCachingService = new ContextCachingService();

  // POST /v1/caching/contexts
  // Create a new cached context
  server.post('/v1/caching/contexts', {
    schema: {
      tags: ['Caching'],
      summary: 'Create cached context',
      description:
        'Creates a cached context for reuse across multiple requests. Supports up to 1M tokens with configurable TTL (5min, 1h, 24h).',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'messages'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            description: 'Human-readable name for the cached context',
          },
          messages: {
            type: 'array',
            description: 'Array of messages to cache',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: ['system', 'user', 'assistant', 'function', 'tool'] },
                content: {
                  oneOf: [{ type: 'string' }, { type: 'array' }],
                },
              },
            },
          },
          ttl: {
            type: 'string',
            enum: ['5min', '1h', '24h'],
            default: '1h',
            description: 'Time-to-live for the cached context',
          },
          metadata: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Optional metadata key-value pairs',
          },
        },
      },
      response: {
        201: {
          description: 'Cached context created successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique context ID' },
            name: { type: 'string', description: 'Context name' },
            token_count: { type: 'integer', description: 'Number of tokens cached' },
            ttl: { type: 'string', enum: ['5min', '1h', '24h'], description: 'Time-to-live setting' },
            expires_at: { type: 'string', format: 'date-time', description: 'Expiration timestamp (ISO 8601)' },
            hash: { type: 'string', description: 'Content hash for deduplication' },
          },
        },
        400: {
          description: 'Bad request (invalid input)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_parameter", "token_limit_exceeded")' },
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
          description: 'Resource not found (e.g., cache service unavailable)',
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
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
      },
    },
    preHandler: authenticateRequest,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const parseResult = CreateCachedContextSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.code(400).send({
            error: {
              message: parseResult.error.message,
              type: 'invalid_request_error',
            },
          });
        }

        const { name, messages, ttl, metadata } = parseResult.data;
        const userContext = createOrchestrationContext(request, {
          taskType: 'caching',
          contextSize: 0,
        });

        const params: CreateCachedContextParams = {
          name,
          messages: messages as ChatMessage[],
          ttl: ttl as CacheTTL,
          metadata,
          userContext,
          requestId: request.id,
        };

        const result = await contextCachingService.createCachedContext(params);

        return reply.code(201).send({
          id: result.id,
          name: result.name,
          token_count: result.tokenCount,
          ttl: result.ttl,
          expires_at: result.expiresAt,
          hash: result.hash,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error: errorMessage, requestId: request.id }, 'Failed to create cached context');
        return reply.code(500).send({
          error: {
            message: errorMessage,
            type: 'internal_error',
          },
        });
      }
    },
  });

  // GET /v1/caching/contexts
  // List all cached contexts for the organization
  server.get('/v1/caching/contexts', {
    schema: {
      tags: ['Caching'],
      summary: 'List cached contexts',
      description: 'Returns a list of all cached contexts for the organization',
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
            description: 'Number of contexts to return (1-100, default: 20)',
          },
          offset: { 
            type: 'integer', 
            minimum: 0, 
            default: 0,
            description: 'Number of contexts to skip for pagination (default: 0)',
          },
        },
      },
      response: {
        200: {
          description: 'Cached contexts listed successfully',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'], description: 'Object type' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Context ID' },
                  name: { type: 'string', description: 'Context name' },
                  token_count: { type: 'integer', description: 'Number of tokens' },
                  ttl: { type: 'string', enum: ['5min', '1h', '24h'], description: 'Time-to-live' },
                  created_at: { type: 'string', format: 'date-time', description: 'Creation timestamp' },
                  expires_at: { type: 'string', format: 'date-time', description: 'Expiration timestamp' },
                  last_accessed_at: { type: 'string', format: 'date-time', description: 'Last access timestamp' },
                  access_count: { type: 'integer', description: 'Number of times accessed' },
                },
              },
              description: 'Array of cached contexts',
            },
            total: { type: 'integer', description: 'Total number of contexts' },
            has_more: { type: 'boolean', description: 'Whether more results are available' },
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
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const query = request.query as { limit?: number; offset?: number };
        const userContext = createOrchestrationContext(request, {
          taskType: 'caching',
          contextSize: 0,
        });

        const params: ListCachedContextsParams = {
          limit: query.limit ?? 20,
          offset: query.offset ?? 0,
          userContext,
          requestId: request.id,
        };

        const result = await contextCachingService.listCachedContexts(params);

        return reply.send({
          object: 'list',
          data: result.contexts.map((ctx) => ({
            id: ctx.id,
            name: ctx.name,
            token_count: ctx.tokenCount,
            ttl: ctx.ttl,
            created_at: ctx.createdAt,
            expires_at: ctx.expiresAt,
            last_accessed_at: ctx.lastAccessedAt,
            access_count: ctx.accessCount,
          })),
          total: result.total,
          has_more: result.hasMore,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error: errorMessage, requestId: request.id }, 'Failed to list cached contexts');
        return reply.code(500).send({
          error: {
            message: errorMessage,
            type: 'internal_error',
          },
        });
      }
    },
  });

  // GET /v1/caching/contexts/:context_id
  // Get a specific cached context
  server.get('/v1/caching/contexts/:context_id', {
    schema: {
      tags: ['Caching'],
      summary: 'Get cached context',
      description: 'Retrieves detailed information about a specific cached context by ID, including all cached messages, token count, TTL settings, and access statistics. Use this endpoint to inspect cached contexts and verify their contents before using them in chat completions.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['context_id'],
        properties: {
          context_id: { type: 'string', description: 'The ID of the cached context to retrieve' },
        },
      },
      response: {
        200: {
          description: 'Cached context retrieved successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Context ID' },
            name: { type: 'string', description: 'Context name' },
            messages: {
              type: 'array',
              description: 'Array of cached messages in the context',
              items: {
                type: 'object',
                description: 'Message object with role and content',
                properties: {
                  role: { type: 'string', description: 'Message role: user, assistant, or system' },
                  content: { 
                    oneOf: [{ type: 'string', description: 'Text content as string' }, { type: 'array', description: 'Array of content parts (multimodal)' }],
                    description: 'Message content (string or array)',
                  },
                },
              },
            },
            token_count: { type: 'integer', description: 'Total number of tokens in the cached context' },
            ttl: { type: 'string', enum: ['5min', '1h', '24h'], description: 'Time-to-live: 5min (5 minutes), 1h (1 hour), 24h (24 hours)' },
            created_at: { type: 'string', format: 'date-time', description: 'ISO 8601 timestamp when the context was created' },
            expires_at: { type: 'string', format: 'date-time', description: 'ISO 8601 timestamp when the context expires' },
            last_accessed_at: { type: 'string', format: 'date-time', description: 'ISO 8601 timestamp of the last access to this context' },
            access_count: { type: 'integer', description: 'Number of times this context has been accessed' },
            metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Metadata key-value pairs associated with the context' },
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
          description: 'Cached context not found or expired',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the context was not found or has expired' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "context_not_found" or "context_expired")' },
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
      try {
        const { context_id } = request.params as { context_id: string };
        const userContext = createOrchestrationContext(request, {
          taskType: 'caching',
          contextSize: 0,
        });

        const params: GetCachedContextParams = {
          contextId: context_id,
          userContext,
          requestId: request.id,
        };

        const result = await contextCachingService.getCachedContext(params);

        if (!result) {
          return reply.code(404).send({
            error: {
              message: 'Cached context not found or expired',
              type: 'not_found',
            },
          });
        }

        return reply.send({
          id: result.id,
          name: result.name,
          messages: result.messages,
          token_count: result.tokenCount,
          ttl: result.ttl,
          created_at: result.createdAt.toISOString(),
          expires_at: result.expiresAt.toISOString(),
          last_accessed_at: result.lastAccessedAt.toISOString(),
          access_count: result.accessCount,
          metadata: result.metadata,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error: errorMessage, requestId: request.id }, 'Failed to get cached context');
        return reply.code(500).send({
          error: {
            message: errorMessage,
            type: 'internal_error',
          },
        });
      }
    },
  });

  // DELETE /v1/caching/contexts/:context_id
  // Delete a cached context
  server.delete('/v1/caching/contexts/:context_id', {
    schema: {
      tags: ['Caching'],
      summary: 'Delete cached context',
      description: 'Permanently deletes a cached context by ID. This action cannot be undone and will free up the cached tokens. The context ID will no longer be valid after deletion. Use this endpoint to manage cache storage and remove unused contexts.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['context_id'],
        properties: {
          context_id: { type: 'string', description: 'The ID of the cached context to delete' },
        },
      },
      response: {
        200: {
          description: 'Cached context deleted successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID of the deleted context' },
            deleted: { type: 'boolean', description: 'Deletion confirmation flag (always true)' },
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
          description: 'Cached context not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the context was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "context_not_found")' },
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
      try {
        const { context_id } = request.params as { context_id: string };
        const userContext = createOrchestrationContext(request, {
          taskType: 'caching',
          contextSize: 0,
        });

        const params: DeleteCachedContextParams = {
          contextId: context_id,
          userContext,
          requestId: request.id,
        };

        const result = await contextCachingService.deleteCachedContext(params);

        return reply.send({
          id: result.id,
          deleted: result.deleted,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error: errorMessage, requestId: request.id }, 'Failed to delete cached context');
        return reply.code(500).send({
          error: {
            message: errorMessage,
            type: 'internal_error',
          },
        });
      }
    },
  });

  // POST /v1/caching/contexts/:context_id/use
  // Use a cached context with additional messages
  server.post('/v1/caching/contexts/:context_id/use', {
    schema: {
      tags: ['Caching'],
      summary: 'Use cached context',
      description:
        'Retrieves a cached context and optionally appends additional messages. Returns the full message array ready for chat completion.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['context_id'],
        properties: {
          context_id: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          additional_messages: {
            type: 'array',
            description: 'Additional messages to append to the cached context',
            items: {
              type: 'object',
              description: 'Message object to append',
              properties: {
                role: { 
                  type: 'string', 
                  enum: ['system', 'user', 'assistant', 'function', 'tool'],
                  description: 'Message role: system (instructions), user (input), assistant (response), function/tool (tool results)',
                },
                content: { 
                  type: 'string',
                  description: 'Message content text',
                },
              },
            },
          },
        },
      },
      response: {
        200: {
          description: 'Cached context used successfully',
          type: 'object',
          properties: {
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string' },
                  content: { oneOf: [{ type: 'string' }, { type: 'array' }] },
                },
              },
              description: 'Combined messages (cached + additional)',
            },
            cached_token_count: { type: 'integer', description: 'Number of tokens from cache' },
            total_token_count: { type: 'integer', description: 'Total tokens (cached + additional)' },
            cache_hit: { type: 'boolean', description: 'Whether cache was found and used' },
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
          description: 'Cached context not found or expired',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the context was not found or has expired' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "context_not_found" or "context_expired")' },
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
      try {
        const { context_id } = request.params as { context_id: string };
        const body = request.body as { additional_messages?: ChatMessage[] } | undefined;
        const userContext = createOrchestrationContext(request, {
          taskType: 'caching',
          contextSize: 0,
        });

        const params: UseCachedContextParams = {
          contextId: context_id,
          additionalMessages: body?.additional_messages,
          userContext,
          requestId: request.id,
        };

        const result = await contextCachingService.useCachedContext(params);

        if (!result.cacheHit) {
          return reply.code(404).send({
            error: {
              message: 'Cached context not found or expired',
              type: 'not_found',
            },
          });
        }

        return reply.send({
          messages: result.messages,
          cached_token_count: result.cachedTokenCount,
          total_token_count: result.totalTokenCount,
          cache_hit: result.cacheHit,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error: errorMessage, requestId: request.id }, 'Failed to use cached context');
        return reply.code(500).send({
          error: {
            message: errorMessage,
            type: 'internal_error',
          },
        });
      }
    },
  });

  log.info('Context Caching routes registered successfully (5 endpoints)');
}
