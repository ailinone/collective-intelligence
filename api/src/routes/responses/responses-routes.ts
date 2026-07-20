// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OpenAI Responses API Routes
 * New simplified conversational interface (OpenAI Responses API compatible)
 *
 * Features:
 * - Simplified single-turn and multi-turn conversations
 * - Built-in tool execution
 * - Web search integration
 * - File handling
 * - Streaming support
 *
 * NO HARDCODED MODELS - All selection is dynamic
 * REAL IMPLEMENTATION - Uses orchestration engine
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '@/utils/logger';
import {
  extractErrorCodeFromObject,
  extractStatusCode,
  getErrorMessage,
} from '@/utils/type-guards';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import type {
  ChatRequest,
  ChatMessage,
  OrchestrationContext,
  Tool,
  StrategyInputName,
} from '@/types';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { createOrchestrationContext } from '@/utils/orchestration-context';
import {
  getOrchestrationEngine,
  isOrchestrationEngineInitialized,
} from '@/core/orchestration/orchestration-engine';
import { nanoid } from 'nanoid';
import { trackChatUsage } from '@/services/billing-usage-tracker';
import { withIdempotency } from '@/middleware/idempotency-middleware';
import { setupSSEHeaders } from '@/utils/sse';
import { executeRouteWithRetry } from '@/utils/route-retry';
import type { ChatResponse } from '@/types';
import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { resolveAilinVirtualModelAlias } from '@/services/ailin-virtual-model-service';
import {
  STRATEGY_INPUT_VALUES,
  canonicalizeStrategyInput,
  getStrategyValidationMessage,
  mapExecutionToCanonical,
  resolveExecutionStrategy,
} from '@/core/orchestration/strategy-contract';

const log = logger.child({ module: 'responses-routes' });

// ============================================
// Types (OpenAI Responses API Compatible)
// ============================================

/**
 * Input types for responses API
 */
type ResponseInputItem =
  | ResponseInputMessageItem
  | ResponseInputItemReference;

interface ResponseInputMessageItem {
  type: 'message';
  role: 'user' | 'assistant' | 'system';
  content: string | ResponseContentPart[];
}

interface ResponseInputItemReference {
  type: 'item_reference';
  id: string;
}

type ResponseContentPart =
  | ResponseContentPartText
  | ResponseContentPartImage
  | ResponseContentPartFile;

interface ResponseContentPartText {
  type: 'input_text' | 'output_text';
  text: string;
}

interface ResponseContentPartImage {
  type: 'input_image';
  image_url: string;
  detail?: 'low' | 'high' | 'auto';
}

interface ResponseContentPartFile {
  type: 'input_file';
  file_id: string;
}

/**
 * Tool definition types
 */
interface ResponseTool {
  type: 'function' | 'web_search' | 'file_search' | 'code_interpreter';
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  // Web search options
  web_search?: {
    max_results?: number;
    search_context_size?: 'low' | 'medium' | 'high';
  };
}

/**
 * Response create request
 */
interface ResponseCreateRequest {
  model?: string;
  input: string | ResponseInputItem[];
  instructions?: string;
  tools?: ResponseTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string };
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  stream?: boolean;
  metadata?: Record<string, string>;
  // Ailin extensions
  strategy?: StrategyInputName;
  quality_target?: number;
  max_cost?: number;
}

/**
 * Response output item
 */
interface ResponseOutputItem {
  type: 'message' | 'function_call' | 'function_call_output' | 'web_search_call' | 'reasoning';
  id: string;
  status: 'completed' | 'in_progress' | 'incomplete';
  role?: 'assistant';
  content?: ResponseContentPart[];
  // Function call specific
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: string;
  // Reasoning specific
  summary?: ResponseContentPart[];
}

/**
 * Response object
 */
interface ResponseObject {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  status: 'completed' | 'in_progress' | 'incomplete' | 'failed' | 'cancelled';
  status_details?: {
    type: string;
    reason?: string;
  };
  output: ResponseOutputItem[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  metadata?: Record<string, string>;
  // Ailin extensions
  ailin_metadata?: {
    models_used: string[];
    strategy_used: string;
    resolved_strategy?: string;
    resolved_model?: string;
    final_decider_model_id?: string;
    final_decider_model_name?: string;
    final_decider_role?: string;
    fallback_chain?: string[];
    total_cost: number;
    total_duration_ms: number;
  };
}

// ============================================
// Streaming (OpenAI Responses SSE) support
// ============================================

/**
 * Minimal write sink for SSE. Fastify's `reply.raw` (a Node ServerResponse)
 * satisfies this shape, and tests can pass an in-memory fake. Keeping the
 * surface this narrow is what makes the streaming logic unit-testable without
 * booting Fastify + Prisma + the provider registry.
 */
export interface SSESink {
  write(chunk: string): unknown;
  end(): unknown;
  /** Optional flush (Node compression streams expose this). */
  flush?: () => void;
}

/**
 * In-progress / completed response envelope used by the streaming events.
 * Mirrors the non-streaming `ResponseObject` shape closely enough for clients
 * that parse `response.created` / `response.completed` event payloads.
 */
export interface StreamingResponseEnvelope {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  status: ResponseObject['status'];
  output: ResponseOutputItem[];
  usage: ResponseObject['usage'];
  metadata?: Record<string, string>;
  ailin_metadata?: ResponseObject['ailin_metadata'];
}

/**
 * The discrete events emitted on the Responses streaming channel, following
 * the OpenAI Responses streaming protocol:
 *   - response.created           (once, at the start)
 *   - response.output_text.delta (per text delta)
 *   - response.completed         (once, on success)
 *   - response.failed            (once, on mid-stream error)
 * Each is framed as `data: <json>\n\n`; the stream terminates with
 * `data: [DONE]\n\n`. An additional Ailin-specific `ailin_metadata` frame is
 * emitted just before completion to surface orchestration provenance.
 */
type ResponsesStreamEvent =
  | {
      type: 'response.created';
      response: StreamingResponseEnvelope;
    }
  | {
      type: 'response.output_text.delta';
      item_id: string;
      output_index: number;
      content_index: number;
      delta: string;
    }
  | {
      type: 'response.completed';
      response: StreamingResponseEnvelope;
    }
  | {
      type: 'response.failed';
      response: StreamingResponseEnvelope;
      error: { message: string; type: string; code?: string };
    }
  | {
      // Ailin extension frame carrying orchestration metadata, emitted right
      // before `response.completed`. Discriminated by `type` like the OpenAI
      // events so consumers can route on a single field.
      type: 'ailin.metadata';
      ailin_metadata: NonNullable<ResponseObject['ailin_metadata']>;
    };

/**
 * Serialize a single Responses stream event into an SSE `data:` frame.
 */
export function formatResponsesSSE(event: ResponsesStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Extract the incremental text from an engine `ChatResponse` chunk.
 *
 * The engine's `executeStream` yields two shapes depending on whether the
 * selected strategy natively streams:
 *   1. native streaming  → `choices[0].delta.content` (incremental token text)
 *   2. buffered fallback → `choices[0].message.content` (full text in one shot)
 * Both are mapped to a single text delta here. Non-string `content`
 * (multimodal arrays) and SSE progress/observer chunks (which carry empty
 * delta content + an `ailin_metadata.type`) contribute no text.
 */
export function extractDeltaText(chunk: ChatResponse): string {
  const choice = chunk.choices?.[0];
  if (!choice) return '';

  // Skip non-completion metadata chunks (progress / observer / clarification):
  // they carry an `ailin_metadata.type` discriminator and empty content.
  const metaType =
    chunk.ailin_metadata && 'type' in chunk.ailin_metadata
      ? (chunk.ailin_metadata as { type?: string }).type
      : undefined;

  const deltaContent = choice.delta?.content;
  if (typeof deltaContent === 'string' && deltaContent.length > 0) {
    return deltaContent;
  }

  // Buffered-fallback path: a single full message rather than incremental
  // deltas. Only treat it as text when it is NOT a metadata-only chunk.
  if (!metaType) {
    const messageContent = choice.message?.content;
    if (typeof messageContent === 'string' && messageContent.length > 0) {
      return messageContent;
    }
  }

  return '';
}

/**
 * Build the OpenAI-shaped `ailin_metadata` block from an accumulated stream.
 * Mirrors the non-streaming response's `ailin_metadata` so streaming and
 * buffered consumers see the same provenance fields.
 */
function buildStreamingAilinMetadata(args: {
  modelsUsed: string[];
  strategyUsed: string;
  resolvedModel?: string;
  finalDeciderModelId?: string;
  totalCost: number;
  totalDurationMs: number;
}): NonNullable<ResponseObject['ailin_metadata']> {
  return {
    models_used: args.modelsUsed,
    strategy_used: args.strategyUsed,
    resolved_model: args.resolvedModel,
    final_decider_model_id: args.finalDeciderModelId,
    total_cost: args.totalCost,
    total_duration_ms: args.totalDurationMs,
  };
}

export interface StreamResponseParams {
  /** Source of engine chunks (e.g. `engine.executeStream(...)`). */
  source: AsyncIterable<ChatResponse>;
  /** Output SSE sink (e.g. `reply.raw`). */
  sink: SSESink;
  responseId: string;
  requestedModel: string;
  metadata?: Record<string, string>;
  /** Wall-clock start (ms) for duration accounting. */
  startTime: number;
  /**
   * Optional hook fired once the stream has fully completed (success or
   * failure). Receives the aggregated text + provenance for billing/persistence.
   */
  onComplete?: (summary: {
    text: string;
    failed: boolean;
    modelsUsed: string[];
    strategyUsed: string;
    resolvedModel?: string;
    finalDeciderModelId?: string;
    totalCost: number;
    usage: ResponseObject['usage'];
    durationMs: number;
  }) => void | Promise<void>;
}

/**
 * Drive an engine chunk stream and emit OpenAI Responses streaming events to
 * the sink. This is the testable core of `/v1/responses` streaming.
 *
 * Emission order:
 *   response.created → response.output_text.delta* → ailin.metadata →
 *   response.completed → [DONE]
 * On a mid-stream error: emits whatever deltas arrived, then
 *   ailin.metadata → response.failed → [DONE]
 * so the connection always terminates cleanly with a final frame + sentinel.
 */
export async function streamResponse(params: StreamResponseParams): Promise<void> {
  const {
    source,
    sink,
    responseId,
    requestedModel,
    metadata,
    startTime,
    onComplete,
  } = params;

  const itemId = `msg_${nanoid(16)}`;
  const createdAt = Math.floor(Date.now() / 1000);

  const baseEnvelope = (
    status: StreamingResponseEnvelope['status'],
    output: ResponseOutputItem[],
    usage: ResponseObject['usage'],
    ailinMetadata?: ResponseObject['ailin_metadata']
  ): StreamingResponseEnvelope => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    model: requestedModel,
    status,
    output,
    usage,
    metadata,
    ...(ailinMetadata ? { ailin_metadata: ailinMetadata } : {}),
  });

  const emit = (event: ResponsesStreamEvent): void => {
    sink.write(formatResponsesSSE(event));
    if (typeof sink.flush === 'function') {
      sink.flush();
    }
  };

  const emitDone = (): void => {
    sink.write('data: [DONE]\n\n');
  };

  // Aggregation state.
  let accumulatedText = '';
  const modelsUsed: string[] = [];
  let strategyUsed = '';
  let resolvedModel: string | undefined;
  let finalDeciderModelId: string | undefined;
  let totalCost = 0;
  let usage: ResponseObject['usage'] = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };

  // Pull provenance off any chunk that happens to carry final metadata
  // (completion chunks set the full `AilinMetadata` shape, which has no
  // `type` discriminator).
  const captureProvenance = (chunk: ChatResponse): void => {
    if (typeof chunk.model === 'string' && chunk.model.length > 0) {
      finalDeciderModelId = chunk.model;
      if (!resolvedModel) resolvedModel = chunk.model;
    }
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens ?? usage.input_tokens,
        output_tokens: chunk.usage.completion_tokens ?? usage.output_tokens,
        total_tokens: chunk.usage.total_tokens ?? usage.total_tokens,
      };
    }
    const meta = chunk.ailin_metadata;
    if (meta && !('type' in meta)) {
      if (Array.isArray(meta.models_used)) {
        for (const m of meta.models_used) {
          if (typeof m === 'string' && !modelsUsed.includes(m)) modelsUsed.push(m);
        }
      }
      if (typeof meta.strategy_used === 'string') strategyUsed = meta.strategy_used;
      if (typeof meta.resolved_model === 'string') resolvedModel = meta.resolved_model;
      if (typeof meta.final_decider_model_id === 'string') {
        finalDeciderModelId = meta.final_decider_model_id;
      }
      if (typeof meta.cost_usd === 'number') totalCost = meta.cost_usd;
    }
  };

  // 1) response.created
  emit({
    type: 'response.created',
    response: baseEnvelope('in_progress', [], usage),
  });

  let failed = false;
  let failureError: { message: string; type: string; code?: string } | null = null;

  try {
    for await (const chunk of source) {
      captureProvenance(chunk);
      const deltaText = extractDeltaText(chunk);
      if (deltaText.length > 0) {
        accumulatedText += deltaText;
        emit({
          type: 'response.output_text.delta',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: deltaText,
        });
      }
    }
  } catch (error) {
    failed = true;
    failureError = {
      message: getErrorMessage(error),
      type: 'response_error',
      code: extractErrorCodeFromObject(error) ?? 'RESPONSE_STREAM_FAILED',
    };
    log.error(
      { responseId, error: failureError.message, code: failureError.code },
      'Responses streaming failed mid-stream'
    );
  }

  const durationMs = Date.now() - startTime;
  const ailinMetadata = buildStreamingAilinMetadata({
    modelsUsed,
    strategyUsed,
    resolvedModel,
    finalDeciderModelId,
    totalCost,
    totalDurationMs: durationMs,
  });

  // Ailin provenance frame (always emitted before the terminal event).
  emit({ type: 'ailin.metadata', ailin_metadata: ailinMetadata });

  const finalOutput: ResponseOutputItem[] =
    accumulatedText.length > 0
      ? [
          {
            type: 'message',
            id: itemId,
            status: failed ? 'incomplete' : 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: accumulatedText }],
          },
        ]
      : [];

  if (failed && failureError) {
    emit({
      type: 'response.failed',
      response: baseEnvelope('failed', finalOutput, usage, ailinMetadata),
      error: failureError,
    });
  } else {
    emit({
      type: 'response.completed',
      response: baseEnvelope('completed', finalOutput, usage, ailinMetadata),
    });
  }

  emitDone();

  if (onComplete) {
    try {
      await onComplete({
        text: accumulatedText,
        failed,
        modelsUsed,
        strategyUsed,
        resolvedModel,
        finalDeciderModelId,
        totalCost,
        usage,
        durationMs,
      });
    } catch (error) {
      log.warn(
        { responseId, error: getErrorMessage(error) },
        'Responses streaming onComplete hook failed'
      );
    }
  }
}

// ============================================
// Responses Service
// ============================================

class ResponsesService {
  /**
   * Create a response using the orchestration engine
   * REAL IMPLEMENTATION - Persists response to database
   */
  async createResponse(
    request: ResponseCreateRequest,
    context: OrchestrationContext
  ): Promise<ResponseObject> {
    const startTime = Date.now();
    const responseId = `resp_${nanoid(24)}`;

    log.info(
      {
        requestId: context.requestId,
        responseId,
        hasTools: !!request.tools?.length,
        stream: request.stream,
      },
      'Creating response'
    );

    // Steps 1-3: Convert input + tools and prepare the chat request
    // (shared with the streaming path via buildChatRequest).
    const chatRequest = this.buildChatRequest(request, false);

    // Step 4: Execute via orchestration engine
    if (!isOrchestrationEngineInitialized()) {
      throw new Error('OrchestrationEngine not initialized');
    }

    const engine = getOrchestrationEngine();
    const result = await engine.execute(chatRequest, context.organizationId, context.userId);

    // Step 5: Convert response to Responses API format
    const output = this.convertToOutputItems(result.finalResponse, responseId);

    const durationMs = Date.now() - startTime;

    log.info(
      {
        requestId: context.requestId,
        responseId,
        outputItems: output.length,
        durationMs,
      },
      'Response created successfully'
    );

    const resolvedStrategyOutput =
      typeof result.metadata?.resolved_strategy === 'string'
        ? result.metadata.resolved_strategy
        : mapExecutionToCanonical(result.strategyUsed);
    const resolvedModel =
      typeof result.metadata?.resolved_model === 'string'
        ? result.metadata.resolved_model
        : result.modelsUsed.find((m) => m.success)?.modelName ?? result.modelsUsed[0]?.modelName;
    const finalDeciderModelId =
      typeof result.metadata?.final_decider_model_id === 'string'
        ? result.metadata.final_decider_model_id
        : typeof result.finalResponse.model === 'string' && result.finalResponse.model.length > 0
          ? result.finalResponse.model
          : result.modelsUsed[0]?.modelId;
    const finalDeciderModelName =
      typeof result.metadata?.final_decider_model_name === 'string'
        ? result.metadata.final_decider_model_name
        : resolvedModel;
    const finalDeciderRole =
      typeof result.metadata?.final_decider_role === 'string'
        ? result.metadata.final_decider_role
        : undefined;

    const responseObject: ResponseObject = {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: finalDeciderModelId ?? request.model ?? 'auto',
      status: 'completed',
      output,
      usage: {
        input_tokens: result.finalResponse.usage?.prompt_tokens ?? 0,
        output_tokens: result.finalResponse.usage?.completion_tokens ?? 0,
        total_tokens: result.finalResponse.usage?.total_tokens ?? 0,
      },
      metadata: request.metadata,
      ailin_metadata: {
        models_used: result.modelsUsed.map((m) => m.modelId),
        strategy_used: result.strategyUsed,
        resolved_strategy: resolvedStrategyOutput,
        resolved_model: resolvedModel,
        final_decider_model_id: finalDeciderModelId,
        final_decider_model_name: finalDeciderModelName,
        final_decider_role: finalDeciderRole,
        fallback_chain: Array.isArray(result.metadata?.fallback_chain)
          ? result.metadata.fallback_chain.filter(
              (entry): entry is string => typeof entry === 'string'
            )
          : undefined,
        total_cost: result.totalCost,
        total_duration_ms: durationMs,
      },
    };

    // Persist response to database using RequestLog metadata
    try {
      await prisma.requestLog.upsert({
        where: { requestId: responseId },
        create: {
          organizationId: context.organizationId,
          requestId: responseId,
          endpoint: '/v1/responses',
          method: 'POST',
          durationMs,
          inputTokens: responseObject.usage.input_tokens,
          outputTokens: responseObject.usage.output_tokens,
          totalTokens: responseObject.usage.total_tokens,
          costUsd: result.totalCost,
          status: 'success',
          request: {} as Prisma.InputJsonValue,
          response: JSON.parse(JSON.stringify(responseObject)) as Prisma.InputJsonValue,
          metadata: {
            type: 'response_object',
            responseId: responseId,
          } as Prisma.InputJsonValue,
          modelsUsed: result.modelsUsed.map((m) => m.modelId),
          modelCount: result.modelsUsed.length,
          strategyName: result.strategyUsed,
        },
        update: {
          response: JSON.parse(JSON.stringify(responseObject)) as Prisma.InputJsonValue,
          metadata: {
            type: 'response_object',
            responseId: responseId,
          } as Prisma.InputJsonValue,
        },
      });
      log.debug({ responseId }, 'Response persisted to database');
    } catch (error) {
      log.warn({ responseId, error: getErrorMessage(error) }, 'Failed to persist response to database');
      // Continue even if persistence fails
    }

    return responseObject;
  }

  /**
   * Build a `ChatRequest` from a Responses API request.
   *
   * Shared by the non-streaming (`createResponse`) and streaming
   * (`createStreamingResponse`) paths so input/tool/alias/strategy conversion
   * stays identical across both — this is the streaming↔non-streaming parity
   * guarantee. Throws 400 errors for invalid input / strategy.
   */
  buildChatRequest(request: ResponseCreateRequest, stream: boolean): ChatRequest {
    // Step 1: Convert input to chat messages
    const messages = this.convertInputToMessages(request.input, request.instructions);
    if (!messages.some((message) => message.role === 'user')) {
      throw Object.assign(new Error('Invalid responses input: provide at least one user message.'), {
        statusCode: 400,
        code: 'invalid_input_format',
      });
    }

    // Step 2: Convert tools to chat format
    const tools = this.convertTools(request.tools);

    // Step 3: Prepare chat request
    const modelValue = typeof request.model === 'string' ? request.model.trim() : '';
    const aliasResolution = resolveAilinVirtualModelAlias(modelValue);
    const modelProvided = modelValue.length > 0;
    const explicitlyAuto = modelValue.toLowerCase() === 'auto' || aliasResolution !== null;
    const resolvedStrategy =
      typeof request.strategy === 'string'
        ? resolveExecutionStrategy(request.strategy)
        : undefined;
    const canonicalStrategy =
      typeof request.strategy === 'string'
        ? canonicalizeStrategyInput(request.strategy)
        : undefined;
    if (typeof request.strategy === 'string' && !resolvedStrategy && !canonicalStrategy) {
      throw Object.assign(new Error(getStrategyValidationMessage()), {
        statusCode: 400,
        code: 'invalid_strategy',
      });
    }

    return {
      model: aliasResolution ? aliasResolution.model : request.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: this.convertToolChoice(request.tool_choice),
      temperature: request.temperature,
      max_tokens: request.max_output_tokens,
      top_p: request.top_p,
      stream,
      quality_target:
        request.quality_target !== undefined
          ? request.quality_target
          : aliasResolution?.qualityTarget,
      max_cost:
        request.max_cost !== undefined
          ? request.max_cost
          : aliasResolution?.maxCost,
      task_type: aliasResolution?.taskType,
      ailin_alias: aliasResolution?.alias,
      ailin_constraints: aliasResolution?.constraints,
      ailin_billing: aliasResolution?.billing,
      strategy:
        resolvedStrategy ??
        (canonicalStrategy === 'dynamic'
          ? 'auto'
          : ((request.strategy as ChatRequest['strategy']) ?? aliasResolution?.strategy)),
      user_specified_model: modelProvided && !explicitlyAuto,
      // Enable web search if tool is present
      webSearch: request.tools?.some((t) => t.type === 'web_search'),
      webSearchOptions: this.extractWebSearchOptions(request.tools),
    };
  }

  /**
   * Execute a Responses request in streaming mode and emit OpenAI Responses
   * SSE events to the provided sink. Reuses the SAME `engine.executeStream`
   * mechanism as `/v1/chat/completions` — the only difference is event shape.
   *
   * Returns the response id (so the route can log/track) once the stream has
   * terminated (success or mid-stream failure both close cleanly with [DONE]).
   */
  async createStreamingResponse(
    request: ResponseCreateRequest,
    context: OrchestrationContext,
    sink: SSESink
  ): Promise<{ responseId: string }> {
    const startTime = Date.now();
    const responseId = `resp_${nanoid(24)}`;

    log.info(
      {
        requestId: context.requestId,
        responseId,
        hasTools: !!request.tools?.length,
        stream: true,
      },
      'Creating streaming response'
    );

    // Build the chat request (stream=true) — validation errors surface here,
    // BEFORE any SSE header/frame is written, so the route can still emit a
    // proper JSON 4xx.
    const chatRequest = this.buildChatRequest(request, true);

    if (!isOrchestrationEngineInitialized()) {
      throw new Error('OrchestrationEngine not initialized');
    }
    const engine = getOrchestrationEngine();

    await streamResponse({
      source: engine.executeStream(chatRequest, context.organizationId, context.userId),
      sink,
      responseId,
      requestedModel: request.model ?? 'auto',
      metadata: request.metadata,
      startTime,
      onComplete: async (summary) => {
        // Persist a lightweight RequestLog row and track usage for billing.
        // Mirrors the chat streaming path: streaming carries no per-token cost
        // accounting here, so cost is whatever provenance reported (or 0).
        try {
          await prisma.requestLog.upsert({
            where: { requestId: responseId },
            create: {
              organizationId: context.organizationId,
              requestId: responseId,
              endpoint: '/v1/responses',
              method: 'POST',
              durationMs: summary.durationMs,
              inputTokens: summary.usage.input_tokens,
              outputTokens: summary.usage.output_tokens,
              totalTokens: summary.usage.total_tokens,
              costUsd: summary.totalCost,
              status: summary.failed ? 'error' : 'success',
              request: {} as Prisma.InputJsonValue,
              response: {
                streaming: true,
                failed: summary.failed,
              } as Prisma.InputJsonValue,
              metadata: {
                type: 'response_object',
                responseId,
                streaming: true,
              } as Prisma.InputJsonValue,
              modelsUsed: summary.modelsUsed,
              modelCount: summary.modelsUsed.length,
              strategyName: summary.strategyUsed || 'auto',
            },
            update: {
              status: summary.failed ? 'error' : 'success',
              metadata: {
                type: 'response_object',
                responseId,
                streaming: true,
              } as Prisma.InputJsonValue,
            },
          });
        } catch (error) {
          log.warn(
            { responseId, error: getErrorMessage(error) },
            'Failed to persist streaming response to database'
          );
        }

        if (!summary.failed && context.organizationId) {
          try {
            await trackChatUsage({
              organizationId: context.organizationId,
              userId: context.userId ?? '',
              requestId: responseId,
              request: { model: request.model ?? 'auto', messages: [] },
              cacheHit: false,
              strategyOverride: summary.strategyUsed || 'single-streaming',
              totalCostOverride: summary.totalCost,
              totalTokensOverride: summary.usage.total_tokens,
            });
          } catch (error) {
            log.warn(
              { responseId, error: getErrorMessage(error) },
              'Failed to track streaming response usage'
            );
          }
        }
      },
    });

    return { responseId };
  }

  /**
   * Get a response by ID
   * REAL IMPLEMENTATION - Retrieves from database
   */
  async getResponse(responseId: string, organizationId: string): Promise<ResponseObject | null> {
    try {
      const requestLog = await prisma.requestLog.findFirst({
        where: {
          requestId: responseId,
          organizationId: organizationId,
          metadata: {
            path: ['type'],
            equals: 'response_object',
          },
        },
      });

      if (!requestLog || !requestLog.response) {
        return null;
      }

      // Extract response object from RequestLog
      const responseData = JSON.parse(JSON.stringify(requestLog.response)) as ResponseObject;
      return responseData;
    } catch (error) {
      log.error({ responseId, error: getErrorMessage(error) }, 'Failed to retrieve response from database');
      return null;
    }
  }

  /**
   * Delete a response by ID
   * REAL IMPLEMENTATION - Removes from database
   */
  async deleteResponse(responseId: string, organizationId: string): Promise<boolean> {
    try {
      await prisma.requestLog.deleteMany({
        where: {
          requestId: responseId,
          organizationId: organizationId,
          metadata: {
            path: ['type'],
            equals: 'response_object',
          },
        },
      });
      return true;
    } catch (error) {
      log.error({ responseId, error: getErrorMessage(error) }, 'Failed to delete response from database');
      return false;
    }
  }

  /**
   * Convert input to chat messages
   */
  private convertInputToMessages(
    input: string | ResponseInputItem[],
    instructions?: string
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // Add system instructions if provided
    if (typeof instructions === 'string' && instructions.trim().length > 0) {
      messages.push({
        role: 'system',
        content: instructions,
      });
    }

    // Handle simple string input
    if (typeof input === 'string') {
      const normalized = input.trim();
      if (normalized.length > 0) {
        messages.push({
          role: 'user',
          content: normalized,
        });
      }
      return messages;
    }

    // Handle array input
    for (const rawItem of input as unknown[]) {
      // Ajv with coerceTypes='array' can turn string input into [string]
      if (typeof rawItem === 'string') {
        const normalized = rawItem.trim();
        if (normalized.length > 0) {
          messages.push({
            role: 'user',
            content: normalized,
          });
        }
        continue;
      }

      if (!rawItem || typeof rawItem !== 'object') {
        continue;
      }

      // `rawItem` is `unknown` (parsed JSON); narrow to a record once.
      if (typeof rawItem !== 'object' || rawItem === null) continue;
      const item = rawItem as Record<string, unknown>;
      const role = item.role;
      const type = item.type;

      if (type === 'item_reference') {
        // Requires lookup of prior response items, not yet implemented.
        continue;
      }

      // OpenAI-compatible: accept message items with or without explicit `type: "message"`.
      const isMessageType = type === 'message' || type === undefined;
      const isRoleValid = role === 'user' || role === 'assistant' || role === 'system';
      if (isMessageType && isRoleValid) {
        const content = this.convertContentParts(item.content);
        if (typeof content === 'string' && content.trim().length === 0) {
          continue;
        }
        if (Array.isArray(content) && content.length === 0) {
          continue;
        }
        messages.push({
          role,
          content,
        });
        continue;
      }

      // Compatibility fallback for flattened text items.
      if (type === 'input_text' && typeof item.text === 'string') {
        const normalized = item.text.trim();
        if (normalized.length > 0) {
          messages.push({
            role: 'user',
            content: normalized,
          });
        }
      }
    }

    return messages;
  }

  /**
   * Convert content parts to chat format
   */
  private convertContentParts(
    content: unknown
  ): string | ChatMessage['content'] {
    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return '';
    }

    const converted: ChatMessage['content'] = [];

    for (const rawPart of content) {
      if (typeof rawPart === 'string') {
        const normalized = rawPart.trim();
        if (normalized.length > 0) {
          converted.push({ type: 'text', text: normalized });
        }
        continue;
      }

      if (!rawPart || typeof rawPart !== 'object') {
        continue;
      }

      const part = rawPart as Record<string, unknown>;
      const partType = typeof part.type === 'string' ? part.type : undefined;

      if (
        (partType === 'input_text' || partType === 'output_text' || partType === 'text') &&
        typeof part.text === 'string'
      ) {
        const normalized = part.text.trim();
        if (normalized.length > 0) {
          converted.push({ type: 'text', text: normalized });
        }
        continue;
      }

      if (
        (partType === 'input_image' || partType === 'image_url') &&
        typeof part.image_url === 'string'
      ) {
        converted.push({
          type: 'image_url',
          image_url: {
            url: part.image_url,
          },
        });
        continue;
      }

      if (
        (partType === 'input_image' || partType === 'image_url') &&
        part.image_url &&
        typeof part.image_url === 'object'
      ) {
        const image = part.image_url as Record<string, unknown>;
        const url = typeof image.url === 'string' ? image.url : '';
        const detail =
          image.detail === 'low' || image.detail === 'high' || image.detail === 'auto'
            ? image.detail
            : undefined;
        if (url.length > 0) {
          converted.push({
            type: 'image_url',
            image_url: {
              url,
              detail,
            },
          });
        }
        continue;
      }

      if (partType === 'input_file' && typeof part.file_id === 'string') {
        converted.push({ type: 'text', text: `[File: ${part.file_id}]` });
      }
    }

    return converted;
  }

  /**
   * Convert response tools to chat tools
   */
  private convertTools(tools?: ResponseTool[]): Tool[] {
    if (!tools) return [];

    return tools
      .filter((t) => t.type === 'function' && t.function)
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.function!.name,
          description: t.function?.description,
          parameters: t.function?.parameters ?? {},
        },
      }));
  }

  /**
   * Convert tool choice to chat format
   */
  private convertToolChoice(
    toolChoice?: ResponseCreateRequest['tool_choice']
  ): ChatRequest['tool_choice'] {
    if (!toolChoice) return undefined;
    if (toolChoice === 'auto' || toolChoice === 'none') {
      return toolChoice;
    }
    if (toolChoice === 'required') {
      return 'auto';
    }
    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      return { type: 'function', function: { name: toolChoice.name } };
    }
    return undefined;
  }

  /**
   * Extract web search options from tools
   */
  private extractWebSearchOptions(
    tools?: ResponseTool[]
  ): ChatRequest['webSearchOptions'] | undefined {
    const webSearchTool = tools?.find((t) => t.type === 'web_search');
    if (!webSearchTool?.web_search) return undefined;

    return {
      max_results: webSearchTool.web_search.max_results,
      search_context_size: webSearchTool.web_search.search_context_size,
    };
  }

  /**
   * Convert orchestration response to output items
   */
  private convertToOutputItems(
    response: {
      choices?: Array<{
        message?: ChatMessage;
        finish_reason?: string | null;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    },
    _responseId: string
  ): ResponseOutputItem[] {
    const output: ResponseOutputItem[] = [];
    const message = response.choices?.[0]?.message;

    if (!message) {
      return output;
    }

    // Handle tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        output.push({
          type: 'function_call',
          id: `fc_${nanoid(16)}`,
          status: 'completed',
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
          call_id: toolCall.id,
        });
      }
    }

    // Handle text content
    const contentParts = this.extractContentParts(message.content);
    if (contentParts.length > 0) {
      output.push({
        type: 'message',
        id: `msg_${nanoid(16)}`,
        status: 'completed',
        role: 'assistant',
        content: contentParts,
      });
    }

    return output;
  }

  /**
   * Extract content parts from message content
   */
  private extractContentParts(
    content: string | ChatMessage['content']
  ): ResponseContentPart[] {
    if (typeof content === 'string') {
      return [{ type: 'output_text', text: content }];
    }

    if (Array.isArray(content)) {
      return content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => ({ type: 'output_text' as const, text: c.text }));
    }

    return [];
  }
}

// ============================================
// Route Registration
// ============================================

export async function registerResponsesRoutes(
  server: FastifyInstance
): Promise<void> {
  const responsesService = new ResponsesService();

  // ==========================================
  // POST /v1/responses
  // ==========================================
  server.post<{ Body: ResponseCreateRequest }>(
    '/v1/responses',
    {
      schema: {
        tags: ['Responses'],
        summary: 'Create a response',
        description:
          'OpenAI Responses API compatible endpoint. Creates a model response for the given input with optional tool calling and web search.',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['input'],
          properties: {
            model: {
              type: 'string',
              description:
                'Model ID, "auto", or Ailin virtual aliases (e.g., "ailin-auto", "ailin-best", "ailin-fast", "ailin-economy", "ailin-consensus"). Aliases resolve to autonomous orchestration profiles over dynamically discovered provider models.',
            },
            input: {
              anyOf: [
                { 
                  type: 'string',
                  description: 'Input text as a single string. Simple format for text-only requests.',
                },
                {
                  type: 'array',
                  description: 'Array of input items supporting messages and item references. More flexible format for complex inputs.',
                  items: {
                    type: 'object',
                    properties: {
                      type: { 
                        type: 'string', 
                        enum: ['message', 'item_reference'],
                        description: 'Item type: message (conversation message) or item_reference (reference to existing item)',
                      },
                      role: { 
                        type: 'string', 
                        enum: ['user', 'assistant', 'system'],
                        description: 'Message role: user (human input), assistant (AI response), system (instructions). Required for message type.',
                      },
                      content: {
                        anyOf: [
                          { type: 'string', description: 'Text content as a string' },
                          { 
                            type: 'array',
                            description: 'Multimodal content array (text blocks, images, etc.)',
                            items: { 
                              type: 'object',
                              description: 'Content block object. Can contain text, image_url, or other multimodal content types.',
                              properties: {
                                type: {
                                  type: 'string',
                                  description: 'Content block type: text, image_url, etc.',
                                },
                                text: {
                                  type: 'string',
                                  description: 'Text content (for text type blocks)',
                                },
                                image_url: {
                                  type: 'object',
                                  description: 'Image URL object (for image_url type blocks)',
                                },
                              },
                            },
                          },
                        ],
                        description: 'Message content. Can be a string or array of content blocks.',
                      },
                      id: { 
                        type: 'string',
                        description: 'Item ID for referencing. Required for item_reference type.',
                      },
                    },
                  },
                },
              ],
            },
            instructions: { 
              type: 'string',
              description: 'System instructions to guide the model\'s behavior and response style',
            },
            tools: {
              type: 'array',
              description: 'Array of tools available to the model for function calling',
              items: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['function', 'web_search', 'file_search', 'code_interpreter'],
                    description: 'Tool type: function (custom function), web_search (web search), file_search (RAG), or code_interpreter (Python execution)',
                  },
                  function: { 
                    type: 'object',
                    description: 'Function tool definition (required when type is "function"). Contains name, description, and parameters schema.',
                  },
                  web_search: { 
                    type: 'object',
                    description: 'Web search tool configuration (required when type is "web_search")',
                  },
                },
              },
            },
            tool_choice: {
              oneOf: [
                { type: 'string', enum: ['auto', 'none', 'required'], description: 'Tool choice mode: auto (let model decide), none (no tools), required (must use tools)' },
                { type: 'object', description: 'Specific tool choice configuration object' },
              ],
              description: 'Controls which tools (if any) the model can use. Can be a string ("auto", "none", "required") or an object specifying specific tools.',
            },
            temperature: { type: 'number', minimum: 0, maximum: 2 },
            max_output_tokens: { type: 'integer', minimum: 1 },
            top_p: { type: 'number', minimum: 0, maximum: 1 },
            stream: { type: 'boolean' },
            metadata: { type: 'object', additionalProperties: { type: 'string' } },
            // Ailin extensions
            strategy: {
              type: 'string',
              enum: STRATEGY_INPUT_VALUES,
              description:
                'Canonical strategy contract with compatibility aliases. Canonical: single, cost, speed, quality, balanced, parallel, debate, quality_multipass, dynamic.',
            },
            quality_target: { 
              type: 'number', 
              minimum: 0, 
              maximum: 1,
              description: 'Target quality level (0-1). Higher values prioritize quality over speed/cost. Used in orchestration decisions.',
            },
            max_cost: { 
              type: 'number', 
              minimum: 0,
              description: 'Maximum cost threshold (in USD). Orchestration will not exceed this cost.',
            },
          },
        },
        response: {
          200: {
            description: 'Response created successfully',
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Response ID' },
              object: { type: 'string', enum: ['response'], description: 'Object type' },
              created_at: { type: 'integer', description: 'Unix timestamp of creation' },
              model: { type: 'string', description: 'Model used for response' },
              status: { type: 'string', enum: ['completed', 'in_progress', 'failed'], description: 'Response status' },
              output: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['message', 'item_reference'] },
                    role: { type: 'string' },
                    content: { oneOf: [{ type: 'string' }, { type: 'array' }] },
                    id: { type: 'string' },
                  },
                },
                description: 'Response output items',
              },
              usage: {
                type: 'object',
                properties: {
                  input_tokens: { type: 'integer' },
                  output_tokens: { type: 'integer' },
                  total_tokens: { type: 'integer' },
                },
              },
              metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Response metadata' },
              ailin_metadata: {
                type: 'object',
                properties: {
                  models_used: { type: 'array', items: { type: 'string' } },
                  strategy_used: { type: 'string' },
                  resolved_strategy: { type: 'string' },
                  resolved_model: { type: 'string' },
                  final_decider_model_id: { type: 'string' },
                  final_decider_model_name: { type: 'string' },
                  final_decider_role: { type: 'string' },
                  fallback_chain: { type: 'array', items: { type: 'string' } },
                  total_cost: { type: 'number' },
                  total_duration_ms: { type: 'number' },
                },
                additionalProperties: true,
              },
            },
          },
          400: {
            description: 'Bad request (invalid input)',
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  type: { type: 'string' },
                  code: { type: 'string' },
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
                  message: { type: 'string' },
                  type: { type: 'string' },
                  code: { type: 'string' },
                },
              },
            },
          },
        },
      },
      preHandler: authenticateRequest,
    },
    async (
      request: FastifyRequest<{ Body: ResponseCreateRequest }>,
      reply: FastifyReply
    ) => {
      const extendedRequest = request as ExtendedFastifyRequest;
      const responsesRequest = request.body;

      // Create orchestration context
      const inputSize =
        typeof responsesRequest.input === 'string'
          ? responsesRequest.input.length
          : JSON.stringify(responsesRequest.input).length;

      const userContext: OrchestrationContext = extendedRequest.userContext
        ? extendedRequest.userContext
        : createOrchestrationContext(request, {
            taskType: 'general',
            contextSize: inputSize,
          });

      const requestId =
        typeof request.id === 'string' ? request.id : `resp-${nanoid(16)}`;
      userContext.requestId = requestId;

      try {
        // Streaming path (SSE). Mirrors /v1/chat/completions: idempotency is
        // bypassed for streams (a token stream is not a replayable buffered
        // body), and we write OpenAI Responses streaming events directly to
        // `reply.raw`. Request validation happens inside buildChatRequest,
        // which runs BEFORE any SSE header/frame is written — so a 4xx still
        // returns a proper JSON error body.
        if (responsesRequest.stream) {
          log.info({ requestId }, 'Streaming responses API requested');

          // Validate up-front (throws 400 for bad input/strategy) so we can
          // still emit a JSON error before committing to the SSE channel.
          responsesService.buildChatRequest(responsesRequest, true);

          // Commit to SSE: set headers, then stream events to the raw socket.
          setupSSEHeaders(reply);
          try {
            await responsesService.createStreamingResponse(
              responsesRequest,
              userContext,
              reply.raw
            );
          } catch (streamError) {
            // Engine bootstrap / pre-iteration failure (e.g. engine not
            // initialized). Headers are already sent, so surface the error as
            // a terminal SSE error frame rather than an HTTP status change.
            const message = getErrorMessage(streamError);
            const code = extractErrorCodeFromObject(streamError) ?? 'RESPONSE_STREAM_FAILED';
            log.error({ requestId, error: message, code }, 'Responses stream setup failed');
            reply.raw.write(
              formatResponsesSSE({
                type: 'response.failed',
                response: {
                  id: `resp_${nanoid(24)}`,
                  object: 'response',
                  created_at: Math.floor(Date.now() / 1000),
                  model: responsesRequest.model ?? 'auto',
                  status: 'failed',
                  output: [],
                  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                },
                error: { message, type: 'response_error', code },
              })
            );
            reply.raw.write('data: [DONE]\n\n');
          }
          reply.raw.end();
          return reply;
        }

        // Wrap the billable execution with Idempotency-Key support. Without
        // the header this is a transparent passthrough; with it, identical
        // retries replay the original response instead of re-billing.
        return await withIdempotency({
          request,
          reply,
          organizationId: userContext.organizationId,
          requestBody: responsesRequest,
          isStreaming: false,
          handler: async () => {
            // Create response
            const response = await executeRouteWithRetry(
              () => responsesService.createResponse(responsesRequest, userContext),
              {
                operationName: 'POST /v1/responses',
                requestId,
                log,
                isIdempotent: true,
                maxAttempts: 3,
                baseDelayMs: 200,
                maxDelayMs: 1200,
              }
            );

            // Track usage for billing
            if (response.usage && userContext.organizationId) {
              await trackChatUsage({
                organizationId: userContext.organizationId,
                userId: userContext.userId ?? '',
                requestId,
                request: {
                  model: response.model,
                  messages: [],
                },
                cacheHit: false,
                totalCostOverride: response.ailin_metadata?.total_cost ?? 0,
                totalTokensOverride: response.usage.total_tokens,
              });
            }

            return { httpStatus: 200, body: response };
          },
        });
      } catch (error) {
        const statusCode = extractStatusCode(error) ?? 500;
        const errorCode = extractErrorCodeFromObject(error) ?? 'RESPONSE_FAILED';
        const errorMessage = getErrorMessage(error);
        log.error({ requestId, statusCode, errorCode, error: errorMessage }, 'Response creation failed');

        return reply.status(statusCode).send({
          error: {
            message: errorMessage,
            type: 'response_error',
            code: errorCode,
          },
        });
      }
    }
  );

  // ==========================================
  // GET /v1/responses/:response_id
  // ==========================================
  server.get<{ Params: { response_id: string } }>(
    '/v1/responses/:response_id',
    {
      schema: {
        tags: ['Responses'],
        summary: 'Retrieve a response',
        description: 'Retrieves a previously created response by ID.',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        params: {
          type: 'object',
          required: ['response_id'],
          properties: {
            response_id: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              object: { type: 'string' },
              created_at: { type: 'integer' },
              model: { type: 'string' },
              status: { type: 'string' },
              output: { type: 'array' },
              usage: { type: 'object' },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  type: { type: 'string' },
                },
              },
            },
          },
        },
      },
      preHandler: authenticateRequest,
    },
    async (
      request: FastifyRequest<{ Params: { response_id: string } }>,
      reply: FastifyReply
    ) => {
      const { response_id } = request.params;
      const extendedRequest = request as ExtendedFastifyRequest;
      const organizationId = extendedRequest.userContext?.organizationId;

      if (!organizationId) {
        return reply.status(401).send({
          error: {
            message: 'Unauthorized',
            type: 'authentication_error',
          },
        });
      }

      log.info({ responseId: response_id }, 'Response retrieval requested');

      // Retrieve response from database
      const response = await responsesService.getResponse(response_id, organizationId);

      if (!response) {
      return reply.status(404).send({
        error: {
            message: `Response ${response_id} not found.`,
          type: 'not_found_error',
        },
      });
      }

      return reply.send(response);
    }
  );

  // ==========================================
  // DELETE /v1/responses/:response_id
  // ==========================================
  server.delete<{ Params: { response_id: string } }>(
    '/v1/responses/:response_id',
    {
      schema: {
        tags: ['Responses'],
        summary: 'Delete a response',
        description: 'Deletes a response by ID.',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        params: {
          type: 'object',
          required: ['response_id'],
          properties: {
            response_id: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              object: { type: 'string' },
              deleted: { type: 'boolean' },
            },
          },
        },
      },
      preHandler: authenticateRequest,
    },
    async (
      request: FastifyRequest<{ Params: { response_id: string } }>,
      reply: FastifyReply
    ) => {
      const { response_id } = request.params;
      const extendedRequest = request as ExtendedFastifyRequest;
      const organizationId = extendedRequest.userContext?.organizationId;

      if (!organizationId) {
        return reply.status(401).send({
          error: {
            message: 'Unauthorized',
            type: 'authentication_error',
          },
        });
      }

      log.info({ responseId: response_id }, 'Response deletion requested');

      // Delete response from database
      const deleted = await responsesService.deleteResponse(response_id, organizationId);

      // Return success even if not found (idempotent)
      return reply.send({
        id: response_id,
        object: 'response.deleted',
        deleted,
      });
    }
  );

  log.info('Responses API routes registered successfully (REAL implementation)');
}
