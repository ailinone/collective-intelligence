// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration test — SKIP LOCKED disjoint-claim invariant (Fase 3.4).
 *
 * Proves that N concurrent pollers claiming from `broadcast_trace_outbox`
 * under `FOR UPDATE SKIP LOCKED` never double-claim a row. This is the
 * ADR-014 §3 invariant that underpins horizontal poller scaling — if it
 * breaks, we get duplicate deliveries AND the claim-and-commit refactor
 * (Fase 3.1) silently regresses.
 *
 * Why an integration test (not a unit test):
 *   Unit tests mock `$transaction` and never exercise Postgres row locks.
 *   SKIP LOCKED is a storage-engine-level guarantee; only a real DB running
 *   N concurrent tx can prove the disjointness. A mock passing does not
 *   imply production will.
 *
 * What we assert:
 *   1. Union of claims across all pollers = all seeded rows (no row left
 *      behind if at least one poller is still running).
 *   2. Pairwise intersection = ∅ (no double-claim across pollers).
 *   3. Every row has `drained_at IS NOT NULL` after the sweep.
 *
 * We test the SQL primitive directly (same `SELECT … FOR UPDATE SKIP LOCKED`
 * + `UPDATE SET drained_at = NOW()` used by the poller). Testing the SQL
 * rather than `pollOnce()` avoids scaffolding full TraceEnvelope JSONB just
 * to exercise the claim layer.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '@/database/client';
import { startTestEnvironment, stopTestEnvironment } from '@/../tests/utils/test-environment';

describe('broadcast outbox — SKIP LOCKED disjoint claims (integration)', () => {
  beforeAll(async () => {
    await startTestEnvironment();
  }, 120_000);

  afterAll(async () => {
    await stopTestEnvironment();
  });

  beforeEach(async () => {
    // Clean any state left by prior tests. Order matters: child → parent.
    await prisma.$executeRawUnsafe('DELETE FROM broadcast_dlq');
    await prisma.$executeRawUnsafe('DELETE FROM broadcast_delivery');
    await prisma.$executeRawUnsafe('DELETE FROM broadcast_trace_outbox');
  });

  /**
   * Runs the EXACT claim SQL the poller uses, inside its own tx. Each call
   * returns the ids it successfully claimed. Concurrent callers MUST see
   * disjoint id sets.
   */
  async function runClaim(batchSize: number): Promise<string[]> {
    return await prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ envelope_id: string }>>`
          SELECT envelope_id
            FROM broadcast_trace_outbox
           WHERE drained_at IS NULL
           ORDER BY created_at
           LIMIT ${batchSize}
           FOR UPDATE SKIP LOCKED
        `;
        if (rows.length === 0) return [];
        const ids = rows.map((r) => r.envelope_id);
        await tx.$executeRaw`
          UPDATE broadcast_trace_outbox
             SET drained_at = NOW()
           WHERE envelope_id = ANY(${ids}::uuid[])
        `;
        return ids;
      },
      { timeout: 15_000 },
    );
  }

  async function seed(n: number): Promise<string[]> {
    const ids: string[] = [];
    const now = new Date();
    const rows = Array.from({ length: n }, () => {
      const envelopeId = randomUUID();
      ids.push(envelopeId);
      return {
        envelopeId,
        schemaVersion: '1.0',
        organizationId: randomUUID(),
        userId: null,
        resolutionScope: 'organization' as const,
        envelope: {}, // opaque — this test never parses
        occurredAt: now,
      };
    });
    await prisma.broadcastTraceOutbox.createMany({ data: rows });
    return ids;
  }

  it('with N=8 pollers and 100 rows, the union is disjoint and complete', async () => {
    const total = 100;
    const pollerCount = 8;
    const perBatch = 20; // 8 × 20 = 160 ≥ 100 so every row WILL be claimed

    const seeded = await seed(total);
    const seededSet = new Set(seeded);

    const results = await Promise.all(
      Array.from({ length: pollerCount }, () => runClaim(perBatch)),
    );

    // ── Invariant 1: pairwise intersection is empty ───────────────────
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const overlap = results[i]!.filter((id) => results[j]!.includes(id));
        expect(
          overlap,
          `pollers ${i} and ${j} double-claimed these ids`,
        ).toHaveLength(0);
      }
    }

    // ── Invariant 2: union equals the seeded set (nothing left behind) ─
    const claimedAll = new Set(results.flat());
    expect(claimedAll.size).toBe(total);
    for (const id of seeded) expect(claimedAll.has(id)).toBe(true);
    expect(seededSet.size).toBe(total);

    // ── Invariant 3: every row is marked drained ──────────────────────
    const undrained = await prisma.broadcastTraceOutbox.count({
      where: { drainedAt: null },
    });
    expect(undrained).toBe(0);
  });

  it('with contention > supply, some pollers claim zero rows and there is no blocking', async () => {
    // SKIP LOCKED's whole point: a poller that finds no claimable rows
    // returns immediately instead of blocking on the others' locks. Build
    // a scenario where demand (N × batchSize) ≫ supply and assert that
    // every poller returns within the test's wall-clock budget, several
    // with empty claim sets.
    const total = 5;
    const pollerCount = 10;
    const perBatch = 5; // 10 × 5 = 50 ≫ 5 → most pollers claim 0

    await seed(total);

    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: pollerCount }, () => runClaim(perBatch)),
    );
    const elapsed = Date.now() - start;

    // If SKIP LOCKED were not in effect, losing pollers would block on
    // the winners' locks — 10 concurrent claims × ~50ms tx = way past
    // our budget. A passing SKIP LOCKED makes this complete near-instant.
    expect(elapsed, `SKIP LOCKED should not serialize pollers (took ${elapsed}ms)`).toBeLessThan(
      5_000,
    );

    // Exactly 5 rows claimed across all pollers.
    const totalClaimed = results.reduce((n, r) => n + r.length, 0);
    expect(totalClaimed).toBe(total);

    // At least half the pollers must have claimed zero — proves SKIP
    // LOCKED returns empty sets instead of blocking.
    const emptyPollers = results.filter((r) => r.length === 0).length;
    expect(emptyPollers).toBeGreaterThanOrEqual(pollerCount / 2);
  });

  it('a second sweep after all rows drained claims zero new rows', async () => {
    const total = 20;
    await seed(total);

    // First sweep drains everything.
    const first = await Promise.all(
      Array.from({ length: 4 }, () => runClaim(10)),
    );
    const firstTotal = first.reduce((n, r) => n + r.length, 0);
    expect(firstTotal).toBe(total);

    // Second sweep — no claimable rows because drained_at IS NOT NULL
    // for all of them. The `WHERE drained_at IS NULL` predicate filters
    // them out regardless of row locks.
    const second = await Promise.all(
      Array.from({ length: 4 }, () => runClaim(10)),
    );
    const secondTotal = second.reduce((n, r) => n + r.length, 0);
    expect(secondTotal).toBe(0);
  });

  it('rows become reclaimable after drained_at is reset to NULL (stranded reclaim)', async () => {
    // Mirrors the Fase 3.1 safety net: after a stranded row's
    // `drained_at` is reset, a new poll MUST pick it up.
    const total = 5;
    const seeded = await seed(total);

    // Drain everything.
    await runClaim(total);
    expect(
      await prisma.broadcastTraceOutbox.count({ where: { drainedAt: null } }),
    ).toBe(0);

    // Simulate the stranded-reclaim sweep resetting a subset.
    const toReclaim = seeded.slice(0, 3);
    await prisma.$executeRaw`
      UPDATE broadcast_trace_outbox
         SET drained_at = NULL
       WHERE envelope_id = ANY(${toReclaim}::uuid[])
    `;

    // Exactly the reclaimed subset should now be claimable.
    const claimed = await runClaim(10);
    expect(claimed.sort()).toEqual(toReclaim.sort());
  });
});
