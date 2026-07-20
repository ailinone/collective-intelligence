// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider Health Check Routes
 * Detailed health status for all LLM providers
 */

import type { FastifyInstance } from 'fastify';
import { logger } from '@/utils/logger';
import { providerAvailabilityService } from '@/services/provider-availability-service';
import { getProviderRegistry } from '@/providers/provider-registry';

/**
 * Register provider health check routes
 */
export async function registerProviderHealthRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /v1/health/providers
   * Returns health status of all providers
   */
  server.get(
    '/v1/health/providers',
    {
      schema: {
        tags: ['Health'],
        description: 'Detailed health status of all LLM providers',
        response: {
          200: {
            type: 'object',
            properties: {
              timestamp: { type: 'string' },
              totalProviders: { type: 'number' },
              available: { type: 'number' },
              degraded: { type: 'number' },
              unavailable: { type: 'number' },
              providers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    status: { type: 'string' },
                    reason: { type: 'string' },
                    lastChecked: { type: 'string' },
                    modelsAvailable: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request, _reply) => {
      try {
        const registry = getProviderRegistry();
        const allAdapters = registry.getAll();

        const providerStatuses = await Promise.all(
          allAdapters.map(async (adapter) => {
            const providerName = adapter.getName();
            const status = providerAvailabilityService.getStatus(providerName);
            const isUsable = providerAvailabilityService.isProviderUsable(providerName);

            let modelsAvailable = 0;
            try {
              const models = await adapter.getModels();
              modelsAvailable = models.length;
            } catch {
              modelsAvailable = 0;
            }

            return {
              name: providerName,
              status: status?.status || 'unknown',
              reason: status?.reason || 'No status available',
              lastChecked: status?.lastUpdated?.toISOString() || new Date().toISOString(),
              modelsAvailable,
              usable: isUsable,
            };
          })
        );

        const available = providerStatuses.filter((p) => p.status === 'available').length;
        const degraded = providerStatuses.filter((p) => p.status === 'degraded').length;
        const unavailable = providerStatuses.filter(
          (p) => p.status === 'unavailable' || p.status === 'invalid_credentials'
        ).length;

        return {
          timestamp: new Date().toISOString(),
          totalProviders: providerStatuses.length,
          available,
          degraded,
          unavailable,
          providers: providerStatuses,
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, 'Failed to get provider health status');
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  );

  /**
   * GET /v1/health/providers/:providerName
   * Detailed health check for specific provider
   */
  server.get(
    '/v1/health/providers/:providerName',
    {
      schema: {
        tags: ['Health'],
        summary: 'Get specific provider health',
        description: 'Returns detailed health status for a specific LLM provider including model availability, usability status, and any health check errors.',
        params: {
          type: 'object',
          properties: {
            providerName: { type: 'string', description: 'Provider name (e.g., openai, anthropic, google)' },
          },
          required: ['providerName'],
        },
        response: {
          200: {
            description: 'Provider health status',
            type: 'object',
            properties: {
              provider: { type: 'string', description: 'Provider name' },
              status: { type: 'string', enum: ['available', 'degraded', 'unavailable', 'invalid_credentials', 'unknown'], description: 'Current provider status' },
              reason: { type: 'string', description: 'Status reason' },
              lastChecked: { type: 'string', format: 'date-time', description: 'Last health check timestamp' },
              usable: { type: 'boolean', description: 'Whether provider is currently usable' },
              modelsAvailable: { type: 'number', description: 'Number of models available' },
              healthCheckError: { type: 'string', nullable: true, description: 'Error from health check if any' },
              details: { type: 'object', additionalProperties: true, description: 'Additional status details' },
            },
          },
          400: {
            description: 'Invalid request parameter',
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
          404: {
            description: 'Provider not found',
            type: 'object',
            properties: {
              error: { type: 'string' },
              providerName: { type: 'string' },
            },
          },
          500: {
            description: 'Health check failed',
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
      // Type-safe params extraction
      const params = request.params;
      if (!params || typeof params !== 'object' || !('providerName' in params) || typeof params.providerName !== 'string') {
        return reply.status(400).send({
          error: 'Invalid provider name parameter',
        });
      }
      const { providerName } = params;

      try {
        const registry = getProviderRegistry();
        const adapter = registry.get(providerName);

        if (!adapter) {
          return reply.status(404).send({
            error: 'Provider not found',
            providerName,
          });
        }

        const status = providerAvailabilityService.getStatus(providerName);
        const isUsable = providerAvailabilityService.isProviderUsable(providerName);

        // Try to fetch models (health check)
        let modelsAvailable = 0;
        let healthCheckError: string | undefined;

        try {
          const models = await adapter.getModels();
          modelsAvailable = models.length;
        } catch (error: unknown) {
          healthCheckError = error instanceof Error ? error.message : String(error);
        }

        return {
          provider: providerName,
          status: status?.status || 'unknown',
          reason: status?.reason || 'No status available',
          lastChecked: status?.lastUpdated?.toISOString() || new Date().toISOString(),
          usable: isUsable,
          modelsAvailable,
          healthCheckError,
          details: {
            statusHistory: status,
          },
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage, providerName }, 'Failed to check provider health');
        return reply.status(500).send({
          error: 'Health check failed',
          message: errorMessage,
        });
      }
    }
  );

  logger.info('✅ Provider health check routes registered');
}

