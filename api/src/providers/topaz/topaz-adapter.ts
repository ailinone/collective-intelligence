// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Topaz Image API Adapter — async upscale / enhance jobs.
 *
 * Topaz Labs publishes an **async-job** image API for their Photo/Gigapixel
 * pipelines. The standard flow is:
 *
 *   1. POST /image/v1/enhance  (multipart/form-data: image + params)
 *        → { process_id, status: 'queued' | 'processing' }
 *   2. Poll GET /image/v1/status/{process_id}
 *        → { status, download_url?, error? }
 *   3. GET /image/v1/download/{process_id}  (binary image response)
 *
 * Source: https://www.topazlabs.com/api (reference docs gated; API surface
 * validated from SDK sample code published by Topaz)
 *
 * ### Auth
 *
 *   X-API-Key: <TOPAZ_API_KEY>
 *
 * Not `Authorization: Bearer`. Topaz uses a custom header, matching the
 * catalog's `authScheme: 'api-key-header'` + `authHeaderName: 'X-API-Key'`.
 *
 * ### Why dedicated
 *
 *  - **Async job protocol**: same reason as RunwayML — hub's sync POST can't
 *    represent it.
 *  - **Binary download step**: the third call returns image bytes, not JSON.
 *    We materialize a Buffer in `imageEdit.image` to match the shared
 *    `ImageEditResponse` contract.
 *  - **Multipart upload**: input image travels as multipart, not base64
 *    JSON. This adapter handles the form construction so callers pass a
 *    Buffer + params and get back a Buffer.
 *
 * ### Params (all optional)
 *
 *   upscale_factor: 1|2|4|6        (default: model's native max)
 *   noise_reduction: 0..100
 *   sharpen: 0..100
 *   model: 'standard_v2' | 'high_fidelity_v2' | 'art_and_cg' | 'low_resolution'
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

export interface TopazAdapterConfig extends BaseProviderConfig {
  baseUrl?: string;
  /** Poll budget overrides (defaults: 180 × 2s = 6min). */
  pollMaxAttempts?: number;
  pollIntervalMs?: number;
  /** Override the enhance path for private preview models. */
  enhancePath?: string;
}

/** Documented Topaz enhance pipelines — keeps capability merger honest. */
const ENHANCE_MODELS: readonly string[] = [
  'standard_v2',
  'high_fidelity_v2',
  'art_and_cg',
  'low_resolution',
] as const;

/** Terminal-status set. */
const TERMINAL = new Set(['completed', 'succeeded', 'failed', 'cancelled', 'error']);

interface TopazStatus {
  process_id?: string;
  status: string;
  progress?: number;
  download_url?: string;
  error?: string;
  output_url?: string;
}

export class TopazAdapter extends ProviderAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pollMaxAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly enhancePath: string;
  private readonly tlog = logger.child({ provider: 'topaz' });

  constructor(config: TopazAdapterConfig) {
    super('topaz', 'Topaz Labs', config);
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || 'https://api.topazlabs.com/image/v1').replace(/\/$/, '');
    this.pollMaxAttempts = config.pollMaxAttempts ?? 180;
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
    this.enhancePath = config.enhancePath || '/enhance';
  }

  /** Public: is this a documented Topaz enhance model id? */
  static isTopazModel(id: string): boolean {
    return ENHANCE_MODELS.includes(id);
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();
    return {
      id: 'topaz',
      name: 'topaz',
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

  async getModels(): Promise<Model[]> {
    return ENHANCE_MODELS.map(
      (id) =>
        narrowAs<Model>(({
          id,
          name: id,
          displayName: id,
          provider: 'topaz',
          contextWindow: 0,
          maxOutputTokens: 0,
          capabilities: ['image_upscale', 'image_enhance'],
        })),
    );
  }

  async chatCompletion(_r: ChatRequest): Promise<ChatResponse> {
    throw new Error('topaz: chatCompletion not supported — Topaz is image-only');
  }

  async *chatCompletionStream(_r: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    throw new Error('topaz: chatCompletionStream not supported — Topaz is image-only');
    yield undefined as never;
  }

  async generateEmbeddings(_r: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error('topaz: generateEmbeddings not supported — Topaz is image-only');
  }

  async imageGenerate(_m: Model, _r: ImageGenRequest): Promise<ImageGenResponse> {
    throw new Error(
      'topaz: imageGenerate not supported — Topaz enhances existing images; use imageEdit',
    );
  }

  /**
   * Upload → poll → download. The `ImageEditRequest.image` is the Buffer or
   * URL to enhance; `request.prompt` carries Topaz-specific params via JSON.
   */
  async imageEdit(model: Model, request: ImageEditRequest): Promise<ImageEditResponse> {
    const modelId = (model.name || model.id || 'standard_v2').trim();
    if (!TopazAdapter.isTopazModel(modelId)) {
      throw new Error(`topaz: unknown model ${modelId} — expected one of ${ENHANCE_MODELS.join(', ')}`);
    }

    const options = (request.options || {}) as Record<string, unknown>;
    const imageInput = request.image;
    if (!imageInput) {
      throw new Error('topaz.imageEdit: image is required');
    }

    const form = await this.buildForm(modelId, imageInput, options);

    // Route the enhance submission through the resilience stack (bulkhead →
    // breaker → timeout) so a Topaz outage fast-fails and is isolated
    // per-provider. Status polling and CDN download below stay outside the
    // bulkhead slot (not held for the job's lifetime).
    const created = await this.executeThroughBulkhead(async () => {
      const createdRes = await fetch(`${this.baseUrl}${this.enhancePath}`, {
        method: 'POST',
        headers: { 'X-API-Key': this.apiKey },
        // FormData is a valid BodyInit at runtime (undici/node 20+ fetch); the
        // cast avoids importing lib-dom types for a node-native call.
        body: narrowAs<ReadableStream<Uint8Array>>(form),
        signal: AbortSignal.timeout(Math.max(10_000, this.config.timeout ?? 60_000)),
      });
      if (!createdRes.ok) {
        const text = await createdRes.text().catch(() => '<unreadable>');
        throw new Error(`Topaz HTTP ${createdRes.status} on enhance: ${text.slice(0, 500)}`);
      }
      return (await createdRes.json()) as { process_id?: string; id?: string };
    }, 'image edit');
    const processId = created.process_id || created.id;
    if (!processId) {
      throw new Error('topaz: enhance response has no process_id');
    }

    const terminal = await this.pollStatus(processId);
    const norm = terminal.status.toLowerCase();
    if (norm === 'failed' || norm === 'cancelled' || norm === 'error') {
      throw new Error(
        `topaz: process ${processId} ended in ${terminal.status}: ${terminal.error ?? '(no error detail)'}`,
      );
    }

    const downloadUrl = terminal.download_url || terminal.output_url;
    if (!downloadUrl) {
      throw new Error(`topaz: process ${processId} succeeded but no download_url returned`);
    }

    // Fetch the binary result. Topaz signs the URL, so we don't re-attach auth.
    const binRes = await fetch(downloadUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(120_000),
    });
    if (!binRes.ok) {
      throw new Error(`topaz: download HTTP ${binRes.status} for ${processId}`);
    }
    const arrayBuf = await binRes.arrayBuffer();
    return narrowAs<ImageEditResponse>({
      image: Buffer.from(arrayBuf),
      format: inferFormatFromUrl(downloadUrl),
      raw: { processId, status: terminal.status, downloadUrl },
    });
  }

  async imageVariation(_m: Model, _r: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('topaz: imageVariation not supported');
  }

  async moderate(_m: Model, _r: ModerationRequest): Promise<ModerationResponse> {
    throw new Error('topaz: moderation not supported');
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    if (!this.apiKey) {
      return {
        healthy: false,
        checkedAt: new Date(),
        error: 'TOPAZ_API_KEY is not configured',
        latency: Date.now() - start,
      };
    }
    // Topaz publishes no dedicated health route. Probing the enhance path with
    // HEAD returns 405 on a valid key, 401 on a bad one. 401 = unhealthy.
    try {
      const res = await fetch(`${this.baseUrl}${this.enhancePath}`, {
        method: 'HEAD',
        headers: { 'X-API-Key': this.apiKey },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401 || res.status === 403) {
        return {
          healthy: false,
          checkedAt: new Date(),
          latency: Date.now() - start,
          error: `Topaz HTTP ${res.status} — TOPAZ_API_KEY rejected`,
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
    return modelName?.trim() || 'standard_v2';
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  protected async pollStatus(processId: string): Promise<TopazStatus> {
    for (let attempt = 0; attempt < this.pollMaxAttempts; attempt++) {
      const res = await fetch(
        `${this.baseUrl}/status/${encodeURIComponent(processId)}`,
        {
          method: 'GET',
          headers: { 'X-API-Key': this.apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>');
        throw new Error(`Topaz HTTP ${res.status} on status: ${text.slice(0, 500)}`);
      }
      const body = (await res.json()) as TopazStatus;
      if (TERMINAL.has(body.status.toLowerCase())) {
        return body;
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error(
      `topaz: process ${processId} did not reach terminal status after ${this.pollMaxAttempts} polls (${this.pollIntervalMs}ms each)`,
    );
  }

  /**
   * Construct multipart/form-data with the image payload + Topaz params.
   * Works with a Buffer (binary input) or a string URL (Topaz will fetch).
   */
  private async buildForm(
    modelId: string,
    image: Buffer | string,
    options: Record<string, unknown>,
  ): Promise<FormData> {
    const form = new FormData();
    form.append('model', modelId);

    if (Buffer.isBuffer(image)) {
      const blob = new Blob([new Uint8Array(image)], { type: 'application/octet-stream' });
      form.append('image', blob, 'input.bin');
    } else if (typeof image === 'string') {
      form.append('image_url', image);
    } else {
      throw new Error('topaz: unsupported image input type');
    }

    if (typeof options.upscale_factor === 'number') {
      form.append('upscale_factor', String(options.upscale_factor));
    }
    if (typeof options.noise_reduction === 'number') {
      form.append('noise_reduction', String(options.noise_reduction));
    }
    if (typeof options.sharpen === 'number') {
      form.append('sharpen', String(options.sharpen));
    }

    return form;
  }
}

function inferFormatFromUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('.jpg') || lower.includes('.jpeg')) return 'jpeg';
  if (lower.includes('.png')) return 'png';
  if (lower.includes('.webp')) return 'webp';
  if (lower.includes('.tiff') || lower.includes('.tif')) return 'tiff';
  return 'binary';
}
