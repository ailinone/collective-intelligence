// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { requireTenantContext } from '@/api/middleware/tenant-isolation-middleware';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import type { ChatMessage, ModelCapability } from '@/types';
import { createOrchestrationContext } from '@/utils/orchestration-context';
import { AudioOrchestrationService } from '@/services/audio-orchestration-service';
import { ImagesOrchestrationService } from '@/services/images-orchestration-service';
import { VideoOrchestrationService } from '@/services/video-orchestration-service';
import { SearchOrchestrationService } from '@/services/search-orchestration-service';
import { ModerationsOrchestrationService } from '@/services/moderations-orchestration-service';
import { CodeExecutionService } from '@/services/code-execution-service';
import { getCapabilityExecutionService } from '@/services/capability-execution-service';
import {
  getCapabilityExecutionPlan,
  getModelCapabilitiesForCapability,
  listCapabilityDefinitions,
  normalizeCapabilityName,
  type CapabilityExecutionMode,
  type CapabilityExecutionPlan,
} from '@/core/capabilities/capability-registry';
import { getAllCatalogModels } from '@/services/model-catalog-service';
import { getProviderRegistry } from '@/providers/provider-registry';
import { isCapabilityOperationalForModel, type ModelOperability } from '@/providers/provider-operability';
import { isModelCapability } from '@/types';
import { executeRouteWithRetry } from '@/utils/route-retry';

const log = logger.child({ module: 'capabilities-routes' });

type CapabilityRequestBody = Record<string, unknown>;

interface CapabilityExecutionHints {
  sandboxPreference?: string[];
  strategy?: string;
  maxCost?: number;
  qualityTarget?: number;
  timeoutMs?: number;
  allowFallback?: boolean;
}

interface CapabilityExecutionEnvelope {
  input?: unknown;
  messages?: ChatMessage[];
  options?: Record<string, unknown>;
  execution?: CapabilityExecutionHints;
}

interface CapabilityModeResult {
  data: unknown;
  resolvedProvider?: string;
  resolvedModel?: string;
  executionPath: CapabilityExecutionMode;
}

const AUDIO_FORMATS = new Set(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']);
const TRANSCRIPTION_FORMATS = new Set(['json', 'text', 'srt', 'verbose_json', 'vtt']);
const IMAGE_SIZES = new Set(['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792']);
const IMAGE_EDIT_SIZES = new Set(['256x256', '512x512', '1024x1024']);

const CHAT_ORCHESTRATION_CAPABILITIES = new Set<ModelCapability>([
  'chat',
  'text_generation',
  'completions',
  'reasoning',
  'thinking_mode',
  'analysis',
  'qa',
  'json_mode',
  'function_calling',
  'tool_use',
  'documentation',
  'health',
  'deep_compute',
  'research',
  'pdf_understanding',
]);

const SEARCH_CAPABILITIES = new Set<ModelCapability>([
  'web_search',
  'deep_search',
  'deep_research',
  'file_search',
  'research',
]);

const CODE_CAPABILITIES = new Set<ModelCapability>([
  'code_generation',
  'code_completion',
  'coding',
  'code_review',
  'debugging',
  'refactoring',
  'testing',
  'code_interpreter',
  'computer_use',
  'agents',
  'mcp',
]);

const AUDIO_TRANSCRIPTION_CAPABILITIES = new Set<ModelCapability>([
  'speech_to_text',
  'transcription',
  'audio_input',
  'listen',
  'diarization',
  'video_to_text',
  'video_transcription',
]);

const AUDIO_SYNTH_CAPABILITIES = new Set<ModelCapability>([
  'text_to_speech',
  'tts',
  'audio_generation',
  'audio_output',
]);

const REALTIME_STREAM_ONLY = new Set<ModelCapability>(['realtime', 'realtime_audio', 'audio_to_audio']);

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function decodeBase64Payload(value: unknown, fieldName: string): Buffer {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} is required and must be a base64 string`);
  }

  const raw = value.includes(',') ? value.split(',').pop() ?? value : value;
  return Buffer.from(raw, 'base64');
}

function buildCapabilityError(
  capability: string,
  reason: string,
  details?: Record<string, unknown>,
  code = 'capability_dependency_unavailable',
  statusCode = 422
): Error & {
  statusCode: number;
  code: string;
  type: string;
  details?: Record<string, unknown>;
} {
  const err = new Error(reason) as Error & {
    statusCode: number;
    code: string;
    type: string;
    details?: Record<string, unknown>;
  };
  err.statusCode = statusCode;
  err.code = code;
  err.type = 'capability_error';
  err.details = {
    capability,
    ...details,
  };
  return err;
}

function getUserContext(request: FastifyRequest) {
  const extendedRequest = request as ExtendedFastifyRequest;
  return extendedRequest.userContext || createOrchestrationContext(request);
}

function collectForwardHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const source = request.headers;
  const keepHeaders = [
    'authorization',
    'x-api-key',
    'x-organization-id',
    'x-request-id',
    'x-signature',
    'x-timestamp',
    'x-nonce',
  ];

  for (const name of keepHeaders) {
    const value = source[name];
    if (typeof value === 'string' && value.length > 0) {
      headers[name] = value;
    }
  }

  headers['content-type'] = 'application/json';
  return headers;
}

async function proxyJsonRequest(
  request: FastifyRequest,
  url: string,
  payload: CapabilityRequestBody
): Promise<unknown> {
  const forwarded = await request.server.inject({
    method: 'POST',
    url,
    headers: collectForwardHeaders(request),
    payload,
  });

  const contentType = forwarded.headers['content-type'];
  const isJson = typeof contentType === 'string' && contentType.includes('application/json');
  // The forwarded body is opaque from the route's perspective; we keep
  // the parsed shape as `unknown` and let downstream consumers narrow it.
  const parsedPayload: unknown = isJson
    ? JSON.parse(forwarded.payload || '{}')
    : forwarded.payload;

  if (forwarded.statusCode >= 400) {
    throw buildCapabilityError('proxy_route', `Proxy execution failed for ${url}`, {
      upstreamPath: url,
      upstreamStatusCode: forwarded.statusCode,
      upstreamPayload: parsedPayload,
    });
  }

  return parsedPayload;
}

async function forwardJsonRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  url: string,
  payload: CapabilityRequestBody
): Promise<void> {
  const forwarded = await request.server.inject({
    method: 'POST',
    url,
    headers: collectForwardHeaders(request),
    payload,
  });

  const contentType = forwarded.headers['content-type'];
  if (typeof contentType === 'string') {
    reply.header('Content-Type', contentType);
  }

  reply.code(forwarded.statusCode);
  if (typeof contentType === 'string' && contentType.includes('application/json')) {
    return reply.send(JSON.parse(forwarded.payload || '{}'));
  }

  return reply.send(forwarded.rawPayload);
}

function parseEnvelope(body: CapabilityRequestBody): CapabilityExecutionEnvelope {
  const hasEnvelopeFields =
    Object.prototype.hasOwnProperty.call(body, 'input') ||
    Object.prototype.hasOwnProperty.call(body, 'messages') ||
    Object.prototype.hasOwnProperty.call(body, 'options') ||
    Object.prototype.hasOwnProperty.call(body, 'execution');

  if (!hasEnvelopeFields) {
    return {
      input: body,
      options: body,
      execution: {},
    };
  }

  const input = body.input;
  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : undefined;
  const options =
    body.options && typeof body.options === 'object' && !Array.isArray(body.options)
      ? (body.options as Record<string, unknown>)
      : {};

  const executionRaw =
    body.execution && typeof body.execution === 'object' && !Array.isArray(body.execution)
      ? (body.execution as Record<string, unknown>)
      : {};

  const sandboxPreferenceRaw = executionRaw.sandboxPreference;
  let sandboxPreference: string[] | undefined;
  if (typeof sandboxPreferenceRaw === 'string') {
    sandboxPreference = [sandboxPreferenceRaw];
  } else if (Array.isArray(sandboxPreferenceRaw)) {
    sandboxPreference = sandboxPreferenceRaw.filter((item): item is string => typeof item === 'string');
  }

  return {
    input,
    messages,
    options,
    execution: {
      sandboxPreference,
      strategy: asString(executionRaw.strategy),
      maxCost: asNumber(executionRaw.maxCost),
      qualityTarget: asNumber(executionRaw.qualityTarget),
      timeoutMs: asNumber(executionRaw.timeoutMs),
      allowFallback: asBoolean(executionRaw.allowFallback, true),
    },
  };
}

function deriveTextInput(body: CapabilityRequestBody, envelope: CapabilityExecutionEnvelope): string {
  const fromInput = asString(envelope.input);
  if (fromInput) return fromInput;

  const candidate =
    asString(body.prompt) ??
    asString(body.query) ??
    asString(body.text) ??
    asString(body.input) ??
    asString(body.code) ??
    asString(body.content);
  if (candidate) return candidate;

  if (envelope.input && typeof envelope.input === 'object') {
    return JSON.stringify(envelope.input);
  }
  return 'No explicit input provided.';
}

function deriveMessages(
  body: CapabilityRequestBody,
  envelope: CapabilityExecutionEnvelope,
  capability: string
): ChatMessage[] {
  if (Array.isArray(envelope.messages) && envelope.messages.length > 0) {
    return envelope.messages;
  }

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages as ChatMessage[];
  }

  const textInput = deriveTextInput(body, envelope);
  return [
    {
      role: 'user',
      content: `Capability: ${capability}\n\n${textInput}`,
    },
  ];
}

function normalizedEnvelopeResponse(
  capability: string,
  requestId: string,
  mode: CapabilityExecutionMode,
  data: unknown,
  fallbackUsed: boolean,
  durationMs: number,
  resolvedProvider?: string,
  resolvedModel?: string
) {
  return {
    object: 'capability.result',
    capability,
    data,
    _ailin: {
      resolved_capability: capability,
      resolved_provider: resolvedProvider ?? null,
      resolved_model: resolvedModel ?? null,
      execution_path: mode,
      fallback_used: fallbackUsed,
      duration_ms: durationMs,
      request_id: requestId,
    },
  };
}

function getProxyTarget(capability: ModelCapability): string | null {
  if (capability === 'chat' || capability === 'completions' || capability === 'text_generation') {
    return '/v1/chat/completions';
  }
  if (capability === 'embeddings' || capability === 'embedding') {
    return '/v1/embeddings';
  }
  if (SEARCH_CAPABILITIES.has(capability)) {
    return '/v1/search';
  }
  return null;
}

async function executeNativeAdapterMode(
  capability: ModelCapability,
  body: CapabilityRequestBody,
  envelope: CapabilityExecutionEnvelope,
  request: FastifyRequest,
  requestId: string,
  services: {
    audio: AudioOrchestrationService;
    image: ImagesOrchestrationService;
    video: VideoOrchestrationService;
    search: SearchOrchestrationService;
    moderation: ModerationsOrchestrationService;
  }
): Promise<CapabilityModeResult> {
  const userContext = getUserContext(request);
  const envelopeInput =
    envelope.input && typeof envelope.input === 'object' && !Array.isArray(envelope.input)
      ? (envelope.input as CapabilityRequestBody)
      : {};
  const envelopeOptions =
    envelope.options && typeof envelope.options === 'object'
      ? (envelope.options as CapabilityRequestBody)
      : {};
  const requestBody: CapabilityRequestBody = {
    ...envelopeInput,
    ...envelopeOptions,
    ...body,
  };
  const strategy = asString(requestBody.strategy) ?? envelope.execution?.strategy;
  const allowFallback =
    requestBody.allow_fallback !== undefined
      ? asBoolean(requestBody.allow_fallback, true)
      : envelope.execution?.allowFallback ?? true;
  const maxCost = asNumber(requestBody.max_cost) ?? envelope.execution?.maxCost;
  const qualityTarget = asNumber(requestBody.quality_target) ?? envelope.execution?.qualityTarget;
  const executionUserContext = {
    ...userContext,
    ...(maxCost !== undefined ? { maxCost } : {}),
    ...(qualityTarget !== undefined ? { qualityTarget } : {}),
  };

  if (AUDIO_SYNTH_CAPABILITIES.has(capability)) {
    const input =
      asString(requestBody.input) ??
      asString(requestBody.text) ??
      deriveTextInput(requestBody, envelope);
    if (!input) {
      throw buildCapabilityError(capability, 'input (or text) is required for speech synthesis');
    }

    const responseFormatRaw =
      asString(requestBody.response_format) ?? asString(requestBody.format) ?? 'mp3';
    const responseFormat = AUDIO_FORMATS.has(responseFormatRaw) ? responseFormatRaw : 'mp3';
    const speed = asNumber(requestBody.speed) ?? 1.0;

    const result = await services.audio.synthesizeSpeech({
      text: input,
      model: asString(requestBody.model),
      voice: asString(requestBody.voice),
      format: responseFormat as 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm',
      speed,
      strategy,
      allowFallback,
      userContext: executionUserContext,
      requestId,
    });

    return {
      data: {
        audio_base64: result.audioBuffer.toString('base64'),
        format: result.format,
      },
      resolvedProvider: result.provider,
      resolvedModel: result.modelUsed,
      executionPath: 'native_adapter',
    };
  }

  if (AUDIO_TRANSCRIPTION_CAPABILITIES.has(capability)) {
    const audioBuffer = decodeBase64Payload(
      requestBody.audio_base64 ?? requestBody.audio,
      'audio_base64'
    );
    const filename = asString(requestBody.filename) ?? 'audio.wav';
    const responseFormatRaw = asString(requestBody.response_format) ?? 'json';
    const responseFormat = TRANSCRIPTION_FORMATS.has(responseFormatRaw) ? responseFormatRaw : 'json';

    const transcription = await services.audio.transcribeAudio({
      audioBuffer,
      filename,
      model: asString(requestBody.model),
      language: asString(requestBody.language),
      prompt: asString(requestBody.prompt),
      responseFormat: responseFormat as 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt',
      temperature: asNumber(requestBody.temperature) ?? 0,
      timestampGranularities: asStringArray(requestBody.timestamp_granularities).filter(
        (item): item is 'word' | 'segment' => item === 'word' || item === 'segment'
      ),
      strategy,
      allowFallback,
      userContext: executionUserContext,
      requestId,
    });

    return {
      data: {
        text: transcription.text,
        language: transcription.language,
        duration: transcription.duration,
        words: transcription.words,
        segments: transcription.segments,
        srt: transcription.srt,
        vtt: transcription.vtt,
      },
      resolvedProvider: transcription.provider,
      resolvedModel: transcription.modelUsed,
      executionPath: 'native_adapter',
    };
  }

  if (capability === 'audio_to_audio') {
    throw buildCapabilityError(
      capability,
      'audio_to_audio requires realtime websocket session and cannot execute via HTTP JSON',
      { requiredEndpoint: '/v1/realtime' }
    );
  }

  if (capability === 'image_generation') {
    const prompt = asString(requestBody.prompt) ?? deriveTextInput(requestBody, envelope);
    if (!prompt) throw buildCapabilityError(capability, 'prompt is required for image generation');

    const sizeRaw = asString(requestBody.size) ?? '1024x1024';
    const size = IMAGE_SIZES.has(sizeRaw) ? sizeRaw : '1024x1024';
    const qualityRaw = asString(requestBody.quality) ?? 'standard';
    const quality = qualityRaw === 'hd' ? 'hd' : 'standard';
    const styleRaw = asString(requestBody.style) ?? 'vivid';
    const style = styleRaw === 'natural' ? 'natural' : 'vivid';
    const responseFormatRaw = asString(requestBody.response_format) ?? 'url';
    const responseFormat = responseFormatRaw === 'b64_json' ? 'b64_json' : 'url';
    const n = Math.max(1, Math.min(10, asNumber(requestBody.n) ?? 1));

    const result = await services.image.generateImages({
      prompt,
      model: asString(requestBody.model),
      n,
      size: size as '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792',
      quality,
      responseFormat,
      style,
      strategy,
      allowFallback,
      userContext: executionUserContext,
      requestId,
    });

    return {
      data: { created: Math.floor(Date.now() / 1000), data: result.images },
      resolvedProvider: result.provider,
      resolvedModel: result.modelUsed,
      executionPath: 'native_adapter',
    };
  }

  if (capability === 'image_editing') {
    const imageBuffer = decodeBase64Payload(
      requestBody.image_base64 ?? requestBody.image,
      'image_base64'
    );
    const maskBuffer =
      requestBody.mask_base64 !== undefined
        ? decodeBase64Payload(requestBody.mask_base64, 'mask_base64')
        : undefined;
    const prompt = asString(requestBody.prompt) ?? deriveTextInput(requestBody, envelope);
    if (!prompt) throw buildCapabilityError(capability, 'prompt is required for image editing');
    const sizeRaw = asString(requestBody.size) ?? '1024x1024';
    const size = IMAGE_EDIT_SIZES.has(sizeRaw) ? sizeRaw : '1024x1024';
    const responseFormatRaw = asString(requestBody.response_format) ?? 'url';
    const responseFormat = responseFormatRaw === 'b64_json' ? 'b64_json' : 'url';
    const n = Math.max(1, Math.min(10, asNumber(requestBody.n) ?? 1));

    const result = await services.image.editImage({
      image: imageBuffer,
      mask: maskBuffer,
      prompt,
      model: asString(requestBody.model),
      n,
      size: size as '256x256' | '512x512' | '1024x1024',
      responseFormat,
      strategy,
      allowFallback,
      userContext: executionUserContext,
      requestId,
    });

    return {
      data: { created: Math.floor(Date.now() / 1000), data: result.images },
      resolvedProvider: result.provider,
      resolvedModel: result.modelUsed,
      executionPath: 'native_adapter',
    };
  }

  if (
    capability === 'video_generation' ||
    capability === 'image_to_video' ||
    capability === 'video_to_video' ||
    capability === 'video_editing'
  ) {
    const prompt = asString(requestBody.prompt) ?? deriveTextInput(requestBody, envelope);
    if (!prompt) throw buildCapabilityError(capability, 'prompt is required for video generation');

    const result = await services.video.generateVideo({
      prompt,
      model: asString(requestBody.model),
      image:
        asString(requestBody.image) ??
        asString(requestBody.image_url) ??
        asString(requestBody.image_base64),
      startImage:
        asString(requestBody.start_image) ??
        asString(requestBody.start_image_url) ??
        asString(requestBody.start_image_base64),
      endImage:
        asString(requestBody.end_image) ??
        asString(requestBody.end_image_url) ??
        asString(requestBody.end_image_base64),
      audio:
        asString(requestBody.audio) ??
        asString(requestBody.audio_url) ??
        asString(requestBody.audio_base64),
      video:
        asString(requestBody.video) ??
        asString(requestBody.video_url) ??
        asString(requestBody.video_base64),
      duration: asNumber(requestBody.duration),
      aspectRatio: asString(requestBody.aspect_ratio),
      size: asString(requestBody.size),
      n: asNumber(requestBody.n),
      responseFormat: asString(requestBody.response_format) === 'b64_json' ? 'b64_json' : 'url',
      strategy,
      allowFallback,
      userContext: executionUserContext,
      requestId,
    });

    return {
      data: { created: Math.floor(Date.now() / 1000), data: result.videos },
      resolvedProvider: result.provider,
      resolvedModel: result.modelUsed,
      executionPath: 'native_adapter',
    };
  }

  if (capability === 'analysis' && Array.isArray(requestBody.input)) {
    const moderation = await services.moderation.moderateContent({
      inputs: requestBody.input.filter((item): item is string => typeof item === 'string'),
      model: asString(requestBody.model),
      userContext: executionUserContext,
      requestId,
    });
    return {
      data: {
        object: 'list',
        data: moderation.results,
      },
      resolvedProvider: moderation.provider,
      resolvedModel: moderation.modelUsed,
      executionPath: 'native_adapter',
    };
  }

  throw buildCapabilityError(capability, `No native adapter executor available for ${capability}`, {
    executionMode: 'native_adapter',
  });
}

async function executeToolPipelineMode(
  capability: ModelCapability,
  body: CapabilityRequestBody,
  envelope: CapabilityExecutionEnvelope,
  request: FastifyRequest,
  requestId: string,
  services: {
    search: SearchOrchestrationService;
  }
): Promise<CapabilityModeResult> {
  const userContext = getUserContext(request);

  if (SEARCH_CAPABILITIES.has(capability)) {
    const query = asString(body.query) ?? deriveTextInput(body, envelope);
    if (!query) throw buildCapabilityError(capability, 'query is required for search capability');

    const depthRaw = asString(body.search_depth) ?? asString(body.depth) ?? 'basic';
    const searchDepth = depthRaw === 'advanced' ? 'advanced' : 'basic';
    const maxResults = Math.max(1, Math.min(100, asNumber(body.max_results) ?? 10));

    const result = await services.search.performSearch({
      query,
      model: asString(body.model),
      searchDepth,
      maxResults,
      includeImages: asBoolean(body.include_images, false),
      includeAnswer: asBoolean(body.include_answer, true),
      includeRawContent: asBoolean(body.include_raw_content, false),
      includeDomains: asStringArray(body.include_domains),
      excludeDomains: asStringArray(body.exclude_domains),
      topic:
        (asString(body.topic) as 'general' | 'news' | 'finance' | undefined) ??
        (capability === 'deep_search' || capability === 'deep_research' ? 'news' : 'general'),
      userContext,
      requestId,
    });

    return {
      data: {
        answer: result.answer,
        results: result.results,
        images: result.images,
      },
      resolvedProvider: result.providerUsed,
      resolvedModel: result.modelUsed,
      executionPath: 'tool_pipeline',
    };
  }

  throw buildCapabilityError(capability, `No tool pipeline executor available for ${capability}`, {
    executionMode: 'tool_pipeline',
  });
}

async function executeSandboxWorkflowMode(
  capability: ModelCapability,
  body: CapabilityRequestBody,
  envelope: CapabilityExecutionEnvelope,
  request: FastifyRequest,
  requestId: string,
  codeExecutionService: CodeExecutionService
): Promise<CapabilityModeResult> {
  if (!CODE_CAPABILITIES.has(capability)) {
    throw buildCapabilityError(capability, `No sandbox workflow executor available for ${capability}`, {
      executionMode: 'sandbox_workflow',
    });
  }

  const userContext = getUserContext(request);
  const code = asString(body.code) ?? asString(body.input) ?? asString(envelope.input);
  if (!code) {
    throw buildCapabilityError(capability, 'code is required for sandbox workflow execution');
  }

  const languageRaw = asString(body.language) ?? 'python';
  const allowedLanguages = new Set(['javascript', 'typescript', 'python', 'java', 'csharp', 'go']);
  const language = allowedLanguages.has(languageRaw) ? languageRaw : 'python';
  const timeoutMs = asNumber(body.timeoutMs) ?? envelope.execution?.timeoutMs ?? 30000;
  const functionName = asString(body.functionName) ?? asString(body.function_name);
  const tests = Array.isArray(body.tests)
    ? (body.tests as Array<{ args: unknown[]; expected: unknown }>)
    : undefined;

  const result = await codeExecutionService.executeCode({
    code,
    language: language as 'javascript' | 'typescript' | 'python' | 'java' | 'csharp' | 'go',
    functionName,
    tests,
    timeoutMs,
    userContext,
    requestId,
  });

  if (!result.success) {
    throw buildCapabilityError(capability, result.error || 'Sandbox workflow execution failed', {
      executionMode: 'sandbox_workflow',
    });
  }

  return {
    data: result,
    resolvedProvider: result.provider,
    resolvedModel: result.modelUsed,
    executionPath: 'sandbox_workflow',
  };
}

async function executeOrchestrationMode(
  capability: ModelCapability,
  body: CapabilityRequestBody,
  envelope: CapabilityExecutionEnvelope,
  request: FastifyRequest
): Promise<CapabilityModeResult> {
  const userContext = getUserContext(request);
  const capabilityExecutionService = getCapabilityExecutionService();
  const orchestrationBody = {
    ...(envelope.options && typeof envelope.options === 'object'
      ? (envelope.options as CapabilityRequestBody)
      : {}),
    ...body,
  };
  const messages = deriveMessages(orchestrationBody, envelope, capability);
  const maxCost = asNumber(orchestrationBody.max_cost) ?? envelope.execution?.maxCost;
  const qualityTarget =
    asNumber(orchestrationBody.quality_target) ?? envelope.execution?.qualityTarget;
  const strategy = asString(orchestrationBody.strategy) ?? envelope.execution?.strategy;

  const result = await capabilityExecutionService.executeWithCapabilities(messages, {
    requiredCapabilities: getModelCapabilitiesForCapability(capability),
    organizationId: userContext.organizationId,
    userId: userContext.userId,
    maxCost,
    qualityTarget,
    strategy,
    taskType: asString(orchestrationBody.task_type) as
      | 'general'
      | 'analysis'
      | 'qa'
      | 'code-generation'
      | 'code-review'
      | 'debugging'
      | 'refactoring'
      | 'documentation'
      | 'testing'
      | undefined,
  });

  if (!result.success || !result.response) {
    throw buildCapabilityError(
      capability,
      result.error || 'Orchestration execution failed',
      {
        executionMode: 'orchestration',
      },
      'capability_dependency_unavailable'
    );
  }

  return {
    data: result.response,
    resolvedProvider: result.providerUsed,
    resolvedModel: result.modelUsed,
    executionPath: 'orchestration',
  };
}

async function executeProxyMode(
  capability: ModelCapability,
  body: CapabilityRequestBody,
  envelope: CapabilityExecutionEnvelope,
  request: FastifyRequest
): Promise<CapabilityModeResult> {
  const target = getProxyTarget(capability);
  if (!target) {
    throw buildCapabilityError(capability, `No proxy target configured for ${capability}`, {
      executionMode: 'proxy_route',
    });
  }

  const payload: CapabilityRequestBody = { ...body };
  if (target === '/v1/chat/completions') {
    payload.messages = deriveMessages(body, envelope, capability);
    payload.stream = false;
  }
  if (target === '/v1/search' && !payload.query) {
    payload.query = deriveTextInput(body, envelope);
  }

  const proxyResult = await proxyJsonRequest(request, target, payload);
  return {
    data: proxyResult,
    executionPath: 'proxy_route',
  };
}

async function executeCapabilityByPlan(
  plan: CapabilityExecutionPlan,
  body: CapabilityRequestBody,
  envelope: CapabilityExecutionEnvelope,
  request: FastifyRequest,
  requestId: string,
  services: {
    audio: AudioOrchestrationService;
    image: ImagesOrchestrationService;
    video: VideoOrchestrationService;
    search: SearchOrchestrationService;
    moderation: ModerationsOrchestrationService;
    code: CodeExecutionService;
  }
): Promise<{ result: CapabilityModeResult; fallbackUsed: boolean }> {
  const attempts: Array<{ mode: CapabilityExecutionMode; reason: string }> = [];

  for (const [index, mode] of plan.executionPath.entries()) {
    try {
      let modeResult: CapabilityModeResult;

      if (mode === 'proxy_route') {
        modeResult = await executeProxyMode(plan.id, body, envelope, request);
      } else if (mode === 'native_adapter') {
        modeResult = await executeNativeAdapterMode(plan.id, body, envelope, request, requestId, {
          audio: services.audio,
          image: services.image,
          video: services.video,
          search: services.search,
          moderation: services.moderation,
        });
      } else if (mode === 'tool_pipeline') {
        modeResult = await executeToolPipelineMode(plan.id, body, envelope, request, requestId, {
          search: services.search,
        });
      } else if (mode === 'sandbox_workflow') {
        modeResult = await executeSandboxWorkflowMode(
          plan.id,
          body,
          envelope,
          request,
          requestId,
          services.code
        );
      } else {
        modeResult = await executeOrchestrationMode(plan.id, body, envelope, request);
      }

      return {
        result: modeResult,
        fallbackUsed: index > 0,
      };
    } catch (error) {
      const err = error as { message?: string };
      attempts.push({
        mode,
        reason: err.message || 'execution_failed',
      });
      log.warn(
        { capability: plan.id, mode, error: err.message, requestId },
        'Capability execution mode failed'
      );
    }
  }

  throw buildCapabilityError(
    plan.id,
    `Capability ${plan.id} is currently unavailable across configured execution paths`,
    {
      executionPath: plan.executionPath,
      attempts,
      dependencies: plan.dependencies,
    }
  );
}

export async function registerCapabilitiesRoutes(server: FastifyInstance): Promise<void> {
  const audioService = new AudioOrchestrationService();
  const imageService = new ImagesOrchestrationService();
  const videoService = new VideoOrchestrationService();
  const searchService = new SearchOrchestrationService();
  const moderationService = new ModerationsOrchestrationService();
  const codeExecutionService = new CodeExecutionService();

  server.post<{ Params: { capability: string }; Body: CapabilityRequestBody }>(
    '/v1/capabilities/:capability/execute',
    {
      schema: {
        tags: ['Capabilities'],
        description:
          'Universal capability execution endpoint with capability-plan driven dispatch, fallback execution paths, and normalized result envelope.',
      },
      preHandler: [authenticateRequest, requireTenantContext()],
    },
    async (request, reply) => {
      const capabilityInput = request.params.capability;
      const normalizedCapability = normalizeCapabilityName(capabilityInput);
      const definition = getCapabilityExecutionPlan(normalizedCapability);
      const body = request.body || {};
      const envelope = parseEnvelope(body);
      const requestId = request.id;
      const start = Date.now();

      try {
        if (!definition && !isModelCapability(normalizedCapability)) {
          throw buildCapabilityError(
            normalizedCapability,
            `Unsupported capability: ${capabilityInput}`,
            {
              availableCapabilities: listCapabilityDefinitions().map((item) => item.id),
            },
            'capability_not_supported',
            422
          );
        }

        const capabilityId = (definition?.id ?? normalizedCapability) as ModelCapability;

        const dynamicPlan: CapabilityExecutionPlan =
          definition ??
          ({
            id: capabilityId,
            aliases: [capabilityId],
            modelCapabilities: [capabilityId],
            supportsExecute: true,
            supportsStream: capabilityId === 'chat' || capabilityId === 'streaming',
            maturity: 'stable',
            executionPath: CHAT_ORCHESTRATION_CAPABILITIES.has(capabilityId)
              ? ['orchestration']
              : ['orchestration'],
            requiredCapabilities: [capabilityId],
            dependencies: ['provider_registry', 'model_catalog', 'tenant_policy'],
          } satisfies CapabilityExecutionPlan);

        if (!dynamicPlan.supportsExecute) {
          throw buildCapabilityError(
            dynamicPlan.id,
            `Capability ${dynamicPlan.id} does not support execute mode`,
            {
              support: { execute: dynamicPlan.supportsExecute, stream: dynamicPlan.supportsStream },
            }
          );
        }

        const execution = await executeRouteWithRetry(
          () =>
            executeCapabilityByPlan(dynamicPlan, body, envelope, request, requestId, {
              audio: audioService,
              image: imageService,
              video: videoService,
              search: searchService,
              moderation: moderationService,
              code: codeExecutionService,
            }),
          {
            operationName: `POST /v1/capabilities/${dynamicPlan.id}/execute`,
            requestId,
            log,
            isIdempotent: true,
            maxAttempts: 3,
            baseDelayMs: 200,
            maxDelayMs: 1200,
          }
        );

        const durationMs = Date.now() - start;
        return reply.send(
          normalizedEnvelopeResponse(
            dynamicPlan.id,
            requestId,
            execution.result.executionPath,
            execution.result.data,
            execution.fallbackUsed,
            durationMs,
            execution.result.resolvedProvider,
            execution.result.resolvedModel
          )
        );
      } catch (error: unknown) {
        const err = error as {
          statusCode?: number;
          code?: string;
          type?: string;
          details?: Record<string, unknown>;
          message?: string;
        };
        const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
        const code =
          typeof err.code === 'string'
            ? err.code
            : statusCode >= 400 && statusCode < 500
              ? 'capability_dependency_unavailable'
              : 'internal_error';
        const type = typeof err.type === 'string' ? err.type : 'capability_error';
        const message = err.message || `Capability ${normalizedCapability} execution failed`;
        log.warn(
          { capability: normalizedCapability, error: message, requestId },
          'Capability execute failed'
        );
        return reply.code(statusCode).send({
          error: {
            code,
            type,
            message,
            details: err.details,
          },
        });
      }
    }
  );

  server.post<{ Params: { capability: string }; Body: CapabilityRequestBody }>(
    '/v1/capabilities/:capability/stream',
    {
      schema: {
        tags: ['Capabilities'],
        description:
          'Universal capability streaming endpoint. Stream-capable capabilities are proxied to streaming-compatible routes.',
      },
      preHandler: [authenticateRequest, requireTenantContext()],
    },
    async (request, reply) => {
      const capability = normalizeCapabilityName(request.params.capability);
      const definition = getCapabilityExecutionPlan(capability);
      const body = request.body || {};
      const envelope = parseEnvelope(body);

      if (!definition && !isModelCapability(capability)) {
        return reply.code(422).send({
          error: {
            code: 'capability_not_supported',
            type: 'capability_error',
            message: `Unsupported capability: ${request.params.capability}`,
            details: {
              capability,
              availableCapabilities: listCapabilityDefinitions().map((item) => item.id),
            },
          },
        });
      }

      const capabilityId = (definition?.id ?? capability) as ModelCapability;
      const streamSupported =
        definition?.supportsStream ?? (capabilityId === 'chat' || capabilityId === 'streaming');
      if (!streamSupported) {
        return reply.code(422).send({
          error: {
            code: 'capability_stream_not_supported',
            type: 'capability_error',
            message: `Streaming is not operational for capability ${capability}`,
            details: {
              capability,
              reason: 'stream_not_supported',
            },
          },
        });
      }

      if (REALTIME_STREAM_ONLY.has(capabilityId)) {
        return reply.code(422).send({
          error: {
            code: 'capability_dependency_unavailable',
            type: 'capability_error',
            message: `Capability ${capability} requires websocket realtime session`,
            details: {
              capability,
              requiredEndpoint: '/v1/realtime',
            },
          },
        });
      }

      if (
        capabilityId === 'chat' ||
        capabilityId === 'streaming' ||
        capabilityId === 'text_generation' ||
        capabilityId === 'completions'
      ) {
        const payload: CapabilityRequestBody = {
          ...body,
          messages: deriveMessages(body, envelope, capabilityId),
          stream: true,
        };
        return forwardJsonRequest(request, reply, '/v1/chat/completions', payload);
      }

      return reply.code(422).send({
        error: {
          code: 'capability_stream_not_supported',
          type: 'capability_error',
          message: `Streaming is not currently mapped for capability ${capability}`,
          details: {
            capability,
            executionPath: definition?.executionPath ?? ['orchestration'],
          },
        },
      });
    }
  );

  server.get<{ Params: { capability: string } }>(
    '/v1/capabilities/:capability/health',
    {
      schema: {
        tags: ['Capabilities'],
        description:
          'Capability health and operability report with inventory, runnable coverage, and dependency diagnostics.',
      },
      preHandler: [authenticateRequest, requireTenantContext()],
    },
    async (request, reply) => {
      const capabilityInput = request.params.capability;
      const capability = normalizeCapabilityName(capabilityInput);
      const definition = getCapabilityExecutionPlan(capability);
      const mappedCapabilities = getModelCapabilitiesForCapability(capability);

      if (!definition && !isModelCapability(capability)) {
        return reply.code(422).send({
          error: {
            code: 'capability_not_supported',
            type: 'capability_error',
            message: `Unsupported capability: ${capabilityInput}`,
            details: {
              capability,
              availableCapabilities: listCapabilityDefinitions().map((item) => item.id),
            },
          },
        });
      }

      const allModels = await getAllCatalogModels();
      const providerRegistry = getProviderRegistry();
      const directCapability = isModelCapability(capability) ? capability : null;
      const requiredCaps =
        definition?.requiredCapabilities && definition.requiredCapabilities.length > 0
          ? definition.requiredCapabilities
          : mappedCapabilities.length > 0
            ? mappedCapabilities
            : directCapability
              ? [directCapability]
              : [];

      const candidateModels =
        requiredCaps.length > 0
          ? allModels.filter((model) => requiredCaps.every((required) => model.capabilities.includes(required)))
          : [];

      let runnableCount = 0;
      const reasonCounts = new Map<string, number>();
      const dependencyCounts = new Map<string, number>();
      const samples: Array<{
        model: string;
        provider: string;
        runnable: boolean;
        reasons: string[];
      }> = [];
      // resolveModelOperability(model) doesn't vary by capability, but the loop
      // below checks each model against every required capability — without
      // this cache it recomputed operability (string normalization + Set/array
      // allocation) once per model PER capability, for every model in the pool.
      const operabilityCache = new Map<string, ModelOperability>();

      for (const model of candidateModels) {
        let operational = true;
        const reasons: string[] = [];

        for (const requiredCapability of requiredCaps) {
          const check = isCapabilityOperationalForModel(
            model,
            requiredCapability,
            (providerName) => providerRegistry.get(providerName),
            operabilityCache
          );

          if (!check.operational) {
            operational = false;
            reasons.push(...check.operability.nonOperationalReasons);
          }
        }

        if (operational) {
          runnableCount += 1;
        } else {
          const uniqueReasons = Array.from(new Set(reasons.length > 0 ? reasons : ['not_runnable']));
          for (const reason of uniqueReasons) {
            reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
            const dependency = reason.split(':')[0];
            dependencyCounts.set(dependency, (dependencyCounts.get(dependency) ?? 0) + 1);
          }
          if (samples.length < 25) {
            samples.push({
              model: model.name,
              provider: model.provider,
              runnable: false,
              reasons: uniqueReasons,
            });
          }
        }
      }

      const topNonOperationalReasons = Array.from(reasonCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, count }));

      const dependencies = Array.from(dependencyCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([dependency, count]) => ({ dependency, affectedModels: count }));

      const executeSupported = definition?.supportsExecute ?? true;
      const streamSupported = definition?.supportsStream ?? false;
      const operational = executeSupported ? runnableCount > 0 : streamSupported;

      return reply.send({
        capability,
        aliasResolvedFrom: capabilityInput !== capability ? capabilityInput : undefined,
        operational,
        maturity: definition?.maturity ?? 'stable',
        executionPath: definition?.executionPath ?? ['orchestration'],
        requiredCapabilities: requiredCaps,
        support: {
          execute: executeSupported,
          stream: streamSupported,
        },
        inventory: {
          discovered: candidateModels.length,
          runnable: runnableCount,
          nonOperational: Math.max(0, candidateModels.length - runnableCount),
          modelCapabilities: mappedCapabilities,
        },
        topNonOperationalReasons,
        dependencies,
        sampleNonOperationalModels: samples,
      });
    }
  );

  server.get(
    '/v1/capabilities',
    {
      schema: {
        tags: ['Capabilities'],
        description: 'List complete capability matrix with execution metadata and dependency hints.',
      },
      preHandler: [authenticateRequest, requireTenantContext()],
    },
    async (_request, reply) => {
      const capabilities = listCapabilityDefinitions().map((item) => ({
        id: item.id,
        aliases: item.aliases,
        supportsExecute: item.supportsExecute,
        supportsStream: item.supportsStream,
        maturity: item.maturity,
        executionPath: item.executionPath,
        requiredCapabilities: item.requiredCapabilities,
        dependencies: item.dependencies,
      }));

      return reply.send({
        object: 'list',
        data: capabilities,
      });
    }
  );

  log.info('Capability universal routes registered');
}
