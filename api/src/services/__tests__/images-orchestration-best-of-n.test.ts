// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ImagesOrchestrationService — real best-of-N + judge selection (Package B).
 *
 * Before this change, `parallel`/`debate`/`quality_multipass` all collapsed
 * to the exact same behavior as plain `quality`: sort the candidate pool by a
 * static score, then let `executeWithFallback`'s `Promise.any` race the top
 * of the pool and return whichever answered FIRST. No comparison of actual
 * generated content ever happened — "debate" never debated anything.
 *
 * These tests assert the real mechanism: N candidates generated CONCURRENTLY
 * (not raced-to-first), a real judge scoring each one, and the JUDGE's
 * verdict — not speed, not static ranking — deciding which candidate is
 * returned.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Model, OrchestrationContext } from '@/types';

const searchModelsComplete = vi.fn();
const findModelsByIdOrName = vi.fn();

vi.mock('@/services/model-repository', () => ({
  ModelRepository: class {
    searchModelsComplete = searchModelsComplete;
    findModelsByIdOrName = findModelsByIdOrName;
  },
}));

const resolveAdapterForModel = vi.fn();
vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({ resolveAdapterForModel }),
}));

vi.mock('@/providers/provider-operability', () => ({
  isAdapterMethodImplemented: (adapter: { imageGenerate?: unknown }) =>
    typeof adapter.imageGenerate === 'function',
}));

const judgeScore = vi.fn();
vi.mock('@/services/image-candidate-judge', () => ({
  getImageCandidateJudge: () => ({ score: judgeScore }),
}));

import { ImagesOrchestrationService } from '../images-orchestration-service';

const USER_CONTEXT = {
  organizationId: 'org_test',
  userId: 'user_test',
} as unknown as OrchestrationContext;

function makeModel(id: string, provider: string, overrides: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    displayName: id,
    provider,
    capabilities: ['image_generation'],
    contextWindow: 0,
    maxOutputTokens: 0,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.02,
    performance: { latencyMs: 2000, throughput: 1, quality: 0.7, reliability: 1 },
    status: 'active',
    ...overrides,
  } as unknown as Model;
}

function wirePool(models: Model[], adaptersByProvider: Record<string, { imageGenerate: Mock }>): void {
  searchModelsComplete.mockResolvedValue(models);
  resolveAdapterForModel.mockImplementation((model: Model) => ({
    adapter: { ...adaptersByProvider[model.provider], getName: () => model.provider },
    operability: {},
  }));
}

const GEN_OPTIONS = {
  prompt: 'a red bicycle leaning on a brick wall',
  n: 1,
  size: '1024x1024' as const,
  quality: 'standard' as const,
  responseFormat: 'url' as const,
  style: 'vivid' as const,
  userContext: USER_CONTEXT,
  requestId: 'req_1',
};

describe('ImagesOrchestrationService — best-of-N (Package B)', () => {
  let service: ImagesOrchestrationService;

  beforeEach(() => {
    vi.clearAllMocks();
    judgeScore.mockReset();
    process.env.IMAGE_BEST_OF_N = '3';
    service = new ImagesOrchestrationService();
  });

  it('generates from ALL candidates concurrently, not race-to-first', async () => {
    const modelA = makeModel('model-a', 'provider-a');
    const modelB = makeModel('model-b', 'provider-b');
    const modelC = makeModel('model-c', 'provider-c');

    let resolveSlow: (() => void) | undefined;
    const slow = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSlow = () =>
            resolve({ image: [{ url: 'https://example.com/slow.png' }], format: 'png', raw: {} });
        })
    );
    const fast = vi
      .fn()
      .mockResolvedValue({ image: [{ url: 'https://example.com/fast.png' }], format: 'png', raw: {} });
    const alsoFast = vi
      .fn()
      .mockResolvedValue({ image: [{ url: 'https://example.com/also-fast.png' }], format: 'png', raw: {} });

    wirePool([modelA, modelB, modelC], {
      'provider-a': { imageGenerate: slow },
      'provider-b': { imageGenerate: fast },
      'provider-c': { imageGenerate: alsoFast },
    });
    judgeScore.mockResolvedValue({ score: 0.5, verdict: 'pass', available: true });

    const resultPromise = service.generateImages({ ...GEN_OPTIONS, strategy: 'parallel' });

    // Give the fast candidates a turn on the microtask/macrotask queue, then
    // resolve the slow one — with the OLD Promise.any-race behavior, a fast
    // candidate would have already won and the slow one's call might never
    // even have been made. Here, ALL THREE must have been invoked.
    await new Promise((r) => setTimeout(r, 10));
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fast).toHaveBeenCalledTimes(1);
    expect(alsoFast).toHaveBeenCalledTimes(1);
    resolveSlow?.();

    const result = await resultPromise;
    expect(result.candidatesEvaluated).toBe(3);
  });

  it('the judge verdict — not static ranking — decides the winner', async () => {
    // model-b has a LOWER static quality score than model-a, but the judge
    // will score model-b's actual output higher — the judge must win.
    const modelA = makeModel('model-a', 'provider-a', {
      performance: { latencyMs: 1000, throughput: 1, quality: 0.9, reliability: 1 },
    });
    const modelB = makeModel('model-b', 'provider-b', {
      performance: { latencyMs: 1000, throughput: 1, quality: 0.3, reliability: 1 },
    });

    const genA = vi
      .fn()
      .mockResolvedValue({ image: [{ url: 'https://example.com/a.png' }], format: 'png', raw: {} });
    const genB = vi
      .fn()
      .mockResolvedValue({ image: [{ url: 'https://example.com/b.png' }], format: 'png', raw: {} });

    wirePool([modelA, modelB], {
      'provider-a': { imageGenerate: genA },
      'provider-b': { imageGenerate: genB },
    });

    judgeScore.mockImplementation(async (input: { image: string }) => {
      if (input.image === 'https://example.com/a.png') {
        return { score: 0.4, verdict: 'fail', available: true };
      }
      return { score: 0.95, verdict: 'pass', available: true };
    });

    const result = await service.generateImages({ ...GEN_OPTIONS, strategy: 'debate' });

    expect(result.modelUsed).toBe('model-b');
    expect(result.provider).toBe('provider-b');
    expect(result.judgeUsed).toBe(true);
    expect(result.images[0]?.url).toBe('https://example.com/b.png');
    expect(result.judgeVerdicts).toHaveLength(2);
  });

  it('falls back to static-ranking order when the judge is unavailable for every candidate', async () => {
    const modelA = makeModel('model-a', 'provider-a', {
      performance: { latencyMs: 1000, throughput: 1, quality: 0.9, reliability: 1 },
    });
    const modelB = makeModel('model-b', 'provider-b', {
      performance: { latencyMs: 1000, throughput: 1, quality: 0.3, reliability: 1 },
    });

    const genA = vi
      .fn()
      .mockResolvedValue({ image: [{ url: 'https://example.com/a.png' }], format: 'png', raw: {} });
    const genB = vi
      .fn()
      .mockResolvedValue({ image: [{ url: 'https://example.com/b.png' }], format: 'png', raw: {} });

    wirePool([modelA, modelB], {
      'provider-a': { imageGenerate: genA },
      'provider-b': { imageGenerate: genB },
    });
    judgeScore.mockResolvedValue({ score: 0, verdict: 'uncertain', available: false, unavailableReason: 'image_judge_disabled' });

    const result = await service.generateImages({ ...GEN_OPTIONS, strategy: 'quality_multipass' });

    // model-a ranked first by the pre-existing static quality score — the
    // honest fallback when the judge cannot actually compare anything.
    expect(result.modelUsed).toBe('model-a');
    expect(result.judgeUsed).toBe(false);
  });

  it('never invokes the judge when only one candidate succeeds', async () => {
    const modelA = makeModel('model-a', 'provider-a');
    const modelB = makeModel('model-b', 'provider-b');

    const genA = vi.fn().mockRejectedValue(new Error('provider down'));
    const genB = vi
      .fn()
      .mockResolvedValue({ image: [{ url: 'https://example.com/b.png' }], format: 'png', raw: {} });

    wirePool([modelA, modelB], {
      'provider-a': { imageGenerate: genA },
      'provider-b': { imageGenerate: genB },
    });

    const result = await service.generateImages({ ...GEN_OPTIONS, strategy: 'parallel' });

    expect(judgeScore).not.toHaveBeenCalled();
    expect(result.judgeUsed).toBe(false);
    expect(result.modelUsed).toBe('model-b');
    expect(result.candidatesEvaluated).toBe(1);
    // The failed candidate is still recorded for observability.
    expect(result.attempts?.some((a) => a.provider === 'provider-a' && a.status === 'failed')).toBe(
      true
    );
  });

  it('falls through to sequential fallback when every top-N candidate fails', async () => {
    process.env.IMAGE_BEST_OF_N = '2';
    const modelA = makeModel('model-a', 'provider-a');
    const modelB = makeModel('model-b', 'provider-b');
    const modelC = makeModel('model-c', 'provider-c');

    const genA = vi.fn().mockRejectedValue(new Error('down'));
    const genB = vi.fn().mockRejectedValue(new Error('down'));
    const genC = vi
      .fn()
      .mockResolvedValue({ image: [{ url: 'https://example.com/c.png' }], format: 'png', raw: {} });

    wirePool([modelA, modelB, modelC], {
      'provider-a': { imageGenerate: genA },
      'provider-b': { imageGenerate: genB },
      'provider-c': { imageGenerate: genC },
    });

    const result = await service.generateImages({ ...GEN_OPTIONS, strategy: 'parallel' });

    expect(result.modelUsed).toBe('model-c');
    expect(judgeScore).not.toHaveBeenCalled();
    // Both best-of-N failures AND the eventual fallback success are recorded.
    expect(result.attempts?.filter((a) => a.status === 'failed')).toHaveLength(2);
    expect(result.attempts?.some((a) => a.status === 'success' && a.provider === 'provider-c')).toBe(
      true
    );
  });

  it('does not apply best-of-N when an explicit model is requested', async () => {
    const explicitModel = makeModel('explicit-model', 'provider-explicit');
    findModelsByIdOrName.mockResolvedValue([explicitModel]);
    const gen = vi
      .fn()
      .mockResolvedValue({ image: [{ url: 'https://example.com/explicit.png' }], format: 'png', raw: {} });
    resolveAdapterForModel.mockReturnValue({
      adapter: { imageGenerate: gen, getName: () => 'provider-explicit' },
      operability: {},
    });

    const result = await service.generateImages({
      ...GEN_OPTIONS,
      model: 'explicit-model',
      strategy: 'debate',
    });

    expect(judgeScore).not.toHaveBeenCalled();
    expect(gen).toHaveBeenCalledTimes(1);
    expect(result.modelUsed).toBe('explicit-model');
    expect(result.judgeUsed).toBeUndefined();
  });

  it('does not apply best-of-N for ordinary strategies (quality/cost/speed/balanced/single/dynamic)', async () => {
    const modelA = makeModel('model-a', 'provider-a');
    const modelB = makeModel('model-b', 'provider-b');
    const genA = vi
      .fn()
      .mockResolvedValue({ image: [{ url: 'https://example.com/a.png' }], format: 'png', raw: {} });
    const genB = vi
      .fn()
      .mockResolvedValue({ image: [{ url: 'https://example.com/b.png' }], format: 'png', raw: {} });
    wirePool([modelA, modelB], {
      'provider-a': { imageGenerate: genA },
      'provider-b': { imageGenerate: genB },
    });

    const result = await service.generateImages({ ...GEN_OPTIONS, strategy: 'quality' });

    expect(judgeScore).not.toHaveBeenCalled();
    // Single-winner path: only ONE candidate is ever actually called.
    expect(genA.mock.calls.length + genB.mock.calls.length).toBe(1);
    expect(result.judgeUsed).toBeUndefined();
    expect(result.candidatesEvaluated).toBeUndefined();
  });
});
