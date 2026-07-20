// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Codebase Analysis Routes
 * 
 * Endpoints for code analysis integration with CLI:
 * - Symbol storage and retrieval
 * - Dependency tracking
 * - Semantic search
 * - Incremental indexing
 */

import type { FastifyInstance } from 'fastify';
import { authenticate } from '@/middleware/auth-middleware';
import {
  requireTenantContext,
  getTenantContext,
} from '@/api/middleware/tenant-isolation-middleware';
import { logger } from '@/utils/logger';
import { ValidationError } from '@/utils/custom-errors';
import {
  syncCodeAnalysis,
  semanticSearch,
  findSymbolReferences,
  getDependencyGraph,
  getFileSymbols,
  getCheckpointStatus,
  getProjectStats,
  type AnalysisSyncRequest,
  type SemanticSearchOptions as _SemanticSearchOptions,
} from '@/services/code-analysis-service';

const log = logger.child({ component: 'codebase-analysis-routes' });

interface _ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export async function registerCodebaseAnalysisRoutes(server: FastifyInstance): Promise<void> {
  /**
   * POST /v1/codebase/analysis
   * Sync code analysis results from CLI (symbols, dependencies)
   */
  server.post<{
    Body: AnalysisSyncRequest;
  }>(
    '/v1/codebase/analysis',
    {
      schema: {
        tags: ['Codebase Analysis'],
        summary: 'Sync code analysis from CLI',
        description: 'Upload symbols and dependencies extracted by CLI Tree-sitter parser',
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
                        type: { 
                          type: 'string',
                          enum: ['function', 'class', 'variable', 'method', 'interface', 'enum', 'constant', 'type', 'import', 'export']
                        },
                        kind: { type: 'string' },
                        startLine: { type: 'integer' },
                        endLine: { type: 'integer' },
                        startColumn: { type: 'integer' },
                        endColumn: { type: 'integer' },
                        signature: { type: 'string' },
                        documentation: { type: 'string' },
                        visibility: { type: 'string', enum: ['public', 'private', 'protected', 'internal'] },
                        isAsync: { type: 'boolean' },
                        isStatic: { type: 'boolean' },
                        isExported: { type: 'boolean' },
                        metadata: { type: 'object' },
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
                        dependencyType: {
                          type: 'string',
                          enum: ['import', 'export', 'call', 'inherit', 'implement', 'reference', 'type_reference']
                        },
                        importPath: { type: 'string' },
                        isExternal: { type: 'boolean' },
                        isDynamic: { type: 'boolean' },
                        metadata: { type: 'object' },
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
        const response = await syncCodeAnalysis(tenantContext.organizationId, request.body);
        return reply.send(response);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // ValidationError → 400 (caller can fix the payload). Anything else → 500.
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
   * POST /v1/search/semantic
   * Enhanced semantic search across codebase
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
    '/v1/search/semantic',
    {
      schema: {
        tags: ['Codebase Analysis'],
        summary: 'Semantic search across codebase',
        description: 'Search using full-text and trigram matching for both content and symbols',
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
        const results = await semanticSearch({
          organizationId: tenantContext.organizationId,
          projectId: request.body.projectId,
          branch: request.body.branch,
          query: request.body.query,
          limit: request.body.limit,
          includeSymbols: request.body.includeSymbols,
          includeContent: request.body.includeContent,
          symbolTypes: request.body.symbolTypes,
        });

        return reply.send({
          query: request.body.query,
          totalResults: results.length,
          results,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Semantic search failed');
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
   * GET /v1/codebase/symbols
   * Get symbols for a file
   */
  server.get<{
    Querystring: {
      projectId: string;
      filePath: string;
      branch?: string;
    };
  }>(
    '/v1/codebase/symbols',
    {
      schema: {
        tags: ['Codebase Analysis'],
        summary: 'Get symbols for a file',
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
        const symbols = await getFileSymbols(
          tenantContext.organizationId,
          request.query.projectId,
          request.query.filePath,
          request.query.branch
        );

        return reply.send({
          filePath: request.query.filePath,
          symbolCount: symbols.length,
          symbols,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Failed to get file symbols');
        return reply.status(500).send({
          error: {
            code: 'get_symbols_failed',
            message: errorMessage,
          },
        });
      }
    }
  );

  /**
   * GET /v1/codebase/references
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
    '/v1/codebase/references',
    {
      schema: {
        tags: ['Codebase Analysis'],
        summary: 'Find symbol references',
        description: 'Find all definitions and usages of a symbol across the codebase',
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
        const references = await findSymbolReferences(
          tenantContext.organizationId,
          request.query.projectId,
          request.query.symbolName,
          request.query.symbolType,
          request.query.branch
        );

        return reply.send({
          symbolName: request.query.symbolName,
          referenceCount: references.length,
          references,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Failed to find symbol references');
        return reply.status(500).send({
          error: {
            code: 'find_references_failed',
            message: errorMessage,
          },
        });
      }
    }
  );

  /**
   * GET /v1/codebase/dependencies
   * Get dependency graph
   */
  server.get<{
    Querystring: {
      projectId: string;
      filePath?: string;
      depth?: number;
      branch?: string;
    };
  }>(
    '/v1/codebase/dependencies',
    {
      schema: {
        tags: ['Codebase Analysis'],
        summary: 'Get dependency graph',
        description: 'Get import/export dependency graph for project or specific file',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        querystring: {
          type: 'object',
          required: ['projectId'],
          properties: {
            projectId: { type: 'string' },
            filePath: { type: 'string' },
            depth: { type: 'integer', minimum: 1, maximum: 10, default: 2 },
            branch: { type: 'string' },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      try {
        const tenantContext = getTenantContext(request);
        const graph = await getDependencyGraph(
          tenantContext.organizationId,
          request.query.projectId,
          request.query.filePath,
          request.query.depth,
          request.query.branch
        );

        return reply.send({
          projectId: request.query.projectId,
          filePath: request.query.filePath,
          depth: request.query.depth || 2,
          nodeCount: graph.length,
          graph,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Failed to get dependency graph');
        return reply.status(500).send({
          error: {
            code: 'get_dependencies_failed',
            message: errorMessage,
          },
        });
      }
    }
  );

  /**
   * GET /v1/codebase/checkpoint
   * Get checkpoint status for incremental indexing
   */
  server.get<{
    Querystring: {
      projectId: string;
      branch?: string;
    };
  }>(
    '/v1/codebase/checkpoint',
    {
      schema: {
        tags: ['Codebase Analysis'],
        summary: 'Get checkpoint status',
        description: 'Get indexing checkpoint for incremental sync',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        querystring: {
          type: 'object',
          required: ['projectId'],
          properties: {
            projectId: { type: 'string' },
            branch: { type: 'string' },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      try {
        const tenantContext = getTenantContext(request);
        const status = await getCheckpointStatus(
          tenantContext.organizationId,
          request.query.projectId,
          request.query.branch
        );

        if (!status) {
          return reply.status(404).send({
            error: {
              code: 'project_not_found',
              message: 'Project not found',
            },
          });
        }

        return reply.send(status);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Failed to get checkpoint status');
        return reply.status(500).send({
          error: {
            code: 'get_checkpoint_failed',
            message: errorMessage,
          },
        });
      }
    }
  );

  /**
   * GET /v1/codebase/stats
   * Get project statistics
   */
  server.get<{
    Querystring: {
      projectId: string;
      branch?: string;
    };
  }>(
    '/v1/codebase/stats',
    {
      schema: {
        tags: ['Codebase Analysis'],
        summary: 'Get project statistics',
        description: 'Get file, symbol, and dependency counts with distributions',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        querystring: {
          type: 'object',
          required: ['projectId'],
          properties: {
            projectId: { type: 'string' },
            branch: { type: 'string' },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      try {
        const tenantContext = getTenantContext(request);
        const stats = await getProjectStats(
          tenantContext.organizationId,
          request.query.projectId,
          request.query.branch
        );

        if (!stats) {
          return reply.status(404).send({
            error: {
              code: 'project_not_found',
              message: 'Project not found',
            },
          });
        }

        return reply.send(stats);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Failed to get project stats');
        return reply.status(500).send({
          error: {
            code: 'get_stats_failed',
            message: errorMessage,
          },
        });
      }
    }
  );
}

