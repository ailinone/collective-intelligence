// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration test — GDPR/LGPD right-to-erasure cascade against a REAL DB.
 *
 * Gated behind the integration config (`pnpm test:integration`), which boots
 * a testcontainer Postgres with the broadcast migration applied. This is the
 * test that proves the cascade actually works end-to-end: FK ON DELETE, the
 * JSONB #>> path extraction on broadcast_dlq, and the tenant filter on the
 * outbox all behave as the unit tests claim under real Postgres semantics.
 *
 * Why integration, not unit:
 *   Unit tests assert the SQL we generate. Only a real DB can prove:
 *     - ON DELETE CASCADE actually fires
 *     - #>> ARRAY['tenant', 'userId'] extracts correctly from JSONB
 *     - UUID casts reject malformed input
 *     - Transaction atomicity: a partial erasure never leaks rows
 *
 * The fake-prisma suite in broadcast-admin-service.test.ts intentionally does
 * NOT exercise these — that's what this file is for.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '@/database/client';
import { BroadcastAdminService } from '../broadcast-admin-service';
import { startTestEnvironment, stopTestEnvironment } from '@/../tests/utils/test-environment';

// ─── Test setup ─────────────────────────────────────────────────────────

describe('BroadcastAdminService — erasure cascade (integration)', () => {
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
    await prisma.$executeRawUnsafe('DELETE FROM broadcast_destination');
  });

  it('erasing a user deletes their outbox rows and preserves other users', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const orgId = randomUUID();

    // Seed: two outbox rows for userA, one for userB.
    const now = new Date();
    await prisma.broadcastTraceOutbox.createMany({
      data: [
        {
          envelopeId: randomUUID(),
          schemaVersion: '1.0.0',
          organizationId: orgId,
          userId: userA,
          resolutionScope: 'organization',
          envelope: { tenant: { userId: userA } },
          occurredAt: now,
        },
        {
          envelopeId: randomUUID(),
          schemaVersion: '1.0.0',
          organizationId: orgId,
          userId: userA,
          resolutionScope: 'organization',
          envelope: { tenant: { userId: userA } },
          occurredAt: now,
        },
        {
          envelopeId: randomUUID(),
          schemaVersion: '1.0.0',
          organizationId: orgId,
          userId: userB,
          resolutionScope: 'organization',
          envelope: { tenant: { userId: userB } },
          occurredAt: now,
        },
      ],
    });

    const svc = new BroadcastAdminService();
    const tally = await svc.eraseSubject({ kind: 'user', userId: userA });

    expect(tally.outboxDeleted).toBe(2);
    const remaining = await prisma.broadcastTraceOutbox.count();
    expect(remaining).toBe(1);
    const byUser = await prisma.broadcastTraceOutbox.findFirst({ where: { userId: userB } });
    expect(byUser).not.toBeNull();
  });

  it('erasing a destination cascades to its deliveries AND its dlq entries (FK ON DELETE)', async () => {
    const orgId = randomUUID();
    const envelopeId = randomUUID();
    const now = new Date();

    // Outbox parent (delivery FKs to it + FKs to destination)
    await prisma.broadcastTraceOutbox.create({
      data: {
        envelopeId,
        schemaVersion: '1.0.0',
        organizationId: orgId,
        resolutionScope: 'organization',
        envelope: { tenant: { organizationId: orgId } },
        occurredAt: now,
      },
    });

    const destination = await prisma.broadcastDestination.create({
      data: {
        id: randomUUID(),
        tenantType: 'organization',
        tenantId: orgId,
        destinationType: 'webhook',
        name: 'will-be-erased',
        configCiphertext: Buffer.alloc(16),
        configIv: Buffer.alloc(12),
        configAuthTag: Buffer.alloc(16),
        configAad: 'x',
        configDekWrapped: Buffer.alloc(16),
        configKekResource: 'local://test',
      },
    });

    await prisma.broadcastDelivery.create({
      data: {
        envelopeId,
        destinationId: destination.id,
        status: 'sent',
        attempts: 1,
        firstAttemptAt: now,
        lastAttemptAt: now,
      },
    });

    await prisma.broadcastDlqEntry.create({
      data: {
        id: randomUUID(),
        envelopeId,
        destinationId: destination.id,
        envelopeSnapshot: { tenant: { organizationId: orgId } },
        errorClass: 'adapter_4xx',
        errorMessage: 'upstream rejected',
        totalAttempts: 5,
        firstAttemptedAt: now,
        deadLetteredAt: now,
      },
    });

    // Sanity: rows exist pre-erasure.
    expect(await prisma.broadcastDelivery.count()).toBe(1);
    expect(await prisma.broadcastDlqEntry.count()).toBe(1);

    const svc = new BroadcastAdminService();
    const tally = await svc.eraseSubject({ kind: 'organization', organizationId: orgId });

    expect(tally.destinationsDeleted).toBe(1);
    expect(tally.outboxDeleted).toBe(1);
    // Delivery count may be 0 from BOTH the explicit join DELETE AND the
    // cascade from destination removal. We only assert the end-state.
    expect(await prisma.broadcastDelivery.count()).toBe(0);
    expect(await prisma.broadcastDlqEntry.count()).toBe(0);
    expect(await prisma.broadcastDestination.count()).toBe(0);
  });

  it('JSONB path expression #>> on envelope_snapshot works for subject-only DLQ (no destination)', async () => {
    // Seed a DLQ row whose destination is from a DIFFERENT tenant, but the
    // envelope_snapshot JSON references the subject being erased. This tests
    // the fallback path in the service that deletes via JSON path, not via FK.
    const subjectUser = randomUUID();
    const otherOrg = randomUUID();
    const envelopeId = randomUUID();
    const now = new Date();

    await prisma.broadcastTraceOutbox.create({
      data: {
        envelopeId,
        schemaVersion: '1.0.0',
        organizationId: otherOrg,
        resolutionScope: 'organization',
        envelope: { tenant: { organizationId: otherOrg } },
        occurredAt: now,
      },
    });

    const destination = await prisma.broadcastDestination.create({
      data: {
        id: randomUUID(),
        tenantType: 'organization',
        tenantId: otherOrg,
        destinationType: 'webhook',
        name: 'other-tenant-dest',
        configCiphertext: Buffer.alloc(16),
        configIv: Buffer.alloc(12),
        configAuthTag: Buffer.alloc(16),
        configAad: 'x',
        configDekWrapped: Buffer.alloc(16),
        configKekResource: 'local://test',
      },
    });

    await prisma.broadcastDlqEntry.create({
      data: {
        id: randomUUID(),
        envelopeId,
        destinationId: destination.id,
        envelopeSnapshot: { tenant: { userId: subjectUser } }, // references the user
        errorClass: 'x',
        errorMessage: 'x',
        totalAttempts: 1,
        firstAttemptedAt: now,
        deadLetteredAt: now,
      },
    });

    const svc = new BroadcastAdminService();
    const tally = await svc.eraseSubject({ kind: 'user', userId: subjectUser });

    expect(tally.dlqDeleted).toBe(1);
    expect(await prisma.broadcastDlqEntry.count()).toBe(0);
    // Other tenant's destination must survive (subject is a user, not the org)
    expect(await prisma.broadcastDestination.count()).toBe(1);
  });

  it('runs inside a single transaction — partial delete rolls back on error', async () => {
    // Seed valid outbox + a destination. Then pass an invalid UUID to force
    // Postgres to throw mid-transaction. We then assert NO state changed.
    const orgId = randomUUID();
    const now = new Date();

    await prisma.broadcastTraceOutbox.create({
      data: {
        envelopeId: randomUUID(),
        schemaVersion: '1.0.0',
        organizationId: orgId,
        resolutionScope: 'organization',
        envelope: { tenant: { organizationId: orgId } },
        occurredAt: now,
      },
    });

    const before = await prisma.broadcastTraceOutbox.count();
    expect(before).toBe(1);

    const svc = new BroadcastAdminService();
    // An invalid UUID triggers the ::uuid cast to raise, aborting the tx.
    await expect(
      svc.eraseSubject({
        kind: 'organization',
        organizationId: 'not-a-uuid' as unknown as string,
      }),
    ).rejects.toBeDefined();

    // Confirm nothing was deleted.
    expect(await prisma.broadcastTraceOutbox.count()).toBe(1);
  });
});

describe('BroadcastAdminService — DLQ replay (integration)', () => {
  beforeAll(async () => {
    await startTestEnvironment();
  }, 120_000);

  afterAll(async () => {
    await stopTestEnvironment();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM broadcast_dlq');
    await prisma.$executeRawUnsafe('DELETE FROM broadcast_delivery');
    await prisma.$executeRawUnsafe('DELETE FROM broadcast_trace_outbox');
    await prisma.$executeRawUnsafe('DELETE FROM broadcast_destination');
  });

  it('writes a fresh outbox row and marks the DLQ entry replayed', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const origEnvelopeId = randomUUID();
    const replayerId = randomUUID();
    const now = new Date();

    await prisma.broadcastTraceOutbox.create({
      data: {
        envelopeId: origEnvelopeId,
        schemaVersion: '1.0.0',
        organizationId: orgId,
        userId,
        resolutionScope: 'organization',
        envelope: {
          envelopeId: origEnvelopeId,
          tenant: { organizationId: orgId, userId, resolutionScope: 'organization' },
          schemaVersion: '1.0.0',
          destinationType: 'webhook',
        },
        occurredAt: now,
      },
    });

    const destination = await prisma.broadcastDestination.create({
      data: {
        id: randomUUID(),
        tenantType: 'organization',
        tenantId: orgId,
        destinationType: 'webhook',
        name: 'd',
        configCiphertext: Buffer.alloc(16),
        configIv: Buffer.alloc(12),
        configAuthTag: Buffer.alloc(16),
        configAad: 'x',
        configDekWrapped: Buffer.alloc(16),
        configKekResource: 'local://test',
      },
    });

    const dlq = await prisma.broadcastDlqEntry.create({
      data: {
        id: randomUUID(),
        envelopeId: origEnvelopeId,
        destinationId: destination.id,
        envelopeSnapshot: {
          envelopeId: origEnvelopeId,
          tenant: { organizationId: orgId, userId, resolutionScope: 'organization' },
          schemaVersion: '1.0.0',
          destinationType: 'webhook',
          occurredAt: now.toISOString(),
        },
        errorClass: 'adapter_5xx',
        errorMessage: 'upstream 503',
        totalAttempts: 5,
        firstAttemptedAt: now,
        deadLetteredAt: now,
      },
    });

    const svc = new BroadcastAdminService();
    const outcome = await svc.replayDlqEntry({
      dlqEntryId: dlq.id,
      replayedByUserId: replayerId,
    });

    expect(outcome.requeued).toBe(true);
    expect(outcome.newEnvelopeId).not.toBe(origEnvelopeId);
    expect(outcome.newEnvelopeId).toMatch(/^[0-9a-f-]{36}$/);

    // Fresh outbox row exists with the new envelopeId.
    const freshRow = await prisma.broadcastTraceOutbox.findUnique({
      where: { envelopeId: outcome.newEnvelopeId },
    });
    expect(freshRow).not.toBeNull();
    const envelope = freshRow!.envelope as Record<string, unknown>;
    const metadata = envelope.metadata as Record<string, unknown> | undefined;
    expect(metadata?.replayedFromEnvelopeId).toBe(origEnvelopeId);
    expect(metadata?.replayedFromDlqId).toBe(dlq.id);

    // DLQ entry is marked replayed.
    const after = await prisma.broadcastDlqEntry.findUnique({ where: { id: dlq.id } });
    expect(after?.replayedAt).not.toBeNull();
    expect(after?.replayedByUserId).toBe(replayerId);

    // Second replay attempt is a no-op.
    const retry = await svc.replayDlqEntry({
      dlqEntryId: dlq.id,
      replayedByUserId: replayerId,
    });
    expect(retry.requeued).toBe(false);
    expect(retry.reason).toBe('dlq entry already replayed');
  });
});
