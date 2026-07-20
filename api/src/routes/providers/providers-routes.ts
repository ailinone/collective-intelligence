// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Providers Routes
 * Lists available AI providers and their status
 */

import type { FastifyInstance } from 'fastify';
import { authenticate } from '@/middleware/auth-middleware';
import { getProviderRegistry } from '@/providers/provider-registry';
import { providerAvailabilityService } from '@/services/provider-availability-service';
import { prisma } from '@/database/client';

export async function registerProvidersRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /v1/providers
   * List all available AI providers and their status
   */
  server.get(
    '/v1/providers',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Providers'],
        summary: 'List available AI providers',
        description: 'Returns a list of all configured AI providers with their availability status, health, and capabilities',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              providers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    displayName: { type: 'string' },
                    status: { type: 'string', enum: ['active', 'inactive', 'error'] },
                    health: {
                      type: 'object',
                      properties: {
                        status: { type: 'string' },
                        lastChecked: { type: 'string' },
                        latency: { type: 'number' },
                      },
                    },
                    capabilities: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    modelsCount: { type: 'number' },
            configured: { type: 'boolean' },
            discovered: { type: 'boolean' },
            source: { type: 'string' },
            executionProvider: { type: 'string' },
            routedVia: { type: 'string' },
                  },
                },
              },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string' },
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
        const registry = getProviderRegistry();
        const providers = await registry.getAllProviders();
        const availability = providerAvailabilityService.getSnapshot();
        const allModels = await registry.getAllModels();
        const dbProviders = await prisma.provider.findMany({
          where: { status: { not: 'disabled' } },
          select: {
            id: true,
            name: true,
            displayName: true,
            metadata: true,
          },
        });

        const configuredProvidersList = providers.map((provider) => {
          const providerAvailability = availability[provider.id];
          const models = allModels.filter((m) => m.providerId === provider.id);
          const uniqueCapabilities = Array.from(
            new Set(models.flatMap((model) => model.capabilities || []))
          );

          return {
            id: provider.id,
            name: provider.name,
            displayName: provider.displayName || provider.name,
            status: providerAvailability?.status === 'available' ? 'active' : 'inactive',
            health: providerAvailability
              ? {
                  status: providerAvailability.status === 'available' ? 'healthy' : 'unhealthy',
                  lastChecked: providerAvailability.lastUpdated?.toISOString(),
                  reason: providerAvailability.reason,
                }
              : undefined,
            capabilities: uniqueCapabilities,
            modelsCount: models.length,
            configured: providerAvailability?.status === 'available',
            discovered: false,
          };
        });

        const configuredIds = new Set(configuredProvidersList.map((provider) => provider.id));
        const discoveredProvidersList = dbProviders
          .filter((provider) => !configuredIds.has(provider.id))
          .map((provider) => {
            const models = allModels.filter((m) => m.providerId === provider.id);
            const capabilities = Array.from(new Set(models.flatMap((model) => model.capabilities || [])));
            const metadata =
              provider.metadata && typeof provider.metadata === 'object' && !Array.isArray(provider.metadata)
                ? (provider.metadata as Record<string, unknown>)
                : {};

            const source =
              typeof metadata.discoveredBy === 'string' ? (metadata.discoveredBy as string) : undefined;
            const executionProvider =
              typeof metadata.executionProvider === 'string'
                ? (metadata.executionProvider as string)
                : undefined;
            const routedVia =
              typeof metadata.routedVia === 'string' ? (metadata.routedVia as string) : undefined;

            return {
              id: provider.id,
              name: provider.name,
              displayName: provider.displayName || provider.name,
              status: models.length > 0 ? 'active' : 'inactive',
              health: undefined,
              capabilities,
              modelsCount: models.length,
              configured: false,
              discovered: true,
              source,
              executionProvider,
              routedVia,
            };
          });

        const providersList = [...configuredProvidersList, ...discoveredProvidersList];

        return reply.send({ providers: providersList });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Failed to list providers');
        return reply.code(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );

  /**
   * GET /v1/providers/:id
   * Get details about a specific provider
   */
  server.get(
    '/v1/providers/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Providers'],
        summary: 'Get provider details',
        description: 'Returns detailed information about a specific AI provider',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              displayName: { type: 'string' },
              status: { type: 'string' },
              health: { type: 'object' },
              capabilities: { type: 'array' },
              modelsCount: { type: 'number' },
              configured: { type: 'boolean' },
              discovered: { type: 'boolean' },
              source: { type: 'string' },
              executionProvider: { type: 'string' },
              routedVia: { type: 'string' },
              models: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    status: { type: 'string' },
                  },
                },
              },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
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
        const { id } = request.params as { id: string };
        const registry = getProviderRegistry();
        const providers = await registry.getAllProviders();
        const provider = providers.find((p) => p.id === id);
        const allModels = await registry.getAllModels();

        if (provider) {
          const availability = providerAvailabilityService.getStatus(id);
          const models = allModels.filter((m) => m.providerId === id);

          return reply.send({
            id: provider.id,
            name: provider.name,
            displayName: provider.displayName || provider.name,
            status: availability?.status === 'available' ? 'active' : 'inactive',
            health: availability
              ? {
                  status: availability.status === 'available' ? 'healthy' : 'unhealthy',
                  lastChecked: availability.lastUpdated?.toISOString(),
                  reason: availability.reason,
                  configured: availability.status === 'available',
                }
              : undefined,
            capabilities: Array.from(new Set(models.flatMap((model) => model.capabilities || []))),
            modelsCount: models.length,
            configured: availability?.status === 'available',
            discovered: false,
            models: models.slice(0, 20).map((model: { id: string; name: string; status: string }) => ({
              id: model.id,
              name: model.name,
              status: model.status,
            })),
          });
        }

        const discoveredProvider = await prisma.provider.findUnique({
          where: { name: id },
          select: {
            id: true,
            name: true,
            displayName: true,
            metadata: true,
          },
        });

        if (!discoveredProvider) {
          return reply.code(404).send({
            error: 'Provider not found',
            message: `Provider with ID "${id}" not found`,
          });
        }

        const models = allModels.filter((m) => m.providerId === id);
        const metadata =
          discoveredProvider.metadata &&
          typeof discoveredProvider.metadata === 'object' &&
          !Array.isArray(discoveredProvider.metadata)
            ? (discoveredProvider.metadata as Record<string, unknown>)
            : {};
        const source =
          typeof metadata.discoveredBy === 'string' ? (metadata.discoveredBy as string) : undefined;
        const executionProvider =
          typeof metadata.executionProvider === 'string'
            ? (metadata.executionProvider as string)
            : undefined;
        const routedVia =
          typeof metadata.routedVia === 'string' ? (metadata.routedVia as string) : undefined;

        return reply.send({
          id: discoveredProvider.id,
          name: discoveredProvider.name,
          displayName: discoveredProvider.displayName || discoveredProvider.name,
          status: models.length > 0 ? 'active' : 'inactive',
          health: undefined,
          capabilities: Array.from(new Set(models.flatMap((model) => model.capabilities || []))),
          modelsCount: models.length,
          configured: false,
          discovered: true,
          source,
          executionProvider,
          routedVia,
          models: models.slice(0, 20).map((model: { id: string; name: string; status: string }) => ({
            id: model.id,
            name: model.name,
            status: model.status,
          })),
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Failed to get provider details');
        return reply.code(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );
}

