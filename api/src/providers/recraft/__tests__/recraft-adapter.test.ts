// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RecraftAdapter — style/model allowlist validation + /images/generations wire.
 *
 * Recraft's value-add over the generic OAI image surface is **model × style**
 * gating: v3 has vector families, v2 is raster-only. These tests cover the
 * static allowlist, wire-body composition, and the "no bulk /models" guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecraftAdapter } from '../recraft-adapter';
import type { Model } from '@/types';

const BASE = 'https://external.api.recraft.ai/v1';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];

function stubFetch(jsonBody: unknown, init: { ok?: boolean; status?: number } = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, fetchInit?: RequestInit) => {
    calls.push({ url: String(url), init: fetchInit ?? {} });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => jsonBody,
      text: async () => JSON.stringify(jsonBody),
      // Download step returns an empty ArrayBuffer for tests that don't care
      // about the binary payload — they only assert on request composition.
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function makeAdapter() {
  return new RecraftAdapter({
    apiKey: 'recraft-test-key',
    baseUrl: BASE,
  });
}

function mockModel(id: string): Model {
  return {
    id,
    name: id,
    displayName: id,
    provider: 'recraft',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: ['image_generation'],
  } as unknown as Model;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('RecraftAdapter — style/model allowlist', () => {
  it('accepts v3 vector + any styles', () => {
    expect(RecraftAdapter.isValidStyleForModel('recraftv3', 'vector_illustration')).toBe(true);
    expect(RecraftAdapter.isValidStyleForModel('recraftv3', 'any')).toBe(true);
    expect(RecraftAdapter.isValidStyleForModel('recraftv3', 'icon')).toBe(true);
  });

  it('rejects vector styles on v2', () => {
    expect(RecraftAdapter.isValidStyleForModel('recraftv2', 'vector_illustration')).toBe(false);
    expect(RecraftAdapter.isValidStyleForModel('recraftv2', 'icon')).toBe(false);
    expect(RecraftAdapter.isValidStyleForModel('recraftv2', 'realistic_image')).toBe(true);
  });

  it('rejects unknown model entirely', () => {
    expect(RecraftAdapter.isValidStyleForModel('recraft-alpha', 'realistic_image')).toBe(false);
  });
});

describe('RecraftAdapter — getModels (no bulk /models)', () => {
  it('returns static catalog without hitting the wire', async () => {
    const sentinel = { count: 0 };
    const original = globalThis.fetch;
    globalThis.fetch = ((..._args: unknown[]) => {
      sentinel.count++;
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' } as Response);
    }) as unknown as typeof fetch;
    try {
      const adapter = makeAdapter();
      const models = await adapter.getModels();
      expect(models.map((m) => m.id).sort()).toEqual(['recraftv2', 'recraftv3']);
      expect(sentinel.count).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('RecraftAdapter — imageGenerate wire shape', () => {
  it('POSTs /images/generations with prompt + style + n + size + response_format, then downloads URL', async () => {
    // Route both the generations call and the follow-up download.
    const original = globalThis.fetch;
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    globalThis.fetch = (vi.fn(async (url: string | URL | Request, fetchInit?: RequestInit) => {
      calls.push({ url: String(url), init: fetchInit ?? {} });
      if (String(url).endsWith('/images/generations')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            created: 1234,
            data: [{ url: 'https://cdn.recraft.ai/out.png', image_id: 'img-1' }],
          }),
          text: async () => '',
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response;
      }
      // Download step
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '',
        arrayBuffer: async () => fakePng.buffer as ArrayBuffer,
      } as Response;
    }) as unknown) as typeof fetch;
    try {
      const adapter = makeAdapter();
      const res = await adapter.imageGenerate(mockModel('recraftv3'), {
        prompt: 'logo for a coffee shop',
        size: '1024x1024',
        options: { style: 'logo_raster', n: 1, response_format: 'url' },
      });
      expect(Buffer.isBuffer(res.image)).toBe(true);
      expect((res.image as Buffer).length).toBe(fakePng.length);
      expect(res.format).toBe('png');
      expect(calls[0].url).toBe(`${BASE}/images/generations`);
      expect(calls[1].url).toBe('https://cdn.recraft.ai/out.png');
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.model).toBe('recraftv3');
      expect(body.prompt).toBe('logo for a coffee shop');
      expect(body.size).toBe('1024x1024');
      expect(body.n).toBe(1);
      expect(body.style).toBe('logo_raster');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects style/model mismatch before the wire', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.imageGenerate(mockModel('recraftv2'), {
        prompt: 'x',
        options: { style: 'vector_illustration' },
      }),
    ).rejects.toThrow(/not valid for recraftv2/);
  });

  it('rejects unsupported size', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.imageGenerate(mockModel('recraftv3'), {
        prompt: 'x',
        size: '9999x9999',
      }),
    ).rejects.toThrow(/invalid size/);
  });

  it('decodes b64_json to a Buffer when response_format=b64_json', async () => {
    const restore = stubFetch({
      data: [{ b64_json: Buffer.from('fake-png').toString('base64') }],
    });
    try {
      const adapter = makeAdapter();
      const res = await adapter.imageGenerate(mockModel('recraftv3'), {
        prompt: 'x',
        options: { response_format: 'b64_json' },
      });
      expect(Buffer.isBuffer(res.image)).toBe(true);
      expect((res.image as Buffer).toString()).toBe('fake-png');
      expect(res.format).toBe('png');
    } finally {
      restore();
    }
  });

  it('sends Authorization: Bearer', async () => {
    const restore = stubFetch({ data: [{ url: 'u' }] });
    try {
      const adapter = makeAdapter();
      await adapter.imageGenerate(mockModel('recraftv3'), { prompt: 'x' });
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer recraft-test-key');
      expect(headers['Content-Type']).toBe('application/json');
    } finally {
      restore();
    }
  });

  it('rejects unknown model id', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.imageGenerate(mockModel('recraft-v99'), { prompt: 'x' }),
    ).rejects.toThrow(/unknown model/);
  });
});

describe('RecraftAdapter — chat/embeddings are unsupported', () => {
  it('chatCompletion throws', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.chatCompletion({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/image-only/);
  });

  it('generateEmbeddings throws', async () => {
    const adapter = makeAdapter();
    await expect(adapter.generateEmbeddings({ model: 'x', input: 'y' })).rejects.toThrow(
      /image-only/,
    );
  });
});

describe('RecraftAdapter — healthcheck', () => {
  it('returns unhealthy when apiKey missing', async () => {
    const adapter = new RecraftAdapter({ apiKey: '', baseUrl: BASE });
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/RECRAFT_API_KEY/);
  });
});
