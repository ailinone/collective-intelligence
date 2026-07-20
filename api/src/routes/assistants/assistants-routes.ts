// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Assistants API Routes
 * OpenAI-compatible assistants endpoints
 * 
 * Features:
 * - Persistent AI assistants with instructions
 * - Tool integration (code_interpreter, file_search, function calling)
 * - Multi-model support (dynamic selection)
 * - Vector stores for knowledge
 * 
 * NO HARDCODED MODELS - All model selection is dynamic
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { requireTenantContext } from '@/api/middleware/tenant-isolation-middleware';
import { AssistantsService } from '@/services/assistants-service';
import type { RequestUserContext } from '@/types';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import type {
  CreateAssistantRequest,
  ModifyAssistantRequest,
  CreateAssistantFileRequest,
  GetAssistantFileRequest,
  ListAssistantFilesRequest,
  DeleteAssistantFileRequest,
} from '@/types/assistants';

const log = logger.child({ module: 'assistants-routes' });

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

export async function registerAssistantsRoutes(server: FastifyInstance): Promise<void> {
  const assistantsService = new AssistantsService();

  // POST /v1/assistants
  server.post('/v1/assistants', {
    schema: {
      tags: ['Assistants'],
      summary: 'Create assistant',
      description: 'Create an assistant with a model and instructions. Supports dynamic model selection based on capabilities. Assistants can be configured with custom tools, metadata, and behavior settings for specific use cases.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          model: { type: 'string', description: 'Model ID (e.g., "gpt-4", "claude-3-opus", or "auto" for dynamic selection)' },
          name: { type: 'string', nullable: true, description: 'Name of the assistant' },
          description: { type: 'string', nullable: true, description: 'Description of the assistant' },
          instructions: { type: 'string', nullable: true, description: 'System instructions for the assistant' },
          tools: {
            type: 'array',
            description: 'Tools available to the assistant. Each tool can be a code interpreter, file search, or custom function.',
            items: {
              type: 'object',
              properties: {
                type: { 
                  type: 'string', 
                  enum: ['code_interpreter', 'file_search', 'function'],
                  description: 'Tool type: code_interpreter (execute Python), file_search (semantic search), or function (custom function calling)',
                },
                function: {
                  type: 'object',
                  description: 'Function tool definition (required when type is "function")',
                  properties: {
                    name: { type: 'string', description: 'Function name (must be unique, a-z, A-Z, 0-9, _, -)' },
                    description: { type: 'string', description: 'Function description for the model to understand when to use it' },
                    parameters: { type: 'object', description: 'JSON Schema object defining function parameters' },
                  },
                },
              },
            },
          },
          tool_resources: {
            type: 'object',
            description: 'Resources for tool execution. Defines files and vector stores available to code_interpreter and file_search tools.',
            properties: {
              code_interpreter: {
                type: 'object',
                description: 'Resources for code_interpreter tool. Files uploaded here can be accessed by the code interpreter.',
                properties: {
                  file_ids: { 
                    type: 'array', 
                    items: { type: 'string' },
                    description: 'Array of file IDs accessible to the code interpreter for reading and writing data',
                  },
                },
              },
              file_search: {
                type: 'object',
                description: 'Resources for file_search tool. Configures vector stores for semantic search over documents.',
                properties: {
                  vector_store_ids: { 
                    type: 'array', 
                    items: { type: 'string' },
                    description: 'Array of existing vector store IDs to use for file search',
                  },
                  vector_stores: {
                    type: 'array',
                    description: 'Array of vector store configurations to create and use. Alternative to vector_store_ids.',
                    items: {
                      type: 'object',
                      properties: {
                        file_ids: { 
                          type: 'array', 
                          items: { type: 'string' },
                          description: 'File IDs to add to this vector store for semantic search',
                        },
                        name: { 
                          type: 'string',
                          description: 'Optional name for the vector store',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          metadata: { 
            type: 'object', 
            additionalProperties: { type: 'string' },
            description: 'Optional metadata key-value pairs for the assistant. Can be used for custom organization or filtering.',
          },
          temperature: { 
            type: 'number', 
            nullable: true, 
            minimum: 0, 
            maximum: 2,
            description: 'Sampling temperature (0-2). Higher values make output more random. Lower values make it more focused. Default varies by model.',
          },
          top_p: { 
            type: 'number', 
            nullable: true, 
            minimum: 0, 
            maximum: 1,
            description: 'Nucleus sampling parameter (0-1). Consider tokens with cumulative probability up to this threshold. Alternative to temperature.',
          },
          response_format: {
            oneOf: [
              { type: 'string', enum: ['text', 'json_object'], description: 'Response format as string: "text" (default) or "json_object" (forces JSON output)' },
              { 
                type: 'object', 
                properties: { type: { type: 'string', enum: ['json_object'], description: 'Must be "json_object" to force JSON output' } },
                description: 'Response format as object with type field',
              },
              { type: 'null', description: 'No format restriction (default text)' },
            ],
            description: 'Response format specification. Use "json_object" or { type: "json_object" } to force JSON responses. Requires model support for JSON mode.',
          },
        },
      },
      response: {
        200: {
          description: 'Assistant created successfully',
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['assistant'] },
            created_at: { type: 'integer' },
            name: { type: 'string', nullable: true },
            description: { type: 'string', nullable: true },
            model: { type: 'string' },
            instructions: { type: 'string', nullable: true },
          },
        },
        400: {
          description: 'Bad request (invalid parameters)',
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
        401: {
          description: 'Unauthorized',
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
    preHandler: [authenticateRequest, requireTenantContext()],
    handler: async (request: FastifyRequest<{ Body: Omit<CreateAssistantRequest, 'userContext' | 'requestId'> }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const body = request.body as Omit<CreateAssistantRequest, 'userContext' | 'requestId'>;
        const createRequest: CreateAssistantRequest = {
          ...body,
          userContext,
          requestId: request.id,
        };
        const result = await assistantsService.createAssistant(createRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/assistants/{id}
  server.get('/v1/assistants/:assistant_id', {
    schema: {
      tags: ['Assistants'],
      summary: 'Retrieve assistant',
      description: 'Retrieve a specific assistant by ID. Returns complete assistant details including model configuration, instructions, tools, and metadata. The assistant can be used for conversations and task execution. This endpoint provides full access to all assistant settings and configuration.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['assistant_id'],
        properties: {
          assistant_id: { type: 'string', description: 'The ID of the assistant to retrieve' },
        },
      },
      response: {
        200: {
          description: 'Assistant retrieved successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Assistant ID' },
            object: { type: 'string', enum: ['assistant'], description: 'Object type identifier' },
            created_at: { type: 'integer', description: 'Unix timestamp when the assistant was created' },
            name: { type: 'string', nullable: true, description: 'Assistant name' },
            description: { type: 'string', nullable: true, description: 'Assistant description' },
            model: { type: 'string', description: 'Model ID used by the assistant' },
            instructions: { type: 'string', nullable: true, description: 'System instructions for the assistant' },
            tools: { type: 'array', description: 'Array of tools available to the assistant' },
            tool_resources: { type: 'object', nullable: true, description: 'Resources for tool execution (files, vector stores)' },
            metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Metadata key-value pairs' },
            temperature: { type: 'number', nullable: true, description: 'Sampling temperature (0-2)' },
            top_p: { type: 'number', nullable: true, description: 'Nucleus sampling parameter (0-1)' },
            response_format: {
              oneOf: [
                { 
                  type: 'string', 
                  enum: ['text', 'json_object'],
                  description: 'Response format as string: "text" (default) or "json_object" (forces JSON output)',
                },
                { 
                  type: 'object',
                  description: 'Response format as object with type field (e.g., { type: "json_object" })',
                },
                { 
                  type: 'null',
                  description: 'No format restriction (default text)',
                },
              ],
              description: 'Response format specification. Use "json_object" or { type: "json_object" } to force JSON responses. Requires model support for JSON mode.',
            },
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
          description: 'Assistant not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the assistant was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "assistant_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { assistant_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const result = await assistantsService.getAssistant({ 
          assistantId: request.params.assistant_id, 
          userContext, 
          requestId: request.id 
        });
        return reply.send(result);
      } catch (error: unknown) {
        return reply.code(404).send({ error: { message: 'Assistant not found' } });
      }
    },
  });

  // POST /v1/assistants/{id}
  server.post('/v1/assistants/:assistant_id', {
    schema: {
      tags: ['Assistants'],
      summary: 'Modify assistant',
      description: 'Modify an assistant. Only provided fields will be updated. This allows partial updates to assistant configuration, including model settings, tools, instructions, and metadata. All fields are optional and only the provided ones will be changed.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['assistant_id'],
        properties: {
          assistant_id: { type: 'string', description: 'The ID of the assistant to modify' },
        },
      },
      body: {
        type: 'object',
        required: [],
        properties: {
          model: { 
            type: 'string',
            description: 'Model ID to update (e.g., "gpt-4", "claude-3-opus", or "auto" for dynamic selection)',
          },
          name: { 
            type: 'string', 
            nullable: true,
            description: 'Assistant name. Set to null to remove the name.',
          },
          description: { 
            type: 'string', 
            nullable: true,
            description: 'Assistant description. Set to null to remove the description.',
          },
          instructions: { 
            type: 'string', 
            nullable: true,
            description: 'System instructions for the assistant. Set to null to remove instructions.',
          },
          tools: { 
            type: 'array',
            description: 'Array of tools available to the assistant. Replaces existing tools if provided.',
          },
          tool_resources: { 
            type: 'object',
            description: 'Resources for tool execution (files, vector stores). Replaces existing resources if provided.',
          },
          metadata: { 
            type: 'object',
            description: 'Metadata key-value pairs. Replaces all existing metadata if provided.',
          },
          temperature: { 
            type: 'number', 
            nullable: true,
            description: 'Sampling temperature (0-2). Set to null to use model default.',
          },
          top_p: { 
            type: 'number', 
            nullable: true,
            description: 'Nucleus sampling parameter (0-1). Set to null to use model default.',
          },
          response_format: {
            oneOf: [
              { type: 'string', enum: ['text', 'json_object'], description: 'Response format as string: "text" (default) or "json_object" (forces JSON output)' },
              { type: 'object', properties: { type: { type: 'string', enum: ['json_object'], description: 'Must be "json_object" to force JSON output' } }, description: 'Response format as object with type field' },
              { type: 'null', description: 'No format restriction (default text)' },
            ],
            description: 'Response format specification. Use "json_object" or { type: "json_object" } to force JSON responses. Requires model support for JSON mode. Set to null to use default.',
          },
        },
      },
      response: {
        200: {
          description: 'Assistant modified successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Assistant ID' },
            object: { type: 'string', enum: ['assistant'], description: 'Object type identifier' },
            created_at: { type: 'integer', description: 'Unix timestamp when the assistant was created' },
            name: { type: 'string', nullable: true, description: 'Assistant name' },
            description: { type: 'string', nullable: true, description: 'Assistant description' },
            model: { type: 'string', description: 'Model ID used by the assistant' },
            instructions: { type: 'string', nullable: true, description: 'System instructions for the assistant' },
            tools: { type: 'array', description: 'Array of tools available to the assistant' },
            tool_resources: { type: 'object', nullable: true, description: 'Resources for tool execution (files, vector stores)' },
            metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Metadata key-value pairs' },
            temperature: { type: 'number', nullable: true, description: 'Sampling temperature (0-2)' },
            top_p: { type: 'number', nullable: true, description: 'Nucleus sampling parameter (0-1)' },
            response_format: {
              oneOf: [
                { 
                  type: 'string', 
                  enum: ['text', 'json_object'],
                  description: 'Response format as string: "text" (default) or "json_object" (forces JSON output)',
                },
                { 
                  type: 'object',
                  description: 'Response format as object with type field (e.g., { type: "json_object" })',
                },
                { 
                  type: 'null',
                  description: 'No format restriction (default text)',
                },
              ],
              description: 'Response format specification. Use "json_object" or { type: "json_object" } to force JSON responses. Requires model support for JSON mode.',
            },
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
          description: 'Assistant not found or referenced resource not found (e.g., file, vector store)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the assistant or referenced resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "assistant_not_found", "file_not_found", "vector_store_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { assistant_id: string }; Body: Omit<ModifyAssistantRequest, 'assistantId' | 'userContext' | 'requestId'> }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const body = request.body as Omit<ModifyAssistantRequest, 'assistantId' | 'userContext' | 'requestId'>;
        const modifyRequest: ModifyAssistantRequest = {
          assistantId: request.params.assistant_id,
          ...body,
          userContext,
          requestId: request.id,
        };
        const result = await assistantsService.modifyAssistant(modifyRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // DELETE /v1/assistants/{id}
  server.delete('/v1/assistants/:assistant_id', {
    schema: {
      tags: ['Assistants'],
      summary: 'Delete assistant',
      description: 'Permanently delete an assistant. This action cannot be undone. All associated data, including vector stores and file associations, will be removed. The assistant ID will no longer be valid after deletion.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['assistant_id'],
        properties: {
          assistant_id: { type: 'string', description: 'The ID of the assistant to delete' },
        },
      },
      response: {
        200: {
          description: 'Assistant deleted successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID of the deleted assistant' },
            object: { type: 'string', enum: ['assistant'], description: 'Object type identifier' },
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
          description: 'Assistant not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the assistant was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "assistant_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { assistant_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const result = await assistantsService.deleteAssistant({ 
          assistantId: request.params.assistant_id, 
          userContext, 
          requestId: request.id 
        });
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(404).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/assistants
  server.get('/v1/assistants', {
    schema: {
      tags: ['Assistants'],
      summary: 'List assistants',
      description: 'Returns a list of assistants owned by the organization',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
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
            description: 'Number of assistants to return (1-100, default: 20)',
          },
          after: { type: 'string', description: 'Cursor for pagination (after this ID)' },
          before: { type: 'string', description: 'Cursor for pagination (before this ID)' },
          order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order (default: desc)' },
        },
      },
      response: {
        200: {
          description: 'List of assistants',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'] },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  object: { type: 'string', enum: ['assistant'] },
                  created_at: { type: 'integer' },
                  name: { type: 'string', nullable: true },
                  description: { type: 'string', nullable: true },
                  model: { type: 'string' },
                  instructions: { type: 'string', nullable: true },
                  tools: { type: 'array' },
                  tool_resources: { type: 'object', nullable: true },
                  metadata: { type: 'object' },
                },
              },
            },
            has_more: { 
              type: 'boolean',
              description: 'Whether more assistants are available beyond this page (true if additional pages exist)',
            },
            first_id: {
              type: 'string',
              nullable: true,
              description: 'ID of the first assistant in this list (for pagination)',
            },
            last_id: {
              type: 'string',
              nullable: true,
              description: 'ID of the last assistant in this list (for pagination)',
            },
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
    preHandler: [authenticateRequest, requireTenantContext()],
    handler: async (request: FastifyRequest<{ Querystring: { limit?: number | string; after?: string; before?: string; order?: 'asc' | 'desc' } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        // Parse limit - can be string from query params
        let limit: number = 20;
        if (request.query.limit !== undefined) {
          if (typeof request.query.limit === 'string') {
            const parsed = parseInt(request.query.limit, 10);
            if (!isNaN(parsed) && parsed > 0) {
              limit = Math.min(parsed, 100); // Cap at 100
            }
          } else if (typeof request.query.limit === 'number' && request.query.limit > 0) {
            limit = Math.min(request.query.limit, 100); // Cap at 100
          }
        }

        const result = await assistantsService.listAssistants({ 
          limit, 
          after: request.query.after,
          before: request.query.before,
          order: request.query.order || 'desc',
          userContext, 
          requestId: request.id 
        });
        return reply.send({ object: 'list', data: result.assistants, has_more: result.has_more });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error: errorMessage, requestId: request.id }, 'List assistants failed');
        return reply.code(500).send({ error: { message: errorMessage } });
      }
    },
  });

  // POST /v1/assistants/{id}/files
  server.post('/v1/assistants/:assistant_id/files', {
    schema: { 
      tags: ['Assistants'], 
      summary: 'Create assistant file',
      description: 'Associate a file with an assistant. Files associated with assistants can be used by tools like file_search for semantic search and retrieval. The file must first be uploaded via the Files API before it can be associated with an assistant.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['assistant_id'],
        properties: {
          assistant_id: { type: 'string', description: 'The ID of the assistant' },
        },
      },
      body: {
        type: 'object',
        required: ['file_id'],
        properties: {
          file_id: { type: 'string', description: 'The ID of the file to associate with the assistant' },
        },
      },
      response: {
        200: {
          description: 'File associated successfully',
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['assistant.file'] },
            created_at: { type: 'integer' },
            assistant_id: { type: 'string' },
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
          description: 'Assistant or file not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the assistant or file was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "assistant_not_found" or "file_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { assistant_id: string }; Body: { file_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const createRequest: CreateAssistantFileRequest = {
          assistantId: request.params.assistant_id,
          fileId: request.body.file_id,
          userContext,
          requestId: request.id,
        };
        const result = await assistantsService.createAssistantFile(createRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') ? 404 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/assistants/{id}/files
  server.get('/v1/assistants/:assistant_id/files', {
    schema: { 
      tags: ['Assistants'], 
      summary: 'List assistant files',
      description: 'List all files associated with an assistant. Returns a paginated list of file associations that can be used by the assistant\'s tools (e.g., file_search for semantic search). Supports cursor-based pagination.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['assistant_id'],
        properties: {
          assistant_id: { type: 'string', description: 'The ID of the assistant' },
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
            description: 'Number of files to return (1-100, default: 20)',
          },
          order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order (default: desc)' },
          after: { type: 'string', description: 'Cursor for pagination (after this ID)' },
          before: { type: 'string', description: 'Cursor for pagination (before this ID)' },
        },
      },
      response: {
        200: {
          description: 'List of assistant files',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'] },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  object: { type: 'string', enum: ['assistant.file'] },
                  created_at: { type: 'integer' },
                  assistant_id: { type: 'string' },
                },
              },
            },
            has_more: { type: 'boolean', description: 'Whether more items are available beyond this page' },
            first_id: { type: 'string', nullable: true, description: 'ID of the first item in this list (for pagination)' },
            last_id: { type: 'string', nullable: true, description: 'ID of the last item in this list (for pagination)' },
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
          description: 'Assistant not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the assistant was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "assistant_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { assistant_id: string }; Querystring: { limit?: number | string; order?: 'asc' | 'desc'; after?: string; before?: string } }>, reply: FastifyReply) => {
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

        const listRequest: ListAssistantFilesRequest = {
          assistantId: request.params.assistant_id,
          limit,
          order: request.query.order || 'desc',
          after: request.query.after,
          before: request.query.before,
          userContext,
          requestId: request.id,
        };
        const result = await assistantsService.listAssistantFiles(listRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') ? 404 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/assistants/{id}/files/{file_id}
  server.get('/v1/assistants/:assistant_id/files/:file_id', {
    schema: { 
      tags: ['Assistants'], 
      summary: 'Get assistant file',
      description: 'Retrieve information about a specific file associated with an assistant. Returns metadata about the file association, including when it was created and the file ID. Use this to verify file associations for tools like file_search.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['assistant_id', 'file_id'],
        properties: {
          assistant_id: { type: 'string', description: 'The ID of the assistant' },
          file_id: { type: 'string', description: 'The ID of the file' },
        },
      },
      response: {
        200: {
          description: 'Assistant file retrieved successfully',
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['assistant.file'] },
            created_at: { type: 'integer' },
            assistant_id: { type: 'string' },
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
          description: 'Assistant or file not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the assistant or file was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "assistant_not_found" or "file_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { assistant_id: string; file_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const getRequest: GetAssistantFileRequest = {
          assistantId: request.params.assistant_id,
          fileId: request.params.file_id,
          userContext,
          requestId: request.id,
        };
        const result = await assistantsService.getAssistantFile(getRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') || errorMessage.includes('not associated') ? 404 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  // DELETE /v1/assistants/{id}/files/{file_id}
  server.delete('/v1/assistants/:assistant_id/files/:file_id', {
    schema: { 
      tags: ['Assistants'], 
      summary: 'Delete assistant file',
      description: 'Remove a file association from an assistant. This disconnects the file from the assistant, preventing it from being used by tools like file_search. The file itself is not deleted and can be re-associated later if needed.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['assistant_id', 'file_id'],
        properties: {
          assistant_id: { type: 'string', description: 'The ID of the assistant' },
          file_id: { type: 'string', description: 'The ID of the file to remove' },
        },
      },
      response: {
        200: {
          description: 'File association deleted successfully',
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['assistant.file.deleted'] },
            deleted: { type: 'boolean' },
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
          description: 'Assistant or file not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the assistant or file was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "assistant_not_found" or "file_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { assistant_id: string; file_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const deleteRequest: DeleteAssistantFileRequest = {
          assistantId: request.params.assistant_id,
          fileId: request.params.file_id,
          userContext,
          requestId: request.id,
        };
        const result = await assistantsService.deleteAssistantFile(deleteRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') || errorMessage.includes('not associated') ? 404 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  log.info('Assistants API routes registered successfully');
}
