// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for BflAdapter.
 *
 * The full submit→poll→download dance is exercised against a stubbed `fetch`
 * to validate the wire orchestration without hitting BFL. Static behaviors
 * (model allowlist, image-only refusal) are asserted directly.
 *
 * Why the stub vs an integration test: BFL jobs are minutes-long even on the
 * fastest models, and integration tests would gate CI on network reachability
 * + a live API key. The wire-level behaviors we care about (per-model URL,
 * x-key header, polling loop until non-pending status, signed-URL download)
 * are deterministic and worth pinning here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BflAdapter } from '@/providers/bfl/bfl-adapter';

describe('BflAdapter', () => {
  describe('static behavior', () => {
    it('isFluxModel accepts only documented FLUX ids', () => {
      expect(BflAdapter.isFluxModel('flux-pro-1.1')).toBe(true);
      expect(BflAdapter.isFluxModel('flux-dev')).toBe(true);
      expect(BflAdapter.isFluxModel('flux-pro-1.1-ultra')).toBe(true);
      expect(BflAdapter.isFluxModel('flux-mystery-9000')).toBe(false);
      expect(BflAdapter.isFluxModel('gpt-4')).toBe(false);
    });

    it('returns 5 static models with correct capability tagging', async () => {
      const adapter = new BflAdapter({ apiKey: 'test', name: 'bfl', enabled: true });
      const models = await adapter.getModels();
      expect(models).toHaveLength(5);

      const ultra = models.find((m) => m.id === 'flux-pro-1.1-ultra');
      expect(ultra?.capabilities).toContain('image_generation');
      expect(ultra?.capabilities).toContain('image_editing');

      const dev = models.find((m) => m.id === 'flux-dev');
      expect(dev?.capabilities).toContain('image_generation');
      expect(dev?.capabilities).not.toContain('image_editing');
    });
  });

  describe('image-only surface', () => {
    let adapter: BflAdapter;
    beforeEach(() => {
      adapter = new BflAdapter({ apiKey: 'test', name: 'bfl', enabled: true });
    });

    it('throws on chatCompletion with the BFL-is-image-only message', async () => {
      await expect(
        adapter.chatCompletion({ messages: [], model: 'flux-pro' } as never),
      ).rejects.toThrow(/image-only/i);
    });

    it('throws on generateEmbeddings', async () => {
      await expect(adapter.generateEmbeddings({ input: 'x', model: 'x' } as never)).rejects.toThrow(
        /image-only/i,
      );
    });

    it('throws on imageVariation', async () => {
      await expect(
        adapter.imageVariation({} as never, { image: Buffer.from(''), n: 1 } as never),
      ).rejects.toThrow(/imageVariation not supported/);
    });

    it('rejects unknown models on imageGenerate', async () => {
      await expect(
        adapter.imageGenerate(
          { id: 'flux-fake', name: 'flux-fake' } as never,
          { prompt: 'cat', n: 1 } as never,
        ),
      ).rejects.toThrow(/unknown model flux-fake/);
    });

    it('rejects edit on a non-edit-capable model', async () => {
      await expect(
        adapter.imageEdit(
          { id: 'flux-dev', name: 'flux-dev' } as never,
          { image: Buffer.from(''), prompt: 'edit', n: 1 } as never,
        ),
      ).rejects.toThrow(/imageEdit not supported on flux-dev/);
    });
  });

  describe('imageGenerate wire orchestration', () => {
    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
      vi.restoreAllMocks();
    });

    it('submits to /v1/<model>, polls until Ready, downloads sample, returns Buffer', async () => {
      const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
      let pollCount = 0;
      const mockSample = 'https://cdn.bfl.ai/signed/abc.png';
      const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic

      global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method || 'GET';
        calls.push({
          url,
          method,
          headers: (init?.headers as Record<string, string>) ?? {},
        });

        // 1. Submit
        if (url.endsWith('/flux-pro-1.1') && method === 'POST') {
          return new Response(
            JSON.stringify({ id: 'job-123', polling_url: 'https://api.bfl.ai/v1/get_result?id=job-123' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        // 2. Poll — first call returns Pending, second returns Ready.
        if (url.includes('get_result') && method === 'GET') {
          pollCount += 1;
          if (pollCount === 1) {
            return new Response(JSON.stringify({ status: 'Pending' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(
            JSON.stringify({ status: 'Ready', result: { sample: mockSample } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        // 3. Download
        if (url === mockSample && method === 'GET') {
          return new Response(imageBytes, { status: 200 });
        }

        return new Response('not found', { status: 404 });
      }) as typeof global.fetch;

      const adapter = new BflAdapter({
        apiKey: 'sk-test',
        name: 'bfl',
        enabled: true,
        // Tighten the polling budget so the test is fast.
        pollIntervalMs: 1,
        pollMaxAttempts: 5,
      } as never);

      const out = await adapter.imageGenerate(
        { id: 'flux-pro-1.1', name: 'flux-pro-1.1' } as never,
        { prompt: 'a friendly fox', size: '1024x1024', n: 1 } as never,
      );

      expect(Buffer.isBuffer(out.image)).toBe(true);
      expect(out.format).toBe('png');
      expect((out as { raw?: { id?: string } }).raw?.id).toBe('job-123');

      // Wire-level assertions: per-model URL, x-key header, three calls in order.
      expect(calls[0].url).toBe('https://api.bfl.ai/v1/flux-pro-1.1');
      expect(calls[0].method).toBe('POST');
      expect(calls[0].headers['x-key']).toBe('sk-test');
      expect(calls[1].url).toContain('get_result');
      expect(calls[2].url).toContain('get_result'); // second poll returns Ready
      expect(calls[3].url).toBe(mockSample);
      // Total requests: 1 submit + 2 polls + 1 download.
      expect(calls).toHaveLength(4);
    });

    it('throws when the job ends in non-Ready terminal status', async () => {
      global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method || 'GET';
        if (url.endsWith('/flux-pro') && method === 'POST') {
          return new Response(
            JSON.stringify({ id: 'job-bad', polling_url: 'https://api.bfl.ai/v1/get_result?id=job-bad' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('get_result')) {
          return new Response(
            JSON.stringify({ status: 'Content Moderated', error: 'prompt rejected by safety filter' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      }) as typeof global.fetch;

      const adapter = new BflAdapter({
        apiKey: 'sk-test',
        name: 'bfl',
        enabled: true,
        pollIntervalMs: 1,
        pollMaxAttempts: 5,
      } as never);

      await expect(
        adapter.imageGenerate(
          { id: 'flux-pro', name: 'flux-pro' } as never,
          { prompt: 'naughty', n: 1 } as never,
        ),
      ).rejects.toThrow(/Content Moderated.*prompt rejected/);
    });
  });
});
