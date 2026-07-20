// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RunwayMLAdapter — X-Runway-Version header, async polling, task state machine.
 *
 * Runway's API is an async-job protocol:
 *   POST /v1/image_to_video → { id }
 *   poll GET /v1/tasks/{id} → { status, output? }
 *
 * These tests install a routed fetch stub that advances a scripted task-state
 * machine so we can assert both happy path and failure transitions without
 * sleeping between polls. The adapter's `pollIntervalMs` is set to 1ms in
 * tests to keep wall-clock trivial.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunwayMLAdapter } from '../runwayml-adapter';
import type { Model } from '@/types';

const BASE = 'https://api.dev.runwayml.com';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];

type RouteHandler = (url: string, init: RequestInit) => {
  ok?: boolean;
  status?: number;
  body: unknown;
};

function installFetchRouter(routes: Array<{ match: (url: string) => boolean; handler: RouteHandler }>) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const route = routes.find((r) => r.match(u));
    if (!route) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: `no stub for ${u}` }),
        text: async () => `no stub for ${u}`,
      } as Response;
    }
    const result = route.handler(u, init ?? {});
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      json: async () => result.body,
      text: async () => JSON.stringify(result.body),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeAdapter(overrides: { apiVersion?: string } = {}) {
  return new RunwayMLAdapter({
    apiKey: 'runway-test-key',
    baseUrl: BASE,
    apiVersion: overrides.apiVersion,
    pollIntervalMs: 1, // fast tests
    pollMaxAttempts: 20,
  });
}

function mockModel(id: string): Model {
  return {
    id,
    name: id,
    displayName: id,
    provider: 'runwayml',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: ['image_to_video'],
  } as unknown as Model;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('RunwayMLAdapter — static model id guards', () => {
  it('accepts documented ids', () => {
    expect(RunwayMLAdapter.isRunwayModel('gen3a_turbo')).toBe(true);
    expect(RunwayMLAdapter.isRunwayModel('gen3_alpha')).toBe(true);
    expect(RunwayMLAdapter.isRunwayModel('act-one')).toBe(true);
  });

  it('rejects unknown ids', () => {
    expect(RunwayMLAdapter.isRunwayModel('gen2')).toBe(false);
    expect(RunwayMLAdapter.isRunwayModel('')).toBe(false);
  });
});

describe('RunwayMLAdapter — getModels (no probe)', () => {
  it('returns the static catalog without any fetch', async () => {
    const sentinel = { count: 0 };
    const original = globalThis.fetch;
    globalThis.fetch = ((..._args: unknown[]) => {
      sentinel.count++;
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' } as Response);
    }) as unknown as typeof fetch;
    try {
      const models = await makeAdapter().getModels();
      expect(models.map((m) => m.id).sort()).toEqual(['act-one', 'gen3_alpha', 'gen3a_turbo']);
      expect(sentinel.count).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('RunwayMLAdapter — X-Runway-Version header', () => {
  it('stamps the default version on every call', async () => {
    const restore = installFetchRouter([
      { match: (u) => u.endsWith('/v1/image_to_video'), handler: () => ({ body: { id: 't1', status: 'PENDING' } }) },
      { match: (u) => u.includes('/v1/tasks/t1'), handler: () => ({ body: { id: 't1', status: 'SUCCEEDED', output: ['https://r.runway.out/a.mp4'] } }) },
    ]);
    try {
      const adapter = makeAdapter();
      await adapter.videoGenerate(mockModel('gen3a_turbo'), {
        prompt: 'zoom in',
        options: { promptImage: 'https://in.jpg' },
      });
      for (const c of calls) {
        const h = c.init.headers as Record<string, string>;
        expect(h['X-Runway-Version']).toBe('2024-11-06');
        expect(h.Authorization).toBe('Bearer runway-test-key');
      }
    } finally {
      restore();
    }
  });

  it('honors apiVersion override', async () => {
    const restore = installFetchRouter([
      { match: (u) => u.endsWith('/v1/image_to_video'), handler: () => ({ body: { id: 't2', status: 'PENDING' } }) },
      { match: (u) => u.includes('/v1/tasks/t2'), handler: () => ({ body: { id: 't2', status: 'SUCCEEDED', output: ['u'] } }) },
    ]);
    try {
      const adapter = makeAdapter({ apiVersion: '2025-01-01' });
      await adapter.videoGenerate(mockModel('gen3a_turbo'), {
        prompt: 'x',
        options: { promptImage: 'https://in.jpg' },
      });
      const h = calls[0].init.headers as Record<string, string>;
      expect(h['X-Runway-Version']).toBe('2025-01-01');
    } finally {
      restore();
    }
  });
});

describe('RunwayMLAdapter — videoGenerate task state machine', () => {
  it('polls PENDING → RUNNING → SUCCEEDED and returns the first output URL', async () => {
    let statusCall = 0;
    const restore = installFetchRouter([
      { match: (u) => u.endsWith('/v1/image_to_video'), handler: () => ({ body: { id: 't42', status: 'PENDING' } }) },
      {
        match: (u) => u.includes('/v1/tasks/t42'),
        handler: () => {
          statusCall++;
          if (statusCall === 1) return { body: { id: 't42', status: 'PENDING' } };
          if (statusCall === 2) return { body: { id: 't42', status: 'RUNNING', progress: 0.5 } };
          return { body: { id: 't42', status: 'SUCCEEDED', output: ['https://out.mp4', 'https://thumb.jpg'] } };
        },
      },
    ]);
    try {
      const adapter = makeAdapter();
      const res = await adapter.videoGenerate(mockModel('gen3_alpha'), {
        prompt: 'a cat flips through space',
        options: { promptImage: 'https://cat.jpg', duration: 5, ratio: '16:9' },
      });
      expect(res.video).toBe('https://out.mp4');
      expect(statusCall).toBe(3);
    } finally {
      restore();
    }
  });

  it('throws when task ends FAILED and includes the failure reason', async () => {
    const restore = installFetchRouter([
      { match: (u) => u.endsWith('/v1/image_to_video'), handler: () => ({ body: { id: 'tx', status: 'PENDING' } }) },
      {
        match: (u) => u.includes('/v1/tasks/tx'),
        handler: () => ({ body: { id: 'tx', status: 'FAILED', failure: 'content_moderation', failureCode: 'CM_001' } }),
      },
    ]);
    try {
      const adapter = makeAdapter();
      await expect(
        adapter.videoGenerate(mockModel('gen3a_turbo'), {
          prompt: 'x',
          options: { promptImage: 'https://in.jpg' },
        }),
      ).rejects.toThrow(/FAILED.*content_moderation/);
    } finally {
      restore();
    }
  });

  it('sends promptImage + promptText in the body', async () => {
    const restore = installFetchRouter([
      { match: (u) => u.endsWith('/v1/image_to_video'), handler: () => ({ body: { id: 'b1', status: 'PENDING' } }) },
      { match: (u) => u.includes('/v1/tasks/b1'), handler: () => ({ body: { id: 'b1', status: 'SUCCEEDED', output: ['u'] } }) },
    ]);
    try {
      const adapter = makeAdapter();
      await adapter.videoGenerate(mockModel('gen3a_turbo'), {
        prompt: 'camera slowly pans up',
        options: { promptImage: 'https://src.jpg', duration: 10, ratio: '9:16', seed: 42 },
      });
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.model).toBe('gen3a_turbo');
      expect(body.promptImage).toBe('https://src.jpg');
      expect(body.promptText).toBe('camera slowly pans up');
      expect(body.duration).toBe(10);
      expect(body.ratio).toBe('9:16');
      expect(body.seed).toBe(42);
    } finally {
      restore();
    }
  });

  it('rejects when promptImage is missing', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.videoGenerate(mockModel('gen3a_turbo'), { prompt: 'x' }),
    ).rejects.toThrow(/promptImage.*required/);
  });
});

describe('RunwayMLAdapter — chat/embeddings are unsupported', () => {
  it('chatCompletion throws', async () => {
    await expect(
      makeAdapter().chatCompletion({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/video-only/);
  });

  it('generateEmbeddings throws', async () => {
    await expect(makeAdapter().generateEmbeddings({ model: 'x', input: 'y' })).rejects.toThrow(
      /video-only/,
    );
  });
});
