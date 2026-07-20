// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * TopazAdapter — X-API-Key header, multipart upload, status poll, binary download.
 *
 * The Topaz flow is three-step: enhance POST → status poll → download GET. These
 * tests verify each step wires through correctly and the happy + failure
 * branches land in the right shape of response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopazAdapter } from '../topaz-adapter';
import type { Model } from '@/types';

const BASE = 'https://api.topazlabs.com/image/v1';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];

type RouteHandler = (url: string, init: RequestInit) => {
  ok?: boolean;
  status?: number;
  body: unknown;
  binary?: ArrayBuffer;
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
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response;
    }
    const result = route.handler(u, init ?? {});
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      json: async () => result.body,
      text: async () => JSON.stringify(result.body),
      arrayBuffer: async () => result.binary ?? new ArrayBuffer(0),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeAdapter() {
  return new TopazAdapter({
    apiKey: 'topaz-test-key',
    baseUrl: BASE,
    pollIntervalMs: 1,
    pollMaxAttempts: 10,
  });
}

function mockModel(id: string): Model {
  return {
    id,
    name: id,
    displayName: id,
    provider: 'topaz',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: ['image_upscale'],
  } as unknown as Model;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('TopazAdapter — static model allowlist', () => {
  it('accepts documented enhance pipelines', () => {
    expect(TopazAdapter.isTopazModel('standard_v2')).toBe(true);
    expect(TopazAdapter.isTopazModel('high_fidelity_v2')).toBe(true);
    expect(TopazAdapter.isTopazModel('art_and_cg')).toBe(true);
  });

  it('rejects unknown ids', () => {
    expect(TopazAdapter.isTopazModel('gigapixel-lite')).toBe(false);
    expect(TopazAdapter.isTopazModel('')).toBe(false);
  });
});

describe('TopazAdapter — getModels (no probe)', () => {
  it('returns static pipelines without any fetch', async () => {
    const sentinel = { count: 0 };
    const original = globalThis.fetch;
    globalThis.fetch = ((..._args: unknown[]) => {
      sentinel.count++;
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' } as Response);
    }) as unknown as typeof fetch;
    try {
      const models = await makeAdapter().getModels();
      expect(models.map((m) => m.id).sort()).toEqual([
        'art_and_cg',
        'high_fidelity_v2',
        'low_resolution',
        'standard_v2',
      ]);
      expect(sentinel.count).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('TopazAdapter — imageEdit full flow', () => {
  it('uploads multipart, polls status, downloads binary', async () => {
    let statusCall = 0;
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const restore = installFetchRouter([
      {
        match: (u) => u.endsWith('/enhance'),
        handler: (_, init) => {
          // Multipart body: the form should carry model + image parts.
          // We only check the header here; actual form parsing would need a helper.
          const h = init.headers as Record<string, string>;
          expect(h['X-API-Key']).toBe('topaz-test-key');
          return { body: { process_id: 'px-1' } };
        },
      },
      {
        match: (u) => u.includes('/status/px-1'),
        handler: () => {
          statusCall++;
          if (statusCall === 1) return { body: { status: 'processing', progress: 0.3 } };
          if (statusCall === 2) return { body: { status: 'processing', progress: 0.8 } };
          return { body: { status: 'completed', download_url: 'https://topaz.out/img.png' } };
        },
      },
      {
        match: (u) => u === 'https://topaz.out/img.png',
        handler: () => ({ body: {}, binary: fakePng.buffer }),
      },
    ]);

    try {
      const adapter = makeAdapter();
      const res = await adapter.imageEdit(mockModel('standard_v2'), {
        image: Buffer.from([1, 2, 3]),
        prompt: '',
        options: { upscale_factor: 2, noise_reduction: 50 },
      });
      expect(Buffer.isBuffer(res.image)).toBe(true);
      expect((res.image as Buffer).length).toBe(fakePng.length);
      expect(res.format).toBe('png');
      expect(statusCall).toBe(3);
    } finally {
      restore();
    }
  });

  it('throws when status settles FAILED with the reported error', async () => {
    const restore = installFetchRouter([
      { match: (u) => u.endsWith('/enhance'), handler: () => ({ body: { process_id: 'px-err' } }) },
      {
        match: (u) => u.includes('/status/px-err'),
        handler: () => ({ body: { status: 'failed', error: 'unsupported_format' } }),
      },
    ]);
    try {
      await expect(
        makeAdapter().imageEdit(mockModel('standard_v2'), {
          image: Buffer.from([1, 2, 3]),
          prompt: '',
        }),
      ).rejects.toThrow(/failed.*unsupported_format/);
    } finally {
      restore();
    }
  });

  it('rejects missing image', async () => {
    await expect(
      makeAdapter().imageEdit(mockModel('standard_v2'), {
        image: undefined as unknown as Buffer,
        prompt: '',
      }),
    ).rejects.toThrow(/image is required/);
  });

  it('rejects unknown model id', async () => {
    await expect(
      makeAdapter().imageEdit(mockModel('super_v9'), {
        image: Buffer.from([0]),
        prompt: '',
      }),
    ).rejects.toThrow(/unknown model/);
  });

  it('accepts URL string input (image_url form field)', async () => {
    const restore = installFetchRouter([
      {
        match: (u) => u.endsWith('/enhance'),
        handler: () => ({ body: { process_id: 'px-url' } }),
      },
      {
        match: (u) => u.includes('/status/px-url'),
        handler: () => ({ body: { status: 'completed', download_url: 'https://o.tif' } }),
      },
      {
        match: (u) => u === 'https://o.tif',
        handler: () => ({ body: {}, binary: new Uint8Array([9, 9, 9]).buffer }),
      },
    ]);
    try {
      const adapter = makeAdapter();
      const res = await adapter.imageEdit(mockModel('high_fidelity_v2'), {
        image: 'https://in.example/image.jpg',
        prompt: '',
      });
      expect(res.format).toBe('tiff');
    } finally {
      restore();
    }
  });
});

describe('TopazAdapter — other surfaces', () => {
  it('chat / embeddings / imageGenerate all refuse', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.chatCompletion({ model: 'x', messages: [{ role: 'user', content: 'y' }] }),
    ).rejects.toThrow(/image-only/);
    await expect(adapter.generateEmbeddings({ model: 'x', input: 'y' })).rejects.toThrow(
      /image-only/,
    );
    await expect(
      adapter.imageGenerate(mockModel('standard_v2'), { prompt: 'x' }),
    ).rejects.toThrow(/use imageEdit/);
  });

  it('healthcheck unhealthy when key missing', async () => {
    const adapter = new TopazAdapter({ apiKey: '', baseUrl: BASE });
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/TOPAZ_API_KEY/);
  });
});
