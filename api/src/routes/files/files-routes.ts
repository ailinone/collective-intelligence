// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Files API Routes
 * OpenAI-compatible file upload/management endpoints
 * 
 * Features:
 * - Multi-format support (text, image, audio, video, PDF, etc.)
 * - GCS storage integration (no hardcoded bucket names)
 * - Purpose-based file management (fine-tune, assistants, vision, batch, etc.)
 * - Automatic format validation
 * - Metadata tracking
 * 
 * NO HARDCODED - All storage configuration from environment
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as crypto from 'crypto';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { FilesService } from '@/services/files-service';
import type { RequestUserContext } from '@/types';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { executeRouteWithRetry } from '@/utils/route-retry';

const log = logger.child({ module: 'files-routes' });

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

function getHeaderValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    // Array.isArray narrows to `any[]` (lib quirk); destructured `first`
    // gets typed as `unknown` here so the typeof guard is meaningful.
    const [first]: [unknown] = value as [unknown];
    if (typeof first === 'string' && first.trim().length > 0) {
      return first.trim();
    }
  }
  return undefined;
}

function buildUploadIdempotencyKey(
  requestId: string,
  organizationId: string,
  userId: string,
  purpose: string,
  filename: string,
  fileBuffer: Buffer
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${requestId}:${organizationId}:${userId}:${purpose}:${filename}:${fileBuffer.length}:`)
    .update(fileBuffer)
    .digest('hex');

  return hash;
}

// ==
// Request Schemas (OpenAI-compatible)
// ==

const _FileUploadSchema = z.object({
  file: z.unknown(), // Binary file (handled by multipart)
  purpose: z.enum([
    'fine-tune',
    'fine-tune-results',
    'assistants',
    'assistants_output',
    'batch',
    'batch_output',
    'vision',
    'user_data',
  ]),
});

// ==
// ==
// Register Routes
// ==

export async function registerFilesRoutes(server: FastifyInstance): Promise<void> {
  const filesService = new FilesService();

  // POST /v1/files
  server.post('/v1/files', {
    schema: {
      tags: ['Files'],
      summary: 'Upload file',
      description: 'Uploads a file that can be used for various purposes (fine-tuning, assistants, vision, batch processing, etc.). Files are stored securely in GCS.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      consumes: ['multipart/form-data'],
      body: {
        type: 'object',
        required: ['file', 'purpose'],
        properties: {
          file: { 
            type: 'string', 
            format: 'binary',
            description: 'File to upload (text, image, audio, video, PDF, etc.)',
          },
          purpose: { 
            type: 'string', 
            enum: ['fine-tune', 'fine-tune-results', 'assistants', 'assistants_output', 'batch', 'batch_output', 'vision', 'user_data'],
            description: 'Purpose of the file',
          },
        },
      },
      response: {
        200: {
          description: 'File uploaded successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'File ID' },
            object: { type: 'string', enum: ['file'], description: 'Object type' },
            bytes: { type: 'integer', description: 'File size in bytes' },
            created_at: { type: 'integer', description: 'Unix timestamp of file creation' },
            filename: { type: 'string', description: 'Original filename' },
            purpose: { type: 'string', enum: ['fine-tune', 'fine-tune-results', 'assistants', 'assistants_output', 'batch', 'batch_output', 'vision', 'user_data'], description: 'Purpose of the file' },
            status: { type: 'string', enum: ['uploaded', 'processed', 'error'], description: 'File processing status' },
            status_details: { type: 'string', nullable: true, description: 'Additional status information' },
          },
        },
        400: {
          description: 'Bad request (missing file or purpose)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "missing_file", "missing_purpose", "invalid_file_format")' },
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
          description: 'Resource not found (e.g., storage service unavailable)',
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
      const requestId = request.id;
      const userContext = getUserContext(request);

      log.info({ requestId }, 'File upload request received');

      try {
        // Parse multipart form data
        // Note: Requires @fastify/multipart plugin
        const data = await (request as { file?: () => Promise<{ filename: string; toBuffer: () => Promise<Buffer>; fields: Record<string, { value?: string }> }> }).file?.();
        if (!data) {
          return reply.code(400).send({
            error: {
              message: 'No file provided',
              type: 'invalid_request_error',
              code: 'missing_file',
            },
          });
        }

        const fileBuffer = await data.toBuffer();
        const filename = data.filename;
        const fields = data.fields as Record<string, { value?: string }>;
        const purpose = fields.purpose?.value;

        if (!purpose) {
          return reply.code(400).send({
            error: {
              message: 'Purpose is required',
              type: 'invalid_request_error',
              code: 'missing_purpose',
            },
          });
        }

        log.info({ requestId, filename, purpose, size: fileBuffer.length }, 'File upload processing started');

        const headerIdempotencyKey =
          getHeaderValue(request.headers['idempotency-key']) ??
          getHeaderValue(request.headers['x-idempotency-key']);
        const idempotencyKey =
          headerIdempotencyKey ??
          buildUploadIdempotencyKey(
            requestId,
            userContext.organizationId,
            userContext.userId || '',
            purpose,
            filename,
            fileBuffer
          );

        // Upload file via files service
        const result = await executeRouteWithRetry(
          () =>
            filesService.uploadFile({
              fileBuffer,
              filename,
              purpose,
              userContext,
              requestId,
              idempotencyKey,
            }),
          {
            operationName: 'POST /v1/files upload',
            requestId,
            log,
            isIdempotent: true,
            maxAttempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 1500,
          }
        );

        return reply.send({
          id: result.id,
          object: 'file',
          bytes: result.bytes,
          created_at: result.created_at,
          filename: result.filename,
          purpose: result.purpose,
          status: result.status,
          status_details: result.status_details,
        });
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'Unknown error';
        const statusCode = extractStatusCode(error) ?? 500;
        const errorType = extractErrorType(error) ?? 'file_upload_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'internal_error';
        
        log.error({ requestId, error: errorMessage }, 'File upload failed');
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

  // GET /v1/files
  server.get('/v1/files', {
    schema: {
      tags: ['Files'],
      summary: 'List files',
      description: 'Returns a paginated list of files that belong to the user\'s organization. Supports filtering by purpose and cursor-based pagination. Use this endpoint to browse uploaded files for fine-tuning, assistants, batch processing, or vision tasks.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      querystring: {
        type: 'object',
        required: [],
        properties: {
          purpose: { 
            type: 'string',
            description: 'Filter files by purpose (e.g., "assistants", "fine-tune", "batch")',
          },
          limit: { 
            type: 'integer', 
            minimum: 1, 
            maximum: 100, 
            default: 20,
            description: 'Number of files to return (1-100, default: 20)',
          },
          after: { 
            type: 'string',
            description: 'Cursor for pagination (after this file ID)',
          },
          before: { 
            type: 'string',
            description: 'Cursor for pagination (before this file ID)',
          },
        },
      },
      response: {
        200: {
          description: 'Files listed successfully',
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'], description: 'Object type identifier' },
            data: {
              type: 'array',
              description: 'Array of file objects',
              items: {
                type: 'object',
                description: 'File object containing metadata and status',
                properties: {
                  id: { type: 'string', description: 'Unique file ID' },
                  object: { type: 'string', enum: ['file'], description: 'Object type identifier' },
                  bytes: { type: 'integer', description: 'File size in bytes' },
                  created_at: { type: 'integer', description: 'Unix timestamp when the file was uploaded' },
                  filename: { type: 'string', description: 'Original filename as uploaded' },
                  purpose: { type: 'string', description: 'File purpose: assistants (for RAG/vector stores), fine-tune (for fine-tuning jobs), batch (for batch processing)' },
                  status: { type: 'string', description: 'File processing status: uploaded (file received), processing (being processed), processed (ready for use), error (processing failed)' },
                  status_details: { type: 'string', nullable: true, description: 'Detailed status information (error messages if status is error, processing progress, validation results, etc.)' },
                },
              },
            },
            has_more: { type: 'boolean', description: 'Whether there are more files available beyond this page (true if additional pages exist)' },
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
    handler: async (request: FastifyRequest<{ Querystring: { purpose?: string; limit?: number; after?: string; before?: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const userContext = getUserContext(request);
      const { purpose, limit = 20, after, before } = request.query;

      log.info({ requestId, purpose, limit }, 'List files request received');

      try {
        const result = await filesService.listFiles({
          purpose,
          limit,
          after,
          before,
          userContext,
          requestId,
        });

        return reply.send({
          object: 'list',
          data: result.files,
          has_more: result.has_more,
        });
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'Unknown error';
        const statusCode = extractStatusCode(error) ?? 500;
        const errorType = extractErrorType(error) ?? 'file_list_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'internal_error';
        
        log.error({ requestId, error: errorMessage }, 'List files failed');
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

  // GET /v1/files/{file_id}
  server.get('/v1/files/:file_id', {
    schema: {
      tags: ['Files'],
      summary: 'Retrieve file metadata',
      description: 'Returns detailed information about a specific file, including size, purpose, processing status, and metadata. Use this endpoint to check file upload status and retrieve file details before using it with assistants or fine-tuning jobs.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['file_id'],
        properties: {
          file_id: { type: 'string', description: 'The ID of the file to retrieve' },
        },
      },
      response: {
        200: {
          description: 'File metadata retrieved successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'File ID' },
            object: { type: 'string', enum: ['file'], description: 'Object type' },
            bytes: { type: 'integer', description: 'File size in bytes' },
            created_at: { type: 'integer', description: 'Unix timestamp of file creation' },
            filename: { type: 'string', description: 'Original filename' },
            purpose: { type: 'string', description: 'Purpose of the file' },
            status: { type: 'string', description: 'File processing status' },
            status_details: { type: 'string', nullable: true, description: 'Additional status information (error messages, processing details, validation results, etc.)' },
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
          description: 'File not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the file was not found' },
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
    handler: async (request: FastifyRequest<{ Params: { file_id: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const userContext = getUserContext(request);
      const { file_id } = request.params;

      log.info({ requestId, file_id }, 'Get file request received');

      try {
        const result = await filesService.getFile({
          fileId: file_id,
          userContext,
          requestId,
        });

        return reply.send({
          id: result.id,
          object: 'file',
          bytes: result.bytes,
          created_at: result.created_at,
          filename: result.filename,
          purpose: result.purpose,
          status: result.status,
          status_details: result.status_details,
        });
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'Unknown error';
        const statusCode = extractStatusCode(error) ?? 404;
        const errorType = extractErrorType(error) ?? 'file_not_found_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'not_found';
        
        log.error({ requestId, file_id, error: errorMessage }, 'Get file failed');
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

  // DELETE /v1/files/{file_id}
  server.delete('/v1/files/:file_id', {
    schema: {
      tags: ['Files'],
      summary: 'Delete file',
      description: 'Permanently delete a file from the system. This action cannot be undone. The file will be removed from all associated assistants and vector stores. File ID will no longer be valid after deletion.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['file_id'],
        properties: {
          file_id: { type: 'string', description: 'The ID of the file to delete' },
        },
      },
      response: {
        200: {
          description: 'File deleted successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'File ID' },
            object: { type: 'string', enum: ['file'], description: 'Object type' },
            deleted: { type: 'boolean', description: 'Whether the file was deleted' },
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
          description: 'File not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the file was not found' },
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
    handler: async (request: FastifyRequest<{ Params: { file_id: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const userContext = getUserContext(request);
      const { file_id } = request.params;

      log.info({ requestId, file_id }, 'Delete file request received');

      try {
        const result = await filesService.deleteFile({
          fileId: file_id,
          userContext,
          requestId,
        });

        return reply.send({
          id: file_id,
          object: 'file',
          deleted: result.deleted,
        });
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'Unknown error';
        const statusCode = extractStatusCode(error) ?? 404;
        const errorType = extractErrorType(error) ?? 'file_not_found_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'not_found';
        
        log.error({ requestId, file_id, error: errorMessage }, 'Delete file failed');
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

  // GET /v1/files/{file_id}/content
  server.get('/v1/files/:file_id/content', {
    schema: {
      tags: ['Files'],
      summary: 'Retrieve file content',
      description: 'Downloads and returns the binary content of a specific file. The response includes appropriate Content-Type and Content-Disposition headers for file download. Use this endpoint to retrieve the actual file data after uploading.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['file_id'],
        properties: {
          file_id: { type: 'string', description: 'The ID of the file to retrieve content from' },
        },
      },
      response: {
        200: {
          description: 'File content retrieved successfully (returns binary content with appropriate Content-Type header)',
          type: 'string',
          format: 'binary',
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
          description: 'File not found',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the file was not found' },
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
    handler: async (request: FastifyRequest<{ Params: { file_id: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const userContext = getUserContext(request);
      const { file_id } = request.params;

      log.info({ requestId, file_id }, 'Get file content request received');

      try {
        const result = await filesService.getFileContent({
          fileId: file_id,
          userContext,
          requestId,
        });

        // Set appropriate content type
        reply.header('Content-Type', result.contentType);
        reply.header('Content-Disposition', `attachment; filename="${result.filename}"`);

        return reply.send(result.content);
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'Unknown error';
        const statusCode = extractStatusCode(error) ?? 404;
        const errorType = extractErrorType(error) ?? 'file_not_found_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'not_found';
        
        log.error({ requestId, file_id, error: errorMessage }, 'Get file content failed');
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

  log.info('Files API routes registered successfully');
}

