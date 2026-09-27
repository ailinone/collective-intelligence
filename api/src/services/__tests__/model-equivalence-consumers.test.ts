// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The consumers of the model equivalence index, run for real against the
 * real-id fixture (fixtures/equivalence-real-ids.tsv, production export of
 * 2026-09-24): every one of them uses getAllEntriesForModel() as "the same
 * model on another provider", so each must only ever reach the requested model.
 *
 *   - provider-registry.findModel() (judges, arbiters, fallback chains,
 *     embedding models, capability validation, session re-pins);
 *   - the base-strategy cross-provider retry after a balance or auth error;
 *   - the single-model balance retry of a user-pinned model.
 *
 * With the n-gram index this replaced, a retry of claude-sonnet-4-6 could run
 * 4-5 or 4, and findModel() of an HF repository resolved to another owner's
 * fine-tune (devonho/llama-2-7b-miniguanaco -> mahenpatil/...). A first exact
 * key still let findModel('command-r-03-2024') resolve to command-r-08-2024 and
 * the retry of OpenAI's tts-1 run Inworld's inworld/tts-1.
 *
 * Hermetic: Prisma, Redis, the operability hub and the feedback collector are
 * mocked; the index, getAllEntriesForModel(), ProviderRegistry, BaseStrategy
 * and SingleModelStrategy are the production code with stub adapters.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { loadRealIdCatalog } from './fixtures/equivalence-real-ids.fixture';
import type { FixtureRow } from './fixtures/equivalence-catalog.fixture';

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  findMany: vi.fn(),
  routeState: new Map<string, string>(),
}));

vi.mock('@/database/client', () => ({
  prisma: { $queryRaw: h.queryRaw, model: { findMany: h.findMany } },
  Prisma: {},
}));

vi.mock('@/cache/redis-client', () => ({
  getRedisClient: () => ({
    get: async () => null,
    set: async () => 'OK',
    del: async () => 0,
  }),
}));

vi.mock('@/core/provider-operability-hub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/provider-operability-hub')>();
  const hub = {
    getRouteState: (provider: string, modelId: string) => ({
      operabilityState: h.routeState.get(`${provider}|${modelId}`) ?? 'unknown',
    }),
    isRouteHot: () => false,
    recordRouteExecution: () => undefined,
  };
  return { ...actual, getProviderOperabilityHub: () => hub };
});

vi.mock('@/core/feedback/execution-feedback-collector', () => ({
  getExecutionFeedbackCollector: () => ({ record: () => undefined }),
}));

import { resetProviderHealthRegistryForTesting } from '@/core/operability';
import { BaseStrategy, type StrategyMetadata } from '@/core/orchestration/base-strategy';
import { SingleModelStrategy } from '@/core/orchestration/strategies/single-model-strategy';
import { ProviderRegistry, setProviderRegistry } from '@/providers/provider-registry';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { modelCatalogService } from '@/services/model-catalog-service';
import {
  buildEquivalenceIndex,
  type EquivalenceIndex,
} from '@/services/model-equivalence-clustering';
import {
  getModelEquivalenceService,
  resetModelEquivalenceServiceForTests,
} from '@/services/model-equivalence-service';
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelExecution,
  OrchestrationContext,
  OrchestrationResult,
} from '@/types';

const rows: FixtureRow[] = loadRealIdCatalog();
let index: EquivalenceIndex;

function toModel(row: FixtureRow): Model {
  return {
    id: row.modelId,
    providerId: row.providerId,
    provider: row.providerId,
    name: row.modelId,
    displayName: row.modelId,
    contextWindow: 8000,
    maxOutputTokens: 1000,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat'],
    performance: { latencyMs: 0, throughput: 0, quality: 0, reliability: 0 },
    status: 'active',
    metadata: { sourceType: row.sourceType },
  };
}

function prismaRecord(row: FixtureRow) {
  return {
    uid: row.uid,
    id: row.modelId,
    providerId: row.providerId,
    name: row.modelId,
    displayName: row.modelId,
    contextWindow: 8000,
    maxOutputTokens: 1000,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat'],
    performance: {},
    status: 'active',
    metadata: { sourceType: row.sourceType },
    lastSyncedAt: null,
    provider: { name: row.providerId },
  };
}

type IdFilter = { in?: string[]; startsWith?: string };
async function fakeFindMany(args: {
  where: { uid?: { in: string[] }; OR?: Array<{ id: IdFilter }> };
}) {
  const { where } = args;
  if (where.uid) {
    const uids = new Set(where.uid.in);
    return rows.filter((r) => uids.has(r.uid)).map(prismaRecord);
  }
  const clauses = where.OR ?? [];
  return rows
    .filter((r) =>
      clauses.some(
        (c) =>
          (c.id.in?.includes(r.modelId) ?? false) ||
          (c.id.startsWith !== undefined && r.modelId.startsWith(c.id.startsWith))
      )
    )
    .map(prismaRecord);
}

function row(modelId: string, providerId: string): FixtureRow {
  const found = rows.find((r) => r.modelId === modelId && r.providerId === providerId);
  if (!found) throw new Error(`fixture has no ${modelId} on ${providerId}`);
  return found;
}

const keyOf = (modelId: string): string | undefined => index.modelToKey.get(modelId);

function chatResponse(content: string): ChatResponse {
  return {
    id: 'r',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', logprobs: null },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** Calls the stub adapters received: `${provider} ${request.model}`. */
const calls: string[] = [];
let failingProviders = new Set<string>();

function stubAdapter(name: string): ProviderAdapter {
  const adapter = {
    getName: () => name,
    chatCompletion: async (request: ChatRequest) => {
      calls.push(`${name} ${request.model}`);
      if (failingProviders.has(name)) {
        throw Object.assign(new Error(`${name} HTTP 401 invalid api key`), { statusCode: 401 });
      }
      return chatResponse(`served by ${name}`);
    },
    calculateCost: () => 0.001,
  };
  return adapter as unknown as ProviderAdapter;
}

const registry = new ProviderRegistry();

beforeAll(async () => {
  index = await buildEquivalenceIndex(rows);
  process.env.MODEL_EQUIVALENCE_LAZY_REBUILD = 'false';
  resetModelEquivalenceServiceForTests();
  h.queryRaw.mockResolvedValue(
    rows.map((r) => ({
      uid: r.uid,
      modelId: r.modelId,
      providerId: r.providerId,
      providerName: r.provider,
      sourceType: r.sourceType,
    }))
  );
  h.findMany.mockImplementation(fakeFindMany);
  await getModelEquivalenceService().buildIndex();

  for (const providerId of new Set(rows.map((r) => r.providerId))) {
    registry.register(stubAdapter(providerId));
  }
  setProviderRegistry(registry);
  // Step 1 of findModel (the exact route on the preferred provider) reads the
  // catalog cache; answer it from the fixture.
  vi.spyOn(modelCatalogService, 'getModel').mockImplementation(async (modelId, provider) => {
    const found = rows.find(
      (r) => r.modelId === modelId && (!provider || r.providerId === provider)
    );
    return found ? toModel(found) : null;
  });
});

afterAll(() => {
  resetModelEquivalenceServiceForTests();
  delete process.env.MODEL_EQUIVALENCE_LAZY_REBUILD;
  vi.restoreAllMocks();
});

beforeEach(() => {
  calls.length = 0;
  failingProviders = new Set();
  h.routeState.clear();
  // A failure recorded by one test must not near-zero-skip the next one.
  resetProviderHealthRegistryForTesting();
});

describe('provider-registry.findModel', () => {
  it('without a preferred provider resolves the requested model, never another version', async () => {
    for (const id of [
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'gpt-oss-20b',
      'gemini-2.5-flash-lite',
    ]) {
      const resolved = await registry.findModel(id);
      expect(resolved).not.toBeNull();
      expect(keyOf(resolved?.model.id ?? '')).toBe(keyOf(id));
      expect(resolved?.adapter.getName()).toBe(resolved?.model.provider);
    }
  });

  it('resolves a repository only to its owner (another host of the same repository)', async () => {
    const resolved = await registry.findModel('devonho/llama-2-7b-miniguanaco');
    expect(resolved?.model.id).toBe('devonho/llama-2-7b-miniguanaco');

    // The preferred host is proven bad: the other host of the SAME repository.
    h.routeState.set('huggingface|devonho/llama-2-7b-miniguanaco', 'auth_failed');
    const fallback = await registry.findModel('devonho/llama-2-7b-miniguanaco', 'huggingface');
    expect(fallback?.model.id).toBe('devonho/llama-2-7b-miniguanaco');
    expect(fallback?.adapter.getName()).toBe('featherless-ai');
  });

  it('with a proven-bad preferred provider falls back to the same model elsewhere', async () => {
    h.routeState.set('anthropic|claude-sonnet-4-6', 'no_credits');
    const resolved = await registry.findModel('claude-sonnet-4-6', 'anthropic');
    expect(resolved?.adapter.getName()).not.toBe('anthropic');
    expect(keyOf(resolved?.model.id ?? '')).toBe('claude-sonnet-4-6');
  });

  it('returns null for a model no provider lists, instead of a similar one', async () => {
    expect(await registry.findModel('claude-sonnet-4-7')).toBeNull();
    expect(await registry.findModel('someorg/llama-2-7b-miniguanaco')).toBeNull();
  });

  it("never swaps a provider's own product for another vendor's model of the same name", async () => {
    const tts = await registry.findModel('tts-1');
    expect(keyOf(tts?.model.id ?? '')).toBe('tts-1');
    const inworld = await registry.findModel('inworld/tts-1');
    expect(inworld?.model.id).toBe('inworld/tts-1');
    expect(inworld?.adapter.getName()).toBe('aiml');
    for (const id of ['deepgram/zeus', 'trustedrouter/zeus', 'openrouter/auto', 'deepgram/flux']) {
      expect((await registry.findModel(id))?.model.id).toBe(id);
    }
  });

  it('resolves a dated snapshot only to that snapshot', async () => {
    for (const id of [
      'claude-3-5-sonnet-20240620',
      'command-r-03-2024',
      'gpt-4o-mini-tts-2025-03-20',
      'gpt-4o-2024-05-13',
    ]) {
      const resolved = await registry.findModel(id);
      expect(resolved).not.toBeNull();
      expect(keyOf(resolved?.model.id ?? '')).toBe(keyOf(id));
    }
  });
});

class RetryProbeStrategy extends BaseStrategy {
  getMetadata(): StrategyMetadata {
    return { name: 'single' } as unknown as StrategyMetadata;
  }
  async execute(_r: ChatRequest, _c: OrchestrationContext): Promise<OrchestrationResult> {
    throw new Error('not used');
  }
  run(adapter: ProviderAdapter, model: Model): Promise<ModelExecution> {
    return this.executeModel(adapter, model, {
      model: model.id,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
    });
  }
}

describe('base-strategy cross-provider retry (balance or auth error)', () => {
  it('retries claude-sonnet-4-6 only as claude-sonnet-4-6, on every other provider that lists it', async () => {
    failingProviders = new Set(rows.map((r) => r.providerId)); // every attempt fails
    const execution = await new RetryProbeStrategy().run(
      registry.get('anthropic') as ProviderAdapter,
      toModel(row('claude-sonnet-4-6', 'anthropic'))
    );

    expect(execution.success).toBe(false);
    const [first, ...retries] = calls;
    expect(first).toBe('anthropic claude-sonnet-4-6');
    const expectedRetries = (index.groups.get('claude-sonnet-4-6')?.members ?? [])
      .filter((m) => m.providerId !== 'anthropic')
      .map((m) => `${m.providerId} ${m.modelId}`)
      .sort();
    expect(expectedRetries.length).toBeGreaterThan(30);
    expect([...retries].sort()).toEqual(expectedRetries);
    for (const call of retries) expect(keyOf(call.split(' ')[1])).toBe('claude-sonnet-4-6');
  });

  it('a successful retry returns the same model served by another provider', async () => {
    failingProviders = new Set(['anthropic']);
    const execution = await new RetryProbeStrategy().run(
      registry.get('anthropic') as ProviderAdapter,
      toModel(row('claude-sonnet-4-6', 'anthropic'))
    );

    expect(execution.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(keyOf(execution.modelId)).toBe('claude-sonnet-4-6');
    expect(execution.provider).not.toBe('anthropic');
  });

  it('a repository is retried only on another host of the same repository', async () => {
    failingProviders = new Set(['huggingface', 'featherless-ai']);
    await new RetryProbeStrategy().run(
      registry.get('huggingface') as ProviderAdapter,
      toModel(row('mahenpatil/llama-2-7b-miniguanaco', 'huggingface'))
    );
    expect(calls).toEqual([
      'huggingface mahenpatil/llama-2-7b-miniguanaco',
      'featherless-ai mahenpatil/llama-2-7b-miniguanaco',
    ]);
  });

  it("retries OpenAI's tts-1 only as tts-1, never as Inworld's inworld/tts-1", async () => {
    failingProviders = new Set(rows.map((r) => r.providerId));
    await new RetryProbeStrategy().run(
      registry.get('openai') as ProviderAdapter,
      toModel(row('tts-1', 'openai'))
    );
    const [first, ...retries] = calls;
    expect(first).toBe('openai tts-1');
    expect(retries).toHaveLength((index.groups.get('tts-1')?.members.length ?? 0) - 1);
    for (const call of retries) expect(keyOf(call.split(' ')[1])).toBe('tts-1');
    expect(calls).not.toContain('aiml inworld/tts-1');
  });

  it('no other provider lists the model: no retry, the original error surfaces', async () => {
    failingProviders = new Set(['aws-bedrock']);
    const execution = await new RetryProbeStrategy().run(
      registry.get('aws-bedrock') as ProviderAdapter,
      toModel(row('openai.gpt-oss-120b-1:0', 'aws-bedrock'))
    );
    expect(execution.success).toBe(false);
    expect(execution.error).toContain('HTTP 401');
    // Never the 20b Bedrock model, nor gpt-oss-120b spellings of other catalogs.
    expect(calls).toEqual(['aws-bedrock openai.gpt-oss-120b-1:0']);
  });
});

describe('single-model balance retry of a user-pinned model', () => {
  function pinnedStrategy(pinned: Model) {
    const strategy = new SingleModelStrategy();
    const internals = strategy as unknown as Record<string, unknown>;
    let selected = false;
    internals.emitObserverEvent = vi.fn();
    internals.selectBestModel = vi.fn(async () => {
      if (selected) return null;
      selected = true;
      return { model: pinned, adapter: registry.get(pinned.provider) };
    });
    internals.getAdapterForModel = async (entry: Model) => registry.get(entry.provider) ?? null;
    // The retry loop under test calls executeModel once per entry; a 402 on the
    // failing providers, success elsewhere.
    internals.executeModel = vi.fn(
      async (
        adapter: ProviderAdapter,
        model: Model,
        request: ChatRequest
      ): Promise<ModelExecution> => {
        const provider = adapter.getName();
        calls.push(`${provider} ${request.model}`);
        const failed = failingProviders.has(provider);
        return {
          modelId: model.id,
          modelName: model.name,
          provider,
          role: 'primary',
          request,
          response: chatResponse(failed ? '' : `served by ${provider}`),
          cost: 0,
          durationMs: 1,
          success: !failed,
          error: failed ? 'HTTP 402 insufficient credits' : undefined,
        };
      }
    );
    return strategy;
  }

  const context = { requestId: 'req-pinned', qualityTarget: 0 } as unknown as OrchestrationContext;
  const request = (model: string): ChatRequest => ({
    model,
    messages: [{ role: 'user', content: 'hello' }],
  });

  it('a pinned repository is retried only on another host of that repository', async () => {
    failingProviders = new Set(['huggingface']);
    const pinned = toModel(row('devonho/llama-2-7b-miniguanaco', 'huggingface'));
    const result = await pinnedStrategy(pinned).execute(request(pinned.id), context);

    expect(calls).toEqual([
      'huggingface devonho/llama-2-7b-miniguanaco',
      'featherless-ai devonho/llama-2-7b-miniguanaco',
    ]);
    expect(result.metadata?.selectedProvider).toBe('featherless-ai');
  });

  it('a pinned claude-sonnet-4-6 is never retried as 4-5 or 4', async () => {
    failingProviders = new Set(rows.map((r) => r.providerId));
    const pinned = toModel(row('claude-sonnet-4-6', 'anthropic'));
    await expect(pinnedStrategy(pinned).execute(request(pinned.id), context)).rejects.toThrow(
      /Model execution failed/
    );

    const [first, ...retries] = calls;
    expect(first).toBe('anthropic claude-sonnet-4-6');
    expect(retries.length).toBe((index.groups.get('claude-sonnet-4-6')?.members.length ?? 0) - 1);
    for (const call of retries) expect(keyOf(call.split(' ')[1])).toBe('claude-sonnet-4-6');
  });

  it('a pinned dated snapshot is never retried as another snapshot or the alias', async () => {
    failingProviders = new Set(rows.map((r) => r.providerId));
    const pinned = toModel(row('claude-3-5-sonnet-20240620', 'aihubmix'));
    await expect(pinnedStrategy(pinned).execute(request(pinned.id), context)).rejects.toThrow(
      /Model execution failed/
    );

    const [first, ...retries] = calls;
    expect(first).toBe('aihubmix claude-3-5-sonnet-20240620');
    const key = keyOf('claude-3-5-sonnet-20240620');
    expect(key).toBe('claude-3-5-sonnet@20240620');
    expect(retries.length).toBe((index.groups.get(key ?? '')?.members.length ?? 0) - 1);
    for (const call of retries) expect(keyOf(call.split(' ')[1])).toBe(key);
  });
});
