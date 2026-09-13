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
 *
 * Prompt caching (LOTE AZ, 2026-09): see ADR-025. Claude models hosted on
 * Bedrock support the same underlying prompt-cache mechanism as calling
 * Anthropic directly, exposed here as a `cachePoint` content block in the
 * Converse API rather than Anthropic's own `cache_control` field. Gated by
 * `resolveClaudeCacheMinimumTokens()` below (real, AWS-documented per-model
 * minimums) — never emitted unconditionally, and never applied to non-Claude
 * Bedrock model families (Llama / Titan / Mistral / Nova), which have their
 * own separate — and here, out-of-scope — caching contracts.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  CachePointType,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
  type SystemContentBlock,
  type Tool,
  type ToolChoice,
  type InferenceConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import { estimateTokensForText } from '@/core/orchestration/model-selection/dynamic-context-budget';

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
  null | boolean | number | string | SmithyDocumentType[] | { [prop: string]: SmithyDocumentType };

import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';

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
  ToolCall,
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

    const accessKeyId = config.accessKeyId || process.env.AWS_ACCESS_KEY_ID || config.apiKey;
    const secretAccessKey = config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
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
      const { messages, converseInput: baseInput } = buildConverseInput(request, modelId);
      const converseInput: ConverseCommandInput = { ...baseInput, modelId };

      this.providerLog.debug({ modelId, messageCount: messages.length }, 'Converse request');

      const response = await this.runtimeClient.send(new ConverseCommand(converseInput));
      return parseConverseResponse(response, modelId);
    }, 'aws-bedrock.chatCompletion');
  }

  // ── Chat completion (streaming) ─────────────────────────────────────

  /**
   * Streams a Converse response, forwarding both text and tool-call deltas.
   *
   * Bedrock's ConverseStream event union (contract verified against
   * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html,
   * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ContentBlockStartEvent.html,
   * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ContentBlockDeltaEvent.html,
   * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolUseBlockStart.html and
   * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolUseBlockDelta.html,
   * fetched 2026-09-08) announces a `tool_use` block's `toolUseId`/`name`
   * ONCE via `contentBlockStart.start.toolUse`, then streams its arguments
   * incrementally via `contentBlockDelta.delta.toolUse.input` — a STRING
   * partial-JSON fragment, distinct from the non-streaming `ToolUseBlock`'s
   * `input`, which is a complete JSON value (see
   * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolUseBlock.html
   * and `parseConverseResponse` below). Prior to this fix, this loop only
   * ever inspected `contentBlockDelta.delta.text` and `messageStop` — every
   * `contentBlockStart`/tool-use `contentBlockDelta` event was silently
   * dropped, so `stream: true` + `tools` on Bedrock discarded every tool
   * call from the stream (non-streaming was already unaffected by that
   * particular bug, though see `parseConverseResponse`'s doc comment for a
   * separate gap that WAS present there).
   *
   * `contentBlockIndex` is Bedrock's own content-block position counter
   * (text and tool_use blocks share it), so — same fix pattern as the
   * Anthropic adapter's `toolCallByBlockIndex` — it is remapped here to a
   * dense, zero-based sequence covering only tool_use blocks, which is what
   * an OpenAI-compatible client keys concurrent (parallel) tool-call
   * accumulation on (`ChatMessage.tool_calls[].index`).
   */
  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    const modelId = this.resolveModelId(request.model);
    const { converseInput: baseInput } = buildConverseInput(request, modelId);
    const streamInput: ConverseCommandInput = { ...baseInput, modelId };

    const streamResponse = await this.runtimeClient.send(new ConverseStreamCommand(streamInput));
    if (!streamResponse.stream) return;

    const created = Math.floor(Date.now() / 1000);
    const id = `bedrock-${Date.now()}`;
    const toolCallByBlockIndex = new Map<
      number,
      { toolCallIndex: number; id: string; name: string }
    >();
    let nextToolCallIndex = 0;

    for await (const event of streamResponse.stream) {
      if (event?.contentBlockStart) {
        const { start, contentBlockIndex } = event.contentBlockStart;
        const toolUse = start?.toolUse;
        if (
          toolUse?.toolUseId &&
          toolUse.name &&
          typeof contentBlockIndex === 'number'
        ) {
          const toolCallIndex = nextToolCallIndex++;
          toolCallByBlockIndex.set(contentBlockIndex, {
            toolCallIndex,
            id: toolUse.toolUseId,
            name: toolUse.name,
          });
          yield {
            id,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: toolUse.toolUseId,
                      type: 'function',
                      function: { name: toolUse.name, arguments: '' },
                      index: toolCallIndex,
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
        }
        continue;
      }

      if (event?.contentBlockDelta) {
        const { delta, contentBlockIndex } = event.contentBlockDelta;
        const textDelta = delta?.text;
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
          continue;
        }

        const toolInputDelta = delta?.toolUse?.input;
        if (typeof toolInputDelta === 'string' && typeof contentBlockIndex === 'number') {
          const tracked = toolCallByBlockIndex.get(contentBlockIndex);
          if (tracked) {
            yield {
              id,
              object: 'chat.completion.chunk',
              created,
              model: modelId,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        id: tracked.id,
                        type: 'function',
                        // Forward the raw fragment (not an accumulated
                        // total) — a standard OpenAI-client-style
                        // `arguments += delta` reconstruction depends on it.
                        function: { name: tracked.name, arguments: toolInputDelta },
                        index: tracked.toolCallIndex,
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
          }
        }
        continue;
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
export function splitSystemFromMessages(messages: ChatMessage[]): {
  messages: ChatMessage[];
  system: SystemContentBlock[];
} {
  const system: SystemContentBlock[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .map((p) =>
                  p && typeof p === 'object' && 'text' in p ? (p as { text: string }).text : ''
                )
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
  const role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user';
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
  tools: Array<{
    type?: string;
    function: { name: string; description?: string; parameters?: unknown };
  }>
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

// ═══ Prompt caching (LOTE AZ, 2026-09) — see ADR-025 ══════════════════
//
// AWS Bedrock's Converse API caches via a `cachePoint` content block placed
// IN-LINE at the end of a stable section (`tools`, `system`, or `messages`)
// rather than Anthropic-direct's per-block `cache_control` field. Bedrock
// processes sections in a fixed `tools -> system -> messages` order and
// evaluates the minimum-cacheable-size gate against the CUMULATIVE token
// count up to the checkpoint, not each section in isolation — and AWS's own
// guidance for Anthropic models on Bedrock is to place a SINGLE checkpoint
// at the end of the static content rather than one per section ("simplified
// cache management": a lone breakpoint lets Bedrock find the longest
// matching prefix automatically). We follow that guidance here: one
// checkpoint at the end of `system` (covering `tools` + `system`) when a
// system prompt is present, else one at the end of `tools`.
//
// Per-model minimums below are the real, AWS-documented values (not a
// guess) — see ADR-025 for the source and fetch date. Going below a model's
// documented minimum is NOT an API error: Bedrock accepts the request and
// silently skips caching that checkpoint ("your inference still succeeds,
// but your prefix isn't cached"). The gate here exists so we don't emit a
// cachePoint marker we already know cannot do anything, not to prevent a
// request from failing.

/**
 * Per-model minimum token count required before Bedrock will actually cache
 * a checkpoint for a Claude model, keyed by a distinguishing substring of
 * the Bedrock model id. Checked in order — entries are mutually exclusive
 * substrings of real Bedrock model ids, so ordering does not affect matches
 * today, but keep more specific ids above `CLAUDE_CACHE_MIN_TOKENS_DEFAULT`.
 *
 * Source: AWS docs, "Prompt caching for faster model inference" —
 * docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
 * (fetched 2026-09-06; see ADR-025).
 */
const CLAUDE_CACHE_MIN_TOKENS: ReadonlyArray<readonly [string, number]> = [
  ['claude-fable-5-1', 512],
  ['claude-mythos-5-1', 512],
  ['claude-fable-5', 512],
  ['claude-mythos-5', 512],
  ['claude-mythos-preview', 4096],
  ['claude-opus-5', 512],
  ['claude-opus-4-8', 1024],
  ['claude-opus-4-7', 4096],
  ['claude-opus-4-6', 4096],
  ['claude-opus-4-5', 4096],
  ['claude-sonnet-5', 1024],
  ['claude-sonnet-4-6', 1024],
  ['claude-sonnet-4-5', 1024],
  ['claude-3-7-sonnet', 1024],
  ['claude-3-5-sonnet', 1024],
  ['claude-haiku-4-5', 4096],
];

/**
 * Conservative fallback for any Claude-on-Bedrock model id not in the table
 * above (an older model AWS's current docs page no longer lists, or a new
 * one this table hasn't been updated for yet). Set to the HIGHEST minimum
 * documented for the Claude family rather than the lowest: undershooting a
 * model's real minimum only costs a missed cache opportunity (see the file
 * header note — it never causes an error), so the safe direction to guess
 * wrong in is "requires more than it actually does," not the reverse.
 */
const CLAUDE_CACHE_MIN_TOKENS_DEFAULT = 4096;

/**
 * True for any Bedrock model id belonging to the Claude family (Anthropic's
 * models hosted on Bedrock use the `anthropic.claude-...` vendor prefix,
 * with region-routed variants like `us.anthropic.claude-...`). Caching here
 * is scoped to Claude only — Nova, Llama, Titan, and Mistral on Bedrock have
 * their own separate caching contracts, out of scope for this pass.
 */
export function isBedrockClaudeModel(modelId: string): boolean {
  return modelId.toLowerCase().includes('claude');
}

/**
 * Resolve the minimum cacheable-prefix token count for a Claude-on-Bedrock
 * model id. See the `CLAUDE_CACHE_MIN_TOKENS` table doc comment for the
 * source and the fallback's rationale.
 */
export function resolveClaudeCacheMinimumTokens(modelId: string): number {
  const normalized = modelId.toLowerCase();
  for (const [needle, minTokens] of CLAUDE_CACHE_MIN_TOKENS) {
    if (normalized.includes(needle)) return minTokens;
  }
  return CLAUDE_CACHE_MIN_TOKENS_DEFAULT;
}

/**
 * Extract the plain text Bedrock will actually see from a `SystemContentBlock`
 * array built by `splitSystemFromMessages` (which only ever emits `{ text }`
 * members) — narrowed defensively in case a caller passes one through twice.
 */
function systemBlocksToText(system: SystemContentBlock[]): string {
  return system
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

/**
 * Append a Bedrock `cachePoint` checkpoint to `tools` and/or `system` for a
 * Claude model, gated by `resolveClaudeCacheMinimumTokens()`. Non-Claude
 * models and requests below the documented minimum pass through unchanged.
 *
 * Placement follows AWS's own "simplified cache management" recommendation
 * for Anthropic models (see the section header comment above): ONE
 * checkpoint at the end of `system` when a system prompt is present
 * (covering the cumulative `tools` + `system` prefix, since Bedrock chains
 * sections in that fixed order), else one at the end of `tools` alone.
 * Message-content checkpoints (e.g. a large per-turn document or image) are
 * out of scope for this pass — see ADR-025.
 */
export function applyClaudeCacheCheckpoint(
  system: SystemContentBlock[],
  tools: Tool[],
  modelId: string
): { system: SystemContentBlock[]; tools: Tool[] } {
  if (!isBedrockClaudeModel(modelId)) {
    return { system, tools };
  }

  const toolsTokens = tools.length > 0 ? estimateTokensForText(JSON.stringify(tools)) : 0;
  const systemTokens = system.length > 0 ? estimateTokensForText(systemBlocksToText(system)) : 0;
  const cumulativeTokens = toolsTokens + systemTokens;

  if (cumulativeTokens < resolveClaudeCacheMinimumTokens(modelId)) {
    return { system, tools };
  }

  const cachePointBlock = { cachePoint: { type: CachePointType.DEFAULT } };

  if (system.length > 0) {
    return { system: [...system, cachePointBlock], tools };
  }
  if (tools.length > 0) {
    return { system, tools: [...tools, cachePointBlock] };
  }
  return { system, tools };
}

/**
 * Bedrock's ToolChoice `tool` member (force one specific named tool) is
 * documented as supported only by Anthropic Claude and Amazon Nova model
 * families on Bedrock — see `resolveBedrockToolChoice`'s doc comment for the
 * source. Reuses this file's existing coarse-grained id-substring family
 * detection style (see `isBedrockClaudeModel`) rather than a maintained
 * per-model allowlist.
 */
function supportsNamedBedrockToolChoice(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.includes('claude') || normalized.includes('nova');
}

/**
 * Map the canonical OpenAI-shaped `tool_choice` onto the Bedrock Converse
 * API's `ToolChoice` union — `{auto:{}}` | `{any:{}}` | `{tool:{name}}`, per
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolChoice.html.
 *
 * Two precision points from that same reference page:
 *  - The union has NO `none` member. There is no way to expose tool
 *    definitions to the model while forbidding their use for a turn, so
 *    `tool_choice: 'none'` is handled by the caller (`buildConverseInput`)
 *    omitting `toolConfig`/`tools` entirely rather than by any value
 *    returned here.
 *  - `tool` (force one specific named tool) is documented as "Only
 *    supported by Anthropic Claude 3 and Amazon Nova models" — sending it to
 *    any other Bedrock model family (Llama, Titan, Mistral, DeepSeek, ...)
 *    would get the request rejected outright. For those families this falls
 *    back to `any` (forces *a* tool call, the closest safe approximation of
 *    the caller's intent) rather than silently dropping the request down to
 *    unconstrained `auto` — which would reproduce the exact silent-downgrade
 *    bug this fix addresses.
 *
 * OpenAI's `'required'` maps to `any`: "call some tool" and "may call a
 * tool" are different constraints. `ChatRequest['tool_choice']` doesn't
 * carry a `'required'` literal in its type today, but a real
 * OpenAI-compatible caller can still send the string at runtime, so it's
 * handled defensively here rather than only through the type.
 */
function resolveBedrockToolChoice(
  toolChoice: ChatRequest['tool_choice'] | 'required',
  modelId: string
): ToolChoice | undefined {
  if (toolChoice === undefined || toolChoice === 'none') return undefined;
  if (toolChoice === 'auto') return { auto: {} };
  if (toolChoice === 'required') return { any: {} };
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    return supportsNamedBedrockToolChoice(modelId)
      ? { tool: { name: toolChoice.function.name } }
      : { any: {} };
  }
  return undefined;
}

/**
 * Build the full Converse request body (minus `modelId`, added by the
 * caller) shared by `chatCompletion` and `chatCompletionStream` — the two
 * previously duplicated this construction verbatim, which is exactly the
 * kind of divergence risk that let caching ship on one path and not the
 * other in the first place.
 */
export function buildConverseInput(
  request: ChatRequest,
  modelId: string
): { messages: ChatMessage[]; converseInput: Omit<ConverseCommandInput, 'modelId'> } {
  const { messages, system } = splitSystemFromMessages(request.messages);
  const tools =
    request.tools && request.tools.length > 0 ? convertTools(request.tools) : ([] as Tool[]);
  const cached = applyClaudeCacheCheckpoint(system, tools, modelId);

  // `tool_choice: 'none'` has no native Bedrock equivalent (see
  // `resolveBedrockToolChoice`) — the only faithful way to honor it is to
  // suppress `tools` (and therefore `toolConfig`) entirely for this turn.
  const toolsSuppressed = cached.tools.length > 0 && request.tool_choice === 'none';
  const toolChoice = toolsSuppressed
    ? undefined
    : resolveBedrockToolChoice(request.tool_choice, modelId);

  return {
    messages,
    converseInput: {
      messages: messages.map(convertMessageToConverse),
      ...(cached.system.length > 0 ? { system: cached.system } : {}),
      inferenceConfig: buildInferenceConfig(request),
      ...(cached.tools.length > 0 && !toolsSuppressed
        ? { toolConfig: { tools: cached.tools, ...(toolChoice ? { toolChoice } : {}) } }
        : {}),
    },
  };
}

/**
 * Parse a Converse response into an OAI-shaped ChatResponse.
 *
 * Audit finding, 2026-09-08: this previously extracted ONLY `text` content
 * blocks — a non-streaming Converse response whose `stopReason` is
 * `'tool_use'` (a model calling a tool) had its `toolUse` block(s) silently
 * dropped entirely, with no `tool_calls` ever reaching the caller. This was
 * NOT limited to the streaming path (see `chatCompletionStream`'s doc
 * comment) — non-streaming tool calling was equally broken. Fixed per the
 * documented `ToolUseBlock` shape (`toolUseId`, `name`, `input` as a
 * complete JSON value — contrast with the streaming `ToolUseBlockDelta`,
 * whose `input` is an incremental JSON *string* fragment):
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolUseBlock.html
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ContentBlock.html
 * (fetched 2026-09-08).
 */
export function parseConverseResponse(
  response: ConverseCommandOutput,
  modelName: string
): ChatResponse {
  const message = response.output?.message;
  const blocks = message?.content ?? [];

  const text = blocks
    .map((block) => {
      if (block && typeof block === 'object' && 'text' in block) {
        return typeof block.text === 'string' ? block.text : '';
      }
      return '';
    })
    .filter((s) => s.length > 0)
    .join('');

  const toolUseBlocks = blocks
    .map((block) => {
      if (!block || typeof block !== 'object' || !('toolUse' in block) || !block.toolUse) {
        return null;
      }
      const toolUse = block.toolUse as { toolUseId?: string; name?: string; input?: unknown };
      if (typeof toolUse.toolUseId !== 'string' || typeof toolUse.name !== 'string') return null;
      return { toolUseId: toolUse.toolUseId, name: toolUse.name, input: toolUse.input };
    })
    .filter((tu): tu is { toolUseId: string; name: string; input: unknown } => tu !== null);

  // Dense zero-based index over tool_use blocks only — mirrors the
  // Anthropic adapter's non-streaming `convertResponse` convention (array
  // position among the filtered tool calls, not the raw content-block
  // position, which may also count interleaved text blocks).
  const toolCalls: ToolCall[] = toolUseBlocks.map((tu, index) => ({
    id: tu.toolUseId,
    type: 'function' as const,
    function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
    index,
  }));

  return {
    id: `bedrock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
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
