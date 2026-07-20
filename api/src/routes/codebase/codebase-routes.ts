// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { FastifyInstance } from 'fastify';
import { authenticate } from '@/middleware/auth-middleware';
import {
  requireTenantContext,
  getTenantContext,
} from '@/api/middleware/tenant-isolation-middleware';
import { logger } from '@/utils/logger';
import { searchCodebase, syncCodebaseChunk } from '@/services/codebase-service';
import {
  syncCodeAnalysis,
  semanticSearch,
  findSymbolReferences,
  getFileSymbols,
  type AnalysisSyncRequest,
} from '@/services/code-analysis-service';
import type { CodebaseSearchResponse, CodebaseSyncRequest } from '@/types';
import { ValidationError } from '@/utils/custom-errors';

const log = logger.child({ component: 'codebase-routes' });

interface SearchBody {
  projectId: string;
  branch?: string;
  query: string;
  limit?: number;
  fileTypes?: string[];
  includeContext?: boolean;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export async function registerCodebaseRoutes(server: FastifyInstance): Promise<void> {
  server.post<{
    Body: CodebaseSyncRequest;
  }>(
    '/v1/codebase/sync',
    {
      schema: {
        tags: ['Codebase'],
        summary: 'Synchronize codebase chunk',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: [
            'projectId',
            'rootPath',
            'files',
            'sequence',
            'totalSequences',
            'isFinalChunk',
          ],
          properties: {
            projectId: { type: 'string' },
            rootPath: { type: 'string' },
            branch: { type: 'string' },
            commitSha: { type: 'string' },
            sequence: { type: 'integer', minimum: 1 },
            totalSequences: { type: 'integer', minimum: 1 },
            isFinalChunk: { type: 'boolean' },
            files: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['path', 'size', 'checksum', 'lastModified'],
                properties: {
                  path: { type: 'string' },
                  size: { type: 'integer', minimum: 0 },
                  checksum: { type: 'string' },
                  lastModified: { type: 'integer' },
                  language: { type: 'string' },
                  content: { type: 'string' },
                  encoding: { type: 'string', enum: ['utf-8', 'base64'] },
                  executable: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      try {
        const tenantContext = getTenantContext(request);
        const organizationId = tenantContext.organizationId;

        const response = await syncCodebaseChunk(organizationId, request.body);
        return reply.send(response);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Failed to process codebase sync');
        return reply.status(500).send({
          error: {
            code: 'codebase_sync_failed',
            message: errorMessage,
          },
        });
      }
    }
  );

  server.post<{
    Body: SearchBody;
    Reply: CodebaseSearchResponse | ErrorResponse;
  }>(
    '/v1/search/codebase',
    {
      schema: {
        tags: ['Codebase'],
        summary: 'Search codebase',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['projectId', 'query'],
          properties: {
            projectId: { type: 'string' },
            branch: { type: 'string' },
            query: { type: 'string', minLength: 2 },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            fileTypes: {
              type: 'array',
              items: { type: 'string' },
            },
            includeContext: { type: 'boolean' },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      try {
        const tenantContext = getTenantContext(request);
        const organizationId = tenantContext.organizationId;

        const response = await searchCodebase({
          organizationId,
          projectExternalId: request.body.projectId,
          branch: request.body.branch,
          query: request.body.query,
          limit: request.body.limit,
          fileTypes: request.body.fileTypes,
          includeContext: request.body.includeContext,
        });

        return reply.send(response);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Failed to execute codebase search');
        return reply.status(500).send({
          error: {
            code: 'codebase_search_failed',
            message: errorMessage,
          },
        });
      }
    }
  );

  // ============================================
  // Code Analysis Routes (Symbol-based)
  // ============================================

  /**
   * Sync code analysis results (symbols, dependencies) from CLI
   */
  server.post<{
    Body: AnalysisSyncRequest;
  }>(
    '/v1/codebase/analysis/sync',
    {
      schema: {
        tags: ['Codebase'],
        summary: 'Sync code analysis results (symbols, dependencies)',
        description: 'Receives parsed symbols and dependencies from CLI Tree-sitter analysis',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['projectId', 'files', 'isIncremental'],
          properties: {
            projectId: { type: 'string' },
            branch: { type: 'string' },
            commitSha: { type: 'string' },
            isIncremental: { type: 'boolean' },
            previousChecksum: { type: 'string' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                required: ['filePath', 'symbols', 'dependencies', 'checksum', 'lineCount'],
                properties: {
                  filePath: { type: 'string' },
                  checksum: { type: 'string' },
                  lineCount: { type: 'integer' },
                  symbols: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['name', 'type', 'startLine', 'endLine'],
                      properties: {
                        name: { type: 'string' },
                        qualifiedName: { type: 'string' },
                        type: { type: 'string' },
                        kind: { type: 'string' },
                        startLine: { type: 'integer' },
                        endLine: { type: 'integer' },
                        startColumn: { type: 'integer' },
                        endColumn: { type: 'integer' },
                        signature: { type: 'string' },
                        documentation: { type: 'string' },
                        visibility: { type: 'string' },
                        isAsync: { type: 'boolean' },
                        isStatic: { type: 'boolean' },
                        isExported: { type: 'boolean' },
                      },
                    },
                  },
                  dependencies: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['sourceFilePath', 'dependencyType'],
                      properties: {
                        sourceFilePath: { type: 'string' },
                        targetFilePath: { type: 'string' },
                        sourceSymbolName: { type: 'string' },
                        targetSymbolName: { type: 'string' },
                        dependencyType: { type: 'string' },
                        importPath: { type: 'string' },
                        isExternal: { type: 'boolean' },
                        isDynamic: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      try {
        const tenantContext = getTenantContext(request);
        const organizationId = tenantContext.organizationId;

        const response = await syncCodeAnalysis(organizationId, request.body);
        return reply.send(response);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // ValidationError → 400 with the specific field errors so callers can
        // fix the payload. Anything else → 500.
        if (error instanceof ValidationError) {
          log.warn({ error: errorMessage, details: error.details }, 'Invalid code analysis payload');
          return reply.status(400).send({
            error: {
              code: error.code ?? 'validation_error',
              message: errorMessage,
              details: error.details,
            },
          });
        }
        log.error({ error: errorMessage }, 'Failed to sync code analysis');
        return reply.status(500).send({
          error: {
            code: 'analysis_sync_failed',
            message: errorMessage,
          },
        });
      }
    }
  );

  /**
   * Semantic search across codebase (symbols + content)
   */
  server.post<{
    Body: {
      projectId: string;
      branch?: string;
      query: string;
      limit?: number;
      includeSymbols?: boolean;
      includeContent?: boolean;
      symbolTypes?: string[];
    };
  }>(
    '/v1/codebase/search/semantic',
    {
      schema: {
        tags: ['Codebase'],
        summary: 'Semantic search across codebase',
        description: 'Search symbols, content, and dependencies with semantic understanding',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['projectId', 'query'],
          properties: {
            projectId: { type: 'string' },
            branch: { type: 'string' },
            query: { type: 'string', minLength: 2 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            includeSymbols: { type: 'boolean', default: true },
            includeContent: { type: 'boolean', default: true },
            symbolTypes: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      try {
        const tenantContext = getTenantContext(request);
        const organizationId = tenantContext.organizationId;

        const results = await semanticSearch({
          organizationId,
          projectId: request.body.projectId,
          branch: request.body.branch,
          query: request.body.query,
          limit: request.body.limit,
          includeSymbols: request.body.includeSymbols,
          includeContent: request.body.includeContent,
          symbolTypes: request.body.symbolTypes,
        });

        return reply.send({ results });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Failed to execute semantic search');
        return reply.status(500).send({
          error: {
            code: 'semantic_search_failed',
            message: errorMessage,
          },
        });
      }
    }
  );

  /**
   * Find all references to a symbol
   */
  server.get<{
    Querystring: {
      projectId: string;
      symbolName: string;
      symbolType?: string;
      branch?: string;
    };
  }>(
    '/v1/codebase/symbols/references',
    {
      schema: {
        tags: ['Codebase'],
        summary: 'Find all references to a symbol',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        querystring: {
          type: 'object',
          required: ['projectId', 'symbolName'],
          properties: {
            projectId: { type: 'string' },
            symbolName: { type: 'string' },
            symbolType: { type: 'string' },
            branch: { type: 'string' },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      try {
        const tenantContext = getTenantContext(request);
        const organizationId = tenantContext.organizationId;

        const references = await findSymbolReferences(
          organizationId,
          request.query.projectId,
          request.query.symbolName,
          request.query.symbolType,
          request.query.branch
        );

        return reply.send({ references });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Failed to find symbol references');
        return reply.status(500).send({
          error: {
            code: 'symbol_references_failed',
            message: errorMessage,
          },
        });
      }
    }
  );

  /**
   * Get symbols for a specific file
   */
  server.get<{
    Querystring: {
      projectId: string;
      filePath: string;
      branch?: string;
    };
  }>(
    '/v1/codebase/files/symbols',
    {
      schema: {
        tags: ['Codebase'],
        summary: 'Get symbols for a specific file',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        querystring: {
          type: 'object',
          required: ['projectId', 'filePath'],
          properties: {
            projectId: { type: 'string' },
            filePath: { type: 'string' },
            branch: { type: 'string' },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      try {
        const tenantContext = getTenantContext(request);
        const organizationId = tenantContext.organizationId;

        const symbols = await getFileSymbols(
          organizationId,
          request.query.projectId,
          request.query.filePath,
          request.query.branch
        );

        return reply.send({ symbols });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Failed to get file symbols');
        return reply.status(500).send({
          error: {
            code: 'file_symbols_failed',
            message: errorMessage,
          },
        });
      }
    }
  );
}
