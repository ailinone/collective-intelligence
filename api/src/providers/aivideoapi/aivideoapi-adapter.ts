// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * AI Video API (aivideoapi.com) Adapter — Runway video generation via a
 * third-party aggregator, async submit + poll.
 *
 * aivideoapi.com is a thin REST wrapper AROUND RunwayML's models — it is a
 * completely different vendor/host/credential from `runwayml-adapter.ts`
 * (which calls Runway's own `api.dev.runwayml.com` API directly). Do not
 * confuse the two: this adapter's `AIVIDEOAPI_API_KEY` will never work
 * against Runway's own API, and vice versa.
 *
 * Source (all 11 reference pages fetched and cross-checked live, 2026-09-08):
 *   https://aivideoapi.readme.io/reference/runwaygeneratetext
 *   https://aivideoapi.readme.io/reference/runwaygenerateimage
 *   https://aivideoapi.readme.io/reference/runwaygenerateimagedescription
 *   https://aivideoapi.readme.io/reference/runwaygeneratevideo
 *   https://aivideoapi.readme.io/reference/runwayextend
 *   https://aivideoapi.readme.io/reference/get_task_status_runway_status_get
 * (each has a matching `generate_by_*_post` / `..._get` operationId page with
 * the same content — readme.io publishes both a human page and an
 * operationId-keyed page per endpoint).
 *
 * ### Protocol — 5 submit endpoints, 1 shared poll endpoint
 *
 *   1. POST /runway/generate/text              — text-to-video
 *   2. POST /runway/generate/image              — image-to-video
 *   3. POST /runway/generate/imageDescription   — image + text description-to-video
 *   4. POST /runway/generate/video              — video-to-video (restyle an
 *                                                  input video by text prompt;
 *                                                  no `model` field — Gen3 only)
 *   5. POST /runway/extend                      — extend an ALREADY-generated
 *                                                  video (takes the `uuid` from
 *                                                  a prior generation, not a
 *                                                  fresh prompt)
 *   6. GET  /status?uuid={uuid}                 — poll every one of the above
 *
 * All 5 submit endpoints return 200 with a task handle; the docs' own prose
 * for every one of them says "use the returned uuid and endpoint /status to
 * check your task's progress" — so a `uuid` field is documented to exist.
 * `/runway/extend`'s OWN request body also takes a `uuid` field (of a PRIOR
 * completed task) to know which video to extend — do not confuse the two:
 * one is "the id I get back", the other is "the id I send in".
 *
 * ### The undocumented part — response body shapes
 *
 * As of 2026-09-08, aivideoapi.com's own published OpenAPI spec (surfaced
 * via readme.io) ships a genuinely EMPTY `{}` response schema on the 200 for
 * every single endpoint above, submit and poll alike — this was independently
 * confirmed by fetching the raw `.md` spec export for `runwaygeneratetext`
 * and `get_task_status_runway_status_get` directly, not just the rendered
 * doc page. This is exactly the class of gap that produced the empiriolabs
 * incident fixed in 100dcaeb (fix(video-orchestration): correct empiriolabs
 * poll path + bound fallback search to its own deadline) — guessing an
 * unverified field name instead of admitting the gap. Rather than guess a
 * single shape and silently break the moment the real field name differs,
 * `extractTaskId()` and `extractStatusPayload()` below try every
 * plausible candidate name (documented per-candidate) and the status/error
 * paths surface the RAW payload in the thrown error so a real failure is
 * diagnosable from logs, not a silent `undefined`. This should be tightened
 * to a single confirmed field name the first time a real submit is proven
 * live (see the PR description's "contract-only vs. live-tested" split).
 *
 * ### Auth
 *
 * `Authorization: <API_Key>` — the RAW key value, no `Bearer ` prefix. This
 * is confirmed by the OpenAPI security scheme itself: every operation above
 * declares `APIKeyAuth` (OpenAPI `type: apiKey`, `in: header`,
 * `name: Authorization`), which by definition carries the raw credential
 * value in the named header. That is a structurally different declaration
 * from `type: http, scheme: bearer` (which is what would produce
 * `Authorization: Bearer <key>`), and aivideoapi.com's spec uses the former
 * for every operation — never the latter.
 *
 * ### Why dedicated (not the OpenAI-compatible hub)
 *
 * Same reasoning as RunwayML / BFL / Topaz: this is a bespoke async-job REST
 * shape with 5 distinct submit routes selected by which combination of
 * text/image/video the caller supplies, not a single sync
 * `POST /images/generations`-shaped call the hub's bridge can represent.
 *
 * ### PR #497 lesson applied — orchestration-deadline-aware polling
 *
 * `execute-with-fallback.ts` (100dcaeb) gives every fallback candidate a
 * fair SHARE of the overall search deadline via `ctx.deadlineAt`, forwarded
 * by `video-orchestration-service.ts` into `VideoGenRequest.options.
 * orchestrationDeadlineAt`. Exactly like `byteplus-adapter.ts`'s
 * `submitAndPollGenerationTask`, this adapter's poll loop bounds its own
 * fixed poll budget by `min(ownDeadline, orchestrationDeadlineAt)` so a
 * single slow-failing task here cannot silently consume the ENTIRE
 * cross-provider fallback search budget and starve every other candidate —
 * the exact failure mode that PR #497 fixed for empiriolabs.
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

export interface AivideoapiAdapterConfig extends BaseProviderConfig {
  baseUrl?: string;
  /** Own poll budget, independent of any orchestration deadline (default 5min). */
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** Documented `model` values. Not every endpoint accepts every value — see
 *  per-method validation below (`generate/text` and `extend` reject gen4;
 *  `generate/video` takes no `model` field at all — Gen3 only). */
const AIVIDEOAPI_MODELS: readonly string[] = ['gen2', 'gen3', 'gen4'] as const;
const TEXT_AND_EXTEND_MODELS = new Set(['gen2', 'gen3']);

/** The only two terminal states the docs enumerate; 'in queue' and
 *  'submitted' (and anything undocumented) are treated as still in-flight —
 *  conservative by design so an unrecognized transitional value never gets
 *  misread as done. */
const TERMINAL_SUCCESS = 'success';
const TERMINAL_FAILURE = 'failed';

interface AivideoapiTaskPayload {
  uuid?: string;
  id?: string;
  task_id?: string;
  taskId?: string;
  status?: string;
  state?: string;
  error?: string;
  error_code?: string;
  errorCode?: string;
  video_url?: string;
  url?: string;
  video?: string;
  gif_url?: string;
  eta?: number;
  [k: string]: unknown;
}

/**
 * Every submit endpoint's own docs say "use the returned uuid" — `uuid` is
 * the primary candidate. `id`/`task_id`/`taskId` are defensive fallbacks for
 * the genuinely-undocumented response shape (see class doc).
 */
function extractTaskId(payload: AivideoapiTaskPayload): string | undefined {
  for (const key of ['uuid', 'id', 'task_id', 'taskId'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** `status` is the field name implied by the endpoint's own name ("Get Task
 *  Status"); `state` is a defensive fallback. */
function extractStatus(payload: AivideoapiTaskPayload): string {
  const raw =
    (typeof payload.status === 'string' && payload.status) ||
    (typeof payload.state === 'string' && payload.state) ||
    '';
  return raw.toLowerCase();
}

/** The docs say "video and GIF URLs retrievable" on success without naming
 *  the JSON keys — try every plausible candidate, preferring the most
 *  specific (`video_url`) first. */
function extractVideoUrl(payload: AivideoapiTaskPayload): string | undefined {
  for (const key of ['video_url', 'url', 'video'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  const data = payload.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    for (const key of ['video_url', 'url', 'video']) {
      const value = nested[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return undefined;
}

export class AivideoapiAdapter extends ProviderAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly alog = logger.child({ provider: 'aivideoapi' });

  constructor(config: AivideoapiAdapterConfig) {
    super('aivideoapi', 'AI Video API (Runway)', config);
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || 'https://api.aivideoapi.com').replace(/\/$/, '');
    this.pollTimeoutMs = config.pollTimeoutMs ?? 300_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 3_000;
  }

  static isKnownModel(id: string): boolean {
    return AIVIDEOAPI_MODELS.includes(id);
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();
    return {
      id: 'aivideoapi',
      name: 'aivideoapi',
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

  /** No `/models` route is documented — static list, same pattern as
   *  RunwayML/BFL/Topaz (`pinnedFallback.models` in the catalog row). */
  async getModels(): Promise<Model[]> {
    return AIVIDEOAPI_MODELS.map((id) =>
      narrowAs<Model>({
        id,
        name: id,
        displayName: `Runway ${id} (via aivideoapi)`,
        provider: 'aivideoapi',
        contextWindow: 0,
        maxOutputTokens: 0,
        capabilities:
          id === 'gen4'
            ? ['video_generation', 'image_to_video']
            : ['video_generation', 'text_to_video', 'image_to_video', 'video_to_video'],
      })
    );
  }

  async chatCompletion(_r: ChatRequest): Promise<ChatResponse> {
    throw new Error('aivideoapi: chatCompletion not supported — video-only');
  }

  async *chatCompletionStream(_r: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    throw new Error('aivideoapi: chatCompletionStream not supported — video-only');
    yield undefined as never;
  }

  async generateEmbeddings(_r: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error('aivideoapi: generateEmbeddings not supported — video-only');
  }

  async imageEdit(_m: Model, _r: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('aivideoapi: imageEdit not supported');
  }

  async imageVariation(_m: Model, _r: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('aivideoapi: imageVariation not supported');
  }

  async moderate(_m: Model, _r: ModerationRequest): Promise<ModerationResponse> {
    throw new Error('aivideoapi: moderation not supported');
  }

  /**
   * Routes to one of the 5 submit endpoints based on which fields the
   * caller supplied, then polls `/status` until terminal. Selection order
   * (checked in this precedence):
   *
   *   1. `options.extendUuid` set        → POST /runway/extend
   *   2. `request.video` set             → POST /runway/generate/video
   *   3. `request.image` AND `.prompt`   → POST /runway/generate/imageDescription
   *   4. `request.image` set (no prompt) → POST /runway/generate/image
   *   5. `request.prompt` set            → POST /runway/generate/text
   */
  async videoGenerate(model: Model, request: VideoGenRequest): Promise<VideoGenResponse> {
    const modelId = (model.name || model.id || 'gen3').trim();
    if (!AivideoapiAdapter.isKnownModel(modelId)) {
      throw new Error(
        `aivideoapi: unknown model ${modelId} — expected one of ${AIVIDEOAPI_MODELS.join(', ')}`
      );
    }

    const options = (request.options || {}) as Record<string, unknown>;
    const rawDeadline = options.orchestrationDeadlineAt;
    const orchestrationDeadlineAt =
      typeof rawDeadline === 'number' && Number.isFinite(rawDeadline) ? rawDeadline : undefined;

    const extendUuid = typeof options.extendUuid === 'string' ? options.extendUuid : undefined;
    const hasImage = typeof request.image === 'string' && request.image.length > 0;
    const hasVideo = typeof request.video === 'string' && request.video.length > 0;
    const hasPrompt = typeof request.prompt === 'string' && request.prompt.length > 0;

    let path: string;
    let body: Record<string, unknown>;

    if (extendUuid) {
      if (!TEXT_AND_EXTEND_MODELS.has(modelId)) {
        throw new Error(`aivideoapi: /runway/extend only accepts gen2 or gen3, got ${modelId}`);
      }
      path = '/runway/extend';
      body = { uuid: extendUuid, model: modelId };
      if (hasPrompt) body.text_prompt = request.prompt;
      if (typeof options.motion === 'number') body.motion = options.motion;
      if (typeof options.seed === 'number') body.seed = options.seed;
      if (typeof options.callbackUrl === 'string') body.callback_url = options.callbackUrl;
    } else if (hasVideo) {
      // /runway/generate/video takes no `model` field — Gen3-only under the hood.
      if (!hasPrompt) {
        throw new Error('aivideoapi.videoGenerate: prompt is required for video-to-video restyle');
      }
      path = '/runway/generate/video';
      body = { text_prompt: request.prompt, video_prompt: request.video };
      const structureTransformation = options.structureTransformation;
      if (typeof structureTransformation === 'number') {
        body.structure_transformation = structureTransformation;
      }
      if (typeof options.seed === 'number') body.seed = options.seed;
      if (typeof options.callbackUrl === 'string') body.callback_url = options.callbackUrl;
    } else if (hasImage && hasPrompt) {
      path = '/runway/generate/imageDescription';
      body = { text_prompt: request.prompt, img_prompt: request.image, model: modelId };
      this.applyCommonImageOptions(body, options);
    } else if (hasImage) {
      path = '/runway/generate/image';
      body = { img_prompt: request.image, model: modelId };
      this.applyCommonImageOptions(body, options);
    } else if (hasPrompt) {
      if (!TEXT_AND_EXTEND_MODELS.has(modelId)) {
        throw new Error(
          `aivideoapi: /runway/generate/text only accepts gen2 or gen3, got ${modelId}`
        );
      }
      path = '/runway/generate/text';
      body = { text_prompt: request.prompt, model: modelId };
      if (typeof options.width === 'number') body.width = options.width;
      if (typeof options.height === 'number') body.height = options.height;
      if (typeof options.motion === 'number') body.motion = options.motion;
      if (typeof options.seed === 'number') body.seed = options.seed;
      if (typeof options.callbackUrl === 'string') body.callback_url = options.callbackUrl;
      if (typeof request.duration === 'number') body.time = request.duration;
    } else {
      throw new Error(
        'aivideoapi.videoGenerate: at least one of prompt, image, or video is required'
      );
    }

    const submitted = await this.executeThroughBulkhead(
      () => this.fetchJson<AivideoapiTaskPayload>(path, { method: 'POST', body }),
      `POST ${path}`
    );
    const taskId = extractTaskId(submitted);
    if (!taskId) {
      throw new Error(
        `aivideoapi: ${path} response carried no recognizable task id (tried uuid/id/task_id/taskId) — raw: ${JSON.stringify(submitted).slice(0, 500)}`
      );
    }

    const terminal = await this.pollTask(taskId, orchestrationDeadlineAt);
    const status = extractStatus(terminal);
    if (status !== TERMINAL_SUCCESS) {
      const err = terminal.error || terminal.error_code || terminal.errorCode || status || 'unknown';
      throw new Error(`aivideoapi: task ${taskId} ended in status "${status}": ${err}`);
    }

    const videoUrl = extractVideoUrl(terminal);
    if (!videoUrl) {
      throw new Error(
        `aivideoapi: task ${taskId} reported success but no video URL was found (tried video_url/url/video, top-level and nested under data) — raw: ${JSON.stringify(terminal).slice(0, 500)}`
      );
    }

    return narrowAs<VideoGenResponse>({
      video: [{ id: taskId, url: videoUrl }],
      format: 'url',
      raw: terminal,
    });
  }

  private applyCommonImageOptions(body: Record<string, unknown>, options: Record<string, unknown>) {
    if (typeof options.imageAsEndFrame === 'boolean') body.image_as_end_frame = options.imageAsEndFrame;
    if (typeof options.flip === 'boolean') body.flip = options.flip;
    if (typeof options.motion === 'number') body.motion = options.motion;
    if (typeof options.seed === 'number') body.seed = options.seed;
    if (typeof options.callbackUrl === 'string') body.callback_url = options.callbackUrl;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    if (!this.apiKey) {
      return {
        healthy: false,
        checkedAt: new Date(),
        error: 'AIVIDEOAPI_API_KEY is not configured',
        latency: Date.now() - start,
      };
    }
    // No dedicated health/ping route is documented. /status with a
    // syntactically-valid-but-nonexistent uuid is the cheapest real probe —
    // same "probe a real endpoint, judge only on auth failure" pattern as
    // RunwayML (/v1/tasks) and BFL (/get_result?id=<bogus>) above.
    try {
      const res = await fetch(`${this.baseUrl}/status?uuid=00000000-0000-0000-0000-000000000000`, {
        method: 'GET',
        headers: this.buildHeaders(false),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401 || res.status === 403) {
        return {
          healthy: false,
          checkedAt: new Date(),
          latency: Date.now() - start,
          error: `aivideoapi HTTP ${res.status} — AIVIDEOAPI_API_KEY rejected`,
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
    return modelName?.trim() || 'gen3';
  }

  // ─── Polling internals ───────────────────────────────────────────────────

  /**
   * Poll `GET /status?uuid={taskId}` until a terminal status. Bounds its own
   * fixed `pollTimeoutMs` budget by `orchestrationDeadlineAt` when the caller
   * supplied one — see the class doc's "PR #497 lesson applied" section.
   * Exposed with `protected` visibility so tests can drive the state machine
   * with a tiny budget instead of waiting minutes.
   */
  protected async pollTask(
    taskId: string,
    orchestrationDeadlineAt?: number
  ): Promise<AivideoapiTaskPayload> {
    const pollStartedAt = Date.now();
    const ownDeadline = pollStartedAt + this.pollTimeoutMs;
    const cutShortByOrchestration =
      typeof orchestrationDeadlineAt === 'number' && orchestrationDeadlineAt < ownDeadline;
    const deadline = cutShortByOrchestration ? orchestrationDeadlineAt : ownDeadline;

    let lastPayload: AivideoapiTaskPayload | undefined;
    let lastError: string | undefined;

    for (;;) {
      try {
        lastPayload = await this.fetchJson<AivideoapiTaskPayload>(
          `/status?uuid=${encodeURIComponent(taskId)}`,
          { method: 'GET' }
        );
        const status = extractStatus(lastPayload);
        if (status === TERMINAL_SUCCESS || status === TERMINAL_FAILURE) {
          return lastPayload;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      if (Date.now() + this.pollIntervalMs > deadline) {
        const elapsedMs = Date.now() - pollStartedAt;
        const budgetNote = cutShortByOrchestration
          ? `cut short by the overall fallback search deadline (own poll budget is ${this.pollTimeoutMs}ms)`
          : `${this.pollTimeoutMs}ms poll budget`;
        const lastStatus = lastPayload ? extractStatus(lastPayload) || 'unknown' : 'unknown';
        throw new Error(
          `aivideoapi: task ${taskId} still "${lastStatus}" after ${elapsedMs}ms, ${budgetNote}` +
            (lastError ? ` (last poll error: ${lastError})` : '')
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private buildHeaders(includeJsonContentType: boolean): Record<string, string> {
    // Raw key, NOT "Bearer <key>" — see class doc's Auth section
    // (OpenAPI `type: apiKey` scheme, not `type: http, scheme: bearer`).
    const headers: Record<string, string> = {
      Authorization: this.apiKey,
      Accept: 'application/json',
    };
    if (includeJsonContentType) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private async fetchJson<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: Record<string, unknown> }
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
    const timeoutMs = Math.max(1000, this.config.timeout ?? 60_000);
    const res = await fetch(url, {
      method: init.method,
      headers: this.buildHeaders(init.method === 'POST'),
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '<unreadable>');
      throw new Error(`aivideoapi HTTP ${res.status} on ${init.method} ${path}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }
}
