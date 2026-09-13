// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ElevenLabsAdapter — Music generation wire contract tests (LOTE AX,
 * 2026-09-06), mirroring the existing TTS coverage pattern used across this
 * catalog (mocked `fetch`, request-shape + response-parsing assertions).
 *
 * Covers:
 *   - `generateMusic` REQUEST composition: `prompt` XOR `composition_plan`,
 *     `model_id`, `music_length_ms`, `force_instrumental`, `seed`, and the
 *     `output_format` query param — per docs.elevenlabs.io (`POST /v1/music`).
 *   - RESPONSE handling: raw audio bytes come back as a `Buffer`.
 *   - ERROR handling: neither `prompt` nor `compositionPlan` supplied; a
 *     non-2xx upstream response.
 *   - `getModels()` discovery: music models (`music_v1`/`music_v2`) are
 *     tagged `music_generation`, not `text_to_speech`, and survive even when
 *     the vendor reports `can_do_text_to_speech: false` for them.
 *
 * No live credentials needed — `fetch` is stubbed per test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsAdapter } from '../elevenlabs-adapter';
import type { Model } from '@/types';

const BASE = 'https://api.elevenlabs.io/v1';

type FetchCall = { url: string; init: RequestInit; body: Record<string, unknown> | undefined };
let calls: FetchCall[] = [];

/** Stub `fetch` to return a binary (audio) response for every call. */
function stubAudio(bytes: Uint8Array, opts: { ok?: boolean; status?: number; errorText?: string } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
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

/** Stub `fetch` to return a JSON `/v1/models` listing. */
function stubModelsJson(body: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    calls.push({ url: String(url), init: {}, body: undefined });
    return {
      ok: true,
      status: 200,
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

function makeAdapter(): ElevenLabsAdapter {
  return new ElevenLabsAdapter({
    apiKey: 'elevenlabs-test-key',
    baseUrl: BASE,
  });
}

function musicModelFixture(overrides: Partial<Model> = {}): Model {
  return {
    id: 'elevenlabs/music_v2',
    name: 'music_v2',
    displayName: 'ElevenLabs music_v2',
    provider: 'elevenlabs',
    providerId: 'elevenlabs',
    contextWindow: 0,
    maxOutputTokens: 0,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    status: 'active',
    capabilities: ['music_generation'],
    performance: { latencyMs: 0, throughput: 0, quality: 0.9, reliability: 0.9 },
    ...overrides,
  } as Model;
}

afterEach(() => {
  calls = [];
  vi.restoreAllMocks();
});

describe('ElevenLabsAdapter.generateMusic', () => {
  it('sends a prompt-based request with model_id and the output_format query param', async () => {
    const restore = stubAudio(new Uint8Array([1, 2, 3, 4]));
    try {
      const adapter = makeAdapter();
      const result = await adapter.generateMusic(musicModelFixture(), {
        prompt: 'An upbeat synthwave track for a product demo',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${BASE}/music?output_format=mp3_44100_128`);
      expect(calls[0].init.method).toBe('POST');
      expect(calls[0].body).toEqual({
        model_id: 'music_v2',
        prompt: 'An upbeat synthwave track for a product demo',
      });
      expect((calls[0].init.headers as Record<string, string>)['xi-api-key']).toBe(
        'elevenlabs-test-key'
      );

      expect(Buffer.isBuffer(result.audio)).toBe(true);
      expect(result.audio.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
      expect(result.format).toBe('mp3');
    } finally {
      restore();
    }
  });

  it('sends compositionPlan instead of prompt when both concepts are provided a plan', async () => {
    const restore = stubAudio(new Uint8Array([9]));
    try {
      const adapter = makeAdapter();
      const plan = { sections: [{ name: 'intro', duration_ms: 4000 }] };
      await adapter.generateMusic(musicModelFixture(), { compositionPlan: plan });

      expect(calls[0].body).toEqual({ model_id: 'music_v2', composition_plan: plan });
      // A composition plan request must never also carry a bare `prompt` key.
      expect(calls[0].body).not.toHaveProperty('prompt');
    } finally {
      restore();
    }
  });

  it('forwards musicLengthMs, forceInstrumental and seed onto the request body', async () => {
    const restore = stubAudio(new Uint8Array([0]));
    try {
      const adapter = makeAdapter();
      await adapter.generateMusic(musicModelFixture(), {
        prompt: 'Calm ambient pad',
        musicLengthMs: 60000,
        forceInstrumental: true,
        seed: 42,
      });

      expect(calls[0].body).toEqual({
        model_id: 'music_v2',
        prompt: 'Calm ambient pad',
        music_length_ms: 60000,
        force_instrumental: true,
        seed: 42,
      });
    } finally {
      restore();
    }
  });

  it('throws when neither prompt nor compositionPlan is supplied', async () => {
    const adapter = makeAdapter();
    await expect(adapter.generateMusic(musicModelFixture(), {})).rejects.toThrow(
      /prompt or compositionPlan is required/i
    );
    expect(calls).toHaveLength(0);
  });

  it('throws with the upstream status and body on a non-2xx response', async () => {
    const restore = stubAudio(new Uint8Array([]), {
      ok: false,
      status: 402,
      errorText: '{"detail":"music generation requires a paid subscription"}',
    });
    try {
      const adapter = makeAdapter();
      await expect(
        adapter.generateMusic(musicModelFixture(), { prompt: 'test' })
      ).rejects.toThrow(/402/);
    } finally {
      restore();
    }
  });
});

describe('ElevenLabsAdapter.getModels — music model discovery', () => {
  it('tags music_v1/music_v2 as music_generation, not text_to_speech', async () => {
    const restore = stubModelsJson([
      { model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true },
      { model_id: 'music_v2', name: 'Music v2', can_do_text_to_speech: false },
    ]);
    try {
      const adapter = makeAdapter();
      const models = await adapter.getModels();

      const tts = models.find((m) => m.name === 'eleven_multilingual_v2');
      const music = models.find((m) => m.name === 'music_v2');

      expect(tts?.capabilities).toEqual(['text_to_speech', 'streaming']);
      expect(music).toBeDefined();
      expect(music?.capabilities).toEqual(['music_generation']);
      expect(music?.displayName).toContain('Music');
    } finally {
      restore();
    }
  });

  it('does not drop a discovered music model even though can_do_text_to_speech is false', async () => {
    const restore = stubModelsJson([
      { model_id: 'music_v1', name: 'Music v1', can_do_text_to_speech: false },
      { model_id: 'music_v2', name: 'Music v2', can_do_text_to_speech: false },
    ]);
    try {
      const adapter = makeAdapter();
      const models = await adapter.getModels();
      // Both music_v1 (real) and music_v2 (real) are present in the fixture,
      // so no pinned entries need to be appended.
      expect(models).toHaveLength(2);
      expect(models.every((m) => m.capabilities.includes('music_generation'))).toBe(true);
    } finally {
      restore();
    }
  });

  it('appends the pinned music_v1/music_v2 fallback when GET /v1/models omits them entirely', async () => {
    // Live-verified 2026-09-06: ElevenLabs' real GET /v1/models response
    // lists only TTS/STS models — music_v1/music_v2 never appear. This
    // fixture is that real shape (trimmed).
    const restore = stubModelsJson([
      { model_id: 'eleven_v3', name: 'Eleven v3', can_do_text_to_speech: true },
      { model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true },
      { model_id: 'eleven_english_sts_v2', name: 'English STS v2', can_do_text_to_speech: false },
    ]);
    try {
      const adapter = makeAdapter();
      const models = await adapter.getModels();
      const musicModels = models.filter((m) => m.capabilities.includes('music_generation'));

      expect(musicModels.map((m) => m.name).sort()).toEqual(['music_v1', 'music_v2']);
      for (const m of musicModels) {
        expect(m.metadata?.pinnedFallback).toBe(true);
        expect(m.metadata?.pinnedFallbackReason).toBe('no-list-endpoint');
      }
    } finally {
      restore();
    }
  });

  it('does not duplicate a pinned music model the vendor already lists', async () => {
    const restore = stubModelsJson([
      { model_id: 'music_v2', name: 'Music v2 (now listed)', can_do_text_to_speech: false },
    ]);
    try {
      const adapter = makeAdapter();
      const models = await adapter.getModels();
      const musicModels = models.filter((m) => m.name === 'music_v2');
      // Exactly one row — the discovered one, not a duplicate pinned entry —
      // and music_v1 still gets pinned since it's genuinely absent.
      expect(musicModels).toHaveLength(1);
      expect(musicModels[0].metadata?.pinnedFallback).toBeUndefined();
      expect(models.some((m) => m.name === 'music_v1' && m.metadata?.pinnedFallback)).toBe(true);
    } finally {
      restore();
    }
  });
});
