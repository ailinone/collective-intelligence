// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CartesiaAdapter, auth header wire contract tests (2026-09-14).
 *
 * Root cause: `authHeaders()` sent `X-API-Key: ${apiKey}`, an undocumented
 * header. docs.cartesia.ai's reference for both `POST /tts/bytes` and
 * `GET /voices` (fetched 2026-09-14) documents `Authorization: Bearer
 * $CARTESIA_API_KEY` as the auth scheme. Live-verified against the real API
 * on 2026-09-14 with a production key (`GET /voices`): both header forms
 * currently return `200`, so `X-API-Key` wasn't actually broken, but it's
 * unofficial/undocumented behavior Cartesia could drop without notice.
 * `authHeaders()` now sends the documented `Authorization: Bearer` form.
 *
 * These tests pin that wire contract for both callers of `authHeaders()`:
 * `textToSpeech` (`POST /tts/bytes`) and `healthCheck` (`GET /voices`).
 *
 * No live credentials needed, `fetch` is stubbed per test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CartesiaAdapter } from '../cartesia-adapter';
import type { Model } from '@/types';

const BASE = 'https://api.cartesia.ai';
const API_KEY = 'cartesia-test-key';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];

/** Stub `fetch` to return a binary (audio) response for every call. */
function stubAudio(bytes: Uint8Array, opts: { ok?: boolean; status?: number; errorText?: string } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => opts.errorText ?? '',
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Stub `fetch` to return a JSON `/voices` listing (or an error status). */
function stubVoicesJson(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
      text: async () => JSON.stringify(body),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeAdapter(): CartesiaAdapter {
  return new CartesiaAdapter({ apiKey: API_KEY, baseUrl: BASE });
}

function ttsModelFixture(overrides: Partial<Model> = {}): Model {
  return {
    id: 'cartesia/sonic-3',
    name: 'sonic-3',
    displayName: 'Cartesia sonic-3 (TTS)',
    provider: 'cartesia',
    providerId: 'cartesia',
    contextWindow: 0,
    maxOutputTokens: 0,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    status: 'active',
    capabilities: ['text_to_speech', 'streaming'],
    performance: { latencyMs: 90, throughput: 0, quality: 0.95, reliability: 0.9 },
    ...overrides,
  } as Model;
}

afterEach(() => {
  calls = [];
  vi.restoreAllMocks();
});

describe('CartesiaAdapter, Authorization header', () => {
  it('textToSpeech sends Authorization: Bearer (not X-API-Key) to POST /tts/bytes', async () => {
    const restore = stubAudio(new Uint8Array([1, 2, 3, 4]));
    try {
      const adapter = makeAdapter();
      await adapter.textToSpeech(ttsModelFixture(), { text: 'Hello there', voice: 'alloy' });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${BASE}/tts/bytes`);
      expect(calls[0].init.method).toBe('POST');

      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(headers['Cartesia-Version']).toBe('2025-04-16');
      expect(headers).not.toHaveProperty('X-API-Key');
    } finally {
      restore();
    }
  });

  it('healthCheck sends Authorization: Bearer (not X-API-Key) to GET /voices', async () => {
    const restore = stubVoicesJson({ has_more: false, data: [] });
    try {
      const adapter = makeAdapter();
      const result = await adapter.healthCheck();

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${BASE}/voices`);

      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(headers['Cartesia-Version']).toBe('2025-04-16');
      expect(headers).not.toHaveProperty('X-API-Key');
      expect(result.healthy).toBe(true);
    } finally {
      restore();
    }
  });

  it('healthCheck reports unhealthy on a non-2xx /voices response', async () => {
    const restore = stubVoicesJson({ error: 'unauthorized' }, { ok: false, status: 401 });
    try {
      const adapter = makeAdapter();
      const result = await adapter.healthCheck();
      expect(result.healthy).toBe(false);
    } finally {
      restore();
    }
  });

  it('textToSpeech surfaces the upstream status on a non-2xx /tts/bytes response', async () => {
    const restore = stubAudio(new Uint8Array([]), {
      ok: false,
      status: 401,
      errorText: '{"error":"invalid api key"}',
    });
    try {
      const adapter = makeAdapter();
      await expect(
        adapter.textToSpeech(ttsModelFixture(), { text: 'test' })
      ).rejects.toThrow(/401/);
    } finally {
      restore();
    }
  });
});
