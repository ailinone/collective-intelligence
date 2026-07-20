// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RunwayML Adapter — image-to-video + act-one motion transfer with async polling.
 *
 * Runway's public API is an **async-job** protocol, not a sync-completion one:
 *
 *   1. POST /v1/image_to_video  →  { id: <task-uuid>, status: 'PENDING' | 'RUNNING' }
 *   2. Poll GET /v1/tasks/{id}  →  { status, output: string[], failure: string? }
 *
 * The `/v1/tasks` route accepts GET for status and DELETE for cancel. Status
 * transitions: `PENDING` → `RUNNING` → (`SUCCEEDED` | `FAILED` | `CANCELLED`).
 *
 * Source: https://docs.dev.runwayml.com/
 *
 * ### Required header
 *
 * **Every** request must carry `X-Runway-Version: 2024-11-06` (or later). Runway
 * versions its API through this header — omitting it returns 400. The catalog
 * declares it in `extraHeaders` and we stamp it here explicitly too, so an
 * operator can override the version without touching the catalog.
 *
 * ### Auth
 *
 * `Authorization: Bearer <RUNWAYML_API_KEY>`.
 *
 * ### Supported model ids
 *
 *   - `gen3a_turbo`   — fastest image-to-video
 *   - `gen3_alpha`    — higher quality image-to-video
 *   - `act-one`       — motion transfer (different route, not covered by this
 *                       adapter in Batch 2; we reserve the namespace)
 *
 * ### Why dedicated
 *
 * 1. Async-job polling has no OAI-compat analogue. The hub adapter's
 *    `videoGenerate` is a single sync POST.
 * 2. The output is a **URL array**, not binary or a JSON blob. Callers must
 *    download from that URL; we don't pre-fetch.
 * 3. Polling budget is a per-request operational concern — max attempts,
 *    interval — that the hub has no hook for.
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
  ImageVariationRequest,
  ImageVariationResponse,
  ModerationRequest,
  ModerationResponse,
  VideoGenRequest,
  VideoGenResponse,
} from '@/types/model-client';
import { narrowAs } from '@/utils/type-guards';
import { logger } from '@/utils/logger';

export interface RunwayMLAdapterConfig extends BaseProviderConfig {
  baseUrl?: string;
  /** Override the X-Runway-Version header. Defaults to the docs-latest value. */
  apiVersion?: string;
  /** Override the polling budget. Defaults to 120 attempts × 2s = 4min. */
  pollMaxAttempts?: number;
  pollIntervalMs?: number;
}

/** Documented task statuses. */
type RunwayTaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'THROTTLED';

interface RunwayTask {
  id: string;
  status: RunwayTaskStatus;
  createdAt: string;
  output?: readonly string[];
  failure?: string;
  failureCode?: string;
  progress?: number;
}

/** Documented model ids. Listed here to back `getModels()` without a /models probe. */
const STATIC_MODELS: readonly string[] = ['gen3a_turbo', 'gen3_alpha', 'act-one'] as const;

/** Documented API version header value. */
const DEFAULT_API_VERSION = '2024-11-06';

export class RunwayMLAdapter extends ProviderAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly pollMaxAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly rlog = logger.child({ provider: 'runwayml' });

  constructor(config: RunwayMLAdapterConfig) {
    super('runwayml', 'RunwayML', config);
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || 'https://api.dev.runwayml.com').replace(/\/$/, '');
    this.apiVersion = config.apiVersion || DEFAULT_API_VERSION;
    this.pollMaxAttempts = config.pollMaxAttempts ?? 120;
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
  }

  /** Public: are we looking at a documented Runway model id? */
  static isRunwayModel(id: string): boolean {
    return STATIC_MODELS.includes(id);
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();
    return {
      id: 'runwayml',
      name: 'runwayml',
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
    return STATIC_MODELS.map(
      (id) =>
        narrowAs<Model>(({
          id,
          name: id,
          displayName: id,
          provider: 'runwayml',
          contextWindow: 0,
          maxOutputTokens: 0,
          capabilities: id === 'act-one' ? ['motion_transfer'] : ['image_to_video'],
        })),
    );
  }

  async chatCompletion(_request: ChatRequest): Promise<ChatResponse> {
    throw new Error('runwayml: chatCompletion not supported — Runway is video-only');
  }

  async *chatCompletionStream(_request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    throw new Error('runwayml: chatCompletionStream not supported — Runway is video-only');
    yield undefined as never;
  }

  async generateEmbeddings(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error('runwayml: generateEmbeddings not supported — Runway is video-only');
  }

  /**
   * POST /v1/image_to_video, then poll /v1/tasks/{id} until terminal status.
   * Returns the first output URL in `VideoGenResponse.video` (callers download).
   */
  async videoGenerate(model: Model, request: VideoGenRequest): Promise<VideoGenResponse> {
    const modelId = (model.name || model.id || 'gen3a_turbo').trim();
    if (!RunwayMLAdapter.isRunwayModel(modelId)) {
      throw new Error(
        `runwayml: unknown model ${modelId} — expected one of ${STATIC_MODELS.join(', ')}`,
      );
    }

    const options = (request.options || {}) as Record<string, unknown>;
    const promptImage =
      typeof options.promptImage === 'string'
        ? options.promptImage
        : typeof options.image === 'string'
          ? options.image
          : typeof request.image === 'string'
            ? request.image
            : undefined;

    if (!promptImage) {
      throw new Error(
        'runwayml.videoGenerate: promptImage (URL or data URI) is required for image-to-video',
      );
    }

    const payload: Record<string, unknown> = {
      model: modelId,
      promptImage,
    };
    if (request.prompt) payload.promptText = request.prompt;
    if (typeof options.duration === 'number') payload.duration = options.duration;
    if (typeof options.ratio === 'string') payload.ratio = options.ratio;
    if (typeof options.seed === 'number') payload.seed = options.seed;
    if (typeof options.watermark === 'boolean') payload.watermark = options.watermark;

    const created = await this.fetchJson<{ id: string; status?: RunwayTaskStatus }>(
      '/v1/image_to_video',
      { method: 'POST', body: payload },
    );
    if (!created?.id) {
      throw new Error('runwayml: /v1/image_to_video returned no task id');
    }

    const terminal = await this.pollTask(created.id);
    if (terminal.status !== 'SUCCEEDED') {
      const err = terminal.failure || terminal.failureCode || terminal.status;
      throw new Error(`runwayml: task ${terminal.id} ended in ${terminal.status}: ${err}`);
    }
    const outputs: unknown[] = Array.isArray(terminal.output) ? terminal.output : [];
    if (outputs.length === 0) {
      throw new Error(`runwayml: task ${terminal.id} succeeded but returned no output URLs`);
    }
    const firstOutput = outputs[0];

    return narrowAs<VideoGenResponse>({
      video: firstOutput,
      format: 'url',
      raw: terminal,
    });
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    if (!this.apiKey) {
      return {
        healthy: false,
        checkedAt: new Date(),
        error: 'RUNWAYML_API_KEY is not configured',
        latency: Date.now() - start,
      };
    }
    // Runway exposes no "/ping" — the cheapest probe is listing tasks (which
    // 401s with a bad key, 200s with an empty list on a fresh project).
    try {
      const res = await fetch(`${this.baseUrl}/v1/tasks`, {
        method: 'GET',
        headers: this.buildHeaders(false),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) {
        return {
          healthy: false,
          checkedAt: new Date(),
          latency: Date.now() - start,
          error: 'Runway HTTP 401 — RUNWAYML_API_KEY rejected',
        };
      }
      return { healthy: res.ok, checkedAt: new Date(), latency: Date.now() - start };
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
    return modelName?.trim() || 'gen3a_turbo';
  }

  // ─── Unsupported surfaces ────────────────────────────────────────────────
  async imageEdit(_m: Model, _r: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('runwayml: imageEdit not supported');
  }

  async imageVariation(_m: Model, _r: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('runwayml: imageVariation not supported');
  }

  async moderate(_m: Model, _r: ModerationRequest): Promise<ModerationResponse> {
    throw new Error('runwayml: moderation not supported');
  }

  // ─── Polling internals ───────────────────────────────────────────────────

  /**
   * Poll `/v1/tasks/{id}` until terminal status. Exposed to tests via a
   * protected visibility so fake clocks / smaller budgets can assert on the
   * status-machine without waiting minutes.
   */
  protected async pollTask(taskId: string): Promise<RunwayTask> {
    for (let attempt = 0; attempt < this.pollMaxAttempts; attempt++) {
      const task = await this.fetchJson<RunwayTask>(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: 'GET',
      });
      if (
        task.status === 'SUCCEEDED' ||
        task.status === 'FAILED' ||
        task.status === 'CANCELLED'
      ) {
        return task;
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error(
      `runwayml: task ${taskId} did not reach terminal status after ${this.pollMaxAttempts} polls (${this.pollIntervalMs}ms each)`,
    );
  }

  private buildHeaders(includeJsonContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'X-Runway-Version': this.apiVersion,
    };
    if (includeJsonContentType) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private async fetchJson<T>(
    path: string,
    init: { method: 'GET' | 'POST' | 'DELETE'; body?: Record<string, unknown> },
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
    const timeoutMs = Math.max(1000, this.config.timeout ?? 60000);
    // Single choke-point for Runway task submission and polling — route through
    // the resilience stack (bulkhead → breaker → timeout) so an outage
    // fast-fails and is isolated per-provider. (The healthCheck probe uses a
    // separate direct fetch and stays independent of the breaker.)
    return this.executeThroughBulkhead(async () => {
      const res = await fetch(url, {
        method: init.method,
        headers: this.buildHeaders(init.method === 'POST'),
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>');
        throw new Error(`Runway HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      return (await res.json()) as T;
    }, `${init.method} ${path}`);
  }
}
