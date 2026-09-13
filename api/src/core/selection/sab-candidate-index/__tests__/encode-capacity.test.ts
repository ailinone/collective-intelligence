// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capacity-boundary behavior for encode.ts. Every fixed bound is a HARD
 * failure (SabEncodeCapacityError): row count, provider count, string
 * blobs, and (since 2026-09-11) the capability mask width. The previous
 * version of this file asserted that >32 capabilities were "gracefully
 * truncated"; the production canary showed what that graceful truncation
 * actually did downstream (decoded Models lost `vision`/`reasoning`/
 * `tool_use`/..., and the selector's fail-closed capability filter emptied
 * the pool), so truncation is now a rebuild failure and the fixtures here
 * use the real production shape instead of `metadata: {}`.
 *
 * Capacity constants are read from env ONCE at module import time
 * (capacity.ts), so each case that needs a non-default capacity uses
 * `vi.resetModules()` + a fresh dynamic import inside an isolated
 * `vi.stubEnv`/`vi.unstubAllEnvs` block.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Model, ModelCapability } from '@/types';
import { narrowAs } from '@/utils/type-guards';
import {
  PROD_ACTIVE_ROWS,
  PROD_CAPABILITIES_64,
  PROD_CAPABILITIES_DROPPED_BY_OLD_MASK,
  PROD_MAX_METADATA_BYTES,
  buildProdShapedModels,
  metadataOfExactBytes,
} from './prod-catalog-fixture';

function makeModel(overrides: Partial<Model> & Pick<Model, 'id' | 'providerId' | 'provider'>): Model {
  return {
    name: overrides.id,
    displayName: overrides.id,
    contextWindow: 8_000,
    maxOutputTokens: 1_000,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.02,
    capabilities: ['chat'],
    performance: { latencyMs: 100, throughput: 10, quality: 0.5, reliability: 0.9 },
    status: 'active',
    metadata: {},
    ...overrides,
  };
}

async function freshModules() {
  vi.resetModules();
  const schema = await import('../schema');
  const encode = await import('../encode');
  const reader = await import('../reader');
  const capacity = await import('../capacity');
  return { ...schema, ...encode, ...reader, ...capacity };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('encode.ts capacity boundaries', () => {
  it('throws SabEncodeCapacityError when row count exceeds MAX_MODELS (hard failure — never silently drops rows)', async () => {
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '3');
    const { computeLayout, wrapViews, encodeGeneration, SabEncodeCapacityError } = await freshModules();

    const models: Model[] = [1, 2, 3, 4].map((i) =>
      makeModel({ id: `m-${i}`, providerId: 'p1', provider: 'p1' })
    );
    const { layout, totalBytes } = computeLayout();
    const views = wrapViews(new SharedArrayBuffer(totalBytes), layout);

    expect(() => encodeGeneration(models, views)).toThrow(SabEncodeCapacityError);
  });

  it('throws SabEncodeCapacityError when provider count exceeds MAX_PROVIDERS', async () => {
    vi.stubEnv('SAB_CANDIDATE_MAX_PROVIDERS', '2');
    const { computeLayout, wrapViews, encodeGeneration, SabEncodeCapacityError } = await freshModules();

    const models: Model[] = [1, 2, 3].map((i) =>
      makeModel({ id: `m-${i}`, providerId: `p${i}`, provider: `p${i}` })
    );
    const { layout, totalBytes } = computeLayout();
    const views = wrapViews(new SharedArrayBuffer(totalBytes), layout);

    expect(() => encodeGeneration(models, views)).toThrow(SabEncodeCapacityError);
  });

  it('throws SabEncodeCapacityError (with the real count and the list that would be dropped) when distinct capabilities exceed MAX_CAPABILITIES — never truncates', async () => {
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '1000');
    const { computeLayout, wrapViews, encodeGeneration, SabEncodeCapacityError, MAX_CAPABILITIES } =
      await freshModules();

    const overflow = MAX_CAPABILITIES + 1;
    const models: Model[] = Array.from({ length: overflow }, (_, i) =>
      makeModel({
        id: `m-${i}`,
        providerId: 'p1',
        provider: 'p1',
        capabilities: [narrowAs<ModelCapability>(`synthetic_capability_${String(i).padStart(3, '0')}`)],
      })
    );
    const { layout, totalBytes } = computeLayout();
    const views = wrapViews(new SharedArrayBuffer(totalBytes), layout);

    let thrown: unknown;
    try {
      encodeGeneration(models, views);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SabEncodeCapacityError);
    const message = (thrown as Error).message;
    expect(message).toContain(`distinct capability count ${overflow}`);
    expect(message).toContain(`${MAX_CAPABILITIES}-bit`);
    // Sorted names: the one past the width is the last synthetic one.
    expect(message).toContain(`synthetic_capability_${String(overflow - 1).padStart(3, '0')}`);
  });

  it('encodes the real 64-capability production set without loss: filters past bit 31 narrow, decode returns every capability', async () => {
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '20000');
    const { computeLayout, wrapViews, encodeGeneration, buildGenLookup, getCandidatesFromSharedIndex } =
      await freshModules();

    const models = buildProdShapedModels({ rows: 20_000, realisticMetadata: false });
    const { layout, totalBytes } = computeLayout();
    const views = wrapViews(new SharedArrayBuffer(totalBytes), layout);
    const meta = encodeGeneration(models, views);

    expect(meta.distinctCapabilities).toBe(64);
    expect(meta.capNames.length).toBe(64);
    expect(meta.capNames).toEqual([...PROD_CAPABILITIES_64].sort());
    expect(meta.rowCount).toBe(20_000);

    const gen = buildGenLookup(meta);
    const byId = new Map(models.map((m) => [m.id, m]));
    const unfiltered = getCandidatesFromSharedIndex(views, gen, {}, 400, 300, 0.15);
    expect(unfiltered.models.length).toBe(700);

    // Every capability the old encoder dropped now narrows the pool and
    // every returned model really has it (bit positions 32..63).
    for (const cap of PROD_CAPABILITIES_DROPPED_BY_OLD_MASK) {
      const bit = gen.capBit.get(cap);
      expect(bit, cap).toBeGreaterThanOrEqual(32);
      const result = getCandidatesFromSharedIndex(
        views,
        gen,
        { requiredCapabilities: [narrowAs<ModelCapability>(cap)] },
        400,
        300,
        0.15
      );
      expect(result.models.length, cap).toBeGreaterThan(0);
      for (const m of result.models) {
        expect(m.capabilities, `${m.id} lacks ${cap}`).toContain(cap);
        const source = byId.get(m.id);
        expect([...m.capabilities].sort()).toEqual([...(source?.capabilities ?? [])].sort());
      }
    }

    // AND across words: `code_review` lives in word 0 (bit < 32), `vision`
    // and `reasoning` in word 1 (bit >= 32).
    for (const combo of [
      ['vision', 'reasoning'],
      ['code_review', 'vision'],
    ] as const) {
      const both = getCandidatesFromSharedIndex(
        views,
        gen,
        { requiredCapabilities: [...combo] },
        400,
        300,
        0.15
      );
      expect(both.models.length, combo.join('+')).toBeGreaterThan(0);
      expect(both.models.length, combo.join('+')).toBeLessThan(unfiltered.models.length);
      for (const m of both.models) for (const cap of combo) expect(m.capabilities).toContain(cap);
    }

    // A string absent from the whole catalog still fails open (Map-path parity).
    const unknown = getCandidatesFromSharedIndex(
      views,
      gen,
      { requiredCapabilities: [narrowAs<ModelCapability>('nonexistent-cap')] },
      400,
      300,
      0.15
    );
    expect(unknown.models.length).toBe(unfiltered.models.length);
  });

  it('fails BEFORE writing anything, with an actionable message, when the metadata blob is too small for the catalog', async () => {
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '100');
    vi.stubEnv('SAB_CANDIDATE_METADATA_BLOB_BYTES', String(64 * 1024));
    const { computeLayout, wrapViews, encodeGeneration, SabEncodeCapacityError } = await freshModules();

    // 10 rows at the observed production maximum: 137,570 bytes > 65,536.
    const models: Model[] = Array.from({ length: 10 }, (_, i) =>
      makeModel({
        id: `m-${i}`,
        providerId: 'p1',
        provider: 'p1',
        metadata: metadataOfExactBytes(PROD_MAX_METADATA_BYTES, i),
      })
    );
    const { layout, totalBytes } = computeLayout();
    const views = wrapViews(new SharedArrayBuffer(totalBytes), layout);

    let thrown: unknown;
    try {
      encodeGeneration(models, views);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SabEncodeCapacityError);
    const message = (thrown as Error).message;
    expect(message).toContain(`needs ${10 * PROD_MAX_METADATA_BYTES} bytes for 10 rows`);
    expect(message).toContain(`avg ${PROD_MAX_METADATA_BYTES} bytes/row`);
    expect(message).toContain(`capacity is ${64 * 1024}`);
    expect(message).toContain('SAB_CANDIDATE_METADATA_BYTES_PER_MODEL');

    // The pre-pass rejected the catalog before the per-row loop ran.
    expect(views.metadataStrLen.every((len) => len === 0)).toBe(true);
    expect(views.idStrLen.every((len) => len === 0)).toBe(true);
    expect(views.metadataBlob.every((b) => b === 0)).toBe(true);
  });

  it('encodes the real production shape (112,140 rows, avg ~934 B metadata, max 13,757 B tail, 64 capabilities) inside the DEFAULT capacity', async () => {
    const { computeLayout, wrapViews, encodeGeneration, buildGenLookup, getCandidatesFromSharedIndex, METADATA_BLOB_BYTES, MAX_MODELS } =
      await freshModules();

    const models = buildProdShapedModels();
    expect(models.length).toBe(PROD_ACTIVE_ROWS);

    let totalMetadataBytes = 0;
    let maxMetadataBytes = 0;
    for (const m of models) {
      const bytes = Buffer.byteLength(JSON.stringify(m.metadata ?? {}), 'utf8');
      totalMetadataBytes += bytes;
      if (bytes > maxMetadataBytes) maxMetadataBytes = bytes;
    }
    const avgMetadataBytes = totalMetadataBytes / models.length;
    expect(maxMetadataBytes).toBe(PROD_MAX_METADATA_BYTES);
    expect(avgMetadataBytes).toBeGreaterThan(900);
    expect(avgMetadataBytes).toBeLessThan(1_000);

    const { layout, totalBytes } = computeLayout();
    const views = wrapViews(new SharedArrayBuffer(totalBytes), layout);
    const start = performance.now();
    const meta = encodeGeneration(models, views);
    const encodeMs = performance.now() - start;

    expect(meta.rowCount).toBe(PROD_ACTIVE_ROWS);
    expect(meta.distinctCapabilities).toBe(64);
    expect(meta.metadataBlobUsedBytes).toBe(totalMetadataBytes);
    expect(meta.metadataBlobUsedBytes).toBeLessThan(METADATA_BLOB_BYTES);

    // eslint-disable-next-line no-console
    console.info(
      `[sab-candidate-index prod-shape encode] ${PROD_ACTIVE_ROWS} rows, ${meta.distinctCapabilities} capabilities, ` +
        `metadata ${totalMetadataBytes} B (avg ${avgMetadataBytes.toFixed(1)}, max ${maxMetadataBytes}) = ` +
        `${((100 * totalMetadataBytes) / METADATA_BLOB_BYTES).toFixed(1)}% of the ${METADATA_BLOB_BYTES} B blob ` +
        `(MAX_MODELS=${MAX_MODELS}); encode ${encodeMs.toFixed(0)} ms`
    );

    // Round-trip the largest row and a high-bit capability filter.
    const gen = buildGenLookup(meta);
    const result = getCandidatesFromSharedIndex(views, gen, { requiredCapabilities: ['web_search'] }, 400, 300, 0.15);
    expect(result.models.length).toBeGreaterThan(0);
    for (const m of result.models) expect(m.capabilities).toContain('web_search');
    const decodedMax = getCandidatesFromSharedIndex(
      views,
      gen,
      { preferredProviders: ['provider-0'] },
      400,
      300,
      0.15
    ).models.find((m) => m.id === 'curated-0');
    expect(decodedMax).toBeDefined();
    expect(decodedMax?.metadata).toEqual(models[0].metadata);
  }, 120_000);
});
