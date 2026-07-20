// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Google Gemini fine-tuning (tuning) client — unit tests.
 *
 * Exercises the REAL endpoint shapes against a mocked fetch so NO live calls
 * happen. Locks in: URL/key construction, create→get→delete request bodies,
 * status normalization, and the 503 provider_not_configured contract when the
 * credential is missing.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GoogleFineTuningClient,
  GoogleTuningNotConfiguredError,
  GoogleTuningApiError,
  mapGoogleStateToNormalizedStatus,
  type GoogleTuningOperation,
  type GoogleTunedModel,
} from '../google-fine-tuning-client';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERR',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('mapGoogleStateToNormalizedStatus', () => {
  it('maps Google TunedModel states to the normalized vocabulary', () => {
    expect(mapGoogleStateToNormalizedStatus('ACTIVE')).toBe('succeeded');
    expect(mapGoogleStateToNormalizedStatus('FAILED')).toBe('failed');
    expect(mapGoogleStateToNormalizedStatus('CREATING')).toBe('running');
    expect(mapGoogleStateToNormalizedStatus('STATE_UNSPECIFIED')).toBe('queued');
    expect(mapGoogleStateToNormalizedStatus(undefined)).toBe('queued');
    expect(mapGoogleStateToNormalizedStatus('SOMETHING_ELSE')).toBe('queued');
  });
});

describe('GoogleFineTuningClient construction', () => {
  it('throws a 503 provider_not_configured error when the api key is empty', () => {
    expect(() => new GoogleFineTuningClient({ apiKey: '' })).toThrow(
      GoogleTuningNotConfiguredError
    );
    try {
      new GoogleFineTuningClient({ apiKey: '   ' });
    } catch (error) {
      expect((error as { statusCode: number }).statusCode).toBe(503);
      expect((error as { code: string }).code).toBe('provider_not_configured');
    }
  });
});

describe('GoogleFineTuningClient.createTuningJob', () => {
  it('POSTs to tunedModels with the api key, base model and examples', async () => {
    const operation: GoogleTuningOperation = {
      name: 'operations/abc',
      done: false,
      metadata: { tunedModel: 'tunedModels/my-model-123' },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(operation));

    const client = new GoogleFineTuningClient({
      apiKey: 'AIza_test_key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await client.createTuningJob({
      baseModel: 'models/gemini-1.5-flash-001-tuning',
      displayName: 'my-tune',
      hyperparameters: { epochCount: 3, batchSize: 4, learningRateMultiplier: 1 },
      examples: [
        { textInput: 'hello', output: 'hi there' },
        { textInput: 'bye', output: 'goodbye' },
      ],
    });

    expect(result.metadata?.tunedModel).toBe('tunedModels/my-model-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1beta/tunedModels');
    expect(url).toContain('key=AIza_test_key');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.baseModel).toBe('models/gemini-1.5-flash-001-tuning');
    expect(body.displayName).toBe('my-tune');
    const tuningTask = body.tuningTask as Record<string, unknown>;
    expect(tuningTask.hyperparameters).toEqual({
      epochCount: 3,
      batchSize: 4,
      learningRateMultiplier: 1,
    });
    const trainingData = tuningTask.trainingData as {
      examples: { examples: Array<{ textInput: string; output: string }> };
    };
    expect(trainingData.examples.examples).toHaveLength(2);
    expect(trainingData.examples.examples[0]).toEqual({
      textInput: 'hello',
      output: 'hi there',
    });
  });

  it('throws GoogleTuningApiError on a non-2xx response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'quota' }, { ok: false, status: 429 }));
    const client = new GoogleFineTuningClient({
      apiKey: 'k',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.createTuningJob({
        baseModel: 'models/gemini-1.5-flash-001-tuning',
        examples: [{ textInput: 'a', output: 'b' }],
      })
    ).rejects.toBeInstanceOf(GoogleTuningApiError);
  });
});

describe('GoogleFineTuningClient.getTunedModel', () => {
  it('GETs the tuned model resource and returns its state', async () => {
    const tunedModel: GoogleTunedModel = {
      name: 'tunedModels/my-model-123',
      state: 'ACTIVE',
      tuningTask: {
        completeTime: '2026-06-13T00:00:00Z',
        snapshots: [{ step: 1, meanLoss: 0.5 }],
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tunedModel));
    const client = new GoogleFineTuningClient({
      apiKey: 'k',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await client.getTunedModel('tunedModels/my-model-123');
    expect(result.state).toBe('ACTIVE');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1beta/tunedModels/my-model-123');
    expect(init.method).toBe('GET');
  });
});

describe('GoogleFineTuningClient.deleteTunedModel', () => {
  it('DELETEs the tuned model resource', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    const client = new GoogleFineTuningClient({
      apiKey: 'k',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.deleteTunedModel('tunedModels/my-model-123');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1beta/tunedModels/my-model-123');
    expect(init.method).toBe('DELETE');
  });
});
