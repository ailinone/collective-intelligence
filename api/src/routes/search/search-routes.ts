// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Search & Grounding API Routes
 * Web search and grounding capabilities with multi-provider orchestration
 * 
 * Features:
 * - Multi-provider orchestration (Tavily, models with web_search capability like Perplexity, etc.)
 * - Dynamic model/service selection based on capabilities
 * - Basic and deep search modes
 * - Context extraction for RAG
 * - Google Maps integration (when available)
 * 
 * NO HARDCODED PROVIDERS - All selection is dynamic via capabilities
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { SearchOrchestrationService } from '@/services/search-orchestration-service';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { createOrchestrationContext } from '@/utils/orchestration-context';

const log = logger.child({ module: 'search-routes' });

// ============================================
// Request Schemas
// ============================================

const SearchRequestSchema = z.object({
  query: z.string().min(1).max(2000),
  model: z.string().optional().default('auto'), // 'auto' triggers dynamic selection
  search_depth: z.enum(['basic', 'advanced']).optional().default('basic'),
  max_results: z.number().int().min(1).max(100).optional().default(10),
  include_images: z.boolean().optional().default(false),
  include_answer: z.boolean().optional().default(true),
  include_raw_content: z.boolean().optional().default(false),
  include_domains: z.array(z.string()).optional(),
  exclude_domains: z.array(z.string()).optional(),
  topic: z.enum(['general', 'news', 'finance']).optional().default('general'),
});

const GroundingRequestSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(10),
  include_images: z.boolean().optional().default(false),
});

// ============================================
// Types
// ============================================

interface SearchRequest {
  query: string;
  model?: string;
  search_depth?: 'basic' | 'advanced';
  max_results?: number;
  include_images?: boolean;
  include_answer?: boolean;
  include_raw_content?: boolean;
  include_domains?: string[];
  exclude_domains?: string[];
  topic?: 'general' | 'news' | 'finance';
}

// Use `z.infer<typeof GroundingRequestSchema>` directly at the handler site
// rather than maintaining a parallel interface (was previously unused).

// ============================================
// Register Routes
// ============================================

export async function registerSearchRoutes(server: FastifyInstance): Promise<void> {
  const searchService = new SearchOrchestrationService();

  // ==========================================
  // POST /v1/search
  // ==========================================
  server.post('/v1/search', {
    schema: {
      tags: ['Search', 'Grounding'],
      summary: 'Web search with AI grounding',
      description: 'Performs web search using multi-provider orchestration (Tavily, models with web_search capability like Perplexity, Google Search Grounding, etc.). Automatically selects the best search provider/model based on query type and depth requirements.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { 
            type: 'string', 
            minLength: 1, 
            maxLength: 2000,
            description: 'Search query text',
          },
          model: { 
            type: 'string', 
            default: 'auto',
            description: 'Model ID or "auto" for intelligent selection. When "auto", Ailin orchestrates between Tavily, Perplexity, and other models with web_search capability.',
          },
          search_depth: { 
            type: 'string', 
            enum: ['basic', 'advanced'],
            default: 'basic',
            description: 'Search depth: basic (fast) or advanced (comprehensive)',
          },
          max_results: { 
            type: 'integer', 
            minimum: 1, 
            maximum: 100,
            default: 10,
            description: 'Maximum number of results to return',
          },
          include_images: { 
            type: 'boolean', 
            default: false,
            description: 'Include images in results',
          },
          include_answer: { 
            type: 'boolean', 
            default: true,
            description: 'Include AI-generated answer summary',
          },
          include_raw_content: { 
            type: 'boolean', 
            default: false,
            description: 'Include raw HTML/text content from pages',
          },
          include_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only search within these domains',
          },
          exclude_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exclude these domains from search',
          },
          topic: {
            type: 'string',
            enum: ['general', 'news', 'finance'],
            default: 'general',
            description: 'Search topic category',
          },
        },
      },
      response: {
        200: {
          description: 'Search completed successfully',
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Original search query' },
            answer: { type: 'string', nullable: true, description: 'AI-generated answer summary' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Result title' },
                  url: { type: 'string', description: 'Result URL' },
                  content: { type: 'string', description: 'Result content snippet' },
                  rawContent: { type: 'string', nullable: true, description: 'Raw HTML/text content' },
                  score: { type: 'number', description: 'Relevance score' },
                  publishedDate: { type: 'string', nullable: true, description: 'Publication date' },
                },
              },
            },
            images: {
              type: 'array',
              items: { type: 'string' },
              description: 'Image URLs found in results',
            },
            responseTime: { type: 'number', description: 'Response time in milliseconds' },
            _ailin: {
              type: 'object',
              properties: {
                provider_used: { type: 'string' },
                model_used: { type: 'string', nullable: true },
                duration_ms: { type: 'number' },
              },
            },
          },
        },
        400: {
          description: 'Bad request (invalid query)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_query", "invalid_parameter")' },
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
          description: 'Resource not found (e.g., search service or URL not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found", "url_not_found")' },
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
    handler: async (request: FastifyRequest<{ Body: SearchRequest }>, reply: FastifyReply) => {
      const requestId = request.id;
      const extendedRequest = request as ExtendedFastifyRequest;
      const userContext = extendedRequest.userContext || createOrchestrationContext(request);

      log.info({ requestId, query: request.body.query, model: request.body.model }, 'Search request received');

      try {
        // Validate request body
        const validated = SearchRequestSchema.parse(request.body);

        // Execute search via orchestration service
        const result = await searchService.performSearch({
          query: validated.query,
          model: validated.model === 'auto' ? undefined : validated.model,
          searchDepth: validated.search_depth!,
          maxResults: validated.max_results!,
          includeImages: validated.include_images!,
          includeAnswer: validated.include_answer!,
          includeRawContent: validated.include_raw_content!,
          includeDomains: validated.include_domains,
          excludeDomains: validated.exclude_domains,
          topic: validated.topic!,
          userContext,
          requestId,
        });

        return reply.send({
          query: validated.query,
          answer: result.answer,
          results: result.results,
          images: result.images,
          responseTime: result.responseTime,
          _ailin: {
            provider_used: result.providerUsed,
            model_used: result.modelUsed,
            duration_ms: result.durationMs,
          },
        });
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'Search request failed';
        const statusCode = extractStatusCode(error) ?? 500;
        const errorType = extractErrorType(error) ?? 'search_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'internal_error';
        
        log.error({ requestId, error: errorMessage }, 'Search request failed');
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

  // ==========================================
  // POST /v1/grounding/extract
  // ==========================================
  server.post('/v1/grounding/extract', {
    schema: {
      tags: ['Search'],
      summary: 'Extract content from URLs',
      description: 'Extracts and processes content from provided URLs for grounding/RAG purposes.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['urls'],
        properties: {
          urls: { 
            type: 'array', 
            items: { type: 'string', format: 'uri' },
            minItems: 1,
            maxItems: 10,
            description: 'Array of URLs to extract content from (1-10 URLs allowed)' 
          },
          include_images: { 
            type: 'boolean', 
            default: false,
            description: 'Whether to include image URLs found on the pages (default: false)' 
          },
        },
      },
      response: {
        200: {
          description: 'Content extracted successfully',
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'Source URL' },
                  content: { type: 'string', description: 'Extracted text content' },
                  images: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Image URLs found on page',
                  },
                },
              },
            },
            failedResults: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  error: { type: 'string' },
                },
              },
            },
            responseTime: { type: 'number', description: 'Total extraction time in milliseconds' },
            _ailin: {
              type: 'object',
              properties: {
                provider_used: { type: 'string' },
                duration_ms: { type: 'number' },
              },
            },
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
          description: 'Resource not found (e.g., search service or URL not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found", "url_not_found")' },
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
    handler: async (
      request: FastifyRequest<{ Body: z.infer<typeof GroundingRequestSchema> }>,
      reply: FastifyReply
    ) => {
      const requestId = request.id;
      const extendedRequest = request as ExtendedFastifyRequest;
      const userContext = extendedRequest.userContext || createOrchestrationContext(request);

      log.info({ requestId, urlCount: request.body.urls.length }, 'Grounding extract request received');

      try {
        const validated = GroundingRequestSchema.parse(request.body);

        const result = await searchService.extractContent({
          urls: validated.urls,
          includeImages: validated.include_images ?? false,
          userContext,
          requestId,
        });

        return reply.send({
          results: result.results,
          failedResults: result.failedResults,
          responseTime: result.responseTime,
          _ailin: {
            provider_used: result.providerUsed,
            duration_ms: result.durationMs,
          },
        });
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'Content extraction failed';
        const statusCode = extractStatusCode(error) ?? 500;
        const errorType = extractErrorType(error) ?? 'grounding_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'internal_error';
        
        log.error({ requestId, error: errorMessage }, 'Grounding extract request failed');
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

  log.info('Search & Grounding API routes registered successfully');
}
