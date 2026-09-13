// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Diarization is a HARD capability gate on the STT pipeline.
 *
 * The failure this suite prevents: transcribing with a provider that has no
 * native diarizer and returning an ordinary, unlabelled transcript. The caller
 * asked for speaker separation, got a plain transcript, and has no way to tell
 * the difference — a silent correctness bug rather than a visible error.
 *
 * So: when `diarize: true`, candidates are filtered to adapters that DECLARE
 * native diarization (`ProviderAdapter.getDiarizationSupport()`), and the call
 * fails closed when none survive.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchModels = vi.fn();
const resolveAdapterForModel = vi.fn();
const registryGetAll = vi.fn();

vi.mock('@/services/model-repository', () => ({
  // `selectSTTCandidateModels` calls `searchModelsComplete` (the unwindowed
  // search, per LOTE AO's fix for the silent 100-row recency cap) — alias it
  // to the same mock so existing `searchModels.mockResolvedValue(...)` setup
  // controls both call sites regardless of which one production code uses.
  ModelRepository: class {
    searchModels = searchModels;
    searchModelsComplete = searchModels;
  },
}));

vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({
    resolveAdapterForModel,
    getAll: registryGetAll,
    get: vi.fn(),
  }),
}));

const { AudioOrchestrationService } = await import('@/services/audio-orchestration-service');
const { ProviderAdapter } = await import('@/providers/base/provider-adapter');
import type { Model, OrchestrationContext } from '@/types';

const USER_CONTEXT = {
  requestId: 'req-1',
  organizationId: 'org-1',
  userId: 'user-1',
  models: [],
  taskType: 'general',
  contextSize: 0,
} as unknown as OrchestrationContext;

function sttModel(name: string, provider: string): Model {
  return {
    id: `${provider}:${name}`,
    name,
    provider,
    capabilities: ['speech_to_text'],
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    metadata: {},
  } as unknown as Model;
}

/**
 * Minimal adapter stub. `speechToText` must differ from the base prototype's,
 * otherwise `isAdapterMethodImplemented` correctly rejects it as unimplemented.
 */
function adapterStub(options: { diarizes: boolean; name: string; onCall?: (r: unknown) => void }) {
  return {
    getName: () => options.name,
    getApiKey: () => 'key',
    getDiarizationSupport: () =>
      options.diarizes
        ? {
            native: true,
            evidenceUrl: 'https://vendor.invalid/docs/diarization',
            acceptsSpeakerCountHint: false,
          }
        : { native: false },
    speechToText: vi.fn(async (_model: Model, request: unknown) => {
      options.onCall?.(request);
      return {
        text: 'transcribed text',
        raw: {
          speakers: options.diarizes
            ? [{ speaker: 'speaker_0', start: 0, end: 1, text: 'transcribed text' }]
            : undefined,
        },
      };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  registryGetAll.mockReturnValue([]);
});

describe('transcribeAudio — diarization gate', () => {
  it('fails closed when no configured adapter declares native diarization', async () => {
    const model = sttModel('some-stt', 'plain-stt-provider');
    searchModels.mockResolvedValue([model]);
    const adapter = adapterStub({ diarizes: false, name: 'plain-stt-provider' });
    resolveAdapterForModel.mockReturnValue({ adapter });

    const service = new AudioOrchestrationService();

    await expect(
      service.transcribeAudio({
        audioBuffer: Buffer.from('audio'),
        filename: 'a.wav',
        diarize: true,
        userContext: USER_CONTEXT,
        requestId: 'req-1',
      })
    ).rejects.toThrow(/diariz/i);

    // The critical part: the non-diarizing provider was never called, so no
    // unlabelled transcript could be mistaken for a diarized one.
    expect(adapter.speechToText).not.toHaveBeenCalled();
  });

  it('names the providers that WOULD satisfy the request', async () => {
    searchModels.mockResolvedValue([sttModel('some-stt', 'plain-stt-provider')]);
    resolveAdapterForModel.mockReturnValue({
      adapter: adapterStub({ diarizes: false, name: 'plain-stt-provider' }),
    });
    registryGetAll.mockReturnValue([
      adapterStub({ diarizes: true, name: 'a-diarizing-provider' }),
      adapterStub({ diarizes: false, name: 'plain-stt-provider' }),
    ]);

    const service = new AudioOrchestrationService();

    await expect(
      service.transcribeAudio({
        audioBuffer: Buffer.from('audio'),
        filename: 'a.wav',
        diarize: true,
        userContext: USER_CONTEXT,
        requestId: 'req-1',
      })
    ).rejects.toThrow(/a-diarizing-provider/);
  });

  it('forwards diarize:true to a declaring adapter and returns its speaker turns', async () => {
    const received: unknown[] = [];
    const model = sttModel('some-stt', 'a-diarizing-provider');
    searchModels.mockResolvedValue([model]);
    resolveAdapterForModel.mockReturnValue({
      adapter: adapterStub({
        diarizes: true,
        name: 'a-diarizing-provider',
        onCall: (request) => received.push(request),
      }),
    });

    const service = new AudioOrchestrationService();
    const result = await service.transcribeAudio({
      audioBuffer: Buffer.from('audio'),
      filename: 'a.wav',
      diarize: true,
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    expect(received).toHaveLength(1);
    expect((received[0] as { options: Record<string, unknown> }).options.diarize).toBe(true);
    expect(result.diarized).toBe(true);
    expect(result.speakers).toEqual([
      { speaker: 'speaker_0', start: 0, end: 1, text: 'transcribed text' },
    ]);
  });

  it('withholds the speaker-count hint from adapters that do not accept one', async () => {
    const received: unknown[] = [];
    searchModels.mockResolvedValue([sttModel('some-stt', 'a-diarizing-provider')]);
    resolveAdapterForModel.mockReturnValue({
      adapter: adapterStub({
        diarizes: true,
        name: 'a-diarizing-provider',
        onCall: (request) => received.push(request),
      }),
    });

    const service = new AudioOrchestrationService();
    await service.transcribeAudio({
      audioBuffer: Buffer.from('audio'),
      filename: 'a.wav',
      diarize: true,
      numSpeakers: 3,
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    const options = (received[0] as { options: Record<string, unknown> }).options;
    expect(options.diarize).toBe(true);
    // acceptsSpeakerCountHint is false for this stub, so sending numSpeakers
    // would be an undocumented parameter on a real provider.
    expect('numSpeakers' in options).toBe(false);
  });

  it('reports zero turns rather than none, when the diarizer ran and labelled nothing', async () => {
    searchModels.mockResolvedValue([sttModel('some-stt', 'a-diarizing-provider')]);
    resolveAdapterForModel.mockReturnValue({
      adapter: {
        getName: () => 'a-diarizing-provider',
        getApiKey: () => 'key',
        getDiarizationSupport: () => ({
          native: true,
          evidenceUrl: 'https://vendor.invalid/docs',
        }),
        speechToText: vi.fn(async () => ({ text: '', raw: { speakers: [] } })),
      },
    });

    const service = new AudioOrchestrationService();
    const result = await service.transcribeAudio({
      audioBuffer: Buffer.from('audio'),
      filename: 'a.wav',
      diarize: true,
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    // `[]` = asked and got nothing; `undefined` would mean never asked.
    expect(result.speakers).toEqual([]);
    expect(result.diarized).toBe(false);
  });
});

describe('transcribeAudio — no diarization requested', () => {
  it('leaves ordinary transcription untouched by the gate', async () => {
    const received: unknown[] = [];
    searchModels.mockResolvedValue([sttModel('some-stt', 'plain-stt-provider')]);
    resolveAdapterForModel.mockReturnValue({
      adapter: adapterStub({
        diarizes: false,
        name: 'plain-stt-provider',
        onCall: (request) => received.push(request),
      }),
    });

    const service = new AudioOrchestrationService();
    const result = await service.transcribeAudio({
      audioBuffer: Buffer.from('audio'),
      filename: 'a.wav',
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    expect(result.text).toBe('transcribed text');
    expect(result.speakers).toBeUndefined();
    expect(result.diarized).toBeUndefined();
    const options = (received[0] as { options: Record<string, unknown> }).options;
    expect('diarize' in options).toBe(false);
  });
});

describe('ProviderAdapter default', () => {
  it('denies diarization unless an adapter opts in', () => {
    expect(ProviderAdapter.prototype.getDiarizationSupport.call({})).toEqual({ native: false });
  });
});
