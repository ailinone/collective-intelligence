// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for the HCRA assertion write-amplification bug
 * (root-caused to commit e21b464f, "wire HCRA assertions into live
 * discovery", 2026-09-05): `writeAssertions` unconditionally superseded
 * and re-inserted a fetcher's entire snapshot on every discovery cycle,
 * even when nothing changed. With `model-discovery-hourly` running every
 * 60 minutes, this grew `model_capability_assertions` from ~0 to 62.8M
 * rows in 13 days (99.66% superseded, all within a single 13-day window).
 *
 * Fix: before superseding+inserting, compare each new signal against the
 * currently-active assertion for the same (model_uid, capability_uri,
 * source). If confidence and assertedValue are unchanged, just touch
 * `observed_at` on the existing row (refreshes freshness decay, zero
 * table growth). Only supersede+insert when the value actually changed
 * or the (model, capability, source) triple is new.
 */
import { describe, test, expect, vi } from 'vitest';

// writer.ts imports `prisma` at module scope only to use as a default
// parameter value; every test here injects its own mock runner instead.
// Mocking this out avoids triggering the real client's DATABASE_URL
// validation on import (this repo's established pattern — see
// core/evaluation/__tests__/drift-detection.test.ts).
vi.mock('@/database/client', () => ({ prisma: {} }));

import { writeAssertions } from '../writer';
import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';
import type { CapabilitySignal } from '@/services/model-capability-merger';

const VISION_URI = LEGACY_CAPABILITY_TO_URI.vision;

function makeRunner() {
  return {
    $queryRawUnsafe: vi.fn(),
    $executeRawUnsafe: vi.fn(),
  };
}

const MODEL_UID = 'a'.repeat(25);
const ORIGIN = 'test-fetcher@v1';

function signal(overrides: Partial<CapabilitySignal> = {}): CapabilitySignal {
  return {
    capability: 'vision',
    source: 'provider-declared',
    confidence: 1.0,
    ...overrides,
  };
}

describe('writeAssertions idempotency', () => {
  test('does not supersede or insert when the signal matches the currently active assertion', async () => {
    const runner = makeRunner();
    // Currently-active assertion for this exact (model, capability, source),
    // with the SAME confidence/assertedValue the new batch will emit.
    runner.$queryRawUnsafe.mockResolvedValueOnce([
      {
        model_uid: MODEL_UID,
        capability_uri: VISION_URI,
        source: 'provider-declared',
        confidence: 1.0,
        asserted_value: true,
      },
    ]);
    runner.$executeRawUnsafe.mockResolvedValue(1);

    const stats = await writeAssertions(
      [{ modelUid: MODEL_UID, signals: [signal()] }],
      { origin: ORIGIN },
      runner
    );

    const executedSql = runner.$executeRawUnsafe.mock.calls.map((c) => String(c[0]));
    expect(executedSql.some((sql) => /INSERT INTO/i.test(sql))).toBe(false);
    expect(executedSql.some((sql) => /SET\s+superseded_at/i.test(sql))).toBe(false);
    expect(stats.rowsInserted).toBe(0);
    expect(stats.rowsSuperseded).toBe(0);
    expect(stats.rowsTouched).toBe(1);
  });

  test('supersedes and inserts when confidence actually changed', async () => {
    const runner = makeRunner();
    runner.$queryRawUnsafe.mockResolvedValueOnce([
      {
        model_uid: MODEL_UID,
        capability_uri: VISION_URI,
        source: 'provider-declared',
        confidence: 0.4, // different from the 1.0 the new batch emits
        asserted_value: true,
      },
    ]);
    runner.$executeRawUnsafe.mockResolvedValue(1);

    const stats = await writeAssertions(
      [{ modelUid: MODEL_UID, signals: [signal({ confidence: 1.0 })] }],
      { origin: ORIGIN },
      runner
    );

    const executedSql = runner.$executeRawUnsafe.mock.calls.map((c) => String(c[0]));
    expect(executedSql.some((sql) => /SET\s+superseded_at/i.test(sql))).toBe(true);
    expect(executedSql.some((sql) => /INSERT INTO/i.test(sql))).toBe(true);
    expect(stats.rowsSuperseded).toBe(1);
    expect(stats.rowsInserted).toBe(1);
    expect(stats.rowsTouched).toBe(0);
  });

  test('supersedes (no-op) and inserts when no active assertion exists yet', async () => {
    const runner = makeRunner();
    runner.$queryRawUnsafe.mockResolvedValueOnce([]); // nothing active yet
    runner.$executeRawUnsafe.mockResolvedValue(1);

    const stats = await writeAssertions(
      [{ modelUid: MODEL_UID, signals: [signal()] }],
      { origin: ORIGIN },
      runner
    );

    const executedSql = runner.$executeRawUnsafe.mock.calls.map((c) => String(c[0]));
    expect(executedSql.some((sql) => /INSERT INTO/i.test(sql))).toBe(true);
    expect(stats.rowsInserted).toBe(1);
    expect(stats.rowsTouched).toBe(0);
  });

  test('mixed batch: touches the unchanged signal and supersedes+inserts only the changed one', async () => {
    const runner = makeRunner();
    const otherModelUid = 'b'.repeat(25);
    runner.$queryRawUnsafe.mockResolvedValueOnce([
      {
        model_uid: MODEL_UID,
        capability_uri: VISION_URI,
        source: 'provider-declared',
        confidence: 1.0,
        asserted_value: true,
      },
      {
        model_uid: otherModelUid,
        capability_uri: VISION_URI,
        source: 'provider-declared',
        confidence: 0.4,
        asserted_value: true,
      },
    ]);
    runner.$executeRawUnsafe.mockResolvedValue(1);

    const stats = await writeAssertions(
      [
        { modelUid: MODEL_UID, signals: [signal({ confidence: 1.0 })] }, // unchanged
        { modelUid: otherModelUid, signals: [signal({ confidence: 1.0 })] }, // changed (was 0.4)
      ],
      { origin: ORIGIN },
      runner
    );

    expect(stats.rowsTouched).toBe(1);
    expect(stats.rowsSuperseded).toBe(1);
    expect(stats.rowsInserted).toBe(1);
  });
});
