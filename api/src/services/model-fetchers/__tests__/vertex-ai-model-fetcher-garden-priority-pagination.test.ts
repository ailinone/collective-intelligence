// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for the 2026-09-14 Vertex AI Model Garden priority +
 * pagination fix.
 *
 * ## Finding A (priority)
 *
 * `fetchModelsFromGoogleAPI` used to check `this.apiKey` BEFORE
 * `this.projectId`, so whenever both were configured (as they are in
 * production — `<prefix>-vertex-key` + `<prefix>-vertex-project-id`, passed
 * together from central-model-discovery-service.ts) the apiKey branch
 * (Google AI Studio, native Gemini only) always won and Model Garden
 * (Anthropic/Meta/etc. foundation models) was never even attempted.
 * Confirmed live 2026-09-14: the apiKey endpoint returns models with zero
 * matches for claude|anthropic|llama|meta.
 *
 * projectId/Model Garden is now tried FIRST when both are present, with a
 * fallback to apiKey/Google AI Studio on ANY Model Garden failure (gcloud
 * auth failure, or the HTTP call itself failing) so the reorder cannot
 * regress the apiKey-only behavior that already worked.
 *
 * ## Finding B (pagination)
 *
 * Neither branch used to follow `nextPageToken`, silently capping every
 * provider at whatever fit on page 1. Confirmed live 2026-09-14 against the
 * real `<prefix>-vertex-key` secret: the Google AI Studio endpoint returns 50
 * models plus a non-empty `nextPageToken` on page 1, and a further 6 models
 * (56 total) on page 2 with no further token. Both branches now page via
 * `fetchAllPages` until `nextPageToken` is absent, capped at
 * `MAX_PAGINATION_PAGES` (20) as a safety net.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
}));

vi.mock('node-fetch', () => ({
  default: (...args: unknown[]) => mocks.fetch(...args),
}));

import { VertexAIModelFetcher } from '@/services/model-fetchers/vertex-ai-model-fetcher';

type Internals = {
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
};

/** Fakes the gcloud child process `executeGcloudCommand` spawns and reads. */
function mockGcloud(result: { token?: string; stderr?: string; exitCode?: number }): void {
  mocks.spawn.mockImplementation(() => {
    const closeHandlers: Array<(code: number | null) => void> = [];
    const proc = {
      stdout: {
        on: (_event: string, cb: (data: Buffer) => void) => {
          if (result.token) cb(Buffer.from(result.token));
        },
      },
      stderr: {
        on: (_event: string, cb: (data: Buffer) => void) => {
          if (result.stderr) cb(Buffer.from(result.stderr));
        },
      },
      on: (event: string, cb: (code: number | null) => void) => {
        if (event === 'close') closeHandlers.push(cb);
      },
    };
    queueMicrotask(() => {
      const code = result.exitCode ?? (result.stderr ? 1 : 0);
      closeHandlers.forEach((cb) => cb(code));
    });
    return proc;
  });
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
  mocks.fetch.mockReset();
});

describe('VertexAIModelFetcher — projectId (Model Garden) takes priority over apiKey', () => {
  it('tries Model Garden first when both apiKey and projectId are configured, and never calls Google AI Studio when it succeeds', async () => {
    mockGcloud({ token: 'fake-access-token' });

    mocks.fetch.mockImplementation(async (url: string) => {
      if (
        url.includes('aiplatform.googleapis.com') &&
        url.includes('/publishers') &&
        !url.includes('/publishers/')
      ) {
        return jsonResponse(200, { publishers: [{ name: 'publishers/anthropic' }] });
      }
      if (url.includes('/publishers/anthropic/models')) {
        return jsonResponse(200, {
          publisherModels: [{ name: 'publishers/anthropic/models/claude-3-5-sonnet' }],
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const fetcher = new VertexAIModelFetcher({ apiKey: 'ai-studio-key', projectId: 'my-project' });
    const models = await fetcher.getModels();

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('claude-3-5-sonnet');
    expect(models[0]?.metadata?.source).toBe('vertex-ai-model-garden');

    const calledUrls = mocks.fetch.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.some((u) => u.includes('aiplatform.googleapis.com'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('generativelanguage.googleapis.com'))).toBe(false);
  });

  it('falls back to apiKey/Google AI Studio when gcloud auth fails (missing roles/aiplatform.user)', async () => {
    mockGcloud({ stderr: 'ERROR: (gcloud.auth) You do not have permission', exitCode: 1 });

    mocks.fetch.mockImplementation(async (url: string) => {
      expect(url).toContain('generativelanguage.googleapis.com');
      expect(url).toContain('key=ai-studio-key');
      return jsonResponse(200, { models: [{ name: 'models/gemini-2.5-flash' }] });
    });

    const fetcher = new VertexAIModelFetcher({ apiKey: 'ai-studio-key', projectId: 'my-project' });
    const models = await fetcher.getModels();

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('gemini-2.5-flash');
    expect(models[0]?.metadata?.source).toBe('google-ai-api');
    // Only the Google AI Studio endpoint should ever have been reached.
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to apiKey/Google AI Studio when the Model Garden HTTP call itself fails (not just gcloud auth)', async () => {
    // gcloud succeeds (a token IS obtained) but the actual Vertex AI call
    // 403s - this is the reordered path the operator explicitly flagged as
    // needing coverage ("ajuste se necessário pra também cobrir esse
    // caminho reordenado").
    mockGcloud({ token: 'fake-access-token' });

    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.includes('aiplatform.googleapis.com')) {
        return jsonResponse(403, { error: { message: 'Permission denied' } });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return jsonResponse(200, { models: [{ name: 'models/gemini-2.5-pro' }] });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const fetcher = new VertexAIModelFetcher({ apiKey: 'ai-studio-key', projectId: 'my-project' });
    const models = await fetcher.getModels();

    expect(models).toHaveLength(1);
    expect(models[0]?.metadata?.source).toBe('google-ai-api');
  });

  it('returns [] (no fallback) when Model Garden fails and no apiKey is configured', async () => {
    mockGcloud({ stderr: 'no credentials', exitCode: 1 });
    // Explicit '' (not omitted) beats tests/test-env.ts's global
    // VERTEX_AI_API_KEY mock default: `config?.apiKey ?? process.env...`
    // only falls through to the env var on null/undefined, never on ''.
    const fetcher = new VertexAIModelFetcher({ apiKey: '', projectId: 'my-project' });
    const models = await fetcher.getModels();
    expect(models).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('uses Google AI Studio directly when only apiKey is configured (no projectId)', async () => {
    mocks.fetch.mockImplementation(async (url: string) => {
      expect(url).toContain('generativelanguage.googleapis.com');
      return jsonResponse(200, { models: [{ name: 'models/gemini-2.5-flash' }] });
    });

    // Explicit '' (not omitted) beats tests/test-env.ts's global
    // VERTEX_AI_PROJECT_ID mock default (same '' vs undefined nuance as
    // the apiKey case above).
    const fetcher = new VertexAIModelFetcher({ apiKey: 'ai-studio-key', projectId: '' });
    const models = await fetcher.getModels();
    expect(models).toHaveLength(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe('VertexAIModelFetcher — pagination follows nextPageToken until exhausted', () => {
  it('collects models across multiple pages on the Google AI Studio branch (mirrors the live 50+6=56 confirmation)', async () => {
    mocks.fetch.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      const pageToken = parsed.searchParams.get('pageToken');
      if (!pageToken) {
        return jsonResponse(200, {
          models: [{ name: 'models/gemini-a' }, { name: 'models/gemini-b' }],
          nextPageToken: 'page-2-token',
        });
      }
      if (pageToken === 'page-2-token') {
        return jsonResponse(200, { models: [{ name: 'models/gemini-c' }] });
      }
      throw new Error(`Unexpected pageToken ${pageToken}`);
    });

    const fetcher = new VertexAIModelFetcher({ apiKey: 'ai-studio-key', projectId: '' });
    const models = await fetcher.getModels();

    expect(models.map((m) => m.id)).toEqual(['gemini-a', 'gemini-b', 'gemini-c']);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('stops after MAX_PAGINATION_PAGES (20) and logs a WARN when nextPageToken never runs out', async () => {
    let page = 0;
    mocks.fetch.mockImplementation(async () => {
      page += 1;
      return jsonResponse(200, {
        models: [{ name: `models/gemini-page-${page}` }],
        nextPageToken: `token-${page}`,
      });
    });

    const fetcher = new VertexAIModelFetcher({ apiKey: 'ai-studio-key', projectId: '' });
    const warnSpy = vi.spyOn((fetcher as unknown as Internals).log, 'warn');
    const models = await fetcher.getModels();

    expect(mocks.fetch).toHaveBeenCalledTimes(20);
    expect(models).toHaveLength(20);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pages: 20 }),
      expect.stringMatching(/safety cap of 20 pages/i)
    );
  });

  it('paginates the Model Garden publishers list too, and accepts the documented `publisherModels` field name', async () => {
    mockGcloud({ token: 'fake-access-token' });

    mocks.fetch.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/publishers')) {
        const pageToken = parsed.searchParams.get('pageToken');
        if (!pageToken) {
          return jsonResponse(200, {
            publishers: [{ name: 'publishers/google' }],
            nextPageToken: 'publishers-page-2',
          });
        }
        return jsonResponse(200, { publishers: [{ name: 'publishers/anthropic' }] });
      }
      if (parsed.pathname.includes('/publishers/google/models')) {
        return jsonResponse(200, {
          publisherModels: [{ name: 'publishers/google/models/gemini-3.1-pro' }],
        });
      }
      if (parsed.pathname.includes('/publishers/anthropic/models')) {
        return jsonResponse(200, {
          publisherModels: [{ name: 'publishers/anthropic/models/claude-3-5-sonnet' }],
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const fetcher = new VertexAIModelFetcher({ apiKey: '', projectId: 'my-project' });
    const models = await fetcher.getModels();

    expect(models.map((m) => m.id).sort()).toEqual(['claude-3-5-sonnet', 'gemini-3.1-pro']);
  });
});
