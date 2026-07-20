// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SnowflakeCortexAdapter — baseUrl resolution, JWT auth wire, chat/embed paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { SnowflakeCortexAdapter } from '../snowflake-cortex-adapter';

function makePemKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return privateKey;
}

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];

function stubFetch(response: { ok?: boolean; status?: number; body: unknown }) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const KEY_PEM = makePemKey(); // shared across tests; signing is deterministic given the input

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('SnowflakeCortexAdapter — baseUrl resolution', () => {
  it('uses explicit baseUrl when provided', () => {
    const adapter = new SnowflakeCortexAdapter({
      apiKey: 'x',
      baseUrl: 'https://custom.example.snowflakecomputing.com',
      account: 'a',
      user: 'u',
      privateKeyPem: KEY_PEM,
    });
    expect((adapter as unknown as { baseUrl: string }).baseUrl).toBe(
      'https://custom.example.snowflakecomputing.com',
    );
  });

  it('computes baseUrl from account when not explicit', () => {
    const adapter = new SnowflakeCortexAdapter({
      apiKey: 'x',
      account: 'myorg.myacc',
      user: 'u',
      privateKeyPem: KEY_PEM,
    });
    expect((adapter as unknown as { baseUrl: string }).baseUrl).toBe(
      'https://myorg-myacc.snowflakecomputing.com',
    );
  });

  it('falls back to placeholder when nothing is set', () => {
    const adapter = new SnowflakeCortexAdapter({
      apiKey: 'x',
      account: '',
      user: '',
      privateKeyPem: '',
    });
    expect((adapter as unknown as { baseUrl: string }).baseUrl).toBe(
      'https://snowflake.example.snowflakecomputing.com',
    );
  });
});

describe('SnowflakeCortexAdapter — healthcheck', () => {
  it('reports config error when account missing', async () => {
    const adapter = new SnowflakeCortexAdapter({
      apiKey: 'x',
      account: '',
      user: 'u',
      privateKeyPem: KEY_PEM,
    });
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/SNOWFLAKE_ACCOUNT/);
  });

  it('reports config error when key missing', async () => {
    const adapter = new SnowflakeCortexAdapter({
      apiKey: 'x',
      account: 'a',
      user: 'u',
      privateKeyPem: '',
    });
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/SNOWFLAKE_PRIVATE_KEY_PEM/);
  });

  it('reports healthy when signer constructs and mints a token', async () => {
    const adapter = new SnowflakeCortexAdapter({
      apiKey: 'x',
      account: 'a',
      user: 'u',
      privateKeyPem: KEY_PEM,
    });
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(true);
  });
});

describe('SnowflakeCortexAdapter — getModels (static catalog, no network)', () => {
  it('returns curated list without fetch', async () => {
    const sentinel = { count: 0 };
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      sentinel.count++;
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' } as Response);
    }) as unknown as typeof fetch;
    try {
      const adapter = new SnowflakeCortexAdapter({
        apiKey: 'x',
        account: 'a',
        user: 'u',
        privateKeyPem: KEY_PEM,
      });
      const models = await adapter.getModels();
      expect(models.length).toBeGreaterThan(10);
      expect(models.some((m) => m.id === 'mistral-large2')).toBe(true);
      expect(models.some((m) => m.id === 'snowflake-arctic-embed-m')).toBe(true);
      expect(sentinel.count).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('SnowflakeCortexAdapter — chatCompletion wire', () => {
  it('POSTs /api/v2/cortex/inference:complete with signed JWT', async () => {
    const restore = stubFetch({
      body: {
        id: 'cortex-1',
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    });
    try {
      const adapter = new SnowflakeCortexAdapter({
        apiKey: 'x',
        account: 'myacc',
        user: 'svc',
        privateKeyPem: KEY_PEM,
      });
      const res = await adapter.chatCompletion({
        model: 'mistral-large2',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.choices[0].message.content).toBe('hi');
      expect(calls[0].url).toBe(
        'https://myacc.snowflakecomputing.com/api/v2/cortex/inference:complete',
      );
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Bearer /);
      expect(headers['X-Snowflake-Authorization-Token-Type']).toBe('KEYPAIR_JWT');
    } finally {
      restore();
    }
  });

  it('rejects embedding models on chat surface', async () => {
    const adapter = new SnowflakeCortexAdapter({
      apiKey: 'x',
      account: 'a',
      user: 'u',
      privateKeyPem: KEY_PEM,
    });
    await expect(
      adapter.chatCompletion({
        model: 'e5-base-v2',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow(/embeddings-only/);
  });
});

describe('SnowflakeCortexAdapter — embeddings wire', () => {
  it('POSTs /api/v2/cortex/inference:embed with text array', async () => {
    const restore = stubFetch({
      body: {
        data: [{ embedding: [0.1, 0.2] }],
        usage: { total_tokens: 4 },
      },
    });
    try {
      const adapter = new SnowflakeCortexAdapter({
        apiKey: 'x',
        account: 'a',
        user: 'u',
        privateKeyPem: KEY_PEM,
      });
      const res = await adapter.generateEmbeddings({
        model: 'e5-base-v2',
        input: 'hello',
      });
      expect(res.data[0].embedding).toEqual([0.1, 0.2]);
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.text).toEqual(['hello']);
      expect(calls[0].url).toMatch(/inference:embed$/);
    } finally {
      restore();
    }
  });

  it('rejects chat model on embeddings surface', async () => {
    const adapter = new SnowflakeCortexAdapter({
      apiKey: 'x',
      account: 'a',
      user: 'u',
      privateKeyPem: KEY_PEM,
    });
    await expect(
      adapter.generateEmbeddings({ model: 'mistral-large2', input: 'x' }),
    ).rejects.toThrow(/not an embedding/);
  });
});

describe('SnowflakeCortexAdapter — unsupported surfaces', () => {
  it('image/moderation surfaces all refuse', async () => {
    const adapter = new SnowflakeCortexAdapter({
      apiKey: 'x',
      account: 'a',
      user: 'u',
      privateKeyPem: KEY_PEM,
    });
    const dummyModel = { id: 'm' } as never;
    await expect(adapter.imageGenerate(dummyModel, { prompt: 'x' })).rejects.toThrow(/not supported/);
    await expect(adapter.imageEdit(dummyModel, { image: Buffer.from([0]), prompt: 'x' })).rejects.toThrow(/not supported/);
  });
});
