// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Black Forest Labs (FLUX) Adapter — async image-generation jobs.
 *
 * BFL publishes an **async-job** image API for the FLUX family. The standard
 * flow is:
 *
 *   1. POST /v1/<model>       (JSON body: prompt + optional knobs)
 *        → { id, polling_url }
 *   2. Poll polling_url       (or fall back to /v1/get_result?id=<id>)
 *        → { status, result?: { sample?: string }, ... }
 *      until `status === 'Ready'` (or a terminal failure status).
 *   3. GET result.sample      (signed CDN URL — no auth re-attachment)
 *        → image bytes.
 *
 * Source: https://docs.bfl.ai/ (FLUX models and async-job protocol).
 *
 * ### Auth
 *
 *   x-key: <BFL_API_KEY>
 *
 * Lower-case header (per BFL spec) and NOT `Authorization: Bearer`. The
 * catalog row carries `authScheme: 'api-key-header'` + `authHeaderName: 'x-key'`
 * to reflect this — see providers.catalog.ts.
 *
 * ### Why dedicated
 *
 *   - **Async job protocol**: same reason as RunwayML / Topaz — the
 *     OAI-compatible hub assumes a synchronous /images/generations response
 *     and can't represent the submit→poll→download dance.
 *   - **Per-model URL**: BFL routes by model on the URL path itself (e.g.
 *     `POST /v1/flux-pro-1.1`), not via a `model` field in the body. The hub
 *     would call `/images/generations` and 404.
 *   - **Static catalog**: BFL has no /models route. We return the catalog's
 *     `pinnedFallback.models` list, same pattern as Recraft.
 *
 * ### Supported parameters
 *
 *   width, height            — pixels, must be multiples of 32 (BFL constraint)
 *   prompt_upsampling        — boolean
 *   seed                     — integer
 *   safety_tolerance         — 0..6 (default 2; higher = more permissive)
 *   output_format            — 'jpeg' | 'png'
 *   guidance / steps         — model-specific knobs (forwarded if present)
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
  ImageEditRequest,
  ImageEditResponse,
  ImageGenRequest,
  ImageGenResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  ModerationRequest,
  ModerationResponse,
} from '@/types/model-client';
import { narrowAs } from '@/utils/type-guards';
import { logger } from '@/utils/logger';

export interface BflAdapterConfig extends BaseProviderConfig {
  baseUrl?: string;
  /** Poll budget overrides (default: 120 polls × 1.5s = ~3 min). */
  pollMaxAttempts?: number;
  pollIntervalMs?: number;
}

/** Documented FLUX models — matches `pinnedFallback.models` in the catalog. */
const FLUX_MODELS: readonly string[] = [
  'flux-pro-1.1',
  'flux-pro',
  'flux-dev',
  'flux-schnell',
  'flux-pro-1.1-ultra',
] as const;

/** Models that accept an `image_prompt` parameter (image-editing surface). */
const EDIT_CAPABLE = new Set<string>(['flux-pro-1.1', 'flux-pro', 'flux-pro-1.1-ultra']);

/** Status values BFL returns. We treat anything not in `IN_FLIGHT` as terminal. */
const IN_FLIGHT = new Set(['pending', 'queued', 'processing']);
const READY = 'ready';

interface BflSubmitResponse {
  id?: string;
  polling_url?: string;
}

interface BflPollResponse {
  id?: string;
  status?: string;
  result?: {
    sample?: string;
    [k: string]: unknown;
  };
  // BFL returns an `error` envelope on terminal failures.
  error?: string;
  [k: string]: unknown;
}

export class BflAdapter extends ProviderAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pollMaxAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly blog = logger.child({ provider: 'bfl' });

  constructor(config: BflAdapterConfig) {
    super('bfl', 'Black Forest Labs', config);
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || 'https://api.bfl.ai/v1').replace(/\/$/, '');
    this.pollMaxAttempts = config.pollMaxAttempts ?? 120;
    this.pollIntervalMs = config.pollIntervalMs ?? 1500;
  }

  /** Public: is this a documented FLUX model id? */
  static isFluxModel(id: string): boolean {
    return FLUX_MODELS.includes(id);
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();
    return {
      id: 'bfl',
      name: 'bfl',
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
   * BFL has no /models route — return the static catalog. The fetch sentinel
   * test guards against accidental network leakage in this method.
   */
  async getModels(): Promise<Model[]> {
    return FLUX_MODELS.map(
      (id) =>
        narrowAs<Model>(({
          id,
          name: id,
          displayName: id,
          provider: 'bfl',
          contextWindow: 0,
          maxOutputTokens: 0,
          capabilities: EDIT_CAPABLE.has(id)
            ? ['image_generation', 'image_editing']
            : ['image_generation'],
        })),
    );
  }

  // ─── Unsupported surfaces (image-only) ──────────────────────────────────
  async chatCompletion(_r: ChatRequest): Promise<ChatResponse> {
    throw new Error('bfl: chatCompletion not supported — BFL is image-only');
  }

  async *chatCompletionStream(_r: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    throw new Error('bfl: chatCompletionStream not supported — BFL is image-only');
    yield undefined as never;
  }

  async generateEmbeddings(_r: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error('bfl: generateEmbeddings not supported — BFL is image-only');
  }

  async imageVariation(_m: Model, _r: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('bfl: imageVariation not supported');
  }

  async moderate(_m: Model, _r: ModerationRequest): Promise<ModerationResponse> {
    throw new Error('bfl: moderation not supported');
  }

  /**
   * POST /v1/<model> → poll polling_url → download result.sample.
   *
   * The model id is part of the URL path (NOT the body), per BFL convention.
   */
  async imageGenerate(model: Model, request: ImageGenRequest): Promise<ImageGenResponse> {
    const modelId = (model.name || model.id || 'flux-pro-1.1').trim();
    if (!BflAdapter.isFluxModel(modelId)) {
      throw new Error(
        `bfl: unknown model ${modelId} — expected one of ${FLUX_MODELS.join(', ')}`,
      );
    }
    return this.runJob(modelId, this.buildBody(request));
  }

  /**
   * Image edit on FLUX-pro variants that accept `image_prompt`. The base
   * image is forwarded as a data URL (BFL accepts public URLs or base64
   * data URLs); we materialize Buffers as data URLs to keep the call simple.
   */
  async imageEdit(model: Model, request: ImageEditRequest): Promise<ImageEditResponse> {
    const modelId = (model.name || model.id || 'flux-pro-1.1').trim();
    if (!BflAdapter.isFluxModel(modelId)) {
      throw new Error(
        `bfl: unknown model ${modelId} — expected one of ${FLUX_MODELS.join(', ')}`,
      );
    }
    if (!EDIT_CAPABLE.has(modelId)) {
      throw new Error(`bfl: imageEdit not supported on ${modelId} — use one of ${[...EDIT_CAPABLE].join(', ')}`);
    }
    if (!request.image) {
      throw new Error('bfl.imageEdit: image is required');
    }
    const body = this.buildBody({
      prompt: request.prompt,
      size: request.size,
      options: request.options,
    } as ImageGenRequest);
    body.image_prompt = encodeImageForBfl(request.image);
    const result = await this.runJob(modelId, body);
    return narrowAs<ImageEditResponse>(result);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    if (!this.apiKey) {
      return {
        healthy: false,
        checkedAt: new Date(),
        error: 'BFL_API_KEY is not configured',
        latency: Date.now() - start,
      };
    }
    // BFL has no GET /health route. Probing /get_result with an obviously-bad
    // id returns 200 + `{status: "Task not found"}` on a valid key, 401 on a
    // bad one. 401 = unhealthy; everything else = reachable.
    try {
      const res = await fetch(`${this.baseUrl}/get_result?id=health-probe`, {
        method: 'GET',
        headers: this.buildHeaders(false),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401 || res.status === 403) {
        return {
          healthy: false,
          checkedAt: new Date(),
          latency: Date.now() - start,
          error: `BFL HTTP ${res.status} — BFL_API_KEY rejected`,
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

  calculateCost(_m: Model, _i: number, _o: number): number {
    return 0;
  }

  normalizeModelName(modelName: string): string {
    return modelName?.trim() || 'flux-pro-1.1';
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private buildHeaders(includeJsonContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'x-key': this.apiKey,
      Accept: 'application/json',
    };
    if (includeJsonContentType) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private buildBody(request: ImageGenRequest): Record<string, unknown> {
    const options = (request.options || {}) as Record<string, unknown>;
    const body: Record<string, unknown> = { prompt: request.prompt };

    // Size: prefer explicit width/height options, fall back to parsing `size`.
    if (typeof options.width === 'number' && typeof options.height === 'number') {
      body.width = options.width;
      body.height = options.height;
    } else if (typeof request.size === 'string') {
      const parsed = /^(\d+)x(\d+)$/.exec(request.size);
      if (parsed) {
        body.width = Number(parsed[1]);
        body.height = Number(parsed[2]);
      }
    }

    // Forward documented BFL knobs verbatim if present.
    for (const key of [
      'seed',
      'prompt_upsampling',
      'safety_tolerance',
      'output_format',
      'guidance',
      'steps',
      'raw',
    ] as const) {
      if (options[key] !== undefined) {
        body[key] = options[key];
      }
    }

    return body;
  }

  private async runJob(modelId: string, body: Record<string, unknown>): Promise<ImageGenResponse> {
    // Route job submission through the resilience stack (bulkhead → breaker →
    // timeout) so a BFL outage fast-fails and is isolated per-provider. Polling
    // and CDN download below stay outside the bulkhead slot (not held for the
    // job's lifetime).
    const submitted = await this.executeThroughBulkhead(async () => {
      const submit = await fetch(`${this.baseUrl}/${encodeURIComponent(modelId)}`, {
        method: 'POST',
        headers: this.buildHeaders(true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(10_000, this.config.timeout ?? 60_000)),
      });
      if (!submit.ok) {
        const text = await submit.text().catch(() => '<unreadable>');
        throw new Error(`BFL HTTP ${submit.status} on submit: ${text.slice(0, 500)}`);
      }
      return (await submit.json()) as BflSubmitResponse;
    }, 'image generation');
    const id = submitted.id;
    const pollUrl = submitted.polling_url || (id ? `${this.baseUrl}/get_result?id=${encodeURIComponent(id)}` : null);
    if (!id || !pollUrl) {
      throw new Error('bfl: submit response missing id or polling_url');
    }

    const terminal = await this.pollResult(pollUrl, id);
    const status = (terminal.status || '').toLowerCase();
    if (status !== READY) {
      throw new Error(
        `bfl: job ${id} ended in status "${terminal.status}": ${terminal.error ?? '(no error detail)'}`,
      );
    }

    const sample = terminal.result?.sample;
    if (typeof sample !== 'string' || sample.length === 0) {
      throw new Error(`bfl: job ${id} ready but result.sample missing`);
    }

    const binRes = await fetch(sample, {
      method: 'GET',
      signal: AbortSignal.timeout(120_000),
    });
    if (!binRes.ok) {
      throw new Error(`bfl: download HTTP ${binRes.status} for ${id}`);
    }
    const arrayBuf = await binRes.arrayBuffer();
    return narrowAs<ImageGenResponse>({
      image: Buffer.from(arrayBuf),
      format: inferFormatFromUrl(sample),
      raw: { id, status: terminal.status, sample },
    });
  }

  protected async pollResult(pollUrl: string, jobId: string): Promise<BflPollResponse> {
    for (let attempt = 0; attempt < this.pollMaxAttempts; attempt++) {
      const res = await fetch(pollUrl, {
        method: 'GET',
        headers: this.buildHeaders(false),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>');
        throw new Error(`BFL HTTP ${res.status} on poll: ${text.slice(0, 500)}`);
      }
      const body = (await res.json()) as BflPollResponse;
      const status = (body.status || '').toLowerCase();
      if (!IN_FLIGHT.has(status)) {
        return body;
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error(
      `bfl: job ${jobId} did not reach terminal status after ${this.pollMaxAttempts} polls (${this.pollIntervalMs}ms each)`,
    );
  }
}

function inferFormatFromUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('.png')) return 'png';
  if (lower.includes('.jpg') || lower.includes('.jpeg')) return 'jpeg';
  if (lower.includes('.webp')) return 'webp';
  return 'png';
}

/**
 * BFL accepts either a public URL or a base64 data URL for `image_prompt`.
 * If the caller supplies a Buffer we wrap it as a data URL; strings are
 * forwarded verbatim (URL or already-data-URL).
 */
function encodeImageForBfl(image: Buffer | string): string {
  if (typeof image === 'string') return image;
  const b64 = image.toString('base64');
  return `data:image/png;base64,${b64}`;
}
