// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for BroadcastOutboxPoller (post Fase 3.1 refactor).
 *
 * Flow under test:
 *   Phase 1 CLAIM  (short tx):        SELECT FOR UPDATE SKIP LOCKED + UPDATE drained_at=NOW()
 *   Phase 2 DISPATCH (outside tx):    per-envelope resolve + executor.deliverOne
 *   Phase 3 FINALIZE (short UPDATE):  destinations_resolved_count for successes
 *   Phase 3b RECLAIM (short UPDATE):  drained_at=NULL for envelopes whose dispatch threw
 *
 * The mock db mirrors this flow: $transaction wraps the claim phase only; the
 * finalize UPDATE and the stranded-reclaim UPDATE run via the top-level
 * $executeRaw on the db (NOT inside a tx).
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';

import { BroadcastOutboxPoller } from '../broadcast-outbox-poller';
import type { DestinationResolver } from '../destination-resolver';
import type { BroadcastDeliveryExecutor } from '../delivery-executor';
import type { ResolvedDestination } from '../destination-resolver';
import {
  TRACE_ENVELOPE_SCHEMA_VERSION,
  type TraceEnvelope,
} from '@/broadcast/domain/trace-envelope';

// ─── Envelope fixture ───────────────────────────────────────────────────

function makeEnvelope(): TraceEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: TRACE_ENVELOPE_SCHEMA_VERSION,
    envelopeId: randomUUID(),
    traceId: '0'.repeat(32),
    spanId: '0'.repeat(16),
    requestId: 'req-' + randomUUID(),
    occurredAt: now,
    tenant: {
      organizationId: randomUUID(),
      userId: randomUUID(),
      apiKeyId: null,
      resolutionScope: 'organization',
    },
    resource: { serviceName: 'ailin-ci-api', deploymentEnvironment: 'staging' },
    generation: {
      model: { slug: 'gpt-5', provider: 'openai' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.0 },
      timing: { startedAt: now, endedAt: now, latencyMs: 1 },
      streaming: false,
    },
    routing: {
      selectedProvider: 'openai',
      reason: 'primary',
      candidatesConsidered: [],
      retryAttempts: 0,
    },
    content: {
      messages: [{ role: 'user', content: 'hi' }],
      choices: [],
      multimodalStripped: false,
    },
    custom: {},
    status: { code: 'ok' },
  } as TraceEnvelope;
}

function makeDestination(type: ResolvedDestination['type'] = 'webhook'): ResolvedDestination {
  return {
    id: randomUUID(),
    tenantType: 'organization',
    tenantId: randomUUID(),
    type,
    name: 'd-' + type,
    samplingRate: 1.0,
    privacyMode: false,
    releaseStatus: 'stable',
    configCiphertext: Buffer.alloc(0),
    configIv: Buffer.alloc(12),
    configAuthTag: Buffer.alloc(16),
    configAad: 'x',
    configDekWrapped: Buffer.alloc(0),
    configKekResource: 'local',
  };
}

// ─── Mock Prisma surface ────────────────────────────────────────────────

interface OutboxFixtureRow {
  envelope_id: string;
  envelope: TraceEnvelope;
  drained_at: Date | null;
  destinations_resolved_count: number | null;
}

/**
 * Mimics the poller's SQL-level surface:
 *   - $transaction(fn)           → runs fn with a tx that supports $queryRaw + $executeRaw
 *   - $executeRaw (on top-level) → finalize resolved-count + reclaim stranded
 *
 * The mock parses each $executeRaw call by the verb in the strings[] array.
 */
function makeMockDb(rows: OutboxFixtureRow[]) {
  const claimedIds = new Set<string>();

  // Inside-tx: SELECT FOR UPDATE SKIP LOCKED → returns unclaimed rows.
  // Inside-tx: UPDATE ... SET drained_at = NOW() WHERE id = ANY(ids) → marks claim.
  const tx = {
    $queryRaw: vi.fn(async () =>
      rows
        .filter((r) => !claimedIds.has(r.envelope_id) && r.drained_at === null)
        .map((r) => ({ envelope_id: r.envelope_id, envelope: r.envelope })),
    ),
    $executeRaw: vi.fn(async (strings: { raw?: readonly string[] }, ...values: unknown[]) => {
      const sql = (strings.raw ?? []).join(' ');
      if (/drained_at\s*=\s*NOW\(\)/i.test(sql)) {
        const ids = values[0] as string[];
        for (const id of ids) {
          const row = rows.find((r) => r.envelope_id === id);
          if (row) {
            row.drained_at = new Date();
            claimedIds.add(id);
          }
        }
        return ids.length;
      }
      return 0;
    }),
  };

  const finalizeCounts = new Map<string, number>();
  const reclaimedIds = new Set<string>();

  const db = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) =>
      fn(tx),
    ),
    $executeRaw: vi.fn(async (strings: { raw?: readonly string[] }, ...values: unknown[]) => {
      const sql = (strings.raw ?? []).join(' ');
      if (/destinations_resolved_count\s*=\s*data\.resolved_count/i.test(sql)) {
        const ids = values[0] as string[];
        const counts = values[1] as number[];
        for (let i = 0; i < ids.length; i++) {
          finalizeCounts.set(ids[i]!, counts[i]!);
          const row = rows.find((r) => r.envelope_id === ids[i]);
          if (row) row.destinations_resolved_count = counts[i]!;
        }
        return ids.length;
      }
      if (/drained_at\s*=\s*NULL/i.test(sql)) {
        const ids = values[0] as string[];
        for (const id of ids) {
          const row = rows.find(
            (r) => r.envelope_id === id && r.destinations_resolved_count === null,
          );
          if (row) {
            row.drained_at = null;
            claimedIds.delete(id);
            reclaimedIds.add(id);
          }
        }
        return ids.length;
      }
      return 0;
    }),
  };

  return { db, tx, claimedIds, finalizeCounts, reclaimedIds };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('BroadcastOutboxPoller — empty outbox', () => {
  it('returns zero counts and never opens a fan-out', async () => {
    const { db } = makeMockDb([]);
    const resolver: DestinationResolver = {
      resolveForEnvelope: vi.fn(async () => []),
    };
    const executor = {
      deliverOne: vi.fn(),
    } as unknown as BroadcastDeliveryExecutor;

    const poller = new BroadcastOutboxPoller({
      resolver,
      executor,
      db: db as never,
    });
    const result = await poller.pollOnce();

    expect(result).toEqual({
      envelopesProcessed: 0,
      deliveriesAttempted: 0,
      deliveriesSucceeded: 0,
      destinationsResolved: 0,
      envelopesReclaimed: 0,
    });
    expect(resolver.resolveForEnvelope).not.toHaveBeenCalled();
    expect(executor.deliverOne).not.toHaveBeenCalled();
  });
});

describe('BroadcastOutboxPoller — single envelope fan-out', () => {
  it('dispatches one envelope to one destination and marks it drained', async () => {
    const env = makeEnvelope();
    const { db, claimedIds, finalizeCounts } = makeMockDb([
      {
        envelope_id: env.envelopeId,
        envelope: env,
        drained_at: null,
        destinations_resolved_count: null,
      },
    ]);
    const dest = makeDestination();
    const resolver: DestinationResolver = {
      resolveForEnvelope: vi.fn(async () => [dest]),
    };
    const deliverOne = vi.fn(async () => ({
      destinationId: dest.id,
      status: 'success' as const,
      attemptNumber: 1,
    }));
    const executor = { deliverOne } as unknown as BroadcastDeliveryExecutor;

    const poller = new BroadcastOutboxPoller({ resolver, executor, db: db as never });
    const result = await poller.pollOnce();

    expect(result.envelopesProcessed).toBe(1);
    expect(result.deliveriesAttempted).toBe(1);
    expect(result.deliveriesSucceeded).toBe(1);
    expect(result.destinationsResolved).toBe(1);
    expect(result.envelopesReclaimed).toBe(0);
    expect(claimedIds.has(env.envelopeId)).toBe(true);
    expect(finalizeCounts.get(env.envelopeId)).toBe(1);
    expect(deliverOne).toHaveBeenCalledTimes(1);
  });
});

describe('BroadcastOutboxPoller — fan-out to multiple destinations', () => {
  it('dispatches one envelope to N destinations in parallel', async () => {
    const env = makeEnvelope();
    const { db } = makeMockDb([
      {
        envelope_id: env.envelopeId,
        envelope: env,
        drained_at: null,
        destinations_resolved_count: null,
      },
    ]);
    const dests = [makeDestination('webhook'), makeDestination('langfuse'), makeDestination('datadog')];
    const resolver: DestinationResolver = {
      resolveForEnvelope: vi.fn(async () => dests),
    };
    const deliverOne = vi.fn(async (_env: TraceEnvelope, d: ResolvedDestination) => ({
      destinationId: d.id,
      status: d.type === 'datadog' ? ('pending_retry' as const) : ('success' as const),
      attemptNumber: 1,
    }));
    const executor = { deliverOne } as unknown as BroadcastDeliveryExecutor;

    const poller = new BroadcastOutboxPoller({ resolver, executor, db: db as never });
    const result = await poller.pollOnce();

    expect(result.envelopesProcessed).toBe(1);
    expect(result.destinationsResolved).toBe(3);
    expect(result.deliveriesAttempted).toBe(3);
    expect(result.deliveriesSucceeded).toBe(2);
    expect(deliverOne).toHaveBeenCalledTimes(3);
  });
});

describe('BroadcastOutboxPoller — envelope with no matching destinations', () => {
  it('still marks the row drained with resolvedCount=0', async () => {
    const env = makeEnvelope();
    const { db, claimedIds, finalizeCounts } = makeMockDb([
      {
        envelope_id: env.envelopeId,
        envelope: env,
        drained_at: null,
        destinations_resolved_count: null,
      },
    ]);
    const resolver: DestinationResolver = {
      resolveForEnvelope: vi.fn(async () => []),
    };
    const executor = {
      deliverOne: vi.fn(),
    } as unknown as BroadcastDeliveryExecutor;

    const poller = new BroadcastOutboxPoller({ resolver, executor, db: db as never });
    const result = await poller.pollOnce();

    expect(result.envelopesProcessed).toBe(1);
    expect(result.destinationsResolved).toBe(0);
    expect(claimedIds.has(env.envelopeId)).toBe(true);
    expect(finalizeCounts.get(env.envelopeId)).toBe(0);
    expect(executor.deliverOne).not.toHaveBeenCalled();
  });
});

describe('BroadcastOutboxPoller — resolver failure reclaims the row', () => {
  it('resets drained_at to NULL when dispatch throws so another tick can retry', async () => {
    const env = makeEnvelope();
    const { db, reclaimedIds } = makeMockDb([
      {
        envelope_id: env.envelopeId,
        envelope: env,
        drained_at: null,
        destinations_resolved_count: null,
      },
    ]);
    const resolver: DestinationResolver = {
      resolveForEnvelope: vi.fn(async () => {
        throw new Error('resolver down');
      }),
    };
    const executor = {
      deliverOne: vi.fn(),
    } as unknown as BroadcastDeliveryExecutor;

    const poller = new BroadcastOutboxPoller({ resolver, executor, db: db as never });
    const result = await poller.pollOnce();

    expect(result.envelopesProcessed).toBe(0);
    expect(result.envelopesReclaimed).toBe(1);
    expect(reclaimedIds.has(env.envelopeId)).toBe(true);
  });
});

describe('BroadcastOutboxPoller — mixed envelope outcomes', () => {
  it('finalizes successful envelopes and reclaims failed ones', async () => {
    const good = makeEnvelope();
    const bad = makeEnvelope();
    const { db, finalizeCounts, reclaimedIds } = makeMockDb([
      {
        envelope_id: good.envelopeId,
        envelope: good,
        drained_at: null,
        destinations_resolved_count: null,
      },
      {
        envelope_id: bad.envelopeId,
        envelope: bad,
        drained_at: null,
        destinations_resolved_count: null,
      },
    ]);
    const dest = makeDestination();
    const resolver: DestinationResolver = {
      resolveForEnvelope: vi.fn(async (env: TraceEnvelope) => {
        if (env.envelopeId === bad.envelopeId) throw new Error('transient');
        return [dest];
      }),
    };
    const deliverOne = vi.fn(async () => ({
      destinationId: dest.id,
      status: 'success' as const,
      attemptNumber: 1,
    }));
    const executor = { deliverOne } as unknown as BroadcastDeliveryExecutor;

    const poller = new BroadcastOutboxPoller({ resolver, executor, db: db as never });
    const result = await poller.pollOnce();

    expect(result.envelopesProcessed).toBe(1);
    expect(result.envelopesReclaimed).toBe(1);
    expect(finalizeCounts.has(good.envelopeId)).toBe(true);
    expect(reclaimedIds.has(bad.envelopeId)).toBe(true);
  });
});

describe('BroadcastOutboxPoller — executor throwing is isolated', () => {
  it('does not cascade to sibling destinations in the same envelope', async () => {
    const env = makeEnvelope();
    const { db, claimedIds } = makeMockDb([
      {
        envelope_id: env.envelopeId,
        envelope: env,
        drained_at: null,
        destinations_resolved_count: null,
      },
    ]);
    const dA = makeDestination('webhook');
    const dB = makeDestination('langfuse');
    const resolver: DestinationResolver = {
      resolveForEnvelope: vi.fn(async () => [dA, dB]),
    };
    const deliverOne = vi.fn(async (_env: TraceEnvelope, d: ResolvedDestination) => {
      if (d.id === dA.id) throw new Error('unexpected executor bug');
      return { destinationId: d.id, status: 'success' as const, attemptNumber: 1 };
    });
    const executor = { deliverOne } as unknown as BroadcastDeliveryExecutor;

    const poller = new BroadcastOutboxPoller({ resolver, executor, db: db as never });
    const result = await poller.pollOnce();

    expect(result.envelopesProcessed).toBe(1);
    expect(result.destinationsResolved).toBe(2);
    // Only the non-throwing destination counted.
    expect(result.deliveriesAttempted).toBe(1);
    expect(result.deliveriesSucceeded).toBe(1);
    expect(claimedIds.has(env.envelopeId)).toBe(true);
  });
});

describe('BroadcastOutboxPoller — dispatch runs OUTSIDE any transaction (Fase 3.1)', () => {
  // The Fase 3.1 refactor moved delivery dispatch OUT of the claim tx so that
  // HTTP latency no longer holds a DB connection. This regression test pins
  // that contract: the executor must be invoked WITHOUT a tx runner argument
  // (or with the global db) — never with the short-lived claim tx.
  it('calls executor.deliverOne with no tx (two args only)', async () => {
    const env = makeEnvelope();
    const { db, tx } = makeMockDb([
      {
        envelope_id: env.envelopeId,
        envelope: env,
        drained_at: null,
        destinations_resolved_count: null,
      },
    ]);
    const dest = makeDestination();
    const resolver: DestinationResolver = {
      resolveForEnvelope: vi.fn(async () => [dest]),
    };
    const deliverOne = vi.fn(async () => ({
      destinationId: dest.id,
      status: 'success' as const,
      attemptNumber: 1,
    }));
    const executor = { deliverOne } as unknown as BroadcastDeliveryExecutor;

    const poller = new BroadcastOutboxPoller({ resolver, executor, db: db as never });
    await poller.pollOnce();

    expect(deliverOne).toHaveBeenCalledTimes(1);
    const call = deliverOne.mock.calls[0]!;
    // Only (envelope, destination) — no third arg, and crucially not `tx`.
    expect(call.length).toBe(2);
    expect(call[2]).toBeUndefined();
    // Sanity: the tx object IS distinct from the outer db, proving the mock
    // correctly scopes the tx to phase 1 only.
    expect(tx).not.toBe(db);
  });
});
