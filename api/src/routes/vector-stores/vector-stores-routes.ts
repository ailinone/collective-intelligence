// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Vector Stores API Routes
 * OpenAI-compatible vector stores endpoints
 * 
 * Features:
 * - Vector store creation and management
 * - File associations for RAG
 * - Status tracking
 * - Expiration management
 * 
 * NO HARDCODED MODELS - All embedding models selected dynamically
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { VectorStoresService } from '@/services/vector-stores-service';
import type { RequestUserContext } from '@/types';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import type {
  CreateVectorStoreRequest,
  ModifyVectorStoreRequest,
  GetVectorStoreRequest,
  ListVectorStoresRequest,
  DeleteVectorStoreRequest,
  CreateVectorStoreFileRequest,
  ListVectorStoreFilesRequest,
  DeleteVectorStoreFileRequest,
  SearchVectorStoreRequest,
} from '@/types/assistants';

const log = logger.child({ module: 'vector-stores-routes' });

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

export async function registerVectorStoresRoutes(server: FastifyInstance): Promise<void> {
  const vectorStoresService = new VectorStoresService();

  // POST /v1/vector_stores
  server.post('/v1/vector_stores', {
    schema: {
      tags: ['Vector Stores'],
      summary: 'Create vector store',
      description: 'Create a new vector store for RAG (Retrieval-Augmented Generation). Vector stores enable efficient similarity search over large collections of documents for knowledge retrieval.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          name: { type: 'string', description: 'Name of the vector store' },
          file_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of file IDs to associate with the vector store',
          },
          expires_after: {
            type: 'object',
            properties: {
              anchor: { type: 'string', enum: ['last_active_at'], description: 'Anchor point for expiration calculation' },
              days: { type: 'number', minimum: 1, description: 'Number of days until expiration' },
            },
            description: 'Expiration configuration. Vector store expires after specified days from last active time.',
          },
          metadata: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Optional metadata key-value pairs for the vector store',
          },
        },
      },
      response: {
        200: {
          description: 'Vector store created successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique identifier for the vector store' },
            object: { type: 'string', enum: ['vector_store'], description: 'Object type' },
            created_at: { type: 'integer', description: 'Unix timestamp of creation' },
            name: { type: ['string', 'null'], description: 'Name of the vector store' },
            usage_bytes: { type: 'integer', description: 'Total storage used in bytes' },
            file_counts: {
              type: 'object',
              properties: {
                in_progress: { type: 'integer', description: 'Number of files being processed' },
                completed: { type: 'integer', description: 'Number of files successfully processed' },
                failed: { type: 'integer', description: 'Number of files that failed processing' },
                cancelled: { type: 'integer', description: 'Number of files cancelled' },
              },
            },
            status: { type: 'string', enum: ['expired', 'in_progress', 'completed'], description: 'Current status of the vector store' },
            expires_after: {
              type: ['object', 'null'],
              properties: {
                anchor: { type: 'string', enum: ['last_active_at'] },
                days: { type: 'number' },
              },
            },
            expires_at: { type: ['integer', 'null'], description: 'Unix timestamp when the vector store expires' },
            last_active_at: { type: ['integer', 'null'], description: 'Unix timestamp of last activity' },
            metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Vector store metadata' },
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
                code: { type: 'string', description: 'Error code (e.g., "invalid_parameter", "invalid_file_id")' },
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
          description: 'Resource not found (e.g., vector store or file not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "vector_store_not_found", "file_not_found")' },
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
    handler: async (request: FastifyRequest<{ Body: Omit<CreateVectorStoreRequest, 'userContext' | 'requestId'> }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const createRequest: CreateVectorStoreRequest = {
          ...request.body,
          userContext,
          requestId: request.id,
        };
        const result = await vectorStoresService.createVectorStore(createRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/vector_stores
  server.get('/v1/vector_stores', {
    schema: {
      tags: ['Vector Stores'],
      summary: 'List vector stores',
      description: 'List all vector stores for the organization. Supports pagination using cursor-based navigation with `after` and `before` parameters.',
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
            description: 'Maximum number of vector stores to return (1-100, default: 20)',
          },
          order: { type: 'string', enum: ['asc', 'desc'], default: 'desc', description: 'Sort order: asc (oldest first) or desc (newest first, default)' },
          after: { type: 'string', description: 'Cursor for pagination. Return results after this vector store ID.' },
          before: { type: 'string', description: 'Cursor for pagination. Return results before this vector store ID.' },
        },
      },
      response: {
        200: {
          description: 'Vector stores listed successfully',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'], description: 'Object type' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Vector store ID' },
                  object: { type: 'string', enum: ['vector_store'], description: 'Object type identifier' },
                  created_at: { type: 'integer', description: 'Unix timestamp when the vector store was created' },
                  name: { type: ['string', 'null'], description: 'Vector store name (null if unnamed)' },
                  usage_bytes: { type: 'integer', description: 'Total storage size in bytes used by the vector store' },
                  file_counts: { type: 'object', description: 'Object containing file count statistics (total, in_progress, completed, failed)' },
                  status: { type: 'string', enum: ['expired', 'in_progress', 'completed'], description: 'Vector store status: expired (expired), in_progress (processing files), completed (ready for use)' },
                  expires_at: { type: ['integer', 'null'], description: 'Unix timestamp when the vector store expires (null if no expiration)' },
                  last_active_at: { type: ['integer', 'null'], description: 'Unix timestamp of last activity/usage (null if never used)' },
                  metadata: { type: 'object', description: 'Metadata key-value pairs associated with the vector store' },
                },
              },
              description: 'Array of vector stores',
            },
            first_id: { type: ['string', 'null'], description: 'ID of the first vector store in the list' },
            last_id: { type: ['string', 'null'], description: 'ID of the last vector store in the list' },
            has_more: { type: 'boolean', description: 'Whether more vector stores are available beyond this page (true if additional pages exist)' },
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
          description: 'Resource not found (e.g., vector store or file not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "vector_store_not_found", "file_not_found")' },
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
    handler: async (request: FastifyRequest<{ Querystring: { limit?: number | string; order?: 'asc' | 'desc'; after?: string; before?: string } }>, reply: FastifyReply) => {
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

        const listRequest: ListVectorStoresRequest = {
          limit,
          order: request.query.order || 'desc',
          after: request.query.after,
          before: request.query.before,
          userContext,
          requestId: request.id,
        };
        const result = await vectorStoresService.listVectorStores(listRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/vector_stores/{id}
  server.get('/v1/vector_stores/:vector_store_id', {
    schema: {
      tags: ['Vector Stores'],
      summary: 'Get vector store',
      description: 'Retrieve a specific vector store by ID. Returns complete details including status, file counts, and expiration information.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['vector_store_id'],
        properties: {
          vector_store_id: { type: 'string', description: 'Unique identifier of the vector store to retrieve' },
        },
      },
      response: {
        200: {
          description: 'Vector store retrieved successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique identifier for the vector store' },
            object: { type: 'string', enum: ['vector_store'], description: 'Object type' },
            created_at: { type: 'integer', description: 'Unix timestamp of creation' },
            name: { type: ['string', 'null'], description: 'Name of the vector store' },
            usage_bytes: { type: 'integer', description: 'Total storage used in bytes' },
            file_counts: {
              type: 'object',
              properties: {
                in_progress: { type: 'integer', description: 'Number of files being processed' },
                completed: { type: 'integer', description: 'Number of files successfully processed' },
                failed: { type: 'integer', description: 'Number of files that failed processing' },
                cancelled: { type: 'integer', description: 'Number of files cancelled' },
              },
            },
            status: { type: 'string', enum: ['expired', 'in_progress', 'completed'], description: 'Current status of the vector store' },
            expires_after: {
              type: ['object', 'null'],
              properties: {
                anchor: { type: 'string', enum: ['last_active_at'] },
                days: { type: 'number' },
              },
            },
            expires_at: { type: ['integer', 'null'], description: 'Unix timestamp when the vector store expires' },
            last_active_at: { type: ['integer', 'null'], description: 'Unix timestamp of last activity' },
            metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Vector store metadata' },
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
          description: 'Vector store not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the vector store was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "vector_store_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { vector_store_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const getRequest: GetVectorStoreRequest = {
          vectorStoreId: request.params.vector_store_id,
          userContext,
          requestId: request.id,
        };
        const result = await vectorStoresService.getVectorStore(getRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') ? 404 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  // POST /v1/vector_stores/{id}
  server.post('/v1/vector_stores/:vector_store_id', {
    schema: {
      tags: ['Vector Stores'],
      summary: 'Modify vector store',
      description: 'Update an existing vector store. Can modify name, expiration settings, and metadata. Note: file associations cannot be modified through this endpoint; use file-specific endpoints.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['vector_store_id'],
        properties: {
          vector_store_id: { type: 'string', description: 'Unique identifier of the vector store to modify' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'], description: 'New name for the vector store (null to remove)' },
          expires_after: {
            type: ['object', 'null'],
            properties: {
              anchor: { type: 'string', enum: ['last_active_at'], description: 'Anchor point for expiration calculation' },
              days: { type: 'number', minimum: 1, description: 'Number of days until expiration' },
            },
            description: 'Expiration configuration (null to remove expiration)',
          },
          metadata: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Metadata to update. Replaces all existing metadata if provided.',
          },
        },
      },
      response: {
        200: {
          description: 'Vector store modified successfully',
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['vector_store'] },
            created_at: { type: 'integer' },
            name: { type: ['string', 'null'] },
            usage_bytes: { type: 'integer' },
            file_counts: { type: 'object' },
            status: { type: 'string', enum: ['expired', 'in_progress', 'completed'] },
            expires_after: { type: ['object', 'null'] },
            expires_at: { type: ['integer', 'null'] },
            last_active_at: { type: ['integer', 'null'] },
            metadata: { type: 'object', additionalProperties: { type: 'string' } },
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
          description: 'Vector store not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the vector store was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "vector_store_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { vector_store_id: string }; Body: Omit<ModifyVectorStoreRequest, 'vectorStoreId' | 'userContext' | 'requestId'> }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const modifyRequest: ModifyVectorStoreRequest = {
          vectorStoreId: request.params.vector_store_id,
          ...request.body,
          userContext,
          requestId: request.id,
        };
        const result = await vectorStoresService.modifyVectorStore(modifyRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') ? 404 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  // DELETE /v1/vector_stores/{id}
  server.delete('/v1/vector_stores/:vector_store_id', {
    schema: {
      tags: ['Vector Stores'],
      summary: 'Delete vector store',
      description: 'Permanently delete a vector store and all associated files. This action cannot be undone. All embeddings and indexed data will be removed.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['vector_store_id'],
        properties: {
          vector_store_id: { type: 'string', description: 'Unique identifier of the vector store to delete' },
        },
      },
      response: {
        200: {
          description: 'Vector store deleted successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID of the deleted vector store' },
            object: { type: 'string', enum: ['vector_store.deleted'], description: 'Object type' },
            deleted: { type: 'boolean', description: 'Deletion confirmation' },
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
          description: 'Vector store not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the vector store was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "vector_store_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { vector_store_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const deleteRequest: DeleteVectorStoreRequest = {
          vectorStoreId: request.params.vector_store_id,
          userContext,
          requestId: request.id,
        };
        const result = await vectorStoresService.deleteVectorStore(deleteRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') ? 404 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  // POST /v1/vector_stores/{id}/files
  server.post('/v1/vector_stores/:vector_store_id/files', {
    schema: {
      tags: ['Vector Stores'],
      summary: 'Create vector store file',
      description: 'Associate a file with a vector store. The file will be processed and its embeddings will be added to the vector store for similarity search. Processing happens asynchronously.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['vector_store_id'],
        properties: {
          vector_store_id: { type: 'string', description: 'Unique identifier of the vector store' },
        },
      },
      body: {
        type: 'object',
        required: ['file_id'],
        properties: {
          file_id: { type: 'string', description: 'ID of the file to associate with the vector store. File must have been uploaded previously.' },
        },
      },
      response: {
        200: {
          description: 'File associated with vector store successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique identifier for the vector store file association' },
            object: { type: 'string', enum: ['vector_store.file'], description: 'Object type' },
            created_at: { type: 'integer', description: 'Unix timestamp of creation' },
            vector_store_id: { type: 'string', description: 'ID of the associated vector store' },
            status: { type: 'string', enum: ['in_progress', 'completed', 'failed', 'cancelled'], description: 'Processing status of the file' },
          },
        },
        400: {
          description: 'Bad request (invalid file_id or vector_store_id)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_parameter", "invalid_file_id")' },
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
          description: 'Vector store or file not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the vector store or file was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "vector_store_not_found", "file_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { vector_store_id: string }; Body: { file_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const createRequest: CreateVectorStoreFileRequest = {
          vectorStoreId: request.params.vector_store_id,
          fileId: request.body.file_id,
          userContext,
          requestId: request.id,
        };
        const result = await vectorStoresService.createVectorStoreFile(createRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') ? 404 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  // POST /v1/vector_stores/{id}/search
  server.post('/v1/vector_stores/:vector_store_id/search', {
    schema: {
      tags: ['Vector Stores'],
      summary: 'Search vector store',
      description:
        'Run a semantic similarity search over a vector store. The query is embedded and ranked against the store\'s chunk embeddings using cosine similarity (pgvector HNSW). Returns the most relevant chunks with their similarity scores. Scoped to the calling organization.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['vector_store_id'],
        properties: {
          vector_store_id: { type: 'string', description: 'Unique identifier of the vector store to search' },
        },
      },
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, description: 'Natural-language query to search for' },
          top_k: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: 'Number of top-scoring chunks to return (1-100, default 10)' },
          file_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: restrict the search to chunks from these file IDs within the store',
          },
        },
      },
      response: {
        200: {
          description: 'Search results ordered by descending similarity score',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['vector_store.search_results'] },
            search_query: { type: 'string', description: 'Echo of the submitted query' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  file_id: { type: 'string', description: 'ID of the file this chunk came from' },
                  score: { type: 'number', description: 'Cosine similarity in [0,1] (1 = identical)' },
                  content: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', enum: ['text'] },
                        text: { type: 'string', description: 'The matched chunk text' },
                      },
                    },
                  },
                  chunk_index: { type: 'integer', description: 'Zero-based position of the chunk within its file' },
                  metadata: { type: 'object', description: 'Chunk metadata (e.g. source filename)' },
                },
              },
            },
            has_more: { type: 'boolean' },
            next_page: { type: ['string', 'null'] },
          },
        },
        400: {
          description: 'Bad request (missing/empty query)',
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
        404: {
          description: 'Vector store not found (or not owned by the caller)',
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
    preHandler: authenticateRequest,
    handler: async (request: FastifyRequest<{ Params: { vector_store_id: string }; Body: { query: string; top_k?: number; file_ids?: string[] } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const searchRequest: SearchVectorStoreRequest = {
          vectorStoreId: request.params.vector_store_id,
          query: request.body.query,
          top_k: request.body.top_k,
          file_ids: request.body.file_ids,
          userContext,
          requestId: request.id,
        };
        const result = await vectorStoresService.searchVectorStore(searchRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        let statusCode = 500;
        if (errorMessage.includes('not found')) statusCode = 404;
        else if (errorMessage.includes('query is required')) statusCode = 400;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  // GET /v1/vector_stores/{id}/files
  server.get('/v1/vector_stores/:vector_store_id/files', {
    schema: {
      tags: ['Vector Stores'],
      summary: 'List vector store files',
      description: 'List all files associated with a vector store. Supports filtering by status and pagination using cursor-based navigation.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['vector_store_id'],
        properties: {
          vector_store_id: { type: 'string', description: 'Unique identifier of the vector store' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          limit: {
            anyOf: [
              { type: 'integer', minimum: 1, maximum: 100 },
              { type: 'string', pattern: '^[0-9]+$' },
            ],
            default: 20,
            description: 'Maximum number of files to return (1-100)',
          },
          order: { type: 'string', enum: ['asc', 'desc'], default: 'desc', description: 'Sort order: asc (oldest first) or desc (newest first)' },
          after: { type: 'string', description: 'Cursor for pagination. Return results after this file ID.' },
          before: { type: 'string', description: 'Cursor for pagination. Return results before this file ID.' },
          filter: { type: 'string', enum: ['in_progress', 'completed', 'failed', 'cancelled'], description: 'Filter files by processing status' },
        },
      },
      response: {
        200: {
          description: 'Vector store files listed successfully',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'], description: 'Object type' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Unique identifier for the vector store file' },
                  object: { type: 'string', enum: ['vector_store.file'], description: 'Object type' },
                  created_at: { type: 'integer', description: 'Unix timestamp of creation' },
                  vector_store_id: { type: 'string', description: 'ID of the associated vector store' },
                  status: { type: 'string', enum: ['in_progress', 'completed', 'failed', 'cancelled'], description: 'Processing status' },
                },
              },
              description: 'Array of vector store files',
            },
            first_id: { type: ['string', 'null'], description: 'ID of the first file in the list' },
            last_id: { type: ['string', 'null'], description: 'ID of the last file in the list' },
            has_more: { type: 'boolean', description: 'Whether more files are available' },
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
          description: 'Vector store not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the vector store was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "vector_store_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { vector_store_id: string }; Querystring: { limit?: number | string; order?: 'asc' | 'desc'; after?: string; before?: string; filter?: 'in_progress' | 'completed' | 'failed' | 'cancelled' } }>, reply: FastifyReply) => {
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

        const listRequest: ListVectorStoreFilesRequest = {
          vectorStoreId: request.params.vector_store_id,
          limit,
          order: request.query.order || 'desc',
          after: request.query.after,
          before: request.query.before,
          filter: request.query.filter,
          userContext,
          requestId: request.id,
        };
        const result = await vectorStoresService.listVectorStoreFiles(listRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') ? 404 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  // DELETE /v1/vector_stores/{id}/files/{file_id}
  server.delete('/v1/vector_stores/:vector_store_id/files/:file_id', {
    schema: {
      tags: ['Vector Stores'],
      summary: 'Delete vector store file',
      description: 'Remove a file association from a vector store. The file embeddings will be removed from the vector store, but the original file remains in the system.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['vector_store_id', 'file_id'],
        properties: {
          vector_store_id: { type: 'string', description: 'Unique identifier of the vector store' },
          file_id: { type: 'string', description: 'Unique identifier of the file to remove from the vector store' },
        },
      },
      response: {
        200: {
          description: 'File removed from vector store successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID of the removed file' },
            object: { type: 'string', enum: ['vector_store.file.deleted'], description: 'Object type' },
            deleted: { type: 'boolean', description: 'Deletion confirmation' },
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
          description: 'Vector store, file, or association not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the vector store, file, or association was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "vector_store_not_found", "file_not_found", "association_not_found")' },
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
    handler: async (request: FastifyRequest<{ Params: { vector_store_id: string; file_id: string } }>, reply: FastifyReply) => {
      const userContext = getUserContext(request);
      try {
        const deleteRequest: DeleteVectorStoreFileRequest = {
          vectorStoreId: request.params.vector_store_id,
          fileId: request.params.file_id,
          userContext,
          requestId: request.id,
        };
        const result = await vectorStoresService.deleteVectorStoreFile(deleteRequest);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const statusCode = errorMessage.includes('not found') || errorMessage.includes('not associated') ? 404 : 500;
        return reply.code(statusCode).send({ error: { message: errorMessage } });
      }
    },
  });

  log.info('Vector Stores API routes registered successfully');
}
