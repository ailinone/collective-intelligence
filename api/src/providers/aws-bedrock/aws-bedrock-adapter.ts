// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * AWS Bedrock Provider Adapter — native (NOT OpenAI-compatible).
 *
 * Design rationale (see Batch 7.1 report):
 *  - Uses the **Converse API** (not InvokeModel) so the adapter stays model-
 *    family agnostic. Converse normalizes across Claude / Llama / Titan /
 *    Mistral / Nova server-side — we emit ONE payload shape regardless of
 *    the underlying model family the operator selects.
 *  - SigV4 signing is delegated to `@aws-sdk/client-bedrock-runtime`. We never
 *    hand-roll canonical requests — that path is crypto-critical and the SDK
 *    is battle-tested.
 *  - System-message extraction from the OAI `messages[]` array is load-
 *    bearing: OpenAI puts system-in-messages; Converse takes a separate
 *    top-level `system[]`. Forgetting this ships the system prompt as a user
 *    turn (works, but poisons quality metrics).
 *  - No OAI-compat shim: this adapter goes through the `provider-registry.ts`
 *    switch path (native adapters), not the catalog+factory path. Counted
 *    against the anti-hardcode-guard baseline (21 → 22) deliberately.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
  type SystemContentBlock,
  type Tool,
  type InferenceConfiguration,
} from '@aws-sdk/client-bedrock-runtime';

/**
 * Local mirror of smithy's `DocumentType` — the recursive JSON-value type
 * Bedrock's `ToolSpecification.inputSchema.json` accepts.
 *
 * Declared locally (not imported from `@smithy/types`) because that package
 * is a *transitive* dep of the AWS SDK, not a direct one; importing it here
 * would force it into package.json even though we only need the type shape.
 * This mirrors the architectural principle applied in
 * `broadcast/infrastructure/encryption/gcp-kms-kek-provider.ts` — model the
 * minimal external type surface locally rather than pulling in a package for
 * a type alias.
 */
type SmithyDocumentType =
  | null
  | boolean
  | number
  | string
  | SmithyDocumentType[]
  | { [prop: string]: SmithyDocumentType };

import {
  BedrockClient,
  ListFoundationModelsCommand,
} from '@aws-sdk/client-bedrock';

import { ProviderAdapter, type HealthCheckResult } from '../base/provider-adapter';
import { narrowAs } from '@/utils/type-guards';
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

/**
 * AWS Bedrock adapter configuration.
 *
 * All fields except `apiKey` (which we repurpose as a sentinel) fall back to
 * environment variables. `apiKey` is required by the base-class ProviderConfig
 * contract — we store the AWS access key ID there so `getApiKey()` still
 * returns something meaningful for telemetry.
 */
export interface AWSBedrockAdapterConfig extends ProviderConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /**
   * Optional Bedrock inference-profile ARN for cross-region / provisioned
   * throughput routing. When set, ConverseCommand's `modelId` will receive
   * this ARN in place of the raw model id.
   */
  inferenceProfileArn?: string;
}

const DEFAULT_BEDROCK_REGION = 'us-east-1';

/**
 * AWS Bedrock Adapter
 * Native adapter — calls Bedrock Converse API via the AWS SDK.
 */
export class AWSBedrockAdapter extends ProviderAdapter {
  private runtimeClient: BedrockRuntimeClient;
  private controlClient: BedrockClient;
  private region: string;
  private inferenceProfileArn?: string;
  private providerLog = logger.child({ provider: 'aws-bedrock' });

  constructor(config: AWSBedrockAdapterConfig) {
    super('aws-bedrock', 'AWS Bedrock', config);

    const accessKeyId =
      config.accessKeyId || process.env.AWS_ACCESS_KEY_ID || config.apiKey;
    const secretAccessKey =
      config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = config.sessionToken || process.env.AWS_SESSION_TOKEN;
    this.region =
      config.region ||
      process.env.AWS_BEDROCK_REGION ||
      process.env.AWS_REGION ||
      DEFAULT_BEDROCK_REGION;
    this.inferenceProfileArn =
      config.inferenceProfileArn || process.env.AWS_BEDROCK_INFERENCE_PROFILE_ARN;

    if (!accessKeyId) {
      throw new Error(
        'AWSBedrockAdapter requires accessKeyId (set AWS_ACCESS_KEY_ID env var, ' +
          'config.accessKeyId, or config.apiKey)'
      );
    }
    if (!secretAccessKey) {
      throw new Error(
        'AWSBedrockAdapter requires secretAccessKey (set AWS_SECRET_ACCESS_KEY env var ' +
          'or config.secretAccessKey)'
      );
    }

    const credentials = { accessKeyId, secretAccessKey, sessionToken };
    this.runtimeClient = new BedrockRuntimeClient({ region: this.region, credentials });
    this.controlClient = new BedrockClient({ region: this.region, credentials });

    this.providerLog.info(
      {
        region: this.region,
        hasSessionToken: Boolean(sessionToken),
        hasInferenceProfile: Boolean(this.inferenceProfileArn),
      },
      'AWSBedrockAdapter initialized'
    );
  }

  // ── Identity ────────────────────────────────────────────────────────

  override getName(): string {
    return 'aws-bedrock';
  }

  override getDisplayName(): string {
    return 'AWS Bedrock';
  }

  getRegion(): string {
    return this.region;
  }

  // ── Provider + Model surface ────────────────────────────────────────

  async getProvider(): Promise<Provider> {
    const models = await this.getModels();
    return {
      id: 'aws-bedrock',
      name: 'aws-bedrock',
      displayName: 'AWS Bedrock',
      status: models.length > 0 ? 'active' : 'disabled',
      health: { status: 'healthy' as const, lastCheck: new Date(), latency: 0 },
      models,
      metadata: { region: this.region },
    };
  }

  async getModels(): Promise<Model[]> {
    return getModelsByProvider('aws-bedrock');
  }

  // ── Health ──────────────────────────────────────────────────────────

  async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    try {
      await this.controlClient.send(new ListFoundationModelsCommand({}));
      return { healthy: true, latency: Date.now() - startTime, checkedAt: new Date() };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { healthy: false, error: errorMessage, checkedAt: new Date() };
    }
  }

  // ── Chat completion (non-streaming) ─────────────────────────────────

  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    return this.executeThroughBulkhead(async () => {
      // resolveModelId accepts `string | undefined` and either returns the
      // configured inference-profile ARN or a normalized model id (or throws
      // if neither is available). Downstream we use `modelId` — guaranteed
      // string — so the ChatResponse's required `model: string` is satisfied
      // even when the caller didn't send one.
      const modelId = this.resolveModelId(request.model);
      const { messages, system } = splitSystemFromMessages(request.messages);
      const converseInput: ConverseCommandInput = {
        modelId,
        messages: messages.map(convertMessageToConverse),
        ...(system.length > 0 ? { system } : {}),
        inferenceConfig: buildInferenceConfig(request),
        ...(request.tools && request.tools.length > 0
          ? { toolConfig: { tools: convertTools(request.tools) } }
          : {}),
      };

      this.providerLog.debug({ modelId, messageCount: messages.length }, 'Converse request');

      const response = await this.runtimeClient.send(new ConverseCommand(converseInput));
      return parseConverseResponse(response, modelId);
    }, 'aws-bedrock.chatCompletion');
  }

  // ── Chat completion (streaming) ─────────────────────────────────────

  async *chatCompletionStream(
    request: ChatRequest
  ): AsyncGenerator<ChatResponse, void, unknown> {
    const modelId = this.resolveModelId(request.model);
    const { messages, system } = splitSystemFromMessages(request.messages);
    const streamInput: ConverseCommandInput = {
      modelId,
      messages: messages.map(convertMessageToConverse),
      ...(system.length > 0 ? { system } : {}),
      inferenceConfig: buildInferenceConfig(request),
      ...(request.tools && request.tools.length > 0
        ? { toolConfig: { tools: convertTools(request.tools) } }
        : {}),
    };

    const streamResponse = await this.runtimeClient.send(
      new ConverseStreamCommand(streamInput)
    );
    if (!streamResponse.stream) return;

    // Accumulate deltas. Converse stream events are a discriminated union —
    // contentBlockDelta events carry the text fragments.
    const created = Math.floor(Date.now() / 1000);
    const id = `bedrock-${Date.now()}`;
    for await (const event of streamResponse.stream) {
      const textDelta = event?.contentBlockDelta?.delta?.text;
      if (typeof textDelta === 'string' && textDelta.length > 0) {
        yield {
          id,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: textDelta },
              finish_reason: null,
            },
          ],
        };
      }
      if (event?.messageStop) {
        yield {
          id,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: mapStopReason(event.messageStop.stopReason),
            },
          ],
        };
      }
    }
  }

  // ── Embeddings ──────────────────────────────────────────────────────

  async generateEmbeddings(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    // Bedrock embeddings use `InvokeModelCommand` with per-family body shapes
    // (Titan: {inputText}, Cohere: {texts, input_type}). Deferred — covered
    // by the dedicated embeddings pack in a subsequent batch.
    throw new Error(
      'aws-bedrock: generateEmbeddings not yet implemented. ' +
        'Use a Bedrock embeddings model via a dedicated embeddings pack (follow-up batch).'
    );
  }

  // ── Unsupported capabilities (throw per base-class contract) ────────

  async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('aws-bedrock: imageEdit not supported');
  }

  async imageVariation(
    _model: Model,
    _request: ImageVariationRequest
  ): Promise<ImageVariationResponse> {
    throw new Error('aws-bedrock: imageVariation not supported');
  }

  async moderate(_model: Model, _request: ModerationRequest): Promise<ModerationResponse> {
    throw new Error(
      'aws-bedrock: native moderate() not supported. Route via a guardrails-aware model.'
    );
  }

  // ── Cost + normalization ────────────────────────────────────────────

  calculateCost(model: Model, inputTokens: number, outputTokens: number): number {
    // Canonical pattern aligned with anthropic-adapter.ts: the Model shape
    // carries flat `inputCostPer1k` / `outputCostPer1k` Prisma Decimals.
    // `Number(decimal) || 0` normalizes both the Prisma Decimal wrapper and
    // a numeric/string fallback; `Math.max(0, …)` guards against negative
    // rates bleeding through from a bad catalog row.
    const inputRate = Number(model.inputCostPer1k) || 0;
    const outputRate = Number(model.outputCostPer1k) || 0;
    const cost =
      (inputTokens / 1000) * Math.max(0, inputRate) +
      (outputTokens / 1000) * Math.max(0, outputRate);
    return Math.max(0, cost);
  }

  normalizeModelName(modelName: string): string {
    // Accept 'aws-bedrock/anthropic.claude-...' → 'anthropic.claude-...'
    if (modelName.startsWith('aws-bedrock/')) {
      return modelName.slice('aws-bedrock/'.length);
    }
    if (modelName.startsWith('bedrock/')) {
      return modelName.slice('bedrock/'.length);
    }
    return modelName;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Resolve the model id the SDK should see.
   * Precedence:
   *   1. A configured inference-profile ARN (cross-region / provisioned
   *      throughput routing) — the profile routes across regions server-side.
   *   2. A request-supplied model id (normalized to strip the `aws-bedrock/`
   *      prefix).
   *   3. Throw — without either, there is literally no model to call.
   *
   * Accepts `string | undefined` to match `ChatRequest.model`, which went
   * optional when orchestration started deciding the model at a higher layer.
   * The returned string is used downstream as the guaranteed `model` value in
   * the emitted `ChatResponse`.
   */
  private resolveModelId(requestedModel: string | undefined): string {
    if (this.inferenceProfileArn) return this.inferenceProfileArn;
    if (requestedModel && requestedModel.length > 0) {
      return this.normalizeModelName(requestedModel);
    }
    throw new Error(
      'aws-bedrock: no model to invoke. Either pass `model` in the request or ' +
        'configure `inferenceProfileArn` on the adapter (AWS_BEDROCK_INFERENCE_PROFILE_ARN).'
    );
  }
}

// ═══ Exported pure helpers (testable in isolation) ═══════════════════

/**
 * Split OpenAI `messages[]` into Converse-shaped `messages[]` + `system[]`.
 * All role:'system' messages are hoisted into the system array; their order
 * is preserved but they come out as separate SystemContentBlocks.
 */
export function splitSystemFromMessages(
  messages: ChatMessage[]
): { messages: ChatMessage[]; system: SystemContentBlock[] } {
  const system: SystemContentBlock[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((p) => (p && typeof p === 'object' && 'text' in p ? (p as { text: string }).text : ''))
              .filter((s): s is string => typeof s === 'string' && s.length > 0)
              .join('\n')
          : String(m.content ?? '');
      if (text.length > 0) system.push({ text });
    } else {
      rest.push(m);
    }
  }
  return { messages: rest, system };
}

/**
 * Convert a single OAI `ChatMessage` to a Converse `Message`.
 * Non-text parts (image_url, tool calls) are currently dropped with a warn-
 * friendly stub — expand in a follow-up vision pack.
 */
export function convertMessageToConverse(message: ChatMessage): Message {
  const role: 'user' | 'assistant' =
    message.role === 'assistant' ? 'assistant' : 'user';
  if (typeof message.content === 'string') {
    return { role, content: [{ text: message.content }] };
  }
  if (Array.isArray(message.content)) {
    const content = message.content
      .map((part) => {
        if (!part || typeof part !== 'object') return null;
        if ('text' in part && typeof (part as { text: unknown }).text === 'string') {
          return { text: (part as { text: string }).text };
        }
        // image_url and tool-use fragments require dedicated mapping — out of
        // scope for this pack; preserve empty to avoid poisoning the turn.
        return null;
      })
      .filter((c): c is { text: string } => c !== null);
    return { role, content: content.length > 0 ? content : [{ text: '' }] };
  }
  return { role, content: [{ text: String(message.content ?? '') }] };
}

/**
 * Build Converse inferenceConfig from an OAI ChatRequest.
 * Nullables left unset (SDK applies per-family defaults).
 */
export function buildInferenceConfig(request: ChatRequest): InferenceConfiguration {
  const cfg: InferenceConfiguration = {};
  if (typeof request.max_tokens === 'number') cfg.maxTokens = request.max_tokens;
  if (typeof request.temperature === 'number') cfg.temperature = request.temperature;
  if (typeof request.top_p === 'number') cfg.topP = request.top_p;
  if (Array.isArray(request.stop) && request.stop.length > 0) {
    cfg.stopSequences = request.stop;
  } else if (typeof request.stop === 'string') {
    cfg.stopSequences = [request.stop];
  }
  return cfg;
}

/**
 * Convert OAI tools to Converse Tool[].
 * OAI shape: { type:'function', function:{ name, description, parameters } }
 * Converse shape: { toolSpec: { name, description, inputSchema: { json: ... } } }
 */
export function convertTools(
  tools: Array<{ type?: string; function: { name: string; description?: string; parameters?: unknown } }>
): Tool[] {
  // The Converse ToolSpec type declares `description` as a required string
  // (not `string | undefined`). Under `exactOptionalPropertyTypes`, spreading
  // `description: undefined` is a type error — so we set the field only when
  // the caller actually provided a description.
  //
  // The AWS SDK models `Tool` as a smithy-style tagged union
  // `ToolSpecMember | $UnknownMember`. TypeScript can't auto-discriminate an
  // inline object literal into the `ToolSpecMember` branch (both members have
  // `$unknown?: never`-style markers), so we annotate the callback's return
  // type explicitly — no cast required, just the branch the SDK documents.
  return tools.map((t): Tool => ({
    toolSpec: {
      name: t.function.name,
      ...(typeof t.function.description === 'string' && t.function.description.length > 0
        ? { description: t.function.description }
        : {}),
      // `inputSchema.json` expects smithy's recursive `DocumentType` (the
      // JSON-value type, mirrored locally as `SmithyDocumentType`).
      // `parameters` is `unknown` at compile time because callers wire
      // arbitrary JSON-Schema objects here. The double-cast via `unknown`
      // acknowledges that: we accept whatever JSON the caller provides and
      // let Bedrock validate it at invocation time.
      inputSchema: { json: narrowAs<SmithyDocumentType>(t.function.parameters ?? {}) },
    },
  }));
}

/**
 * Parse a Converse response into an OAI-shaped ChatResponse.
 */
export function parseConverseResponse(
  response: ConverseCommandOutput,
  modelName: string
): ChatResponse {
  const message = response.output?.message;
  const text =
    message?.content
      ?.map((block) => {
        if (block && typeof block === 'object' && 'text' in block) {
          return typeof block.text === 'string' ? block.text : '';
        }
        return '';
      })
      .filter((s) => s.length > 0)
      .join('') ?? '';

  return {
    id: `bedrock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: mapStopReason(response.stopReason),
      },
    ],
    usage: {
      prompt_tokens: response.usage?.inputTokens ?? 0,
      completion_tokens: response.usage?.outputTokens ?? 0,
      total_tokens: response.usage?.totalTokens ?? 0,
    },
  };
}

/**
 * Map Converse `stopReason` to OAI `finish_reason`.
 * Values Converse emits: 'end_turn' | 'tool_use' | 'max_tokens' |
 *                        'stop_sequence' | 'guardrail_intervened' | 'content_filtered'
 */
export function mapStopReason(
  reason: string | undefined
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'guardrail_intervened':
    case 'content_filtered':
      return 'content_filter';
    default:
      return null;
  }
}
