// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * getAllEntriesForModel(): the requested model on every provider that lists
 * it, never another model (2026-09-24, strict equivalence grouping).
 *
 * Every caller (provider-registry.findModel(), the base-strategy cross-provider
 * retry, the single-model balance retry) uses the result as "the same model on
 * another provider". The n-gram index this replaced grouped claude-sonnet-4-6
 * with 4-5 and 4, gpt-oss-120b with 20b and 214 owners' llama-2-7b-miniguanaco
 * repositories, and the identity filter on top of it still let the owners
 * through. The ids below are real catalog ids (export of 2026-09-24).
 *
 * Hermetic: Prisma and Redis are mocked (a small in-memory catalog); the
 * equivalence index is built for real by the production code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCatalogPublishScript } from './fake-catalog-redis';

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  findMany: vi.fn(),
  redis: new Map<string, string>(),
}));

vi.mock('@/database/client', () => ({
  prisma: { $queryRaw: h.queryRaw, model: { findMany: h.findMany } },
  Prisma: {},
}));

vi.mock('@/cache/redis-client', () => ({
  getRedisClient: () => ({
    get: async (key: string) => h.redis.get(key) ?? null,
    set: async (key: string, value: string) => {
      h.redis.set(key, value);
      return 'OK';
    },
    del: async (key: string) => (h.redis.delete(key) ? 1 : 0),
    eval: async (script: unknown, numKeys: unknown, ...args: unknown[]) =>
      runCatalogPublishScript(h.redis, script, numKeys, ...args),
  }),
}));

import {
  getAllCatalogModels,
  getAllEntriesForModel,
  getCatalogIndices,
  invalidateCatalogCache,
} from '@/services/model-catalog-service';
import {
  getModelEquivalenceService,
  resetModelEquivalenceServiceForTests,
} from '@/services/model-equivalence-service';

interface CatalogRow {
  uid: string;
  modelId: string;
  providerId: string;
  sourceType: string;
}

const SPEC: Array<[string, string, string]> = [
  // claude-sonnet 4.6 / 4.5 / 4
  ['claude-sonnet-4-6', 'anthropic', 'native_api'],
  ['anthropic/claude-sonnet-4.6', 'openrouter', 'cloud_hub'],
  ['claude-sonnet-4-6', 'aihubmix', 'cloud_hub'],
  ['deepinfra/anthropic/claude-sonnet-4-6', 'edenai', 'cloud_hub'],
  ['claude-sonnet-4.6', 'poe', 'cloud_hub'],
  ['claude-sonnet-4-5', 'venice', 'native_api'],
  ['claude-sonnet-4-5-20250929', 'anthropic', 'native_api'],
  ['anthropic/claude-sonnet-4.5', 'openrouter', 'router'],
  ['claude-sonnet-4-5-20250929-thinking', 'nanogpt', 'cloud_hub'],
  ['bedrock/claude-sonnet-4-5@eu-central-1', 'requesty', 'cloud_hub'],
  ['claude-sonnet-4-20250514', 'anthropic', 'native_api'],
  ['anthropic/claude-sonnet-4', 'openrouter', 'router'],
  // gpt-oss 120b / 20b
  ['gpt-oss-120b', 'groq', 'native_api'],
  ['openai/gpt-oss-120b', 'deepinfra', 'native_api'],
  ['deepinfra/openai/gpt-oss-120b', 'edenai', 'cloud_hub'],
  ['gpt-oss-20b', 'groq', 'native_api'],
  ['openai/gpt-oss-20b', 'deepinfra', 'native_api'],
  ['deepinfra/openai/gpt-oss-20b', 'edenai', 'cloud_hub'],
  ['openai/gpt-oss-safeguard-20b', 'openrouter', 'router'],
  ['accounts/fireworks/models/gpt-oss-20b', 'fireworks-ai', 'native_api'],
  // Llama 3.3 / 3.1 70B
  ['meta-llama/Llama-3.3-70B-Instruct', 'deepinfra', 'native_api'],
  ['meta-llama/llama-3.3-70b-instruct', 'openrouter', 'router'],
  ['llama-3.3-70b-instruct', 'novita', 'cloud_hub'],
  ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'togetherai', 'cloud_hub'],
  ['llama-3.1-70b-instruct', 'novita', 'cloud_hub'],
  ['meta-llama/Llama-3.1-70B-Instruct', 'deepinfra', 'native_api'],
  ['RedHatAI/Llama-3.3-70B-Instruct', 'huggingface', 'aggregator'],
  // Gemini 2.5 Flash / Flash-Lite / Flash-Image
  ['gemini-2.5-flash', 'gemini-openai', 'native_api'],
  ['google/gemini-2.5-flash', 'openrouter', 'router'],
  ['gemini-2.5-flash-lite', 'gemini-openai', 'native_api'],
  ['google/gemini-2.5-flash-lite', 'openrouter', 'router'],
  ['google/gemini-2.5-flash-image', 'openrouter', 'router'],
  // One repository name, several owners.
  ['devonho/llama-2-7b-miniguanaco', 'huggingface', 'aggregator'],
  ['devonho/llama-2-7b-miniguanaco', 'featherless-ai', 'aggregator'],
  ['mahenpatil/llama-2-7b-miniguanaco', 'huggingface', 'aggregator'],
  ['mahenpatil/llama-2-7b-miniguanaco', 'featherless-ai', 'aggregator'],
  // -preview and -vN are other models.
  ['o1', 'openai', 'native_api'],
  ['openai/o1-preview', 'openrouter', 'router'],
  ['deepseek-v3', 'deepseek', 'native_api'],
  ['deepseek/deepseek-v3', 'openrouter', 'router'],
  ['deepseek-v4', 'deepseek', 'native_api'],
  // A provider that names its own products with its own namespace.
  ['deepgram/aura-2', 'deepgram', 'native_api'],
];

/** Provider display name (Model.provider); the provider id by default. */
let displayName = (providerId: string): string => providerId;

let catalog: CatalogRow[] = [];

function resetCatalog(): void {
  catalog = SPEC.map(([modelId, providerId, sourceType], i) => ({
    uid: `u${String(i).padStart(3, '0')}`,
    modelId,
    providerId,
    sourceType,
  }));
}

function prismaRecord(row: CatalogRow) {
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
    provider: { name: displayName(row.providerId) },
  };
}

type IdFilter = { in?: string[]; startsWith?: string };
interface FindManyArgs {
  where: {
    uid?: { in: string[] };
    OR?: Array<{ id: IdFilter }>;
    status?: unknown;
  };
}

const matchesId = (id: string, filter: IdFilter): boolean =>
  (filter.in?.includes(id) ?? false) ||
  (filter.startsWith !== undefined && id.startsWith(filter.startsWith));

/** The query shapes getAllEntriesForModel() and the catalog load issue, answered from `catalog`. */
async function fakeFindMany(args: FindManyArgs) {
  const { where } = args;
  if (where.uid) {
    const uids = where.uid.in;
    return catalog.filter((r) => uids.includes(r.uid)).map(prismaRecord);
  }
  if (where.OR) {
    const clauses = where.OR;
    return catalog.filter((r) => clauses.some((c) => matchesId(r.modelId, c.id))).map(prismaRecord);
  }
  return catalog.map(prismaRecord); // the full catalog load (getAllCatalogModels)
}

const savedLazy = process.env.MODEL_EQUIVALENCE_LAZY_REBUILD;

async function buildIndex(): Promise<void> {
  h.queryRaw.mockResolvedValue(
    catalog.map((r) => ({
      uid: r.uid,
      modelId: r.modelId,
      providerId: r.providerId,
      providerName: r.providerId,
      sourceType: r.sourceType,
    }))
  );
  await getModelEquivalenceService().buildIndex();
}

beforeEach(() => {
  resetModelEquivalenceServiceForTests();
  invalidateCatalogCache();
  h.redis.clear();
  process.env.MODEL_EQUIVALENCE_LAZY_REBUILD = 'false';
  h.queryRaw.mockReset();
  h.findMany.mockReset();
  h.findMany.mockImplementation(fakeFindMany);
  resetCatalog();
});

afterEach(() => {
  displayName = (providerId) => providerId;
  resetModelEquivalenceServiceForTests();
  invalidateCatalogCache();
  if (savedLazy === undefined) delete process.env.MODEL_EQUIVALENCE_LAZY_REBUILD;
  else process.env.MODEL_EQUIVALENCE_LAZY_REBUILD = savedLazy;
});

const entries = async (modelId: string) =>
  (await getAllEntriesForModel(modelId)).map((m) => `${m.id}@${m.provider}`);

describe('getAllEntriesForModel with the index: the requested model only', () => {
  beforeEach(buildIndex);

  it('claude-sonnet-4-6: every spelling of 4.6 on every provider, native first, never 4.5 or 4', async () => {
    const expected = [
      'claude-sonnet-4-6@anthropic',
      'anthropic/claude-sonnet-4.6@openrouter',
      'claude-sonnet-4-6@aihubmix',
      'deepinfra/anthropic/claude-sonnet-4-6@edenai',
      'claude-sonnet-4.6@poe',
    ];
    expect(await entries('claude-sonnet-4-6')).toEqual(expected);
    const uidQuery = h.findMany.mock.calls[0][0] as FindManyArgs;
    expect(uidQuery.where.uid?.in).toHaveLength(5);
    // Another spelling of the same model resolves to the same rows.
    expect(await entries('anthropic/claude-sonnet-4.6')).toEqual(expected);
    expect(await entries('Claude-Sonnet-4.6')).toEqual(expected);

    // The dated snapshot is 4.5 too; the -thinking and @region variants are not.
    expect(await entries('claude-sonnet-4-5')).toEqual([
      'claude-sonnet-4-5@venice',
      'claude-sonnet-4-5-20250929@anthropic',
      'anthropic/claude-sonnet-4.5@openrouter',
    ]);
    expect(await entries('claude-sonnet-4')).toEqual([
      'claude-sonnet-4-20250514@anthropic',
      'anthropic/claude-sonnet-4@openrouter',
    ]);
  });

  it('gpt-oss-20b never returns a 120b or safeguard spelling', async () => {
    expect(await entries('gpt-oss-20b')).toEqual([
      'gpt-oss-20b@groq',
      'openai/gpt-oss-20b@deepinfra',
      'deepinfra/openai/gpt-oss-20b@edenai',
    ]);
    expect(await entries('openai/gpt-oss-120b')).toEqual([
      'gpt-oss-120b@groq',
      'openai/gpt-oss-120b@deepinfra',
      'deepinfra/openai/gpt-oss-120b@edenai',
    ]);
  });

  it("llama-3.3-70b-instruct never returns 3.1, Turbo or another owner's copy", async () => {
    expect(await entries('llama-3.3-70b-instruct')).toEqual([
      'meta-llama/Llama-3.3-70B-Instruct@deepinfra',
      'llama-3.3-70b-instruct@novita',
      'meta-llama/llama-3.3-70b-instruct@openrouter',
    ]);
    expect(await entries('llama-3.1-70b-instruct')).toEqual([
      'meta-llama/Llama-3.1-70B-Instruct@deepinfra',
      'llama-3.1-70b-instruct@novita',
    ]);
  });

  it('gemini-2.5-flash never returns flash-lite or flash-image', async () => {
    expect(await entries('gemini-2.5-flash')).toEqual([
      'gemini-2.5-flash@gemini-openai',
      'google/gemini-2.5-flash@openrouter',
    ]);
    expect(await entries('gemini-2.5-flash-lite')).toEqual([
      'gemini-2.5-flash-lite@gemini-openai',
      'google/gemini-2.5-flash-lite@openrouter',
    ]);
  });

  it("a repository returns only its owner's rows", async () => {
    expect(await entries('devonho/llama-2-7b-miniguanaco')).toEqual([
      'devonho/llama-2-7b-miniguanaco@huggingface',
      'devonho/llama-2-7b-miniguanaco@featherless-ai',
    ]);
  });

  it('treats -preview and -vN as different models', async () => {
    expect(await entries('o1')).toEqual(['o1@openai']);
    expect(await entries('openai/o1-preview')).toEqual(['openai/o1-preview@openrouter']);
    expect(await entries('deepseek-v3')).toEqual([
      'deepseek-v3@deepseek',
      'deepseek/deepseek-v3@openrouter',
    ]);
    expect(await entries('deepseek-v4')).toEqual(['deepseek-v4@deepseek']);
  });
});

describe('getAllEntriesForModel without a group: key-checked spelling query', () => {
  it('an id the index does not know gets only same-key rows added after the build', async () => {
    await buildIndex();
    // Listed after the last build: the same new model on two providers, and
    // a repository of another owner with that name.
    catalog.push(
      {
        uid: 'n1',
        modelId: 'claude-sonnet-4-7',
        providerId: 'anthropic',
        sourceType: 'native_api',
      },
      {
        uid: 'n2',
        modelId: 'anthropic/claude-sonnet-4-7',
        providerId: 'openrouter',
        sourceType: 'router',
      },
      {
        uid: 'n3',
        modelId: 'someorg/claude-sonnet-4-7',
        providerId: 'huggingface',
        sourceType: 'aggregator',
      }
    );

    expect(await entries('claude-sonnet-4-7')).toEqual([
      'claude-sonnet-4-7@anthropic',
      'anthropic/claude-sonnet-4-7@openrouter',
    ]);
    expect(h.findMany).toHaveBeenCalledTimes(1);
    const query = h.findMany.mock.calls[0][0] as FindManyArgs;
    expect(query.where.uid).toBeUndefined();
    const spellings = query.where.OR?.[0].id.in ?? [];
    // Catalog provider ids as namespaces, not a hand-maintained vendor list.
    expect(spellings).toEqual(
      expect.arrayContaining([
        'claude-sonnet-4-7',
        'anthropic/claude-sonnet-4-7',
        'openrouter/claude-sonnet-4-7',
      ])
    );
  });

  it('drops whatever the database returns that is not the requested model', async () => {
    await buildIndex();
    h.findMany.mockImplementationOnce(async () =>
      [
        {
          uid: 'x1',
          modelId: 'gemini-3.5-flash',
          providerId: 'gemini-openai',
          sourceType: 'native_api',
        },
        {
          uid: 'x2',
          modelId: 'gemini-3.5-flash-lite',
          providerId: 'gemini-openai',
          sourceType: 'native_api',
        },
        {
          uid: 'x3',
          modelId: 'google/gemini-3.5-flash-image',
          providerId: 'openrouter',
          sourceType: 'router',
        },
        {
          uid: 'x4',
          modelId: 'someorg/gemini-3.5-flash',
          providerId: 'huggingface',
          sourceType: 'aggregator',
        },
      ].map(prismaRecord)
    );
    expect(await entries('gemini-3.5-flash')).toEqual(['gemini-3.5-flash@gemini-openai']);
  });

  it("keeps another vendor's product of the same name out, with the rows' own evidence", async () => {
    await buildIndex();
    // Listed after the last build: a model served by its vendor and a router,
    // and a product of another provider (deepgram serves no "tts-9" itself).
    catalog.push(
      { uid: 'v1', modelId: 'tts-9', providerId: 'openai', sourceType: 'native_api' },
      { uid: 'v2', modelId: 'openai/tts-9', providerId: 'openrouter', sourceType: 'router' },
      { uid: 'v3', modelId: 'deepgram/tts-9', providerId: 'togetherai', sourceType: 'cloud_hub' }
    );
    expect(await entries('tts-9')).toEqual(['tts-9@openai', 'openai/tts-9@openrouter']);
    expect(await entries('deepgram/tts-9')).toEqual(['deepgram/tts-9@togetherai']);
  });

  it('keeps two snapshots of one name apart, and apart from the undated alias', async () => {
    await buildIndex();
    catalog.push(
      { uid: 's1', modelId: 'gpt-9o-2031-01-01', providerId: 'openai', sourceType: 'native_api' },
      { uid: 's2', modelId: 'gpt-9o-2031-06-01', providerId: 'openai', sourceType: 'native_api' },
      { uid: 's3', modelId: 'gpt-9o', providerId: 'openai', sourceType: 'native_api' },
      {
        uid: 's4',
        modelId: 'openai/gpt-9o-2031-01-01',
        providerId: 'openrouter',
        sourceType: 'router',
      }
    );
    expect(await entries('gpt-9o-2031-01-01')).toEqual([
      'gpt-9o-2031-01-01@openai',
      'openai/gpt-9o-2031-01-01@openrouter',
    ]);
    expect(await entries('gpt-9o')).toEqual(['gpt-9o@openai']);
  });

  it('returns nothing for an unknown model', async () => {
    await buildIndex();
    expect(await entries('claude-sonnet-4-7')).toEqual([]);
    expect(await entries('someorg/llama-2-7b-miniguanaco')).toEqual([]);
  });

  it('before the first build: exact and dated spellings, and provider prefixes from the catalog', async () => {
    // No index and no catalog cache yet: exact and dated spellings only.
    expect(getCatalogIndices()).toBeNull();
    expect(await entries('claude-sonnet-4-5')).toEqual([
      'claude-sonnet-4-5@venice',
      'claude-sonnet-4-5-20250929@anthropic',
    ]);
    expect(await entries('devonho/llama-2-7b-miniguanaco')).toEqual([
      'devonho/llama-2-7b-miniguanaco@huggingface',
      'devonho/llama-2-7b-miniguanaco@featherless-ai',
    ]);

    // With the catalog cache loaded, provider ids (Model.providerId, not the
    // display name) are known: the name under a provider that serves it is
    // found too, other models never.
    displayName = (providerId) => `${providerId.toUpperCase()} Inc`;
    await getAllCatalogModels();
    expect(getCatalogIndices()).not.toBeNull();
    expect(await entries('deepseek-v3')).toEqual([
      'deepseek-v3@DEEPSEEK Inc',
      'deepseek/deepseek-v3@OPENROUTER Inc',
    ]);
    expect(await entries('claude-sonnet-4-6')).toEqual([
      'claude-sonnet-4-6@ANTHROPIC Inc',
      'claude-sonnet-4-6@AIHUBMIX Inc',
    ]);
    // A vendor namespace whose provider does not serve the name needs the
    // publisher evidence only the index gathers: fewer rows, never another model.
    expect(await entries('gpt-oss-20b')).toEqual(['gpt-oss-20b@GROQ Inc']);
  });
});
