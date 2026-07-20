// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Recraft Adapter — text-to-image with style/substyle controls.
 *
 * Recraft publishes an **OpenAI-shaped** `/images/generations` endpoint with
 * one substantive extension: first-class `style` and `substyle` controls
 * that pick between vector / raster / icon / logo families. The `response_format`
 * switch and `n` / `size` knobs follow OpenAI semantics.
 *
 * Source: https://www.recraft.ai/docs/api-reference/generate-image
 *
 * ### Why a dedicated adapter
 *
 * Three reasons this exists instead of running Recraft through the plain hub:
 *
 *   1. **Style allowlist enforcement.** Recraft rejects requests with a style
 *      that isn't valid for the chosen model (v3 has "any" + vector families,
 *      v2 is raster-only). Catching this before the wire gives a clearer
 *      failure than a 400 from Recraft saying "style is invalid".
 *   2. **No /models endpoint.** Recraft doesn't expose a bulk model listing,
 *      so `getModels()` must return the static catalog rather than probing.
 *      The hub's default `getModels()` will 404 — we short-circuit.
 *   3. **Chat / embeddings are hard NOs.** Recraft is image-only. A dedicated
 *      class makes the "unsupported" surface explicit and throws with a
 *      useful message rather than a generic 404.
 *
 * ### Wire contract
 *
 *   POST /v1/images/generations
 *   Headers:
 *     Authorization: Bearer <RECRAFT_API_KEY>
 *     Content-Type: application/json
 *   Body:
 *     { prompt, model: 'recraftv3' | 'recraftv2',
 *       style?, substyle?, n?, size?, response_format? }
 *   Response:
 *     { created: number, data: [{ url?: string, b64_json?: string, image_id?: string }] }
 */

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
import type {
  ImageGenRequest,
  ImageGenResponse,
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  ModerationRequest,
  ModerationResponse,
} from '@/types/model-client';
import { narrowAs } from '@/utils/type-guards';
import { logger } from '@/utils/logger';

export interface RecraftAdapterConfig extends BaseProviderConfig {
  baseUrl?: string;
}

/** Documented style families per model — Recraft rejects mismatches server-side. */
const STYLES_BY_MODEL: Readonly<Record<string, readonly string[]>> = {
  recraftv3: ['any', 'realistic_image', 'digital_illustration', 'vector_illustration', 'icon', 'logo_raster'],
  recraftv2: ['realistic_image', 'digital_illustration'],
} as const;

/** Static models — Recraft has no bulk /models endpoint. */
const STATIC_MODELS: readonly string[] = ['recraftv3', 'recraftv2'] as const;

/** Documented `size` values accepted by Recraft. */
const ALLOWED_SIZES: readonly string[] = [
  '1024x1024',
  '1365x1024',
  '1024x1365',
  '1536x1024',
  '1024x1536',
  '1820x1024',
  '1024x1820',
  '1024x2048',
  '2048x1024',
  '1434x1024',
  '1024x1434',
  '1024x1280',
  '1280x1024',
  '1024x1707',
  '1707x1024',
] as const;

export class RecraftAdapter extends ProviderAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly rlog = logger.child({ provider: 'recraft' });

  constructor(config: RecraftAdapterConfig) {
    super('recraft', 'Recraft', config);
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || 'https://external.api.recraft.ai/v1').replace(/\/$/, '');
  }

  /** Public: validates a style for a given model. Used by tests + the merger. */
  static isValidStyleForModel(model: string, style: string): boolean {
    const allowed = STYLES_BY_MODEL[model];
    return Array.isArray(allowed) && allowed.includes(style);
  }

  /** Public: the documented size allowlist. */
  static getAllowedSizes(): readonly string[] {
    return ALLOWED_SIZES;
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();
    return {
      id: 'recraft',
      name: 'recraft',
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
   * Recraft has no bulk /models route — return the static catalog. A fetch
   * sentinel test guards against future accidental network leakage.
   */
  async getModels(): Promise<Model[]> {
    return STATIC_MODELS.map(
      (id) =>
        narrowAs<Model>(({
          id,
          name: id,
          displayName: id,
          provider: 'recraft',
          contextWindow: 0,
          maxOutputTokens: 0,
          capabilities: ['image_generation'],
        })),
    );
  }

  async chatCompletion(_request: ChatRequest): Promise<ChatResponse> {
    throw new Error('recraft: chatCompletion not supported — Recraft is image-only');
  }

  async *chatCompletionStream(_request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    throw new Error('recraft: chatCompletionStream not supported — Recraft is image-only');
    yield undefined as never;
  }

  async generateEmbeddings(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error('recraft: generateEmbeddings not supported — Recraft is image-only');
  }

  /**
   * POST /v1/images/generations — Recraft-specific style/substyle validation
   * before the wire; OpenAI-compatible response parsing after.
   */
  async imageGenerate(model: Model, request: ImageGenRequest): Promise<ImageGenResponse> {
    const modelId = (model.name || model.id || 'recraftv3').trim();
    if (!STATIC_MODELS.includes(modelId)) {
      throw new Error(`recraft: unknown model ${modelId} — expected one of ${STATIC_MODELS.join(', ')}`);
    }

    const options = (request.options || {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = {
      model: modelId,
      prompt: request.prompt,
      n: typeof options.n === 'number' ? options.n : 1,
      response_format:
        typeof options.response_format === 'string'
          ? options.response_format
          : typeof options.responseFormat === 'string'
            ? options.responseFormat
            : 'url',
    };

    // size: forward as-is if present, validate against allowlist
    if (request.size) {
      if (!ALLOWED_SIZES.includes(request.size)) {
        throw new Error(
          `recraft: invalid size ${request.size} — expected one of ${ALLOWED_SIZES.slice(0, 5).join(', ')}...`,
        );
      }
      payload.size = request.size;
    }

    // style: validate against model's allowlist
    if (typeof options.style === 'string') {
      if (!RecraftAdapter.isValidStyleForModel(modelId, options.style)) {
        throw new Error(
          `recraft: style "${options.style}" not valid for ${modelId} — expected one of ${STYLES_BY_MODEL[modelId].join(', ')}`,
        );
      }
      payload.style = options.style;
    }

    if (typeof options.substyle === 'string') {
      payload.substyle = options.substyle;
    }
    if (typeof options.negative_prompt === 'string') {
      payload.negative_prompt = options.negative_prompt;
    }
    if (options.controls && typeof options.controls === 'object') {
      payload.controls = options.controls;
    }

    const raw = await this.fetchJson<{
      created?: number;
      data?: Array<{ url?: string; b64_json?: string; image_id?: string }>;
    }>('/images/generations', { method: 'POST', body: payload });

    const first = Array.isArray(raw.data) ? raw.data[0] : undefined;
    if (!first) {
      throw new Error('recraft: empty data array in /images/generations response');
    }

    if (first.b64_json) {
      return { image: Buffer.from(first.b64_json, 'base64'), format: 'png', raw };
    }
    if (first.url) {
      // ImageGenResponse.image is strictly Buffer — we fetch the CDN URL so
      // callers get the binary regardless of which response_format they asked
      // for. Recraft's URLs are signed but require no auth re-attachment.
      const binRes = await fetch(first.url, {
        method: 'GET',
        signal: AbortSignal.timeout(60_000),
      });
      if (!binRes.ok) {
        throw new Error(`recraft: download HTTP ${binRes.status} for ${first.url}`);
      }
      const buf = Buffer.from(await binRes.arrayBuffer());
      return { image: buf, format: inferRecraftFormat(first.url), raw };
    }
    throw new Error('recraft: response data entry has neither url nor b64_json');
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    if (!this.apiKey) {
      return {
        healthy: false,
        checkedAt: new Date(),
        error: 'RECRAFT_API_KEY is not configured',
        latency: Date.now() - start,
      };
    }
    // Recraft has no GET health endpoint — the cheapest probe is the root
    // path, which returns 404 with a well-formed body when the key is live.
    // We treat any response (not a network error) as "we can reach Recraft"
    // and specifically 401 as "key bad".
    try {
      const res = await fetch(`${this.baseUrl}/`, {
        method: 'GET',
        headers: this.buildHeaders(false),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) {
        return {
          healthy: false,
          checkedAt: new Date(),
          latency: Date.now() - start,
          error: 'Recraft HTTP 401 — RECRAFT_API_KEY rejected',
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
    return modelName?.trim() || 'recraftv3';
  }

  // ─── Unsupported surfaces ────────────────────────────────────────────────
  async imageEdit(_m: Model, _r: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('recraft: imageEdit not yet implemented');
  }

  async imageVariation(_m: Model, _r: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('recraft: imageVariation not supported');
  }

  async moderate(_m: Model, _r: ModerationRequest): Promise<ModerationResponse> {
    throw new Error('recraft: moderation not supported');
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

  private async fetchJson<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
    const timeoutMs = Math.max(1000, this.config.timeout ?? 60000);
    // Single choke-point for all Recraft API calls — route through the
    // resilience stack (bulkhead → breaker → timeout) so an outage fast-fails
    // and is isolated per-provider.
    return this.executeThroughBulkhead(async () => {
      const res = await fetch(url, {
        method: init.method,
        headers: this.buildHeaders(true),
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>');
        throw new Error(`Recraft HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      return (await res.json()) as T;
    }, `${init.method} ${path}`);
  }
}

function inferRecraftFormat(url: string): 'png' | 'jpg' | 'webp' | 'svg' | string {
  const lower = url.toLowerCase();
  if (lower.includes('.svg')) return 'svg';
  if (lower.includes('.png')) return 'png';
  if (lower.includes('.jpg') || lower.includes('.jpeg')) return 'jpg';
  if (lower.includes('.webp')) return 'webp';
  return 'png';
}
