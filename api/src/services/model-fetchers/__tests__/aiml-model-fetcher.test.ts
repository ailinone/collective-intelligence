// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * AIML model fetcher — `type` field capability mapping (LOTE BA, 2026-09).
 *
 * Confirmed live production bug: AIML's real `/models` endpoint returns
 * `type` as a namespaced endpoint path (`openai/image-generations`,
 * `internal/video-generations/submit`, `openai/embeddings`, ...), not the
 * short form (`image`, `video`, `embedding`) the original
 * `TYPE_CAPABILITY_MAP` was written against. The exact-key lookup missed
 * every one of these live values and silently defaulted the model to
 * `['chat', 'text_generation']` — verified against production for ~600
 * models (270 video, 160 image, 90 tts, 45 stt, 30 embedding, 12 OCR, 4
 * image-editing rows all mislabelled as generic chat).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AimlModelFetcher } from '@/services/model-fetchers/aiml-model-fetcher';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function fetchWithType(type: string) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    jsonResponse({
      data: [{ id: `test-model-${type.replace(/[/]/g, '-')}`, type, info: {}, features: [] }],
    })
  );
  const fetcher = new AimlModelFetcher({ apiKey: 'live-key' });
  const models = await fetcher.getModels();
  expect(models).toHaveLength(1);
  return models[0];
}

describe('AimlModelFetcher — real AIML `type` values (LOTE BA)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('openai/image-generations → image_generation, not chat (160 models in prod)', async () => {
    const model = await fetchWithType('openai/image-generations');
    expect(model.capabilities).toContain('image_generation');
    expect(model.capabilities).not.toContain('chat');
    expect(model.capabilities).not.toContain('text_generation');
  });

  it('internal/video-generations/submit → video_generation, not chat (269 models in prod)', async () => {
    const model = await fetchWithType('internal/video-generations/submit');
    expect(model.capabilities).toContain('video_generation');
    expect(model.capabilities).not.toContain('chat');
  });

  it('internal/text-to-speech → text_to_speech/tts, not chat (87 models in prod)', async () => {
    const model = await fetchWithType('internal/text-to-speech');
    expect(model.capabilities).toContain('text_to_speech');
    expect(model.capabilities).toContain('tts');
    expect(model.capabilities).not.toContain('chat');
  });

  it('internal/speech-to-text/submit → speech_to_text/transcription, not chat (46 models in prod)', async () => {
    const model = await fetchWithType('internal/speech-to-text/submit');
    expect(model.capabilities).toContain('speech_to_text');
    expect(model.capabilities).toContain('transcription');
    expect(model.capabilities).not.toContain('chat');
  });

  it('openai/embeddings → embedding/embeddings, not chat (30 models in prod)', async () => {
    const model = await fetchWithType('openai/embeddings');
    expect(model.capabilities).toContain('embedding');
    expect(model.capabilities).toContain('embeddings');
    expect(model.capabilities).not.toContain('chat');
    expect(model.capabilities).not.toContain('function_calling');
  });

  it('openai/image-editing → image_editing + image_generation, not chat (4 models in prod)', async () => {
    const model = await fetchWithType('openai/image-editing');
    expect(model.capabilities).toContain('image_editing');
    expect(model.capabilities).toContain('image_generation');
    expect(model.capabilities).not.toContain('chat');
  });

  it('internal/optical-character-recognition → vision, not chat (12 models in prod)', async () => {
    const model = await fetchWithType('internal/optical-character-recognition');
    expect(model.capabilities).toContain('vision');
    expect(model.capabilities).not.toContain('chat');
  });

  it('internal/audio-generations/submit → audio/audio_generation, not chat (9 models in prod)', async () => {
    const model = await fetchWithType('internal/audio-generations/submit');
    expect(model.capabilities).toContain('audio');
    expect(model.capabilities).toContain('audio_generation');
    expect(model.capabilities).not.toContain('chat');
  });

  it('openai/chat-completions → chat (480 models in prod; still correct after the fix)', async () => {
    const model = await fetchWithType('openai/chat-completions');
    expect(model.capabilities).toContain('chat');
    expect(model.capabilities).toContain('text_generation');
  });

  it('openai/responses/submit → chat + tool_use + function_calling (81 models in prod)', async () => {
    const model = await fetchWithType('openai/responses/submit');
    expect(model.capabilities).toContain('chat');
    expect(model.capabilities).toContain('tool_use');
    expect(model.capabilities).toContain('function_calling');
  });

  it('short-form legacy type values still map correctly (backward compatibility)', async () => {
    const image = await fetchWithType('image');
    expect(image.capabilities).toContain('image_generation');

    const tts = await fetchWithType('tts');
    expect(tts.capabilities).toContain('text_to_speech');

    const embedding = await fetchWithType('embedding');
    expect(embedding.capabilities).toContain('embedding');
  });

  it('a genuinely unclassifiable type still falls back to chat (no false confidence)', async () => {
    const model = await fetchWithType('anthropic/batches-cancel');
    expect(model.capabilities).toContain('chat');
    expect(model.capabilities).toContain('text_generation');
  });
});

/**
 * `info.contextLength` / `info.outputMax` field-name bug (2026-09).
 *
 * Live-verified against `curl https://api.aimlapi.com/models`: the real
 * response nests `contextLength`/`outputMax` (camelCase) under `info`, e.g.
 * `anthropic/claude-sonnet-4.6` → `{ contextLength: 200000, outputMax: 64000 }`
 * and `amazon/nova-2-lite-v1` → `{ contextLength: 1000000, outputMax: 65535 }`.
 * The fetcher previously read `info.context_length`/`info.max_tokens`
 * (snake_case), which never exists in the live payload — every one of
 * AIML's ~937 catalog models fell back to the generic 8192/4096 defaults
 * regardless of the model's real, vendor-published context window.
 *
 * Also verified live: the raw payload never carries any price field under
 * any name (`price`, `cost`, `pricing`, ...) outside free-text descriptions
 * — pricing is intentionally left at `{0, 0}` ("unknown", not "free"),
 * never guessed from a heuristic.
 */
describe('AimlModelFetcher — info.contextLength/outputMax field names (2026-09)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the real camelCase contextLength/outputMax fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'anthropic/claude-sonnet-4.6',
            type: 'openai/chat-completions',
            info: { name: 'Claude 4.6 Sonnet', contextLength: 200000, outputMax: 64000 },
            features: [],
          },
        ],
      })
    );
    const fetcher = new AimlModelFetcher({ apiKey: 'live-key' });
    const [model] = await fetcher.getModels();
    expect(model.contextWindow).toBe(200000);
    expect(model.maxOutputTokens).toBe(64000);
  });

  it('falls back to the generic defaults only when info is genuinely empty (not on every model)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: 'openai/gpt-6-astra', type: 'openai/chat-completions', info: {}, features: [] }],
      })
    );
    const fetcher = new AimlModelFetcher({ apiKey: 'live-key' });
    const [model] = await fetcher.getModels();
    expect(model.contextWindow).toBe(8192);
    expect(model.maxOutputTokens).toBe(4096);
  });

  it('still accepts legacy snake_case field names defensively', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'legacy/example',
            type: 'openai/chat-completions',
            info: { context_length: 32768, max_tokens: 8192 },
            features: [],
          },
        ],
      })
    );
    const fetcher = new AimlModelFetcher({ apiKey: 'live-key' });
    const [model] = await fetcher.getModels();
    expect(model.contextWindow).toBe(32768);
    expect(model.maxOutputTokens).toBe(8192);
  });

  it('never fabricates a price — pricing stays {0, 0} even when context/output are known', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'anthropic/claude-sonnet-4.6',
            type: 'openai/chat-completions',
            info: { contextLength: 200000, outputMax: 64000 },
            features: [],
          },
        ],
      })
    );
    const fetcher = new AimlModelFetcher({ apiKey: 'live-key' });
    const [model] = await fetcher.getModels();
    expect(model.pricing).toEqual({ inputCostPer1M: 0, outputCostPer1M: 0, currency: 'USD' });
  });
});
