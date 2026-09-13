// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Real, exact memory-footprint measurement for the default capacity
 * configuration — unlike the feasibility investigation's own
 * `memory-footprint.mjs --expose-gc` (which measured heap delta from
 * actually encoding a fixture, an indirect proxy), the SharedArrayBuffer
 * size here is a DETERMINISTIC function of `computeLayout()`'s fixed-capacity
 * schema alone, independent of how many real rows are ever encoded into it
 * — so this test reports the exact, real number directly, no proxy
 * measurement needed.
 *
 * History of this number (per `ci_api` replica, two generations + control):
 *   - 56.75 MB: feasibility prototype (no metadata blob at all).
 *   - 187.80 MB: first production schema (64 MiB metadata blob per
 *     generation, 32-bit capability mask). That blob was never multiplied
 *     against the real catalog and overflowed on the very first production
 *     build (2026-09-11 canary, ADR-027 "Canary 2").
 *   - Current: metadata blob derived as MAX_MODELS x METADATA_BYTES_PER_MODEL
 *     (200,000 x 1,024 = 200 MiB per generation, ~1.9x the ~109 MB the real
 *     catalog needs today) plus a 4-word (128-bit) capability mask. The
 *     exact figure is printed below; the assertions pin its shape so a
 *     capacity typo cannot silently move it by an order of magnitude.
 *
 * This is VIRTUAL allocation. The kernel backs SharedArrayBuffer pages
 * lazily, so resident memory grows with bytes actually written: roughly
 * 2 x (metadata used + id blob used + fixed SoA fields touched), ~2 x 145 MB
 * at today's catalog, not the full figure below.
 */
import { describe, expect, it } from 'vitest';
import { computeLayout } from '../schema';
import {
  CAPABILITY_MASK_WORDS,
  MAX_MODELS,
  METADATA_BLOB_BYTES,
  METADATA_BYTES_PER_MODEL,
} from '../capacity';

/** 2026-09-11 production facts (ADR-027, "Canary 2"). */
const PROD_ACTIVE_ROWS = 112_140;
const PROD_AVG_METADATA_BYTES = 934;
const PROD_SYNC_STAMP_BYTES = 42; // `,"lastSyncedAt":"2026-09-11T00:00:00.000Z"` added by mapPrismaModel

describe('sab-candidate-index real memory footprint (default capacity)', () => {
  it('reports the exact, real per-replica SharedArrayBuffer allocation (two generations + control block)', () => {
    const { layout, totalBytes } = computeLayout();
    const perGenerationMb = totalBytes / (1024 * 1024);
    const controlBytes = 64;
    const totalPerReplicaMb = (totalBytes * 2 + controlBytes) / (1024 * 1024);
    const metadataBlobMb = layout.metadataBlob.byteLength / (1024 * 1024);
    const bitmaskMb = layout.capabilityBitmask.byteLength / (1024 * 1024);

    // eslint-disable-next-line no-console
    console.info(
      `[sab-candidate-index memory footprint] one generation: ${perGenerationMb.toFixed(2)} MiB ` +
        `(metadata blob ${metadataBlobMb.toFixed(2)} MiB, capability mask ${bitmaskMb.toFixed(2)} MiB) | ` +
        `two generations (double-buffer) + control block: ${totalPerReplicaMb.toFixed(2)} MiB per ci_api replica (virtual)`
    );

    expect(layout.capabilityBitmask.length).toBe(MAX_MODELS * CAPABILITY_MASK_WORDS);
    expect(layout.metadataBlob.byteLength).toBe(METADATA_BLOB_BYTES);
    // Sanity bounds, not a precise pin — catches an accidental
    // order-of-magnitude regression (e.g. a capacity constant typo).
    expect(totalPerReplicaMb).toBeGreaterThan(300);
    expect(totalPerReplicaMb).toBeLessThan(1024);
  });

  it('derives the default metadata blob from MAX_MODELS and covers the real 2026-09-11 catalog with headroom', () => {
    if (!process.env.SAB_CANDIDATE_METADATA_BLOB_BYTES) {
      expect(METADATA_BLOB_BYTES).toBe(MAX_MODELS * METADATA_BYTES_PER_MODEL);
    }
    const realNeedToday = PROD_ACTIVE_ROWS * (PROD_AVG_METADATA_BYTES + PROD_SYNC_STAMP_BYTES);
    const designCeilingNeed = MAX_MODELS * (PROD_AVG_METADATA_BYTES + PROD_SYNC_STAMP_BYTES);
    // eslint-disable-next-line no-console
    console.info(
      `[sab-candidate-index metadata blob] capacity ${METADATA_BLOB_BYTES} B | real need today ${realNeedToday} B ` +
        `(${(METADATA_BLOB_BYTES / realNeedToday).toFixed(2)}x headroom) | at MAX_MODELS=${MAX_MODELS}: ${designCeilingNeed} B`
    );
    expect(METADATA_BLOB_BYTES).toBeGreaterThanOrEqual(realNeedToday * 1.5);
    expect(METADATA_BLOB_BYTES).toBeGreaterThanOrEqual(designCeilingNeed);
    expect(METADATA_BLOB_BYTES).toBeLessThanOrEqual(2 ** 31 - 1);
  });
});
