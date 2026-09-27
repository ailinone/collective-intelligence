// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The model equivalence key (2026-09-24): two ids share a group only when they
 * name the same model. The n-gram index this replaced merged different
 * versions, sizes, variants and repository owners (claude-sonnet-4-6 with 4-5
 * and 4, gpt-oss-120b with 20b, llama-3.3-70b with 3.1 and 3, gemini-2.5-flash
 * with flash-lite, 214 owners of llama-2-7b-miniguanaco in one group). Every
 * counterexample family below was merged by the production index in at least
 * one spelling (measured on the 2026-09-24 export), and the review of the
 * first exact key found two more: different dated snapshots of one name
 * (claude-3-5-sonnet-20240620 with -20241022) and a provider's own product
 * with another vendor's model of the same name (inworld/tts-1 with OpenAI's
 * tts-1, deepgram/zeus with trustedrouter/zeus, openrouter/auto with other
 * routers' auto).
 *
 * Hermetic: pure functions only.
 */
import { describe, it, expect } from 'vitest';
import {
  buildEquivalenceIndex,
  createEquivalenceKeyContext,
  equivalenceKey,
  normalizeModelName,
  parseModelName,
  resolveEquivalenceKey,
  withListingEvidence,
  withoutProviderNamespaces,
  type EquivalenceIndex,
} from '@/services/model-equivalence-clustering';
import { row, type FixtureRow } from './fixtures/equivalence-catalog.fixture';

/** Group key of every raw id, and the raw ids of every group. */
async function indexOf(rows: FixtureRow[]): Promise<{
  index: EquivalenceIndex;
  keyOf: (id: string) => string | undefined;
  idsOf: (key: string | undefined) => string[];
}> {
  const index = await buildEquivalenceIndex(rows);
  return {
    index,
    keyOf: (id) => index.modelToKey.get(id),
    idsOf: (key) =>
      [...new Set(index.groups.get(key ?? '')?.members.map((m) => m.modelId) ?? [])].sort(),
  };
}

function expectAllDifferent(keyOf: (id: string) => string | undefined, ids: string[]): void {
  const keys = ids.map((id) => keyOf(id));
  for (const key of keys) expect(key).toBeDefined();
  expect(new Set(keys).size).toBe(ids.length);
}

function expectOneGroup(keyOf: (id: string) => string | undefined, ids: string[]): void {
  const keys = new Set(ids.map((id) => keyOf(id)));
  expect(keys.has(undefined)).toBe(false);
  expect(keys.size).toBe(1);
}

describe('normalizeModelName: case, separators, snapshot dates and -latest only', () => {
  it.each([
    ['Claude_Sonnet 4.6', 'claude-sonnet-4-6'],
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    ['claude-sonnet-4-5@20250929', 'claude-sonnet-4-5'],
    ['gpt-4o-2024-08-06', 'gpt-4o'],
    ['o3-mini-2025-01-31-high', 'o3-mini-high'],
    ['command-a-03-2025', 'command-a'],
    ['mistral-large-latest', 'mistral-large'],
    ['claude-3.7-sonnet-latest', 'claude-3-7-sonnet'],
    ['gemini-2.5-flash-preview-09-2025', 'gemini-2-5-flash-preview'],
  ])('%s -> %s', (raw, normalized) => {
    expect(normalizeModelName(raw)).toBe(normalized);
  });

  it.each([
    'o1-preview',
    'deepseek-v3',
    'gemini-2-0-flash-001',
    'qwen3-235b-a22b-instruct-2507',
    'deepseek-v4-flash-0731',
    'gemini-2-5-pro-preview-05-06',
    'gpt-oss-120b:free',
    'claude-sonnet-4-5:thinking',
    'qwen3:8b',
    'gemini-2-5-flash-lite@eu',
    'claude-sonnet-4-5[1m]',
    'model-20251399',
  ])('keeps every other token significant: %s', (name) => {
    expect(normalizeModelName(name)).toBe(name);
  });

  it('parseModelName gives one canonical stamp for every shape of the same date', () => {
    for (const raw of [
      'claude-sonnet-4-5-2025-09-29',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-5@20250929',
      'Claude-Sonnet-4.5-20250929',
    ]) {
      expect(parseModelName(raw)).toEqual({ base: 'claude-sonnet-4-5', stamp: '20250929' });
    }
    expect(parseModelName('command-r-03-2024')).toEqual({ base: 'command-r', stamp: '202403' });
    expect(parseModelName('claude-3-5-sonnet-latest')).toEqual({
      base: 'claude-3-5-sonnet',
      stamp: '',
    });
    expect(parseModelName('o3-mini-2025-01-31-high')).toEqual({
      base: 'o3-mini-high',
      stamp: '20250131',
    });
  });
});

describe('equivalenceKey: route prefixes, provider namespaces, publishers, repositories', () => {
  const context = createEquivalenceKeyContext(
    [
      'openai',
      'anthropic',
      'deepinfra',
      'groq',
      'togetherai',
      'xai',
      'pioneer',
      'huggingface',
      'inworld',
    ],
    {
      // Which provider serves which name itself (bare, or under another namespace).
      hostedNames: new Set(['openai/gpt-oss-120b', 'openai/tts-1', 'xai/grok-4']),
      publisherOfName: new Map([['llama-3-3-70b-instruct', 'meta-llama']]),
    }
  );

  it('removes route prefixes, and a provider namespace when that provider serves the name', () => {
    for (const id of [
      'gpt-oss-120b',
      'openai/gpt-oss-120b',
      'deepinfra/openai/gpt-oss-120b',
      'groq/openai/gpt-oss-120b',
      'together_ai/openai/gpt-oss-120b',
      'anthropic/pioneer/openai/gpt-oss-120b',
      'GPT-OSS-120B',
    ]) {
      expect(equivalenceKey(id, context)).toBe('gpt-oss-120b');
    }
    expect(equivalenceKey('x-ai/grok-4', context)).toBe('grok-4');
    expect(equivalenceKey('openai/tts-1', context)).toBe('tts-1');
    expect(withoutProviderNamespaces('deepinfra/openai/GPT-OSS-120b', context)).toBe(
      'GPT-OSS-120b'
    );
    // At least one segment is always kept.
    expect(equivalenceKey('openai', context)).toBe('openai');
  });

  it("keeps a provider namespace that does not serve the name: that provider's own product", () => {
    expect(equivalenceKey('inworld/tts-1', context)).toBe('inworld/tts-1');
    expect(equivalenceKey('inworld/tts-1', context)).not.toBe(equivalenceKey('tts-1', context));
    // Kept by its letters and digits, so provider spellings still meet.
    expect(equivalenceKey('x-ai/grok-5-preview', context)).toBe('xai/grok-5-preview');
    expect(equivalenceKey('xai/grok-5-preview', context)).toBe('xai/grok-5-preview');
    expect(equivalenceKey('deepinfra/gpt-oss-120b', context)).toBe('deepinfra/gpt-oss-120b');
  });

  it('joins an owner namespace to the bare name only when it is the publisher', () => {
    expect(equivalenceKey('meta-llama/Llama-3.3-70B-Instruct', context)).toBe(
      'llama-3-3-70b-instruct'
    );
    expect(equivalenceKey('deepinfra/meta-llama/Llama-3.3-70B-Instruct', context)).toBe(
      'llama-3-3-70b-instruct'
    );
    expect(equivalenceKey('unsloth/Llama-3.3-70B-Instruct', context)).toBe(
      'unsloth/llama-3.3-70b-instruct'
    );
    expect(equivalenceKey('meta-llama/Llama-3.3-70B-Instruct-Turbo', context)).toBe(
      'meta-llama/llama-3.3-70b-instruct-turbo'
    );
  });

  it('keeps any other path as a repository identity: case folded, nothing else removed', () => {
    expect(equivalenceKey('Sao10K/L3.3-70B-Euryale-v2.3', context)).toBe(
      'sao10k/l3.3-70b-euryale-v2.3'
    );
    expect(equivalenceKey('spockren/naruto_lora_xl', context)).not.toBe(
      equivalenceKey('spockren/naruto-lora-xl', context)
    );
    expect(equivalenceKey('cardiffnlp/twitter-roberta-base-sentiment-latest', context)).not.toBe(
      equivalenceKey('cardiffnlp/twitter-roberta-base-sentiment', context)
    );
    expect(equivalenceKey('OpenLLM-Ro/RoLlama3.1-8b-Instruct-2024-10-09', context)).not.toBe(
      equivalenceKey('OpenLLM-Ro/RoLlama3.1-8b-Instruct', context)
    );
    expect(equivalenceKey('accounts/fireworks/models/gpt-oss-120b', context)).toBe(
      'accounts/fireworks/models/gpt-oss-120b'
    );
    // A provider route in front of a repository keeps the repository owner.
    expect(equivalenceKey('huggingface/devonho/llama-2-7b-miniguanaco', context)).toBe(
      'devonho/llama-2-7b-miniguanaco'
    );
  });

  it('a snapshot stamp joins the undated name only when it is the only snapshot', () => {
    const snapshots = createEquivalenceKeyContext(['anthropic'], {
      snapshotOfName: new Map<string, string | null>([
        ['claude-sonnet-4-5', '20250929'],
        ['claude-3-5-sonnet', null],
      ]),
    });
    expect(equivalenceKey('claude-sonnet-4-5-20250929', snapshots)).toBe('claude-sonnet-4-5');
    expect(equivalenceKey('claude-sonnet-4-5@20250929', snapshots)).toBe('claude-sonnet-4-5');
    // A snapshot the catalog does not know is not assumed to be the same model.
    expect(equivalenceKey('claude-sonnet-4-5-20260101', snapshots)).toBe(
      'claude-sonnet-4-5@20260101'
    );
    expect(equivalenceKey('claude-3-5-sonnet-20240620', snapshots)).toBe(
      'claude-3-5-sonnet@20240620'
    );
    expect(equivalenceKey('claude-3-5-sonnet@20240620', snapshots)).toBe(
      'claude-3-5-sonnet@20240620'
    );
    expect(equivalenceKey('claude-3-5-sonnet-latest', snapshots)).toBe('claude-3-5-sonnet');
  });
});

describe('publishers and hosts are derived from the catalog (no vendor list)', () => {
  it('an owner listed by more API providers than any other namespace, with a bare listing, is the publisher', async () => {
    const { keyOf, index } = await indexOf([
      row('kimi-k2.6', 'moonshot', 'native_api'),
      row('moonshotai/kimi-k2.6', 'openrouter', 'router'),
      row('moonshotai/Kimi-K2.6', 'deepinfra', 'native_api'),
      row('moonshot/kimi-k2.6', 'requesty', 'router'),
      row('kimi-k2.5', 'moonshot', 'native_api'),
    ]);
    expect(index.context.publisherOfName.get('kimi-k2-6')).toBe('moonshotai');
    expect(index.context.hostedNames.has('moonshot/kimi-k2-6')).toBe(true);
    expectOneGroup(keyOf, [
      'kimi-k2.6',
      'moonshotai/kimi-k2.6',
      'moonshotai/Kimi-K2.6',
      'moonshot/kimi-k2.6',
    ]);
    expectAllDifferent(keyOf, ['kimi-k2.6', 'kimi-k2.5']);
  });

  it('the namespace of a provider serving the name does not compete with the vendor org', async () => {
    const { keyOf, index } = await indexOf([
      row('deepseek-v4-pro', 'deepseek', 'native_api'),
      row('deepseek/deepseek-v4-pro', 'openrouter', 'router'),
      row('deepseek/deepseek-v4-pro', 'vercel-ai-gateway', 'native_api'),
      row('deepseek/deepseek-v4-pro', 'requesty', 'router'),
      row('deepseek-ai/DeepSeek-V4-Pro', 'deepinfra', 'native_api'),
      row('deepseek-ai/DeepSeek-V4-Pro', 'togetherai', 'cloud_hub'),
      // A host that lists the vendor's spelling serves the name too.
      row('zai-org/GLM-5.2', 'phala', 'native_api'),
      row('phala/glm-5.2', 'phala', 'native_api'),
      row('glm-5.2', 'zai', 'native_api'),
    ]);
    expect(index.context.publisherOfName.get('deepseek-v4-pro')).toBe('deepseek-ai');
    expectOneGroup(keyOf, [
      'deepseek-v4-pro',
      'deepseek/deepseek-v4-pro',
      'deepseek-ai/DeepSeek-V4-Pro',
    ]);
    expectOneGroup(keyOf, ['glm-5.2', 'phala/glm-5.2']);
  });

  it('no bare listing, a tie, aggregator-only evidence, or a lone provider namespace: no publisher', async () => {
    const { keyOf, index } = await indexOf([
      // No bare listing of the name.
      row('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'togetherai', 'cloud_hub'),
      row('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'deepinfra', 'native_api'),
      // A tie between two owners.
      row('solar-pro', 'upstage', 'native_api'),
      row('upstage-ai/solar-pro', 'openrouter', 'router'),
      row('upstageai/solar-pro', 'requesty', 'router'),
      // Only a repository hub lists the namespace.
      row('gemma-2b-zephyr-sft', 'someprovider', 'native_api'),
      row('Columbia-NLP/gemma-2b-zephyr-sft', 'huggingface', 'aggregator'),
      row('Columbia-NLP/gemma-2b-zephyr-sft', 'featherless-ai', 'aggregator'),
      // A provider namespace that does not serve the name, listed once.
      row('flux', 'ai302', 'cloud_hub'),
      row('deepgram/flux', 'togetherai', 'native_api'),
      row('deepgram/aura-2', 'deepgram', 'native_api'),
    ]);
    expect([...index.context.publisherOfName.keys()]).toEqual([]);
    expect(keyOf('meta-llama/Llama-3.3-70B-Instruct-Turbo')).toBe(
      'meta-llama/llama-3.3-70b-instruct-turbo'
    );
    expectAllDifferent(keyOf, ['solar-pro', 'upstage-ai/solar-pro', 'upstageai/solar-pro']);
    expectAllDifferent(keyOf, ['gemma-2b-zephyr-sft', 'Columbia-NLP/gemma-2b-zephyr-sft']);
    expectAllDifferent(keyOf, ['flux', 'deepgram/flux']);
  });
});

describe('counterexamples: different models never share a group', () => {
  it('claude-sonnet-4-6 vs claude-sonnet-4-5 vs claude-sonnet-4 (and the floating claude-sonnet alias)', async () => {
    const { keyOf, idsOf } = await indexOf([
      row('claude-sonnet-4-6', 'anthropic', 'native_api'),
      row('anthropic/claude-sonnet-4.6', 'openrouter', 'router'),
      row('claude-sonnet-4-5', 'anthropic', 'native_api'),
      row('claude-sonnet-4-5-20250929', 'anthropic', 'native_api'),
      row('anthropic/claude-sonnet-4.5', 'openrouter', 'router'),
      row('claude-sonnet-4', 'anthropic', 'native_api'),
      row('claude-sonnet-4-20250514', 'anthropic', 'native_api'),
      row('anthropic/claude-sonnet-4', 'openrouter', 'router'),
      row('~anthropic/claude-sonnet-latest', 'openrouter', 'router'),
    ]);
    expectAllDifferent(keyOf, [
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-sonnet-4',
      '~anthropic/claude-sonnet-latest',
    ]);
    expect(idsOf('claude-sonnet-4-6')).toEqual([
      'anthropic/claude-sonnet-4.6',
      'claude-sonnet-4-6',
    ]);
    expect(idsOf('claude-sonnet-4-5')).toEqual([
      'anthropic/claude-sonnet-4.5',
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-20250929',
    ]);
    expect(idsOf('claude-sonnet-4')).toEqual([
      'anthropic/claude-sonnet-4',
      'claude-sonnet-4',
      'claude-sonnet-4-20250514',
    ]);
    expect(idsOf(keyOf('~anthropic/claude-sonnet-latest'))).toEqual([
      '~anthropic/claude-sonnet-latest',
    ]);
  });

  it('gpt-oss-120b vs gpt-oss-20b in every spelling', async () => {
    const pairs: Array<[string, string, string]> = [
      ['gpt-oss-120b', 'gpt-oss-20b', 'groq'],
      ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openrouter'],
      ['deepinfra/openai/gpt-oss-120b', 'deepinfra/openai/gpt-oss-20b', 'deepinfra'],
      ['groq/openai/gpt-oss-120b', 'groq/openai/gpt-oss-20b', 'requesty'],
      [
        'accounts/fireworks/models/gpt-oss-120b',
        'accounts/fireworks/models/gpt-oss-20b',
        'fireworks-ai',
      ],
      ['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b', 'cloudflare-workers-ai'],
      ['gpt-oss-120b:free', 'gpt-oss-20b:free', 'openrouter'],
      ['openai.gpt-oss-120b-1:0', 'openai.gpt-oss-20b-1:0', 'aws-bedrock'],
      ['fireworks_ai/gpt-oss-120b', 'fireworks_ai/gpt-oss-20b', 'edenai'],
    ];
    const rows: FixtureRow[] = [
      row('gpt-oss-120b', 'openai', 'native_api'),
      row('gpt-oss-20b', 'openai', 'native_api'),
    ];
    for (const [big, small, provider] of pairs)
      rows.push(row(big, provider, 'router'), row(small, provider, 'router'));
    rows.push(row('openai/gpt-oss-safeguard-20b', 'openrouter', 'router'));
    const { keyOf } = await indexOf(rows);

    for (const [big, small] of pairs) expect(keyOf(big)).not.toBe(keyOf(small));
    const bigKeys = new Set(pairs.map(([big]) => keyOf(big)));
    const smallKeys = new Set(pairs.map(([, small]) => keyOf(small)));
    for (const key of bigKeys) expect(smallKeys.has(key)).toBe(false);
    expect(keyOf('openai/gpt-oss-safeguard-20b')).not.toBe(keyOf('openai/gpt-oss-20b'));
    // The provider-prefixed spellings of each size are one model; fireworks-ai
    // lists the name under its own route path, so it serves it.
    expectOneGroup(keyOf, [
      'gpt-oss-120b',
      'openai/gpt-oss-120b',
      'deepinfra/openai/gpt-oss-120b',
      'groq/openai/gpt-oss-120b',
      'fireworks_ai/gpt-oss-120b',
    ]);
    expectOneGroup(keyOf, [
      'gpt-oss-20b',
      'openai/gpt-oss-20b',
      'deepinfra/openai/gpt-oss-20b',
      'groq/openai/gpt-oss-20b',
      'fireworks_ai/gpt-oss-20b',
    ]);
  });

  it('llama-3.3-70b vs llama-3.1-70b vs llama-3-70b, Turbo and third-party fine-tunes', async () => {
    const { keyOf } = await indexOf([
      row('llama-3.3-70b-instruct', 'novita', 'cloud_hub'),
      row('llama-3.1-70b-instruct', 'novita', 'cloud_hub'),
      row('llama-3-70b-instruct', 'novita', 'cloud_hub'),
      row('meta-llama/Llama-3.3-70B-Instruct', 'deepinfra', 'native_api'),
      row('meta-llama/Llama-3.3-70B-Instruct', 'openrouter', 'router'),
      row('meta-llama/Llama-3.1-70B-Instruct', 'deepinfra', 'native_api'),
      row('meta-llama/Llama-3.1-70B-Instruct', 'openrouter', 'router'),
      row('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'togetherai', 'cloud_hub'),
      row('turboderp/Cat-Llama-3-70B-instruct', 'featherless-ai', 'aggregator'),
      row('unsloth/Llama-3.3-70B-Instruct', 'huggingface', 'aggregator'),
      row('llama-3.3-70b', 'groq', 'native_api'),
      row('llama-3.1-70b', 'groq', 'native_api'),
      row('llama-3-70b', 'groq', 'native_api'),
    ]);
    expectAllDifferent(keyOf, [
      'llama-3.3-70b-instruct',
      'llama-3.1-70b-instruct',
      'llama-3-70b-instruct',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'turboderp/Cat-Llama-3-70B-instruct',
      'unsloth/Llama-3.3-70B-Instruct',
      'llama-3.3-70b',
      'llama-3.1-70b',
      'llama-3-70b',
    ]);
    expectOneGroup(keyOf, ['llama-3.3-70b-instruct', 'meta-llama/Llama-3.3-70B-Instruct']);
    expectOneGroup(keyOf, ['llama-3.1-70b-instruct', 'meta-llama/Llama-3.1-70B-Instruct']);
  });

  it('gemini-2.5-flash vs flash-lite vs flash-image vs the dated preview', async () => {
    const { keyOf } = await indexOf([
      row('gemini-2.5-flash', 'gemini-openai', 'native_api'),
      row('google/gemini-2.5-flash', 'openrouter', 'router'),
      row('google/gemini-2.5-flash', 'deepinfra', 'native_api'),
      row('gemini-2.5-flash-lite', 'gemini-openai', 'native_api'),
      row('google/gemini-2.5-flash-lite', 'openrouter', 'router'),
      row('google/gemini-2.5-flash-lite', 'deepinfra', 'native_api'),
      row('google/gemini-2.5-flash-image', 'openrouter', 'router'),
      row('gemini-2.5-flash-preview-09-2025', 'gemini-openai', 'native_api'),
      row('gemini-2.5-flash-lite@eu', 'orqai', 'router'),
      row('gemini-2.5-flash@eu', 'orqai', 'router'),
    ]);
    expectAllDifferent(keyOf, [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'google/gemini-2.5-flash-image',
      'gemini-2.5-flash-preview-09-2025',
      'gemini-2.5-flash-lite@eu',
      'gemini-2.5-flash@eu',
    ]);
    expectOneGroup(keyOf, ['gemini-2.5-flash', 'google/gemini-2.5-flash']);
    expectOneGroup(keyOf, ['gemini-2.5-flash-lite', 'google/gemini-2.5-flash-lite']);
  });

  it('454 owners of one repository name are 454 models (each on its two hosts)', async () => {
    const owners = Array.from({ length: 454 }, (_, i) => `owner-${i.toString(36)}`);
    const rows: FixtureRow[] = [];
    for (const owner of owners) {
      rows.push(row(`${owner}/llama-2-7b-miniguanaco`, 'huggingface', 'aggregator'));
      rows.push(row(`${owner}/llama-2-7b-miniguanaco`, 'featherless-ai', 'aggregator'));
    }
    rows.push(row('genai/llama-2-7b-miniguanaco-hf', 'huggingface', 'aggregator'));
    const { index, keyOf, idsOf } = await indexOf(rows);

    const keys = new Set(owners.map((owner) => keyOf(`${owner}/llama-2-7b-miniguanaco`)));
    expect(keys.size).toBe(454);
    expect(index.groups.size).toBe(455);
    expect(idsOf('owner-0/llama-2-7b-miniguanaco')).toEqual(['owner-0/llama-2-7b-miniguanaco']);
    expect(
      index.groups
        .get('owner-0/llama-2-7b-miniguanaco')
        ?.members.map((m) => m.providerId)
        .sort()
    ).toEqual(['featherless-ai', 'huggingface']);
  });

  it('two dated snapshots of one name are two models; the undated alias is neither', async () => {
    const { keyOf, idsOf, index } = await indexOf([
      // Vertex names the second one claude-3-5-sonnet-v2@20241022.
      row('claude-3-5-sonnet-20240620', 'aihubmix', 'cloud_hub'),
      row('anthropic/claude-3-5-sonnet-20240620', 'orqai', 'router'),
      row('claude-3-5-sonnet-20241022', 'nanogpt', 'cloud_hub'),
      row('claude-3-5-sonnet-latest', 'ai302', 'cloud_hub'),
      row('anthropic/claude-3.5-sonnet', 'openrouter', 'router'),
      row('claude-3-5-sonnet', 'aihubmix', 'cloud_hub'),
      row('claude-sonnet-4-6', 'anthropic', 'native_api'),
      // Cohere's month-stamped snapshots.
      row('command-r-03-2024', 'apertis', 'native_api'),
      row('command-r-08-2024', 'apertis', 'native_api'),
      row('command-r', 'cohere', 'native_api'),
      // One provider lists both snapshots: evidence they are two models.
      row('gpt-4o-mini-tts-2025-03-20', 'openai', 'cloud_hub'),
      row('gpt-4o-mini-tts-2025-12-15', 'openai', 'cloud_hub'),
      row('gpt-4o-mini-tts', 'openai', 'cloud_hub'),
      row('gpt-4o-2024-05-13', 'openai', 'native_api'),
      row('openai/gpt-4o-2024-11-20', 'openrouter', 'router'),
      row('gpt-4o-2024-08-06', 'openai', 'native_api'),
      row('gpt-4o', 'openai', 'native_api'),
      row('openai/gpt-4o', 'openrouter', 'router'),
    ]);
    expectAllDifferent(keyOf, [
      'claude-3-5-sonnet-20240620',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-latest',
    ]);
    expect(idsOf('claude-3-5-sonnet@20240620')).toEqual([
      'anthropic/claude-3-5-sonnet-20240620',
      'claude-3-5-sonnet-20240620',
    ]);
    expect(idsOf('claude-3-5-sonnet')).toEqual([
      'anthropic/claude-3.5-sonnet',
      'claude-3-5-sonnet',
      'claude-3-5-sonnet-latest',
    ]);
    expectAllDifferent(keyOf, ['command-r-03-2024', 'command-r-08-2024', 'command-r']);
    expectAllDifferent(keyOf, [
      'gpt-4o-mini-tts-2025-03-20',
      'gpt-4o-mini-tts-2025-12-15',
      'gpt-4o-mini-tts',
    ]);
    expectAllDifferent(keyOf, [
      'gpt-4o-2024-05-13',
      'openai/gpt-4o-2024-11-20',
      'gpt-4o-2024-08-06',
      'gpt-4o',
    ]);
    expect(idsOf('gpt-4o')).toEqual(['gpt-4o', 'openai/gpt-4o']);
    expect(index.stats.multiSnapshotNames).toBe(4);
  });

  it("a provider's own product never meets another vendor's model of the same name", async () => {
    const { keyOf, idsOf } = await indexOf([
      // OpenAI's tts-1, served bare and under openai/; Inworld's TTS-1 on aiml.
      row('tts-1', 'openai', 'cloud_hub'),
      row('tts-1', 'aiml', 'cloud_hub'),
      row('openai/tts-1', 'aiml', 'cloud_hub'),
      row('openai/tts-1', 'vercel-ai-gateway', 'native_api'),
      row('inworld/tts-1', 'aiml', 'cloud_hub'),
      row('openai/gpt-4o-mini', 'inworld', 'native_api'),
      // Deepgram's Aura voices and TrustedRouter's own LLM family.
      row('deepgram/zeus', 'deepgram', 'native_api'),
      row('trustedrouter/zeus', 'trustedrouter', 'native_api'),
      // Deepgram's Flux (speech) and another vendor's flux (image).
      row('deepgram/flux', 'togetherai', 'native_api'),
      row('flux', 'ai302', 'cloud_hub'),
      // Every router's own "auto".
      row('openrouter/auto', 'openrouter', 'router'),
      row('trustedrouter/auto', 'trustedrouter', 'native_api'),
      row('orcarouter/auto', 'orcarouter', 'native_api'),
      row('fastrouter/auto', 'fastrouter', 'native_api'),
      row('auto', 'modeloracle', 'native_api'),
      row('MegaNova/Web-Search', 'meganova', 'native_api'),
      row('web-search', 'poe', 'cloud_hub'),
    ]);
    expect(idsOf('tts-1')).toEqual(['openai/tts-1', 'tts-1']);
    expectAllDifferent(keyOf, ['tts-1', 'inworld/tts-1']);
    expectAllDifferent(keyOf, ['deepgram/zeus', 'trustedrouter/zeus']);
    expectAllDifferent(keyOf, ['deepgram/flux', 'flux']);
    expectAllDifferent(keyOf, [
      'openrouter/auto',
      'trustedrouter/auto',
      'orcarouter/auto',
      'fastrouter/auto',
      'auto',
    ]);
    expectAllDifferent(keyOf, ['MegaNova/Web-Search', 'web-search']);
  });
});

describe('positive cases: the same model in any spelling shares one group', () => {
  it('vendor prefix, route prefix, date suffix, -latest, separators and case, across providers', async () => {
    const { keyOf, idsOf } = await indexOf([
      row('gpt-4o', 'openai', 'native_api'),
      row('openai/gpt-4o', 'openrouter', 'router'),
      row('gpt-4o', 'pioneer', 'native_api'),
      row('anthropic/pioneer/gpt-4o', 'pioneer', 'native_api'),
      row('gpt-4o', 'aihubmix', 'aggregator'),
      row('gpt-4o-mini', 'openai', 'native_api'),
      row('claude-3-7-sonnet-latest', 'anthropic', 'native_api'),
      row('anthropic/claude-3-7-sonnet-20250219', 'openrouter', 'router'),
      row('claude-3.7-sonnet', 'vivgrid', 'cloud_hub'),
      row('grok-4', 'xai', 'native_api'),
      row('x-ai/grok-4', 'openrouter', 'router'),
      row('command-a', 'cohere', 'native_api'),
      row('cohere/command-a-03-2025', 'openrouter', 'router'),
      row('mistral-large-latest', 'mistral', 'native_api'),
      row('mistral/mistral-large-latest', 'requesty', 'router'),
      row('claude-haiku-4-5', 'vivgrid', 'cloud_hub'),
      row('claude-haiku-4.5', 'vivgrid', 'cloud_hub'),
    ]);
    expect(idsOf('gpt-4o')).toEqual(['anthropic/pioneer/gpt-4o', 'gpt-4o', 'openai/gpt-4o']);
    expect(keyOf('gpt-4o-mini')).not.toBe(keyOf('gpt-4o'));
    expectOneGroup(keyOf, [
      'claude-3-7-sonnet-latest',
      'anthropic/claude-3-7-sonnet-20250219',
      'claude-3.7-sonnet',
    ]);
    expectOneGroup(keyOf, ['grok-4', 'x-ai/grok-4']);
    expectOneGroup(keyOf, ['command-a', 'cohere/command-a-03-2025']);
    expectOneGroup(keyOf, ['mistral-large-latest', 'mistral/mistral-large-latest']);
    expectOneGroup(keyOf, ['claude-haiku-4-5', 'claude-haiku-4.5']);
  });

  it('members come native providers first, then hubs, routers and aggregators (uid order within a tier)', async () => {
    const { index } = await indexOf([
      row('gpt-4o', 'aihubmix', 'aggregator'),
      row('openai/gpt-4o', 'openrouter', 'router'),
      row('gpt-4o', 'azure', 'cloud_hub'),
      row('gpt-4o', 'openai', 'native_api'),
      row('gpt-4o', 'mystery', 'unknown'),
    ]);
    const group = index.groups.get('gpt-4o');
    expect(group?.members.map((m) => m.providerId)).toEqual([
      'openai',
      'azure',
      'openrouter',
      'aihubmix',
      'mystery',
    ]);
    expect(group?.canonicalName).toBe('gpt-4o');
  });
});

describe('lookup contract (resolveEquivalenceKey): the requested model or null, never a neighbour', () => {
  const catalog = (): FixtureRow[] => [
    row('claude-sonnet-4-6', 'anthropic', 'native_api'),
    row('anthropic/claude-sonnet-4.6', 'openrouter', 'router'),
    row('claude-sonnet-4-5', 'anthropic', 'native_api'),
    row('claude-sonnet-4-5-20250929', 'anthropic', 'native_api'),
    row('claude-3-5-sonnet-20240620', 'aihubmix', 'cloud_hub'),
    row('claude-3-5-sonnet-20241022', 'aihubmix', 'cloud_hub'),
    row('gemini-2.5-flash', 'gemini-openai', 'native_api'),
    row('llama-3.3-70b-instruct', 'groq', 'native_api'),
    row('devonho/llama-2-7b-miniguanaco', 'huggingface', 'aggregator'),
    row('gpt-oss-120b', 'openai', 'native_api'),
    row('tts-1', 'openai', 'cloud_hub'),
  ];

  it('resolves an indexed id and every other spelling of it', async () => {
    const index = await buildEquivalenceIndex(catalog());
    for (const spelling of [
      'claude-sonnet-4-6',
      'anthropic/claude-sonnet-4.6',
      'Claude-Sonnet-4.6',
      'anthropic/claude-sonnet-4-6',
      'openrouter/anthropic/claude-sonnet-4-6',
      'claude-sonnet-4-6-latest',
    ]) {
      expect(resolveEquivalenceKey(index, spelling)).toBe('claude-sonnet-4-6');
    }
    for (const spelling of ['claude-sonnet-4-5@20250929', 'anthropic/claude-sonnet-4.5-20250929']) {
      expect(resolveEquivalenceKey(index, spelling)).toBe('claude-sonnet-4-5');
    }
    expect(resolveEquivalenceKey(index, 'claude-3-5-sonnet@20240620')).toBe(
      'claude-3-5-sonnet@20240620'
    );
    expect(resolveEquivalenceKey(index, 'DevonHo/Llama-2-7b-Miniguanaco')).toBe(
      'devonho/llama-2-7b-miniguanaco'
    );
  });

  it('returns null for ids the index does not know, however close they are', async () => {
    const index = await buildEquivalenceIndex(catalog());
    for (const unknown of [
      'claude-sonnet-4-7',
      'anthropic/claude-sonnet-4.7',
      'claude-sonnet-4',
      'claude-sonnet-4-5-20260101',
      'claude-3-5-sonnet',
      'claude-3-5-sonnet-20250101',
      'gemini-2.5-flash-max',
      'gemini-2.5-flash-lite',
      'llama-3.4-70b-instruct',
      'llama-3.1-70b-instruct',
      'someorg/llama-2-7b-miniguanaco',
      'gpt-oss-240b',
      'gpt-oss-20b',
      'inworld/tts-1',
      'deepgram/llama-3.3-70b-instruct',
    ]) {
      expect(resolveEquivalenceKey(index, unknown)).toBeNull();
    }
  });

  it('every member of a resolved group has the requested id key', async () => {
    const index = await buildEquivalenceIndex(catalog());
    for (const id of [
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-3-5-sonnet-20241022',
      'gemini-2.5-flash',
      'devonho/llama-2-7b-miniguanaco',
    ]) {
      const key = resolveEquivalenceKey(index, id);
      expect(key).not.toBeNull();
      const requested = equivalenceKey(id, index.context);
      for (const member of index.groups.get(key ?? '')?.members ?? []) {
        expect(equivalenceKey(member.modelId, index.context)).toBe(requested);
      }
    }
  });
});

describe('withListingEvidence: rows newer than the published context', () => {
  it("counts the rows' own hosting and snapshots, on top of the published evidence", async () => {
    const index = await buildEquivalenceIndex([
      row('claude-sonnet-4-5', 'anthropic', 'native_api'),
      row('claude-sonnet-4-5-20250929', 'anthropic', 'native_api'),
      row('gpt-9', 'openrouter', 'router'),
    ]);
    const context = withListingEvidence(index.context, [
      // A new provider namespace, served by that provider itself.
      { modelId: 'claude-sonnet-4-7', providerId: 'anthropic', sourceType: 'native_api' },
      { modelId: 'anthropic/claude-sonnet-4-7', providerId: 'openrouter', sourceType: 'router' },
      // A second snapshot of a name whose published snapshot was unique.
      { modelId: 'claude-sonnet-4-5-20260101', providerId: 'anthropic', sourceType: 'native_api' },
    ]);
    expect(equivalenceKey('anthropic/claude-sonnet-4-7', context)).toBe('claude-sonnet-4-7');
    expect(equivalenceKey('anthropic/claude-sonnet-4-7', index.context)).toBe(
      'anthropic/claude-sonnet-4-7'
    );
    expect(equivalenceKey('claude-sonnet-4-5-20250929', index.context)).toBe('claude-sonnet-4-5');
    expect(equivalenceKey('claude-sonnet-4-5-20250929', context)).toBe(
      'claude-sonnet-4-5@20250929'
    );
    expect(equivalenceKey('claude-sonnet-4-5-20260101', context)).toBe(
      'claude-sonnet-4-5@20260101'
    );
    // A listing under the provider's own namespace is not evidence of serving a name.
    const own = withListingEvidence(createEquivalenceKeyContext(['deepgram', 'ai302']), [
      { modelId: 'deepgram/flux', providerId: 'deepgram', sourceType: 'native_api' },
      { modelId: 'flux', providerId: 'ai302', sourceType: 'cloud_hub' },
    ]);
    expect(equivalenceKey('deepgram/flux', own)).not.toBe(equivalenceKey('flux', own));
  });
});
