// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Embeddings routes
 * POST /v1/embeddings
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EmbeddingRequest, ChatRequest, ModelCapability, Model } from '@/types';
import { authenticate } from '@/middleware/auth-middleware';
import {
  requireTenantContext,
  getTenantContext,
} from '@/api/middleware/tenant-isolation-middleware';
import { ProviderRegistry } from '@/providers/provider-registry';
import { ProviderAdapter } from '@/providers/base/provider-adapter';
import { logger } from '@/utils/logger';
import { trackChatUsage } from '@/services/billing-usage-tracker';
import { modelCatalogService } from '@/services/model-catalog-service';
import { narrowAs, serializeError } from '@/utils/type-guards';
import {
  executeWithFallback,
  FallbackExhaustedError,
  NoFallbackCandidateError,
} from '@/core/orchestration/execute-with-fallback';

const embeddingsResponseSchema = {
  type: 'object',
  required: ['object', 'data', 'model', 'usage'],
  additionalProperties: true,
  properties: {
    object: { type: 'string' },
    data: {
      type: 'array',
      items: {
        type: 'object',
        required: ['object', 'embedding', 'index'],
        additionalProperties: true,
        properties: {
          object: { type: 'string' },
          embedding: {
            type: 'array',
            items: { type: 'number' },
          },
          index: { type: 'integer' },
        },
      },
    },
    model: { type: 'string' },
    usage: {
      type: 'object',
      required: ['prompt_tokens', 'total_tokens'],
      additionalProperties: true,
      properties: {
        prompt_tokens: { type: 'integer' },
        completion_tokens: { type: 'integer' },
        total_tokens: { type: 'integer' },
      },
    },
  },
};

function createEmbeddingsHandler(providerRegistry: ProviderRegistry) {
  const supportsEmbeddings = (adapter: ProviderAdapter): boolean => {
    const baseImpl = (
      narrowAs<Record<string, unknown>>(ProviderAdapter.prototype)
    ).generateEmbeddings;
    const impl = (narrowAs<Record<string, unknown>>(adapter)).generateEmbeddings;
    return typeof impl === 'function' && impl !== baseImpl;
  };

  const toStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  };

  const getTextEmbeddingPriority = (model: Model): number => {
    const normalizedName = `${model.id} ${model.name} ${model.displayName}`.toLowerCase();
    const metadata =
      model.metadata && typeof model.metadata === 'object' && !Array.isArray(model.metadata)
        ? (model.metadata as Record<string, unknown>)
        : {};

    const supportedModalities = toStringArray(metadata.supported_modalities).map((item) =>
      item.toLowerCase()
    );
    const declaredInputTypes = toStringArray(metadata.input_types).map((item) =>
      item.toLowerCase()
    );
    const endpoints = toStringArray(metadata.endpoints).map((item) => item.toLowerCase());
    const compatibility =
      metadata.endpointCompatibility &&
      typeof metadata.endpointCompatibility === 'object' &&
      !Array.isArray(metadata.endpointCompatibility)
        ? (metadata.endpointCompatibility as Record<string, unknown>)
        : {};

    let score = 0;

    if (normalizedName.includes('embedding') || normalizedName.includes('embed')) score += 5;
    if (normalizedName.includes('text')) score += 2;
    if (
      normalizedName.includes('image') &&
      !normalizedName.includes('text') &&
      !declaredInputTypes.includes('text')
    ) {
      score -= 4;
    }

    if (supportedModalities.includes('text') || declaredInputTypes.includes('text')) score += 4;
    if (endpoints.includes('embeddings')) score += 3;
    if (compatibility.embeddings === 'explicit') score += 3;

    if (model.status === 'active') score += 1;

    return score;
  };

  const rankEmbeddingCandidates = (models: Model[]): Model[] => {
    return [...models].sort((a, b) => {
      const scoreDiff = getTextEmbeddingPriority(b) - getTextEmbeddingPriority(a);
      if (scoreDiff !== 0) return scoreDiff;

      const aCost = (a.inputCostPer1k || 0) + (a.outputCostPer1k || 0);
      const bCost = (b.inputCostPer1k || 0) + (b.outputCostPer1k || 0);
      if (aCost !== bCost) return aCost - bCost;

      return a.name.localeCompare(b.name);
    });
  };

  return async (request: FastifyRequest<{ Body: EmbeddingRequest }>, reply: FastifyReply) => {
    const embeddingRequest = request.body;
    const tenantContext = getTenantContext(request);
    const organizationId = tenantContext.organizationId;
    const userId = tenantContext.userId;

    const requestLog = logger.child({
      endpoint: request.url,
      organizationId,
      userId,
      model: embeddingRequest.model,
      inputLength: Array.isArray(embeddingRequest.input) ? embeddingRequest.input.length : 1,
    });

    requestLog.info('Embedding generation request received');

    try {
      const requestedModel = embeddingRequest.model;
      const isExplicit = Boolean(requestedModel) && requestedModel !== 'auto';

      // Pre-rank by embeddings-specific signal (name keywords, cost, status).
      // The primitive's own ranking is tier-major and order-stable, so this
      // preference becomes the within-tier tiebreaker — best of both worlds.
      const allModels = await modelCatalogService.listModels();
      const embeddingModels = allModels.filter(
        (m) =>
          m.capabilities.includes('embeddings' as ModelCapability) ||
          m.capabilities.includes('embedding' as ModelCapability)
      );
      const preRanked = rankEmbeddingCandidates(embeddingModels);

      let result;
      try {
        result = await executeWithFallback<
          Awaited<ReturnType<ProviderAdapter['generateEmbeddings']>>
        >({
          capability: ['embeddings', 'embedding'],
          capabilityLabel: 'embeddings',
          explicit: isExplicit ? requestedModel : null,
          maxCandidates: 9,
          registry: providerRegistry,
          catalog: preRanked,
          supportsCapability: supportsEmbeddings,
          log: requestLog,
          execute: async (model, adapter) => {
            const requestForAdapter: EmbeddingRequest = {
              ...embeddingRequest,
              model: model.name,
            };
            return adapter.generateEmbeddings(requestForAdapter);
          },
        });
      } catch (fallbackError) {
        if (fallbackError instanceof NoFallbackCandidateError) {
          requestLog.warn(
            { model: requestedModel ?? 'auto' },
            fallbackError.message
          );
          return reply.status(404).send({
            error: {
              message: fallbackError.message,
              type: 'model_not_found',
              code: fallbackError.code,
              capability: fallbackError.capabilityLabel,
            },
          });
        }
        if (fallbackError instanceof FallbackExhaustedError) {
          requestLog.error(
            {
              model: requestedModel ?? 'auto',
              attempts: fallbackError.attempts,
            },
            'Failed to generate embeddings with all candidate models'
          );
          return reply.status(503).send({
            error: {
              message: fallbackError.message,
              type: 'service_unavailable',
              code: fallbackError.code,
              capability: fallbackError.capabilityLabel,
              attempts: fallbackError.attempts,
            },
          });
        }
        throw fallbackError;
      }

      const selectedModel = result.selectedModel;
      const embeddingResponse = result.response;

      // Track usage for billing
      if (embeddingResponse.usage) {
        const requestId = typeof request.id === 'string' ? request.id : `embeddings-${Date.now()}`;
        const syntheticRequest: ChatRequest = {
          model: selectedModel.id,
          messages: [],
          stream: false,
        };

        await trackChatUsage({
          organizationId,
          userId,
          requestId,
          request: syntheticRequest,
          cacheHit: false,
          strategyOverride: 'embeddings',
          totalTokensOverride: embeddingResponse.usage.total_tokens || 0,
          totalCostOverride: 0,
          modelsOverride: [
            {
              modelId: selectedModel.id,
              modelName: selectedModel.name,
              tokens: embeddingResponse.usage.total_tokens || 0,
              costUsd: 0,
              success: true,
            },
          ],
        }).catch((error) => {
          requestLog.warn({ error: serializeError(error) }, 'Failed to track embedding usage');
        });
      }

      requestLog.info(
        { model: selectedModel.name, vectors: embeddingResponse.data?.length },
        'Embeddings generated'
      );

      return reply.send(embeddingResponse);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to generate embeddings';
      requestLog.error({ error: errorMessage }, 'Failed to generate embeddings');
      if (/embeddings?\s+not\s+supported/i.test(errorMessage) || /service unavailable/i.test(errorMessage)) {
        return reply.status(503).send({
          error: {
            message: errorMessage,
            type: 'service_unavailable',
          },
        });
      }
      return reply.status(500).send({
        error: {
          message: errorMessage,
          type: 'embedding_generation_error',
        },
      });
    }
  };
}

export async function registerEmbeddingsRoutes(
  server: FastifyInstance,
  providerRegistry: ProviderRegistry
): Promise<void> {
  const embeddingsHandler = createEmbeddingsHandler(providerRegistry);

  /**
   * POST /v1/embeddings
   * Generate embeddings (primary endpoint)
   */
  server.post<{ Body: EmbeddingRequest }>(
    '/v1/embeddings',
    {
      schema: {
        tags: ['Embeddings'],
        description: 'Generate embeddings for given input',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['input'],
          properties: {
            input: {
              anyOf: [
                { type: 'string', minLength: 1 },
                { type: 'array', items: { type: 'string' }, minItems: 1 },
              ],
            },
            model: { type: 'string' },
            encoding_format: { type: 'string', enum: ['float', 'base64'] },
          },
        },
        response: {
          200: {
            description: 'Embeddings generated',
            ...embeddingsResponseSchema,
          },
          400: {
            description: 'Invalid request',
            type: 'object',
          },
          401: {
            description: 'Unauthorized',
            type: 'object',
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    embeddingsHandler
  );

  /**
   * POST /v1/embeddings/create
   * Alias for ailin-cli compatibility (expects /create suffix)
   */
  server.post<{ Body: EmbeddingRequest }>(
    '/v1/embeddings/create',
    {
      schema: {
        tags: ['Embeddings'],
        description: 'Generate embeddings (ailin-cli compatible endpoint)',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['input'],
          properties: {
            input: {
              anyOf: [
                { type: 'string', minLength: 1 },
                { type: 'array', items: { type: 'string' }, minItems: 1 },
              ],
            },
            model: { type: 'string' },
            encoding_format: { type: 'string', enum: ['float', 'base64'] },
          },
        },
        response: {
          200: {
            description: 'Embeddings generated',
            ...embeddingsResponseSchema,
          },
          400: {
            description: 'Invalid request',
            type: 'object',
          },
          401: {
            description: 'Unauthorized',
            type: 'object',
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    embeddingsHandler
  );
}
