// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * WatsonxAdapter — IAM token flow + wire contract tests.
 *
 * Exercises the IBM Cloud IAM token exchange, token cache, and the
 * watsonx.ai-shaped request body (model_id + project_id) against the documented
 * API surface. No live credentials needed — `fetch` is stubbed per route.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatsonxAdapter } from '../watsonx-adapter';

const BASE = 'https://us-south.ml.cloud.ibm.com';
const IAM_URL = 'https://iam.cloud.ibm.com/identity/token';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];

type RouteHandler = (url: string, init: RequestInit) => {
  ok?: boolean;
  status?: number;
  body: unknown;
};

function installFetchRouter(routes: Record<string, RouteHandler>) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const key = Object.keys(routes).find((k) => u.startsWith(k));
    if (!key) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: `no stub for ${u}` }),
        text: async () => `no stub for ${u}`,
      } as Response;
    }
    const result = routes[key](u, init ?? {});
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

function makeAdapter(
  opts: { projectId?: string; apiKey?: string } = {},
): WatsonxAdapter {
  return new WatsonxAdapter({
    apiKey: opts.apiKey ?? 'ibm-apikey-123',
    baseUrl: BASE,
    projectId: opts.projectId ?? 'project-abc',
  });
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('WatsonxAdapter — IAM token exchange', () => {
  it('POSTs grant_type=urn:ibm:params:oauth:grant-type:apikey with apikey body', async () => {
    const restore = installFetchRouter({
      [IAM_URL]: (_, init) => {
        // form-urlencoded body
        const bodyStr = String(init.body);
        expect(bodyStr).toContain('grant_type=urn%3Aibm%3Aparams%3Aoauth%3Agrant-type%3Aapikey');
        expect(bodyStr).toContain('apikey=ibm-apikey-123');
        return {
          body: { access_token: 'iam-access-1', expires_in: 3600, token_type: 'Bearer' },
        };
      },
    });
    try {
      const adapter = makeAdapter();
      const result = await adapter.healthCheck();
      expect(result.healthy).toBe(true);
      expect(calls[0].url).toBe(IAM_URL);
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    } finally {
      restore();
    }
  });

  it('caches the IAM token across calls (only one IAM hit)', async () => {
    const iamHits = { count: 0 };
    const restore = installFetchRouter({
      [IAM_URL]: () => {
        iamHits.count++;
        return {
          body: { access_token: 'cached-iam', expires_in: 3600, token_type: 'Bearer' },
        };
      },
      [`${BASE}/ml/v1/text/chat`]: () => ({
        body: {
          id: 'r1',
          model_id: 'meta-llama/llama-3-70b',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      }),
    });
    try {
      const adapter = makeAdapter();
      await adapter.chatCompletion({
        model: 'meta-llama/llama-3-70b',
        messages: [{ role: 'user', content: 'hi' }],
      });
      await adapter.chatCompletion({
        model: 'meta-llama/llama-3-70b',
        messages: [{ role: 'user', content: 'again' }],
      });
      expect(iamHits.count).toBe(1);
    } finally {
      restore();
    }
  });

  it('surfaces an unhealthy result when the IAM exchange fails', async () => {
    const restore = installFetchRouter({
      [IAM_URL]: () => ({
        ok: false,
        status: 401,
        body: { errorMessage: 'apikey invalid' },
      }),
    });
    try {
      const adapter = makeAdapter();
      const result = await adapter.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.error).toMatch(/IAM token HTTP 401/);
    } finally {
      restore();
    }
  });
});

describe('WatsonxAdapter — chat body shape (model_id + project_id + version)', () => {
  it('sends model_id and project_id and pins ?version=2024-05-31', async () => {
    const restore = installFetchRouter({
      [IAM_URL]: () => ({
        body: { access_token: 'tok', expires_in: 3600 },
      }),
      [`${BASE}/ml/v1/text/chat`]: (url, init) => {
        expect(url).toContain('version=2024-05-31');
        const body = JSON.parse(String(init.body));
        expect(body.model_id).toBe('meta-llama/llama-3-70b');
        expect(body.project_id).toBe('project-abc');
        expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
        return {
          body: {
            choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
            model_id: 'meta-llama/llama-3-70b',
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          },
        };
      },
    });
    try {
      const adapter = makeAdapter();
      const res = await adapter.chatCompletion({
        model: 'meta-llama/llama-3-70b',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.model).toBe('meta-llama/llama-3-70b');
    } finally {
      restore();
    }
  });

  it('refuses chat when projectId is missing', async () => {
    const adapter = new WatsonxAdapter({
      apiKey: 'ibm-apikey-123',
      baseUrl: BASE,
      projectId: '',
    });
    // Prevent accidental env-var leakage from masking the missing-projectId path.
    const prev = process.env.WATSONX_PROJECT_ID;
    delete process.env.WATSONX_PROJECT_ID;
    try {
      await expect(
        adapter.chatCompletion({
          model: 'x',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toThrow(/WATSONX_PROJECT_ID/);
    } finally {
      if (prev !== undefined) process.env.WATSONX_PROJECT_ID = prev;
    }
  });
});

describe('WatsonxAdapter — embeddings body shape', () => {
  it('sends inputs[] and model_id to /ml/v1/text/embeddings', async () => {
    const restore = installFetchRouter({
      [IAM_URL]: () => ({ body: { access_token: 'tok', expires_in: 3600 } }),
      [`${BASE}/ml/v1/text/embeddings`]: (url, init) => {
        expect(url).toContain('version=2024-05-31');
        const body = JSON.parse(String(init.body));
        expect(body.model_id).toBe('ibm/slate-30m-english-rtrvr');
        expect(body.project_id).toBe('project-abc');
        expect(body.inputs).toEqual(['a', 'b']);
        return {
          body: {
            results: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
            model_id: 'ibm/slate-30m-english-rtrvr',
          },
        };
      },
    });
    try {
      const adapter = makeAdapter();
      const res = await adapter.generateEmbeddings({
        model: 'ibm/slate-30m-english-rtrvr',
        input: ['a', 'b'],
      });
      expect(res.data).toHaveLength(2);
    } finally {
      restore();
    }
  });
});
