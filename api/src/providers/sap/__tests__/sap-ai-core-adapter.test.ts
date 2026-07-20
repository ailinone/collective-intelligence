// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SapAiCoreAdapter — OAuth2 token provider injection, deployment_id routing,
 * AI-Resource-Group header.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SapAiCoreAdapter } from '../sap-ai-core-adapter';
import type { TokenProvider } from '../../_shared/token-provider';

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

function makeFakeTokenProvider(token = 'fake-oauth-token'): TokenProvider {
  return {
    getToken: async () => token,
    buildAuthHeader: async () => ({ Authorization: `Bearer ${token}` }),
    invalidate: () => {},
  };
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('SapAiCoreAdapter — config error surface', () => {
  it('reports CLIENT_ID missing in healthcheck', async () => {
    const adapter = new SapAiCoreAdapter({
      apiKey: '',
      clientId: '',
      clientSecret: 's',
      authUrl: 'https://idp/t',
    });
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/SAP_AI_CORE_CLIENT_ID/);
  });

  it('reports CLIENT_SECRET missing', async () => {
    const adapter = new SapAiCoreAdapter({
      apiKey: '',
      clientId: 'c',
      clientSecret: '',
      authUrl: 'https://idp/t',
    });
    const result = await adapter.healthCheck();
    expect(result.error).toMatch(/SAP_AI_CORE_CLIENT_SECRET/);
  });

  it('reports AUTH_URL missing', async () => {
    const adapter = new SapAiCoreAdapter({
      apiKey: '',
      clientId: 'c',
      clientSecret: 's',
      authUrl: '',
    });
    const result = await adapter.healthCheck();
    expect(result.error).toMatch(/SAP_AI_CORE_AUTH_URL/);
  });
});

describe('SapAiCoreAdapter — deployment map resolution', () => {
  it('rejects requests with no mapped deployment_id', async () => {
    const adapter = new SapAiCoreAdapter({
      apiKey: 'c',
      clientSecret: 's',
      authUrl: 'https://idp/t',
      deployments: { 'gpt-4o': 'd-abc' },
      tokenProviderFactory: () => makeFakeTokenProvider(),
    });
    await expect(
      adapter.chatCompletion({ model: 'unknown-model', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/no deployment_id mapped/);
  });

  it('getModels() returns deployment map keys', async () => {
    const adapter = new SapAiCoreAdapter({
      apiKey: 'c',
      clientSecret: 's',
      authUrl: 'https://idp/t',
      deployments: { 'gpt-4o': 'd-1', 'text-embed': 'd-2' },
      tokenProviderFactory: () => makeFakeTokenProvider(),
    });
    const models = await adapter.getModels();
    expect(models.map((m) => m.id).sort()).toEqual(['gpt-4o', 'text-embed']);
  });
});

describe('SapAiCoreAdapter — chatCompletion wire', () => {
  it('POSTs /v2/inference/deployments/{id}/chat/completions with AI-Resource-Group header', async () => {
    const restore = stubFetch({
      body: {
        id: 'sap-1',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
    });
    try {
      const adapter = new SapAiCoreAdapter({
        apiKey: 'c',
        clientSecret: 's',
        authUrl: 'https://idp/t',
        baseUrl: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com',
        deployments: { 'gpt-4o': 'd-abc-123' },
        resourceGroup: 'team-a',
        tokenProviderFactory: () => makeFakeTokenProvider('token-X'),
      });
      await adapter.chatCompletion({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(calls[0].url).toContain('/v2/inference/deployments/d-abc-123/chat/completions');
      expect(calls[0].url).toContain('api-version=');
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer token-X');
      expect(headers['AI-Resource-Group']).toBe('team-a');
      expect(headers['Content-Type']).toBe('application/json');
    } finally {
      restore();
    }
  });

  it('defaults resource group to "default"', async () => {
    const restore = stubFetch({
      body: { choices: [{ message: { content: 'y' } }] },
    });
    try {
      const adapter = new SapAiCoreAdapter({
        apiKey: 'c',
        clientSecret: 's',
        authUrl: 'https://idp/t',
        deployments: { m: 'd1' },
        tokenProviderFactory: () => makeFakeTokenProvider(),
      });
      await adapter.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers['AI-Resource-Group']).toBe('default');
    } finally {
      restore();
    }
  });
});

describe('SapAiCoreAdapter — embeddings wire', () => {
  it('routes to /embeddings path with the same resource group', async () => {
    const restore = stubFetch({
      body: { data: [{ embedding: [0.5, 0.6] }], usage: { total_tokens: 2 } },
    });
    try {
      const adapter = new SapAiCoreAdapter({
        apiKey: 'c',
        clientSecret: 's',
        authUrl: 'https://idp/t',
        deployments: { emb: 'd-emb' },
        tokenProviderFactory: () => makeFakeTokenProvider(),
      });
      const res = await adapter.generateEmbeddings({ model: 'emb', input: ['a', 'b'] });
      expect(res.data[0].embedding).toEqual([0.5, 0.6]);
      expect(calls[0].url).toContain('/v2/inference/deployments/d-emb/embeddings');
    } finally {
      restore();
    }
  });
});

describe('SapAiCoreAdapter — unsupported surfaces', () => {
  it('image surfaces refuse', async () => {
    const adapter = new SapAiCoreAdapter({
      apiKey: 'c',
      clientSecret: 's',
      authUrl: 'https://idp/t',
      deployments: { m: 'd' },
      tokenProviderFactory: () => makeFakeTokenProvider(),
    });
    const dummyModel = { id: 'm' } as never;
    await expect(adapter.imageGenerate(dummyModel, { prompt: 'x' })).rejects.toThrow(/not supported/);
  });
});
