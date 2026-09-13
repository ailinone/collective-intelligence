// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Correctness suite for the SharedArrayBuffer-backed candidate index: the
 * SAME filter-combination matrix
 * `investigation/sab-worker-feasibility/correctness-test.mjs` (PR #531)
 * validated against a hand-rolled JS port of the current Map-based logic,
 * now run against the REAL, shipped `getFullCacheFairCandidateModels`
 * (dynamic-model-selector.ts) — the production function this SAB path is
 * meant to replace once SELECTION_USE_SAB_CANDIDATE_INDEX is promoted to
 * default-on.
 *
 * Both paths are driven from the EXACT SAME `Model[]` array (the one
 * `getAllCatalogModels()` returns after a mocked-Prisma hydration — same
 * mocking convention as `full-cache-index-benchmark.test.ts`) so any
 * divergence can only come from the encode/reader logic itself, never from a
 * fixture-construction difference between the two sides.
 *
 * Also asserts something the original investigation prototype did NOT cover
 * (out of its scope — see capacity.ts's METADATA_BLOB_BYTES doc): full
 * `metadata` fidelity, since `findModelsByRequirements`' own
 * `requiredTools`/`requiredEndpoint` filters and several scoring reads
 * depend on it downstream of candidate retrieval.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findManyMock = vi.fn();
vi.mock('@/database/client', () => ({
  prisma: { model: { findMany: (...args: unknown[]) => findManyMock(...args) } },
  Prisma: {},
}));

const fakeRedisStore = new Map<string, string>();
vi.mock('@/cache/redis-client', () => ({
  getRedisClient: () => ({
    get: vi.fn(async (key: string) => fakeRedisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      fakeRedisStore.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (fakeRedisStore.delete(key) ? 1 : 0)),
  }),
}));

import { getFullCacheFairCandidateModels } from '@/core/selection/dynamic-model-selector';
import { getAllCatalogModels, invalidateCatalogCache } from '@/services/model-catalog-service';
import { narrowAs } from '@/utils/type-guards';
import type { ModelCapability } from '@/types';
import { computeLayout, wrapViews } from '../schema';
import { encodeGeneration } from '../encode';
import { buildGenLookup, getCandidatesFromSharedIndex, type SabCandidateCriteria } from '../reader';
import { PROD_CAPABILITIES_64, buildProdShapedModels } from './prod-catalog-fixture';

/** Real per-provider curated-bucket breakdown, live prod shape — same
 *  generator as full-cache-index-benchmark.test.ts (duplicated rather than
 *  imported: that file doesn't export it, and this suite's own scope is
 *  narrow enough that a second, easily-diffable copy is preferable to a
 *  cross-file refactor of a stable, unrelated test). */
const NAMED_CURATED_PROVIDERS: Array<[string, number]> = [
  ['featherless-ai', 22_144],
  ['orqai', 1_464],
  ['aiml', 1_292],
  ['nanogpt', 1_013],
  ['requesty', 879],
  ['openai', 136],
  ['cohere', 35],
  ['xai', 21],
  ['anthropic', 15],
  ['google', 12],
  ['deepseek', 3],
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function curatedRecord(id: string, providerName: string) {
  const h = hashStr(id);
  const capabilities = ['chat'];
  if (h % 100 < 4) capabilities.push('reasoning');
  if (h % 100 < 3) capabilities.push('vision');
  if (h % 100 < 2) capabilities.push('function_calling');
  return {
    id,
    providerId: `${providerName}-provider-id`,
    name: id,
    displayName: id,
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.03,
    capabilities,
    performance: { latencyMs: 500, throughput: 100, quality: 0.9, reliability: 0.99 },
    status: 'active',
    // Real metadata payload (non-empty, with an array + nested object) so the
    // metadata-fidelity assertions below exercise a real JSON round trip, not
    // just `{}`.
    metadata: { tools: ['search', 'calculator'], endpoint: 'chat/completions', version: '2026-09' },
    lastSyncedAt: null,
    provider: { name: providerName },
  };
}

function aggregatedRecord(id: string) {
  const h = hashStr(id);
  const capabilities = ['chat'];
  if (h % 100 < 4) capabilities.push('reasoning');
  return {
    id,
    providerId: 'huggingface-provider-id',
    name: id,
    displayName: id,
    contextWindow: 32_000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities,
    performance: { latencyMs: 800, throughput: 50, quality: 0.6, reliability: 0.9 },
    status: 'active',
    metadata: { serverless_callable: true, hubInventoryClass: 'aggregated_index', executionProvider: 'hf-inference' },
    lastSyncedAt: null,
    provider: { name: 'huggingface' },
  };
}

function buildRealisticCatalogRecords(): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  let namedTotal = 0;
  for (const [provider, count] of NAMED_CURATED_PROVIDERS) {
    namedTotal += count;
    for (let i = 0; i < count; i++) {
      records.push(curatedRecord(`${provider}-${i}`, provider));
    }
  }
  const remainingProviders = 95 - NAMED_CURATED_PROVIDERS.length;
  const remainingRows = 37_629 - namedTotal;
  const perTailProvider = Math.floor(remainingRows / remainingProviders);
  for (let p = 0; p < remainingProviders; p++) {
    const providerName = `long-tail-provider-${p}`;
    const rows = p === remainingProviders - 1 ? remainingRows - perTailProvider * (remainingProviders - 1) : perTailProvider;
    for (let i = 0; i < rows; i++) {
      records.push(curatedRecord(`${providerName}-${i}`, providerName));
    }
  }
  for (let i = 0; i < 73_782; i++) {
    records.push(aggregatedRecord(`hf-${i}`));
  }
  for (let i = 0; i < 255; i++) {
    records.push({
      ...curatedRecord(`orphan-${i}`, 'orphan-provider'),
      metadata: { hubInventoryClass: 'aggregated_index' },
    });
  }
  return records;
}

beforeEach(() => {
  findManyMock.mockReset();
  fakeRedisStore.clear();
  invalidateCatalogCache();
});

const CURATED_TAKE = 400;
const AGGREGATED_TAKE = 300;
const MAX_PROVIDER_SHARE = 0.15;

// The exact filter-combination matrix from
// investigation/sab-worker-feasibility/correctness-test.mjs's CASES array.
const CASES: Array<{ name: string; criteria: SabCandidateCriteria }> = [
  { name: 'default (contextSize=1000, no caps, no provider filter)', criteria: { contextSize: 1000 } },
  { name: 'no filters at all', criteria: {} },
  {
    name: 'requiredCapabilities=[reasoning]',
    criteria: { contextSize: 1000, requiredCapabilities: ['reasoning'] },
  },
  {
    name: 'requiredCapabilities=[vision,reasoning]',
    criteria: { contextSize: 1000, requiredCapabilities: ['vision', 'reasoning'] },
  },
  {
    name: 'requiredCapabilities=[nonexistent-cap] (fail-open expected)',
    // Deliberately not a real ModelCapability — exercises the fail-open path
    // both implementations share for an unrecognized capability string.
    criteria: { contextSize: 1000, requiredCapabilities: [narrowAs<ModelCapability>('nonexistent-cap')] },
  },
  {
    name: 'preferredProviders=[openai,anthropic]',
    criteria: { contextSize: 1000, preferredProviders: ['openai', 'anthropic'] },
  },
  {
    name: 'excludeProviders=[featherless-ai]',
    criteria: { contextSize: 1000, excludeProviders: ['featherless-ai'] },
  },
  {
    name: 'high contextSize=200000 (curated bucket rows are all 128k -> should empty curated)',
    criteria: { contextSize: 200_000 },
  },
];

describe('SAB candidate index vs getFullCacheFairCandidateModels — filter-combination correctness matrix', () => {
  it.each(CASES)('$name', async ({ criteria }) => {
    const records = buildRealisticCatalogRecords();
    findManyMock.mockResolvedValue(records);

    // Warm the real catalog cache/indices — getFullCacheFairCandidateModels
    // reads getCatalogIndices() internally, same as production.
    const models = await getAllCatalogModels();
    expect(models.length).toBe(111_666);

    const mapResult = getFullCacheFairCandidateModels(
      criteria,
      CURATED_TAKE,
      AGGREGATED_TAKE,
      MAX_PROVIDER_SHARE
    );

    // SAB side: encode the SAME `models` array this call just hydrated, then
    // read it back through the exact code path worker.ts/manager.ts run in
    // production (encodeGeneration -> buildGenLookup -> getCandidatesFromSharedIndex).
    const { layout, totalBytes } = computeLayout();
    const views = wrapViews(new SharedArrayBuffer(totalBytes), layout);
    const meta = encodeGeneration(models, views);
    const gen = buildGenLookup(meta);
    const sabResult = getCandidatesFromSharedIndex(
      views,
      gen,
      criteria,
      CURATED_TAKE,
      AGGREGATED_TAKE,
      MAX_PROVIDER_SHARE
    );

    const mapIds = new Set(mapResult.models.map((m) => m.id));
    const sabIds = new Set(sabResult.models.map((m) => m.id));
    expect(sabIds.size).toBe(mapIds.size);
    expect([...sabIds].sort()).toEqual([...mapIds].sort());

    expect(sabResult.curatedCount).toBe(mapResult.curatedCount);
    expect(sabResult.aggregatedCount).toBe(mapResult.aggregatedCount);
    expect(sabResult.curatedDistinctProviders).toBe(mapResult.curatedDistinctProviders);
    expect(sabResult.curatedTopProviderShare).toBeCloseTo(mapResult.curatedTopProviderShare, 9);

    // Metadata fidelity (production-correctness addition beyond the original
    // investigation prototype's scope — see this file's module doc): every
    // candidate's full metadata must round-trip byte-for-byte, since
    // findModelsByRequirements' requiredTools/requiredEndpoint filters and
    // several scoring reads run against it downstream, unconditionally, for
    // candidates from EITHER path.
    const mapById = new Map(mapResult.models.map((m) => [m.id, m]));
    for (const sabModel of sabResult.models) {
      const mapModel = mapById.get(sabModel.id);
      expect(mapModel, `sab-only id ${sabModel.id} not found in map result`).toBeDefined();
      expect(sabModel.metadata).toEqual(mapModel?.metadata ?? {});
      expect(sabModel.provider).toBe(mapModel?.provider);
      expect(sabModel.providerId).toBe(mapModel?.providerId);
      expect(sabModel.contextWindow).toBe(mapModel?.contextWindow);
      expect(sabModel.status).toBe(mapModel?.status);
      expect([...sabModel.capabilities].sort()).toEqual([...(mapModel?.capabilities ?? [])].sort());
    }
  }, 30_000);
});

/**
 * Capability-width matrix (added 2026-09-11, ADR-027 "Canary 2"). The
 * 8-case matrix above only ever exercises 4 distinct capabilities, so it
 * could never see the single-word (32-bit) mask truncate the real
 * catalog's 64. These cases run the SAME byte-for-byte comparison against
 * `getFullCacheFairCandidateModels` on catalogs with 64 (the real set, as
 * logged by the canary's encoder) and 100 (64 real + 36 synthetic)
 * distinct capabilities, filtering specifically on capabilities whose bit
 * position is past 31, 63 and 95.
 */
const SYNTHETIC_TAIL = Array.from({ length: 36 }, (_, i) =>
  // `zz_` so they sort after every real capability and occupy bits 64..99.
  `zz_synthetic_${String(i).padStart(2, '0')}`
);
const CAPS_100: readonly string[] = [...PROD_CAPABILITIES_64, ...SYNTHETIC_TAIL];
const WIDTH_ROWS = 20_000;

function toRecords(models: ReturnType<typeof buildProdShapedModels>): Array<Record<string, unknown>> {
  return models.map((m) => ({ ...m, lastSyncedAt: null, provider: { name: m.provider } }));
}

const WIDTH_CASES: Array<{ pool: readonly string[]; label: string; requiredCapabilities: string[]; extra?: SabCandidateCriteria }> = [
  { pool: PROD_CAPABILITIES_64, label: '64 caps: [tool_use]', requiredCapabilities: ['tool_use'] },
  { pool: PROD_CAPABILITIES_64, label: '64 caps: [vision, reasoning]', requiredCapabilities: ['vision', 'reasoning'] },
  { pool: PROD_CAPABILITIES_64, label: '64 caps: [web_search] (last sorted, bit 63)', requiredCapabilities: ['web_search'] },
  { pool: PROD_CAPABILITIES_64, label: '64 caps: [code_review, vision] (word 0 + word 1)', requiredCapabilities: ['code_review', 'vision'] },
  {
    pool: PROD_CAPABILITIES_64,
    label: '64 caps: [streaming, text_generation, thinking_mode] + contextSize + excludeProviders',
    requiredCapabilities: ['streaming', 'text_generation', 'thinking_mode'],
    extra: { contextSize: 100_000, excludeProviders: ['provider-0', 'provider-1'] },
  },
  {
    pool: PROD_CAPABILITIES_64,
    label: '64 caps: [speech_to_text] + preferredProviders',
    requiredCapabilities: ['speech_to_text'],
    extra: { preferredProviders: ['provider-3', 'provider-42', 'huggingface'] },
  },
  { pool: CAPS_100, label: '100 caps: [tool_use]', requiredCapabilities: ['tool_use'] },
  { pool: CAPS_100, label: '100 caps: [zz_synthetic_00] (bit 64)', requiredCapabilities: ['zz_synthetic_00'] },
  { pool: CAPS_100, label: '100 caps: [zz_synthetic_35] (bit 99)', requiredCapabilities: ['zz_synthetic_35'] },
  { pool: CAPS_100, label: '100 caps: [vision, zz_synthetic_31] (words 1 and 2)', requiredCapabilities: ['vision', 'zz_synthetic_31'] },
  { pool: CAPS_100, label: '100 caps: [code_review, zz_synthetic_35] (words 0 and 3)', requiredCapabilities: ['code_review', 'zz_synthetic_35'] },
  { pool: CAPS_100, label: '100 caps: [nonexistent-cap] (fail-open expected)', requiredCapabilities: ['nonexistent-cap'] },
];

describe('SAB candidate index vs getFullCacheFairCandidateModels — capability-width matrix (64 and 100 distinct capabilities)', () => {
  it.each(WIDTH_CASES)('$label', async ({ pool, requiredCapabilities, extra }) => {
    const source = buildProdShapedModels({ rows: WIDTH_ROWS, capabilityPool: pool, realisticMetadata: false });
    findManyMock.mockResolvedValue(toRecords(source));

    const models = await getAllCatalogModels();
    expect(models.length).toBe(WIDTH_ROWS);

    const criteria: SabCandidateCriteria = {
      ...(extra ?? {}),
      requiredCapabilities: requiredCapabilities.map((c) => narrowAs<ModelCapability>(c)),
    };
    const mapResult = getFullCacheFairCandidateModels(criteria, CURATED_TAKE, AGGREGATED_TAKE, MAX_PROVIDER_SHARE);

    const { layout, totalBytes } = computeLayout();
    const views = wrapViews(new SharedArrayBuffer(totalBytes), layout);
    const meta = encodeGeneration(models, views);
    expect(meta.distinctCapabilities).toBe(pool.length);
    const gen = buildGenLookup(meta);
    for (const cap of requiredCapabilities) {
      if (cap === 'nonexistent-cap') continue;
      expect(gen.capBit.get(cap), cap).toBeDefined();
    }
    const sabResult = getCandidatesFromSharedIndex(views, gen, criteria, CURATED_TAKE, AGGREGATED_TAKE, MAX_PROVIDER_SHARE);

    expect(mapResult.models.length).toBeGreaterThan(0);
    expect([...sabResult.models.map((m) => m.id)].sort()).toEqual([...mapResult.models.map((m) => m.id)].sort());
    expect(sabResult.curatedCount).toBe(mapResult.curatedCount);
    expect(sabResult.aggregatedCount).toBe(mapResult.aggregatedCount);
    expect(sabResult.curatedDistinctProviders).toBe(mapResult.curatedDistinctProviders);
    expect(sabResult.curatedTopProviderShare).toBeCloseTo(mapResult.curatedTopProviderShare, 9);

    // Both paths fail open (return the unnarrowed pool) only when NO row in
    // the catalog has every required capability; otherwise every returned
    // model must carry all of them.
    const satisfiable = source.some((m) =>
      requiredCapabilities.every((cap) => (m.capabilities as string[]).includes(cap))
    );
    expect(satisfiable).toBe(!requiredCapabilities.includes('nonexistent-cap'));

    const mapById = new Map(mapResult.models.map((m) => [m.id, m]));
    for (const sabModel of sabResult.models) {
      const mapModel = mapById.get(sabModel.id);
      expect(mapModel).toBeDefined();
      expect([...sabModel.capabilities].sort()).toEqual([...(mapModel?.capabilities ?? [])].sort());
      expect(sabModel.metadata).toEqual(mapModel?.metadata ?? {});
      if (satisfiable) {
        for (const cap of requiredCapabilities) expect(sabModel.capabilities, `${sabModel.id} lacks ${cap}`).toContain(cap);
      }
    }
  }, 60_000);
});
