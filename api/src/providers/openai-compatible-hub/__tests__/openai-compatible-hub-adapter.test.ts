// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleHubAdapter } from '@/providers/openai-compatible-hub/openai-compatible-hub-adapter';
import { getModelsByProvider } from '@/services/model-catalog-service';

vi.mock('@/services/model-catalog-service', () => ({
  getModelsByProvider: vi.fn(),
}));

const mockedGetModelsByProvider = vi.mocked(getModelsByProvider);

function createAdapter(): OpenAICompatibleHubAdapter {
  return new OpenAICompatibleHubAdapter({
    name: 'orqai',
    providerName: 'orqai',
    apiKey: 'test-key',
    baseUrl: 'https://api.orq.ai/v2/router',
    enabled: true,
  });
}

function buildCatalogModel(name: string): any {
  return {
    id: name,
    provider: 'orqai',
    name,
    displayName: name,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat'],
    performance: {
      latencyMs: 500,
      throughput: 100,
      quality: 0.8,
      reliability: 0.9,
    },
    status: 'active',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('openai-compatible-hub-adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes provider@model to provider/model', async () => {
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('alibaba@qvq-max')]);
    const adapter = createAdapter();

    const normalized = await adapter.normalizeModelName('alibaba@qvq-max');

    expect(normalized).toBe('alibaba/qvq-max');
  });

  it('normalizes hub-prefixed provider@model requests', async () => {
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('alibaba@qvq-max')]);
    const adapter = createAdapter();

    const normalized = await adapter.normalizeModelName('orqai/alibaba@qvq-max');

    expect(normalized).toBe('alibaba/qvq-max');
  });

  it('sends canonical provider/model in chat completion payload', async () => {
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('alibaba@qvq-max')]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'alibaba/qvq-max',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'pong' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const adapter = createAdapter();

    await adapter.chatCompletion({
      model: 'alibaba@qvq-max',
      messages: [{ role: 'user', content: 'ping' }],
    } as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const payload =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    expect(payload.model).toBe('alibaba/qvq-max');
  });

  it('forwards extra headers (Friendli team) for OpenAI-compatible hubs', async () => {
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('friendli-1')]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-friendli',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'friendli-1',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const adapter = new OpenAICompatibleHubAdapter({
      name: 'friendli',
      providerName: 'friendli',
      apiKey: 'friendli-test-key',
      baseUrl: 'https://api.friendli.ai/serverless/v1',
      enabled: true,
      metadata: {
        extraHeaders: {
          'X-Friendli-Team': 'team-id-fixture',
        },
      },
    });

    await adapter.chatCompletion({
      model: 'friendli-1',
      messages: [{ role: 'user', content: 'ping' }],
    } as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['X-Friendli-Team']).toBe('team-id-fixture');
  });

  it('maps provider/model to bare id when hub catalog exposes bare IDs', async () => {
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('gpt-4o-mini')]);
    const adapter = new OpenAICompatibleHubAdapter({
      name: 'heliconeai',
      providerName: 'heliconeai',
      apiKey: 'test-key',
      baseUrl: 'https://ai-gateway.helicone.ai/v1',
      enabled: true,
    });

    const normalized = await adapter.normalizeModelName('openai/gpt-4o-mini');
    expect(normalized).toBe('gpt-4o-mini');
  });

  it('sends canonical provider/model in video generation payload', async () => {
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('google@veo-3-fast')]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: 'video-1', url: 'https://cdn.example.com/video-1.mp4' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const adapter = createAdapter();

    const response = await adapter.videoGenerate(
      { id: 'google@veo-3-fast', name: 'google@veo-3-fast' } as any,
      {
        prompt: 'A cinematic sunrise over mountains',
        startImage: 'https://example.com/start.png',
        endImage: 'https://example.com/end.png',
        video: 'https://example.com/source.mp4',
        options: { n: 2, response_format: 'url' },
      } as any
    );

    expect(response.video).toEqual([{ id: 'video-1', url: 'https://cdn.example.com/video-1.mp4' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/videos/generations');
    const payload =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    expect(payload.model).toBe('google/veo-3-fast');
    expect(payload.start_image).toBe('https://example.com/start.png');
    expect(payload.end_image).toBe('https://example.com/end.png');
    expect(payload.video).toBe('https://example.com/source.mp4');
    expect(payload.n).toBe(2);
  });

  it('retries transient 429 errors and succeeds', async () => {
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('gpt-4o-mini')]);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: 'rate limit exceeded' },
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '0',
            },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'chatcmpl-retry',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'gpt-4o-mini',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const adapter = new OpenAICompatibleHubAdapter({
      name: 'heliconeai',
      providerName: 'heliconeai',
      apiKey: 'test-key',
      baseUrl: 'https://ai-gateway.helicone.ai/v1',
      enabled: true,
      maxRetries: 1,
      retryDelay: 1,
    });

    const response = await adapter.chatCompletion({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'ping' }],
    } as any);

    expect(response.id).toBe('chatcmpl-retry');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry terminal 429 insufficient credit errors', async () => {
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('gpt-4o-mini')]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: 'Insufficient credits' },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const adapter = new OpenAICompatibleHubAdapter({
      name: 'heliconeai',
      providerName: 'heliconeai',
      apiKey: 'test-key',
      baseUrl: 'https://ai-gateway.helicone.ai/v1',
      enabled: true,
      maxRetries: 3,
      retryDelay: 1,
    });

    await expect(
      adapter.chatCompletion({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
      } as any)
    ).rejects.toThrow('HTTP 429');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry terminal 429 daily rate limit errors', async () => {
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('gpt-4o-mini')]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: 'Daily rate limit exceeded. Maximum of 50 requests allowed per day.' },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const adapter = new OpenAICompatibleHubAdapter({
      name: 'heliconeai',
      providerName: 'heliconeai',
      apiKey: 'test-key',
      baseUrl: 'https://ai-gateway.helicone.ai/v1',
      enabled: true,
      maxRetries: 3,
      retryDelay: 1,
    });

    await expect(
      adapter.chatCompletion({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
      } as any)
    ).rejects.toThrow('HTTP 429');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to next dynamic catalog model when first model fails with provider auth', async () => {
    mockedGetModelsByProvider.mockResolvedValue([
      {
        ...buildCatalogModel('alibaba@qvq-max'),
        inputCostPer1k: 0.0001,
      },
      {
        ...buildCatalogModel('openai/gpt-4o-mini'),
        inputCostPer1k: 0.0002,
      },
    ]);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: 'Incorrect API key provided for upstream provider' },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'chatcmpl-fallback',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'openai/gpt-4o-mini',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const adapter = createAdapter();
    const response = await adapter.chatCompletion({
      messages: [{ role: 'user', content: 'ping' }],
    } as any);

    expect(response.id).toBe('chatcmpl-fallback');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const firstPayload = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    const secondPayload = JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body));
    expect(firstPayload.model).toBe('alibaba/qvq-max');
    expect(secondPayload.model).toBe('openai/gpt-4o-mini');
  });

  it('sends multimodal payload for vision requests', async () => {
    mockedGetModelsByProvider.mockResolvedValue([buildCatalogModel('openai/gpt-4o-mini')]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-vision',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'openai/gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'looks good' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const adapter = createAdapter();
    const response = await adapter.vision(
      { id: 'openai/gpt-4o-mini', name: 'openai/gpt-4o-mini' } as any,
      {
        prompt: 'Describe image',
        image: 'https://example.com/image.png',
      } as any
    );

    expect(response.content).toBe('looks good');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const payload =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    expect(messages.length).toBe(1);
  });

  it('calls audio speech endpoint for tts', async () => {
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('openai/gpt-4o-mini')]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(Uint8Array.from([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      })
    );

    const adapter = createAdapter();
    const response = await adapter.textToSpeech(
      { id: 'openai/gpt-4o-mini', name: 'openai/gpt-4o-mini' } as any,
      { text: 'hello', format: 'mp3' } as any
    );

    expect(response.audio.length).toBe(4);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/audio/speech');
  });

  it('calls images edits endpoint for image editing', async () => {
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('openai/gpt-image-1')]);
    const imageBytes = Buffer.from('edited-image');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ b64_json: imageBytes.toString('base64') }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const adapter = createAdapter();
    const response = await adapter.imageEdit(
      { id: 'openai/gpt-image-1', name: 'openai/gpt-image-1' } as any,
      {
        image: Buffer.from('source-image'),
        prompt: 'Remove the background',
        size: '1024x1024',
        n: 1,
        response_format: 'b64_json',
      } as any
    );

    expect(response.image.equals(imageBytes)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/images/edits');

    const body = init.body as FormData;
    expect(body.get('model')).toBe('openai/gpt-image-1');
    expect(body.get('prompt')).toBe('Remove the background');
    expect(body.get('size')).toBe('1024x1024');
    expect(body.get('response_format')).toBe('b64_json');
    expect(body.get('image')).toBeInstanceOf(File);
  });

  it('calls images variations endpoint for image variation', async () => {
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('openai/gpt-image-1')]);
    const imageBytes = Buffer.from('variant-image');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ b64_json: imageBytes.toString('base64') }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const adapter = createAdapter();
    const response = await adapter.imageVariation(
      { id: 'openai/gpt-image-1', name: 'openai/gpt-image-1' } as any,
      {
        image: Buffer.from('source-image'),
        size: '1024x1024',
        n: 1,
        response_format: 'b64_json',
      } as any
    );

    expect(response.image.equals(imageBytes)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/images/variations');

    const body = init.body as FormData;
    expect(body.get('model')).toBe('openai/gpt-image-1');
    expect(body.get('size')).toBe('1024x1024');
    expect(body.get('response_format')).toBe('b64_json');
    expect(body.get('image')).toBeInstanceOf(File);
  });

  it('surfaces non-JSON error bodies without "Body is unusable" regression (Phase 6 Fix 3)', async () => {
    // Phase 6 runtime evidence (docs/phase-6-runtime-evidence-2026-04-30.md):
    // parseErrorPayload was `try response.json() catch response.text()`. When the
    // hub returned a non-JSON error body (e.g. an HTML 502 page from an edge
    // proxy), `response.json()` consumed the body before throwing JSON.parse,
    // so the catch-branch `response.text()` immediately threw "Body is unusable:
    // Body has already been read" — hiding the actual HTTP status and triggering
    // a retry storm. The fix reads the body ONCE as text, then parses in memory.
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('gpt-4o-mini')]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const adapter = new OpenAICompatibleHubAdapter({
      name: 'heliconeai',
      providerName: 'heliconeai',
      apiKey: 'test-key',
      baseUrl: 'https://ai-gateway.helicone.ai/v1',
      enabled: true,
      maxRetries: 0,
      retryDelay: 1,
    });

    let captured: Error | undefined;
    try {
      await adapter.chatCompletion({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
      } as any);
    } catch (e) {
      captured = e as Error;
    }

    expect(captured).toBeDefined();
    // The real HTTP status must surface in the error message.
    expect(captured!.message).toMatch(/HTTP 502/);
    // The body-reuse marker must NOT appear — that's the regression we guard.
    expect(captured!.message).not.toMatch(/Body (is unusable|has already been read)/);
    // Single attempt — non-retried because maxRetries=0.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('parses JSON error bodies normally without losing structure (Phase 6 Fix 3 — no regression)', async () => {
    // Companion to the body-reuse test: confirms the JSON-shaped error path
    // (the hot path for OpenAI-compat hubs) still produces the canonical
    // JSON.stringify-roundtripped payload string in the surfaced error.
    mockedGetModelsByProvider.mockResolvedValueOnce([buildCatalogModel('gpt-4o-mini')]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: 'Internal upstream failure', type: 'server_error' } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const adapter = new OpenAICompatibleHubAdapter({
      name: 'heliconeai',
      providerName: 'heliconeai',
      apiKey: 'test-key',
      baseUrl: 'https://ai-gateway.helicone.ai/v1',
      enabled: true,
      maxRetries: 0,
      retryDelay: 1,
    });

    let captured: Error | undefined;
    try {
      await adapter.chatCompletion({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
      } as any);
    } catch (e) {
      captured = e as Error;
    }

    expect(captured).toBeDefined();
    expect(captured!.message).toMatch(/HTTP 503/);
    // JSON should be re-serialised (canonical form) — both keys present.
    expect(captured!.message).toContain('Internal upstream failure');
    expect(captured!.message).toContain('server_error');
    expect(captured!.message).not.toMatch(/Body (is unusable|has already been read)/);
  });
});
