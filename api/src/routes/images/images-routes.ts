// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Images API Routes
 * OpenAI-compatible image generation/manipulation endpoints
 * 
 * Features:
 * - Multi-provider orchestration (DALL-E, Stable Diffusion, Midjourney, Google Imagen, etc.)
 * - Dynamic model selection based on capabilities
 * - Multiple formats (PNG, JPEG, WebP)
 * - Image editing and variations
 * 
 * NO HARDCODED MODELS - All model selection is dynamic via capabilities
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { ImagesOrchestrationService } from '@/services/images-orchestration-service';
import { createOrchestrationContext } from '@/utils/orchestration-context';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { executeRouteWithRetry } from '@/utils/route-retry';

const log = logger.child({ module: 'images-routes' });

// ============================================
// Request Schemas (OpenAI-compatible)
// ============================================

const ImageGenerationRequestSchema = z.object({
  model: z.string().optional().default('auto'), // 'auto' triggers dynamic selection
  prompt: z.string().min(1).max(4000),
  n: z.number().int().min(1).max(10).optional().default(1), // Number of images
  size: z.enum(['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792']).optional().default('1024x1024'),
  quality: z.enum(['standard', 'hd']).optional().default('standard'),
  response_format: z.enum(['url', 'b64_json']).optional().default('url'),
  style: z.enum(['vivid', 'natural']).optional().default('vivid'),
  strategy: z
    .enum(['single', 'cost', 'speed', 'quality', 'balanced', 'parallel', 'debate', 'quality_multipass', 'quality-multipass', 'quality-multi-pass', 'dynamic', 'auto'])
    .optional(),
  allow_fallback: z.boolean().optional().default(true),
  max_cost: z.number().min(0).optional(),
  quality_target: z.number().min(0).max(1).optional(),
  user: z.string().optional(),
});

// NOTE: ImageEditRequestSchema, ImageVariationRequestSchema (Zod) and the
// ImageEditRequest, ImageVariationRequest interfaces were defined here but
// never wired — validation is inline in the route handlers. Removed to keep
// the file lint-clean; reintroduce when adopting schema-driven validation.

// ============================================
// Types
// ============================================

interface ImageGenerationRequest {
  model?: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  response_format?: string;
  style?: string;
  strategy?: string;
  allow_fallback?: boolean;
  max_cost?: number;
  quality_target?: number;
  user?: string;
}

interface _ImagesUnusedShape {
  model?: string;
  image: Buffer;
  n?: number;
  size?: string;
  response_format?: string;
  strategy?: string;
  allow_fallback?: boolean;
  max_cost?: number;
  quality_target?: number;
  user?: string;
}

// ============================================
// Register Routes
// ============================================

export async function registerImagesRoutes(server: FastifyInstance): Promise<void> {
  const imagesService = new ImagesOrchestrationService();

  // ==========================================
  // POST /v1/images/generations
  // ==========================================
  server.post('/v1/images/generations', {
    schema: {
      tags: ['Images'],
      summary: 'Generate images from text prompts',
      description: 'Creates images from text descriptions using multi-provider orchestration. Automatically selects the best image generation model based on quality requirements and style preferences.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['prompt'],
        properties: {
          model: { 
            type: 'string', 
            default: 'auto',
            description: 'Model ID or "auto" for intelligent selection. When "auto", Ailin orchestrates across 500+ models to find the best image generation model.',
          },
          prompt: { 
            type: 'string', 
            minLength: 1, 
            maxLength: 4000,
            description: 'Text description of the desired image(s). Maximum 4000 characters.',
          },
          n: { 
            type: 'integer', 
            minimum: 1, 
            maximum: 10,
            default: 1,
            description: 'Number of images to generate. Must be between 1 and 10.',
          },
          size: { 
            type: 'string', 
            enum: ['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792'],
            default: '1024x1024',
            description: 'Image size/resolution',
          },
          quality: { 
            type: 'string', 
            enum: ['standard', 'hd'],
            default: 'standard',
            description: 'Quality level (standard or hd)',
          },
          response_format: { 
            type: 'string', 
            enum: ['url', 'b64_json'],
            default: 'url',
            description: 'Response format: URL or base64 JSON',
          },
          style: { 
            type: 'string', 
            enum: ['vivid', 'natural'],
            default: 'vivid',
            description: 'Style: vivid (hyper-real) or natural (more realistic)',
          },
          strategy: {
            type: 'string',
            enum: ['single', 'cost', 'speed', 'quality', 'balanced', 'parallel', 'debate', 'quality_multipass', 'quality-multipass', 'quality-multi-pass', 'dynamic', 'auto'],
            description: 'Execution strategy for model selection and orchestration.'
          },
          allow_fallback: {
            type: 'boolean',
            default: true,
            description: 'Allow fallback to additional candidate models/providers on transient failures.'
          },
          max_cost: {
            type: 'number',
            minimum: 0,
            description: 'Maximum target cost for this request in USD.'
          },
          quality_target: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Quality target from 0 to 1 used by orchestration ranking.'
          },
          user: { 
            type: 'string',
            description: 'Optional unique identifier for end-user tracking',
          },
        },
      },
      response: {
        200: {
          description: 'Images generated successfully',
          type: 'object',
          properties: {
            created: { type: 'integer', description: 'Unix timestamp of image creation' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string', format: 'uri', description: 'URL of generated image (when response_format=url)' },
                  b64_json: { type: 'string', description: 'Base64-encoded image (when response_format=b64_json)' },
                  revised_prompt: { type: 'string', nullable: true, description: 'Revised prompt used for generation' },
                },
              },
            },
            _ailin: {
              type: 'object',
              description: 'Ailin-specific metadata about the image generation',
              properties: {
                model_used: { type: 'string', description: 'Model ID used for image generation' },
                provider: { type: 'string', description: 'AI provider used (e.g., "openai", "stability-ai", "midjourney")' },
              },
            },
          },
        },
        400: {
          description: 'Bad request (invalid prompt or parameters)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_prompt", "invalid_parameter", "invalid_size")' },
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
          description: 'Resource not found (e.g., image generation service unavailable)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
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
    handler: async (request: FastifyRequest<{ Body: ImageGenerationRequest }>, reply: FastifyReply) => {
      const requestId = request.id;
      const {
        model = 'auto',
        prompt,
        n = 1,
        size = '1024x1024',
        quality = 'standard',
        response_format = 'url',
        style: _style = 'vivid',
        user: _user,
      } = request.body;
      // `_style` and `_user` destructured for documentation completeness;
      // actual values flow through validated.style / validated.user below.
      const extendedRequest = request as ExtendedFastifyRequest;
      const userContext = extendedRequest.userContext || createOrchestrationContext(request);

      log.info({ requestId, model, promptLength: prompt.length, n, size, quality }, 'Image generation request received');

      try {
        // Validate request body
        const validated = ImageGenerationRequestSchema.parse(request.body);

        // Type guards for enum values
        const imageSize = validated.size;
        if (imageSize !== '256x256' && imageSize !== '512x512' && imageSize !== '1024x1024' && imageSize !== '1792x1024' && imageSize !== '1024x1792') {
          throw new Error(`Invalid image size: ${imageSize}`);
        }
        const imageQuality = validated.quality;
        if (imageQuality !== 'standard' && imageQuality !== 'hd') {
          throw new Error(`Invalid image quality: ${imageQuality}`);
        }
        const responseFormat = validated.response_format;
        if (responseFormat !== 'url' && responseFormat !== 'b64_json') {
          throw new Error(`Invalid response format: ${responseFormat}`);
        }
        const imageStyle = validated.style;
        if (imageStyle !== 'vivid' && imageStyle !== 'natural') {
          throw new Error(`Invalid image style: ${imageStyle}`);
        }
        const enrichedUserContext = {
          ...userContext,
          ...(validated.max_cost !== undefined ? { maxCost: validated.max_cost } : {}),
          ...(validated.quality_target !== undefined ? { qualityTarget: validated.quality_target } : {}),
        };

        // Execute image generation via orchestration service
        const result = await executeRouteWithRetry(
          () =>
            imagesService.generateImages({
              prompt: validated.prompt,
              model: validated.model === 'auto' ? undefined : validated.model,
              n: validated.n!,
              size: imageSize,
              quality: imageQuality,
              responseFormat,
              style: imageStyle,
              strategy: validated.strategy,
              allowFallback: validated.allow_fallback,
              userContext: enrichedUserContext,
              requestId,
            }),
          {
            operationName: 'POST /v1/images/generations',
            requestId,
            log,
            isIdempotent: true,
            maxAttempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 1500,
          }
        );

        // Return OpenAI-compatible response
        return reply.send({
          created: Math.floor(Date.now() / 1000),
          data: result.images.map((img) => ({
            ...(response_format === 'url' ? { url: img.url } : { b64_json: img.b64_json }),
            revised_prompt: img.revised_prompt,
          })),
          _ailin: {
            model_used: result.modelUsed,
            provider: result.provider,
            duration_ms: result.durationMs,
          },
        });
      } catch (error: unknown) {
        log.error({ requestId, error }, 'Image generation request failed');
        const statusCode = (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') 
          ? error.statusCode 
          : 500;
        const message = error instanceof Error ? error.message : 'Image generation failed';
        const errorType = (error && typeof error === 'object' && 'type' in error && typeof error.type === 'string')
          ? error.type
          : 'image_generation_error';
        const errorCode = (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
          ? error.code
          : 'internal_error';
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

  // ==========================================
  // POST /v1/images/edits
  // ==========================================
  server.post('/v1/images/edits', {
    schema: {
      tags: ['Images'],
      summary: 'Edit images with text prompts',
      description: 'Edits/modifies an existing image based on a text prompt. Optionally accepts a mask to specify areas to edit.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      consumes: ['multipart/form-data'],
      body: {
        type: 'object',
        required: ['image', 'prompt'],
        properties: {
          image: { 
            type: 'string', 
            format: 'binary',
            description: 'Original image to edit (PNG only, must be square, max 4MB)',
          },
          mask: { 
            type: 'string', 
            format: 'binary',
            description: 'Optional mask image (PNG, transparent areas indicate where to edit)',
          },
          prompt: { 
            type: 'string', 
            minLength: 1, 
            maxLength: 4000,
            description: 'Text description of desired edits',
          },
          model: { 
            type: 'string', 
            default: 'auto',
            description: 'Model ID or "auto" for intelligent selection. When "auto", Ailin orchestrates across 500+ models to find the best image editing model.',
          },
          n: { 
            type: 'integer', 
            minimum: 1, 
            maximum: 10,
            default: 1,
            description: 'Number of edited images to generate (1-10)',
          },
          size: { 
            type: 'string', 
            enum: ['256x256', '512x512', '1024x1024'],
            default: '1024x1024',
            description: 'Size of the generated images. Must match the size of the input image.',
          },
          response_format: { 
            type: 'string', 
            enum: ['url', 'b64_json'],
            default: 'url',
            description: 'Format of the response images: "url" returns publicly accessible URLs, "b64_json" returns base64-encoded images in JSON format.',
          },
          strategy: {
            type: 'string',
            enum: ['single', 'cost', 'speed', 'quality', 'balanced', 'parallel', 'debate', 'quality_multipass', 'quality-multipass', 'quality-multi-pass', 'dynamic', 'auto'],
            description: 'Execution strategy for model selection and orchestration.'
          },
          allow_fallback: {
            type: 'boolean',
            default: true,
            description: 'Allow fallback to additional candidate models/providers on transient failures.'
          },
          max_cost: {
            type: 'number',
            minimum: 0,
            description: 'Maximum target cost for this request in USD.'
          },
          quality_target: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Quality target from 0 to 1 used by orchestration ranking.'
          },
        },
      },
      response: {
        200: {
          description: 'Image edited successfully',
          type: 'object',
          properties: {
            created: { type: 'integer', description: 'Unix timestamp when the image was generated' },
            data: {
              type: 'array',
              description: 'Array of edited image objects',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string', format: 'uri', nullable: true, description: 'Publicly accessible URL of the edited image (when response_format is "url")' },
                  b64_json: { type: 'string', nullable: true, description: 'Base64-encoded image data (when response_format is "b64_json")' },
                },
              },
            },
          },
        },
        400: {
          description: 'Bad request (invalid parameters or image format)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_image_format", "invalid_parameter")' },
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
          description: 'Resource not found (e.g., image generation service unavailable)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
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
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      const extendedRequest = request as ExtendedFastifyRequest;
      const userContext = extendedRequest.userContext || createOrchestrationContext(request);

      log.info({ requestId }, 'Image edit request received');

      try {
        // Parse multipart form data
        // Fastify multipart types
        interface MultipartFile {
          toBuffer: () => Promise<Buffer>;
          filename: string;
          fields?: Record<string, { value: string }>;
        }

        const data = await (request as FastifyRequest & { file?: () => Promise<MultipartFile> }).file?.();
        if (!data) {
          return reply.code(400).send({
            error: {
              message: 'No image file provided',
              type: 'invalid_request_error',
              code: 'missing_file',
            },
          });
        }

        const imageBuffer = await data.toBuffer();

        // Get form fields
        const fields = data.fields || {};
        const model = (typeof fields.model === 'object' && fields.model !== null && 'value' in fields.model && typeof fields.model.value === 'string')
          ? fields.model.value
          : 'auto';
        const prompt = (typeof fields.prompt === 'object' && fields.prompt !== null && 'value' in fields.prompt && typeof fields.prompt.value === 'string')
          ? fields.prompt.value
          : undefined;
        const n = (typeof fields.n === 'object' && fields.n !== null && 'value' in fields.n && typeof fields.n.value === 'string')
          ? parseInt(fields.n.value, 10)
          : 1;
        const size = (typeof fields.size === 'object' && fields.size !== null && 'value' in fields.size && typeof fields.size.value === 'string')
          ? fields.size.value
          : '1024x1024';
        const response_format = (typeof fields.response_format === 'object' && fields.response_format !== null && 'value' in fields.response_format && typeof fields.response_format.value === 'string')
          ? fields.response_format.value
          : 'url';
        const strategy = (typeof fields.strategy === 'object' && fields.strategy !== null && 'value' in fields.strategy && typeof fields.strategy.value === 'string')
          ? fields.strategy.value
          : undefined;
        const allowFallbackRaw = (typeof fields.allow_fallback === 'object' && fields.allow_fallback !== null && 'value' in fields.allow_fallback && typeof fields.allow_fallback.value === 'string')
          ? fields.allow_fallback.value
          : undefined;
        const allowFallback = allowFallbackRaw === undefined ? true : allowFallbackRaw.toLowerCase() !== 'false';
        const maxCostRaw = (typeof fields.max_cost === 'object' && fields.max_cost !== null && 'value' in fields.max_cost && typeof fields.max_cost.value === 'string')
          ? fields.max_cost.value
          : undefined;
        const maxCost = maxCostRaw !== undefined ? Number(maxCostRaw) : undefined;
        const qualityTargetRaw = (typeof fields.quality_target === 'object' && fields.quality_target !== null && 'value' in fields.quality_target && typeof fields.quality_target.value === 'string')
          ? fields.quality_target.value
          : undefined;
        const qualityTarget = qualityTargetRaw !== undefined ? Number(qualityTargetRaw) : undefined;
        
        // Get mask if provided
        let maskBuffer: Buffer | undefined;
        const maskData = await (request as FastifyRequest & { file?: () => Promise<MultipartFile> }).file?.();
        if (maskData) {
          maskBuffer = await maskData.toBuffer();
        }

        if (!prompt) {
          return reply.code(400).send({
            error: {
              message: 'Prompt is required',
              type: 'invalid_request_error',
              code: 'missing_prompt',
            },
          });
        }

        // Type guards for enum values
        const imageSize = size;
        if (imageSize !== '256x256' && imageSize !== '512x512' && imageSize !== '1024x1024') {
          throw new Error(`Invalid image size: ${imageSize}`);
        }
        const responseFormat = response_format;
        if (responseFormat !== 'url' && responseFormat !== 'b64_json') {
          throw new Error(`Invalid response format: ${responseFormat}`);
        }

        log.info({ requestId, model, promptLength: prompt.length, hasMask: !!maskBuffer }, 'Image edit processing started');

        // Execute image edit via orchestration service
        const enrichedUserContext = {
          ...userContext,
          ...(Number.isFinite(maxCost) ? { maxCost } : {}),
          ...(Number.isFinite(qualityTarget) ? { qualityTarget } : {}),
        };
        const result = await executeRouteWithRetry(
          () =>
            imagesService.editImage({
              image: imageBuffer,
              mask: maskBuffer,
              prompt,
              model: model === 'auto' ? undefined : model,
              n,
              size: imageSize,
              responseFormat,
              strategy,
              allowFallback,
              userContext: enrichedUserContext,
              requestId,
            }),
          {
            operationName: 'POST /v1/images/edits',
            requestId,
            log,
            isIdempotent: true,
            maxAttempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 1500,
          }
        );

        return reply.send({
          created: Math.floor(Date.now() / 1000),
          data: result.images.map((img) => ({
            ...(response_format === 'url' ? { url: img.url } : { b64_json: img.b64_json }),
          })),
          _ailin: {
            model_used: result.modelUsed,
            provider: result.provider,
            duration_ms: result.durationMs,
          },
        });
      } catch (error: unknown) {
        log.error({ requestId, error }, 'Image edit request failed');
        const statusCode = (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') 
          ? error.statusCode 
          : 500;
        const message = error instanceof Error ? error.message : 'Image edit failed';
        const errorType = (error && typeof error === 'object' && 'type' in error && typeof error.type === 'string')
          ? error.type
          : 'image_edit_error';
        const errorCode = (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
          ? error.code
          : 'internal_error';
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

  // ==========================================
  // POST /v1/images/variations
  // ==========================================
  server.post('/v1/images/variations', {
    schema: {
      tags: ['Images'],
      summary: 'Create variations of images',
      description: 'Creates variations of an existing image using multi-provider orchestration.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      consumes: ['multipart/form-data'],
      body: {
        type: 'object',
        required: ['image'],
        properties: {
          image: { 
            type: 'string', 
            format: 'binary',
            description: 'Source image (PNG only, must be square, max 4MB)',
          },
          model: { 
            type: 'string', 
            default: 'auto',
            description: 'Model ID or "auto" for intelligent selection. When "auto", Ailin orchestrates across 500+ models to find the best image editing model.',
          },
          n: { 
            type: 'integer', 
            minimum: 1, 
            maximum: 10,
            default: 1,
            description: 'Number of edited images to generate (1-10)',
          },
          size: { 
            type: 'string', 
            enum: ['256x256', '512x512', '1024x1024'],
            default: '1024x1024',
            description: 'Size of the generated images. Must match the size of the input image.',
          },
          response_format: { 
            type: 'string', 
            enum: ['url', 'b64_json'],
            default: 'url',
            description: 'Format of the response images: "url" returns publicly accessible URLs, "b64_json" returns base64-encoded images in JSON format.',
          },
          strategy: {
            type: 'string',
            enum: ['single', 'cost', 'speed', 'quality', 'balanced', 'parallel', 'debate', 'quality_multipass', 'quality-multipass', 'quality-multi-pass', 'dynamic', 'auto'],
            description: 'Execution strategy for model selection and orchestration.'
          },
          allow_fallback: {
            type: 'boolean',
            default: true,
            description: 'Allow fallback to additional candidate models/providers on transient failures.'
          },
          max_cost: {
            type: 'number',
            minimum: 0,
            description: 'Maximum target cost for this request in USD.'
          },
          quality_target: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Quality target from 0 to 1 used by orchestration ranking.'
          },
        },
      },
      response: {
        200: {
          description: 'Variations created successfully',
          type: 'object',
          properties: {
            created: { type: 'integer', description: 'Unix timestamp when the variations were created' },
            data: {
              type: 'array',
              description: 'Array of generated image variations',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string', format: 'uri', nullable: true, description: 'URL of the generated image (if response_format is "url")' },
                  b64_json: { type: 'string', nullable: true, description: 'Base64-encoded image data (if response_format is "b64_json")' },
                },
              },
            },
          },
        },
        400: {
          description: 'Bad request (invalid parameters or image format)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_parameter", "invalid_image_format")' },
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
          description: 'Resource not found (e.g., image generation service unavailable)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
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
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      const extendedRequest = request as ExtendedFastifyRequest;
      const userContext = extendedRequest.userContext || createOrchestrationContext(request);

      log.info({ requestId }, 'Image variation request received');

      try {
        // Parse multipart form data
        // Fastify multipart types
        interface MultipartFile {
          toBuffer: () => Promise<Buffer>;
          filename: string;
          fields?: Record<string, { value: string }>;
        }

        const data = await (request as FastifyRequest & { file?: () => Promise<MultipartFile> }).file?.();
        if (!data) {
          return reply.code(400).send({
            error: {
              message: 'No image file provided',
              type: 'invalid_request_error',
              code: 'missing_file',
            },
          });
        }

        const imageBuffer = await data.toBuffer();

        // Get form fields
        const fields = data.fields || {};
        const model = (typeof fields.model === 'object' && fields.model !== null && 'value' in fields.model && typeof fields.model.value === 'string')
          ? fields.model.value
          : 'auto';
        const n = (typeof fields.n === 'object' && fields.n !== null && 'value' in fields.n && typeof fields.n.value === 'string')
          ? parseInt(fields.n.value, 10)
          : 1;
        const size = (typeof fields.size === 'object' && fields.size !== null && 'value' in fields.size && typeof fields.size.value === 'string')
          ? fields.size.value
          : '1024x1024';
        const response_format = (typeof fields.response_format === 'object' && fields.response_format !== null && 'value' in fields.response_format && typeof fields.response_format.value === 'string')
          ? fields.response_format.value
          : 'url';
        const strategy = (typeof fields.strategy === 'object' && fields.strategy !== null && 'value' in fields.strategy && typeof fields.strategy.value === 'string')
          ? fields.strategy.value
          : undefined;
        const allowFallbackRaw = (typeof fields.allow_fallback === 'object' && fields.allow_fallback !== null && 'value' in fields.allow_fallback && typeof fields.allow_fallback.value === 'string')
          ? fields.allow_fallback.value
          : undefined;
        const allowFallback = allowFallbackRaw === undefined ? true : allowFallbackRaw.toLowerCase() !== 'false';
        const maxCostRaw = (typeof fields.max_cost === 'object' && fields.max_cost !== null && 'value' in fields.max_cost && typeof fields.max_cost.value === 'string')
          ? fields.max_cost.value
          : undefined;
        const maxCost = maxCostRaw !== undefined ? Number(maxCostRaw) : undefined;
        const qualityTargetRaw = (typeof fields.quality_target === 'object' && fields.quality_target !== null && 'value' in fields.quality_target && typeof fields.quality_target.value === 'string')
          ? fields.quality_target.value
          : undefined;
        const qualityTarget = qualityTargetRaw !== undefined ? Number(qualityTargetRaw) : undefined;

        // Type guards for enum values
        const imageSize = size;
        if (imageSize !== '256x256' && imageSize !== '512x512' && imageSize !== '1024x1024') {
          throw new Error(`Invalid image size: ${imageSize}`);
        }
        const responseFormat = response_format;
        if (responseFormat !== 'url' && responseFormat !== 'b64_json') {
          throw new Error(`Invalid response format: ${responseFormat}`);
        }

        log.info({ requestId, model, n, size }, 'Image variation processing started');

        // Execute image variation via orchestration service
        const enrichedUserContext = {
          ...userContext,
          ...(Number.isFinite(maxCost) ? { maxCost } : {}),
          ...(Number.isFinite(qualityTarget) ? { qualityTarget } : {}),
        };
        const result = await executeRouteWithRetry(
          () =>
            imagesService.createVariations({
              image: imageBuffer,
              model: model === 'auto' ? undefined : model,
              n,
              size: imageSize,
              responseFormat,
              strategy,
              allowFallback,
              userContext: enrichedUserContext,
              requestId,
            }),
          {
            operationName: 'POST /v1/images/variations',
            requestId,
            log,
            isIdempotent: true,
            maxAttempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 1500,
          }
        );

        return reply.send({
          created: Math.floor(Date.now() / 1000),
          data: result.images.map((img) => ({
            ...(response_format === 'url' ? { url: img.url } : { b64_json: img.b64_json }),
          })),
          _ailin: {
            model_used: result.modelUsed,
            provider: result.provider,
            duration_ms: result.durationMs,
          },
        });
      } catch (error: unknown) {
        log.error({ requestId, error }, 'Image variation request failed');
        const statusCode = (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') 
          ? error.statusCode 
          : 500;
        const message = error instanceof Error ? error.message : 'Image variation failed';
        const errorType = (error && typeof error === 'object' && 'type' in error && typeof error.type === 'string')
          ? error.type
          : 'image_variation_error';
        const errorCode = (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
          ? error.code
          : 'internal_error';
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

  log.info('Images API routes registered successfully');
}

