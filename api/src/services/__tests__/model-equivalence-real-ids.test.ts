// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The equivalence index over REAL catalog ids (fixtures/equivalence-real-ids.tsv,
 * a leaf-closed sample of the 2026-09-24 production export: every row of each
 * selected model name, so the publisher decisions equal production's).
 *
 * On that export the n-gram index this replaced put claude-sonnet-4-6 with 4-5
 * and 4, gpt-oss-120b with 20b, Llama 3.3 with 3.1 and 3, gemini-2.5-flash with
 * flash-image and flash-lite, and 214 owners' llama-2-7b-miniguanaco in one
 * group; a first exact key still put different dated snapshots together
 * (claude-3-5-sonnet-20240620 with -20241022) and a provider's own product with
 * another vendor's model of that name (inworld/tts-1 with OpenAI's tts-1). The
 * properties below are checked with oracles written independently of the key
 * function (tokens of the model name, snapshot stamps, repository owners,
 * namespaces, and what each provider itself lists).
 *
 * Hermetic: Prisma and Redis are mocked; the index is built by the production code.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  REPOSITORY_HOST_PROVIDERS,
  loadRealIdCatalog,
} from './fixtures/equivalence-real-ids.fixture';
import type { FixtureRow } from './fixtures/equivalence-catalog.fixture';

const h = vi.hoisted(() => ({ queryRaw: vi.fn(), findMany: vi.fn() }));

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

import { getAllEntriesForModel } from '@/services/model-catalog-service';
import {
  buildEquivalenceIndex,
  type EquivalenceIndex,
} from '@/services/model-equivalence-clustering';
import {
  getModelEquivalenceService,
  resetModelEquivalenceServiceForTests,
} from '@/services/model-equivalence-service';

const rows: FixtureRow[] = loadRealIdCatalog();
const byUid = new Map(rows.map((r) => [r.uid, r]));
const presentIds = new Set(rows.map((r) => r.modelId));
let index: EquivalenceIndex;

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

// ─── Independent oracles ───────────────────────────────────────────────────

const isYear = (t: string | undefined) => t !== undefined && /^20\d\d$/.test(t);
const isMonth = (t: string | undefined) => t !== undefined && /^(0[1-9]|1[0-2])$/.test(t);
const isDay = (t: string | undefined) => t !== undefined && /^(0[1-9]|[12]\d|3[01])$/.test(t);
const COMPACT_DATE = /^20\d\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;

/**
 * Ordered tokens of the model name (last path segment), without snapshot dates
 * and a trailing "latest": every token that names a version, a size or a
 * variant (4-6 vs 4-5, 120b vs 20b, lite, image, turbo, :free) is kept.
 */
function nameTokens(modelId: string): string {
  const last = modelId.trim().split('/').pop() ?? '';
  const tokens = last
    .toLowerCase()
    .split(/[-._:@\s]+/)
    .filter((t) => t !== '');
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (isYear(tokens[i]) && isMonth(tokens[i + 1]) && isDay(tokens[i + 2])) {
      i += 2;
      continue;
    }
    if (COMPACT_DATE.test(tokens[i])) continue;
    if (i === tokens.length - 2 && isMonth(tokens[i]) && isYear(tokens[i + 1])) break;
    out.push(tokens[i]);
  }
  if (out[out.length - 1] === 'latest') out.pop();
  return out.join(' ');
}

const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const providerLetters = new Set(rows.map((r) => letters(r.providerId)));

/** Path before the model name once leading provider namespaces are dropped, or null. */
function ownerNamespace(modelId: string): string | null {
  const segments = modelId.trim().split('/');
  let start = 0;
  while (segments.length - start >= 2 && providerLetters.has(letters(segments[start]))) start++;
  return segments.length - start >= 2 ? segments.slice(start, -1).join('/').toLowerCase() : null;
}

const STAMP =
  /(?:[-@](20\d\d)-?(0[1-9]|1[0-2])-?(0[1-9]|[12]\d|3[01]))(?=$|[-:@])|-(0[1-9]|1[0-2])-(20\d\d)$/;

/** Snapshot date of the model name ("20240620", "202403" for -03-2024), or "". */
function snapshotStamp(modelId: string): string {
  const leaf = (modelId.split('/').pop() ?? '').toLowerCase().replace(/[._\s]+/g, '-');
  const m = STAMP.exec(leaf);
  if (!m) return '';
  return m[1] ? `${m[1]}${m[2]}${m[3]}` : `${m[5]}${m[4]}`;
}

/** Letters of the segment right before the model name, or "" for a bare id. */
function immediateNamespace(modelId: string): string {
  const segments = modelId.trim().split('/');
  return segments.length >= 2 ? letters(segments[segments.length - 2]) : '';
}

const API_SOURCES = new Set(['native_api', 'cloud_hub', 'router']);

/**
 * `${provider letters}|${name tokens}` for every name a provider lists itself:
 * bare, or (API sources) under a namespace that is not its own.
 */
const servedNames = new Set(
  rows
    .filter((r) => {
      const ns = immediateNamespace(r.modelId);
      return ns === '' || (ns !== letters(r.providerId) && API_SOURCES.has(r.sourceType));
    })
    .map((r) => `${letters(r.providerId)}|${nameTokens(r.modelId)}`)
);

/** The namespace most API providers list a name under (name tokens -> namespace letters). */
const commonNamespace = (() => {
  const counts = new Map<string, Map<string, Set<string>>>();
  for (const r of rows) {
    const ns = immediateNamespace(r.modelId);
    if (ns === '' || !API_SOURCES.has(r.sourceType)) continue;
    const name = nameTokens(r.modelId);
    let byNs = counts.get(name);
    if (!byNs) {
      byNs = new Map();
      counts.set(name, byNs);
    }
    let providers = byNs.get(ns);
    if (!providers) {
      providers = new Set();
      byNs.set(ns, providers);
    }
    providers.add(r.providerId);
  }
  const best = new Map<string, string>();
  for (const [name, byNs] of counts) {
    let top = '';
    let topCount = 0;
    for (const [ns, providers] of byNs) {
      if (providers.size > topCount) {
        top = ns;
        topCount = providers.size;
      }
    }
    best.set(name, top);
  }
  return best;
})();

const groupIds = (key: string) =>
  [...new Set(index.groups.get(key)?.members.map((m) => m.modelId) ?? [])].sort();

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
  h.findMany.mockImplementation(async (args: { where: { uid?: { in: string[] } } }) => {
    const uids = args.where.uid?.in;
    if (!uids) throw new Error('only the uid query is expected: every fixture id is indexed');
    return uids.flatMap((uid) => {
      const row = byUid.get(uid);
      return row ? [prismaRecord(row)] : [];
    });
  });
  await getModelEquivalenceService().buildIndex();
});

afterAll(() => {
  resetModelEquivalenceServiceForTests();
  delete process.env.MODEL_EQUIVALENCE_LAZY_REBUILD;
});

describe('real catalog ids: the fixture', () => {
  it('is the committed sample (every catalog provider, the counterexample families)', () => {
    expect(rows.length).toBe(2429);
    expect(presentIds.size).toBe(1026);
    expect(new Set(rows.map((r) => r.providerId)).size).toBe(106);
    expect(index.groups.size).toBe(706);
  });
});

describe('real catalog ids: no group holds two models', () => {
  it('every member of a group has the same model name tokens (version, size, variant)', () => {
    const mixed: string[] = [];
    for (const [key, group] of index.groups) {
      const names = new Set(group.members.map((m) => nameTokens(m.modelId)));
      if (names.size > 1) mixed.push(`${key}: ${[...names].join(' | ')}`);
    }
    expect(mixed).toEqual([]);
  });

  it('no group holds repositories of two owners (huggingface, featherless-ai)', () => {
    const mixed: string[] = [];
    for (const [key, group] of index.groups) {
      const owners = new Set(
        group.members
          .filter((m) => REPOSITORY_HOST_PROVIDERS.has(m.providerId) && m.modelId.includes('/'))
          .map((m) => m.modelId.split('/')[0].toLowerCase())
      );
      if (owners.size > 1) mixed.push(`${key}: ${[...owners].join(' | ')}`);
    }
    expect(mixed).toEqual([]);
  });

  it('no group holds two different owner namespaces', () => {
    const mixed: string[] = [];
    for (const [key, group] of index.groups) {
      const namespaces = new Set(
        group.members.map((m) => ownerNamespace(m.modelId)).filter((ns) => ns !== null)
      );
      if (namespaces.size > 1) mixed.push(`${key}: ${[...namespaces].join(' | ')}`);
    }
    expect(mixed).toEqual([]);
  });

  it('no group holds two different snapshot dates', () => {
    const mixed: string[] = [];
    for (const [key, group] of index.groups) {
      const stamps = new Set(group.members.map((m) => snapshotStamp(m.modelId)).filter(Boolean));
      if (stamps.size > 1) mixed.push(`${key}: ${[...stamps].join(' | ')}`);
    }
    expect(mixed).toEqual([]);
  });

  it('what one provider lists as two models never shares a group', () => {
    // Evidence from the providers themselves: one provider listing two ids of
    // a group under two different provider namespaces means two products,
    // unless each namespace is that provider's own route, a provider that
    // serves the name itself, or the namespace most providers use for it.
    const conflicts: string[] = [];
    for (const [key, group] of index.groups) {
      const byProvider = new Map<string, string[]>();
      for (const m of group.members) {
        const list = byProvider.get(m.providerId) ?? [];
        if (!list.includes(m.modelId)) list.push(m.modelId);
        byProvider.set(m.providerId, list);
      }
      for (const [providerId, ids] of byProvider) {
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const [a, b] = [ids[i], ids[j]];
            const [stampA, stampB] = [snapshotStamp(a), snapshotStamp(b)];
            if (stampA !== '' && stampB !== '' && stampA !== stampB) {
              conflicts.push(`${key} @${providerId}: ${a} | ${b} (two snapshots)`);
            }
            const [nsA, nsB] = [immediateNamespace(a), immediateNamespace(b)];
            if (nsA === nsB || !providerLetters.has(nsA) || !providerLetters.has(nsB)) continue;
            const name = nameTokens(a);
            const accounted = (ns: string) =>
              ns === letters(providerId) ||
              servedNames.has(`${ns}|${name}`) ||
              commonNamespace.get(name) === ns;
            if (!accounted(nsA) || !accounted(nsB)) {
              conflicts.push(`${key} @${providerId}: ${a} | ${b} (two vendors)`);
            }
          }
        }
      }
    }
    expect(conflicts).toEqual([]);
  });

  it('214 owners of llama-2-7b-miniguanaco are 214 models', () => {
    const repos = rows.filter((r) => r.modelId.toLowerCase().endsWith('/llama-2-7b-miniguanaco'));
    const owners = new Set(repos.map((r) => r.modelId.split('/')[0].toLowerCase()));
    const keys = new Set(repos.map((r) => index.modelToKey.get(r.modelId)));
    expect(repos.length).toBe(426);
    expect(owners.size).toBe(214);
    expect(keys.size).toBe(214);
  });
});

describe('real catalog ids: counterexamples and positive cases', () => {
  const DIFFERENT: string[][] = [
    [
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-sonnet-4',
      '~anthropic/claude-sonnet-latest',
    ],
    ['anthropic/claude-sonnet-4.6', 'anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4'],
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514'],
    ['gpt-oss-120b', 'gpt-oss-20b', 'openai/gpt-oss-safeguard-20b'],
    ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    ['deepinfra/openai/gpt-oss-120b', 'deepinfra/openai/gpt-oss-20b'],
    ['groq/openai/gpt-oss-120b', 'groq/openai/gpt-oss-20b'],
    ['accounts/fireworks/models/gpt-oss-120b', 'accounts/fireworks/models/gpt-oss-20b'],
    ['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b'],
    ['gpt-oss-120b:free', 'gpt-oss-20b:free'],
    ['openai.gpt-oss-120b-1:0', 'openai.gpt-oss-20b-1:0'],
    ['llama-3.3-70b-instruct', 'llama-3.1-70b-instruct', 'llama-3-70b-instruct'],
    [
      'meta-llama/Llama-3.3-70B-Instruct',
      'meta-llama/Llama-3.1-70B-Instruct',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'turboderp/Cat-Llama-3-70B-instruct',
      'unsloth/Llama-3.3-70B-Instruct',
    ],
    ['llama-3.3-70b', 'llama-3-70b'],
    [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash-image',
      'gemini-2.5-flash-preview-09-2025',
    ],
    ['google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash-image'],
    ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
    ['gpt-4o', 'gpt-4', 'gpt-4o-mini'],
    ['o1', 'o1-preview'],
    ['kimi-k2.6', 'kimi-k2.5'],
    ['claude-opus-4-7', 'claude-opus-4-6'],
    ['deepseek-v3', 'deepseek-v3.1'],
    ['devonho/llama-2-7b-miniguanaco', 'mahenpatil/llama-2-7b-miniguanaco'],
    ['Qwen/Qwen3-8B', 'unsloth/Qwen3-8B'],
    [
      'cardiffnlp/twitter-roberta-base-sentiment-latest',
      'cardiffnlp/twitter-roberta-base-sentiment',
    ],
    ['spockren/naruto_lora_xl', 'spockren/naruto-lora-xl'],
    ['whjung/SOLAR-10.7B-instruct-v1.0', 'upstage/SOLAR-10.7B-Instruct-v1.0'],
    ['Columbia-NLP/gemma-2b-zephyr-sft', 'wandb/gemma-2b-zephyr-sft'],
    // Several snapshots of one name: each snapshot is a model, the alias is neither.
    ['claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-latest'],
    ['command-r-03-2024', 'command-r-08-2024', 'command-r'],
    ['command-r-plus-04-2024', 'command-r-plus-08-2024'],
    ['gpt-4o-2024-05-13', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20', 'gpt-4o'],
    ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts-2025-12-15', 'gpt-4o-mini-tts'],
    // A provider's own product and another vendor's model of the same name.
    ['tts-1', 'inworld/tts-1'],
    ['deepgram/zeus', 'trustedrouter/zeus'],
    ['deepgram/athena', 'trustedrouter/athena'],
    ['deepgram/iris', 'trustedrouter/iris'],
    ['deepgram/flux', 'flux'],
    ['openrouter/auto', 'trustedrouter/auto', 'orcarouter/auto', 'fastrouter/auto', 'auto'],
    ['openrouter/free', 'trustedrouter/free', 'orcarouter/free'],
    ['openrouter/fusion', 'trustedrouter/fusion', 'orcarouter/fusion'],
    ['MegaNova/Web-Search', 'web-search'],
  ];

  const SAME: string[][] = [
    [
      'claude-sonnet-4-6',
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-sonnet-4-6',
      'claude-sonnet-4.6',
      'deepinfra/anthropic/claude-sonnet-4-6',
      'vertex/claude-sonnet-4-6',
    ],
    [
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-20250929',
      'anthropic/claude-sonnet-4.5-20250929',
      'anthropic/claude-sonnet-4.5',
    ],
    ['claude-sonnet-4', 'claude-sonnet-4-20250514', 'anthropic/claude-sonnet-4-20250514'],
    [
      'gpt-oss-120b',
      'openai/gpt-oss-120b',
      'groq/openai/gpt-oss-120b',
      'deepinfra/openai/gpt-oss-120b',
      'together_ai/openai/gpt-oss-120b',
      'anthropic/pioneer/openai/gpt-oss-120b',
      'cerebras/gpt-oss-120b',
      'fireworks_ai/gpt-oss-120b',
    ],
    ['gpt-oss-20b', 'openai/gpt-oss-20b', 'GPT-OSS-20B', 'groq/openai/gpt-oss-20b'],
    [
      'llama-3.3-70b-instruct',
      'meta-llama/Llama-3.3-70B-Instruct',
      'meta-llama/llama-3.3-70b-instruct',
      'deepinfra/meta-llama/Llama-3.3-70B-Instruct',
      'novita/meta-llama/llama-3.3-70b-instruct',
    ],
    ['gemini-2.5-flash', 'google/gemini-2.5-flash', 'deepinfra/google/gemini-2.5-flash'],
    ['gemini-2.5-flash-lite', 'google/gemini-2.5-flash-lite'],
    // gpt-4o has three dated snapshots: each is its own model (see DIFFERENT).
    ['gpt-4o', 'openai/gpt-4o', 'anthropic/pioneer/gpt-4o'],
    ['gpt-4o-2024-11-20', 'openai/gpt-4o-2024-11-20'],
    ['grok-4', 'x-ai/grok-4', 'xai/grok-4'],
    ['kimi-k2.6', 'moonshotai/Kimi-K2.6', 'moonshotai/kimi-k2.6', 'moonshot/kimi-k2.6'],
    ['command-a', 'cohere/command-a', 'cohere/command-a-03-2025'],
    ['mistral-large-latest', 'mistral/mistral-large-latest'],
    ['claude-haiku-4-5', 'claude-haiku-4.5'],
    ['qwen3-8b', 'Qwen/Qwen3-8B', 'qwen/qwen3-8b', 'alibaba/qwen3-8b'],
    ['tts-1', 'openai/tts-1'],
    ['claude-3-5-sonnet-20240620', 'anthropic/claude-3-5-sonnet-20240620'],
    ['claude-3-5-sonnet', 'claude-3-5-sonnet-latest', 'anthropic/claude-3.5-sonnet'],
    // The vendor's org namespace joins the name once the provider namespace
    // that serves it no longer blocks it, and hosts' routes join too.
    ['deepseek-v4-pro', 'deepseek/deepseek-v4-pro', 'deepseek-ai/DeepSeek-V4-Pro'],
    [
      'glm-5.2',
      'z-ai/glm-5.2',
      'zai/glm-5.2',
      'zai-org/GLM-5.2',
      'phala/glm-5.2',
      'perplexity/glm-5.2',
      'deepinfra/glm-5.2',
    ],
  ];

  it('every id named here is a real catalog id present in the fixture', () => {
    const missing = [...DIFFERENT, ...SAME].flat().filter((id) => !presentIds.has(id));
    expect(missing).toEqual([]);
  });

  it.each(DIFFERENT.map((ids) => [ids.join(' vs '), ids] as const))(
    'different models, different groups: %s',
    (_label, ids) => {
      const keys = ids.map((id) => index.modelToKey.get(id));
      expect(new Set(keys).size).toBe(ids.length);
    }
  );

  it.each(SAME.map((ids) => [ids[0], ids] as const))('one model, one group: %s', (_label, ids) => {
    const keys = new Set(ids.map((id) => index.modelToKey.get(id)));
    expect(keys.size).toBe(1);
  });

  it('the counterexample groups hold exactly these ids', () => {
    expect(groupIds('claude-sonnet-4-6')).toEqual([
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-sonnet-4.6',
      'claude-sonnet-4-6',
      'claude-sonnet-4.6',
      'deepinfra/anthropic/claude-sonnet-4-6',
      'vertex/claude-sonnet-4-6',
    ]);
    expect(groupIds('gpt-oss-20b')).toEqual([
      'GPT-OSS-20B',
      'anthropic/pioneer/openai/gpt-oss-20b',
      'deepinfra/openai/gpt-oss-20b',
      'gpt-oss-20b',
      'groq/openai/gpt-oss-20b',
      'openai/gpt-oss-20b',
      'phala/gpt-oss-20b',
      'together_ai/openai/gpt-oss-20b',
    ]);
    expect(groupIds('llama-3-3-70b-instruct')).toEqual([
      'anthropic/pioneer/meta-llama/Llama-3.3-70B-Instruct',
      'deepinfra/meta-llama/Llama-3.3-70B-Instruct',
      'llama-3.3-70b-instruct',
      'meta-llama/Llama-3.3-70B-Instruct',
      'meta-llama/llama-3.3-70b-instruct',
      'novita/meta-llama/llama-3.3-70b-instruct',
    ]);
    expect(groupIds('gemini-2-5-flash')).toEqual([
      'deepinfra/google/gemini-2.5-flash',
      'gemini-2.5-flash',
      'google/gemini-2.5-flash',
    ]);
    expect(groupIds('gemini-2-5-flash-lite')).toEqual([
      'gemini-2.5-flash-lite',
      'google/gemini-2.5-flash-lite',
    ]);
    expect(groupIds('tts-1')).toEqual(['openai/tts-1', 'tts-1']);
    expect(groupIds('claude-3-5-sonnet@20240620')).toEqual([
      'anthropic/claude-3-5-sonnet-20240620',
      'claude-3-5-sonnet-20240620',
    ]);
    expect(groupIds('claude-3-5-sonnet')).toEqual([
      'anthropic/claude-3-5-sonnet',
      'anthropic/claude-3.5-sonnet',
      'claude-3-5-sonnet',
      'claude-3-5-sonnet-latest',
    ]);
    expect(index.groups.get('claude-sonnet-4-6')?.members).toHaveLength(40);
    expect(index.groups.get('gpt-oss-20b')?.members).toHaveLength(37);
  });
});

describe('real catalog ids: consumers', () => {
  const TIER: Record<string, number> = { native_api: 0, cloud_hub: 1, router: 2, aggregator: 3 };

  it("getEquivalentModels of a repository returns only that owner's repository", () => {
    const group = getModelEquivalenceService().getEquivalentModels(
      'devonho/llama-2-7b-miniguanaco'
    );
    expect(group?.members.map((m) => `${m.modelId}@${m.providerId}`)).toEqual([
      'devonho/llama-2-7b-miniguanaco@huggingface',
      'devonho/llama-2-7b-miniguanaco@featherless-ai',
    ]);
    expect(
      getModelEquivalenceService().getEquivalentModels('someorg/llama-2-7b-miniguanaco')
    ).toBeNull();
  });

  it('getAllEntriesForModel returns, for every fixture id, exactly the rows of that model, native first', async () => {
    const rowsOfKey = new Map<string, Set<string>>();
    for (const r of rows) {
      const key = index.modelToKey.get(r.modelId) ?? '';
      let set = rowsOfKey.get(key);
      if (!set) {
        set = new Set();
        rowsOfKey.set(key, set);
      }
      set.add(`${r.modelId}@${r.providerId}`);
    }

    const wrong: string[] = [];
    for (const id of presentIds) {
      const entries = await getAllEntriesForModel(id);
      const got = entries.map((m) => `${m.id}@${m.provider}`);
      const expected = [...(rowsOfKey.get(index.modelToKey.get(id) ?? '') ?? [])].sort();
      if (JSON.stringify([...got].sort()) !== JSON.stringify(expected)) {
        wrong.push(`${id}: got ${got.length}, expected ${expected.length}`);
        continue;
      }
      const tiers = entries.map((m) => {
        const sourceType = (m.metadata as { sourceType?: string } | undefined)?.sourceType ?? '';
        return TIER[sourceType] ?? 9;
      });
      if (tiers.some((tier, i) => i > 0 && tier < tiers[i - 1]))
        wrong.push(`${id}: not native first`);
    }
    expect(wrong).toEqual([]);
  });
});
