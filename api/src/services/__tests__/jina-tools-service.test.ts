// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JinaToolsService } from '@/services/jina-tools-service';

function setJinaTestEnv(): void {
  process.env.JINA_API_KEY = 'jina-test-key';
  process.env.JINA_API_BASE_URL = 'https://api.jina.test/v1';
  process.env.JINA_DEEPSEARCH_BASE_URL = 'https://deepsearch.jina.test/v1';
  process.env.JINA_READER_BASE_URL = 'https://r.jina.test';
  process.env.JINA_SEARCH_BASE_URL = 'https://s.jina.test';
  process.env.JINA_TOOLS_MAX_RETRIES = '2';
  process.env.JINA_TOOLS_RETRY_DELAY_MS = '50';
}

function clearJinaTestEnv(): void {
  delete process.env.JINA_API_KEY;
  delete process.env.JINA_API_BASE_URL;
  delete process.env.JINA_DEEPSEARCH_BASE_URL;
  delete process.env.JINA_READER_BASE_URL;
  delete process.env.JINA_SEARCH_BASE_URL;
  delete process.env.JINA_TOOLS_MAX_RETRIES;
  delete process.env.JINA_TOOLS_RETRY_DELAY_MS;
}

describe('JinaToolsService', () => {
  beforeEach(() => {
    clearJinaTestEnv();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    clearJinaTestEnv();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns 401 when JINA_API_KEY is missing', async () => {
    const service = new JinaToolsService();

    await expect(
      service.executeTool({
        toolName: 'reader',
        payload: { url: 'https://example.com' },
        toolCallId: 'tool_missing_key',
      })
    ).rejects.toMatchObject({
      statusCode: 401,
      code: 'unauthorized',
    });
  });

  it('retries on 429 and returns success on next attempt', async () => {
    setJinaTestEnv();

    const fetchMock = vi
      .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
      .mockResolvedValueOnce(
        new Response('rate_limited', {
          status: 429,
          headers: { 'retry-after': '0' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'ok' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    vi.stubGlobal('fetch', fetchMock);

    const service = new JinaToolsService();
    const result = await service.executeTool({
      toolName: 'search',
      payload: { query: 'jina test' },
      toolCallId: 'tool_retry',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://s.jina.test/?q=jina+test');
    expect(result.success).toBe(true);
    expect(result.metadata?.upstream_status).toBe(200);
    expect(result.output).toContain('"data"');
  });

  it('normalizes upstream errors with status and metadata', async () => {
    setJinaTestEnv();

    const fetchMock = vi
      .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
      .mockResolvedValue(
        new Response('resource missing', {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        })
      );

    vi.stubGlobal('fetch', fetchMock);

    const service = new JinaToolsService();

    await expect(
      service.executeTool({
        toolName: 'reader',
        payload: { url: 'https://example.com/missing' },
        toolCallId: 'tool_missing_resource',
      })
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'not_found',
      metadata: expect.objectContaining({
        upstream_status: 404,
      }),
    });
  });

  it('defaults deepsearch model when model is omitted', async () => {
    setJinaTestEnv();

    const fetchMock = vi
      .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'resp_1', choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    vi.stubGlobal('fetch', fetchMock);

    const service = new JinaToolsService();
    await service.executeTool({
      toolName: 'deepsearch',
      payload: {
        messages: [{ role: 'user', content: 'hello' }],
      },
      toolCallId: 'tool_deepsearch',
    });

    const call = fetchMock.mock.calls[0];
    const requestInit = call?.[1] as RequestInit | undefined;
    const body = requestInit?.body ? JSON.parse(requestInit.body as string) : null;

    expect(call?.[0]).toBe('https://deepsearch.jina.test/v1/chat/completions');
    expect(body?.model).toBe('jina-deepsearch-v1');
  });
});

