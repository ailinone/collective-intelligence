// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Deepgram native speaker diarization — wire contract.
 *
 * Verified against the vendor documentation on 2026-09-05
 * (https://developers.deepgram.com/docs/diarization):
 *   - `diarize_model` selects the diarizer AND enables diarization for batch;
 *     values `latest` (currently v2), `v1`, `v2`.
 *   - The legacy boolean `diarize=true` still works but is deprecated, and a
 *     request that sets BOTH is rejected. Hence: send `diarize_model` only.
 *   - Pre-recorded responses carry `speaker` on each word; with
 *     `utterances=true`, each utterance carries `speaker` too.
 *
 * The assertions below pin exactly those facts, so a future change that
 * reintroduces the rejected parameter pair fails here rather than in
 * production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepgramAdapter } from '@/providers/deepgram/deepgram-adapter';
import type { Model } from '@/types';

const MODEL = { id: 'some-stt-model', name: 'some-stt-model', provider: 'deepgram' } as Model;

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const DIARIZED_BODY = {
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: 'good morning everyone shall we start',
            confidence: 0.98,
            words: [
              { word: 'good', start: 0.1, end: 0.4, confidence: 0.99, speaker: 0 },
              { word: 'shall', start: 2.0, end: 2.3, confidence: 0.97, speaker: 1 },
            ],
          },
        ],
      },
    ],
    utterances: [
      { start: 0.1, end: 1.2, transcript: 'good morning everyone', speaker: 0, confidence: 0.98 },
      { start: 2.0, end: 3.1, transcript: 'shall we start', speaker: 1, confidence: 0.95 },
    ],
  },
  metadata: { duration: 3.2, request_id: 'dg-req-1' },
};

let fetchMock: ReturnType<typeof vi.fn>;
let adapter: DeepgramAdapter;

function requestedUrl(): URL {
  return new URL(String(fetchMock.mock.calls[0][0]));
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(DIARIZED_BODY));
  vi.stubGlobal('fetch', fetchMock);
  adapter = new DeepgramAdapter({ apiKey: 'token-not-a-real-key' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DeepgramAdapter.getDiarizationSupport', () => {
  it('declares native diarization with vendor-documentation evidence', () => {
    const support = adapter.getDiarizationSupport();

    expect(support.native).toBe(true);
    // The evidence URL is the audit trail that separates a verified claim from
    // an optimistic one; it is mandatory whenever native is true.
    expect(support.evidenceUrl).toMatch(/^https:\/\/developers\.deepgram\.com\//);
    expect(support.requestParameters).toContain('diarize_model');
    // Deepgram takes no fixed speaker count, so no hint is advertised.
    expect(support.acceptsSpeakerCountHint).toBe(false);
  });
});

describe('DeepgramAdapter.speechToText — diarization requested', () => {
  it('sets diarize_model and utterances, and NEVER the rejected pair', async () => {
    await adapter.speechToText(MODEL, {
      audio: Buffer.from('audio'),
      options: { diarize: true },
    });

    const url = requestedUrl();
    expect(url.pathname).toBe('/v1/listen');
    expect(url.searchParams.get('diarize_model')).toBe('latest');
    expect(url.searchParams.get('utterances')).toBe('true');
    // Deepgram rejects a request that sets both `diarize` and `diarize_model`.
    expect(url.searchParams.has('diarize')).toBe(false);
  });

  it('honours DEEPGRAM_DIARIZE_MODEL for label stability', async () => {
    const previous = process.env.DEEPGRAM_DIARIZE_MODEL;
    process.env.DEEPGRAM_DIARIZE_MODEL = 'v1';
    try {
      await adapter.speechToText(MODEL, {
        audio: Buffer.from('audio'),
        options: { diarize: true },
      });
      expect(requestedUrl().searchParams.get('diarize_model')).toBe('v1');
    } finally {
      if (previous === undefined) delete process.env.DEEPGRAM_DIARIZE_MODEL;
      else process.env.DEEPGRAM_DIARIZE_MODEL = previous;
    }
  });

  it('normalises upstream utterances into labelled speaker turns', async () => {
    const response = await adapter.speechToText(MODEL, {
      audio: Buffer.from('audio'),
      options: { diarize: true },
    });

    const raw = response.raw as { speakers?: Array<Record<string, unknown>>; diarized?: boolean };
    expect(raw.diarized).toBe(true);
    expect(raw.speakers).toEqual([
      { speaker: 'speaker_0', start: 0.1, end: 1.2, text: 'good morning everyone', confidence: 0.98 },
      { speaker: 'speaker_1', start: 2.0, end: 3.1, text: 'shall we start', confidence: 0.95 },
    ]);
    expect(response.text).toBe('good morning everyone shall we start');
  });

  it('reports zero turns rather than inventing a single speaker', async () => {
    // Deepgram ran the diarizer but labelled nothing (e.g. pure silence).
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: {
          channels: [{ alternatives: [{ transcript: '', words: [] }] }],
          utterances: [],
        },
        metadata: { duration: 1 },
      })
    );

    const response = await adapter.speechToText(MODEL, {
      audio: Buffer.from('audio'),
      options: { diarize: true },
    });

    const raw = response.raw as { speakers?: unknown[]; diarized?: boolean };
    expect(raw.speakers).toEqual([]);
    expect(raw.diarized).toBe(false);
  });

  it('drops utterances the upstream did not label', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: {
          channels: [{ alternatives: [{ transcript: 'a b' }] }],
          utterances: [
            { start: 0, end: 1, transcript: 'a' },
            { start: 1, end: 2, transcript: 'b', speaker: 3 },
          ],
        },
        metadata: {},
      })
    );

    const response = await adapter.speechToText(MODEL, {
      audio: Buffer.from('audio'),
      options: { diarize: true },
    });

    const raw = response.raw as { speakers?: Array<{ speaker: string }> };
    expect(raw.speakers).toHaveLength(1);
    expect(raw.speakers?.[0].speaker).toBe('speaker_3');
  });
});

describe('DeepgramAdapter.speechToText — diarization NOT requested', () => {
  it('sends no diarization parameters', async () => {
    await adapter.speechToText(MODEL, { audio: Buffer.from('audio') });

    const url = requestedUrl();
    expect(url.searchParams.has('diarize_model')).toBe(false);
    expect(url.searchParams.has('diarize')).toBe(false);
    expect(url.searchParams.has('utterances')).toBe(false);
  });

  it('omits the speakers field entirely, so absence is distinguishable', async () => {
    const response = await adapter.speechToText(MODEL, { audio: Buffer.from('audio') });

    const raw = response.raw as Record<string, unknown>;
    // `undefined` = never asked. `[]` = asked and got nothing. The two must
    // not collapse into each other.
    expect('speakers' in raw).toBe(false);
    expect('diarized' in raw).toBe(false);
  });

  it('keeps the pre-existing formatting parameters untouched', async () => {
    await adapter.speechToText(MODEL, { audio: Buffer.from('audio'), language: 'pt' });

    const url = requestedUrl();
    expect(url.searchParams.get('language')).toBe('pt');
    expect(url.searchParams.get('smart_format')).toBe('true');
    expect(url.searchParams.get('punctuate')).toBe('true');
    expect(url.searchParams.get('model')).toBe('some-stt-model');
  });
});
