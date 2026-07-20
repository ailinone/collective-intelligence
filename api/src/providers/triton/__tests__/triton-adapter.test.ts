// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * TritonAdapter — KServe v2 wire shape + flat→rows reshape contract.
 *
 * The tensor shape invariants are the critical ones. If the batch dimension
 * or the flattening math regresses, embeddings silently degrade into gibberish
 * (rows misaligned by one column produce plausible-looking-but-wrong vectors).
 * Each tensor-shape test is therefore a tripwire against a class of
 * cross-row contamination bugs that pure functional tests would miss.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TritonAdapter } from '../triton-adapter';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];

function stubFetch(
  response:
    | { ok?: boolean; status?: number; body: unknown }
    | ((url: string, init: RequestInit) => {
        ok?: boolean;
        status?: number;
        body: unknown;
      }),
) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const resolved = typeof response === 'function' ? response(String(url), init ?? {}) : response;
    return {
      ok: resolved.ok ?? true,
      status: resolved.status ?? 200,
      json: async () => resolved.body,
      text: async () => JSON.stringify(resolved.body),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeAdapter(opts?: { apiKey?: string; baseUrl?: string; inputTensorName?: string }) {
  return new TritonAdapter({
    apiKey: opts?.apiKey ?? '',
    baseUrl: opts?.baseUrl ?? 'http://localhost:8000',
    inputTensorName: opts?.inputTensorName,
  });
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('TritonAdapter — embeddings wire shape', () => {
  it('POSTs /v2/models/{model}/infer with a BYTES tensor at shape [batch, 1]', async () => {
    const restore = stubFetch({
      body: {
        outputs: [
          { name: 'EMBEDDING', shape: [2, 3], datatype: 'FP32', data: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] },
        ],
      },
    });
    try {
      const adapter = makeAdapter();
      const res = await adapter.generateEmbeddings({
        model: 'bge-base-en',
        input: ['first doc', 'second doc'],
      });

      // Wire path — URL-encoded model name in the KServe v2 path.
      expect(calls[0].url).toBe('http://localhost:8000/v2/models/bge-base-en/infer');

      const body = JSON.parse(String(calls[0].init.body));
      expect(body.inputs).toHaveLength(1);
      expect(body.inputs[0].name).toBe('TEXT');
      expect(body.inputs[0].datatype).toBe('BYTES');
      expect(body.inputs[0].shape).toEqual([2, 1]);
      expect(body.inputs[0].data).toEqual(['first doc', 'second doc']);

      // Flat data length 6 reshaped into 2 rows of 3.
      expect(res.data).toHaveLength(2);
      expect(res.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
      expect(res.data[1].embedding).toEqual([0.4, 0.5, 0.6]);
      // Index preserved in response order.
      expect(res.data[0].index).toBe(0);
      expect(res.data[1].index).toBe(1);
    } finally {
      restore();
    }
  });

  it('accepts a single string input and wraps it into a batch of 1', async () => {
    const restore = stubFetch({
      body: { outputs: [{ name: 'EMBEDDING', shape: [1, 4], datatype: 'FP32', data: [1, 2, 3, 4] }] },
    });
    try {
      const adapter = makeAdapter();
      const res = await adapter.generateEmbeddings({
        model: 'e5-base-v2',
        input: 'solo string',
      });
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.inputs[0].shape).toEqual([1, 1]);
      expect(body.inputs[0].data).toEqual(['solo string']);
      expect(res.data).toHaveLength(1);
      expect(res.data[0].embedding).toEqual([1, 2, 3, 4]);
    } finally {
      restore();
    }
  });

  it('honors inputTensorName override for non-standard models', async () => {
    const restore = stubFetch({
      body: { outputs: [{ name: 'EMB', shape: [1, 2], datatype: 'FP32', data: [0.5, 0.5] }] },
    });
    try {
      const adapter = makeAdapter({ inputTensorName: 'input_ids' });
      await adapter.generateEmbeddings({
        model: 'custom-bert',
        input: ['hello'],
      });
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.inputs[0].name).toBe('input_ids');
    } finally {
      restore();
    }
  });

  it('URL-encodes model names with special characters', async () => {
    const restore = stubFetch({
      body: { outputs: [{ name: 'E', shape: [1, 1], datatype: 'FP32', data: [0] }] },
    });
    try {
      const adapter = makeAdapter();
      await adapter.generateEmbeddings({ model: 'family/model:v1', input: ['x'] });
      expect(calls[0].url).toContain('/v2/models/family%2Fmodel%3Av1/infer');
    } finally {
      restore();
    }
  });

  it('sends Authorization: Bearer only when apiKey is non-empty', async () => {
    const restore = stubFetch({
      body: { outputs: [{ name: 'E', shape: [1, 1], datatype: 'FP32', data: [0] }] },
    });
    try {
      const noAuth = makeAdapter({ apiKey: '' });
      await noAuth.generateEmbeddings({ model: 'm', input: ['x'] });
      const hdrsNoAuth = (calls[0].init.headers as Record<string, string>) ?? {};
      expect(hdrsNoAuth.Authorization).toBeUndefined();

      calls = [];
      const withAuth = makeAdapter({ apiKey: 'proxy-token' });
      await withAuth.generateEmbeddings({ model: 'm', input: ['x'] });
      const hdrs = (calls[0].init.headers as Record<string, string>) ?? {};
      expect(hdrs.Authorization).toBe('Bearer proxy-token');
    } finally {
      restore();
    }
  });
});

describe('TritonAdapter — shape integrity guards', () => {
  it('throws when output batch size mismatches input batch size', async () => {
    const restore = stubFetch({
      // Asked for 3 strings; server returned 2 rows worth of data.
      body: { outputs: [{ name: 'E', shape: [2, 4], datatype: 'FP32', data: [1, 2, 3, 4, 5, 6, 7, 8] }] },
    });
    try {
      const adapter = makeAdapter();
      await expect(
        adapter.generateEmbeddings({ model: 'm', input: ['a', 'b', 'c'] }),
      ).rejects.toThrow(/batch.*mismatch/i);
    } finally {
      restore();
    }
  });

  it('throws when output data length != batch × dim', async () => {
    const restore = stubFetch({
      // Shape says [2, 3] = 6 values expected, only 5 provided.
      body: { outputs: [{ name: 'E', shape: [2, 3], datatype: 'FP32', data: [1, 2, 3, 4, 5] }] },
    });
    try {
      const adapter = makeAdapter();
      await expect(
        adapter.generateEmbeddings({ model: 'm', input: ['a', 'b'] }),
      ).rejects.toThrow(/data length.*batch/i);
    } finally {
      restore();
    }
  });

  it('throws when response lacks outputs entirely', async () => {
    const restore = stubFetch({ body: { not_outputs: [] } });
    try {
      const adapter = makeAdapter();
      await expect(
        adapter.generateEmbeddings({ model: 'm', input: ['a'] }),
      ).rejects.toThrow(/missing outputs/);
    } finally {
      restore();
    }
  });

  it('throws on HTTP error with truncated body snippet for diagnostics', async () => {
    const restore = stubFetch({ ok: false, status: 503, body: { error: 'model warming up' } });
    try {
      const adapter = makeAdapter();
      await expect(
        adapter.generateEmbeddings({ model: 'm', input: ['a'] }),
      ).rejects.toThrow(/Triton HTTP 503.*model warming up/);
    } finally {
      restore();
    }
  });

  it('rejects empty input before hitting the wire', async () => {
    const sentinel = { called: 0 };
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      sentinel.called++;
      return Promise.resolve({ ok: false, status: 500 } as Response);
    }) as unknown as typeof fetch;
    try {
      const adapter = makeAdapter();
      await expect(
        adapter.generateEmbeddings({ model: 'm', input: [] }),
      ).rejects.toThrow(/non-empty/);
      expect(sentinel.called).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects missing model', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.generateEmbeddings({ model: '', input: ['a'] }),
    ).rejects.toThrow(/model is required/);
  });
});

describe('TritonAdapter — chat surfaces', () => {
  it('throws explicit not-supported error for chatCompletion', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.chatCompletion({ model: 'any', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/chat completion not supported/);
  });
});

describe('TritonAdapter — model discovery', () => {
  it('POSTs /v2/repository/index and returns READY models', async () => {
    const restore = stubFetch((url) => {
      if (url.endsWith('/v2/repository/index')) {
        return {
          body: [
            { name: 'bge-base-en', state: 'READY' },
            { name: 'bge-large-en', state: 'UNAVAILABLE' },
            { name: 'e5-base-v2', state: 'READY' },
            { name: 'no-state-model' }, // No state → treated as usable.
          ],
        };
      }
      return { body: {} };
    });
    try {
      const adapter = makeAdapter();
      const models = await adapter.getModels();
      const names = models.map((m) => m.name);
      expect(names).toContain('bge-base-en');
      expect(names).toContain('e5-base-v2');
      expect(names).toContain('no-state-model');
      expect(names).not.toContain('bge-large-en');
    } finally {
      restore();
    }
  });

  it('returns empty catalog (not throw) when the index endpoint 500s', async () => {
    const restore = stubFetch({ ok: false, status: 500, body: { error: 'down' } });
    try {
      const adapter = makeAdapter();
      const models = await adapter.getModels();
      expect(models).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe('TritonAdapter — health check', () => {
  it('is healthy when /v2/health/ready returns 200', async () => {
    const restore = stubFetch({ ok: true, status: 200, body: {} });
    try {
      const adapter = makeAdapter();
      const h = await adapter.healthCheck();
      expect(h.healthy).toBe(true);
      expect(calls[0].url).toBe('http://localhost:8000/v2/health/ready');
    } finally {
      restore();
    }
  });

  it('is unhealthy on non-2xx', async () => {
    const restore = stubFetch({ ok: false, status: 503, body: {} });
    try {
      const adapter = makeAdapter();
      const h = await adapter.healthCheck();
      expect(h.healthy).toBe(false);
      expect(h.error).toMatch(/503/);
    } finally {
      restore();
    }
  });
});

describe('TritonAdapter — identity', () => {
  it('providerName is "triton"', () => {
    const adapter = makeAdapter();
    expect((adapter as unknown as { name: string }).name).toBe('triton');
    expect(adapter.displayName).toBe('NVIDIA Triton');
  });
});
