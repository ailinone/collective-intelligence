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
import { rejectAnonymousGuestKeyPreHandler } from '@/services/anonymous-quota-gate';
import { rejectChatFreeTierKeyPreHandler } from '@/services/free-tier-quota-gate';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import type { ChatMessage, ChatRequest, ModelCapability } from '@/types';
import { createOrchestrationContext, extractSemanticQueryFromMessages } from '@/utils/orchestration-context';
import { config } from '@/config';
import { MediaPlannerStrategy } from '@/core/orchestration/strategies/media-planner-strategy';
import { MediaConsensusStrategy } from '@/core/orchestration/strategies/media-consensus-strategy';
import { resolveMediaPlanRouting } from '@/core/orchestration/strategies/media-planner-gate';
import { AudioOrchestrationService } from '@/services/audio-orchestration-service';
import { MusicOrchestrationService } from '@/services/music-orchestration-service';
import { ImagesOrchestrationService } from '@/services/images-orchestration-service';
import { VideoOrchestrationService } from '@/services/video-orchestration-service';
import {
  VideoAnalysisUnavailableError,
  VideoUnderstandingService,
  type VideoAnalysisMode,
} from '@/services/video-understanding-service';
import { SearchOrchestrationService } from '@/services/search-orchestration-service';
import { ModerationsOrchestrationService } from '@/services/moderations-orchestration-service';
import { CodeExecutionService } from '@/services/code-execution-service';
import { getCapabilityExecutionService } from '@/services/capability-execution-service';
import { getRerankOrchestrationService } from '@/services/rerank-orchestration-service';
import { getRetrievalOrchestrationService } from '@/services/retrieval-orchestration-service';
import {
  getVisionOrchestrationService,
  type VisionOrchestrationService,
  type VisionTask,
} from '@/services/vision-orchestration-service';
import { PDFService } from '@/services/pdf-service';
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
import {
  isCapabilityOperationalForModel,
  type ModelOperability,
} from '@/providers/provider-operability';
import { isModelCapability } from '@/types';
import { executeRouteWithRetry } from '@/utils/route-retry';
import { toolRegistry } from '@/core/tools/tool-registry';
import type { ToolExecutionContext } from '@/services/advanced-tool-execution-service';
import {
  isComputerUseEnabled,
  isAgentsEnabled,
  isMcpClientEnabled,
} from '@/core/sandbox/sandbox-policy';

const log = logger.child({ module: 'capabilities-routes' });

// Exported for MediaPlannerStrategy (LOTE AT, Part 2): its capability
// dispatcher is typed against these so a real `executeCapabilityByPlan`
// call (bound to a live FastifyRequest at the route layer, see the
// `/v1/capabilities/media-plan/execute` route below) can be injected
// without loosening these to `unknown`/`any` at the strategy boundary.
export type CapabilityRequestBody = Record<string, unknown>;

interface CapabilityExecutionHints {
  sandboxPreference?: string[];
  strategy?: string;
  maxCost?: number;
  qualityTarget?: number;
  timeoutMs?: number;
  allowFallback?: boolean;
}

export interface CapabilityExecutionEnvelope {
  input?: unknown;
  messages?: ChatMessage[];
  options?: Record<string, unknown>;
  execution?: CapabilityExecutionHints;
}

export interface CapabilityModeResult {
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

/**
 * Capabilities the sandbox-workflow mode may serve.
 *
 * `computer_use`, `agents` and `mcp` were members until LOTE AP. That made
 * `POST /v1/capabilities/computer_use/execute` run whatever `code` field the
 * caller supplied through `CodeExecutionService` — a capability meaning
 * "control a GUI" executing arbitrary code, on `LocalProcessSandbox`
 * (child_process.spawn on the API host) whenever no isolated backend is
 * configured. They stay OUT of this set permanently: as of LOTE AV they have
 * their own real executor, `executeAgenticSandboxMode` (mode
 * `'agentic_sandbox'`, built on the isolated Docker sandbox in
 * `core/sandbox/container-sandbox.ts`), which is deliberately a different
 * dispatch branch from this one and never touches `CodeExecutionService`. See
 * the canonical `docs/adr/ADR-024-agentic-capability-execution.md`.
 */
const CODE_CAPABILITIES = new Set<ModelCapability>([
  'code_generation',
  'code_completion',
  'coding',
  'code_review',
  'debugging',
  'refactoring',
  'testing',
  'code_interpreter',
]);

/**
 * Capabilities served by `executeAgenticSandboxMode` (ADR-024, LOTE AV).
 * Each is individually gated by its own default-off flag
 * (`sandbox-policy.ts`); the dispatch branch and the isolated Docker sandbox
 * are shared, but a flag being off makes only THAT capability unavailable.
 */
const AGENTIC_SANDBOX_CAPABILITIES = new Set<ModelCapability>([
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
]);

/**
 * The video-INPUT family. These used to live in
 * `AUDIO_TRANSCRIPTION_CAPABILITIES`, which meant a caller uploading an mp4
 * had its container bytes handed to an STT provider as if they were an audio
 * stream — no demux, no frame ever reaching a vision model, and
 * `video_understanding` matching no branch at all. They now route to
 * `VideoUnderstandingService`, which demuxes the audio track into the real
 * `speech_to_text` pipeline and samples frames into the real `vision`
 * pipeline. See `services/video-understanding-service.ts`.
 */
const VIDEO_INPUT_CAPABILITIES = new Set<ModelCapability>([
  'video_understanding',
  'video_to_text',
  'video_transcription',
]);

const AUDIO_SYNTH_CAPABILITIES = new Set<ModelCapability>([
  'text_to_speech',
  'tts',
  'audio_generation',
  'audio_output',
]);

const REALTIME_STREAM_ONLY = new Set<ModelCapability>([
  'realtime',
  'realtime_audio',
  'audio_to_audio',
]);

/**
 * LOTE AP. All three declared `executionPath: ['native_adapter', ...]` in the
 * capability registry but had no branch here, so every request threw
 * `No native adapter executor available` before falling through to chat
 * orchestration. They now execute through the real `adapter.vision()` path.
 */
const VISION_CAPABILITIES = new Set<ModelCapability>([
  'vision',
  'multimodal',
  'image_captioning',
  'visual_question_answering',
]);

/**
 * LOTE AP. Fidelity-only image operations. Kept apart from `image_editing`
 * because a generative editor asked to upscale returns a different picture —
 * see `ImagesOrchestrationService.enhanceImage`.
 */
const IMAGE_ENHANCEMENT_CAPABILITIES = new Set<ModelCapability>(['image_upscale', 'image_denoise']);

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

  const raw = value.includes(',') ? (value.split(',').pop() ?? value) : value;
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
  const parsedPayload: unknown = isJson ? JSON.parse(forwarded.payload || '{}') : forwarded.payload;

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
    sandboxPreference = sandboxPreferenceRaw.filter(
      (item): item is string => typeof item === 'string'
    );
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

function deriveTextInput(
  body: CapabilityRequestBody,
  envelope: CapabilityExecutionEnvelope
): string {
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

interface RuntimeDependencyReport {
  /** Dependency name, matching the id used in the capability plan. */
  readonly dependency: string;
  readonly satisfied: boolean;
  /** Why, in a form an operator can act on. */
  readonly detail?: string;
}

/**
 * Non-model prerequisites for a capability, resolved live.
 *
 * Two capability families need something the model catalog cannot express:
 *   - the video-input family needs the ffmpeg toolchain ON THE HOST;
 *   - `diarization` needs at least one CONFIGURED adapter that declares a
 *     native diarizer (`getDiarizationSupport().native`).
 * Reporting these turns "operational: false" into an actionable answer.
 */
async function resolveRuntimeDependencies(
  capability: ModelCapability,
  videoUnderstanding: VideoUnderstandingService
): Promise<RuntimeDependencyReport[]> {
  const reports: RuntimeDependencyReport[] = [];

  if (VIDEO_INPUT_CAPABILITIES.has(capability)) {
    const readiness = await videoUnderstanding.getReadiness();
    reports.push({
      dependency: 'ffmpeg_media_toolkit',
      satisfied: readiness.available,
      detail: readiness.reason,
    });
  }

  if (AGENTIC_SANDBOX_CAPABILITIES.has(capability)) {
    const flagName =
      capability === 'computer_use'
        ? 'AGENTIC_COMPUTER_USE_ENABLED'
        : capability === 'mcp'
          ? 'MCP_CLIENT_ENABLED'
          : 'AGENTIC_AGENTS_ENABLED';
    const enabled =
      capability === 'computer_use'
        ? isComputerUseEnabled()
        : capability === 'mcp'
          ? isMcpClientEnabled()
          : isAgentsEnabled();
    reports.push({
      dependency: 'agentic_sandbox_runtime',
      satisfied: enabled,
      detail: enabled
        ? `${capability} runs inside the isolated Docker sandbox (ADR-024).`
        : `${capability} is implemented but disabled by default (ADR-024). Set ${flagName}=true to enable it.`,
    });
  }

  if (capability === 'diarization') {
    let providers: string[] = [];
    try {
      providers = getProviderRegistry()
        .getAll()
        .filter((adapter) => adapter.getDiarizationSupport().native === true)
        .map((adapter) => adapter.getName())
        .sort();
    } catch {
      providers = [];
    }
    reports.push({
      dependency: 'native_diarization_provider',
      satisfied: providers.length > 0,
      detail:
        providers.length > 0
          ? `Providers declaring native diarization: ${providers.join(', ')}`
          : 'No configured provider adapter declares native speaker diarization. Diarization is never simulated — see ADR-024 and the provider gap register.',
    });
  }

  return reports;
}

/**
 * Resolve the image payload of a vision-family request.
 *
 * Three input forms are accepted because three are in real use: a base64 or
 * data-URL string (`image_base64`), an http(s) URL (`image_url`), and the
 * generic `image` field which may be either. URLs are passed through as
 * strings rather than fetched here — `ProviderAdapter.vision()` hands them
 * straight to the provider, which avoids this process becoming an
 * unauthenticated URL fetcher (SSRF surface) on the caller's behalf.
 */
function resolveVisionImage(body: CapabilityRequestBody): Buffer | string {
  const url = asString(body.image_url);
  if (url) return url;

  const generic = asString(body.image);
  if (generic) {
    if (generic.startsWith('http://') || generic.startsWith('https://')) return generic;
    return decodeBase64Payload(generic, 'image');
  }

  return decodeBase64Payload(body.image_base64, 'image_base64');
}

/** Map a vision-family capability id onto the service's task framing. */
function resolveVisionTask(capability: ModelCapability): VisionTask {
  if (capability === 'image_captioning') return 'image_captioning';
  if (capability === 'visual_question_answering') return 'visual_question_answering';
  return 'vision';
}

async function executeVisionCapability(
  capability: ModelCapability,
  body: CapabilityRequestBody,
  envelope: CapabilityExecutionEnvelope,
  context: {
    vision: VisionOrchestrationService;
    strategy?: string;
    allowFallback: boolean;
    userContext: ReturnType<typeof getUserContext>;
    requestId: string;
  }
): Promise<CapabilityModeResult> {
  const image = resolveVisionImage(body);
  const task = resolveVisionTask(capability);

  // VQA takes its question from `question` first — an SDK modelling VQA has a
  // question field, not a prompt field — then the generic prompt fields.
  const prompt =
    task === 'visual_question_answering'
      ? (asString(body.question) ?? asString(body.prompt) ?? asString(body.query) ?? asString(envelope.input))
      : (asString(body.prompt) ?? asString(body.query) ?? asString(envelope.input));

  const detailRaw = asString(body.detail);
  const detail =
    detailRaw === 'low' || detailRaw === 'high' || detailRaw === 'auto' ? detailRaw : undefined;

  const result = await context.vision.analyzeImage({
    task,
    image,
    ...(prompt ? { prompt } : {}),
    ...(asString(body.model) ? { model: asString(body.model) } : {}),
    ...(detail ? { detail } : {}),
    ...(asNumber(body.max_tokens) !== undefined ? { maxTokens: asNumber(body.max_tokens) } : {}),
    ...(asNumber(body.temperature) !== undefined
      ? { temperature: asNumber(body.temperature) }
      : {}),
    ...(context.strategy ? { strategy: context.strategy } : {}),
    allowFallback: context.allowFallback,
    userContext: context.userContext,
    requestId: context.requestId,
  });

  return {
    // The envelope names the task-specific field so a captioning client is not
    // forced to read a generic `content` key, while `content` stays present
    // for callers that treat the whole family uniformly.
    data: {
      content: result.content,
      ...(task === 'image_captioning' ? { caption: result.content } : {}),
      ...(task === 'visual_question_answering' ? { answer: result.content } : {}),
      task: result.task,
    },
    resolvedProvider: result.provider,
    resolvedModel: result.modelUsed,
    executionPath: 'native_adapter',
  };
}

async function executeNativeAdapterMode(
  capability: ModelCapability,
  body: CapabilityRequestBody,
  envelope: CapabilityExecutionEnvelope,
  request: FastifyRequest,
  requestId: string,
  services: {
    audio: AudioOrchestrationService;
    music: MusicOrchestrationService;
    image: ImagesOrchestrationService;
    video: VideoOrchestrationService;
    videoUnderstanding: VideoUnderstandingService;
    search: SearchOrchestrationService;
    moderation: ModerationsOrchestrationService;
    vision: VisionOrchestrationService;
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
      : (envelope.execution?.allowFallback ?? true);
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
    const responseFormat = TRANSCRIPTION_FORMATS.has(responseFormatRaw)
      ? responseFormatRaw
      : 'json';

    // The `diarization` capability IS the request for speaker labels; every
    // other id in this set may opt in explicitly. `diarize` is a hard gate
    // downstream — a provider without a native diarizer is not silently
    // substituted (see AudioOrchestrationService.transcribeAudio).
    const diarize = capability === 'diarization' || asBoolean(requestBody.diarize, false);

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
      diarize,
      numSpeakers: asNumber(requestBody.num_speakers),
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
        speakers: transcription.speakers,
        diarized: transcription.diarized,
      },
      resolvedProvider: transcription.provider,
      resolvedModel: transcription.modelUsed,
      executionPath: 'native_adapter',
    };
  }

  if (VIDEO_INPUT_CAPABILITIES.has(capability)) {
    const videoBuffer = decodeBase64Payload(
      requestBody.video_base64 ?? requestBody.video,
      'video_base64'
    );
    const filename = asString(requestBody.filename) ?? 'video.mp4';
    // `video_understanding` fuses both signals; the two transcription ids
    // answer with the audio track and only sample frames when explicitly asked.
    const mode: VideoAnalysisMode =
      capability === 'video_understanding' ? 'understanding' : 'transcript';
    const responseFormatRaw = asString(requestBody.response_format) ?? 'verbose_json';
    const responseFormat = TRANSCRIPTION_FORMATS.has(responseFormatRaw)
      ? responseFormatRaw
      : 'verbose_json';
    const frameSamplingMode = asString(requestBody.frame_sampling_mode);

    const analysis = await services.videoUnderstanding
      .analyzeVideo({
        videoBuffer,
        filename,
        mode,
        prompt: asString(requestBody.prompt) ?? asString(requestBody.question),
        language: asString(requestBody.language),
        responseFormat: responseFormat as 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt',
        model: asString(requestBody.model),
        frameSampling: {
          mode: frameSamplingMode === 'scene' ? 'scene' : 'interval',
          intervalSec: asNumber(requestBody.frame_interval_seconds),
          maxFrames: asNumber(requestBody.max_frames),
        },
        includeVisualContext: asBoolean(requestBody.include_visual_context, false),
        strategy,
        allowFallback,
        userContext: executionUserContext,
        requestId,
      })
      .catch((error: unknown) => {
        // A missing ffmpeg toolchain (or an unparseable container) is an unmet
        // DEPENDENCY, not an execution failure — say which one, so the caller
        // does not retry into the orchestration fallback for nothing.
        if (error instanceof VideoAnalysisUnavailableError) {
          throw buildCapabilityError(capability, error.message, {
            executionMode: 'native_adapter',
            dependency: error.dependency,
            detail: error.detail,
          });
        }
        throw error;
      });

    return {
      data: {
        mode: analysis.mode,
        media: analysis.media,
        text: analysis.transcript?.text ?? '',
        language: analysis.transcript?.language,
        duration: analysis.transcript?.durationSec,
        segments: analysis.transcript?.segments,
        words: analysis.transcript?.words,
        srt: analysis.transcript?.srt,
        vtt: analysis.transcript?.vtt,
        frames: analysis.frames,
        summary: analysis.summary,
        warnings: analysis.warnings,
      },
      // The transcript's provider/model is the most specific attribution
      // available for the transcription ids; the fusion model is for
      // `video_understanding`. Neither is fabricated when absent.
      resolvedProvider: analysis.summaryProvider ?? analysis.transcript?.provider,
      resolvedModel: analysis.summaryModelUsed ?? analysis.transcript?.modelUsed,
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

  if (capability === 'music_generation') {
    const prompt = asString(requestBody.prompt) ?? asString(envelope.input);
    const compositionPlan =
      requestBody.composition_plan &&
      typeof requestBody.composition_plan === 'object' &&
      !Array.isArray(requestBody.composition_plan)
        ? (requestBody.composition_plan as Record<string, unknown>)
        : undefined;
    if (!prompt && !compositionPlan) {
      throw buildCapabilityError(
        capability,
        'prompt or composition_plan is required for music generation'
      );
    }

    const result = await services.music.generateMusic({
      prompt,
      compositionPlan,
      model: asString(requestBody.model),
      musicLengthMs: asNumber(requestBody.music_length_ms),
      forceInstrumental:
        requestBody.force_instrumental !== undefined
          ? asBoolean(requestBody.force_instrumental, false)
          : undefined,
      seed: asNumber(requestBody.seed),
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
      resolution: asString(requestBody.resolution),
      generateAudio:
        typeof requestBody.generate_audio === 'boolean'
          ? requestBody.generate_audio
          : typeof requestBody.generateAudio === 'boolean'
            ? requestBody.generateAudio
            : undefined,
      soundtrackAudioBase64:
        asString(requestBody.soundtrack_audio_base64) ??
        asString(requestBody.soundtrackAudioBase64),
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

  if (capability === 'reranking') {
    // `documents` may arrive at the top level, inside the envelope's `input`
    // (`{input: {query, documents}}`) or as the envelope input itself.
    const documentsRaw = Array.isArray(requestBody.documents)
      ? requestBody.documents
      : Array.isArray(envelope.input)
        ? envelope.input
        : [];
    const documents = documentsRaw.filter((item): item is string => typeof item === 'string');
    const query = asString(requestBody.query) ?? asString(requestBody.prompt);
    if (!query) {
      throw buildCapabilityError(capability, 'query is required for reranking', {}, 'invalid_request', 400);
    }
    if (documents.length === 0) {
      throw buildCapabilityError(
        capability,
        'documents must be a non-empty array of strings for reranking',
        {},
        'invalid_request',
        400
      );
    }

    const result = await getRerankOrchestrationService().rerank({
      query,
      documents,
      ...(asString(requestBody.model) ? { model: asString(requestBody.model) } : {}),
      ...(() => {
        const topN = asNumber(requestBody.top_n) ?? asNumber(requestBody.top_k);
        return topN !== undefined ? { topN } : {};
      })(),
      returnDocuments: asBoolean(requestBody.return_documents, false),
      ...(strategy ? { strategy } : {}),
      allowFallback,
      userContext: executionUserContext,
      requestId,
    });

    return {
      data: {
        object: 'list',
        results: result.results.map((item) => ({
          index: item.index,
          relevance_score: item.relevanceScore,
          ...(item.document !== undefined ? { document: item.document } : {}),
        })),
        ...(typeof result.totalTokens === 'number'
          ? { usage: { total_tokens: result.totalTokens } }
          : {}),
      },
      resolvedProvider: result.provider,
      resolvedModel: result.modelUsed,
      executionPath: 'native_adapter',
    };
  }

  if (VISION_CAPABILITIES.has(capability)) {
    return executeVisionCapability(capability, requestBody, envelope, {
      vision: services.vision,
      strategy,
      allowFallback,
      userContext: executionUserContext,
      requestId,
    });
  }

  if (IMAGE_ENHANCEMENT_CAPABILITIES.has(capability)) {
    const imageBuffer = decodeBase64Payload(
      requestBody.image_base64 ?? requestBody.image,
      'image_base64'
    );
    const responseFormatRaw = asString(requestBody.response_format) ?? 'b64_json';
    const responseFormat = responseFormatRaw === 'url' ? 'url' : 'b64_json';

    const result = await services.image.enhanceImage({
      image: imageBuffer,
      capability,
      model: asString(requestBody.model),
      ...(asNumber(requestBody.upscale_factor) !== undefined
        ? { upscaleFactor: asNumber(requestBody.upscale_factor) }
        : {}),
      ...(asNumber(requestBody.noise_reduction) !== undefined
        ? { noiseReduction: asNumber(requestBody.noise_reduction) }
        : {}),
      ...(asNumber(requestBody.sharpen) !== undefined
        ? { sharpen: asNumber(requestBody.sharpen) }
        : {}),
      ...(asString(requestBody.prompt) ? { prompt: asString(requestBody.prompt) } : {}),
      responseFormat,
      ...(strategy ? { strategy } : {}),
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
    pdf: PDFService;
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

  // The two branches below accept the ENVELOPE form as well as the flat one
  // (`{input: {...}}` / `{options: {...}}`), because a capability like
  // retrieval carries structured arguments — `vector_store_ids` — that
  // callers naturally nest under `input`. The search branch above predates
  // the envelope and is left reading `body` directly so its behaviour is
  // untouched.
  const envelopeBody: CapabilityRequestBody = {
    ...(envelope.input && typeof envelope.input === 'object' && !Array.isArray(envelope.input)
      ? (envelope.input as CapabilityRequestBody)
      : {}),
    ...(envelope.options && typeof envelope.options === 'object'
      ? (envelope.options as CapabilityRequestBody)
      : {}),
    ...body,
  };

  if (capability === 'retrieval') {
    const query = asString(envelopeBody.query) ?? deriveTextInput(body, envelope);
    const storeIds = asStringArray(
      envelopeBody.vector_store_ids ?? envelopeBody.vectorStoreIds
    );

    const result = await getRetrievalOrchestrationService().retrieve({
      query,
      vectorStoreIds: storeIds,
      ...(asNumber(envelopeBody.top_k) !== undefined
        ? { topK: asNumber(envelopeBody.top_k) }
        : {}),
      ...(asNumber(envelopeBody.max_chunks) !== undefined
        ? { maxChunks: asNumber(envelopeBody.max_chunks) }
        : {}),
      ...(asNumber(envelopeBody.score_threshold) !== undefined
        ? { scoreThreshold: asNumber(envelopeBody.score_threshold) }
        : {}),
      ...(asStringArray(envelopeBody.file_ids).length > 0
        ? { fileIds: asStringArray(envelopeBody.file_ids) }
        : {}),
      rerank: asBoolean(envelopeBody.rerank, false),
      ...(asString(envelopeBody.rerank_model)
        ? { rerankModel: asString(envelopeBody.rerank_model) }
        : {}),
      userContext,
      requestId,
    });

    return {
      data: {
        object: 'retrieval.results',
        query,
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
        rerank: result.rerank,
        retrieved_count: result.retrievedCount,
        failed_store_ids: result.failedStoreIds,
      },
      // Retrieval resolves a reranker only when stage 2 actually ran; the
      // vector stage is local infrastructure, not a provider, so reporting a
      // provider for a stage-1-only result would be a lie.
      ...(result.rerank.applied
        ? { resolvedProvider: result.rerank.provider, resolvedModel: result.rerank.model }
        : {}),
      executionPath: 'tool_pipeline',
    };
  }

  if (capability === 'pdf_understanding') {
    // The capability surface takes the document inline (base64) — the
    // multipart form belongs to POST /v1/pdf/analyze. `file`/`pdf`/`document`
    // are all accepted because the ontology's aliases (`pdf`, `ocr`,
    // `document_understanding`) set three different caller expectations.
    const pdfBuffer = decodeBase64Payload(
      envelopeBody.pdf_base64 ??
        envelopeBody.file ??
        envelopeBody.pdf ??
        envelopeBody.document ??
        envelope.input,
      'pdf_base64'
    );

    const result = await services.pdf.analyzePDF({
      pdfBuffer,
      filename: asString(envelopeBody.filename) ?? 'document.pdf',
      ...(asString(envelopeBody.prompt) ?? asString(envelopeBody.query)
        ? { prompt: asString(envelopeBody.prompt) ?? asString(envelopeBody.query) }
        : {}),
      ...(asString(envelopeBody.model) ? { model: asString(envelopeBody.model) } : {}),
      ...(asNumber(envelopeBody.max_pages) !== undefined
        ? { maxPages: asNumber(envelopeBody.max_pages) }
        : {}),
      ...(typeof envelopeBody.force_ocr === 'boolean'
        ? { forceOcr: envelopeBody.force_ocr }
        : {}),
      userContext,
      requestId,
    });

    return {
      data: {
        text: result.text,
        ...(result.summary !== undefined ? { summary: result.summary } : {}),
        ...(result.extractedData !== undefined ? { extracted_data: result.extractedData } : {}),
        metadata: result.metadata,
        extraction: result.extraction,
      },
      // Both are null when extraction alone answered the request (a digital
      // PDF with no analysis prompt never reaches a provider) — reporting a
      // model for that would misattribute work nobody did.
      ...(result.provider ? { resolvedProvider: result.provider } : {}),
      ...(result.modelUsed ? { resolvedModel: result.modelUsed } : {}),
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
    throw buildCapabilityError(
      capability,
      `No sandbox workflow executor available for ${capability}`,
      {
        executionMode: 'sandbox_workflow',
      }
    );
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

/**
 * `computer_use` / `agents` / `mcp` via the isolated Docker sandbox
 * (ADR-024, LOTE AV). Deliberately separate from `executeSandboxWorkflowMode`
 * above — that mode is `CodeExecutionService` (E2B/Daytona/LocalProcessSandbox)
 * for `CODE_CAPABILITIES` and is untouched by this function.
 *
 * Each capability is gated by its OWN flag (`sandbox-policy.ts`): with the
 * flag off, the tool this mode looks up is never registered (computer_use),
 * the MCP client never connected (mcp), or `runBoundedAgent` reports
 * `stopReason: 'disabled'` (agents) — all three surface as the same
 * `capability_dependency_unavailable` error the caller already sees today
 * with the flag off, which is the byte-for-byte-identical-when-disabled
 * contract this change must not break.
 */
async function executeAgenticSandboxMode(
  capability: ModelCapability,
  body: CapabilityRequestBody,
  envelope: CapabilityExecutionEnvelope,
  request: FastifyRequest,
  requestId: string
): Promise<CapabilityModeResult> {
  const userContext = getUserContext(request);
  const toolCtx: ToolExecutionContext = {
    workingDirectory: process.cwd(),
    log,
    organizationId: userContext.organizationId,
    userId: userContext.userId,
  };

  if (capability === 'computer_use') {
    // Body shape: { operation?: 'shell'|'write_file'|'read_file'|'list_files'
    // (default 'shell'), command?, args?, path?, content? } — mirrors the
    // four `computer_*` tool schemas in computer-use-tools.ts 1:1.
    const operation = asString(body.operation) ?? 'shell';
    const toolNameByOperation: Record<string, string> = {
      shell: 'computer_shell',
      write_file: 'computer_write_file',
      read_file: 'computer_read_file',
      list_files: 'computer_list_files',
    };
    const toolName = toolNameByOperation[operation];
    if (!toolName) {
      throw buildCapabilityError(capability, `Unknown computer_use operation: ${operation}`);
    }
    if (!toolRegistry.has(toolName)) {
      throw buildCapabilityError(
        capability,
        'computer_use is disabled (set AGENTIC_COMPUTER_USE_ENABLED=true to enable)',
        { flag: 'AGENTIC_COMPUTER_USE_ENABLED' }
      );
    }
    const toolResult = await toolRegistry.executeForStrategy(toolName, body, requestId, toolCtx);
    if (!toolResult.success) {
      throw buildCapabilityError(capability, toolResult.error ?? 'computer_use execution failed', {
        toolName,
        ...toolResult.metadata,
      });
    }
    return { data: toolResult, executionPath: 'agentic_sandbox' };
  }

  if (capability === 'mcp') {
    // Body shape: { tool: string, arguments?: object } — `tool` is an
    // already-registered `mcp_<server>_<tool>` name from toolRegistry.
    const toolName = asString(body.tool);
    if (!toolName || !toolRegistry.has(toolName)) {
      throw buildCapabilityError(
        capability,
        toolName
          ? `Unknown or unregistered MCP tool: ${toolName}`
          : 'mcp is disabled or no server is configured (set MCP_CLIENT_ENABLED=true and configure a server)',
        { availableTools: toolRegistry.listNames().filter((name) => name.startsWith('mcp_')) }
      );
    }
    const args =
      body.arguments && typeof body.arguments === 'object'
        ? (body.arguments as Record<string, unknown>)
        : {};
    const toolResult = await toolRegistry.executeForStrategy(toolName, args, requestId, toolCtx);
    if (!toolResult.success) {
      throw buildCapabilityError(capability, toolResult.error ?? 'mcp tool execution failed', {
        toolName,
      });
    }
    return { data: toolResult, executionPath: 'agentic_sandbox' };
  }

  // capability === 'agents'
  const { runBoundedAgent } = await import('@/core/agents/agent-loop');
  const { createDynamicAgentInvoker } = await import('@/core/agents/agent-model-invoker');
  const messages = deriveMessages(body, envelope, capability).map((m) => ({
    role: m.role as 'system' | 'user' | 'assistant' | 'tool',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));
  const requestedTools = asStringArray(body.allowed_tools).filter((name) => toolRegistry.has(name));
  const allowedTools =
    requestedTools.length > 0
      ? requestedTools
      : toolRegistry.listStrategyTools().filter((t) => t.category === 'code').map((t) => t.name);
  const run = await runBoundedAgent({
    messages,
    invoke: createDynamicAgentInvoker(requestId, userContext),
    allowedTools,
    context: toolCtx,
  });
  if (run.stopReason === 'disabled') {
    throw buildCapabilityError(
      capability,
      'agents is disabled (set AGENTIC_AGENTS_ENABLED=true to enable)',
      { flag: 'AGENTIC_AGENTS_ENABLED' }
    );
  }
  if (run.stopReason === 'error') {
    throw buildCapabilityError(capability, run.error ?? 'agent run failed', { runId: run.runId });
  }
  return {
    data: {
      content: run.finalContent,
      stopReason: run.stopReason,
      steps: run.steps,
      runId: run.runId,
    },
    executionPath: 'agentic_sandbox',
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

// Exported (unmodified body) for MediaPlannerStrategy's non-generation
// action dispatch (LOTE AT, Part 2) — see the `/v1/capabilities/media-plan/
// execute` route below, which is the only caller outside this file's own
// dispatch handler and binds `envelope`/`request`/`requestId`/`services` via
// closure exactly as that handler already does.
export async function executeCapabilityByPlan(
  plan: CapabilityExecutionPlan,
  body: CapabilityRequestBody,
  envelope: CapabilityExecutionEnvelope,
  request: FastifyRequest,
  requestId: string,
  services: {
    audio: AudioOrchestrationService;
    music: MusicOrchestrationService;
    image: ImagesOrchestrationService;
    video: VideoOrchestrationService;
    videoUnderstanding: VideoUnderstandingService;
    search: SearchOrchestrationService;
    moderation: ModerationsOrchestrationService;
    code: CodeExecutionService;
    vision: VisionOrchestrationService;
    pdf: PDFService;
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
          music: services.music,
          image: services.image,
          video: services.video,
          videoUnderstanding: services.videoUnderstanding,
          search: services.search,
          moderation: services.moderation,
          vision: services.vision,
        });
      } else if (mode === 'tool_pipeline') {
        modeResult = await executeToolPipelineMode(plan.id, body, envelope, request, requestId, {
          search: services.search,
          pdf: services.pdf,
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
      } else if (mode === 'agentic_sandbox') {
        modeResult = await executeAgenticSandboxMode(plan.id, body, envelope, request, requestId);
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
  const musicService = new MusicOrchestrationService();
  const imageService = new ImagesOrchestrationService();
  const videoService = new VideoOrchestrationService();
  const videoUnderstandingService = new VideoUnderstandingService();
  const searchService = new SearchOrchestrationService();
  const moderationService = new ModerationsOrchestrationService();
  const codeExecutionService = new CodeExecutionService();
  // LOTE AP: vision family (vision / captioning / VQA) and PDF understanding.
  const visionService = getVisionOrchestrationService();
  const pdfService = new PDFService();

  server.post<{ Params: { capability: string }; Body: CapabilityRequestBody }>(
    '/v1/capabilities/:capability/execute',
    {
      schema: {
        tags: ['Capabilities'],
        description:
          'Universal capability execution endpoint with capability-plan driven dispatch, fallback execution paths, and normalized result envelope.',
      },
      preHandler: [
        authenticateRequest,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
        requireTenantContext(),
      ],
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
          // As of ADR-024/LOTE AV, `computer_use`/`agents`/`mcp` all declare
          // `supportsExecute: true` (they have a real executor,
          // `executeAgenticSandboxMode`, gated per-capability by their own
          // default-off flag) and so never reach this branch. What remains
          // here is capabilities that are stream-only BY DESIGN — a
          // bidirectional audio session is a WebSocket, not a POST — and have
          // a working endpoint to point at instead.
          throw buildCapabilityError(
            dynamicPlan.id,
            `Capability ${dynamicPlan.id} does not support execute mode`,
            {
              support: { execute: dynamicPlan.supportsExecute, stream: dynamicPlan.supportsStream },
              ...(REALTIME_STREAM_ONLY.has(dynamicPlan.id)
                ? { requiredEndpoint: '/v1/realtime' }
                : {}),
            }
          );
        }

        const execution = await executeRouteWithRetry(
          () =>
            executeCapabilityByPlan(dynamicPlan, body, envelope, request, requestId, {
              audio: audioService,
              music: musicService,
              image: imageService,
              video: videoService,
              videoUnderstanding: videoUnderstandingService,
              search: searchService,
              moderation: moderationService,
              code: codeExecutionService,
              vision: visionService,
              pdf: pdfService,
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
      preHandler: [
        authenticateRequest,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
        requireTenantContext(),
      ],
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
      preHandler: [
        authenticateRequest,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
        requireTenantContext(),
      ],
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
          ? allModels.filter((model) =>
              requiredCaps.every((required) => model.capabilities.includes(required))
            )
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
          const uniqueReasons = Array.from(
            new Set(reasons.length > 0 ? reasons : ['not_runnable'])
          );
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

      // Model inventory is only PART of the truth for the capabilities whose
      // execution also needs a host binary or a specific provider feature. A
      // report of "N runnable models" while ffmpeg is absent, or while no
      // adapter declares a native diarizer, would be a health check that
      // cannot fail for the reason the capability actually fails.
      const runtimeDependencies = await resolveRuntimeDependencies(
        (definition?.id ?? capability) as ModelCapability,
        videoUnderstandingService
      );
      const runtimeBlocked = runtimeDependencies.some((entry) => entry.satisfied === false);

      const operational =
        !runtimeBlocked && (executeSupported ? runnableCount > 0 : streamSupported);

      return reply.send({
        capability,
        aliasResolvedFrom: capabilityInput !== capability ? capabilityInput : undefined,
        operational,
        maturity: definition?.maturity ?? 'stable',
        executionPath: definition?.executionPath ?? ['orchestration'],
        requiredCapabilities: requiredCaps,
        runtimeDependencies,
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
        description:
          'List complete capability matrix with execution metadata and dependency hints.',
      },
      preHandler: [
        authenticateRequest,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
        requireTenantContext(),
      ],
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

  // LOTE AT (Part 2) — MediaPlannerStrategy entry point. The ENTIRE pathway
  // is behind `config.mediaPlanner.enabled` (MEDIA_PLANNER_ENABLED, default
  // false) checked at the earliest possible point via
  // `resolveMediaPlanRouting` — with the flag off, this handler always
  // responds `media_planner_not_applicable` without running the heuristic
  // text-scan or touching `MediaPlannerStrategy` at all, so this new route
  // existing changes nothing about the routes above it.
  server.post<{ Body: { messages?: ChatMessage[]; prompt?: string; model?: string } }>(
    '/v1/capabilities/media-plan/execute',
    {
      schema: {
        tags: ['Capabilities'],
        description:
          'LOTE AT (Part 2, gated behind MEDIA_PLANNER_ENABLED, default off): agentic media-composition planner. A cheap heuristic (no LLM call) decides whether a request is multi-capability or attribute-constrained enough to warrant the bounded planner loop; most requests are refused with media_planner_not_applicable rather than executed here — see the direct `/v1/capabilities/:capability/execute` route for the normal single-capability path.',
      },
      preHandler: [
        authenticateRequest,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
        requireTenantContext(),
      ],
    },
    async (request, reply) => {
      const requestId = request.id;
      const body = request.body || {};
      const messages: ChatMessage[] =
        body.messages && body.messages.length > 0
          ? body.messages
          : body.prompt
            ? [{ role: 'user', content: body.prompt }]
            : [];

      if (messages.length === 0) {
        return reply.code(422).send({
          error: {
            code: 'invalid_request',
            type: 'capability_error',
            message: '"messages" (chat-shaped array) or "prompt" (string) is required',
          },
        });
      }

      const chatRequest: ChatRequest = { model: body.model ?? 'auto', messages };
      const models = await getAllCatalogModels();
      const orchestrationContext = createOrchestrationContext(request, {
        models,
        semanticQuery: extractSemanticQueryFromMessages(messages),
      });

      const gate = resolveMediaPlanRouting(chatRequest, orchestrationContext, config.mediaPlanner.enabled);
      if (!gate.route) {
        return reply.code(422).send({
          error: {
            code: 'media_planner_not_applicable',
            type: 'capability_error',
            message: config.mediaPlanner.enabled
              ? `Request does not meet the media-planner routing heuristic: ${gate.reason}`
              : 'MEDIA_PLANNER_ENABLED is false',
            details: { reason: gate.reason, detectedCapabilities: gate.detectedCapabilities },
          },
        });
      }

      const envelope = parseEnvelope(body as CapabilityRequestBody);
      const strategy = new MediaPlannerStrategy({
        capabilityDispatcher: (plan, capabilityBody) =>
          executeCapabilityByPlan(plan, capabilityBody, envelope, request, requestId, {
            audio: audioService,
            music: musicService,
            image: imageService,
            video: videoService,
            videoUnderstanding: videoUnderstandingService,
            search: searchService,
            moderation: moderationService,
            code: codeExecutionService,
            vision: visionService,
            pdf: pdfService,
          }),
        // `mediaConsensusExecutor`: LOTE AT Part 1 (media-consensus-strategy)
        // merged 2026-09-06 (PR #443), so `generate` actions now really
        // generate N candidates via the same video/image services this
        // route already constructs above, instead of degrading to an
        // `unmetConstraints` entry. Critics are intentionally NOT wired yet
        // (empty array) — MediaJudgeEvaluator needs a real judge-model
        // client injected, which is a separate piece of work; with zero
        // critics, reconcileCriticResults() degrades to
        // scoringMode:'unavailable'/verdict:'uncertain' and
        // pickBestCandidate() deterministically picks the first
        // gate-passing candidate (see media-consensus-strategy.ts's own
        // documented degrade path) — a real generation path, just without
        // critic-based ranking yet.
        mediaConsensusExecutor: new MediaConsensusStrategy({
          videoService,
          imagesService: imageService,
        }),
      });

      const result = await strategy.execute(chatRequest, orchestrationContext);
      return reply.send(result);
    }
  );

  log.info('Capability universal routes registered');
}
