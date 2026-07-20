// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Orchestration Routes
 * Lists available orchestration strategies and their configuration
 */

import type { FastifyInstance } from 'fastify';
import { authenticate } from '@/middleware/auth-middleware';
import { getOrchestrationEngine } from '@/core/orchestration/orchestration-engine';

export async function registerOrchestrationRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /v1/orchestration/strategies
   * List all available orchestration strategies
   */
  server.get(
    '/v1/orchestration/strategies',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Orchestration'],
        summary: 'List orchestration strategies',
        description: 'Returns a list of all available orchestration strategies with their descriptions and capabilities',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              strategies: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    displayName: { type: 'string' },
                    description: { type: 'string' },
                    aliases: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    executionStrategy: { type: 'string' },
                    useCases: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    costProfile: {
                      type: 'string',
                      enum: ['low', 'medium', 'high', 'variable'],
                    },
                    qualityProfile: {
                      type: 'string',
                      enum: ['balanced', 'speed', 'quality'],
                    },
                    modelsUsed: {
                      type: 'string',
                      enum: ['single', 'multiple', 'variable'],
                    },
                  },
                },
              },
              defaultStrategy: { type: 'string' },
            },
          },
          500: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const engine = getOrchestrationEngine();
        const registeredStrategies = new Set(
          engine.getAvailableStrategies().map((strategy) => strategy.name)
        );

        // Strategy metadata
        const strategies = [
          {
            name: 'single',
            displayName: 'Single Model',
            description: 'Uses a single model for the request. Fast and cost-effective for simple tasks.',
            aliases: [],
            executionStrategy: 'single',
            useCases: ['Simple Q&A', 'Basic text generation', 'Low latency requirements'],
            costProfile: 'low',
            qualityProfile: 'balanced',
            modelsUsed: 'single',
          },
          {
            name: 'cost',
            displayName: 'Cost Optimized',
            description: 'Prioritizes lower cost models with graceful escalation when needed.',
            aliases: [],
            executionStrategy: 'cost-cascade',
            useCases: ['Budget-sensitive workloads', 'Batch operations', 'High volume requests'],
            costProfile: 'low',
            qualityProfile: 'balanced',
            modelsUsed: 'variable',
          },
          {
            name: 'speed',
            displayName: 'Speed Optimized',
            description: 'Prioritizes low-latency execution with minimal orchestration overhead.',
            aliases: [],
            executionStrategy: 'single',
            useCases: ['Interactive UX', 'Low latency requirements', 'Realtime chat'],
            costProfile: 'low',
            qualityProfile: 'speed',
            modelsUsed: 'single',
          },
          {
            name: 'quality',
            displayName: 'Quality Optimized',
            description: 'Executes additional refinement passes to maximize answer quality.',
            aliases: [],
            executionStrategy: 'quality-multipass',
            useCases: ['Critical reasoning', 'Long-form quality', 'High confidence responses'],
            costProfile: 'high',
            qualityProfile: 'quality',
            modelsUsed: 'multiple',
          },
          {
            name: 'balanced',
            displayName: 'Balanced',
            description: 'Balances quality, cost, and speed across orchestration signals.',
            aliases: [],
            executionStrategy: 'hybrid',
            useCases: ['General purpose', 'Mixed workloads', 'Default production traffic'],
            costProfile: 'medium',
            qualityProfile: 'balanced',
            modelsUsed: 'multiple',
          },
          {
            name: 'parallel',
            displayName: 'Parallel',
            description: 'Sends the request to multiple models simultaneously and returns the first response.',
            aliases: [],
            executionStrategy: 'parallel',
            useCases: ['High availability', 'Latency optimization', 'Fault tolerance'],
            costProfile: 'medium',
            qualityProfile: 'balanced',
            modelsUsed: 'multiple',
          },
          {
            name: 'quality_multipass',
            displayName: 'Quality Multi-Pass',
            description: 'Multiple refinement passes for highest quality.',
            aliases: ['quality-multi-pass', 'quality-multipass'],
            executionStrategy: 'quality-multipass',
            useCases: ['High quality requirements', 'Complex reasoning', 'Final drafts'],
            costProfile: 'high',
            qualityProfile: 'quality',
            modelsUsed: 'multiple',
          },
          {
            name: 'debate',
            displayName: 'Debate',
            description: 'Multi-turn debate between models before synthesis.',
            aliases: [],
            executionStrategy: 'debate',
            useCases: ['Counterfactual analysis', 'Critical decision support', 'High-stakes reasoning'],
            costProfile: 'high',
            qualityProfile: 'quality',
            modelsUsed: 'multiple',
          },
          {
            name: 'dynamic',
            displayName: 'Dynamic Selection',
            description: 'Automatically selects the best orchestration strategy and model path.',
            aliases: ['auto'],
            executionStrategy: 'auto',
            useCases: ['Adaptive routing', 'Default behavior', 'Heterogeneous workloads'],
            costProfile: 'variable',
            qualityProfile: 'balanced',
            modelsUsed: 'variable',
          },
        ];

        const filteredStrategies = strategies.filter((strategy) =>
          registeredStrategies.has(strategy.executionStrategy)
        );

        return reply.send({
          strategies: filteredStrategies,
          defaultStrategy: 'dynamic',
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Failed to list orchestration strategies');
        return reply.code(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );
}

