// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Video-protocol behaviors of the hub adapter, live-proven 2026-07-17:
 *
 * - FastRouter's video surface is an ASYNC JOB QUEUE (`POST /videos` →
 *   `{data:{taskId,status:"processing"}}`, poll `GET /videos/{taskId}` until
 *   `data.generations[]`/`fastrouter_assets.urls[]` appear) — the previous
 *   implementation only parsed a sync `data[]` and would have normalized any
 *   async submit response to zero videos.
 * - Together's endpoint requires `{model, payload:{...}}` (payload-wrap) —
 *   the flat OAI body is rejected with a field-validation 400.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleHubAdapter } from '@/providers/openai-compatible-hub/openai-compatible-hub-adapter';
import { getModelsByProvider } from '@/services/model-catalog-service';

vi.mock('@/services/model-catalog-service', () => ({
  getModelsByProvider: vi.fn(),
}));

const mockedGetModelsByProvider = vi.mocked(getModelsByProvider);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function buildCatalogModel(name: string): unknown {
  return {
    id: name,
    provider: 'testhub',
    name,
    displayName: name,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['video_generation'],
    performance: { latencyMs: 500, throughput: 100, quality: 0.8, reliability: 0.9 },
    status: 'active',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createAdapter(metadata?: Record<string, unknown>): OpenAICompatibleHubAdapter {
  return new OpenAICompatibleHubAdapter({
    name: 'testhub',
    providerName: 'testhub',
    apiKey: 'test-key',
    baseUrl: 'https://api.testhub.example/api/v1',
    enabled: true,
    metadata,
  });
}

describe('hub videoGenerate — async job-queue protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Keep the poll loop fast: the implementation clamps to >=500ms interval.
    process.env.HUB_VIDEO_POLL_INTERVAL_MS = '500';
    process.env.HUB_VIDEO_POLL_TIMEOUT_MS = '10000';
  });
  afterEach(() => {
    delete process.env.HUB_VIDEO_POLL_INTERVAL_MS;
    delete process.env.HUB_VIDEO_POLL_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  it('submits to the configured async path, polls until generations appear, and extracts the video url', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('openai/sora-2')] as never);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      // submit: task accepted, no videos yet (FastRouter live shape)
      .mockResolvedValueOnce(
        jsonResponse({
          chat_id: 'fr_chat',
          code: 'success',
          data: { taskId: 'fr_TASK123', status: 'processing' },
        })
      )
      // poll 1: still processing
      .mockResolvedValueOnce(
        jsonResponse({ code: 'processing', data: { taskId: 'fr_TASK123', status: 'processing', generations: [] } })
      )
      // poll 2: finished with a generation
      .mockResolvedValueOnce(
        jsonResponse({
          code: 'success',
          data: {
            taskId: 'fr_TASK123',
            status: 'succeeded',
            generations: [{ id: 'g1', url: 'https://cdn.example.com/final.mp4' }],
          },
        })
      );

    const adapter = createAdapter({ videosPath: '/videos', videoPollPath: '/videos/{taskId}' });
    const response = await adapter.videoGenerate(
      { id: 'openai/sora-2', name: 'openai/sora-2' } as never,
      { prompt: 'a sunset over the ocean' } as never
    );

    expect(response.video).toEqual([{ id: 'g1', url: 'https://cdn.example.com/final.mp4' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const [submitUrl, submitInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(submitUrl).toContain('/videos');
    expect(submitUrl).not.toContain('/videos/generations');
    expect((submitInit.method ?? 'POST').toUpperCase()).toBe('POST');
    const [pollUrl, pollInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(pollUrl).toContain('/videos/fr_TASK123');
    expect((pollInit.method ?? 'GET').toUpperCase()).toBe('GET');
  });

  it('extracts fastrouter_assets.urls when generations are absent', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('kling-ai/kling-v3')] as never);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ data: { taskId: 't2', status: 'processing' } })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 'success',
          data: { taskId: 't2', status: 'succeeded' },
          fastrouter_assets: { status: 'ready', urls: ['https://assets.example.com/v.mp4'] },
        })
      );

    const adapter = createAdapter({ videosPath: '/videos' });
    const response = await adapter.videoGenerate(
      { id: 'kling-ai/kling-v3', name: 'kling-ai/kling-v3' } as never,
      { prompt: 'ocean waves' } as never
    );

    expect(response.video).toEqual([{ url: 'https://assets.example.com/v.mp4' }]);
  });

  it('throws with task id and status when the job terminates without output (live incident shape)', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('openai/sora-2')] as never);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ data: { taskId: 't3', status: 'processing' } }))
      // terminal failure — the exact shape of the 2026-07-17 empty-prompt
      // incident: status failed, error string, zero generations
      .mockResolvedValueOnce(
        jsonResponse({
          code: 'failed',
          data: { taskId: 't3', status: 'failed', generations: [] },
          error: 'openai submit: upstream status 400',
        })
      );

    const adapter = createAdapter({ videosPath: '/videos' });
    await expect(
      adapter.videoGenerate(
        { id: 'openai/sora-2', name: 'openai/sora-2' } as never,
        { prompt: '' } as never
      )
    ).rejects.toThrow(/t3.*failed/);
  });

  it('still returns sync data[] responses without any polling (regression)', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('veo-3')] as never);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'v1', url: 'https://cdn.example.com/sync.mp4' }] })
    );

    const adapter = createAdapter();
    const response = await adapter.videoGenerate(
      { id: 'veo-3', name: 'veo-3' } as never,
      { prompt: 'sync case' } as never
    );

    expect(response.video).toEqual([{ id: 'v1', url: 'https://cdn.example.com/sync.mp4' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('terminal-success submit with zero videos is a legitimate empty sync response — no poll', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('veo-3')] as never);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      // A terminal status at submit time must NOT enter the poll loop: the id
      // here is a request id, not a task to wait on.
      jsonResponse({ id: 'req_1', status: 'success', data: [] })
    );

    const adapter = createAdapter({ videosPath: '/videos', videoPollPath: '/videos/{taskId}' });
    const response = await adapter.videoGenerate(
      { id: 'veo-3', name: 'veo-3' } as never,
      { prompt: 'sync empty' } as never
    );

    expect(response.video).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts snake_case task_id and polls it', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('openai/sora-2')] as never);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ task_id: 'sn_1', status: 'queued' }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            task_id: 'sn_1',
            status: 'succeeded',
            generations: [{ id: 'g1', url: 'https://cdn.example.com/snake.mp4' }],
          },
        })
      );

    const adapter = createAdapter({ videosPath: '/videos', videoPollPath: '/videos/{taskId}' });
    const response = await adapter.videoGenerate(
      { id: 'openai/sora-2', name: 'openai/sora-2' } as never,
      { prompt: 'snake case task id' } as never
    );

    expect(response.video).toEqual([{ id: 'g1', url: 'https://cdn.example.com/snake.mp4' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [pollUrl] = fetchSpy.mock.calls[1] as [string];
    expect(pollUrl).toContain('/videos/sn_1');
  });

  it('tolerates a transient 500 between polls — the paid job still completes', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('openai/sora-2')] as never);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ data: { taskId: 't5', status: 'processing' } })
      )
      // poll 1: still processing
      .mockResolvedValueOnce(
        jsonResponse({ data: { taskId: 't5', status: 'processing', generations: [] } })
      )
      // poll 2: transient gateway 500 — must NOT abort the paid job
      .mockResolvedValueOnce(new Response('upstream hiccup', { status: 500 }))
      // poll 3: healthy terminal result
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            taskId: 't5',
            status: 'succeeded',
            generations: [{ id: 'g1', url: 'https://cdn.example.com/recovered.mp4' }],
          },
        })
      );

    const adapter = createAdapter({ videosPath: '/videos', videoPollPath: '/videos/{taskId}' });
    const response = await adapter.videoGenerate(
      { id: 'openai/sora-2', name: 'openai/sora-2' } as never,
      { prompt: 'transient poll failure' } as never
    );

    expect(response.video).toEqual([{ id: 'g1', url: 'https://cdn.example.com/recovered.mp4' }]);
    // submit + 3 polls: the 500 consumed one poll round, not the job
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('preserves id-only items on the sync data[] path (async handle contract)', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('veo-3')] as never);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      // No status → sync response; the id-only item is an async handle that
      // must survive for the orchestration empty-generation guard.
      jsonResponse({ data: [{ id: 'gen_handle_1' }] })
    );

    const adapter = createAdapter();
    const response = await adapter.videoGenerate(
      { id: 'veo-3', name: 'veo-3' } as never,
      { prompt: 'id-only handle' } as never
    );

    expect(response.video).toEqual([{ id: 'gen_handle_1' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('hub videoGenerate — paid-submit protections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT re-POST the submit on a transient 500 (async paid job — retry could double-bill)', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('openai/sora-2')] as never);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('flaky', { status: 500 }))
      // A retry would land here and start a SECOND billed generation.
      .mockResolvedValue(
        jsonResponse({ data: { taskId: 'dup_TASK', status: 'processing' } })
      );

    const adapter = createAdapter({ videosPath: '/videos', videoPollPath: '/videos/{taskId}' });
    await expect(
      adapter.videoGenerate(
        { id: 'openai/sora-2', name: 'openai/sora-2' } as never,
        { prompt: 'no submit retry' } as never
      )
    ).rejects.toThrow(/video generation failed: HTTP 500/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('hub videoGenerate — payload-wrap request style (Together)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('nests everything except model under payload when videoRequestStyle=payload-wrap', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('openai/sora-2')] as never);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'v1', url: 'https://cdn.together.example/v.mp4' }] })
    );

    const adapter = createAdapter({ videoRequestStyle: 'payload-wrap' });
    await adapter.videoGenerate(
      { id: 'openai/sora-2', name: 'openai/sora-2' } as never,
      { prompt: 'wrapped body', duration: 4, options: { n: 1 } } as never
    );

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('openai/sora-2');
    expect(body.prompt).toBeUndefined();
    const payload = body.payload as Record<string, unknown>;
    expect(payload).toBeDefined();
    expect(payload.prompt).toBe('wrapped body');
    expect(payload.duration).toBe(4);
    expect(payload.n).toBe(1);
    expect(payload.model).toBeUndefined();
  });

  it('keeps the flat body by default (regression)', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('veo-3')] as never);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'v1', url: 'https://cdn.example.com/flat.mp4' }] })
    );

    const adapter = createAdapter();
    await adapter.videoGenerate(
      { id: 'veo-3', name: 'veo-3' } as never,
      { prompt: 'flat body' } as never
    );

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('veo-3');
    expect(body.prompt).toBe('flat body');
    expect(body.payload).toBeUndefined();
  });
});
