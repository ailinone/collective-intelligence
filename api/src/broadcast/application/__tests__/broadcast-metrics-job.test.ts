// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the broadcast metrics probe job.
 *
 * Coverage:
 *   - Empty outbox → backlog=0, headOfLine=null (no lag observation)
 *   - Populated outbox → backlog reflects count, lag observation is non-negative
 *   - oldest=null (all drained) still produces backlog=0 cleanly (no NaN lag)
 *
 * These tests exercise the aggregation shape, not the SQL itself (real SQL
 * behavior is covered by the integration suite).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runBroadcastMetricsProbe,
  runBroadcastStrandedReclaim,
  STRANDED_VISIBILITY_WINDOW_SECONDS,
} from '../broadcast-metrics-job';

interface FakeRow {
  backlog: bigint;
  oldest: Date | null;
}

function makeDb(rows: FakeRow[]): { $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<FakeRow[]> } {
  return {
    $queryRaw: async () => rows,
  };
}

describe('runBroadcastMetricsProbe', () => {
  it('returns backlog=0 and null HOL lag when the outbox is empty', async () => {
    const db = makeDb([{ backlog: 0n, oldest: null }]);
    const result = await runBroadcastMetricsProbe({
      db: db as unknown as Parameters<typeof runBroadcastMetricsProbe>[0]['db'],
      now: () => new Date('2026-04-20T00:00:00Z'),
    });
    expect(result.backlogRows).toBe(0);
    expect(result.headOfLineLagSeconds).toBeNull();
  });

  it('reports backlog count and positive HOL lag when there is a stale row', async () => {
    const now = new Date('2026-04-20T00:00:30Z');
    const oldest = new Date('2026-04-20T00:00:00Z'); // 30s ago
    const db = makeDb([{ backlog: 42n, oldest }]);
    const result = await runBroadcastMetricsProbe({
      db: db as unknown as Parameters<typeof runBroadcastMetricsProbe>[0]['db'],
      now: () => now,
    });
    expect(result.backlogRows).toBe(42);
    expect(result.headOfLineLagSeconds).toBeGreaterThan(29);
    expect(result.headOfLineLagSeconds).toBeLessThan(31);
  });

  it('handles missing row from the query cleanly (treats as empty outbox)', async () => {
    // Some drivers return [] when the outbox is empty instead of a single
    // aggregated row with nulls. The probe must not crash — it should report
    // an empty outbox.
    const db = makeDb([]);
    const result = await runBroadcastMetricsProbe({
      db: db as unknown as Parameters<typeof runBroadcastMetricsProbe>[0]['db'],
    });
    expect(result.backlogRows).toBe(0);
    expect(result.headOfLineLagSeconds).toBeNull();
  });

  it('clamps lag at 0 when the oldest timestamp is in the future (clock skew)', async () => {
    const now = new Date('2026-04-20T00:00:00Z');
    const oldest = new Date('2026-04-20T00:00:05Z'); // 5s in the future
    const db = makeDb([{ backlog: 1n, oldest }]);
    const result = await runBroadcastMetricsProbe({
      db: db as unknown as Parameters<typeof runBroadcastMetricsProbe>[0]['db'],
      now: () => now,
    });
    expect(result.headOfLineLagSeconds).toBe(0);
  });
});

describe('runBroadcastStrandedReclaim (Fase 3.1 safety net)', () => {
  // The reclaim is a single UPDATE; the test surface is the visibility window
  // plumbing, that the right verb runs, and that rows reported by the driver
  // are surfaced as the `reclaimed` count.
  it('issues an UPDATE with the configured visibility window and returns its count', async () => {
    const captured: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      $executeRaw: vi.fn(async (strings: { raw?: readonly string[] }, ...values: unknown[]) => {
        captured.push({ sql: (strings.raw ?? []).join(' '), values });
        return 3; // driver-reported rowcount
      }),
    } as unknown as Parameters<typeof runBroadcastStrandedReclaim>[0]['db'];

    const result = await runBroadcastStrandedReclaim({ db });

    expect(result.reclaimed).toBe(3);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toMatch(/broadcast_trace_outbox/);
    expect(captured[0]!.sql).toMatch(/drained_at\s*=\s*NULL/);
    expect(captured[0]!.sql).toMatch(/destinations_resolved_count\s+IS\s+NULL/);
    expect(captured[0]!.values).toContain(STRANDED_VISIBILITY_WINDOW_SECONDS);
  });

  it('returns 0 when no rows match the window', async () => {
    const db = {
      $executeRaw: vi.fn(async () => 0),
    } as unknown as Parameters<typeof runBroadcastStrandedReclaim>[0]['db'];
    const result = await runBroadcastStrandedReclaim({ db });
    expect(result.reclaimed).toBe(0);
  });
});
