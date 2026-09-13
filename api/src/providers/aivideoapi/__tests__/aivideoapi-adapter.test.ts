// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it, vi } from 'vitest';
import { AivideoapiAdapter } from '../aivideoapi-adapter';
import type { Model } from '@/types';
import type { VideoGenRequest } from '@/types/model-client';
import { narrowAs } from '@/utils/type-guards';

function makeModel(id: string): Model {
  return narrowAs<Model>({
    id,
    name: id,
    displayName: id,
    provider: 'aivideoapi',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: ['video_generation'],
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AivideoapiAdapter — auth', () => {
  it('sends the raw API key in the Authorization header, no Bearer prefix', async () => {
    const capturedHeaders: HeadersInit[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.headers) capturedHeaders.push(init.headers);
      const path = String(url);
      if (path.includes('/status')) return jsonResponse({ status: 'success', video_url: 'https://x/ok.mp4' });
      return jsonResponse({ uuid: 'task-1' });
    }) as unknown as typeof fetch;

    const adapter = new AivideoapiAdapter({ apiKey: 'raw-secret-value', pollIntervalMs: 1 });
    await adapter.videoGenerate(makeModel('gen3'), { prompt: 'a cat' } as VideoGenRequest);

    expect(capturedHeaders.length).toBeGreaterThan(0);
    for (const headers of capturedHeaders) {
      const h = headers as Record<string, string>;
      expect(h.Authorization).toBe('raw-secret-value');
      expect(h.Authorization.startsWith('Bearer')).toBe(false);
    }
  });
});

describe('AivideoapiAdapter — model validation', () => {
  it('rejects an unknown model before making any request', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const adapter = new AivideoapiAdapter({ apiKey: 'k' });
    await expect(
      adapter.videoGenerate(makeModel('gen99'), { prompt: 'x' } as VideoGenRequest)
    ).rejects.toThrow(/unknown model/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects gen4 on the text-to-video route (gen2/gen3 only)', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const adapter = new AivideoapiAdapter({ apiKey: 'k' });
    await expect(
      adapter.videoGenerate(makeModel('gen4'), { prompt: 'x' } as VideoGenRequest)
    ).rejects.toThrow(/generate\/text only accepts gen2 or gen3/);
  });
});

describe('AivideoapiAdapter — endpoint routing', () => {
  it('routes a prompt-only request to /runway/generate/text', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      calls.push(path);
      if (path.includes('/runway/generate/text')) return jsonResponse({ uuid: 't1' });
      if (path.includes('/status')) return jsonResponse({ status: 'success', video_url: 'https://x/v.mp4' });
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;

    const adapter = new AivideoapiAdapter({ apiKey: 'k', pollIntervalMs: 1 });
    const res = await adapter.videoGenerate(makeModel('gen3'), { prompt: 'a dog' } as VideoGenRequest);
    expect(calls[0]).toContain('/runway/generate/text');
    expect(res.video[0].url).toBe('https://x/v.mp4');
  });

  it('routes an image-only request to /runway/generate/image', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/runway/generate/image')) return jsonResponse({ uuid: 't2' });
      if (path.includes('/status')) return jsonResponse({ status: 'success', url: 'https://x/i.mp4' });
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;

    const adapter = new AivideoapiAdapter({ apiKey: 'k', pollIntervalMs: 1 });
    const res = await adapter.videoGenerate(makeModel('gen3'), {
      image: 'https://example.com/a.png',
    } as VideoGenRequest);
    expect(res.video[0].url).toBe('https://x/i.mp4');
  });

  it('routes image+prompt to /runway/generate/imageDescription', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      calls.push(path);
      if (path.includes('/status')) return jsonResponse({ status: 'success', video: 'https://x/d.mp4' });
      return jsonResponse({ uuid: 't3' });
    }) as unknown as typeof fetch;

    const adapter = new AivideoapiAdapter({ apiKey: 'k', pollIntervalMs: 1 });
    await adapter.videoGenerate(makeModel('gen3'), {
      image: 'https://example.com/a.png',
      prompt: 'zoom in',
    } as VideoGenRequest);
    expect(calls[0]).toContain('/runway/generate/imageDescription');
  });

  it('routes a video+prompt restyle request to /runway/generate/video with no model field', async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (init?.body) bodies.push(JSON.parse(init.body as string));
      if (path.includes('/status')) return jsonResponse({ status: 'success', video_url: 'https://x/r.mp4' });
      return jsonResponse({ uuid: 't4' });
    }) as unknown as typeof fetch;

    const adapter = new AivideoapiAdapter({ apiKey: 'k', pollIntervalMs: 1 });
    await adapter.videoGenerate(makeModel('gen3'), {
      video: 'https://example.com/in.mp4',
      prompt: 'restyle as anime',
    } as VideoGenRequest);
    expect(bodies[0].model).toBeUndefined();
    expect(bodies[0].video_prompt).toBe('https://example.com/in.mp4');
  });

  it('requires a prompt for video-to-video restyle', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const adapter = new AivideoapiAdapter({ apiKey: 'k' });
    await expect(
      adapter.videoGenerate(makeModel('gen3'), { video: 'https://example.com/in.mp4' } as VideoGenRequest)
    ).rejects.toThrow(/prompt is required for video-to-video/);
  });

  it('routes an extendUuid option to /runway/extend', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      calls.push(path);
      if (path.includes('/status')) return jsonResponse({ status: 'success', url: 'https://x/e.mp4' });
      return jsonResponse({ uuid: 't5' });
    }) as unknown as typeof fetch;

    const adapter = new AivideoapiAdapter({ apiKey: 'k', pollIntervalMs: 1 });
    await adapter.videoGenerate(makeModel('gen3'), {
      options: { extendUuid: 'prior-task-uuid' },
    } as unknown as VideoGenRequest);
    expect(calls[0]).toContain('/runway/extend');
  });

  it('rejects when no prompt/image/video is supplied', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const adapter = new AivideoapiAdapter({ apiKey: 'k' });
    await expect(
      adapter.videoGenerate(makeModel('gen3'), {} as VideoGenRequest)
    ).rejects.toThrow(/at least one of prompt, image, or video/);
  });
});

describe('AivideoapiAdapter — undocumented response shape tolerance', () => {
  it('extracts a task id from any of uuid/id/task_id/taskId', async () => {
    for (const [key, value] of [
      ['uuid', 'a'],
      ['id', 'b'],
      ['task_id', 'c'],
      ['taskId', 'd'],
    ] as const) {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const path = String(url);
        if (path.includes('/status')) return jsonResponse({ status: 'success', video_url: 'https://x/ok.mp4' });
        return jsonResponse({ [key]: value });
      }) as unknown as typeof fetch;

      const adapter = new AivideoapiAdapter({ apiKey: 'k', pollIntervalMs: 1 });
      const res = await adapter.videoGenerate(makeModel('gen3'), { prompt: 'x' } as VideoGenRequest);
      expect(res.video[0].id).toBe(value);
    }
  });

  it('throws with the raw payload when no recognizable task id is present', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ weird_field: 'nope' })) as unknown as typeof fetch;
    const adapter = new AivideoapiAdapter({ apiKey: 'k' });
    await expect(
      adapter.videoGenerate(makeModel('gen3'), { prompt: 'x' } as VideoGenRequest)
    ).rejects.toThrow(/no recognizable task id/);
  });

  it('extracts a video url from url or video when video_url is absent, including nested under data', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/status')) {
        return jsonResponse({ status: 'success', data: { url: 'https://x/nested.mp4' } });
      }
      return jsonResponse({ uuid: 't1' });
    }) as unknown as typeof fetch;

    const adapter = new AivideoapiAdapter({ apiKey: 'k', pollIntervalMs: 1 });
    const res = await adapter.videoGenerate(makeModel('gen3'), { prompt: 'x' } as VideoGenRequest);
    expect(res.video[0].url).toBe('https://x/nested.mp4');
  });

  it('throws with the raw payload when status is success but no video url can be found', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/status')) return jsonResponse({ status: 'success' });
      return jsonResponse({ uuid: 't1' });
    }) as unknown as typeof fetch;

    const adapter = new AivideoapiAdapter({ apiKey: 'k', pollIntervalMs: 1 });
    await expect(
      adapter.videoGenerate(makeModel('gen3'), { prompt: 'x' } as VideoGenRequest)
    ).rejects.toThrow(/no video URL was found/);
  });

  it('throws a descriptive error when the task ends in failed status', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/status')) return jsonResponse({ status: 'failed', error: 'nsfw content' });
      return jsonResponse({ uuid: 't1' });
    }) as unknown as typeof fetch;

    const adapter = new AivideoapiAdapter({ apiKey: 'k', pollIntervalMs: 1 });
    await expect(
      adapter.videoGenerate(makeModel('gen3'), { prompt: 'x' } as VideoGenRequest)
    ).rejects.toThrow(/nsfw content/);
  });

  it('keeps polling through undocumented transitional statuses until a terminal one arrives', async () => {
    let pollCount = 0;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/status')) {
        pollCount += 1;
        if (pollCount < 3) return jsonResponse({ status: 'in queue' });
        return jsonResponse({ status: 'success', video_url: 'https://x/done.mp4' });
      }
      return jsonResponse({ uuid: 't1' });
    }) as unknown as typeof fetch;

    const adapter = new AivideoapiAdapter({ apiKey: 'k', pollIntervalMs: 1 });
    const res = await adapter.videoGenerate(makeModel('gen3'), { prompt: 'x' } as VideoGenRequest);
    expect(pollCount).toBe(3);
    expect(res.video[0].url).toBe('https://x/done.mp4');
  });
});

describe('AivideoapiAdapter — orchestration-deadline-aware polling', () => {
  it('cuts the poll loop short when orchestrationDeadlineAt is sooner than the own poll budget', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/status')) return jsonResponse({ status: 'submitted' });
      return jsonResponse({ uuid: 't1' });
    }) as unknown as typeof fetch;

    const adapter = new AivideoapiAdapter({ apiKey: 'k', pollIntervalMs: 10, pollTimeoutMs: 60_000 });
    const soonDeadline = Date.now() + 5;
    await expect(
      adapter.videoGenerate(makeModel('gen3'), {
        prompt: 'x',
        options: { orchestrationDeadlineAt: soonDeadline },
      } as unknown as VideoGenRequest)
    ).rejects.toThrow(/cut short by the overall fallback search deadline/);
  });
});

describe('AivideoapiAdapter — unsupported surfaces', () => {
  it('throws for chatCompletion, embeddings, and moderation — video-only provider', async () => {
    const adapter = new AivideoapiAdapter({ apiKey: 'k' });
    await expect(adapter.chatCompletion({} as never)).rejects.toThrow(/video-only/);
    await expect(adapter.generateEmbeddings({} as never)).rejects.toThrow(/video-only/);
    await expect(adapter.moderate(makeModel('gen3'), {} as never)).rejects.toThrow(/not supported/);
  });
});

describe('AivideoapiAdapter — health check', () => {
  it('reports unhealthy without throwing when no API key is configured', async () => {
    const adapter = new AivideoapiAdapter({ apiKey: '' });
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.error).toMatch(/not configured/);
  });

  it('reports unhealthy on a 401/403 from the probe endpoint', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({}, 401)) as unknown as typeof fetch;
    const adapter = new AivideoapiAdapter({ apiKey: 'bad-key' });
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.error).toMatch(/rejected/);
  });

  it('reports healthy on any non-auth response (no dedicated ping route exists)', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ status: 'not found' }, 404)) as unknown as typeof fetch;
    const adapter = new AivideoapiAdapter({ apiKey: 'k' });
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(true);
  });
});
