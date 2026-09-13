// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * IBM watsonx.ai Adapter — IAM token exchange + project-scoped generate API.
 *
 * watsonx.ai is NOT OpenAI-compatible. Extending the hub adapter would force
 * the caller through `/chat/completions` — watsonx.ai uses its own
 * `/ml/v1/text/generation` (and `/ml/v1/text/chat`) with a different payload
 * shape, model IDs are `model_id` (not `model`), and every request MUST
 * include a `project_id` field. On top of that, the Authorization header
 * carries an IAM access token minted from the user's apikey — NOT the apikey
 * itself. This adapter owns that full contract.
 *
 * ### Documented API surface
 * (Source: https://cloud.ibm.com/apidocs/watsonx-ai)
 *
 *   POST https://iam.cloud.ibm.com/identity/token
 *     Content-Type: application/x-www-form-urlencoded
 *     Body: grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=<WATSONX_APIKEY>
 *     Response: { access_token, expires_in, token_type: 'Bearer', ... }
 *
 *   GET {WATSONX_URL}/ml/v1/foundation_model_specs?version=2024-05-31&project_id=<id>
 *     List foundation model specifications available in the project.
 *
 *   POST {WATSONX_URL}/ml/v1/text/chat?version=2024-05-31
 *     Body: { model_id, project_id, messages: [{role, content}], parameters?, tools? }
 *     Authorization: Bearer <IAM_ACCESS_TOKEN>
 *     Response shape is roughly OpenAI chat — but with the extra watsonx
 *     envelope: { id, created_at, model_id, choices: [{index, message, finish_reason}], usage }.
 *
 *   POST {WATSONX_URL}/ml/v1/text/chat_stream?version=2024-05-31
 *     Same body as /text/chat above; Accept: text/event-stream. Real SSE
 *     (`data: {...}` lines), each payload shaped like an OpenAI
 *     chat-completion-chunk (`choices[].delta.{content,tool_calls}`) — see
 *     `chatCompletionStream`'s doc comment for the sourcing/honesty note on
 *     this specific shape.
 *
 *   POST {WATSONX_URL}/ml/v1/text/embeddings?version=2024-05-31
 *     Body: { model_id, project_id, inputs: string[] }
 *     Response: { results: [{ embedding: number[] }], ... }.
 *
 * ### Token lifecycle
 *
 * IAM tokens expire (typically 3600s). This adapter caches the token in
 * memory and refreshes when <60s remain. A failed refresh surfaces as a
 * healthcheck error — not a silent retry loop — so misconfigured
 * `WATSONX_APIKEY` values get reported fast.
 *
 * ### Why `integrationMode: 'catalog-only'` in the catalog row
 *
 * Even with this adapter implemented, the entry stays catalog-only until
 * the anti-hardcode + routing-contract tests confirm end-to-end behavior
 * against a real `WATSONX_APIKEY` + `WATSONX_PROJECT_ID`. Promoting to
 * `discovery+execution` is a deliberate step taken when those creds land.
 * See LOTE B notes in `providers.catalog.ts`.
 */

import { logger } from '@/utils/logger';
import {
  ProviderAdapter,
  type HealthCheckResult,
  type ProviderConfig as BaseProviderConfig,
} from '../base/provider-adapter';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  Provider,
} from '@/types';
import { narrowAs } from '@/utils/type-guards';
import type {
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  ModerationRequest,
  ModerationResponse,
} from '@/types/model-client';

export interface WatsonxAdapterConfig extends BaseProviderConfig {
  baseUrl?: string;
  projectId?: string;
  /** IAM token endpoint override. Defaults to public IBM Cloud IAM. */
  iamTokenUrl?: string;
  /** API version query param — IBM pins by date. */
  apiVersion?: string;
}

interface IamToken {
  accessToken: string;
  expiresAtMs: number;
}

export class WatsonxAdapter extends ProviderAdapter {
  private readonly apikey: string;
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly iamTokenUrl: string;
  private readonly apiVersion: string;
  private cachedToken: IamToken | null = null;
  private readonly log = logger.child({ provider: 'watsonx' });

  constructor(config: WatsonxAdapterConfig) {
    super('watsonx', 'IBM watsonx.ai', config);
    this.apikey = config.apiKey;
    this.baseUrl = (config.baseUrl || 'https://us-south.ml.cloud.ibm.com').replace(/\/$/, '');
    this.projectId = config.projectId || process.env.WATSONX_PROJECT_ID || '';
    this.iamTokenUrl = config.iamTokenUrl || 'https://iam.cloud.ibm.com/identity/token';
    this.apiVersion = config.apiVersion || '2024-05-31';
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();
    return {
      id: 'watsonx',
      name: 'watsonx',
      displayName: this.displayName,
      status: health.healthy ? 'active' : 'disabled',
      models,
      health: {
        status: health.healthy ? 'healthy' : 'degraded',
        lastCheck: health.checkedAt,
        latency: health.latency,
        errorRate: health.healthy ? 0 : 1,
      },
    };
  }

  /**
   * GET /ml/v1/foundation_model_specs?version=...&project_id=...
   *
   * Returns an envelope `{ resources: [{ model_id, ... }] }`. We map to the
   * project's Model shape; capabilities/context-window are seeded from the
   * spec when present.
   */
  async getModels(): Promise<Model[]> {
    if (!this.projectId) {
      this.log.warn('WATSONX_PROJECT_ID missing — cannot list models');
      return [];
    }
    try {
      const token = await this.getToken();
      const url = `${this.baseUrl}/ml/v1/foundation_model_specs?version=${encodeURIComponent(this.apiVersion)}&project_id=${encodeURIComponent(this.projectId)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const txt = await response.text().catch(() => '');
        this.log.warn(
          { status: response.status, body: txt.slice(0, 300) },
          'foundation_model_specs failed'
        );
        return [];
      }
      const json = (await response.json()) as {
        resources?: Array<{ model_id: string; label?: string; provider?: string }>;
      };
      const resources = Array.isArray(json.resources) ? json.resources : [];
      return resources.map((r) =>
        narrowAs<Model>({
          id: r.model_id,
          name: r.model_id,
          displayName: r.label || r.model_id,
          provider: 'watsonx',
          contextWindow: 0,
          maxOutputTokens: 0,
          capabilities: [],
        })
      );
    } catch (err) {
      this.log.error({ err }, 'watsonx getModels failed');
      return [];
    }
  }

  /**
   * Shared `text/chat` request body builder — used by both `chatCompletion`
   * (`/ml/v1/text/chat`) and `chatCompletionStream` (`/ml/v1/text/chat_stream`),
   * which per https://cloud.ibm.com/apidocs/watsonx-ai (fetched 2026-09-08)
   * are separate endpoints with an otherwise identical request body (unlike
   * OpenAI's single endpoint + `stream: true` flag) — no `stream` field is
   * added here.
   */
  private buildChatRequestBody(request: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model_id: request.model,
      project_id: this.projectId,
      messages: request.messages,
    };
    if (typeof request.temperature === 'number') body.temperature = request.temperature;
    if (typeof request.max_tokens === 'number') body.max_tokens = request.max_tokens;
    if (request.tools) body.tools = request.tools;
    if (request.tool_choice) body.tool_choice = request.tool_choice;
    if (request.response_format) body.response_format = request.response_format;
    return body;
  }

  /**
   * POST /ml/v1/text/chat?version=...
   *
   * Translates the project's ChatRequest to watsonx's shape. The response
   * envelope is already OpenAI-like for `choices[].message` so we pass it
   * through with `id`/`model` normalized to the expected ChatResponse shape.
   */
  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    if (!this.projectId) {
      throw new Error('watsonx: WATSONX_PROJECT_ID is required for chat requests');
    }
    const token = await this.getToken();
    const url = `${this.baseUrl}/ml/v1/text/chat?version=${encodeURIComponent(this.apiVersion)}`;
    const body = this.buildChatRequestBody(request);

    // Route through the resilience stack (bulkhead → breaker → timeout) so a
    // watsonx outage fast-fails and is isolated per-provider. Token exchange
    // above is auth, so it stays outside the bulkhead slot.
    return this.executeThroughBulkhead(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1000, this.config.timeout ?? 60000)),
      });

      if (!response.ok) {
        const txt = await response.text().catch(() => '');
        throw new Error(`watsonx chat HTTP ${response.status}: ${txt.slice(0, 500)}`);
      }
      const raw = (await response.json()) as Partial<ChatResponse> & {
        model_id?: string;
        id?: string;
      };
      // Normalize `model_id` → `model` for downstream consumers. ChatResponse
      // requires `model: string`, so we fall through to an empty string rather
      // than `undefined` when everything upstream is missing (should not happen
      // in practice — the watsonx contract echoes `model_id` on every chat
      // response — but TS needs the guarantee).
      return {
        ...(raw as ChatResponse),
        model: raw.model || raw.model_id || request.model || '',
      };
    }, 'chat completion');
  }

  /**
   * POST /ml/v1/text/chat_stream?version=... — real SSE streaming.
   *
   * Audit finding, 2026-09-08: this was previously an "honest placeholder"
   * that called the non-streaming `chatCompletion` once and yielded the
   * single result — no incremental deltas at all, including for tool calls.
   *
   * watsonx.ai's chat surface is explicitly documented as OpenAI-compatible
   * for the non-streaming case (see `chatCompletion`'s doc comment: "the
   * response envelope is already OpenAI-like"), and the official Python SDK
   * reference for `chat_stream` — https://ibm.github.io/watsonx-ai-python-sdk/v1.7.1/fm_model.html
   * (fetched 2026-09-08) — confirms (a) `chat_stream(messages, params, tools,
   * tool_choice, tool_choice_option, ...)` accepts the same `tools`/
   * `tool_choice` parameters as the non-streaming method, and (b) its own
   * usage example consumes the stream via `chunk["choices"][0]["delta"]` —
   * the same `choices[].delta` shape as an OpenAI chat-completion-chunk.
   * The endpoint listing itself is at
   * https://cloud.ibm.com/apidocs/watsonx-ai ("POST /ml/v1/text/chat_stream
   * — Infer text event stream").
   *
   * Honesty note (contract-only, not live-verified): neither source's
   * publicly rendered content spells out `delta.tool_calls[]`'s exact
   * incremental shape (index/id/function.name announced once, then
   * function.arguments fragments — the OpenAI convention this codebase's
   * `ChatMessage.tool_calls[].index` doc comment describes). Given watsonx's
   * own stated design goal of OpenAI-compatibility for this surface, each
   * parsed SSE payload is forwarded AS-IS (same trust boundary the
   * non-streaming path above already relies on via `...(raw as
   * ChatResponse)`) rather than reshaped — if a real account's stream
   * departs from that shape, the discrepancy needs a live capture to fix,
   * not a guess baked in here.
   */
  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    if (!this.projectId) {
      throw new Error('watsonx: WATSONX_PROJECT_ID is required for chat requests');
    }
    const token = await this.getToken();
    const url = `${this.baseUrl}/ml/v1/text/chat_stream?version=${encodeURIComponent(this.apiVersion)}`;
    const body = this.buildChatRequestBody(request);

    const response = await this.executeThroughBulkhead(
      () =>
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(1000, this.config.timeout ?? 60000)),
        }),
      'streaming chat completion'
    );

    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      throw new Error(`watsonx chat_stream HTTP ${response.status}: ${txt.slice(0, 500)}`);
    }
    if (!response.body) {
      throw new Error('watsonx chat_stream: response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const readResult = await reader.read();
        if (readResult.done) break;
        // Same treatment as the sibling Vertex AI / OpenAI-compatible-hub
        // adapters' identical reader loops: `readResult.value` resolves to
        // an unsafely-typed value in this project's lib config, so it is
        // narrowed via `unknown` + an explicit `instanceof` guard rather
        // than destructured directly (ESLint @typescript-eslint/no-unsafe-assignment).
        const value: unknown = readResult.value;
        if (!(value instanceof Uint8Array)) continue;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === '[DONE]') continue;

          let raw: (Partial<ChatResponse> & { model_id?: string; id?: string }) | null = null;
          try {
            raw = JSON.parse(dataStr) as Partial<ChatResponse> & { model_id?: string; id?: string };
          } catch (parseError) {
            this.log.warn(
              { error: parseError instanceof Error ? parseError.message : String(parseError), line },
              'watsonx chat_stream: failed to parse SSE data chunk'
            );
            continue;
          }
          if (!raw || !Array.isArray(raw.choices)) continue;

          yield {
            ...(raw as ChatResponse),
            object: 'chat.completion.chunk',
            model: raw.model || raw.model_id || request.model || '',
          };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * POST /ml/v1/text/embeddings?version=...
   */
  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (!this.projectId) {
      throw new Error('watsonx: WATSONX_PROJECT_ID is required for embeddings');
    }
    const token = await this.getToken();
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const url = `${this.baseUrl}/ml/v1/text/embeddings?version=${encodeURIComponent(this.apiVersion)}`;
    // Route through the resilience stack (bulkhead → breaker → timeout); token
    // exchange above is auth and stays outside the bulkhead slot.
    return this.executeThroughBulkhead(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model_id: request.model,
          project_id: this.projectId,
          inputs,
        }),
        signal: AbortSignal.timeout(Math.max(1000, this.config.timeout ?? 30000)),
      });
      if (!response.ok) {
        const txt = await response.text().catch(() => '');
        throw new Error(`watsonx embeddings HTTP ${response.status}: ${txt.slice(0, 500)}`);
      }
      const raw = (await response.json()) as {
        results?: Array<{ embedding: number[] }>;
        model_id?: string;
      };
      const data = (raw.results ?? []).map((r, i) => ({
        object: 'embedding' as const,
        embedding: r.embedding,
        index: i,
      }));
      return {
        object: 'list',
        data,
        model: raw.model_id || request.model,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      } as EmbeddingResponse;
    }, 'embeddings');
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    if (!this.apikey) {
      return {
        healthy: false,
        checkedAt: new Date(),
        error: 'WATSONX_APIKEY is not configured',
        latency: Date.now() - start,
      };
    }
    try {
      // Minimal probe: token exchange. If this works, the key is valid.
      await this.getToken(true);
      return {
        healthy: true,
        checkedAt: new Date(),
        latency: Date.now() - start,
      };
    } catch (err) {
      return {
        healthy: false,
        checkedAt: new Date(),
        latency: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  calculateCost(_model: Model, _inputTokens: number, _outputTokens: number): number {
    return 0;
  }

  normalizeModelName(modelName: string): string {
    return modelName?.trim() || 'meta-llama/llama-3-70b-instruct';
  }

  async imageEdit(_m: Model, _r: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('watsonx: imageEdit not supported');
  }

  async imageVariation(_m: Model, _r: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('watsonx: imageVariation not supported');
  }

  async moderate(_m: Model, _r: ModerationRequest): Promise<ModerationResponse> {
    throw new Error('watsonx: moderation not supported');
  }

  // ─── IAM token management ─────────────────────────────────────────────
  /**
   * Exchange apikey for IAM access token. Caches until expiry - 60s.
   * When `force=true`, ignores the cache — used by healthCheck to validate
   * the credential without relying on stale cached state.
   */
  private async getToken(force = false): Promise<string> {
    const now = Date.now();
    if (!force && this.cachedToken && this.cachedToken.expiresAtMs > now + 60_000) {
      return this.cachedToken.accessToken;
    }
    const body = new URLSearchParams({
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey: this.apikey,
    });
    const response = await fetch(this.iamTokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      throw new Error(`watsonx IAM token HTTP ${response.status}: ${txt.slice(0, 300)}`);
    }
    const json = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      token_type?: string;
    };
    if (!json.access_token) {
      throw new Error('watsonx IAM response missing access_token');
    }
    const ttlMs = Math.max(60_000, (json.expires_in ?? 3600) * 1000);
    this.cachedToken = {
      accessToken: json.access_token,
      expiresAtMs: now + ttlMs,
    };
    return json.access_token;
  }
}
