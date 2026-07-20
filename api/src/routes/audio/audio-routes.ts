// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Audio API Routes
 * OpenAI-compatible audio endpoints (TTS, STT, Translations)
 * 
 * Features:
 * - Multi-provider orchestration (OpenAI, Google, ElevenLabs, etc.)
 * - Dynamic model selection based on capabilities
 * - Streaming support for TTS
 * - Multiple audio formats (mp3, wav, ogg, opus, pcm)
 * - Language detection and translation
 * 
 * NO HARDCODED MODELS - All model selection is dynamic via capabilities
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { AudioOrchestrationService } from '@/services/audio-orchestration-service';
import { createOrchestrationContext } from '@/utils/orchestration-context';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { executeRouteWithRetry } from '@/utils/route-retry';
import type { CandidateAttempt } from '@/core/orchestration/execute-with-fallback';

const log = logger.child({ module: 'audio-routes' });

/**
 * Project a CandidateAttempt down to the public _ailin envelope shape.
 *
 * Trimmed deliberately: we expose model/provider/status/duration_ms and
 * (when failed) error_class. We do NOT expose modelId (redundant for
 * routing analysis), errorMessage (potentially leaks provider-internal
 * details or upstream prompts), or statusCode (errorClass already
 * captures the relevant taxonomy: 'rate_limit' | 'auth' | 'timeout' |
 * 'quota_exhausted' | 'capability_mismatch' | 'provider_unavailable' |
 * 'bad_request' | 'not_found' | 'other'). Field naming is snake_case to
 * match the existing _ailin envelope (model_used, duration_ms).
 */
function toAilinAttempt(a: CandidateAttempt): {
  model: string;
  provider: string;
  status: 'success' | 'failed' | 'skipped';
  duration_ms: number;
  error_class?: string;
} {
  return {
    model: a.model,
    provider: a.provider,
    status: a.status,
    duration_ms: a.durationMs,
    ...(a.errorClass ? { error_class: a.errorClass } : {}),
  };
}

/** JSON schema fragment for an `attempts` array in _ailin response envelopes. */
const AILIN_ATTEMPTS_SCHEMA = {
  type: 'array',
  description: 'Per-candidate attempt log when fallback was exercised. Empty/single-entry array on first-success paths.',
  items: {
    type: 'object',
    properties: {
      model: { type: 'string' },
      provider: { type: 'string' },
      status: { type: 'string', enum: ['success', 'failed', 'skipped'] },
      duration_ms: { type: 'number' },
      error_class: { type: 'string', enum: ['quota_exhausted', 'auth', 'rate_limit', 'capability_mismatch', 'provider_unavailable', 'timeout', 'bad_request', 'not_found', 'other'] },
    },
  },
} as const;

// ============================================
// Request Schemas (OpenAI-compatible)
// ============================================

const TTSRequestSchema = z.object({
  model: z.string().optional().default('auto'), // 'auto' triggers dynamic selection
  input: z.string().min(1).max(100000),
  voice: z.string().optional().default('auto'),  // Provider-specific voice (alloy, af_heart, Rachel, etc.)
  response_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional().default('mp3'),
  speed: z.number().min(0.25).max(4.0).optional().default(1.0),
  strategy: z
    .enum(['single', 'cost', 'speed', 'quality', 'balanced', 'parallel', 'debate', 'quality_multipass', 'quality-multipass', 'quality-multi-pass', 'dynamic', 'auto'])
    .optional(),
  allow_fallback: z.boolean().optional().default(true),
  max_cost: z.number().min(0).optional(),
  quality_target: z.number().min(0).max(1).optional(),
});

// NOTE: STT/Translation Zod schemas + interfaces removed here — validation
// is currently inline in the route handlers (no schema-based validation).
// Reintroduce as `STTRequestSchema`/`TranslationRequestSchema` when wiring
// pre-handler Zod validation.

// ============================================
// Types
// ============================================

interface TTSRequest {
  model?: string;
  input: string;
  voice?: string;
  response_format?: string;
  speed?: number;
  strategy?: string;
  allow_fallback?: boolean;
  max_cost?: number;
  quality_target?: number;
}

// ============================================
// Register Routes
// ============================================

export async function registerAudioRoutes(server: FastifyInstance): Promise<void> {
  const audioService = new AudioOrchestrationService();

  // ==========================================
  // POST /v1/audio/speech (TTS)
  // ==========================================
  server.post('/v1/audio/speech', {
    schema: {
      tags: ['Audio'],
      summary: 'Text-to-Speech (TTS)',
      description: 'Converts text to natural-sounding audio using multi-provider orchestration. Automatically selects the best TTS model based on language, voice preference, and quality requirements.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['input'],
        properties: {
          model: { 
            type: 'string', 
            default: 'auto',
            description: 'Model ID or "auto" for intelligent selection. When "auto", Ailin orchestrates across 500+ models to find the best TTS model for your requirements.'
          },
          input: { 
            type: 'string', 
            minLength: 1, 
            maxLength: 100000,
            description: 'The text to convert to audio. Maximum length is 100,000 characters.' 
          },
          voice: {
            type: 'string',
            default: 'auto',
            description: 'Voice ID or "auto" for intelligent selection. Any provider voice name accepted (alloy, af_heart, Rachel, etc.).'
          },
          response_format: { 
            type: 'string', 
            enum: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'],
            default: 'mp3',
            description: 'Audio format for the output'
          },
          speed: { 
            type: 'number', 
            minimum: 0.25, 
            maximum: 4.0,
            default: 1.0,
            description: 'Playback speed (0.25 = 4x slower, 4.0 = 4x faster)'
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
          description: 'Audio file generated successfully (binary audio content)',
          type: 'string',
          format: 'binary',
        },
        400: {
          description: 'Bad request (invalid input or parameters)',
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
          description: 'Resource not found (e.g., referenced model or service unavailable)',
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
    handler: async (request: FastifyRequest<{ Body: TTSRequest }>, reply: FastifyReply) => {
      const requestId = request.id;
      // `speed` is destructured for documentation completeness; actual TTS
      // call uses validated.speed (post-validation), so the destructured
      // copy is intentionally unused here.
      const { model = 'auto', input, voice = 'auto', response_format = 'mp3', speed: _speed = 1.0 } = request.body;
      const extendedRequest = request as ExtendedFastifyRequest;
      const userContext = extendedRequest.userContext || createOrchestrationContext(request);

      log.info({ requestId, model, inputLength: input.length, voice, format: response_format }, 'TTS request received');

      try {
        // Validate request body
        const validated = TTSRequestSchema.parse(request.body);

        // Type guard for audio format
        const format = validated.response_format;
        if (format !== 'mp3' && format !== 'opus' && format !== 'aac' && format !== 'flac' && format !== 'wav' && format !== 'pcm') {
          throw new Error(`Invalid audio format: ${format}`);
        }

        // Execute TTS via orchestration service (dynamic model selection)
        const enrichedUserContext = {
          ...userContext,
          ...(validated.max_cost !== undefined ? { maxCost: validated.max_cost } : {}),
          ...(validated.quality_target !== undefined ? { qualityTarget: validated.quality_target } : {}),
        };
        const result = await executeRouteWithRetry(
          () =>
            audioService.synthesizeSpeech({
              text: validated.input,
              model: validated.model === 'auto' ? undefined : validated.model, // undefined triggers auto-selection
              voice: validated.voice === 'auto' ? undefined : validated.voice,
              format,
              speed: validated.speed,
              strategy: validated.strategy,
              allowFallback: validated.allow_fallback,
              userContext: enrichedUserContext,
              requestId,
            }),
          {
            operationName: 'POST /v1/audio/speech',
            requestId,
            log,
            isIdempotent: true,
            maxAttempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 1500,
          }
        );

        // Set response headers
        const contentType = getContentType(validated.response_format);
        reply.header('Content-Type', contentType);
        reply.header('Content-Disposition', `attachment; filename="speech.${validated.response_format}"`);
        reply.header('X-Ailin-Model-Used', result.modelUsed);
        reply.header('X-Ailin-Provider', result.provider);
        reply.header('X-Ailin-Duration-Ms', result.durationMs.toString());

        // Return audio buffer
        return reply.send(result.audioBuffer);
      } catch (error: unknown) {
        log.error({ requestId, error }, 'TTS request failed');
        const statusCode = (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') 
          ? error.statusCode 
          : 500;
        const message = error instanceof Error ? error.message : 'TTS request failed';
        const errorType = (error && typeof error === 'object' && 'type' in error && typeof error.type === 'string')
          ? error.type
          : 'audio_synthesis_error';
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
  // POST /v1/audio/transcriptions (STT)
  // ==========================================
  server.post('/v1/audio/transcriptions', {
    // Skip body schema validation for multipart/form-data endpoints.
    // Fastify's JSON schema validator runs BEFORE the multipart parser and rejects
    // raw form-data bytes as invalid JSON objects. Validation is done in the handler.
    validatorCompiler: () => () => true,
    schema: {
      tags: ['Audio'],
      summary: 'Speech-to-Text (STT)',
      description: 'Transcribes audio into text using multi-provider orchestration (Whisper, Google Speech, etc.). Automatically selects the best STT model based on language and audio quality.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      consumes: ['multipart/form-data'],
      body: {
        type: 'object',
        required: ['file'],
        properties: {
          file: { 
            type: 'string', 
            format: 'binary',
            description: 'Audio file to transcribe (mp3, mp4, mpeg, mpga, m4a, wav, webm, flac, ogg, opus)'
          },
          model: { 
            type: 'string', 
            default: 'auto',
            description: 'Model ID or "auto" for intelligent selection'
          },
          language: { 
            type: 'string',
            description: 'Language of the audio (ISO-639-1 format, e.g., "en", "es", "pt-BR"). Optional - auto-detected if not provided.' 
          },
          prompt: { 
            type: 'string',
            description: 'Optional text to guide the model\'s style or continue a previous audio segment. Helps with proper nouns, context, etc.'
          },
          response_format: { 
            type: 'string', 
            enum: ['json', 'text', 'srt', 'verbose_json', 'vtt'],
            default: 'json'
          },
          temperature: { 
            type: 'number', 
            minimum: 0, 
            maximum: 1,
            default: 0
          },
          timestamp_granularities: {
            type: 'array',
            items: { type: 'string', enum: ['word', 'segment'] },
            description: 'Timestamp granularities (word-level or segment-level)'
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
          description: 'Transcription successful. Response format depends on response_format parameter (json, text, srt, verbose_json, vtt)',
          oneOf: [
            { type: 'string', description: 'Plain text transcription (when response_format=text)' },
            { type: 'string', description: 'SRT subtitle format (when response_format=srt)' },
            { type: 'string', description: 'WebVTT format (when response_format=vtt)' },
            {
              type: 'object',
              description: 'JSON response (when response_format=json or verbose_json)',
              properties: {
                text: { type: 'string', description: 'Transcribed text' },
                language: { type: 'string', description: 'Detected language (ISO-639-1)' },
                duration: { type: 'number', description: 'Audio duration in seconds' },
                words: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      word: { type: 'string' },
                      start: { type: 'number' },
                      end: { type: 'number' },
                    },
                  },
                },
                segments: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'number' },
                      seek: { type: 'number' },
                      start: { type: 'number' },
                      end: { type: 'number' },
                      text: { type: 'string' },
                      temperature: { type: 'number' },
                      avg_logprob: { type: 'number' },
                      compression_ratio: { type: 'number' },
                      no_speech_prob: { type: 'number' },
                    },
                  },
                },
                _ailin: {
                  type: 'object',
                  properties: {
                    model_used: { type: 'string' },
                    provider: { type: 'string' },
                    duration_ms: { type: 'number' },
                    attempts: AILIN_ATTEMPTS_SCHEMA,
                  },
                },
              },
            },
          ],
        },
        400: {
          description: 'Bad request (missing file or invalid parameters)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "missing_file", "invalid_parameter", "invalid_audio_format")' },
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
          description: 'Resource not found (e.g., referenced model or service unavailable)',
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

      log.info({ requestId }, 'STT request received');

      try {
        // Parse multipart form data
        // Fastify multipart types
        interface MultipartFile {
          toBuffer: () => Promise<Buffer>;
          filename: string;
          fields?: Record<string, { value?: string }>;
        }

        const multipartRequest = request as FastifyRequest & { file?: () => Promise<MultipartFile> };
        const data = multipartRequest.file ? await multipartRequest.file() : undefined;
        if (!data) {
          return reply.code(400).send({
            error: {
              message: 'No audio file provided',
              type: 'invalid_request_error',
              code: 'missing_file',
            },
          });
        }

        // Get audio buffer
        const audioBuffer = await data.toBuffer();
        const filename = data.filename;

        // Get form fields
        const fields = (data.fields || {}) as Record<string, unknown>;
        const getFieldValue = (field: unknown): string | undefined => {
          if (!field) return undefined;
          if (Array.isArray(field)) {
            for (const item of field) {
              const value = getFieldValue(item);
              if (value) return value;
            }
            return undefined;
          }
          if (
            typeof field === 'object' &&
            field !== null &&
            'value' in field &&
            typeof (field as { value?: unknown }).value === 'string'
          ) {
            return (field as { value: string }).value;
          }
          return undefined;
        };

        const model = getFieldValue(fields.model) || 'auto';
        const language = getFieldValue(fields.language);
        const prompt = getFieldValue(fields.prompt);
        const response_format = getFieldValue(fields.response_format) || 'json';
        const temperatureRaw = getFieldValue(fields.temperature);
        const temperature = temperatureRaw ? parseFloat(temperatureRaw) : 0;
        const timestampGranularitiesRaw = getFieldValue(fields.timestamp_granularities);
        // JSON.parse returns `unknown`; narrow to a typed array of valid
        // granularity literals before passing to the service.
        const timestamp_granularities: Array<'word' | 'segment'> | undefined = (() => {
          if (!timestampGranularitiesRaw) return undefined;
          try {
            const parsed: unknown = JSON.parse(timestampGranularitiesRaw);
            if (!Array.isArray(parsed)) return undefined;
            return parsed.filter(
              (v): v is 'word' | 'segment' => v === 'word' || v === 'segment',
            );
          } catch {
            return undefined;
          }
        })();
        const strategy = getFieldValue(fields.strategy);
        const allowFallbackRaw = getFieldValue(fields.allow_fallback);
        const allowFallback =
          allowFallbackRaw === undefined ? true : allowFallbackRaw.toLowerCase() !== 'false';
        const maxCostRaw = getFieldValue(fields.max_cost);
        const maxCost = maxCostRaw !== undefined ? Number(maxCostRaw) : undefined;
        const qualityTargetRaw = getFieldValue(fields.quality_target);
        const qualityTarget = qualityTargetRaw !== undefined ? Number(qualityTargetRaw) : undefined;

        log.info({ requestId, model, filename, language, format: response_format }, 'STT processing started');

        // Execute STT via orchestration service
        const enrichedUserContext = {
          ...userContext,
          ...(Number.isFinite(maxCost) ? { maxCost } : {}),
          ...(Number.isFinite(qualityTarget) ? { qualityTarget } : {}),
        };
        const result = await executeRouteWithRetry(
          () =>
            audioService.transcribeAudio({
              audioBuffer,
              filename,
              model: model === 'auto' ? undefined : model,
              language,
              prompt,
              responseFormat: response_format as 'json' | 'text' | 'verbose_json' | 'srt' | 'vtt',
              temperature,
              timestampGranularities: timestamp_granularities,
              strategy,
              allowFallback,
              userContext: enrichedUserContext,
              requestId,
            }),
          {
            operationName: 'POST /v1/audio/transcriptions',
            requestId,
            log,
            isIdempotent: true,
            maxAttempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 1500,
          }
        );

        // Return transcription based on format
        if (response_format === 'text') {
          return reply.send(result.text);
        } else if (response_format === 'srt') {
          reply.header('Content-Type', 'text/plain; charset=utf-8');
          return reply.send(result.srt);
        } else if (response_format === 'vtt') {
          reply.header('Content-Type', 'text/vtt; charset=utf-8');
          return reply.send(result.vtt);
        } else {
          // json or verbose_json
          return reply.send({
            text: result.text,
            language: result.language,
            duration: result.duration,
            words: result.words,
            segments: result.segments,
            _ailin: {
              model_used: result.modelUsed,
              provider: result.provider,
              duration_ms: result.durationMs,
              ...(result.attempts && result.attempts.length > 0
                ? { attempts: result.attempts.map(toAilinAttempt) }
                : {}),
            },
          });
        }
      } catch (error: unknown) {
        log.error({ requestId, error }, 'STT request failed');
        const statusCode = (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') 
          ? error.statusCode 
          : 500;
        const message = error instanceof Error ? error.message : 'STT request failed';
        const errorType = (error && typeof error === 'object' && 'type' in error && typeof error.type === 'string')
          ? error.type
          : 'audio_transcription_error';
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
  // POST /v1/audio/translations
  // ==========================================
  server.post('/v1/audio/translations', {
    validatorCompiler: () => () => true, // Skip body validation for multipart
    schema: {
      tags: ['Audio'],
      summary: 'Audio Translation',
      description: 'Translates audio from any language to English using multi-provider orchestration.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      consumes: ['multipart/form-data'],
      body: {
        type: 'object',
        required: ['file'],
        properties: {
          file: { 
            type: 'string', 
            format: 'binary',
            description: 'Audio file to translate'
          },
          model: { 
            type: 'string', 
            default: 'auto',
            description: 'Model ID or "auto" for intelligent selection. When "auto", Ailin orchestrates across 500+ models to find the best audio translation model.',
          },
          prompt: { 
            type: 'string',
            description: 'Optional text prompt to guide translation context or terminology',
          },
          response_format: { 
            type: 'string', 
            enum: ['json', 'text', 'srt', 'verbose_json', 'vtt'],
            default: 'json',
            description: 'Response format: json (default, structured JSON), text (plain text), srt (SRT subtitles), verbose_json (detailed JSON with timestamps), or vtt (WebVTT format)'
          },
          temperature: { 
            type: 'number', 
            minimum: 0, 
            maximum: 1,
            default: 0,
            description: 'Sampling temperature (0-1). Controls randomness in translation. Lower values make output more deterministic. Default is 0 (most deterministic).'
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
          description: 'Translation successful. Response format depends on response_format parameter (json, text, srt, verbose_json, vtt)',
          oneOf: [
            { type: 'string', description: 'Plain text translation (when response_format=text)' },
            { type: 'string', description: 'SRT subtitle format (when response_format=srt)' },
            { type: 'string', description: 'WebVTT format (when response_format=vtt)' },
            {
              type: 'object',
              description: 'JSON response (when response_format=json or verbose_json)',
              properties: {
                text: { type: 'string', description: 'Translated text in English' },
                duration: { type: 'number', description: 'Audio duration in seconds' },
                segments: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'number' },
                      seek: { type: 'number' },
                      start: { type: 'number' },
                      end: { type: 'number' },
                      text: { type: 'string' },
                    },
                  },
                },
                _ailin: {
                  type: 'object',
                  properties: {
                    model_used: { type: 'string' },
                    provider: { type: 'string' },
                    duration_ms: { type: 'number' },
                    attempts: AILIN_ATTEMPTS_SCHEMA,
                  },
                },
              },
            },
          ],
        },
        400: {
          description: 'Bad request (missing file or invalid parameters)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "missing_file", "invalid_parameter", "invalid_audio_format")' },
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
          description: 'Resource not found (e.g., referenced model or service unavailable)',
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

      log.info({ requestId }, 'Translation request received');

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
              message: 'No audio file provided',
              type: 'invalid_request_error',
              code: 'missing_file',
            },
          });
        }

        const audioBuffer = await data.toBuffer();
        const filename = data.filename;

        const fields = data.fields || {};
        const model = (typeof fields.model === 'object' && fields.model !== null && 'value' in fields.model && typeof fields.model.value === 'string')
          ? fields.model.value
          : 'auto';
        const prompt = (typeof fields.prompt === 'object' && fields.prompt !== null && 'value' in fields.prompt && typeof fields.prompt.value === 'string')
          ? fields.prompt.value
          : undefined;
        const response_format = (typeof fields.response_format === 'object' && fields.response_format !== null && 'value' in fields.response_format && typeof fields.response_format.value === 'string')
          ? fields.response_format.value
          : 'json';
        const temperature = (typeof fields.temperature === 'object' && fields.temperature !== null && 'value' in fields.temperature && typeof fields.temperature.value === 'string')
          ? parseFloat(fields.temperature.value)
          : 0;
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

        // Type guard for response format
        if (response_format !== 'json' && response_format !== 'text' && response_format !== 'srt' && response_format !== 'verbose_json' && response_format !== 'vtt') {
          throw new Error(`Invalid response format: ${response_format}`);
        }

        log.info({ requestId, model, filename, format: response_format }, 'Translation processing started');

        // Execute translation via orchestration service
        const enrichedUserContext = {
          ...userContext,
          ...(Number.isFinite(maxCost) ? { maxCost } : {}),
          ...(Number.isFinite(qualityTarget) ? { qualityTarget } : {}),
        };
        const result = await executeRouteWithRetry(
          () =>
            audioService.translateAudio({
              audioBuffer,
              filename,
              model: model === 'auto' ? undefined : model,
              prompt,
              responseFormat: response_format,
              temperature,
              strategy,
              allowFallback,
              userContext: enrichedUserContext,
              requestId,
            }),
          {
            operationName: 'POST /v1/audio/translations',
            requestId,
            log,
            isIdempotent: true,
            maxAttempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 1500,
          }
        );

        // Return translation based on format
        if (response_format === 'text') {
          return reply.send(result.text);
        } else if (response_format === 'srt') {
          reply.header('Content-Type', 'text/plain; charset=utf-8');
          return reply.send(result.srt);
        } else if (response_format === 'vtt') {
          reply.header('Content-Type', 'text/vtt; charset=utf-8');
          return reply.send(result.vtt);
        } else {
          return reply.send({
            text: result.text,
            duration: result.duration,
            segments: result.segments,
            _ailin: {
              model_used: result.modelUsed,
              provider: result.provider,
              duration_ms: result.durationMs,
              ...(result.attempts && result.attempts.length > 0
                ? { attempts: result.attempts.map(toAilinAttempt) }
                : {}),
            },
          });
        }
      } catch (error: unknown) {
        log.error({ requestId, error }, 'Translation request failed');
        const statusCode = (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') 
          ? error.statusCode 
          : 500;
        const message = error instanceof Error ? error.message : 'Translation request failed';
        const errorType = (error && typeof error === 'object' && 'type' in error && typeof error.type === 'string')
          ? error.type
          : 'audio_translation_error';
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

  log.info('Audio API routes registered successfully');
}

// ============================================
// Helper Functions
// ============================================

function getContentType(format: string): string {
  const mimeTypes: Record<string, string> = {
    mp3: 'audio/mpeg',
    opus: 'audio/opus',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wav: 'audio/wav',
    pcm: 'audio/pcm',
  };
  return mimeTypes[format] || 'audio/mpeg';
}

