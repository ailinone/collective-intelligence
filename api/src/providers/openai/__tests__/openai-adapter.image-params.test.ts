// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for OpenAI image-generation parameter negotiation.
 *
 * Live-traffic finding (LOTE AN). `POST /v1/images/generations` declares schema
 * defaults for `response_format`, `quality` and `style`, so those fields reach
 * the adapter on essentially every request. The `gpt-image-*` family rejects
 * them, and the rejections arrive ONE AT A TIME:
 *
 *   400 Unknown parameter: 'response_format'.
 *   400 Unknown parameter: 'style'.
 *   400 Invalid value: 'standard'. Supported values are: 'low', 'medium', 'high', and 'auto'.
 *
 * Note the third message names only the VALUE, never the field — so the field
 * has to be recovered from what was actually sent. Without that, image
 * generation on gpt-image-* is impossible regardless of credentials.
 *
 * The adapter must negotiate all of this inside a single caller request, and
 * must carry no hardcoded per-model parameter table.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIAdapter } from '@/providers/openai/openai-adapter';
import type { Model } from '@/types';

type GenArgs = Record<string, unknown>;

function apiError(message: string, status = 400): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

const IMAGE_B64 = Buffer.from('fake-png-bytes').toString('base64');

function buildAdapter(impl: (args: GenArgs) => unknown) {
  const calls: GenArgs[] = [];
  const adapter = new OpenAIAdapter({ apiKey: 'test-key', maxRetries: 0 });
  const generate = vi.fn(async (args: GenArgs) => {
    calls.push({ ...args });
    return impl(args);
  });
  const stub = { images: { generate } };
  (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => stub;
  return { adapter, calls, generate };
}

const MODEL = { id: 'gpt-image-1', name: 'gpt-image-1' } as unknown as Model;

/** Request shaped the way the route delivers it, i.e. with all defaults filled in. */
const REQUEST = {
  prompt: 'a plain solid red square',
  size: '1024x1024',
  options: { n: 1, quality: 'standard', responseFormat: 'b64_json', style: 'vivid' },
} as never;

describe('OpenAIAdapter.imageGenerate — parameter negotiation', () => {
  beforeEach(() => {
    (
      OpenAIAdapter as unknown as { unsupportedImageParams: Map<string, Set<string>> }
    ).unsupportedImageParams.clear();
  });

  it('sends the optional parameters when the model accepts them', async () => {
    const { adapter, calls } = buildAdapter(() => ({ data: [{ b64_json: IMAGE_B64 }] }));
    await adapter.imageGenerate(MODEL, REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: 'gpt-image-1',
      response_format: 'b64_json',
      style: 'vivid',
      quality: 'standard',
    });
  });

  it('peels off every rejected parameter within a single request', async () => {
    // Reproduces the exact live sequence observed against api.openai.com.
    const { adapter, calls } = buildAdapter((args) => {
      if ('response_format' in args) throw apiError("400 Unknown parameter: 'response_format'.");
      if ('style' in args) throw apiError("400 Unknown parameter: 'style'.");
      if (args.quality === 'standard') {
        throw apiError(
          "400 Invalid value: 'standard'. Supported values are: 'low', 'medium', 'high', and 'auto'."
        );
      }
      return { data: [{ b64_json: IMAGE_B64 }] };
    });

    const result = await adapter.imageGenerate(MODEL, REQUEST);

    expect(result.image).toBeInstanceOf(Buffer);
    expect(calls).toHaveLength(4);
    const final = calls[calls.length - 1];
    expect('response_format' in final).toBe(false);
    expect('style' in final).toBe(false);
    expect('quality' in final).toBe(false);
    // The parameters that carry the caller's actual intent must survive.
    expect(final).toMatchObject({ model: 'gpt-image-1', prompt: REQUEST.prompt, size: '1024x1024' });
  });

  it('recovers the field name from an Invalid value message that names only the value', async () => {
    const { adapter, calls } = buildAdapter((args) => {
      if (args.quality === 'standard') {
        throw apiError(
          "400 Invalid value: 'standard'. Supported values are: 'low', 'medium', 'high', and 'auto'."
        );
      }
      return { data: [{ b64_json: IMAGE_B64 }] };
    });

    await adapter.imageGenerate(MODEL, REQUEST);
    expect('quality' in calls[calls.length - 1]).toBe(false);
    // Only `quality` is dropped — the other defaults are untouched.
    expect(calls[calls.length - 1]).toMatchObject({ response_format: 'b64_json', style: 'vivid' });
  });

  it('remembers rejections so later requests start clean', async () => {
    const { adapter, calls } = buildAdapter((args) => {
      if ('response_format' in args) throw apiError("400 Unknown parameter: 'response_format'.");
      return { data: [{ b64_json: IMAGE_B64 }] };
    });

    await adapter.imageGenerate(MODEL, REQUEST);
    const afterFirst = calls.length;
    await adapter.imageGenerate(MODEL, REQUEST);

    // Second request must not repeat the probe.
    expect(calls.length - afterFirst).toBe(1);
    expect('response_format' in calls[calls.length - 1]).toBe(false);
  });

  it('propagates errors that are not parameter problems', async () => {
    const { adapter } = buildAdapter(() => {
      throw apiError('429 You have no credits remaining.', 429);
    });
    await expect(adapter.imageGenerate(MODEL, REQUEST)).rejects.toBeDefined();
  });

  it('propagates a 400 that blames no droppable parameter', async () => {
    const { adapter, generate } = buildAdapter(() => {
      throw apiError('400 Your prompt was rejected by the safety system.');
    });
    await expect(adapter.imageGenerate(MODEL, REQUEST)).rejects.toBeDefined();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('never drops prompt or model, even if the vendor names them', async () => {
    // Guards a subtle matcher bug: the droppable set contains `n`, so a bare
    // substring test would match the "n" inside "unknown parameter: 'prompt'"
    // and silently strip `n` from the payload. The field name must be matched
    // as the QUOTED token.
    const { adapter, calls } = buildAdapter(() => {
      throw apiError("400 Unknown parameter: 'prompt'.");
    });
    await expect(adapter.imageGenerate(MODEL, REQUEST)).rejects.toBeDefined();
    // `prompt` is not droppable, so no retry was attempted.
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe(REQUEST.prompt);
    expect(calls[0].model).toBe('gpt-image-1');
  });
});
