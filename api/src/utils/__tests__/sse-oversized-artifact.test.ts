// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test — production incident 2026-09-08.
 *
 * Real production error surfaced to an end user on https://ailin.chat after
 * "Gere uma imagem de um farol na costa ao por do sol." (Ailin¹ Auto,
 * default streaming chat UI):
 *
 *   400, message: Got more than 131072 bytes when reading:
 *   b'data: {"id":"media-stage-image_generation-1788868704571",
 *   "object":"chat.completion","created":178886...
 *
 * Root cause: the streaming media-generation redirect (chat-routes.ts)
 * returns the FULL non-streaming `ChatResponse` — including
 * `ailin_metadata.artifacts[].b64_json`, a raw base64-encoded image with no
 * upper bound below ~13.5MB (see orchestration-engine.ts's
 * `ARTIFACT_MAX_B64_CHARS`) — as a single SSE `data: {...}\n\n` line via
 * `sendSSEChunk`/`formatSSE`. `JSON.stringify` never inserts a literal
 * newline inside a string value, so the entire multi-hundred-KB payload
 * became one unbroken line. ailin-chat's backend proxies this stream with
 * Python's aiohttp (`chat/backend/ailin_chat/routers/openai.py`, registering
 * CI as an OpenAI-compatible provider); iterating a raw `aiohttp.StreamReader`
 * with `async for` calls `.readline()` under the hood
 * (`aiohttp.streams.StreamReader.__aiter__`), which raises
 * `aiohttp.http_exceptions.LineTooLong` — verbatim message format
 * `f"Got more than {limit} bytes when reading: {line!r}."` — once a line
 * exceeds its default 131072-byte `_high_water` mark (2x the 65536-byte
 * default `StreamReader` `limit`). Confirmed by reading aiohttp 3.13.5's
 * actual installed source (`streams.py`, `http_exceptions.py`) rather than
 * assumed.
 *
 * The fix is NOT to raise a buffer size (SSE is a line-oriented protocol; any
 * fixed limit is eventually exceeded by a big enough generated artifact) —
 * it is to never inline a base64 media payload into a single SSE line at
 * all. See `stripUnsafeInlineArtifacts` / `buildOversizedFallback` in
 * `../sse.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { ChatResponse, AilinMetadata, AilinArtifact } from '@/types';
import { formatSSE } from '../sse';

/** 131072 bytes — aiohttp `StreamReader`'s default `_high_water` mark, the
 *  exact threshold the real production incident tripped. Any fix must keep
 *  every emitted line safely under this, with margin. */
const AIOHTTP_LINE_TOO_LONG_THRESHOLD = 131_072;

function baseResponse(artifacts: AilinArtifact[]): ChatResponse {
  const metadata: AilinMetadata = { artifacts };
  return {
    id: `media-stage-image_generation-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'media-generator',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '[image generated — see ailin_metadata.artifacts[0]]' },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    ailin_metadata: metadata,
  };
}

function parseSSELine(line: string): { json: unknown; byteLength: number } {
  expect(line.startsWith('data: ')).toBe(true);
  expect(line.endsWith('\n\n')).toBe(true);
  const payload = line.slice('data: '.length, -2);
  return { json: JSON.parse(payload), byteLength: Buffer.byteLength(line, 'utf8') };
}

describe('formatSSE — never inlines an oversized artifact payload into one line', () => {
  it('reproduces the exact production shape and no longer overflows the aiohttp line limit', () => {
    // A real generated image easily produces a base64 string well past
    // 131072 bytes (128KiB) — this is ~180KB of base64, comfortably below
    // the 13.5MB ARTIFACT_MAX_B64_CHARS cap that would otherwise fail the
    // stage outright, i.e. squarely in the range that used to crash silently
    // downstream instead of anywhere ci's own tests would catch it.
    const hugeB64 = 'A'.repeat(180_000);
    const response = baseResponse([
      {
        modality: 'image',
        stage_name: 'image_generation',
        stage_index: 0,
        b64_json: hugeB64,
        mime_type: 'image/png',
        provider: 'openai',
        model: 'gpt-image-1',
        duration_ms: 1200,
      },
    ]);

    const line = formatSSE(response);
    const { json, byteLength } = parseSSELine(line);

    // The core regression assertion: this line must never again be big
    // enough to trip a line-based SSE reader like aiohttp's.
    expect(byteLength).toBeLessThan(AIOHTTP_LINE_TOO_LONG_THRESHOLD);

    const artifact = (json as ChatResponse).ailin_metadata as AilinMetadata;
    const outArtifact = artifact.artifacts?.[0];
    expect(outArtifact).toBeDefined();
    // The raw base64 must be gone from the wire — never delivered inline.
    expect(outArtifact?.b64_json).toBeUndefined();
    expect(JSON.stringify(outArtifact)).not.toContain(hugeB64);
    // Degradation must be explicit, not silent — the client can tell the
    // image was omitted rather than assuming generation produced nothing.
    expect(outArtifact?.error).toBeTruthy();
  });

  it('prefers a URL over an inline copy even when the inline copy is small (redundant-weight case)', () => {
    const response = baseResponse([
      {
        modality: 'image',
        stage_name: 'image_generation',
        stage_index: 0,
        url: 'https://cdn.example.com/generated/lighthouse.png',
        b64_json: 'small-but-redundant-base64==',
        mime_type: 'image/png',
      },
    ]);

    const { json } = parseSSELine(formatSSE(response));
    const outArtifact = ((json as ChatResponse).ailin_metadata as AilinMetadata).artifacts?.[0];
    expect(outArtifact?.url).toBe('https://cdn.example.com/generated/lighthouse.png');
    expect(outArtifact?.b64_json).toBeUndefined();
    // A URL-backed artifact was never the failure mode — no need to flag it.
    expect(outArtifact?.error).toBeUndefined();
  });

  it('leaves small, url-less artifacts untouched (no unnecessary degradation)', () => {
    const smallB64 = 'A'.repeat(500);
    const response = baseResponse([
      {
        modality: 'audio',
        stage_name: 'audio_generation',
        stage_index: 0,
        b64_json: smallB64,
        mime_type: 'audio/mp3',
      },
    ]);

    const { json } = parseSSELine(formatSSE(response));
    const outArtifact = ((json as ChatResponse).ailin_metadata as AilinMetadata).artifacts?.[0];
    expect(outArtifact?.b64_json).toBe(smallB64);
    expect(outArtifact?.error).toBeUndefined();
  });

  it('passes through chunks with no artifacts unchanged', () => {
    const response: ChatResponse = {
      id: 'chatcmpl-plain',
      object: 'chat.completion',
      created: 1700000000,
      model: 'auto',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop', logprobs: null },
      ],
    };
    const { json } = parseSSELine(formatSSE(response));
    expect(json).toEqual(response);
  });

  it('falls back to a safe degraded chunk when an oversized field survives artifact-stripping', () => {
    // Simulates a hypothetical future field growing unbounded (not the
    // artifact b64_json this incident was about) — the belt-and-suspenders
    // guard must still refuse to ship an oversized line rather than assuming
    // artifact-stripping is the only thing that can ever overflow a line.
    const response = baseResponse([
      {
        modality: 'image',
        stage_name: 'image_generation',
        stage_index: 0,
        url: 'https://cdn.example.com/img.png',
        revised_prompt: 'X'.repeat(200_000),
      },
    ]);

    const line = formatSSE(response);
    const { json, byteLength } = parseSSELine(line);
    expect(byteLength).toBeLessThan(AIOHTTP_LINE_TOO_LONG_THRESHOLD);
    const parsed = json as ChatResponse;
    expect(parsed.ailin_metadata).toBeUndefined();
    expect(parsed.choices[0].message?.content).toMatch(/too large/i);
  });

  it('never emits a line at or above the safe threshold across a range of artifact sizes', () => {
    for (const size of [70_000, 131_072, 500_000, 2_000_000]) {
      const response = baseResponse([
        {
          modality: 'image',
          stage_name: 'image_generation',
          stage_index: 0,
          b64_json: 'B'.repeat(size),
        },
      ]);
      const { byteLength } = parseSSELine(formatSSE(response));
      expect(byteLength).toBeLessThan(AIOHTTP_LINE_TOO_LONG_THRESHOLD);
    }
  });
});
