// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for ADR-028 (Layer 1)'s dynamic MAX_MODELS sizing:
 * `computeEffectiveMaxModels` (live row count -> effective capacity, capped
 * at the MAX_MODELS ceiling) and `buildCapacityConfig` (a single effective
 * MAX_MODELS -> the full set of derived bounds `schema.ts`'s `computeLayout`
 * needs). Both are pure functions of `process.env` + their argument, so each
 * case that needs a non-default ceiling/margin uses `vi.resetModules()` + a
 * fresh dynamic import, same pattern as `encode-capacity.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function freshCapacity() {
  vi.resetModules();
  return import('../capacity');
}

describe('computeEffectiveMaxModels', () => {
  it('never exceeds the MAX_MODELS ceiling, even for a catalog far larger than it', async () => {
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '1000');
    const { computeEffectiveMaxModels, MAX_MODELS } = await freshCapacity();

    expect(MAX_MODELS).toBe(1000);
    expect(computeEffectiveMaxModels(1_000_000)).toBe(1000);
    expect(computeEffectiveMaxModels(5000)).toBe(1000); // 5000 * 1.3 = 6500 > ceiling
  });

  it('applies the default 30% margin over the live row count, rounded up', async () => {
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '1000000'); // keep the ceiling out of the way
    const { computeEffectiveMaxModels } = await freshCapacity();

    expect(computeEffectiveMaxModels(100)).toBe(130); // ceil(100 * 1.3)
    expect(computeEffectiveMaxModels(116_627)).toBe(Math.ceil(116_627 * 1.3));
  });

  it('honors SAB_CANDIDATE_MAX_MODELS_MARGIN', async () => {
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '1000000');
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS_MARGIN', '0.5');
    const { computeEffectiveMaxModels, MAX_MODELS_MARGIN } = await freshCapacity();

    expect(MAX_MODELS_MARGIN).toBe(0.5);
    expect(computeEffectiveMaxModels(200)).toBe(300); // ceil(200 * 1.5)
  });

  it('returns the ceiling itself when there is no live signal yet (0, negative, or non-finite)', async () => {
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '1000');
    const { computeEffectiveMaxModels } = await freshCapacity();

    expect(computeEffectiveMaxModels(0)).toBe(1000);
    expect(computeEffectiveMaxModels(-5)).toBe(1000);
    expect(computeEffectiveMaxModels(Number.NaN)).toBe(1000);
  });
});

describe('buildCapacityConfig', () => {
  it('derives metadataBlobBytes proportionally from maxModels x METADATA_BYTES_PER_MODEL', async () => {
    vi.stubEnv('SAB_CANDIDATE_MAX_MODELS', '1000000');
    const { buildCapacityConfig, METADATA_BYTES_PER_MODEL } = await freshCapacity();

    const cfg = buildCapacityConfig(500);
    expect(cfg.maxModels).toBe(500);
    expect(cfg.metadataBlobBytes).toBe(500 * METADATA_BYTES_PER_MODEL);
  });

  it('clamps curatedCap/aggregatedCap to maxModels when the fixed default would exceed it', async () => {
    // Real-world shape: CURATED_CAP/AGGREGATED_CAP default to 120,000/200,000
    // (the pre-ADR-028 fixed ceiling), which would be nonsensical to keep as
    // an UPPER bound for a much smaller dynamically-resolved generation —
    // every row can land in at most one bucket, so maxModels alone is always
    // sufficient headroom for either bucket (see buildCapacityConfig's own
    // doc).
    const { buildCapacityConfig, CURATED_CAP, AGGREGATED_CAP } = await freshCapacity();
    expect(CURATED_CAP).toBeGreaterThan(500);
    expect(AGGREGATED_CAP).toBeGreaterThan(500);

    const cfg = buildCapacityConfig(500);
    expect(cfg.curatedCap).toBe(500);
    expect(cfg.aggregatedCap).toBe(500);
  });

  it('respects an explicit smaller SAB_CANDIDATE_CURATED_CAP/AGGREGATED_CAP override even when maxModels is larger', async () => {
    vi.stubEnv('SAB_CANDIDATE_CURATED_CAP', '50');
    vi.stubEnv('SAB_CANDIDATE_AGGREGATED_CAP', '60');
    const { buildCapacityConfig } = await freshCapacity();

    const cfg = buildCapacityConfig(1000);
    expect(cfg.curatedCap).toBe(50);
    expect(cfg.aggregatedCap).toBe(60);
  });

  it('still honors an explicit SAB_CANDIDATE_METADATA_BLOB_BYTES override over the derived default', async () => {
    vi.stubEnv('SAB_CANDIDATE_METADATA_BLOB_BYTES', String(64 * 1024));
    const { buildCapacityConfig } = await freshCapacity();

    const cfg = buildCapacityConfig(1_000_000); // would otherwise derive a much bigger blob
    expect(cfg.metadataBlobBytes).toBe(64 * 1024);
  });

  it('produces a layout via schema.computeLayout() with the exact per-model field lengths requested', async () => {
    const { buildCapacityConfig } = await freshCapacity();
    const { computeLayout } = await import('../schema');

    const cfg = buildCapacityConfig(777);
    const { layout } = computeLayout(cfg);
    expect(layout.idStrOffset.length).toBe(777);
    expect(layout.curatedOrder.length).toBe(cfg.curatedCap);
    expect(layout.aggregatedOrder.length).toBe(cfg.aggregatedCap);
    expect(layout.metadataBlob.byteLength).toBe(cfg.metadataBlobBytes);
  });
});

describe('schema.computeLayout with no override stays byte-identical to before ADR-028 (regression guard)', () => {
  it('computeLayout() and computeLayout(buildCapacityConfig(MAX_MODELS)) produce the same totalBytes in the default env', async () => {
    const { buildCapacityConfig, MAX_MODELS } = await freshCapacity();
    const { computeLayout } = await import('../schema');

    const bare = computeLayout();
    const viaDynamicHelper = computeLayout(buildCapacityConfig(MAX_MODELS));
    expect(viaDynamicHelper.totalBytes).toBe(bare.totalBytes);
  });
});
