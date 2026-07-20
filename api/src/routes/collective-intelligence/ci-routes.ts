// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Collective Intelligence Routes
 *
 * API endpoints for Collective Intelligence features:
 * - Semantic Memory (Vector Store)
 * - Agentic Workflows
 * - Reasoning Transparency
 * - Self-Critique
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSemanticMemoryStore, type MemoryType } from '@/core/memory/semantic-memory-store';
import { getAgenticWorkflowEngine, type WorkflowDefinition } from '@/core/agentic/agentic-workflow-engine';
import { getReasoningTransparency } from '@/core/transparency/reasoning-transparency';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { getLearningScopeConfig } from '@/config/learning-scope';

const log = logger.child({ component: 'ci-routes' });

// Helper to extract user context from request
function getUserContext(request: FastifyRequest): { organizationId: string; userId?: string } {
  const extendedRequest = request as ExtendedFastifyRequest;
  return {
    organizationId: extendedRequest.organizationId || '',
    userId: extendedRequest.userId,
  };
}

// ============================================
// Semantic Memory Routes
// ============================================

interface StoreMemoryBody {
  content: string;
  type?: MemoryType;
  metadata?: Record<string, unknown>;
  importance?: number;
  ttlDays?: number;
}

interface SearchMemoryBody {
  query: string;
  type?: MemoryType;
  limit?: number;
  minSimilarity?: number;
}

// ============================================
// Agentic Workflow Routes
// ============================================

interface CreateWorkflowBody {
  task: string;
  tools?: Array<{ name: string; description: string }>;
}

interface ExecuteWorkflowBody {
  workflowId?: string;
  workflow?: WorkflowDefinition;
  input?: Record<string, unknown>;
}

// ============================================
// Route Registration
// ============================================

export async function registerCollectiveIntelligenceRoutes(
  server: FastifyInstance
): Promise<void> {
  const authenticatedServer = server as FastifyInstance & {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  };

  /**
   * Learning scope and guardrails
   * GET /v1/collective-intelligence/learning-scope
   */
  server.get(
    '/v1/collective-intelligence/learning-scope',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Returns active collective learning scope and guardrails',
        tags: ['Collective Intelligence'],
        response: {
          200: {
            type: 'object',
            properties: {
              mode: { type: 'string' },
              localModelTrainingEnabled: { type: 'boolean' },
              offlineReflectionEnabled: { type: 'boolean' },
              offlineReflectionCron: { type: 'string' },
              optimizeRoutingEnabled: { type: 'boolean' },
              semanticMemoryEnabled: { type: 'boolean' },
              notes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userContext = getUserContext(request);

      if (!userContext.organizationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      return reply.send(getLearningScopeConfig());
    }
  );

  // ==========================================
  // SEMANTIC MEMORY ROUTES
  // ==========================================

  /**
   * Store a new memory
   * POST /v1/memory
   */
  server.post<{
    Body: StoreMemoryBody;
  }>(
    '/v1/memory',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Store a new semantic memory',
        tags: ['Collective Intelligence'],
        body: {
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string', description: 'Memory content to store' },
            type: { 
              type: 'string', 
              enum: ['episodic', 'semantic', 'procedural'],
              default: 'semantic'
            },
            metadata: { type: 'object', description: 'Additional metadata' },
            importance: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
            ttlDays: { type: 'number', minimum: 1, default: 90 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              createdAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: StoreMemoryBody }>, reply: FastifyReply) => {
      const { content, type = 'semantic', metadata, importance, ttlDays } = request.body;
      const userContext = getUserContext(request);

      if (!userContext.organizationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
        const memoryStore = getSemanticMemoryStore();
        const memory = await memoryStore.store({
          organizationId: userContext.organizationId,
          userId: userContext.userId,
          type,
          content,
          metadata,
          importance,
          ttlDays,
        });

        log.info({ memoryId: memory.id }, 'Memory stored via API');

        return reply.send({
          id: memory.id,
          type: memory.type,
          createdAt: memory.createdAt.toISOString(),
        });
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to store memory');
        return reply.status(500).send({ error: 'Failed to store memory' });
      }
    }
  );

  /**
   * Search memories
   * POST /v1/memory/search
   */
  server.post<{
    Body: SearchMemoryBody;
  }>(
    '/v1/memory/search',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Search semantic memories by similarity',
        tags: ['Collective Intelligence'],
        body: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Search query' },
            type: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] },
            limit: { type: 'number', minimum: 1, maximum: 100, default: 10 },
            minSimilarity: { type: 'number', minimum: 0, maximum: 1, default: 0.7 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    content: { type: 'string' },
                    type: { type: 'string' },
                    similarity: { type: 'number' },
                    relevanceScore: { type: 'number' },
                    metadata: { type: 'object' },
                  },
                },
              },
              count: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: SearchMemoryBody }>, reply: FastifyReply) => {
      const { query, type, limit = 10, minSimilarity = 0.7 } = request.body;
      const userContext = getUserContext(request);

      if (!userContext.organizationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
        const memoryStore = getSemanticMemoryStore();
        const results = await memoryStore.search({
          organizationId: userContext.organizationId,
          query,
          type,
          userId: userContext.userId,
          limit,
          minSimilarity,
        });

        return reply.send({
          results: results.map((r) => ({
            id: r.entry.id,
            content: r.entry.content,
            type: r.entry.type,
            similarity: Number.isFinite(r.similarity) ? r.similarity : 0,
            relevanceScore: Number.isFinite(r.relevanceScore) ? r.relevanceScore : 0,
            metadata: r.entry.metadata,
          })),
          count: results.length,
        });
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to search memories');
        return reply.status(500).send({ error: 'Failed to search memories' });
      }
    }
  );

  /**
   * Get memory statistics
   * GET /v1/memory/stats
   */
  server.get(
    '/v1/memory/stats',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Get semantic memory statistics for organization',
        tags: ['Collective Intelligence'],
        response: {
          200: {
            type: 'object',
            properties: {
              total: { type: 'number' },
              byType: { type: 'object' },
              avgImportance: { type: 'number' },
              avgAccessCount: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userContext = getUserContext(request);

      if (!userContext.organizationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
        const memoryStore = getSemanticMemoryStore();
        const stats = await memoryStore.getStats(userContext.organizationId);

        return reply.send(stats);
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to get memory stats');
        return reply.status(500).send({ error: 'Failed to get memory stats' });
      }
    }
  );

  /**
   * Delete a memory
   * DELETE /v1/memory/:memoryId
   */
  server.delete<{
    Params: { memoryId: string };
  }>(
    '/v1/memory/:memoryId',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Delete a semantic memory',
        tags: ['Collective Intelligence'],
        params: {
          type: 'object',
          properties: {
            memoryId: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              deleted: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { memoryId: string } }>, reply: FastifyReply) => {
      const { memoryId } = request.params;
      const userContext = getUserContext(request);

      if (!userContext.organizationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
        const memoryStore = getSemanticMemoryStore();
        const deleted = await memoryStore.delete(memoryId, userContext.organizationId);

        return reply.send({ deleted });
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to delete memory');
        return reply.status(500).send({ error: 'Failed to delete memory' });
      }
    }
  );

  // ==========================================
  // AGENTIC WORKFLOW ROUTES
  // ==========================================

  /**
   * Create workflow from natural language task
   * POST /v1/workflows/create
   */
  server.post<{
    Body: CreateWorkflowBody;
  }>(
    '/v1/workflows/create',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Create an agentic workflow from a natural language task description',
        tags: ['Collective Intelligence'],
        body: {
          type: 'object',
          required: ['task'],
          properties: {
            task: { type: 'string', description: 'Natural language task description' },
            tools: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                },
              },
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              steps: { type: 'array' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateWorkflowBody }>, reply: FastifyReply) => {
      const { task, tools } = request.body;
      const userContext = getUserContext(request);

      if (!userContext.organizationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
        const workflowEngine = getAgenticWorkflowEngine();
        const workflow = await workflowEngine.createWorkflowFromTask({
          task,
          context: {
            organizationId: userContext.organizationId,
            userId: userContext.userId,
            requestId: request.id,
            models: [],
            taskType: 'general',
            contextSize: 0,
          },
          availableTools: tools,
        });

        // Register the workflow for later execution
        workflowEngine.registerWorkflow(workflow);

        log.info({ workflowId: workflow.id, stepCount: workflow.steps.length }, 'Workflow created');

        return reply.send({
          id: workflow.id,
          name: workflow.name,
          description: workflow.description,
          steps: workflow.steps.map((s) => ({
            id: s.id,
            name: s.name,
            type: s.type,
          })),
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        if (errorMessage.includes('No suitable model')) {
          return reply.status(503).send({
            error: {
              code: 'no_suitable_model',
              message: 'No suitable model for workflow planning',
            },
          });
        }
        log.error({ error: errorMessage, requestId: request.id }, 'Failed to create workflow');
        const statusCode =
          error && typeof error === 'object' && 'statusCode' in error && typeof (error as { statusCode?: unknown }).statusCode === 'number'
            ? (error as { statusCode: number }).statusCode
            : 500;
        const code =
          error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'workflow_creation_failed';
        return reply.status(statusCode).send({
          error: {
            code,
            message: errorMessage || 'Failed to create workflow',
            requestId: request.id,
          },
        });
      }
    }
  );

  /**
   * Execute a workflow
   * POST /v1/workflows/execute
   */
  server.post<{
    Body: ExecuteWorkflowBody;
  }>(
    '/v1/workflows/execute',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Execute an agentic workflow',
        tags: ['Collective Intelligence'],
        body: {
          type: 'object',
          properties: {
            workflowId: { type: 'string', description: 'ID of registered workflow to execute' },
            workflow: { type: 'object', description: 'Inline workflow definition' },
            input: { type: 'object', description: 'Input variables for the workflow' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              workflowId: { type: 'string' },
              status: { type: 'string' },
              finalOutput: {},
              totalDuration: { type: 'number' },
              totalCost: { type: 'number' },
              steps: { type: 'array' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: ExecuteWorkflowBody }>, reply: FastifyReply) => {
      const { workflowId, workflow: inlineWorkflow, input } = request.body;
      const userContext = getUserContext(request);

      if (!userContext.organizationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
        const workflowEngine = getAgenticWorkflowEngine();

        // Get workflow from ID or use inline definition
        let workflow: WorkflowDefinition | undefined;
        
        if (workflowId) {
          workflow = workflowEngine.getWorkflow(workflowId);
          if (!workflow) {
            return reply.status(404).send({ error: `Workflow ${workflowId} not found` });
          }
        } else if (inlineWorkflow) {
          workflow = inlineWorkflow;
        } else {
          return reply.status(400).send({ error: 'Either workflowId or workflow must be provided' });
        }

        const result = await workflowEngine.execute({
          workflow,
          input,
          organizationId: userContext.organizationId,
          userId: userContext.userId,
        });

        log.info(
          {
            workflowId: result.workflowId,
            status: result.status,
            duration: result.totalDuration,
          },
          'Workflow executed'
        );

        return reply.send({
          workflowId: result.workflowId,
          status: result.status,
          finalOutput: result.finalOutput,
          totalDuration: result.totalDuration,
          totalCost: result.totalCost,
          steps: result.steps.map((s) => ({
            stepId: s.stepId,
            status: s.status,
            output: s.output,
            error: s.error,
            durationMs: s.durationMs,
          })),
        });
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to execute workflow');
        return reply.status(500).send({ error: 'Failed to execute workflow' });
      }
    }
  );

  // ==========================================
  // REASONING TRANSPARENCY ROUTES
  // ==========================================

  /**
   * Get reasoning trace for a request
   * GET /v1/reasoning/:requestId
   */
  server.get<{
    Params: { requestId: string };
  }>(
    '/v1/reasoning/:requestId',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Get reasoning transparency trace for a request',
        tags: ['Collective Intelligence'],
        params: {
          type: 'object',
          properties: {
            requestId: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              requestId: { type: 'string' },
              timestamp: { type: 'number' },
              summary: { type: 'string' },
              modelSelection: { type: 'object' },
              strategySelection: { type: 'object' },
              execution: { type: 'object' },
              quality: { type: 'object' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { requestId: string } }>, reply: FastifyReply) => {
      const { requestId } = request.params;

      try {
        const transparency = getReasoningTransparency();
        const trace = transparency.getTrace(requestId);

        if (!trace) {
          return reply.status(404).send({ error: `Trace for request ${requestId} not found` });
        }

        return reply.send(trace);
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to get reasoning trace');
        return reply.status(500).send({ error: 'Failed to get reasoning trace' });
      }
    }
  );

  /**
   * Get human-readable explanation for a request
   * GET /v1/reasoning/:requestId/explain
   */
  server.get<{
    Params: { requestId: string };
  }>(
    '/v1/reasoning/:requestId/explain',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Get human-readable explanation of AI decision-making for a request',
        tags: ['Collective Intelligence'],
        params: {
          type: 'object',
          properties: {
            requestId: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              explanation: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { requestId: string } }>, reply: FastifyReply) => {
      const { requestId } = request.params;

      try {
        const transparency = getReasoningTransparency();
        const explanation = transparency.explainDecision(requestId);

        return reply.send({ explanation });
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to explain decision');
        return reply.status(500).send({ error: 'Failed to explain decision' });
      }
    }
  );

  // ==========================================
  // SELF-CRITIQUE ROUTES
  // ==========================================

  /**
   * Get self-critique configuration
   * GET /v1/critique/config
   */
  server.get(
    '/v1/critique/config',
    {
      preHandler: authenticatedServer.authenticate,
      schema: {
        description: 'Get self-critique engine configuration',
        tags: ['Collective Intelligence'],
        response: {
          200: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              mode: { type: 'string' },
              maxIterations: { type: 'number' },
              minQualityThreshold: { type: 'number' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Return default configuration
        return reply.send({
          enabled: true,
          mode: 'same-model',
          maxIterations: 2,
          minQualityThreshold: 0.8,
          includeImprovement: true,
        });
      } catch (error) {
        log.error({ error: getErrorMessage(error) }, 'Failed to get critique config');
        return reply.status(500).send({ error: 'Failed to get critique config' });
      }
    }
  );

  log.info('✅ Collective Intelligence routes registered');
}
