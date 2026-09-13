// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * MusicOrchestrationService (LOTE AX, 2026-09-06).
 *
 * Mirrors the mocking pattern used by
 * `audio-orchestration-diarization.test.ts`: `ModelRepository` and the
 * provider registry are mocked so these tests exercise ONLY this service's
 * candidate-selection + dispatch logic, not real discovery or a real
 * adapter's wire protocol (that's `elevenlabs-adapter.test.ts`'s job).
 *
 * Covers:
 *   - dynamic candidate selection: a model tagged `music_generation` whose
 *     resolved adapter implements `generateMusic` is selected, and the
 *     request is forwarded with the right fields.
 *   - fail-closed: no capable candidate → ValidationError, never a silent
 *     fallback to a capability the model doesn't have.
 *   - explicit `model` that lacks the capability → ValidationError, distinct
 *     from the "not found" case.
 *   - the mutual-exclusivity input gate: neither `prompt` nor
 *     `compositionPlan` throws before any candidate is even selected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchModels = vi.fn();
const findModelsByIdOrName = vi.fn();
const resolveAdapterForModel = vi.fn();

vi.mock('@/services/model-repository', () => ({
  ModelRepository: class {
    searchModelsComplete = searchModels;
    findModelsByIdOrName = findModelsByIdOrName;
  },
}));

vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({
    resolveAdapterForModel,
    getAll: vi.fn().mockReturnValue([]),
    get: vi.fn(),
  }),
}));

const { MusicOrchestrationService } = await import('@/services/music-orchestration-service');
import type { Model, OrchestrationContext } from '@/types';

const USER_CONTEXT = {
  requestId: 'req-1',
  organizationId: 'org-1',
  userId: 'user-1',
  models: [],
  taskType: 'general',
  contextSize: 0,
} as unknown as OrchestrationContext;

function musicModel(name: string, provider = 'elevenlabs'): Model {
  return {
    id: `${provider}:${name}`,
    name,
    provider,
    providerId: provider,
    capabilities: ['music_generation'],
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    performance: { latencyMs: 100, throughput: 0, quality: 0.9, reliability: 0.9 },
    metadata: {},
  } as unknown as Model;
}

/** Minimal adapter stub — `generateMusic` must differ from the base
 *  prototype's function reference, otherwise `isAdapterMethodImplemented`
 *  correctly reports it as unimplemented. */
function adapterStub(options: { name: string; onCall?: (r: unknown) => void }) {
  return {
    getName: () => options.name,
    generateMusic: vi.fn(async (_model: Model, request: unknown) => {
      options.onCall?.(request);
      return {
        audio: Buffer.from('fake-mp3-bytes'),
        format: 'mp3',
        raw: {},
      };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MusicOrchestrationService.generateMusic', () => {
  it('rejects a request with neither prompt nor compositionPlan before selecting candidates', async () => {
    const service = new MusicOrchestrationService();

    await expect(
      service.generateMusic({
        userContext: USER_CONTEXT,
        requestId: 'req-1',
      })
    ).rejects.toThrow(/prompt or compositionPlan/i);

    expect(searchModels).not.toHaveBeenCalled();
  });

  it('selects a dynamically-discovered music_generation model and forwards the request', async () => {
    const model = musicModel('music_v2');
    searchModels.mockResolvedValue([model]);
    const adapter = adapterStub({ name: 'elevenlabs' });
    resolveAdapterForModel.mockReturnValue({ adapter });

    const service = new MusicOrchestrationService();
    const result = await service.generateMusic({
      prompt: 'A short cinematic sting',
      musicLengthMs: 15000,
      seed: 7,
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    expect(adapter.generateMusic).toHaveBeenCalledTimes(1);
    const [, request] = adapter.generateMusic.mock.calls[0];
    expect(request).toMatchObject({
      prompt: 'A short cinematic sting',
      musicLengthMs: 15000,
      seed: 7,
    });

    expect(result.provider).toBe('elevenlabs');
    expect(result.modelUsed).toBe('music_v2');
    expect(result.format).toBe('mp3');
    expect(Buffer.isBuffer(result.audioBuffer)).toBe(true);

    // Candidate selection went through `searchModelsComplete`, never the
    // windowed `searchModels` — same anti-silent-truncation invariant as
    // audio/video orchestration.
    expect(searchModels).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: ['music_generation'] })
    );
  });

  it('fails closed when no model in the pool actually implements generateMusic', async () => {
    const model = musicModel('music_v2');
    searchModels.mockResolvedValue([model]);
    // Adapter resolves, but does NOT implement generateMusic (base fallback throws).
    resolveAdapterForModel.mockReturnValue({ adapter: { getName: () => 'elevenlabs' } });

    const service = new MusicOrchestrationService();

    await expect(
      service.generateMusic({
        prompt: 'test',
        userContext: USER_CONTEXT,
        requestId: 'req-1',
      })
    ).rejects.toThrow(/no music generation models available/i);
  });

  it('rejects an explicit model id that lacks the music_generation capability', async () => {
    const chatModel = {
      id: 'openai:gpt-4o',
      name: 'gpt-4o',
      provider: 'openai',
      capabilities: ['chat'],
      inputCostPer1k: 0,
      outputCostPer1k: 0,
      metadata: {},
    } as unknown as Model;
    findModelsByIdOrName.mockResolvedValue([chatModel]);

    const service = new MusicOrchestrationService();

    await expect(
      service.generateMusic({
        prompt: 'test',
        model: 'gpt-4o',
        userContext: USER_CONTEXT,
        requestId: 'req-1',
      })
    ).rejects.toThrow(/does not support music generation/i);

    expect(resolveAdapterForModel).not.toHaveBeenCalled();
  });
});
