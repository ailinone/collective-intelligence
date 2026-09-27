// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test fixtures for the model equivalence index: a hand-written catalog and a
 * seeded synthetic catalog generator shaped like production (org-prefixed
 * fine-tune repos, size/version siblings, region suffixes, dated snapshots,
 * short ids, the same id on several providers). Real catalog ids live in
 * equivalence-real-ids.tsv (see equivalence-real-ids.fixture.ts).
 */

export interface FixtureRow {
  uid: string;
  modelId: string;
  providerId: string;
  provider: string;
  sourceType: string;
}

const PROVIDERS = ['openai', 'anthropic', 'openrouter', 'together', 'huggingface', 'featherless', 'groq', 'edenai'];
const SOURCE_TYPES = ['native_api', 'cloud_hub', 'router', 'aggregator', 'unknown'];

let uidCounter = 0;
function uid(): string {
  uidCounter++;
  return `u${uidCounter.toString(36).padStart(8, '0')}`;
}

export function row(modelId: string, providerId: string, sourceType = 'unknown'): FixtureRow {
  return { uid: uid(), modelId, providerId, provider: providerId, sourceType };
}

/** Hand-written catalog covering every behaviour the index is used for. */
export function handFixture(): FixtureRow[] {
  return [
    row('gpt-5.4-pro', 'openai', 'native_api'),
    row('openai/gpt-5.4-pro', 'openrouter', 'router'),
    row('gpt-5.4-pro-2026-03-05', 'openai', 'native_api'),
    row('gpt-5.4-pro', 'edenai', 'aggregator'),
    row('claude-sonnet-4-6', 'anthropic', 'native_api'),
    row('anthropic/claude-sonnet-4.6', 'openrouter', 'router'),
    row('claude-sonnet-4-5', 'anthropic', 'native_api'),
    row('claude-sonnet-4-5-latest', 'together', 'cloud_hub'),
    row('claude-3-5-sonnet-v2', 'edenai', 'aggregator'),
    row('claude-3-5-sonnet', 'anthropic', 'native_api'),
    row('meta-llama/Llama-3.1-70B-Instruct', 'huggingface', 'aggregator'),
    row('llama-3.1-70b-instruct', 'together', 'cloud_hub'),
    row('llama-3-1-70b-instruct-turbo', 'together', 'cloud_hub'),
    row('llama-3.1-8b-instruct', 'groq', 'cloud_hub'),
    row('qwen2.5-72b-instruct', 'together', 'cloud_hub'),
    row('Qwen/Qwen2.5-7B-Instruct', 'huggingface', 'aggregator'),
    row('gemini-2.5-flash-lite@eu', 'openrouter', 'router'),
    row('gemini-2.5-flash-lite', 'openrouter', 'router'),
    row('gemini-2.5-flash-preview', 'openrouter', 'router'),
    row('deepseek-ai/deepseek-v4-flash', 'featherless', 'cloud_hub'),
    row('deepseek-v4-flash-0731', 'openrouter', 'router'),
    // Short ids: the n-gram index this replaced grouped "t3" with "mo" and
    // "mk" with "t7" (identical hashed embeddings). Four different models.
    row('t3', 'huggingface'),
    row('mo', 'featherless'),
    row('mk', 'huggingface'),
    row('t7', 'huggingface'),
    row('o3', 'openai', 'native_api'),
    row('o3-mini', 'openai', 'native_api'),
    // Degenerate ids.
    row('x', 'huggingface'),
    row('x', 'featherless'),
    row('', 'huggingface'),
  ];
}

// ─── Seeded synthetic catalog ──────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAMILIES = [
  'llama-3.1', 'llama-3.2', 'llama-2', 'qwen2.5', 'qwen3', 'mistral', 'mixtral', 'gemma-2',
  'phi-3', 'deepseek-v3', 'gpt-4o', 'gpt-oss', 'claude-3-5-sonnet', 'yi', 'falcon', 'glm-4',
];
const SIZES = ['0.5b', '1b', '1.5b', '3b', '7b', '8b', '13b', '14b', '32b', '70b', '72b', '120b', '20b'];
const VARIANTS = ['instruct', 'chat', 'base', 'awq', 'gguf', 'fp8', 'lora', 'it', 'coder', 'math'];
const WORDS = ['finetune', 'merged', 'dpo', 'sft', 'uncensored', 'v2', 'exp', 'orpo', 'rp', 'roleplay', 'distill'];
const SUFFIXES = ['', '', '', '-latest', '-preview', '@us', '@eu', '-2025-01-15', '-v2', ':free'];
const SHORT = ['t3', 'mo', 'mk', 't7', 'o1', 'o3', 'bw', 'yg', 'l1', 'v4', '25', 'cm', 'x', 'lili', 'lily', 'kobe'];

/**
 * A catalog of `n` rows shaped like production: most rows are org-prefixed
 * fine-tunes of a few families (dense clusters of near-identical names), some
 * are the same id served by several providers, some are short ids.
 */
export function syntheticCatalog(n: number, seed: number): FixtureRow[] {
  const rnd = mulberry32(seed);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
  const rows: FixtureRow[] = [];
  while (rows.length < n) {
    const r = rnd();
    let id: string;
    if (r < 0.05) {
      id = pick(SHORT);
    } else if (r < 0.35) {
      id = `${pick(FAMILIES)}-${pick(SIZES)}-${pick(VARIANTS)}${pick(SUFFIXES)}`;
    } else {
      const org = `org${Math.floor(rnd() * 5000).toString(36)}`;
      const extra = rnd() < 0.6 ? `-${pick(WORDS)}` : '';
      const tag = rnd() < 0.5 ? `-${Math.floor(rnd() * 100000).toString(36)}` : '';
      id = `${org}/${pick(FAMILIES)}-${pick(SIZES)}-${pick(VARIANTS)}${extra}${tag}`;
    }
    const copies = rnd() < 0.2 ? 1 + Math.floor(rnd() * 4) : 1;
    for (let c = 0; c < copies && rows.length < n; c++) {
      rows.push(row(id, pick(PROVIDERS), pick(SOURCE_TYPES)));
    }
  }
  return rows;
}

/** Deterministic Fisher-Yates shuffle (a copy). */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
