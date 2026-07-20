// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Videos API Routes
 * OpenAI-compatible video generation endpoint with multimodal conditioning.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { createOrchestrationContext } from '@/utils/orchestration-context';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { VideoOrchestrationService } from '@/services/video-orchestration-service';
import { executeRouteWithRetry } from '@/utils/route-retry';

const log = logger.child({ module: 'videos-routes' });

const VideoGenerationRequestSchema = z.object({
  model: z.string().optional().default('auto'),
  prompt: z.string().min(1).max(8000),
  image: z.string().optional(),
  start_image: z.string().optional(),
  end_image: z.string().optional(),
  audio: z.string().optional(),
  video: z.string().optional(),
  duration: z.number().int().min(1).max(120).optional(),
  aspect_ratio: z.string().optional(),
  size: z.string().optional(),
  n: z.number().int().min(1).max(8).optional().default(1),
  response_format: z.enum(['url', 'b64_json']).optional().default('url'),
  strategy: z
    .enum(['single', 'cost', 'speed', 'quality', 'balanced', 'parallel', 'debate', 'quality_multipass', 'quality-multipass', 'quality-multi-pass', 'dynamic', 'auto'])
    .optional(),
  allow_fallback: z.boolean().optional().default(true),
  max_cost: z.number().min(0).optional(),
  quality_target: z.number().min(0).max(1).optional(),
});

interface VideoGenerationRequest {
  model?: string;
  prompt: string;
  image?: string;
  start_image?: string;
  end_image?: string;
  audio?: string;
  video?: string;
  duration?: number;
  aspect_ratio?: string;
  size?: string;
  n?: number;
  response_format?: 'url' | 'b64_json';
  strategy?: string;
  allow_fallback?: boolean;
  max_cost?: number;
  quality_target?: number;
}

export async function registerVideosRoutes(server: FastifyInstance): Promise<void> {
  const videoService = new VideoOrchestrationService();

  server.post('/v1/videos/generations', {
    schema: {
      tags: ['Videos'],
      summary: 'Generate videos from text and multimodal inputs',
      description:
        'Generates videos from prompt with optional conditioning inputs (image, start_image, end_image, audio, video).',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['prompt'],
        properties: {
          model: { type: 'string', default: 'auto' },
          prompt: { type: 'string', minLength: 1, maxLength: 8000 },
          image: { type: 'string', description: 'Image URL or base64 data URI for image-to-video' },
          start_image: { type: 'string', description: 'Start frame image URL/base64' },
          end_image: { type: 'string', description: 'End frame image URL/base64' },
          audio: { type: 'string', description: 'Audio URL or base64 data URI to condition generation' },
          video: { type: 'string', description: 'Source video URL/base64 for video-to-video' },
          duration: { type: 'integer', minimum: 1, maximum: 120 },
          aspect_ratio: { type: 'string' },
          size: { type: 'string' },
          n: { type: 'integer', minimum: 1, maximum: 8, default: 1 },
          response_format: { type: 'string', enum: ['url', 'b64_json'], default: 'url' },
          strategy: {
            type: 'string',
            enum: ['single', 'cost', 'speed', 'quality', 'balanced', 'parallel', 'debate', 'quality_multipass', 'quality-multipass', 'quality-multi-pass', 'dynamic', 'auto'],
          },
          allow_fallback: { type: 'boolean', default: true },
          max_cost: { type: 'number', minimum: 0 },
          quality_target: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            created: { type: 'integer' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', nullable: true },
                  url: { type: 'string', nullable: true },
                  b64_json: { type: 'string', nullable: true },
                },
              },
            },
            _ailin: {
              type: 'object',
              properties: {
                model_used: { type: 'string' },
                provider: { type: 'string' },
                duration_ms: { type: 'number' },
              },
            },
          },
        },
      },
    },
    preHandler: authenticateRequest,
    handler: async (
      request: FastifyRequest<{ Body: VideoGenerationRequest }>,
      reply: FastifyReply
    ) => {
      const requestId = request.id;
      const extendedRequest = request as ExtendedFastifyRequest;
      const userContext = extendedRequest.userContext || createOrchestrationContext(request);

      try {
        const validated = VideoGenerationRequestSchema.parse(request.body);
        const enrichedUserContext = {
          ...userContext,
          ...(validated.max_cost !== undefined ? { maxCost: validated.max_cost } : {}),
          ...(validated.quality_target !== undefined ? { qualityTarget: validated.quality_target } : {}),
        };
        const result = await executeRouteWithRetry(
          () =>
            videoService.generateVideo({
              prompt: validated.prompt,
              model: validated.model === 'auto' ? undefined : validated.model,
              image: validated.image,
              startImage: validated.start_image,
              endImage: validated.end_image,
              audio: validated.audio,
              video: validated.video,
              duration: validated.duration,
              aspectRatio: validated.aspect_ratio,
              size: validated.size,
              n: validated.n,
              responseFormat: validated.response_format,
              strategy: validated.strategy,
              allowFallback: validated.allow_fallback,
              userContext: enrichedUserContext,
              requestId,
            }),
          {
            operationName: 'POST /v1/videos/generations',
            requestId,
            log,
            isIdempotent: true,
            maxAttempts: 3,
            baseDelayMs: 300,
            maxDelayMs: 1800,
          }
        );

        return reply.send({
          created: Math.floor(Date.now() / 1000),
          data: result.videos,
          _ailin: {
            model_used: result.modelUsed,
            provider: result.provider,
            duration_ms: result.durationMs,
          },
        });
      } catch (error: unknown) {
        const statusCode =
          error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number'
            ? error.statusCode
            : 500;
        const message = error instanceof Error ? error.message : 'Video generation failed';
        const errorType =
          error && typeof error === 'object' && 'type' in error && typeof error.type === 'string'
            ? error.type
            : 'video_generation_error';
        const errorCode =
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'internal_error';

        log.error({ requestId, error }, 'Video generation request failed');
        return reply.code(statusCode).send({
          error: {
            message,
            type: errorType,
            code: errorCode,
          },
        });
      }
    },
  });
}
