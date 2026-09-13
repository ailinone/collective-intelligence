// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Rerank + Retrieval routes (LOTE AP, 2026-09-05)
 *
 *   POST /v1/rerank     — Cohere/Voyage-compatible cross-encoder reranking
 *   POST /v1/retrieval  — two-stage retrieval over an ingested vector store
 *
 * Both capabilities existed in the ontology and the catalog long before
 * anything could execute them; these are their first real surfaces. Model
 * selection is fully dynamic (catalog-by-capability), never a pinned vendor.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '@/utils/logger';
import { authenticate } from '@/middleware/auth-middleware';
import { rejectAnonymousGuestKeyPreHandler } from '@/services/anonymous-quota-gate';
import { rejectChatFreeTierKeyPreHandler } from '@/services/free-tier-quota-gate';
import { requireTenantContext } from '@/api/middleware/tenant-isolation-middleware';
import { createOrchestrationContext } from '@/utils/orchestration-context';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import {
  getRerankOrchestrationService,
  MAX_RERANK_DOCUMENTS,
} from '@/services/rerank-orchestration-service';
import {
  getRetrievalOrchestrationService,
  RETRIEVAL_MAX_LIMIT,
  RETRIEVAL_MAX_STORES,
} from '@/services/retrieval-orchestration-service';
import { ValidationError } from '@/utils/custom-errors';
import {
  FallbackExhaustedError,
  NoFallbackCandidateError,
} from '@/core/orchestration/execute-with-fallback';
import { getErrorMessage } from '@/utils/type-guards';

const log = logger.child({ module: 'rerank-routes' });

interface RerankBody {
  query?: unknown;
  documents?: unknown;
  model?: unknown;
  top_n?: unknown;
  /** Voyage spells it `top_k`; accepted as an alias so either SDK works. */
  top_k?: unknown;
  return_documents?: unknown;
  strategy?: unknown;
  allow_fallback?: unknown;
}

interface RetrievalBody {
  query?: unknown;
  vector_store_ids?: unknown;
  top_k?: unknown;
  max_chunks?: unknown;
  score_threshold?: unknown;
  file_ids?: unknown;
  rerank?: unknown;
  rerank_model?: unknown;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function getUserContext(request: FastifyRequest) {
  const extendedRequest = request as ExtendedFastifyRequest;
  return extendedRequest.userContext || createOrchestrationContext(request);
}

/**
 * Translate an orchestration failure into the API error envelope.
 *
 * The three cases are deliberately distinct status codes:
 *   400 — the caller's request is wrong (ValidationError)
 *   404 — no model in the catalog can serve this capability at all
 *   503 — candidates existed but every one of them failed
 * Collapsing 404 into 503 would tell an operator "retry later" for a
 * condition that no amount of retrying fixes.
 */
function sendOrchestrationError(reply: FastifyReply, error: unknown, capability: string) {
  if (error instanceof ValidationError) {
    return reply.code(400).send({
      error: {
        message: error.message,
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    });
  }

  if (error instanceof NoFallbackCandidateError) {
    return reply.code(404).send({
      error: {
        message: `No model with the \`${capability}\` capability is available. ${error.message}`,
        type: 'not_found_error',
        code: 'no_capability_candidates',
      },
    });
  }

  if (error instanceof FallbackExhaustedError) {
    return reply.code(503).send({
      error: {
        message: error.message,
        type: 'service_unavailable',
        code: 'capability_dependency_unavailable',
        attempts: error.attempts,
      },
    });
  }

  const message = getErrorMessage(error);
  log.error({ error: message, capability }, 'Capability execution failed');
  return reply.code(500).send({
    error: { message, type: 'server_error', code: 'internal_error' },
  });
}

const rerankResponseSchema = {
  type: 'object',
  required: ['object', 'model', 'results'],
  additionalProperties: true,
  properties: {
    object: { type: 'string' },
    model: { type: 'string' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'relevance_score'],
        additionalProperties: true,
        properties: {
          index: { type: 'integer' },
          relevance_score: { type: 'number' },
          document: { type: 'string', nullable: true },
        },
      },
    },
    usage: {
      type: 'object',
      additionalProperties: true,
      properties: { total_tokens: { type: 'integer' } },
    },
    _ailin: { type: 'object', additionalProperties: true },
  },
};

export async function registerRerankRoutes(server: FastifyInstance): Promise<void> {
  server.post<{ Body: RerankBody }>(
    '/v1/rerank',
    {
      schema: {
        tags: ['Rerank'],
        summary: 'Rerank documents against a query',
        description:
          'Cross-encoder reranking: rescores candidate documents against a query and returns them ' +
          'ordered by relevance, with indices referring to the original request order. Model ' +
          'selection is dynamic across every catalog model carrying the `reranking` capability; ' +
          'pass `model` to pin one.',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['query', 'documents'],
          properties: {
            query: { type: 'string', minLength: 1 },
            documents: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_RERANK_DOCUMENTS,
              items: { type: 'string' },
            },
            model: { type: 'string', description: 'Reranker model id, or "auto" (default).' },
            top_n: { type: 'integer', minimum: 1 },
            top_k: { type: 'integer', minimum: 1, description: 'Alias of top_n (Voyage spelling).' },
            return_documents: { type: 'boolean', default: false },
            strategy: { type: 'string' },
            allow_fallback: { type: 'boolean', default: true },
          },
        },
        response: {
          200: { description: 'Documents reranked', ...rerankResponseSchema },
          400: { description: 'Invalid request', type: 'object' },
          401: { description: 'Unauthorized', type: 'object' },
          404: { description: 'No reranker model available', type: 'object' },
          503: { description: 'Every reranker candidate failed', type: 'object' },
        },
      },
      preHandler: [
        authenticate,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
        requireTenantContext(),
      ],
    },
    async (request, reply) => {
      const body = request.body || {};
      try {
        const result = await getRerankOrchestrationService().rerank({
          query: typeof body.query === 'string' ? body.query : '',
          documents: Array.isArray(body.documents) ? (body.documents as string[]) : [],
          ...(asOptionalString(body.model) ? { model: asOptionalString(body.model) } : {}),
          ...(() => {
            const topN = asOptionalNumber(body.top_n) ?? asOptionalNumber(body.top_k);
            return topN !== undefined ? { topN } : {};
          })(),
          returnDocuments: body.return_documents === true,
          ...(asOptionalString(body.strategy) ? { strategy: asOptionalString(body.strategy) } : {}),
          ...(typeof body.allow_fallback === 'boolean'
            ? { allowFallback: body.allow_fallback }
            : {}),
          userContext: getUserContext(request),
          requestId: request.id,
        });

        return reply.send({
          object: 'list',
          model: result.modelUsed,
          results: result.results.map((item) => ({
            index: item.index,
            relevance_score: item.relevanceScore,
            ...(item.document !== undefined ? { document: item.document } : {}),
          })),
          ...(typeof result.totalTokens === 'number'
            ? { usage: { total_tokens: result.totalTokens } }
            : {}),
          _ailin: {
            resolved_provider: result.provider,
            resolved_model: result.modelUsed,
            strategy_used: result.strategyUsed,
            fallback_used: result.fallbackUsed,
            duration_ms: result.durationMs,
            request_id: request.id,
          },
        });
      } catch (error: unknown) {
        return sendOrchestrationError(reply, error, 'reranking');
      }
    }
  );

  server.post<{ Body: RetrievalBody }>(
    '/v1/retrieval',
    {
      schema: {
        tags: ['Rerank'],
        summary: 'Two-stage retrieval over ingested vector stores',
        description:
          'Runs a pgvector kNN over the named vector stores (stage 1) and optionally a ' +
          'cross-encoder rerank over the recalled chunks (stage 2). Stores must already ' +
          'contain ingested files — create them via POST /v1/vector_stores. Reranking is ' +
          'fail-soft: a reranker outage degrades to vector order and is reported in ' +
          '`rerank.reason` rather than failing the request.',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['query', 'vector_store_ids'],
          properties: {
            query: { type: 'string', minLength: 1 },
            vector_store_ids: {
              type: 'array',
              minItems: 1,
              maxItems: RETRIEVAL_MAX_STORES,
              items: { type: 'string' },
            },
            top_k: { type: 'integer', minimum: 1, maximum: RETRIEVAL_MAX_LIMIT },
            max_chunks: { type: 'integer', minimum: 1, maximum: RETRIEVAL_MAX_LIMIT },
            score_threshold: { type: 'number' },
            file_ids: { type: 'array', items: { type: 'string' } },
            rerank: { type: 'boolean', default: false },
            rerank_model: { type: 'string' },
          },
        },
        response: {
          200: {
            description: 'Chunks retrieved',
            type: 'object',
            additionalProperties: true,
            properties: {
              object: { type: 'string' },
              query: { type: 'string' },
              data: { type: 'array', items: { type: 'object', additionalProperties: true } },
              rerank: { type: 'object', additionalProperties: true },
              _ailin: { type: 'object', additionalProperties: true },
            },
          },
          400: { description: 'Invalid request', type: 'object' },
          401: { description: 'Unauthorized', type: 'object' },
        },
      },
      preHandler: [
        authenticate,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
        requireTenantContext(),
      ],
    },
    async (request, reply) => {
      const body = request.body || {};
      try {
        const result = await getRetrievalOrchestrationService().retrieve({
          query: typeof body.query === 'string' ? body.query : '',
          vectorStoreIds: asStringArray(body.vector_store_ids),
          ...(asOptionalNumber(body.top_k) !== undefined
            ? { topK: asOptionalNumber(body.top_k) }
            : {}),
          ...(asOptionalNumber(body.max_chunks) !== undefined
            ? { maxChunks: asOptionalNumber(body.max_chunks) }
            : {}),
          ...(asOptionalNumber(body.score_threshold) !== undefined
            ? { scoreThreshold: asOptionalNumber(body.score_threshold) }
            : {}),
          ...(asStringArray(body.file_ids).length > 0
            ? { fileIds: asStringArray(body.file_ids) }
            : {}),
          rerank: body.rerank === true,
          ...(asOptionalString(body.rerank_model)
            ? { rerankModel: asOptionalString(body.rerank_model) }
            : {}),
          userContext: getUserContext(request),
          requestId: request.id,
        });

        return reply.send({
          object: 'retrieval.results',
          query: typeof body.query === 'string' ? body.query : '',
          data: result.chunks.map((chunk) => ({
            vector_store_id: chunk.vectorStoreId,
            file_id: chunk.fileId,
            chunk_index: chunk.chunkIndex,
            content: [{ type: 'text', text: chunk.content }],
            score: chunk.score,
            vector_score: chunk.vectorScore,
            ...(chunk.rerankScore !== undefined ? { rerank_score: chunk.rerankScore } : {}),
            metadata: chunk.metadata,
          })),
          rerank: {
            requested: result.rerank.requested,
            applied: result.rerank.applied,
            ...(result.rerank.model ? { model: result.rerank.model } : {}),
            ...(result.rerank.provider ? { provider: result.rerank.provider } : {}),
            ...(result.rerank.reason ? { reason: result.rerank.reason } : {}),
          },
          _ailin: {
            store_ids: result.storeIds,
            retrieved_count: result.retrievedCount,
            returned_count: result.chunks.length,
            failed_store_ids: result.failedStoreIds,
            duration_ms: result.durationMs,
            request_id: request.id,
          },
        });
      } catch (error: unknown) {
        return sendOrchestrationError(reply, error, 'retrieval');
      }
    }
  );

  log.info('Rerank + retrieval routes registered successfully');
}
