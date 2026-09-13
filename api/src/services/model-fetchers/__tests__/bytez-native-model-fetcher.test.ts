// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Bytez native fetcher — zero-headroom cap regression (2026-09-08).
 *
 * WHY THIS EXISTS
 * ────────────────
 * This session's standing mandate: no part of the system may assume a fixed
 * catalog size, since the real catalog is expected to keep growing. An audit
 * found `maxModels` here defaulted to `100000` — exactly at parity with this
 * file's own header comment describing Bytez's "~100k model surface". A cap
 * set at parity with the documented catalog size has zero headroom: the
 * moment Bytez's real surface grows even slightly past the estimate that
 * produced that figure, `list.slice(0, maxModels)` on this fetcher's single
 * unpaginated response starts silently dropping the tail with no signal —
 * the exact same bug shape fixed in the HF Hub fetcher's 60,000-model cap
 * (hf-hub-model-fetcher.ts), which made 97% of huggingface's zero-capability
 * backlog permanently unreachable once the live catalog outgrew it.
 *
 * As of 2026-09-08 the live catalog was still 0 rows, so this was preemptive
 * rather than a reaction to an observed truncation — the point was to not
 * ship the same landmine a second time, and to make a future truncation loud
 * (warn-level log) instead of silent. (2026-09-09 update: the 0-rows symptom
 * was root-caused to an auth header format mismatch, NOT a missing key — see
 * the class-level doc comment in bytez-native-model-fetcher.ts and the
 * 'sends the bare-token Authorization header' test below.)
 *
 * These tests fail on the pre-fix 100,000 parity cap / info-only logging and
 * pass on the fix.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BytezNativeModelFetcher } from '@/services/model-fetchers/bytez-native-model-fetcher';

vi.mock('@/utils/logger', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  // `child` itself is a plain function (NOT vi.fn()-wrapped): the fetcher's
  // constructor calls logger.child(...) once and stores the result, so this
  // factory must keep returning the same object across the whole file. A
  // vi.fn() wrapper here would get its implementation wiped by the
  // `vi.restoreAllMocks()` in afterEach (used below to reset the fetch spy),
  // which would make logger.child(...) return undefined after the first
  // test and crash every fetcher instantiated afterward.
  return { logger: { child: () => child, ...child } };
});

// Import after the mock so we get the same child-logger instance the fetcher uses.
import { logger } from '@/utils/logger';
const mockLog = logger.child();

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bytezModel(modelId: string, task = 'text-generation') {
  return { modelId, task };
}

describe('bytez-native-model-fetcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('maxModels ceiling (zero-headroom-at-parity landmine)', () => {
    it('the default ceiling no longer truncates at the old 100,000 parity cap', async () => {
      // Reproduces the shape at a scale vitest can run quickly: a single
      // response with 100,001 models — one past the OLD default (100,000).
      // The old default would have silently sliced off the last model. We
      // assert the OLD landmine (100,000) does not reproduce, not the new
      // literal number, so this isn't a change-detector test.
      const COUNT = 100001;
      const output = Array.from({ length: COUNT }, (_, i) => bytezModel(`org/model-${i}`));
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: null, output }));

      const models = await new BytezNativeModelFetcher('live-key').getModels();

      expect(models).toHaveLength(COUNT);
      expect(models.length).toBeGreaterThan(100000);
      expect(mockLog.warn).not.toHaveBeenCalled();
    });

    it('an explicit maxModels override is still honored (the safety valve stays configurable)', async () => {
      const output = Array.from({ length: 10 }, (_, i) => bytezModel(`org/model-${i}`));
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: null, output }));

      const fetcher = new BytezNativeModelFetcher(
        'live-key',
        'https://api.bytez.com/models/v2/list/models',
        5
      );
      const models = await fetcher.getModels();

      expect(models).toHaveLength(5);
    });

    it('logs a warning (not just info) when a run actually hits the cap', async () => {
      const output = Array.from({ length: 10 }, (_, i) => bytezModel(`org/model-${i}`));
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: null, output }));

      const fetcher = new BytezNativeModelFetcher(
        'live-key',
        'https://api.bytez.com/models/v2/list/models',
        5
      );
      await fetcher.getModels();

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ capped: true, received: 10, emitted: 5 }),
        expect.stringContaining('BYTEZ_DISCOVERY_MAX_MODELS')
      );
      expect(mockLog.info).not.toHaveBeenCalledWith(
        expect.anything(),
        'Bytez native discovery completed'
      );
    });

    // Scale-target headroom guard (2026-09-09): the REAL production default
    // (no constructor override, no BYTEZ_DISCOVERY_MAX_MODELS env var) must
    // still accommodate at least 150,000 models — the platform's near/mid-term
    // catalog target. Fails immediately if a future change ever lowers the
    // default back toward (or below) that floor.
    it('the real default (no override) does not truncate at 150,000 models (scale-target headroom)', async () => {
      const COUNT = 150001;
      const output = Array.from({ length: COUNT }, (_, i) => bytezModel(`org/model-${i}`));
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: null, output }));

      const models = await new BytezNativeModelFetcher('live-key').getModels();

      expect(models).toHaveLength(COUNT);
      expect(models.length).toBeGreaterThan(150000);
      expect(mockLog.warn).not.toHaveBeenCalled();
    });

    it('logs at info (not warn) when the cap is not hit', async () => {
      const output = Array.from({ length: 3 }, (_, i) => bytezModel(`org/model-${i}`));
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: null, output }));

      await new BytezNativeModelFetcher(
        'live-key',
        'https://api.bytez.com/models/v2/list/models',
        5
      ).getModels();

      expect(mockLog.warn).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ capped: false }),
        'Bytez native discovery completed'
      );
    });
  });

  it('skips discovery when the key is missing or looks like a mock/test key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(await new BytezNativeModelFetcher('').getModels()).toEqual([]);
    expect(await new BytezNativeModelFetcher('sk-test-mock-123').getModels()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the bare-token Authorization header (no "Bearer " prefix) per Bytez native-endpoint docs', async () => {
    // Root cause of the 2026-09 production 0-models incident: this endpoint
    // (unlike the OAI-compat chat/embeddings endpoints elsewhere in the
    // codebase) documents `Authorization: <token>` with no scheme prefix.
    // Sending `Bearer <token>` here previously produced HTTP 500 on most
    // discovery cycles and HTTP 200 with an empty catalog on the rest.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: null, output: [] }));

    await new BytezNativeModelFetcher('live-key-value').getModels();

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'live-key-value' }),
      })
    );
  });

  it('returns empty and warns on a non-OK response instead of throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({}, 500));

    const models = await new BytezNativeModelFetcher('live-key').getModels();

    expect(models).toEqual([]);
  });

  it('captures and logs the response body on a non-OK response (2026-09-10 visibility fix)', async () => {
    // Root cause investigation of the 2026-09 production "Bytez native list
    // non-OK" incident was blocked for a full day because the prior code
    // only logged `{ status: response.status }` — a bare number with no
    // detail on WHY the vendor rejected the request. A live re-probe found
    // the real body is a small, always-present JSON error object
    // (`{"error":"...","output":[]}`), so capturing it is cheap and turns a
    // future 500 into something actionable straight from the log line
    // instead of requiring a manual live probe against the vendor API.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ error: 'Expected parameter(s): modelId', output: [] }, 500)
    );

    const models = await new BytezNativeModelFetcher('live-key').getModels();

    expect(models).toEqual([]);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 500,
        body: expect.stringContaining('Expected parameter(s): modelId'),
      }),
      'Bytez native list non-OK'
    );
  });

  it('does not throw when the non-OK response body is unreadable', async () => {
    const brokenResponse = {
      ok: false,
      status: 503,
      text: () => Promise.reject(new Error('body already consumed')),
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(brokenResponse);

    const models = await new BytezNativeModelFetcher('live-key').getModels();

    expect(models).toEqual([]);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503, body: '<unreadable>' }),
      'Bytez native list non-OK'
    );
  });

  it('returns empty when the API responds with a non-null error field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ error: 'rate limited', output: [] })
    );

    const models = await new BytezNativeModelFetcher('live-key').getModels();

    expect(models).toEqual([]);
  });

  it('drops entries with no modelId and maps task to capabilities', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        error: null,
        output: [{ task: 'text-generation' }, bytezModel('org/valid', 'text-to-image')],
      })
    );

    const models = await new BytezNativeModelFetcher('live-key').getModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('org/valid');
    expect(models[0].capabilities).toContain('image_generation');
  });
});
