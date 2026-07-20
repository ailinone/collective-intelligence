// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * BroadcastAdminService tests.
 *
 * We don't spin up Postgres here — the tagged-template SQL calls are mocked
 * with a captured-query assertion so we can verify:
 *   - erasure runs all four deletes in a single $transaction
 *   - user kind queries `user_id` column; organization kind queries
 *     `organization_id` column (no accidental cross-usage)
 *   - replay doesn't proceed if the DLQ entry is already replayed
 *   - replay writes a new envelope id (not the original) into the outbox so
 *     the unique (envelope_id, destination_id) index on broadcast_delivery
 *     cannot collide with the original delivery rows
 *
 * Integration tests that hit real SQL live in the testcontainers suite.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  BroadcastAdminService,
  type AdminRunner,
  type Subject,
} from '../broadcast-admin-service';

interface CapturedExec {
  sql: string;
  values: unknown[];
}

// Plaintext tenant identity carried by every fake DLQ entry's destination row
// (models broadcast_destination.tenant_type/tenant_id — the resolution key).
const DEST_TENANT_ID = '0f1e2d3c-4b5a-4697-8877-665544332211';

function interpolate(strings: TemplateStringsArray, values: unknown[]): CapturedExec {
  // Reconstruct a plain-string representation of the tagged template so tests
  // can grep for column names without pulling in a Postgres client.
  const parts: string[] = [];
  strings.forEach((s, i) => {
    parts.push(s);
    if (i < values.length) parts.push(`$${i + 1}`);
  });
  return { sql: parts.join('').trim(), values };
}

interface FakeDbState {
  execCalls: CapturedExec[];
  destinationsDeleted: number;
  dlqEntries: Map<string, {
    id: string;
    envelopeSnapshot: Record<string, unknown>;
    replayedAt: Date | null;
    replayedByUserId: string | null;
  }>;
  outboxRows: Array<{ envelopeId: string; envelope: unknown; [k: string]: unknown }>;
}

function makeFakeDb(): { db: AdminRunner; state: FakeDbState } {
  const state: FakeDbState = {
    execCalls: [],
    destinationsDeleted: 0,
    dlqEntries: new Map(),
    outboxRows: [],
  };

  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = interpolate(strings, values);
      state.execCalls.push(call);
      return 0;
    },
    $queryRaw: async () => [],
    broadcastDestination: {
      deleteMany: async () => {
        const count = state.destinationsDeleted;
        return { count };
      },
    },
    broadcastDlqEntry: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const entry = state.dlqEntries.get(where.id);
        if (!entry) return null;
        // Model the `include: { destination: { select: { tenantType, tenantId } } }`
        // the service passes — the destination's plaintext tenant identity is
        // what rehydrates redacted tenant ids on replay.
        return { ...entry, destination: { tenantType: 'organization', tenantId: DEST_TENANT_ID } };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const entry = state.dlqEntries.get(where.id);
        if (!entry) throw new Error('not found');
        if ('replayedAt' in data) entry.replayedAt = data.replayedAt as Date;
        if ('replayedByUserId' in data) entry.replayedByUserId = data.replayedByUserId as string;
        return entry;
      },
    },
    broadcastTraceOutbox: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.outboxRows.push({ envelopeId: data.envelopeId as string, envelope: data.envelope, ...data });
        return data;
      },
    },
  } as unknown as AdminRunner;

  const db = {
    ...(tx as unknown as Record<string, unknown>),
    $transaction: async <T>(fn: (t: AdminRunner) => Promise<T>) => fn(tx),
  } as unknown as AdminRunner;

  return { db, state };
}

// ─── erasure tests ──────────────────────────────────────────────────────

describe('BroadcastAdminService — eraseSubject', () => {
  let db: AdminRunner;
  let state: FakeDbState;
  let service: BroadcastAdminService;

  beforeEach(() => {
    ({ db, state } = makeFakeDb());
    service = new BroadcastAdminService({ db });
  });

  it('user erasure filters outbox by user_id column', async () => {
    const subject: Subject = { kind: 'user', userId: randomUUID() };
    await service.eraseSubject(subject);
    // First exec = outbox, must mention user_id (not organization_id)
    const outboxSql = state.execCalls[0]!.sql;
    expect(outboxSql).toMatch(/broadcast_trace_outbox/);
    expect(outboxSql).toMatch(/user_id\s*=/);
    expect(outboxSql).not.toMatch(/organization_id\s*=/);
  });

  it('organization erasure filters outbox by organization_id column', async () => {
    const subject: Subject = { kind: 'organization', organizationId: randomUUID() };
    await service.eraseSubject(subject);
    const outboxSql = state.execCalls[0]!.sql;
    expect(outboxSql).toMatch(/organization_id\s*=/);
    expect(outboxSql).not.toMatch(/user_id\s*=/);
  });

  it('deletes in 3 raw-SQL steps + 1 ORM deleteMany for destinations', async () => {
    await service.eraseSubject({ kind: 'organization', organizationId: randomUUID() });
    // outbox + dlq + delivery join = 3 exec calls; destinations via ORM (not captured)
    expect(state.execCalls).toHaveLength(3);
    expect(state.execCalls[1]!.sql).toMatch(/broadcast_dlq/);
    expect(state.execCalls[2]!.sql).toMatch(/broadcast_delivery/);
  });
});

// ─── replay tests ───────────────────────────────────────────────────────

describe('BroadcastAdminService — replayDlqEntry', () => {
  let db: AdminRunner;
  let state: FakeDbState;
  let service: BroadcastAdminService;

  beforeEach(() => {
    ({ db, state } = makeFakeDb());
    service = new BroadcastAdminService({ db });
  });

  function seedDlq(entryId: string, replayedAt: Date | null = null): void {
    state.dlqEntries.set(entryId, {
      id: entryId,
      envelopeSnapshot: {
        schemaVersion: '1.0.0',
        envelopeId: 'original-envelope-uuid',
        occurredAt: '2026-04-17T12:00:00Z',
        tenant: {
          organizationId: 'org-uuid',
          userId: 'user-uuid',
          resolutionScope: 'organization',
        },
      },
      replayedAt,
      replayedByUserId: null,
    });
  }

  it('writes a fresh outbox row with a new envelopeId', async () => {
    const entryId = randomUUID();
    seedDlq(entryId);
    const outcome = await service.replayDlqEntry({
      dlqEntryId: entryId,
      replayedByUserId: randomUUID(),
    });
    expect(outcome.requeued).toBe(true);
    expect(outcome.newEnvelopeId).not.toBe('original-envelope-uuid');
    expect(state.outboxRows).toHaveLength(1);
    const envelope = state.outboxRows[0]!.envelope as Record<string, unknown>;
    expect(envelope.envelopeId).toBe(outcome.newEnvelopeId);
    expect((envelope.metadata as Record<string, unknown>).replayedFromEnvelopeId).toBe(
      'original-envelope-uuid',
    );
  });

  it('marks the DLQ entry as replayed with the caller userId', async () => {
    const entryId = randomUUID();
    const principal = randomUUID();
    seedDlq(entryId);
    await service.replayDlqEntry({ dlqEntryId: entryId, replayedByUserId: principal });
    const entry = state.dlqEntries.get(entryId)!;
    expect(entry.replayedAt).toBeInstanceOf(Date);
    expect(entry.replayedByUserId).toBe(principal);
  });

  it('refuses to replay an already-replayed entry', async () => {
    const entryId = randomUUID();
    seedDlq(entryId, new Date('2026-04-16T00:00:00Z'));
    const outcome = await service.replayDlqEntry({
      dlqEntryId: entryId,
      replayedByUserId: randomUUID(),
    });
    expect(outcome.requeued).toBe(false);
    expect(outcome.reason).toContain('already replayed');
    expect(state.outboxRows).toHaveLength(0);
  });

  it('returns not-found for an unknown id', async () => {
    const outcome = await service.replayDlqEntry({
      dlqEntryId: randomUUID(),
      replayedByUserId: randomUUID(),
    });
    expect(outcome.requeued).toBe(false);
    expect(outcome.reason).toContain('not found');
  });

  it('threads forceInclude=true onto custom["broadcast.force_include"] + metadata', async () => {
    const entryId = randomUUID();
    seedDlq(entryId);
    const outcome = await service.replayDlqEntry({
      dlqEntryId: entryId,
      replayedByUserId: randomUUID(),
      forceInclude: true,
    });
    expect(outcome.requeued).toBe(true);
    const envelope = state.outboxRows[0]!.envelope as Record<string, unknown>;
    const custom = envelope.custom as Record<string, unknown>;
    expect(custom['broadcast.force_include']).toBe(true);
    const metadata = envelope.metadata as Record<string, unknown>;
    expect(metadata.forceInclude).toBe(true);
  });

  it('rehydrates privacy-redacted tenant ids from the destination row (P2007 regression)', async () => {
    // Regression for the redacted-replay bug: a privacy-redacted snapshot
    // carries '[REDACTED]' where TenantContext requires uuid-or-null. Before
    // rehydration this crashed the outbox insert (@db.Uuid columns) and the
    // destination resolver's ::uuid binds with Prisma P2007/P2010.
    const entryId = randomUUID();
    state.dlqEntries.set(entryId, {
      id: entryId,
      envelopeSnapshot: {
        schemaVersion: '1.0.0',
        envelopeId: 'original-envelope-uuid',
        occurredAt: '2026-04-17T12:00:00Z',
        tenant: {
          organizationId: '[REDACTED]',
          userId: '[REDACTED]',
          apiKeyId: '[REDACTED]',
          resolutionScope: 'organization',
        },
      },
      replayedAt: null,
      replayedByUserId: null,
    });

    const outcome = await service.replayDlqEntry({
      dlqEntryId: entryId,
      replayedByUserId: randomUUID(),
    });
    expect(outcome.requeued).toBe(true);

    // Outbox columns get the destination's plaintext tenant id — never the
    // '[REDACTED]' sentinel (which a uuid column would reject).
    const row = state.outboxRows[0]! as Record<string, unknown>;
    expect(row.organizationId).toBe(DEST_TENANT_ID);
    expect(row.userId).toBeNull();
    expect(row.apiKeyId).toBeNull();
    expect(row.resolutionScope).toBe('organization');

    // The cloned envelope's tenant block is TenantContextSchema-valid again,
    // so the resolver and any re-parse of the replayed envelope work.
    const envelope = row.envelope as Record<string, unknown>;
    const tenant = envelope.tenant as Record<string, unknown>;
    expect(tenant.organizationId).toBe(DEST_TENANT_ID);
    expect(tenant.userId).toBeNull();
    expect(tenant.apiKeyId).toBeNull();
    expect(JSON.stringify(envelope)).not.toContain('[REDACTED]');
  });

  it('does NOT set forceInclude marker when flag omitted (default preserves sampling)', async () => {
    const entryId = randomUUID();
    seedDlq(entryId);
    await service.replayDlqEntry({
      dlqEntryId: entryId,
      replayedByUserId: randomUUID(),
    });
    const envelope = state.outboxRows[0]!.envelope as Record<string, unknown>;
    const custom = (envelope.custom ?? {}) as Record<string, unknown>;
    expect(custom['broadcast.force_include']).toBeUndefined();
    const metadata = envelope.metadata as Record<string, unknown>;
    expect(metadata.forceInclude).toBe(false);
  });
});
