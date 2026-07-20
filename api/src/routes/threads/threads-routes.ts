// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Threads API Routes
 * OpenAI-compatible threads/messages/runs endpoints
 * 
 * Features:
 * - Persistent conversation threads
 * - Message management
 * - Run execution with streaming
 * - Dynamic model selection per run
 * 
 * NO HARDCODED MODELS - All model selection is dynamic
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { ThreadsService } from '@/services/threads-service';
import type { RequestUserContext } from '@/types';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import type {
  CreateThreadRequest,
  ModifyThreadRequest,
  GetThreadRequest,
  DeleteThreadRequest,
  CreateMessageRequest,
  ListMessagesRequest,
  CreateRunRequest,
  ListRunsRequest,
  GetRunRequest,
  GetMessageRequest,
  ModifyMessageRequest,
  DeleteMessageRequest,
  SubmitToolOutputsRequest,
  CancelRunRequest,
  ListRunStepsRequest,
  GetRunStepRequest,
} from '@/types/threads';

const log = logger.child({ module: 'threads-routes' });

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

export async function registerThreadsRoutes(server: FastifyInstance): Promise<void> {
  const threadsService = new ThreadsService();

  // POST /v1/threads
  server.post('/v1/threads', {
    schema: {
      tags: ['Threads'],
      summary: 'Create thread',
      description: 'Create a new conversation thread. Threads represent conversations between a user and an assistant.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          messages: {
            type: 'array',
            description: 'Initial messages for the thread. Messages establish conversation context and can include text, images, and file attachments.',
            items: {
              type: 'object',
              properties: {
                role: { 
                  type: 'string', 
                  enum: ['user', 'assistant', 'system', 'tool'],
                  description: 'Message role: user (human input), assistant (AI response), system (instructions), tool (tool execution results)',
                },
                content: {
                  oneOf: [
                    { type: 'string', description: 'Text content as a string' },
                    {
                      type: 'array',
                      description: 'Multimodal content array supporting text and images',
                      items: {
                        type: 'object',
                        properties: {
                          type: { 
                            type: 'string', 
                            enum: ['text', 'image_url'],
                            description: 'Content type: text or image_url',
                          },
                          text: { type: 'string', description: 'Text content (required when type is "text")' },
                          image_url: {
                            type: 'object',
                            description: 'Image URL object (required when type is "image_url")',
                            properties: {
                              url: { type: 'string', description: 'Image URL (must be publicly accessible or use data URI)' },
                              detail: { 
                                type: 'string', 
                                enum: ['low', 'high', 'auto'],
                                description: 'Image detail level: low (cost-effective), high (full resolution), auto (adaptive)',
                              },
                            },
                          },
                        },
                      },
                    },
                  ],
                },
                file_ids: { 
                  type: 'array', 
                  items: { type: 'string' },
                  description: 'Array of file IDs attached to this message (for file_search tool)',
                },
                metadata: { 
                  type: 'object', 
                  additionalProperties: { type: 'string' },
                  description: 'Optional metadata key-value pairs for the message',
                },
                tool_call_id: { 
                  type: 'string',
                  description: 'ID of the tool call this message responds to (required for tool role messages)',
                },
                name: { 
                  type: 'string',
                  description: 'Name of the tool/function called (required for tool role messages)',
                },
              },
            },
          },
          metadata: { 
            type: 'object', 
            additionalProperties: { type: 'string' },
            description: 'Optional metadata key-value pairs for the thread',
          },
        },
      },
      response: {
        200: {
          description: 'Thread created successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Thread ID' },
            object: { type: 'string', enum: ['thread'], description: 'Object type identifier' },
            created_at: { type: 'integer', description: 'Unix timestamp when the thread was created' },
            metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Metadata key-value pairs associated with the thread' },
          },
        },
        400: {
          description: 'Bad request (invalid request body)',
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
          description: 'Resource not found (e.g., referenced file or resource not found)',
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
    handler: async (request: FastifyRequest<{ Body: Omit<CreateThreadRequest, 'userContext' | 'requestId'> }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const body = request.body as Omit<CreateThreadRequest, 'userContext' | 'requestId'>;
        const createRequest: CreateThreadRequest = {
          ...body,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.createThread(createRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/threads/{id}
  server.get('/v1/threads/:thread_id', {
    schema: {
      tags: ['Threads'],
      summary: 'Retrieve thread',
      description: 'Retrieve a specific conversation thread by ID. Returns complete thread information including all messages, metadata, and current state. Threads are used for maintaining conversation context across multiple interactions with assistants.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread to retrieve' },
        },
      },
      response: {
        200: {
          description: 'Thread retrieved successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Thread ID' },
            object: { type: 'string', enum: ['thread'], description: 'Object type identifier' },
            created_at: { type: 'integer', description: 'Unix timestamp when the thread was created' },
            metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Metadata key-value pairs' },
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
          description: 'Thread not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const getRequest: GetThreadRequest = {
          threadId: request.params.thread_id,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.getThread(getRequest);
        return reply.send(result);
      } catch (error: unknown) {
        return reply.code(404).send({ error: { message: 'Thread not found' } });
      }
    },
  });

  // POST /v1/threads/{id}
  server.post('/v1/threads/:thread_id', {
    schema: {
      tags: ['Threads'],
      summary: 'Modify thread',
      description: 'Updates the metadata of an existing thread. Only the metadata object can be modified; messages, runs, and other thread content cannot be changed through this endpoint. Use this to update custom metadata for organization and tracking purposes.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread to modify' },
        },
      },
      body: {
        type: 'object',
        required: [],
        properties: {
          metadata: { 
            type: 'object', 
            additionalProperties: { type: 'string' },
            description: 'Metadata key-value pairs to update. Replaces all existing metadata if provided.',
          },
        },
      },
      response: {
        200: {
          description: 'Thread modified successfully',
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['thread'] },
            created_at: { type: 'integer' },
            metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Metadata key-value pairs associated with the thread' },
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
          description: 'Thread not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string }; Body: Omit<ModifyThreadRequest, 'threadId' | 'userContext' | 'requestId'> }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const body = request.body as Omit<ModifyThreadRequest, 'threadId' | 'userContext' | 'requestId'>;
        const modifyRequest: ModifyThreadRequest = {
          threadId: request.params.thread_id,
          ...body,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.modifyThread(modifyRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // DELETE /v1/threads/{id}
  server.delete('/v1/threads/:thread_id', {
    schema: {
      tags: ['Threads'],
      summary: 'Delete thread',
      description: 'Permanently delete a conversation thread. This action cannot be undone. All messages, runs, and associated data will be removed. The thread ID will no longer be valid after deletion.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread to delete' },
        },
      },
      response: {
        200: {
          description: 'Thread deleted successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID of the deleted thread' },
            object: { type: 'string', enum: ['thread.deleted'], description: 'Object type identifier' },
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
          description: 'Thread not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const deleteRequest: DeleteThreadRequest = {
          threadId: request.params.thread_id,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.deleteThread(deleteRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // POST /v1/threads/{id}/messages
  server.post('/v1/threads/:thread_id/messages', {
    schema: {
      tags: ['Threads'],
      summary: 'Create message',
      description: 'Creates a new message in an existing thread. Supports text content, images (via file IDs), tool call outputs, and attachments. Messages are automatically ordered chronologically and can be retrieved via the list messages endpoint.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread' },
        },
      },
      body: {
        type: 'object',
        required: ['role', 'content'],
        properties: {
          role: { 
            type: 'string', 
            enum: ['user', 'assistant', 'system', 'tool'],
            description: 'Message role. For "tool" role, tool_call_id and name are required.'
          },
          content: { 
            oneOf: [
              { 
                type: 'string',
                description: 'Text content as a string (simple text message)',
              },
              { 
                type: 'array',
                description: 'Array of content parts for multimodal messages (text and/or images)',
                items: {
                  type: 'object',
                  properties: {
                    type: { 
                      type: 'string', 
                      enum: ['text', 'image_url'],
                      description: 'Content part type: text (plain text) or image_url (image reference)',
                    },
                    text: { 
                      type: 'string',
                      description: 'Text content (required when type is "text")',
                    },
                    image_url: {
                      type: 'object',
                      description: 'Image URL object (required when type is "image_url")',
                      properties: {
                        url: { 
                          type: 'string',
                          description: 'URL of the image. Can be a data URL (data:image/...) or HTTP(S) URL.',
                        },
                        detail: { 
                          type: 'string', 
                          enum: ['low', 'high', 'auto'],
                          description: 'Image detail level: "low" (faster, less accurate), "high" (slower, more accurate), "auto" (model decides).',
                        },
                      },
                    },
                  },
                },
              },
            ],
            description: 'Message content. Can be a string (text only) or array of parts (multimodal: text and/or images)',
          },
          file_ids: { 
            type: 'array', 
            items: { type: 'string' },
            description: 'File IDs attached to the message',
          },
          metadata: { 
            type: 'object',
            description: 'Additional metadata',
          },
          tool_call_id: { 
            type: 'string',
            description: 'Required when role is "tool"',
          },
          name: { 
            type: 'string',
            description: 'Tool name, required when role is "tool"',
          },
        },
      },
      response: {
        200: {
          description: 'Message created successfully',
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['thread.message'] },
            created_at: { type: 'integer' },
            thread_id: { type: 'string' },
            role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
            content: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { 
                        type: 'string', 
                        enum: ['text', 'image_url'],
                        description: 'Content part type: text (plain text) or image_url (image reference)',
                      },
                      text: { 
                        type: 'object', 
                        properties: { 
                          value: { 
                            type: 'string',
                            description: 'Text content value',
                          },
                        },
                        description: 'Text content object (required when type is "text")',
                      },
                      image_url: { 
                        type: 'object',
                        description: 'Image URL object (required when type is "image_url"). Contains url and optional detail fields.',
                      },
                    },
                  },
                },
              ],
            },
            file_ids: { 
              type: 'array', 
              items: { type: 'string' },
              description: 'Array of file IDs attached to this message (for file_search tool)',
            },
            assistant_id: { 
              type: 'string', 
              nullable: true,
              description: 'ID of the assistant that generated this message (for assistant role messages)',
            },
            run_id: { 
              type: 'string', 
              nullable: true,
              description: 'ID of the run that generated this message',
            },
            metadata: { 
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Optional metadata key-value pairs for the message',
            },
            tool_call_id: { 
              type: 'string', 
              nullable: true,
              description: 'ID of the tool call this message responds to (required for tool role messages)',
            },
            name: { 
              type: 'string', 
              nullable: true,
              description: 'Name of the tool/function called (required for tool role messages)',
            },
          },
        },
        400: {
          description: 'Bad request (invalid parameters or message content)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_parameter", "invalid_message_content")' },
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
          description: 'Thread not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string }; Body: Omit<CreateMessageRequest, 'threadId' | 'userContext' | 'requestId'> }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const body = request.body as Omit<CreateMessageRequest, 'threadId' | 'userContext' | 'requestId'>;
        const createMessageRequest: CreateMessageRequest = {
          threadId: request.params.thread_id,
          ...body,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.createMessage(createMessageRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/threads/{id}/messages
  server.get('/v1/threads/:thread_id/messages', {
    schema: {
      tags: ['Threads'],
      summary: 'List messages',
      description: 'Retrieves a paginated list of messages from a thread. Supports cursor-based pagination using `after` and `before` parameters, and ordering with `order` parameter (asc/desc). Returns messages in chronological order by default, with detailed metadata for each message.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread' },
        },
      },
      querystring: {
        type: 'object',
        required: [],
        properties: {
          limit: { type: 'integer', description: 'Number of messages to return (1-100, default: 20)' },
          order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order (default: desc)' },
          after: { type: 'string', description: 'Cursor for pagination (after this ID)' },
          before: { type: 'string', description: 'Cursor for pagination (before this ID)' },
          run_id: { type: 'string', description: 'Filter messages by run ID' },
        },
      },
      response: {
        200: {
          description: 'List of messages',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'], description: 'Object type identifier' },
            data: {
              type: 'array',
              description: 'Array of message objects',
              items: {
                type: 'object',
                description: 'Message object with role, content, and metadata',
                properties: {
                  id: { type: 'string', description: 'Unique message ID' },
                  object: { type: 'string', enum: ['thread.message'], description: 'Object type identifier' },
                  created_at: { type: 'integer', description: 'Unix timestamp when the message was created' },
                  thread_id: { type: 'string', description: 'ID of the thread this message belongs to' },
                  role: { type: 'string', description: 'Message role: user (human input), assistant (AI response), system (instructions), tool (tool execution results)' },
                  content: { 
                    oneOf: [
                      { type: 'string', description: 'Text content as a string (simple text message)' },
                      { type: 'array', description: 'Array of content parts for multimodal messages (text blocks, images, etc.)' },
                    ],
                    description: 'Message content. Can be a string (text only) or array of parts (multimodal: text and/or images)',
                  },
                },
              },
            },
            has_more: { type: 'boolean', description: 'Whether more messages are available beyond this page (true if additional pages exist)' },
            first_id: { type: 'string', nullable: true, description: 'ID of the first message in this list (for pagination)' },
            last_id: { type: 'string', nullable: true, description: 'ID of the last message in this list (for pagination)' },
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
          description: 'Thread not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string }; Querystring: { limit?: number; order?: 'asc' | 'desc'; after?: string; before?: string; run_id?: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const listMessagesRequest: ListMessagesRequest = {
          threadId: request.params.thread_id,
          limit: request.query.limit || 20,
          order: request.query.order || 'desc',
          after: request.query.after,
          before: request.query.before,
          run_id: request.query.run_id,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.listMessages(listMessagesRequest);
        return reply.send({ object: 'list', data: result.messages, has_more: result.has_more });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // POST /v1/threads/{id}/runs
  server.post('/v1/threads/:thread_id/runs', {
    schema: {
      tags: ['Threads'],
      summary: 'Create run',
      description: 'Creates a new run to execute an assistant on a thread. A run processes all messages in the thread and generates assistant responses, executing tools as needed. The run will execute asynchronously and can be monitored via the get run endpoint. Supports streaming for real-time updates.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread' },
        },
      },
      body: {
        type: 'object',
        required: ['assistant_id'],
        properties: {
          assistant_id: { type: 'string', description: 'The ID of the assistant to use' },
          model: { type: 'string', description: 'Override model for this run' },
          instructions: { type: 'string', description: 'Override instructions for this run' },
          additional_instructions: { type: 'string', description: 'Additional instructions' },
          tools: { type: 'array', description: 'Override tools for this run' },
          metadata: { 
            type: 'object', 
            additionalProperties: { type: 'string' },
            description: 'Optional metadata key-value pairs for the run',
          },
          temperature: { 
            type: 'number', 
            minimum: 0, 
            maximum: 2,
            description: 'Sampling temperature (0-2). Higher values make output more random. Lower values make it more focused.',
          },
          top_p: { 
            type: 'number', 
            minimum: 0, 
            maximum: 1,
            description: 'Nucleus sampling parameter (0-1). Consider tokens with cumulative probability up to this threshold.',
          },
          stream: { type: 'boolean', description: 'Enable streaming' },
        },
      },
      response: {
        200: {
          description: 'Run created successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique run ID' },
            object: { type: 'string', enum: ['thread.run'], description: 'Object type identifier' },
            created_at: { type: 'integer', description: 'Unix timestamp when the run was created' },
            thread_id: { type: 'string', description: 'ID of the thread this run belongs to' },
            assistant_id: { type: 'string', description: 'ID of the assistant used for this run' },
            status: { type: 'string', description: 'Run status: queued (waiting to start), in_progress (currently executing), requires_action (waiting for tool outputs), cancelling (cancellation in progress), cancelled (cancelled by user), failed (execution failed), completed (successfully finished), expired (timeout)' },
          },
        },
        400: {
          description: 'Bad request (invalid parameters or assistant configuration)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_parameter", "invalid_assistant")' },
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
          description: 'Thread or assistant not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread or assistant was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found", "assistant_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string }; Body: Omit<CreateRunRequest, 'threadId' | 'userContext' | 'requestId'> }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const body = request.body as Omit<CreateRunRequest, 'threadId' | 'userContext' | 'requestId'>;
        const createRunRequest: CreateRunRequest = {
          threadId: request.params.thread_id,
          ...body,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.createRun(createRunRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/threads/{id}/runs
  server.get('/v1/threads/:thread_id/runs', {
    schema: {
      tags: ['Threads'],
      summary: 'List runs',
      description: 'Returns a list of runs belonging to a thread with pagination support',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread' },
        },
      },
      querystring: {
        type: 'object',
        required: [],
        properties: {
          limit: {
            anyOf: [
              { type: 'integer', minimum: 1, maximum: 100 },
              { type: 'string', pattern: '^[0-9]+$' },
            ],
            default: 20,
            description: 'Number of runs to return (1-100, default: 20)',
          },
          order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order (default: desc)' },
          after: { type: 'string', description: 'Cursor for pagination (after this ID)' },
          before: { type: 'string', description: 'Cursor for pagination (before this ID)' },
        },
      },
      response: {
        200: {
          description: 'List of runs',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'] },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Run ID' },
                  object: { type: 'string', enum: ['thread.run'], description: 'Object type identifier' },
                  created_at: { type: 'integer', description: 'Unix timestamp when the run was created' },
                  thread_id: { type: 'string', description: 'ID of the thread this run belongs to' },
                  assistant_id: { type: 'string', description: 'ID of the assistant used for this run' },
                  status: { type: 'string', description: 'Run status: queued, in_progress, requires_action, cancelling, cancelled, failed, completed, or expired' },
                },
              },
            },
            has_more: { type: 'boolean', description: 'Whether more runs are available beyond this page (true if additional pages exist)' },
            first_id: { type: 'string', nullable: true, description: 'ID of the first run in this list (for pagination)' },
            last_id: { type: 'string', nullable: true, description: 'ID of the last run in this list (for pagination)' },
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
          description: 'Thread not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string }; Querystring: { limit?: number; order?: 'asc' | 'desc'; after?: string; before?: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        let limit: number = 20;
        if (request.query.limit !== undefined) {
          if (typeof request.query.limit === 'string') {
            const parsed = parseInt(request.query.limit, 10);
            if (!isNaN(parsed) && parsed > 0) {
              limit = Math.min(parsed, 100);
            }
          } else if (typeof request.query.limit === 'number' && request.query.limit > 0) {
            limit = Math.min(request.query.limit, 100);
          }
        }

        const listRunsRequest: ListRunsRequest = {
          threadId: request.params.thread_id,
          limit,
          order: request.query.order || 'desc',
          after: request.query.after,
          before: request.query.before,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.listRuns(listRunsRequest);
        return reply.send({ object: 'list', data: result.runs, has_more: result.has_more });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/threads/{id}/runs/{run_id}
  server.get('/v1/threads/:thread_id/runs/:run_id', {
    schema: {
      tags: ['Threads'],
      summary: 'Get run',
      description: 'Retrieve a specific run by ID. Returns detailed run information including status, steps, tool calls, and execution results. Runs represent individual assistant execution instances within a thread.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id', 'run_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread' },
          run_id: { type: 'string', description: 'The ID of the run to retrieve' },
        },
      },
      response: {
        200: {
          description: 'Run retrieved successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Run ID' },
            object: { type: 'string', enum: ['thread.run'], description: 'Object type identifier' },
            created_at: { type: 'integer', description: 'Unix timestamp when the run was created' },
            thread_id: { type: 'string', description: 'ID of the thread this run belongs to' },
            assistant_id: { type: 'string', description: 'ID of the assistant used for this run' },
            status: { type: 'string', description: 'Run status: queued, in_progress, requires_action, cancelling, cancelled, failed, completed, or expired' },
            required_action: { type: 'object', nullable: true, description: 'Action required from the user (e.g., tool outputs). Present when status is "requires_action".' },
            last_error: { type: 'object', nullable: true, description: 'Last error that occurred during the run. Present when status is "failed" or "cancelled".' },
            expires_at: { type: 'integer', nullable: true, description: 'Unix timestamp when the run expires. Null if the run does not expire.' },
            started_at: { type: 'integer', nullable: true, description: 'Unix timestamp when the run started. Null if the run has not started.' },
            completed_at: { type: 'integer', nullable: true, description: 'Unix timestamp when the run completed. Null if the run has not completed.' },
            cancelled_at: { type: 'integer', nullable: true, description: 'Unix timestamp when the run was cancelled. Null if the run was not cancelled.' },
            failed_at: { type: 'integer', nullable: true, description: 'Unix timestamp when the run failed. Null if the run did not fail.' },
            metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Metadata key-value pairs associated with the run' },
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
          description: 'Thread or run not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread or run was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found" or "run_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string; run_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const getRunRequest: GetRunRequest = {
          threadId: request.params.thread_id,
          runId: request.params.run_id,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.getRun(getRunRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/threads/{id}/messages/{message_id}
  server.get('/v1/threads/:thread_id/messages/:message_id', {
    schema: {
      tags: ['Threads'],
      summary: 'Get message',
      description: 'Retrieves detailed information about a specific message in a thread, including content, role, attachments, tool calls, and metadata. Use this endpoint to inspect individual messages and their associated data, such as file IDs or tool execution results.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id', 'message_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread' },
          message_id: { type: 'string', description: 'The ID of the message to retrieve' },
        },
      },
      response: {
        200: {
          description: 'Message retrieved successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Message ID' },
            object: { type: 'string', enum: ['thread.message'], description: 'Object type identifier' },
            created_at: { type: 'integer', description: 'Unix timestamp when the message was created' },
            thread_id: { type: 'string', description: 'ID of the thread this message belongs to' },
            role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'], description: 'Message role: user (human input), assistant (AI response), system (instructions), tool (tool execution results)' },
            content: { 
              oneOf: [
                { type: 'string', description: 'Text content as a string' },
                { type: 'array', description: 'Array of content parts (multimodal content)' },
              ],
              description: 'Message content (string or array of parts)',
            },
            file_ids: { type: 'array', items: { type: 'string' }, description: 'Array of file IDs attached to this message' },
            assistant_id: { type: 'string', nullable: true, description: 'ID of the assistant that generated this message (for assistant role messages)' },
            run_id: { type: 'string', nullable: true, description: 'ID of the run that generated this message' },
            metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Metadata key-value pairs associated with the message' },
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
          description: 'Thread or message not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread or message was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found" or "message_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string; message_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const getMessageRequest: GetMessageRequest = {
          threadId: request.params.thread_id,
          messageId: request.params.message_id,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.getMessage(getMessageRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // POST /v1/threads/{id}/messages/{message_id}
  server.post('/v1/threads/:thread_id/messages/:message_id', {
    schema: {
      tags: ['Threads'],
      summary: 'Modify message',
      description: 'Updates the metadata of an existing message in a thread. Only the metadata object can be modified; message content, role, and other core properties cannot be changed. The provided metadata replaces all existing metadata. Use this endpoint to update custom metadata for organization, tagging, or tracking purposes without affecting the message content itself.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id', 'message_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread' },
          message_id: { type: 'string', description: 'The ID of the message to modify' },
        },
      },
      body: {
        type: 'object',
        required: [],
        properties: {
          metadata: { 
            type: 'object', 
            additionalProperties: { type: 'string' },
            description: 'Metadata key-value pairs to update. Replaces all existing metadata if provided.',
          },
        },
      },
      response: {
        200: {
          description: 'Message modified successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Message ID' },
            object: { type: 'string', enum: ['thread.message'], description: 'Object type identifier' },
            created_at: { type: 'integer', description: 'Unix timestamp when the message was created' },
            thread_id: { type: 'string', description: 'ID of the thread this message belongs to' },
            role: { type: 'string', description: 'Message role: user, assistant, system, or tool' },
            content: { 
              oneOf: [
                { type: 'string', description: 'Text content as a string' },
                { type: 'array', description: 'Array of content parts (multimodal content)' },
              ],
              description: 'Message content (string or array of parts)',
            },
            metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Metadata key-value pairs associated with the message' },
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
          description: 'Thread or message not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread or message was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found" or "message_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string; message_id: string }; Body: Omit<ModifyMessageRequest, 'threadId' | 'messageId' | 'userContext' | 'requestId'> }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const body = request.body as Omit<ModifyMessageRequest, 'threadId' | 'messageId' | 'userContext' | 'requestId'>;
        const modifyMessageRequest: ModifyMessageRequest = {
          threadId: request.params.thread_id,
          messageId: request.params.message_id,
          ...body,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.modifyMessage(modifyMessageRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // DELETE /v1/threads/{id}/messages/{message_id}
  server.delete('/v1/threads/:thread_id/messages/:message_id', {
    schema: {
      tags: ['Threads'],
      summary: 'Delete message',
      description: 'Permanently deletes a message from a thread. This action cannot be undone. The message ID will no longer be valid after deletion. Use this endpoint to remove unwanted messages from conversation threads.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id', 'message_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread' },
          message_id: { type: 'string', description: 'The ID of the message to delete' },
        },
      },
      response: {
        200: {
          description: 'Message deleted successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID of the deleted message' },
            object: { type: 'string', enum: ['thread.message.deleted'], description: 'Object type identifier' },
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
          description: 'Thread or message not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread or message was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found" or "message_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string; message_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const deleteMessageRequest: DeleteMessageRequest = {
          threadId: request.params.thread_id,
          messageId: request.params.message_id,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.deleteMessage(deleteMessageRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // POST /v1/threads/{id}/runs/{run_id}/submit_tool_outputs
  server.post('/v1/threads/:thread_id/runs/:run_id/submit_tool_outputs', {
    schema: {
      tags: ['Threads'],
      summary: 'Submit tool outputs',
      description: 'Submits tool execution results for a run that is waiting for action (status "requires_action"). When an assistant uses function/tool calling during a run, the run pauses and requires tool outputs to continue. This endpoint allows providing those outputs to resume the run execution. Each tool_output must correspond to a tool_call_id from the run\'s required_action.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id', 'run_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread' },
          run_id: { type: 'string', description: 'The ID of the run' },
        },
      },
      body: {
        type: 'object',
        required: ['tool_outputs'],
        properties: {
          tool_outputs: {
            type: 'array',
            items: {
              type: 'object',
              required: ['tool_call_id'],
              properties: {
                tool_call_id: { 
                  type: 'string',
                  description: 'ID of the tool call that this output is for. Must match a tool_call_id from the run\'s required_action.',
                },
                output: { 
                  type: 'string',
                  description: 'Output from the tool execution. Required if error is not provided.',
                },
                error: { 
                  type: 'string',
                  description: 'Error message if the tool execution failed. Required if output is not provided.',
                },
              },
            },
          },
          stream: { type: 'boolean', description: 'Enable streaming responses' },
        },
      },
      response: {
        200: {
          description: 'Tool outputs submitted successfully, run will continue',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Run ID' },
            object: { type: 'string', enum: ['thread.run'], description: 'Object type identifier' },
            created_at: { type: 'integer', description: 'Unix timestamp when the run was created' },
            thread_id: { type: 'string', description: 'ID of the thread this run belongs to' },
            assistant_id: { type: 'string', description: 'ID of the assistant used for this run' },
            status: { type: 'string', description: 'Run status after tool outputs submission. Typically "in_progress" or "completed".' },
            required_action: { type: 'object', nullable: true, description: 'Action still required from the user (if any). Null if no action needed.' },
          },
        },
        400: {
          description: 'Invalid request or run not in requires_action status',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_parameter", "run_not_requires_action")' },
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
          description: 'Thread or run not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread or run was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found", "run_not_found")' },
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
    handler: async (request: FastifyRequest<{ 
      Params: { thread_id: string; run_id: string }; 
      Body: Omit<SubmitToolOutputsRequest, 'threadId' | 'runId' | 'userContext' | 'requestId'>;
    }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const body = request.body as Omit<SubmitToolOutputsRequest, 'threadId' | 'runId' | 'userContext' | 'requestId'>;
        const submitToolOutputsRequest: SubmitToolOutputsRequest = {
          threadId: request.params.thread_id,
          runId: request.params.run_id,
          tool_outputs: body.tool_outputs,
          stream: body.stream,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.submitToolOutputs(submitToolOutputsRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') || errorMessage.includes('not in requires_action') || errorMessage.includes('missing output') ? 400 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  // POST /v1/threads/{id}/runs/{run_id}/cancel
  server.post('/v1/threads/:thread_id/runs/:run_id/cancel', {
    schema: {
      tags: ['Threads'],
      summary: 'Cancel run',
      description: 'Cancels an in-progress run. Only runs with status "in_progress" or "queued" can be cancelled. Once cancelled, the run status changes to "cancelling" (immediate) or "cancelled" (final). The run will stop processing and no further assistant responses will be generated. Use this endpoint to halt long-running runs or when user input is needed to proceed. This is useful for stopping expensive operations or when a user changes their mind about a request.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id', 'run_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread' },
          run_id: { type: 'string', description: 'The ID of the run to cancel' },
        },
      },
      response: {
        200: {
          description: 'Run cancelled successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Run ID' },
            object: { type: 'string', enum: ['thread.run'], description: 'Object type identifier' },
            created_at: { type: 'integer', description: 'Unix timestamp when the run was created' },
            thread_id: { type: 'string', description: 'ID of the thread this run belongs to' },
            assistant_id: { type: 'string', description: 'ID of the assistant used for this run' },
            status: { type: 'string', enum: ['cancelled', 'cancelling'], description: 'Run status: "cancelling" (cancellation in progress) or "cancelled" (fully cancelled)' },
            cancelled_at: { type: 'integer', nullable: true, description: 'Unix timestamp when the run was cancelled. Null if cancellation is still in progress (status is "cancelling").' },
          },
        },
        400: {
          description: 'Bad request (run cannot be cancelled - not in_progress)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating why the run cannot be cancelled (e.g., already completed, failed, cancelled, or not yet started)' },
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
          description: 'Thread or run not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread or run was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found" or "run_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string; run_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const cancelRunRequest: CancelRunRequest = {
          threadId: request.params.thread_id,
          runId: request.params.run_id,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.cancelRun(cancelRunRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') || errorMessage.includes('cannot be cancelled') ? 400 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/threads/{id}/runs/{run_id}/steps
  server.get('/v1/threads/:thread_id/runs/:run_id/steps', {
    schema: {
      tags: ['Threads'],
      summary: 'List run steps',
      description: 'Returns a paginated list of all steps executed within a run, ordered chronologically. Steps represent individual operations such as message creation or tool calls. Supports cursor-based pagination using `after` and `before` parameters, and ordering with `order` parameter. Use this endpoint to inspect the complete execution flow of a run and track each operation performed by the assistant.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id', 'run_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread' },
          run_id: { type: 'string', description: 'The ID of the run' },
        },
      },
      querystring: {
        type: 'object',
        required: [],
        properties: {
          limit: {
            anyOf: [
              { type: 'integer', minimum: 1, maximum: 100 },
              { type: 'string', pattern: '^[0-9]+$' },
            ],
            default: 20,
            description: 'Number of steps to return (1-100, default: 20)',
          },
          order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order (default: desc)' },
          after: { type: 'string', description: 'Cursor for pagination (after this ID)' },
          before: { type: 'string', description: 'Cursor for pagination (before this ID)' },
        },
      },
      response: {
        200: {
          description: 'List of run steps',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'] },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Step ID' },
                  object: { type: 'string', enum: ['thread.run.step'], description: 'Object type identifier' },
                  created_at: { type: 'integer', description: 'Unix timestamp when the step was created' },
                  run_id: { type: 'string', description: 'ID of the run this step belongs to' },
                  thread_id: { type: 'string', description: 'ID of the thread this step belongs to' },
                  type: { type: 'string', enum: ['message_creation', 'tool_calls'], description: 'Step type: message_creation (creating message) or tool_calls (executing tools)' },
                  status: { type: 'string', description: 'Step status: in_progress, cancelled, failed, completed, or expired' },
                  step_details: { type: 'object', description: 'Detailed information about the step execution (message_creation or tool_calls details)' },
                },
              },
            },
            has_more: { type: 'boolean', description: 'Whether more steps are available beyond this page (true if additional pages exist)' },
            first_id: { type: 'string', nullable: true, description: 'ID of the first step in this list (for pagination)' },
            last_id: { type: 'string', nullable: true, description: 'ID of the last step in this list (for pagination)' },
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
          description: 'Thread or run not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread or run was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found" or "run_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string; run_id: string }; Querystring: { limit?: number; order?: 'asc' | 'desc'; after?: string; before?: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const listRunStepsRequest: ListRunStepsRequest = {
          threadId: request.params.thread_id,
          runId: request.params.run_id,
          limit: request.query.limit,
          order: request.query.order,
          after: request.query.after,
          before: request.query.before,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.listRunSteps(listRunStepsRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') ? 404 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/threads/{id}/runs/{run_id}/steps/{step_id}
  server.get('/v1/threads/:thread_id/runs/:run_id/steps/:step_id', {
    schema: {
      tags: ['Threads'],
      summary: 'Get run step',
      description: 'Retrieves detailed information about a specific step within a run. Steps represent individual operations performed during run execution, such as message creation or tool call execution. Returns step type, status, execution details (tool calls, message creation), and any errors that occurred during step processing. Use this to inspect individual operations within a run.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['thread_id', 'run_id', 'step_id'],
        properties: {
          thread_id: { type: 'string', description: 'The ID of the thread' },
          run_id: { type: 'string', description: 'The ID of the run' },
          step_id: { type: 'string', description: 'The ID of the step to retrieve' },
        },
      },
      response: {
        200: {
          description: 'Run step retrieved successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Step ID' },
            object: { type: 'string', enum: ['thread.run.step'], description: 'Object type identifier' },
            created_at: { type: 'integer', description: 'Unix timestamp when the step was created' },
            run_id: { type: 'string', description: 'ID of the run this step belongs to' },
            thread_id: { type: 'string', description: 'ID of the thread this step belongs to' },
            type: { type: 'string', enum: ['message_creation', 'tool_calls'], description: 'Step type: message_creation (creating message) or tool_calls (executing tools)' },
            status: { type: 'string', description: 'Step status: in_progress, cancelled, failed, completed, or expired' },
            step_details: {
              type: 'object',
              description: 'Detailed information about the step execution',
              properties: {
                type: { type: 'string', description: 'Step detail type: message_creation or tool_calls' },
                message_creation: { type: 'object', nullable: true, description: 'Message creation details (when type is message_creation)' },
                tool_calls: { type: 'array', nullable: true, description: 'Array of tool calls made in this step (when type is tool_calls)' },
              },
            },
            usage: { type: 'object', nullable: true, description: 'Token usage statistics for this step' },
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
          description: 'Thread, run, or step not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the thread, run, or step was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "thread_not_found", "run_not_found", or "step_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { thread_id: string; run_id: string; step_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const getRunStepRequest: GetRunStepRequest = {
          threadId: request.params.thread_id,
          runId: request.params.run_id,
          stepId: request.params.step_id,
          userContext,
          requestId: request.id,
        };
        const result = await threadsService.getRunStep(getRunStepRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') ? 404 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  log.info('Threads API routes registered successfully');
}
