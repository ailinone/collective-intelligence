// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * v0 (Vercel) Adapter — Platform API chat/code-generation surface.
 *
 * v0.dev's Platform API is NOT OpenAI-compatible. There is no
 * `/v1/chat/completions` and no `/v1/models` — the wire shape is a
 * stateful "chat" resource (`POST /v1/chats`) that returns generated
 * frontend code alongside an assistant text reply, not a plain
 * OpenAI-style completion. Routing this provider through the generic
 * OpenAI-compatible hub (the catalog's old `oai-compat-pure`
 * integrationClass) 404s identically for a valid key, a garbage key, and
 * no Authorization header at all — the hub was calling a route that
 * doesn't exist on v0's app router. This adapter owns the real contract.
 *
 * ### Documented API surface
 * (Source: https://v0.app/docs/api/platform/overview, fetched 2026-08-02;
 * v0.dev/docs/... redirects to the same content)
 *
 *   POST {baseUrl}/chats
 *     Body: { message, system?, attachments?, chatPrivacy?,
 *             modelConfiguration?: { modelId, imageGenerations?, thinking? },
 *             responseMode?: 'sync'|'async'|'experimental_stream',
 *             designSystemId?, attachedSkillIds?, skills?, metadata?,
 *             mcpServerIds?, projectId? (deprecated) }
 *     Response: { id, object:'chat', privacy, text, createdAt, updatedAt?,
 *                 webUrl, apiUrl, metadata, permissions:{write},
 *                 latestVersion?: { status:'pending'|'completed'|'failed',
 *                   files:[{name,content,locked}], demoUrl?, screenshotUrl? },
 *                 messages: [{role,content,type,createdAt,...}] }
 *
 *   POST {baseUrl}/chats/{chatId}/messages
 *     Follow-up turn on an existing chat. Same request/response shape as
 *     chat creation, scoped to a chat id. NOT wired by this adapter yet —
 *     the project's shared `ChatRequest` contract has no chat-id concept
 *     (callers resend full history per call, the standard pattern for
 *     stateless callers elsewhere in this codebase), so every call here
 *     creates a fresh v0 chat. Threading a real v0 chat id through
 *     `ChatRequest.metadata` to hit this endpoint instead is a reasonable
 *     follow-up, not built this pass.
 *
 *   GET {baseUrl}/chats/{chatId}
 *     Richest documented response shape (adds `files[]` top-level
 *     convenience array, `modelConfiguration`, etc.) — not used by this
 *     adapter; `POST /chats` already returns `latestVersion.files[]` and
 *     `messages[]`, which is everything `chatCompletion` needs.
 *
 *   GET {baseUrl}/projects
 *     Used here ONLY as a cheap healthCheck probe (auth-shape check, no
 *     generation, no billing) — see `healthCheck()`.
 *
 * No `/v1/models` (or any models-listing) endpoint exists anywhere in the
 * documented surface (Projects / Chats / Deployments only). Model
 * selection is a request-level field instead:
 * `modelConfiguration.modelId`, one of exactly five documented values —
 * see `V0_MODELS` below.
 *
 * ### Why direct-extension, not the OpenAI-compatible hub
 *
 * Same reasoning as `WatsonxAdapter`: the wire shape (single `message`
 * string in, `latestVersion.files[]` + `messages[]` out) has nothing in
 * common with OpenAI chat/completions, so there is no hub behavior worth
 * inheriting.
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
  ModelCapability,
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

export interface V0AdapterConfig extends BaseProviderConfig {
  baseUrl?: string;
}

/**
 * The complete, documented `modelConfiguration.modelId` enum (from both the
 * create-chat and send-message reference pages). v0 has no `/v1/models`
 * endpoint, so this doubles as the pinned model catalog `getModels()`
 * returns — mirrors `pinnedFallback.models` in providers.catalog.ts.
 */
const V0_MODELS: ReadonlyArray<{ id: string; capabilities: ModelCapability[] }> = [
  { id: 'v0-auto', capabilities: ['chat', 'streaming', 'tool_use', 'code_generation'] },
  { id: 'v0-mini', capabilities: ['chat', 'streaming', 'code_generation'] },
  { id: 'v0-pro', capabilities: ['chat', 'streaming', 'tool_use', 'code_generation'] },
  { id: 'v0-max', capabilities: ['chat', 'streaming', 'tool_use', 'code_generation'] },
  { id: 'v0-max-fast', capabilities: ['chat', 'streaming', 'code_generation'] },
] as const;

const KNOWN_MODEL_IDS = new Set(V0_MODELS.map((m) => m.id));

interface V0File {
  object?: string;
  name: string;
  content: string;
  locked?: boolean;
}

interface V0LatestVersion {
  id?: string;
  object?: string;
  status: 'pending' | 'completed' | 'failed';
  demoUrl?: string;
  screenshotUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  files?: V0File[];
}

interface V0Message {
  id?: string;
  object?: string;
  content?: string;
  role?: 'user' | 'assistant';
  type?: string;
  createdAt?: string;
}

interface V0ChatResponse {
  id: string;
  object?: string;
  text?: string;
  createdAt?: string;
  updatedAt?: string;
  webUrl?: string;
  apiUrl?: string;
  latestVersion?: V0LatestVersion;
  messages?: V0Message[];
  modelConfiguration?: { modelId?: string };
}

export class V0Adapter extends ProviderAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly vlog = logger.child({ provider: 'v0' });

  constructor(config: V0AdapterConfig) {
    super('v0', 'v0 (Vercel)', config);
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || 'https://api.v0.dev/v1').replace(/\/$/, '');
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();
    return {
      id: 'v0',
      name: 'v0',
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
   * v0 has no bulk /models route — return the pinned catalog. A fetch
   * sentinel test guards against future accidental network leakage.
   */
  async getModels(): Promise<Model[]> {
    return V0_MODELS.map((m) =>
      narrowAs<Model>({
        id: m.id,
        name: m.id,
        displayName: m.id,
        provider: 'v0',
        contextWindow: 0,
        maxOutputTokens: 0,
        capabilities: m.capabilities,
      })
    );
  }

  /**
   * POST {baseUrl}/chats — creates a fresh v0 chat per call (see class
   * doc comment for why this doesn't thread a chat id across calls yet).
   * Pins `responseMode: 'sync'` so the call always returns a completed
   * generation rather than a pending async job requiring separate polling
   * (not built this pass).
   */
  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const { message, system } = this.buildV0Message(request);
    const modelId = this.resolveModelId(request.model);

    const body: Record<string, unknown> = {
      message,
      responseMode: 'sync',
      modelConfiguration: { modelId },
    };
    if (system) body.system = system;

    // v0 chat creation runs a full LLM generation plus a code scaffold —
    // materially slower than a typical text completion. Floor the timeout
    // above the base class's generic 60s default (still overridable
    // upward via config.timeout) so a real generation isn't cut off
    // mid-flight.
    const timeoutMs = Math.max(this.config.timeout ?? 60000, 120000);

    return this.executeThroughBulkhead(async () => {
      const response = await fetch(`${this.baseUrl}/chats`, {
        method: 'POST',
        headers: this.buildHeaders(true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const txt = await response.text().catch(() => '');
        throw new Error(`v0 chat HTTP ${response.status}: ${txt.slice(0, 500)}`);
      }

      const raw = (await response.json()) as V0ChatResponse;
      return this.toChatResponse(raw, modelId);
    }, 'chat completion');
  }

  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    // v0 lists 'experimental_stream' as a responseMode, but wiring real
    // SSE is a follow-up — honest placeholder pattern (same as
    // WatsonxAdapter): call the non-streaming path once and yield the
    // single result.
    const once = await this.chatCompletion(request);
    yield once;
  }

  async generateEmbeddings(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error('v0: generateEmbeddings not supported — v0 has no embeddings surface');
  }

  /**
   * v0 publishes no dedicated health/ping route. GET /v1/projects is the
   * cheapest documented, auth-only, non-billed call (a plain listing, not
   * a generation) — same "probe a cheap listing endpoint" pattern as
   * RunwayML (/v1/tasks) and BFL. Deliberately NOT probing POST /v1/chats
   * here: that call always performs (and bills for) a real generation.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    if (!this.apiKey) {
      return {
        healthy: false,
        checkedAt: new Date(),
        error: 'V0_API_KEY is not configured',
        latency: Date.now() - start,
      };
    }
    try {
      const res = await fetch(`${this.baseUrl}/projects`, {
        method: 'GET',
        headers: this.buildHeaders(false),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) {
        return {
          healthy: false,
          checkedAt: new Date(),
          latency: Date.now() - start,
          error: 'v0 HTTP 401 — V0_API_KEY rejected',
        };
      }
      return { healthy: true, checkedAt: new Date(), latency: Date.now() - start };
    } catch (error) {
      return {
        healthy: false,
        checkedAt: new Date(),
        latency: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  calculateCost(_model: Model, _inputTokens: number, _outputTokens: number): number {
    return 0;
  }

  normalizeModelName(modelName: string): string {
    return modelName?.trim() || 'v0-auto';
  }

  // ─── Unsupported surfaces ──────────────────────────────────────────────
  async imageEdit(_m: Model, _r: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('v0: imageEdit not supported');
  }

  async imageVariation(_m: Model, _r: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('v0: imageVariation not supported');
  }

  async moderate(_m: Model, _r: ModerationRequest): Promise<ModerationResponse> {
    throw new Error('v0: moderation not supported');
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private buildHeaders(includeJsonContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    if (includeJsonContentType) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private resolveModelId(modelName?: string): string {
    const normalized = this.normalizeModelName(modelName ?? '');
    if (!KNOWN_MODEL_IDS.has(normalized)) {
      this.vlog.warn(
        { modelId: normalized },
        'v0: modelConfiguration.modelId not in the documented enum — forwarding anyway, v0 will reject it server-side if truly invalid'
      );
    }
    return normalized;
  }

  /**
   * v0's `POST /chats` takes ONE `message` string (+ optional `system`),
   * not a role-tagged messages array like OpenAI-shape APIs. This flattens
   * the project's shared `ChatRequest.messages` into that shape:
   *   - `system`-role messages are concatenated into the `system` field
   *     v0 natively supports.
   *   - A single `user` turn with no prior history is sent verbatim —
   *     matches the documented curl example and the live-tested request
   *     shape from the prior research pass ({"message": "<prompt>"}).
   *   - Multi-turn history (the standard way this codebase's stateless
   *     ChatRequest contract represents a follow-up — resending full
   *     history rather than a server-side chat id) is flattened into a
   *     labeled "User: .../Assistant: ..." transcript so context isn't
   *     silently dropped. v0's models can parse a labeled transcript as
   *     conversational context; this is a synthesis choice (v0's API has
   *     no native multi-turn-array input), not a documented contract.
   *   - `function`/`tool`-role messages have no analog on v0's
   *     single-message surface and are intentionally dropped rather than
   *     corrupting the prompt with irrelevant tool-call payloads.
   */
  private buildV0Message(request: ChatRequest): { message: string; system?: string } {
    const systemTexts: string[] = [];
    const turns: Array<{ role: 'user' | 'assistant'; text: string }> = [];

    for (const msg of request.messages) {
      const text = this.extractTextFromChatContent(msg.content).trim();
      if (!text) continue;
      if (msg.role === 'system') {
        systemTexts.push(text);
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        turns.push({ role: msg.role, text });
      }
    }

    if (turns.length === 0) {
      throw new Error('v0: chatCompletion requires at least one user message');
    }

    const message =
      turns.length === 1 && turns[0].role === 'user'
        ? turns[0].text
        : turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`).join('\n\n');

    const system = systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined;
    return { message, system };
  }

  /**
   * Maps v0's chat-resource response into the shared `ChatResponse`
   * contract. `latestVersion.files[]` (the actual generated code) has no
   * home in `ChatResponse`'s shape, so it's serialized as fenced code
   * blocks and appended after the assistant's text reply — callers
   * reading `choices[0].message.content` still see the complete output.
   * `usage` is omitted rather than fabricated: v0 does not report token
   * counts anywhere in its documented response shape, and `usage` is
   * optional on `ChatResponse`.
   */
  private toChatResponse(raw: V0ChatResponse, requestedModelId: string): ChatResponse {
    const status = raw.latestVersion?.status;
    if (status === 'failed') {
      throw new Error(`v0: chat ${raw.id} generation failed (latestVersion.status === 'failed')`);
    }
    if (status && status !== 'completed') {
      // Shouldn't happen given responseMode:'sync' above, but guard
      // against silently reporting a not-yet-finished generation as done.
      throw new Error(
        `v0: chat ${raw.id} returned unexpected latestVersion.status '${status}' for a sync request`
      );
    }

    const assistantText = (raw.messages ?? [])
      .filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0)
      .map((m) => m.content as string)
      .join('\n\n');

    const files = raw.latestVersion?.files ?? [];
    const filesBlock = files.map((f) => '```' + f.name + '\n' + f.content + '\n```').join('\n\n');

    const content = [assistantText, filesBlock].filter((s) => s.length > 0).join('\n\n') || raw.text || '';

    const createdAtMs = raw.createdAt ? Date.parse(raw.createdAt) : NaN;
    const created = Number.isFinite(createdAtMs)
      ? Math.floor(createdAtMs / 1000)
      : Math.floor(Date.now() / 1000);

    return {
      id: raw.id,
      object: 'chat.completion',
      created,
      model: raw.modelConfiguration?.modelId || requestedModelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
    };
  }
}
