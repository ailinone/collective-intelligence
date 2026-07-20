// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the executeWithFallback contract:
 *
 *   1. Explicit model name selects ALL catalog rows whose name/id matches
 *      AND that declare the requested capability — not just the first row
 *      `findModelByName` happens to return.
 *   2. Adapters that don't support the capability (per `supportsCapability`)
 *      are filtered out before the loop, never counted as failed attempts.
 *   3. Candidate ordering goes through `rankRetryCandidates` (tier first).
 *   4. The classifier maps representative provider error shapes to the
 *      correct `FallbackErrorClass`.
 *   5. On success, `attempts[]` ends with one `success` entry; on full
 *      exhaustion, `FallbackExhaustedError` carries every attempt.
 *   6. When no catalog row matches, `NoFallbackCandidateError` is thrown
 *      *before* any execute() call.
 *
 * The tests inject `catalog` directly so we don't have to spin up Prisma.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  classifyFallbackError,
  executeWithFallback,
  FallbackExhaustedError,
  NoFallbackCandidateError,
  selectCandidates,
} from '../execute-with-fallback';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { Model } from '@/types';

function fakeModel(overrides: Partial<Model> & Pick<Model, 'id' | 'name' | 'provider'>): Model {
  return {
    providerId: overrides.provider,
    displayName: overrides.name,
    contextWindow: 4096,
    maxOutputTokens: 1024,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    capabilities: ['embeddings'],
    performance: {
      latencyP50: 100,
      latencyP95: 200,
      throughput: 100,
      reliability: 0.99,
      qualityScore: 0.8,
    },
    status: 'active',
    metadata: { sourceType: 'native_api' },
    ...overrides,
  } as Model;
}

function fakeAdapter(name: string): ProviderAdapter {
  return {
    getName: () => name,
  } as unknown as ProviderAdapter;
}

function fakeRegistry(adapterByProvider: Record<string, ProviderAdapter | null>): ProviderRegistry {
  return {
    resolveAdapterForModel: (model: Model) => {
      const adapter = adapterByProvider[model.provider] ?? null;
      return {
        adapter,
        operability: {
          runnable: !!adapter,
          originProvider: model.provider,
          executionProvider: model.provider,
          resolvedProvider: adapter ? model.provider : null,
          fallbackChain: [model.provider],
          nonOperationalReasons: adapter ? [] : ['adapter_missing'],
          warnings: [],
        },
      };
    },
  } as unknown as ProviderRegistry;
}

describe('classifyFallbackError', () => {
  it('classifies AbortError as timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyFallbackError(err).errorClass).toBe('timeout');
  });

  it('classifies HTTP 401 as auth', () => {
    expect(classifyFallbackError({ statusCode: 401, message: 'nope' }).errorClass).toBe('auth');
  });

  it('classifies quota messages even with 200 status', () => {
    const r = classifyFallbackError(new Error('Insufficient credits to run model'));
    expect(r.errorClass).toBe('quota_exhausted');
  });

  it('classifies HTTP 429 as rate_limit', () => {
    expect(classifyFallbackError({ status: 429, message: 'tpm hit' }).errorClass).toBe(
      'rate_limit',
    );
  });

  it('classifies "not supported" messages as capability_mismatch', () => {
    expect(
      classifyFallbackError(new Error('embeddings not supported by this provider')).errorClass,
    ).toBe('capability_mismatch');
  });

  it('classifies HTTP 503 as provider_unavailable', () => {
    expect(classifyFallbackError({ statusCode: 503, message: 'down' }).errorClass).toBe(
      'provider_unavailable',
    );
  });

  it('classifies HTTP 404 as not_found', () => {
    expect(classifyFallbackError({ statusCode: 404, message: 'no such' }).errorClass).toBe(
      'not_found',
    );
  });

  it('falls through to other for unrecognized shapes', () => {
    expect(classifyFallbackError({ statusCode: 500, message: 'kaboom' }).errorClass).toBe('other');
    expect(classifyFallbackError(null).errorClass).toBe('other');
  });
});

describe('selectCandidates', () => {
  const catalog: Model[] = [
    fakeModel({ id: 'a-emb', name: 'ada-embed', provider: 'openai' }),
    fakeModel({ id: 'a-chat', name: 'ada-embed', provider: 'aihubmix', capabilities: ['chat'] }),
    fakeModel({ id: 'b-emb', name: 'voyage-3', provider: 'voyage' }),
  ];

  it('returns all rows that declare the capability when explicit is empty', () => {
    const result = selectCandidates({ catalog, capabilities: ['embeddings'] });
    expect(result.map((m) => m.id).sort()).toEqual(['a-emb', 'b-emb']);
  });

  it('matches explicit name across providers and only those declaring the capability', () => {
    const result = selectCandidates({
      catalog,
      capabilities: ['embeddings'],
      explicit: 'ada-embed',
    });
    // a-chat has the same name but different capability → excluded.
    expect(result.map((m) => m.id)).toEqual(['a-emb']);
  });

  it('returns empty when explicit does not exist', () => {
    expect(
      selectCandidates({ catalog, capabilities: ['embeddings'], explicit: 'fictional-model' }),
    ).toEqual([]);
  });

  it('treats explicit "auto" as no-explicit', () => {
    const result = selectCandidates({ catalog, capabilities: ['embeddings'], explicit: 'auto' });
    expect(result.map((m) => m.id).sort()).toEqual(['a-emb', 'b-emb']);
  });
});

describe('executeWithFallback', () => {
  it('returns first success and includes attempt log', async () => {
    const a = fakeModel({ id: 'a', name: 'a', provider: 'openai' });
    const b = fakeModel({ id: 'b', name: 'b', provider: 'voyage' });
    const adapter = fakeAdapter('openai');
    const registry = fakeRegistry({ openai: adapter, voyage: fakeAdapter('voyage') });

    const execute = vi.fn(async (model: Model) => `ok:${model.id}`);

    const result = await executeWithFallback<string>({
      capability: 'embeddings',
      registry,
      catalog: [a, b],
      execute,
    });

    expect(result.response).toBe('ok:a');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ provider: 'openai', status: 'success' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('falls through on candidate failure and classifies the error', async () => {
    const a = fakeModel({ id: 'a', name: 'a', provider: 'openai' });
    const b = fakeModel({ id: 'b', name: 'b', provider: 'voyage' });
    const registry = fakeRegistry({ openai: fakeAdapter('openai'), voyage: fakeAdapter('voyage') });

    const execute = vi.fn(async (model: Model) => {
      if (model.id === 'a') {
        const err = Object.assign(new Error('429 too many requests'), { statusCode: 429 });
        throw err;
      }
      return `ok:${model.id}`;
    });

    const result = await executeWithFallback<string>({
      capability: 'embeddings',
      registry,
      catalog: [a, b],
      execute,
    });

    expect(result.response).toBe('ok:b');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({
      provider: 'openai',
      status: 'failed',
      errorClass: 'rate_limit',
      statusCode: 429,
    });
    expect(result.attempts[1]).toMatchObject({ provider: 'voyage', status: 'success' });
  });

  it('throws FallbackExhaustedError carrying every attempt when all fail', async () => {
    const a = fakeModel({ id: 'a', name: 'a', provider: 'openai' });
    const b = fakeModel({ id: 'b', name: 'b', provider: 'voyage' });
    const registry = fakeRegistry({ openai: fakeAdapter('openai'), voyage: fakeAdapter('voyage') });

    const execute = vi.fn(async () => {
      throw Object.assign(new Error('insufficient credits'), { statusCode: 402 });
    });

    await expect(
      executeWithFallback({
        capability: 'embeddings',
        registry,
        catalog: [a, b],
        execute,
      }),
    ).rejects.toMatchObject({
      name: 'FallbackExhaustedError',
      statusCode: 503,
      code: 'capability_dependency_unavailable',
    });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('throws NoFallbackCandidateError when no row declares the capability', async () => {
    const onlyChat = fakeModel({
      id: 'c',
      name: 'c',
      provider: 'openai',
      capabilities: ['chat'],
    });
    const registry = fakeRegistry({ openai: fakeAdapter('openai') });

    await expect(
      executeWithFallback({
        capability: 'embeddings',
        registry,
        catalog: [onlyChat],
        execute: vi.fn(),
      }),
    ).rejects.toMatchObject({
      name: 'NoFallbackCandidateError',
      statusCode: 404,
      code: 'no_capability_candidates',
    });
  });

  it('throws NoFallbackCandidateError when explicit name does not exist', async () => {
    const a = fakeModel({ id: 'a', name: 'a', provider: 'openai' });
    const registry = fakeRegistry({ openai: fakeAdapter('openai') });

    await expect(
      executeWithFallback({
        capability: 'embeddings',
        explicit: 'fictional-model',
        registry,
        catalog: [a],
        execute: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(NoFallbackCandidateError);
  });

  it('drops candidates whose adapter fails the supportsCapability probe', async () => {
    const a = fakeModel({ id: 'a', name: 'a', provider: 'openai' });
    const b = fakeModel({ id: 'b', name: 'b', provider: 'voyage' });
    const adapterA = fakeAdapter('openai');
    const adapterB = fakeAdapter('voyage');
    const registry = fakeRegistry({ openai: adapterA, voyage: adapterB });

    const execute = vi.fn(async (model: Model) => `ok:${model.id}`);
    const supportsCapability = vi.fn(
      (adapter: ProviderAdapter) => adapter.getName() !== 'openai',
    );

    const result = await executeWithFallback<string>({
      capability: 'embeddings',
      registry,
      catalog: [a, b],
      execute,
      supportsCapability,
    });

    expect(result.response).toBe('ok:b');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].provider).toBe('voyage');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('respects maxCandidates upper bound', async () => {
    const models = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      fakeModel({ id, name: id, provider: id }),
    );
    const adapters = Object.fromEntries(models.map((m) => [m.provider, fakeAdapter(m.provider)]));
    const registry = fakeRegistry(adapters);
    const execute = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(
      executeWithFallback({
        capability: 'embeddings',
        registry,
        catalog: models,
        execute,
        maxCandidates: 2,
      }),
    ).rejects.toMatchObject({ name: 'FallbackExhaustedError' });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('deadlineMs:0 (allow_fallback:false) still tries exactly the first candidate, not zero (regression, found live 2026-07-16)', async () => {
    const a = fakeModel({ id: 'a', name: 'a', provider: 'openai' });
    const b = fakeModel({ id: 'b', name: 'b', provider: 'voyage' });
    const registry = fakeRegistry({ openai: fakeAdapter('openai'), voyage: fakeAdapter('voyage') });
    const execute = vi.fn(async (model: Model) => `ok:${model.id}`);

    const result = await executeWithFallback<string>({
      capability: 'embeddings',
      registry,
      catalog: [a, b],
      execute,
      deadlineMs: 0,
    });

    expect(result.response).toBe('ok:a');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('deadlineMs:0 stops after the first failed candidate — never tries a second', async () => {
    const a = fakeModel({ id: 'a', name: 'a', provider: 'openai' });
    const b = fakeModel({ id: 'b', name: 'b', provider: 'voyage' });
    const registry = fakeRegistry({ openai: fakeAdapter('openai'), voyage: fakeAdapter('voyage') });
    const execute = vi.fn(async () => {
      throw Object.assign(new Error('down'), { statusCode: 503 });
    });

    await expect(
      executeWithFallback({
        capability: 'embeddings',
        registry,
        catalog: [a, b],
        execute,
        deadlineMs: 0,
      }),
    ).rejects.toMatchObject({ name: 'FallbackExhaustedError' });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('orders candidates by retry-candidate-ranking (tier wins over insertion order)', async () => {
    const aggregator = fakeModel({
      id: 'agg',
      name: 'shared',
      provider: 'aihubmix',
      metadata: { sourceType: 'aggregator' },
    });
    const native = fakeModel({
      id: 'nat',
      name: 'shared',
      provider: 'openai',
      metadata: { sourceType: 'native_api' },
    });
    const registry = fakeRegistry({
      aihubmix: fakeAdapter('aihubmix'),
      openai: fakeAdapter('openai'),
    });

    const execute = vi.fn(async (model: Model) => `ok:${model.provider}`);

    const result = await executeWithFallback<string>({
      capability: 'embeddings',
      // catalog order is aggregator-first to verify ranking re-orders it.
      catalog: [aggregator, native],
      registry,
      execute,
    });

    expect(result.response).toBe('ok:openai');
    expect(result.attempts[0].provider).toBe('openai');
  });
});

/**
 * parallelDegree dial — racing top-N cuts cold-start latency for audio.
 * The pins:
 *   1. parallelDegree=N races first N candidates with Promise.any semantics
 *      (first success wins; slower in-flight racers continue but are not
 *      awaited).
 *   2. When all racers fail, sequential fallback resumes from candidate
 *      (N+1) — racers are NOT retried.
 *   3. attempts[] records every candidate that started, regardless of
 *      whether it raced or ran sequentially.
 *   4. parallelDegree is clamped to [1, queue.length] — passing absurd
 *      values doesn't break anything.
 *   5. parallelDegree=1 (or omitted) is bit-identical to the sequential
 *      contract.
 */
describe('executeWithFallback — parallelDegree', () => {
  it('races first N and returns the winner; sequential phase is skipped', async () => {
    const a = fakeModel({ id: 'a', name: 'a', provider: 'openai' });
    const b = fakeModel({ id: 'b', name: 'b', provider: 'voyage' });
    const c = fakeModel({ id: 'c', name: 'c', provider: 'cohere' });
    const registry = fakeRegistry({
      openai: fakeAdapter('openai'),
      voyage: fakeAdapter('voyage'),
      cohere: fakeAdapter('cohere'),
    });

    // All three succeed; the racer that resolves first should win. Because
    // the inner promises run concurrently, the order is timing-dependent —
    // we only assert that we got *some* racer success and that the third
    // (sequential) candidate was NOT executed.
    const execute = vi.fn(async (model: Model) => `ok:${model.id}`);

    const result = await executeWithFallback<string>({
      capability: 'embeddings',
      registry,
      catalog: [a, b, c],
      execute,
      parallelDegree: 2,
    });

    expect(['ok:a', 'ok:b']).toContain(result.response);
    // Only the two racers were awaited. The third candidate may not have
    // been called (race winner short-circuits sequential phase).
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.attempts.find((a) => a.model === 'c')).toBeUndefined();
  });

  it('falls through to sequential when all racers fail', async () => {
    const a = fakeModel({ id: 'a', name: 'a', provider: 'openai' });
    const b = fakeModel({ id: 'b', name: 'b', provider: 'voyage' });
    const c = fakeModel({ id: 'c', name: 'c', provider: 'cohere' });
    const registry = fakeRegistry({
      openai: fakeAdapter('openai'),
      voyage: fakeAdapter('voyage'),
      cohere: fakeAdapter('cohere'),
    });

    // a and b fail (racers); c succeeds (sequential phase).
    const execute = vi.fn(async (model: Model) => {
      if (model.id === 'a' || model.id === 'b') {
        throw Object.assign(new Error('429 too many requests'), { statusCode: 429 });
      }
      return `ok:${model.id}`;
    });

    const result = await executeWithFallback<string>({
      capability: 'embeddings',
      registry,
      catalog: [a, b, c],
      execute,
      parallelDegree: 2,
    });

    expect(result.response).toBe('ok:c');
    expect(result.attempts).toHaveLength(3);
    // Both racer failures are classified.
    const racerAttempts = result.attempts.filter((a) => a.model === 'a' || a.model === 'b');
    expect(racerAttempts).toHaveLength(2);
    expect(racerAttempts.every((a) => a.errorClass === 'rate_limit')).toBe(true);
    expect(result.attempts.find((a) => a.model === 'c')).toMatchObject({ status: 'success' });
  });

  it('one racer wins while siblings fail — both attempts recorded', async () => {
    const a = fakeModel({ id: 'a', name: 'a', provider: 'openai' });
    const b = fakeModel({ id: 'b', name: 'b', provider: 'voyage' });
    const registry = fakeRegistry({
      openai: fakeAdapter('openai'),
      voyage: fakeAdapter('voyage'),
    });

    const execute = vi.fn(async (model: Model) => {
      if (model.id === 'a') {
        throw Object.assign(new Error('insufficient credits'), { statusCode: 402 });
      }
      // Tiny delay so the failing racer pushes its attempt first deterministically.
      await new Promise((r) => setTimeout(r, 5));
      return `ok:${model.id}`;
    });

    const result = await executeWithFallback<string>({
      capability: 'embeddings',
      registry,
      catalog: [a, b],
      execute,
      parallelDegree: 2,
    });

    expect(result.response).toBe('ok:b');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.find((a) => a.provider === 'openai')).toMatchObject({
      status: 'failed',
      errorClass: 'quota_exhausted',
    });
    expect(result.attempts.find((a) => a.provider === 'voyage')).toMatchObject({
      status: 'success',
    });
  });

  it('clamps parallelDegree to queue length without erroring', async () => {
    const a = fakeModel({ id: 'a', name: 'a', provider: 'openai' });
    const registry = fakeRegistry({ openai: fakeAdapter('openai') });

    const execute = vi.fn(async (model: Model) => `ok:${model.id}`);

    // Asking for parallelDegree=99 with one candidate. Should NOT throw —
    // the clamp turns this into "race 1" which collapses to the sequential
    // path.
    const result = await executeWithFallback<string>({
      capability: 'embeddings',
      registry,
      catalog: [a],
      execute,
      parallelDegree: 99,
    });

    expect(result.response).toBe('ok:a');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('parallelDegree=1 is bit-identical to omitting the option', async () => {
    const a = fakeModel({ id: 'a', name: 'a', provider: 'openai' });
    const b = fakeModel({ id: 'b', name: 'b', provider: 'voyage' });
    const registry = fakeRegistry({
      openai: fakeAdapter('openai'),
      voyage: fakeAdapter('voyage'),
    });

    const execute = vi.fn(async (model: Model) => {
      if (model.id === 'a') throw new Error('boom');
      return `ok:${model.id}`;
    });

    const result = await executeWithFallback<string>({
      capability: 'embeddings',
      registry,
      catalog: [a, b],
      execute,
      parallelDegree: 1,
    });

    // Sequential semantics: a is tried first, fails, then b.
    expect(result.response).toBe('ok:b');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ provider: 'openai', status: 'failed' });
    expect(result.attempts[1]).toMatchObject({ provider: 'voyage', status: 'success' });
  });

  it('throws FallbackExhaustedError when racers AND sequential fallback all fail', async () => {
    const a = fakeModel({ id: 'a', name: 'a', provider: 'openai' });
    const b = fakeModel({ id: 'b', name: 'b', provider: 'voyage' });
    const c = fakeModel({ id: 'c', name: 'c', provider: 'cohere' });
    const registry = fakeRegistry({
      openai: fakeAdapter('openai'),
      voyage: fakeAdapter('voyage'),
      cohere: fakeAdapter('cohere'),
    });

    const execute = vi.fn(async () => {
      throw Object.assign(new Error('down'), { statusCode: 503 });
    });

    await expect(
      executeWithFallback({
        capability: 'embeddings',
        registry,
        catalog: [a, b, c],
        execute,
        parallelDegree: 2,
      }),
    ).rejects.toMatchObject({
      name: 'FallbackExhaustedError',
      statusCode: 503,
    });

    expect(execute).toHaveBeenCalledTimes(3);
  });
});
