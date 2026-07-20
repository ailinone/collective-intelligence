// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * AWS SageMaker Provider Adapter — native (NOT OpenAI-compatible by default).
 *
 * SageMaker endpoints are *customer-deployed* inference endpoints — unlike
 * Bedrock, there is NO server-side normalization across model families. Each
 * endpoint is a black box running a specific container (vLLM, TGI, HuggingFace
 * Transformers, JumpStart, or a custom Docker image) and the request/response
 * shape is container-specific.
 *
 * This adapter supports three payload schemas selectable via config:
 *   - `'openai'`   — modern containers that expose a `/v1/chat/completions`-
 *                    shaped body (vLLM with OAI API, TGI with `--messages-api`).
 *                    This is the default; it's what ~80% of 2024+ deploys use.
 *   - `'jumpstart'`— legacy HuggingFace JumpStart: `{ inputs, parameters }`.
 *                    Prompt is flattened from messages via a simple chat
 *                    template. Response is `[{ generated_text: ... }]`.
 *   - `'hf-tgi'`   — raw Text-Generation-Inference: `{ inputs, parameters }`
 *                    with a string prompt; returns `[{ generated_text }]` or
 *                    `{ generated_text }` depending on the container version.
 *
 * Auth: SigV4 delegated entirely to `@aws-sdk/client-sagemaker-runtime`.
 * Never hand-roll — crypto-critical, battle-tested path.
 *
 * Discovery: `getModels()` enumerates the operator's *deployed endpoints* via
 * `@aws-sdk/client-sagemaker` `ListEndpointsCommand`. Falls back gracefully to
 * the catalog when the caller lacks `sagemaker:ListEndpoints` IAM permission.
 *
 * Why this is a native switch-case (not a catalog entry):
 *   1. Request/response is schema-per-endpoint, not one universal shape.
 *   2. SigV4 auth via SDK (not bearer-token).
 *   3. Endpoint resolution happens from the *model name* — the model string
 *      encodes `{endpointName}` and optionally `{schema}`.
 */

import {
  SageMakerRuntimeClient,
  InvokeEndpointCommand,
  type InvokeEndpointCommandInput,
  type InvokeEndpointCommandOutput,
} from '@aws-sdk/client-sagemaker-runtime';

import {
  SageMakerClient,
  ListEndpointsCommand,
} from '@aws-sdk/client-sagemaker';

import { ProviderAdapter, type HealthCheckResult } from '../base/provider-adapter';
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  EmbeddingRequest,
  EmbeddingResponse,
  Provider,
  Model,
  ProviderConfig,
} from '@/types';
import type {
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  ModerationRequest,
  ModerationResponse,
} from '@/types/model-client';
import { logger } from '@/utils/logger';
import { getModelsByProvider } from '@/services/model-catalog-service';

/** Payload schema for a given SageMaker endpoint. */
export type SageMakerPayloadSchema = 'openai' | 'jumpstart' | 'hf-tgi';

/**
 * AWS SageMaker adapter configuration.
 *
 * Endpoints are identified by name (`endpointName`) or by full `modelName`-
 * encoded reference like `aws-sagemaker/<endpointName>`. The `payloadSchema`
 * tells the adapter how to serialize the request body.
 *
 * No specific model identifiers are hardcoded here — `getModels()` reads
 * from the model-catalog service, and endpoint names are operator-supplied
 * infrastructure handles (not model IDs).
 */
export interface AWSSageMakerAdapterConfig extends ProviderConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /**
   * Default endpoint to invoke when the request's `model` doesn't encode one.
   * If omitted, `model` MUST be of the form `aws-sagemaker/{endpointName}` (or
   * `sagemaker/{endpointName}`).
   */
  endpointName?: string;
  /**
   * Payload schema for the default endpoint. Can also be encoded per-model
   * via metadata (future enhancement). Defaults to `'openai'` which is what
   * modern vLLM / TGI-messages-api containers expose.
   */
  payloadSchema?: SageMakerPayloadSchema;
  /**
   * Optional custom attributes header (SageMaker-specific). Used for things
   * like streaming hints or provider-specific routing. Passed through to
   * `InvokeEndpointCommand.CustomAttributes`.
   */
  customAttributes?: string;
  /** MIME type for the request body. Default 'application/json'. */
  contentType?: string;
  /** MIME type the endpoint returns. Default 'application/json'. */
  accept?: string;
  /**
   * Override the internal providerName (default `'aws-sagemaker'`) so that
   * multi-deployment factory expansion (Batch 8.2) can register N distinct
   * adapter instances under N distinct `ProviderRegistry` keys. When unset
   * the default fires — preserving single-endpoint backward compat.
   */
  providerNameOverride?: string;
  /** Override display name (optional, paired with providerNameOverride). */
  displayNameOverride?: string;
}

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_CONTENT_TYPE = 'application/json';
const DEFAULT_ACCEPT = 'application/json';
const DEFAULT_SCHEMA: SageMakerPayloadSchema = 'openai';

/**
 * AWS SageMaker Adapter
 * Native adapter — invokes a deployed SageMaker endpoint via the AWS SDK.
 */
export class AWSSageMakerAdapter extends ProviderAdapter {
  private runtimeClient: SageMakerRuntimeClient;
  private controlClient: SageMakerClient;
  private region: string;
  private endpointName?: string;
  private payloadSchema: SageMakerPayloadSchema;
  private customAttributes?: string;
  private contentType: string;
  private accept: string;
  // Resolved name/display — set in constructor so the multi-deployment
  // factory can register N instances with distinct keys. Defaults
  // preserve the single-instance backward-compatible behavior.
  private readonly resolvedProviderName: string;
  private readonly resolvedDisplayName: string;
  private providerLog;

  constructor(config: AWSSageMakerAdapterConfig) {
    const providerName =
      config.providerNameOverride?.trim() || 'aws-sagemaker';
    const displayName =
      config.displayNameOverride?.trim() || 'AWS SageMaker';
    super(providerName, displayName, config);
    this.resolvedProviderName = providerName;
    this.resolvedDisplayName = displayName;
    this.providerLog = logger.child({ provider: providerName });

    const accessKeyId =
      config.accessKeyId || process.env.AWS_ACCESS_KEY_ID || config.apiKey;
    const secretAccessKey =
      config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = config.sessionToken || process.env.AWS_SESSION_TOKEN;
    this.region =
      config.region ||
      process.env.AWS_SAGEMAKER_REGION ||
      process.env.AWS_REGION ||
      DEFAULT_REGION;
    this.endpointName =
      config.endpointName || process.env.AWS_SAGEMAKER_ENDPOINT_NAME;
    this.payloadSchema =
      config.payloadSchema ||
      (process.env.AWS_SAGEMAKER_PAYLOAD_SCHEMA as SageMakerPayloadSchema) ||
      DEFAULT_SCHEMA;
    this.customAttributes =
      config.customAttributes || process.env.AWS_SAGEMAKER_CUSTOM_ATTRIBUTES;
    this.contentType = config.contentType || DEFAULT_CONTENT_TYPE;
    this.accept = config.accept || DEFAULT_ACCEPT;

    if (!accessKeyId) {
      throw new Error(
        'AWSSageMakerAdapter requires accessKeyId (set AWS_ACCESS_KEY_ID env var, ' +
          'config.accessKeyId, or config.apiKey)',
      );
    }
    if (!secretAccessKey) {
      throw new Error(
        'AWSSageMakerAdapter requires secretAccessKey (set AWS_SECRET_ACCESS_KEY env ' +
          'var or config.secretAccessKey)',
      );
    }

    const credentials = { accessKeyId, secretAccessKey, sessionToken };
    this.runtimeClient = new SageMakerRuntimeClient({
      region: this.region,
      credentials,
    });
    this.controlClient = new SageMakerClient({
      region: this.region,
      credentials,
    });

    this.providerLog.info(
      {
        region: this.region,
        hasSessionToken: Boolean(sessionToken),
        hasDefaultEndpoint: Boolean(this.endpointName),
        payloadSchema: this.payloadSchema,
      },
      'AWSSageMakerAdapter initialized',
    );
  }

  // ── Identity ────────────────────────────────────────────────────────

  override getName(): string {
    return this.resolvedProviderName;
  }

  override getDisplayName(): string {
    return this.resolvedDisplayName;
  }

  getRegion(): string {
    return this.region;
  }

  getPayloadSchema(): SageMakerPayloadSchema {
    return this.payloadSchema;
  }

  // ── Provider + Model surface ────────────────────────────────────────

  async getProvider(): Promise<Provider> {
    const models = await this.getModels();
    return {
      id: this.resolvedProviderName,
      name: this.resolvedProviderName,
      displayName: this.resolvedDisplayName,
      status: models.length > 0 ? 'active' : 'disabled',
      health: { status: 'healthy' as const, lastCheck: new Date(), latency: 0 },
      models,
      metadata: { region: this.region },
    };
  }

  /**
   * Returns models from the catalog (which is the source of truth for model
   * metadata — costs, capabilities). Endpoint discovery via `ListEndpoints`
   * is exposed separately through `listDeployedEndpoints()` because the list
   * changes at runtime and we don't want to couple that to the Model shape.
   */
  async getModels(): Promise<Model[]> {
    // When a multi-deployment instance registers under a derived name
    // (e.g. `aws-sagemaker-<alias>`), first try the derived slot so
    // per-endpoint catalog entries (if ever added) surface correctly.
    // Fall back to the parent `aws-sagemaker` slot so the legacy
    // single-instance path (where only the parent key exists in the
    // model catalog) keeps working.
    if (this.resolvedProviderName !== 'aws-sagemaker') {
      const perInstance = await getModelsByProvider(this.resolvedProviderName);
      if (perInstance.length > 0) return perInstance;
    }
    return getModelsByProvider('aws-sagemaker');
  }

  /**
   * Enumerate the caller's deployed SageMaker endpoints in the configured
   * region. Returns the raw endpoint summaries; the caller decides how to
   * surface them (fleet dashboard, admin UI, etc.). Soft-fails (returns [])
   * on IAM permission errors so a missing `sagemaker:ListEndpoints` policy
   * doesn't brick the provider.
   */
  async listDeployedEndpoints(): Promise<
    Array<{ name: string; status?: string; creationTime?: Date }>
  > {
    try {
      const response = await this.controlClient.send(new ListEndpointsCommand({}));
      return (response.Endpoints ?? []).map((ep) => ({
        name: ep.EndpointName ?? '',
        status: ep.EndpointStatus,
        creationTime: ep.CreationTime,
      }));
    } catch (error: unknown) {
      this.providerLog.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'ListEndpoints failed — returning empty list (likely IAM permission missing)',
      );
      return [];
    }
  }

  // ── Health ──────────────────────────────────────────────────────────

  /**
   * Health check: we probe the *control plane* (ListEndpoints) rather than
   * invoking any specific endpoint. This verifies SigV4 credentials work and
   * the region is reachable without paying invocation cost on an arbitrary
   * endpoint (some endpoints have long cold-starts).
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    try {
      await this.controlClient.send(new ListEndpointsCommand({ MaxResults: 1 }));
      return { healthy: true, latency: Date.now() - startTime, checkedAt: new Date() };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { healthy: false, error: errorMessage, checkedAt: new Date() };
    }
  }

  // ── Chat completion (non-streaming) ─────────────────────────────────

  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    return this.executeThroughBulkhead(async () => {
      const endpointName = this.resolveEndpointName(request.model);
      const body = buildRequestBody(request, this.payloadSchema);
      const invokeInput: InvokeEndpointCommandInput = {
        EndpointName: endpointName,
        Body: new TextEncoder().encode(JSON.stringify(body)),
        ContentType: this.contentType,
        Accept: this.accept,
        ...(this.customAttributes ? { CustomAttributes: this.customAttributes } : {}),
      };

      this.providerLog.debug(
        { endpointName, schema: this.payloadSchema, messageCount: request.messages.length },
        'InvokeEndpoint request',
      );

      const response = await this.runtimeClient.send(new InvokeEndpointCommand(invokeInput));
      return parseEndpointResponse(response, request.model ?? endpointName, this.payloadSchema);
    }, 'aws-sagemaker.chatCompletion');
  }

  // ── Chat completion (streaming) ─────────────────────────────────────

  /**
   * SageMaker streaming uses `InvokeEndpointWithResponseStream` which requires
   * the underlying container to support streaming (TGI, vLLM do; JumpStart
   * traditionally doesn't). We fall back to non-streaming and emit a single
   * chunk. A dedicated streaming pack is queued for a follow-up batch that
   * imports `InvokeEndpointWithResponseStreamCommand` and parses the event
   * payload stream.
   */
  async *chatCompletionStream(
    request: ChatRequest,
  ): AsyncGenerator<ChatResponse, void, unknown> {
    const full = await this.chatCompletion(request);
    const content = full.choices?.[0]?.message?.content ?? '';
    const contentText = typeof content === 'string' ? content : '';
    const created = full.created;
    const id = full.id;
    const modelName = full.model;
    yield {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelName,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: contentText },
          finish_reason: null,
        },
      ],
    };
    yield {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelName,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: full.choices?.[0]?.finish_reason ?? 'stop',
        },
      ],
    };
  }

  // ── Embeddings ──────────────────────────────────────────────────────

  /**
   * SageMaker embeddings ARE possible (deploy an embedding container and
   * invoke it) but the response shape is per-container — we'd need the same
   * schema union as chat. Deferred to the dedicated embeddings pack.
   */
  async generateEmbeddings(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error(
      'aws-sagemaker: generateEmbeddings not yet implemented. ' +
        'Deploy a dedicated embedding endpoint and invoke via a follow-up embeddings pack.',
    );
  }

  // ── Unsupported capabilities (throw per base-class contract) ────────

  async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('aws-sagemaker: imageEdit not supported (endpoint-dependent)');
  }

  async imageVariation(
    _model: Model,
    _request: ImageVariationRequest,
  ): Promise<ImageVariationResponse> {
    throw new Error('aws-sagemaker: imageVariation not supported (endpoint-dependent)');
  }

  async moderate(_model: Model, _request: ModerationRequest): Promise<ModerationResponse> {
    throw new Error(
      'aws-sagemaker: native moderate() not supported. Deploy a moderation endpoint ' +
        'and route via a specialised endpoint adapter instance.',
    );
  }

  // ── Cost + normalization ────────────────────────────────────────────

  /**
   * SageMaker billing is per-hour of deployed instance (infrastructure cost)
   * — NOT per-token. So provider-level per-token cost is inherently an
   * approximation. If the Model carries per-1k token rates (operator supplies
   * them based on their amortised instance-hour cost), we honor them.
   * Otherwise return 0.
   *
   * Uses the canonical `inputCostPer1k`/`outputCostPer1k` shape from the
   * current Model schema (the earlier `pricing.inputCostPer1M` shape no
   * longer exists — see anthropic-adapter.ts:332-338 for the reference).
   */
  calculateCost(model: Model, inputTokens: number, outputTokens: number): number {
    const inputRate = Number(model.inputCostPer1k) || 0;
    const outputRate = Number(model.outputCostPer1k) || 0;
    const cost =
      (inputTokens / 1000) * Math.max(0, inputRate) +
      (outputTokens / 1000) * Math.max(0, outputRate);
    return Math.max(0, cost);
  }

  normalizeModelName(modelName: string): string {
    if (modelName.startsWith('aws-sagemaker/')) {
      return modelName.slice('aws-sagemaker/'.length);
    }
    if (modelName.startsWith('sagemaker/')) {
      return modelName.slice('sagemaker/'.length);
    }
    return modelName;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Resolve which SageMaker endpoint to invoke.
   * Precedence:
   *   1. Model string encodes endpoint:  `aws-sagemaker/my-endpoint`
   *   2. Adapter was constructed with a default endpointName
   *   3. Throw — without an endpoint there's literally nothing to call.
   */
  private resolveEndpointName(requestedModel: string | undefined): string {
    if (requestedModel) {
      const normalized = this.normalizeModelName(requestedModel);
      if (normalized && normalized.length > 0) return normalized;
    }
    if (this.endpointName) return this.endpointName;
    throw new Error(
      'aws-sagemaker: no endpoint to invoke. Either pass `model: "aws-sagemaker/{endpoint-name}"` ' +
        'in the request or configure `endpointName` on the adapter.',
    );
  }
}

// ═══ Exported pure helpers (testable in isolation) ═══════════════════

/**
 * Build the request body for a given payload schema.
 * Each schema emits a distinct JSON shape that matches what the container
 * behind the endpoint expects.
 */
export function buildRequestBody(
  request: ChatRequest,
  schema: SageMakerPayloadSchema,
): unknown {
  switch (schema) {
    case 'openai':
      return buildOpenAIStyleBody(request);
    case 'jumpstart':
      return buildJumpstartBody(request);
    case 'hf-tgi':
      return buildHfTgiBody(request);
    default: {
      // Exhaustiveness check — new schema value added above without
      // a builder is caught at compile time.
      const _exhaustive: never = schema;
      void _exhaustive;
      throw new Error(`aws-sagemaker: unknown payloadSchema '${schema as string}'`);
    }
  }
}

/**
 * OAI-style body: pass messages straight through, mirror the OAI request
 * shape except for non-portable Ailin-specific fields.
 */
export function buildOpenAIStyleBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: request.messages.map(normalizeOAIMessage),
  };
  if (request.model) body.model = request.model;
  if (typeof request.max_tokens === 'number') body.max_tokens = request.max_tokens;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.top_p === 'number') body.top_p = request.top_p;
  if (typeof request.stream === 'boolean') body.stream = request.stream;
  if (request.stop !== undefined) body.stop = request.stop;
  if (request.tools && request.tools.length > 0) body.tools = request.tools;
  return body;
}

/**
 * Strip Ailin-specific / tool fields that might confuse a strict OAI-like
 * container. Keeps role + content + name + tool_call_id.
 */
function normalizeOAIMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: m.role,
    content: m.content,
  };
  if (m.name !== undefined) out.name = m.name;
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
  if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
  return out;
}

/**
 * JumpStart body: `{ inputs: string, parameters: object }`. We flatten the
 * messages into a single prompt using a basic chat template — not perfect for
 * every model family, but good enough to get text through. Operators who need
 * family-specific templates can supply the flattened prompt directly as a
 * single user message.
 */
export function buildJumpstartBody(request: ChatRequest): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  if (typeof request.max_tokens === 'number') parameters.max_new_tokens = request.max_tokens;
  if (typeof request.temperature === 'number') parameters.temperature = request.temperature;
  if (typeof request.top_p === 'number') parameters.top_p = request.top_p;
  if (request.stop !== undefined) {
    parameters.stop = Array.isArray(request.stop) ? request.stop : [request.stop];
  }
  return {
    inputs: flattenMessagesToPrompt(request.messages),
    parameters,
  };
}

/**
 * HuggingFace TGI body: `{ inputs: string, parameters: {...} }` — very close
 * to JumpStart but uses TGI's parameter names (max_new_tokens, do_sample).
 */
export function buildHfTgiBody(request: ChatRequest): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  if (typeof request.max_tokens === 'number') parameters.max_new_tokens = request.max_tokens;
  if (typeof request.temperature === 'number') {
    parameters.temperature = request.temperature;
    parameters.do_sample = request.temperature > 0;
  }
  if (typeof request.top_p === 'number') parameters.top_p = request.top_p;
  if (request.stop !== undefined) {
    parameters.stop = Array.isArray(request.stop) ? request.stop : [request.stop];
  }
  return {
    inputs: flattenMessagesToPrompt(request.messages),
    parameters,
  };
}

/**
 * Flatten OAI messages[] into a single prompt string using a minimal chat
 * template. Format:
 *   System: <text>\n\nUser: <text>\n\nAssistant: <text>\n\nUser: <text>\n\nAssistant:
 * The trailing "Assistant:" primes the model to emit an assistant turn.
 */
export function flattenMessagesToPrompt(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content
            .map((p) => (p && typeof p === 'object' && 'text' in p ? (p as { text: string }).text : ''))
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
            .join('\n')
        : String(m.content ?? '');
    if (!text) continue;
    switch (m.role) {
      case 'system':
        parts.push(`System: ${text}`);
        break;
      case 'user':
        parts.push(`User: ${text}`);
        break;
      case 'assistant':
        parts.push(`Assistant: ${text}`);
        break;
      default:
        // tool/function messages — surface as user context; dropping them
        // would lose context.
        parts.push(`${m.role}: ${text}`);
    }
  }
  // Prime an assistant turn so the model continues the conversation.
  return `${parts.join('\n\n')}\n\nAssistant:`;
}

/**
 * Parse a SageMaker InvokeEndpoint response into an OAI-shaped ChatResponse.
 * The response Body is always a UTF-8 JSON byte buffer — we decode first,
 * then dispatch to a schema-specific extractor.
 */
export function parseEndpointResponse(
  response: InvokeEndpointCommandOutput,
  modelName: string,
  schema: SageMakerPayloadSchema,
): ChatResponse {
  const bytes = response.Body;
  const bodyText = bytes ? new TextDecoder('utf-8').decode(bytes as Uint8Array) : '';
  let parsed: unknown = null;
  try {
    parsed = bodyText.length > 0 ? JSON.parse(bodyText) : null;
  } catch {
    // Non-JSON response — some containers emit plain text. Wrap it.
    parsed = { generated_text: bodyText };
  }

  const extracted = extractTextByScheme(parsed, schema);

  return {
    id: `sagemaker-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: extracted.text },
        finish_reason: extracted.finishReason,
      },
    ],
    usage: {
      prompt_tokens: extracted.promptTokens,
      completion_tokens: extracted.completionTokens,
      total_tokens: extracted.promptTokens + extracted.completionTokens,
    },
  };
}

/** Schema-specific shape extractor. */
export function extractTextByScheme(
  parsed: unknown,
  schema: SageMakerPayloadSchema,
): {
  text: string;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  promptTokens: number;
  completionTokens: number;
} {
  if (schema === 'openai') return extractOpenAIShape(parsed);
  // Both 'jumpstart' and 'hf-tgi' return a generated_text field (possibly in
  // an array wrapper). Share the extractor.
  return extractGeneratedText(parsed);
}

function extractOpenAIShape(parsed: unknown): {
  text: string;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  promptTokens: number;
  completionTokens: number;
} {
  if (!parsed || typeof parsed !== 'object') {
    return { text: '', finishReason: null, promptTokens: 0, completionTokens: 0 };
  }
  const obj = parsed as {
    choices?: Array<{
      message?: { content?: unknown };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = obj.choices?.[0];
  const raw = choice?.message?.content;
  const text =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw
            .map((p) => (p && typeof p === 'object' && 'text' in p ? (p as { text: string }).text : ''))
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
            .join('')
        : '';
  return {
    text,
    finishReason: mapOpenAIFinishReason(choice?.finish_reason),
    promptTokens: obj.usage?.prompt_tokens ?? 0,
    completionTokens: obj.usage?.completion_tokens ?? 0,
  };
}

function extractGeneratedText(parsed: unknown): {
  text: string;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  promptTokens: number;
  completionTokens: number;
} {
  // Accept shapes:
  //   [{ generated_text: "..." }]        — HF TGI array
  //   { generated_text: "..." }          — single
  //   [{ generated_text, details: {...}}] — TGI with details
  const pick = (v: unknown): string => {
    if (v && typeof v === 'object' && 'generated_text' in v) {
      const g = (v as { generated_text: unknown }).generated_text;
      return typeof g === 'string' ? g : '';
    }
    return '';
  };
  let text = '';
  let details: { finish_reason?: string; generated_tokens?: number; prefill?: unknown[] } = {};
  if (Array.isArray(parsed) && parsed.length > 0) {
    text = pick(parsed[0]);
    // Array.isArray narrows the value to `any[]` (TS lib quirk); we
    // re-annotate to keep the unknown contract from above.
    const first: unknown = parsed[0];
    if (first && typeof first === 'object' && 'details' in first) {
      details = (first as { details?: typeof details }).details ?? {};
    }
  } else if (parsed && typeof parsed === 'object') {
    text = pick(parsed);
    if ('details' in parsed) {
      details = (parsed as { details?: typeof details }).details ?? {};
    }
  }
  return {
    text,
    finishReason: mapTgiFinishReason(details.finish_reason),
    promptTokens: Array.isArray(details.prefill) ? details.prefill.length : 0,
    completionTokens: typeof details.generated_tokens === 'number' ? details.generated_tokens : 0,
  };
}

export function mapOpenAIFinishReason(
  reason: string | undefined,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
  switch (reason) {
    case 'stop':
    case 'eos_token':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return reason ? null : null;
  }
}

export function mapTgiFinishReason(
  reason: string | undefined,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
  switch (reason) {
    case 'eos_token':
    case 'stop_sequence':
      return 'stop';
    case 'length':
      return 'length';
    default:
      return null;
  }
}
