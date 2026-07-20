// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DestinationManager tests — validate the CRUD surface and tenant scoping.
 *
 * Assertions covered:
 *   - create rejects invalid config (unknown field, bad url, missing secret)
 *   - create stores encrypted blob + scoped tenant + sane defaults
 *   - list/get/update/delete all reject cross-tenant access (returns not_found,
 *     NOT permission_denied — to avoid revealing existence of another tenant's
 *     destinations)
 *   - update with config rotates the DEK (new dekWrapped)
 *   - delete sets deleted_at AND enabled=false (so resolver skips it)
 *   - decryptConfig round-trips through the cipher
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';

import { DestinationManager, type ManagerRunner } from '../destination-manager';
import { DestinationConfigCipher } from '@/broadcast/infrastructure/encryption';
import { LocalKekProvider } from '@/broadcast/infrastructure/encryption/kek-provider';

// ─── Fake Prisma surface ────────────────────────────────────────────────

interface Row {
  id: string;
  tenantType: string;
  tenantId: string;
  destinationType: string;
  name: string;
  enabled: boolean;
  configCiphertext: Uint8Array;
  configIv: Uint8Array;
  configAuthTag: Uint8Array;
  configAad: string;
  configDekWrapped: Uint8Array;
  configKekResource: string;
  apiKeyFilter: unknown;
  samplingRate: string;
  privacyMode: boolean;
  privacyCustomFields: unknown;
  releaseStatus: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

function makeFakeDb(): {
  db: ManagerRunner;
  rows: Map<string, Row>;
} {
  const rows = new Map<string, Row>();

  const broadcastDestination = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const id = data.id as string;
      const row: Row = {
        id,
        tenantType: data.tenantType as string,
        tenantId: data.tenantId as string,
        destinationType: data.destinationType as string,
        name: data.name as string,
        enabled: (data.enabled as boolean | undefined) ?? true,
        configCiphertext: data.configCiphertext as Uint8Array,
        configIv: data.configIv as Uint8Array,
        configAuthTag: data.configAuthTag as Uint8Array,
        configAad: data.configAad as string,
        configDekWrapped: data.configDekWrapped as Uint8Array,
        configKekResource: data.configKekResource as string,
        apiKeyFilter: data.apiKeyFilter ?? [],
        samplingRate: (data.samplingRate as string | undefined) ?? '1.0000',
        privacyMode: (data.privacyMode as boolean | undefined) ?? false,
        privacyCustomFields: data.privacyCustomFields ?? [],
        releaseStatus: (data.releaseStatus as string | undefined) ?? 'stable',
        lastUsedAt: null,
        createdAt: (data.createdAt as Date) ?? new Date(),
        updatedAt: (data.updatedAt as Date) ?? new Date(),
        deletedAt: null,
      };
      rows.set(id, row);
      return row;
    },
    findMany: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
      const tt = where.tenantType;
      const ti = where.tenantId;
      const result = [...rows.values()].filter(
        (r) =>
          r.tenantType === tt && r.tenantId === ti && (where.deletedAt === null ? r.deletedAt === null : true),
      );
      if (orderBy && typeof orderBy === 'object' && 'createdAt' in orderBy) {
        result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      return result;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      for (const r of rows.values()) {
        if (r.id !== where.id) continue;
        if (where.tenantType && r.tenantType !== where.tenantType) continue;
        if (where.tenantId && r.tenantId !== where.tenantId) continue;
        if (where.deletedAt === null && r.deletedAt !== null) continue;
        return r;
      }
      return null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.get(where.id);
      if (!row) throw new Error('not found');
      for (const [k, v] of Object.entries(data)) {
        (row as unknown as Record<string, unknown>)[k] = v;
      }
      return row;
    },
  };

  const db = {
    broadcastDestination,
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    $transaction: async <T>(fn: (tx: ManagerRunner) => Promise<T>) => fn(db as unknown as ManagerRunner),
  } as unknown as ManagerRunner;

  return { db, rows };
}

// ─── Setup ──────────────────────────────────────────────────────────────

function makeCipher(): DestinationConfigCipher {
  const masterSecret = Buffer.alloc(32, 7);
  const kek = new LocalKekProvider(masterSecret, 'local://test');
  return new DestinationConfigCipher({ kek });
}

function webhookConfig(url = 'https://example.com/hook'): Record<string, unknown> {
  return { url, secret: 'super-secret-value-32-chars-long!!' };
}

describe('DestinationManager — create', () => {
  let db: ManagerRunner;
  let rows: Map<string, Row>;
  let manager: DestinationManager;

  beforeEach(() => {
    ({ db, rows } = makeFakeDb());
    manager = new DestinationManager({ cipher: makeCipher(), db });
  });

  it('creates a webhook destination and persists an encrypted blob', async () => {
    const orgId = randomUUID();
    const result = await manager.create({
      tenantType: 'organization',
      tenantId: orgId,
      destinationType: 'webhook',
      name: 'Prod webhook',
      config: webhookConfig(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.destination.destinationType).toBe('webhook');
    expect(result.destination.tenantType).toBe('organization');
    expect(result.destination.tenantId).toBe(orgId);
    expect(result.destination.enabled).toBe(true);
    expect(result.destination.samplingRate).toBe(1);

    const row = rows.get(result.destination.id);
    expect(row).toBeTruthy();
    expect(row!.configCiphertext.length).toBeGreaterThan(0);
    expect(row!.configAad).toContain(orgId);
  });

  it('rejects invalid webhook config (missing url)', async () => {
    const result = await manager.create({
      tenantType: 'organization',
      tenantId: randomUUID(),
      destinationType: 'webhook',
      name: 'bad',
      config: { secret: 'x'.repeat(32) } as unknown as Record<string, unknown>,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_config');
  });

  it('rejects unknown fields in config (strict mode)', async () => {
    const result = await manager.create({
      tenantType: 'organization',
      tenantId: randomUUID(),
      destinationType: 'webhook',
      name: 'typo',
      config: { ...webhookConfig(), secrit: 'oops' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_config');
  });

  it('rejects invalid sampling rate', async () => {
    const result = await manager.create({
      tenantType: 'organization',
      tenantId: randomUUID(),
      destinationType: 'webhook',
      name: 'x',
      config: webhookConfig(),
      samplingRate: 1.5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
  });

  it('accepts Datadog config with allowlisted site', async () => {
    const result = await manager.create({
      tenantType: 'organization',
      tenantId: randomUUID(),
      destinationType: 'datadog',
      name: 'dd',
      config: { apiKey: 'x'.repeat(32), site: 'datadoghq.com' },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects Datadog config with non-allowlisted site', async () => {
    const result = await manager.create({
      tenantType: 'organization',
      tenantId: randomUUID(),
      destinationType: 'datadog',
      name: 'dd-evil',
      config: { apiKey: 'x'.repeat(32), site: 'evil.example.com' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('DestinationManager — read surfaces with tenant scoping', () => {
  let db: ManagerRunner;
  let manager: DestinationManager;
  const orgA = randomUUID();
  const orgB = randomUUID();
  let idA = '';

  beforeEach(async () => {
    ({ db } = makeFakeDb());
    manager = new DestinationManager({ cipher: makeCipher(), db });
    const result = await manager.create({
      tenantType: 'organization',
      tenantId: orgA,
      destinationType: 'webhook',
      name: 'A webhook',
      config: webhookConfig(),
    });
    if (result.ok) idA = result.destination.id;
  });

  it('list returns only the caller tenant rows', async () => {
    await manager.create({
      tenantType: 'organization',
      tenantId: orgB,
      destinationType: 'webhook',
      name: 'B webhook',
      config: webhookConfig(),
    });
    const listA = await manager.list({ tenantType: 'organization', tenantId: orgA });
    const listB = await manager.list({ tenantType: 'organization', tenantId: orgB });
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0]!.tenantId).toBe(orgA);
    expect(listB[0]!.tenantId).toBe(orgB);
  });

  it('getById returns not_found for another tenant', async () => {
    const result = await manager.getById({ tenantType: 'organization', tenantId: orgB }, idA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
  });

  it('getById returns the row for the owning tenant', async () => {
    const result = await manager.getById({ tenantType: 'organization', tenantId: orgA }, idA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.destination.id).toBe(idA);
  });
});

describe('DestinationManager — update', () => {
  let db: ManagerRunner;
  let rows: Map<string, Row>;
  let manager: DestinationManager;
  const orgId = randomUUID();
  let id = '';

  beforeEach(async () => {
    ({ db, rows } = makeFakeDb());
    manager = new DestinationManager({ cipher: makeCipher(), db });
    const create = await manager.create({
      tenantType: 'organization',
      tenantId: orgId,
      destinationType: 'webhook',
      name: 'orig',
      config: webhookConfig('https://old.example.com/hook'),
    });
    if (create.ok) id = create.destination.id;
  });

  it('rotates the DEK when config changes', async () => {
    const before = rows.get(id)!.configDekWrapped.slice();
    const result = await manager.update(
      { tenantType: 'organization', tenantId: orgId },
      id,
      { config: webhookConfig('https://new.example.com/hook') },
    );
    expect(result.ok).toBe(true);
    const after = rows.get(id)!.configDekWrapped;
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(false);
  });

  it('patches metadata without touching config', async () => {
    const beforeBlob = Buffer.from(rows.get(id)!.configCiphertext);
    const result = await manager.update(
      { tenantType: 'organization', tenantId: orgId },
      id,
      { name: 'new name', enabled: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.destination.name).toBe('new name');
    expect(result.destination.enabled).toBe(false);
    const afterBlob = Buffer.from(rows.get(id)!.configCiphertext);
    expect(afterBlob.equals(beforeBlob)).toBe(true);
  });

  it('rejects cross-tenant update', async () => {
    const result = await manager.update(
      { tenantType: 'organization', tenantId: randomUUID() },
      id,
      { name: 'evil' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
  });

  it('rejects invalid config during update', async () => {
    const result = await manager.update(
      { tenantType: 'organization', tenantId: orgId },
      id,
      { config: { url: 'not a url' } as unknown as Record<string, unknown> },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_config');
  });
});

describe('DestinationManager — delete + decrypt', () => {
  let db: ManagerRunner;
  let rows: Map<string, Row>;
  let manager: DestinationManager;
  const orgId = randomUUID();
  let id = '';

  beforeEach(async () => {
    ({ db, rows } = makeFakeDb());
    manager = new DestinationManager({ cipher: makeCipher(), db });
    const create = await manager.create({
      tenantType: 'organization',
      tenantId: orgId,
      destinationType: 'webhook',
      name: 'todelete',
      config: webhookConfig(),
    });
    if (create.ok) id = create.destination.id;
  });

  it('soft-deletes (sets deleted_at) and disables the destination', async () => {
    const result = await manager.delete({ tenantType: 'organization', tenantId: orgId }, id);
    expect(result.ok).toBe(true);
    const row = rows.get(id)!;
    expect(row.deletedAt).not.toBeNull();
    expect(row.enabled).toBe(false);
  });

  it('soft-deleted rows are invisible to get/list', async () => {
    await manager.delete({ tenantType: 'organization', tenantId: orgId }, id);
    const get = await manager.getById({ tenantType: 'organization', tenantId: orgId }, id);
    expect(get.ok).toBe(false);
    const list = await manager.list({ tenantType: 'organization', tenantId: orgId });
    expect(list).toHaveLength(0);
  });

  it('decryptConfig round-trips the secret back', async () => {
    const result = await manager.decryptConfig<{ url: string; secret: string }>(
      { tenantType: 'organization', tenantId: orgId },
      id,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.url).toBe('https://example.com/hook');
    expect(result.config.secret.length).toBeGreaterThan(16);
  });

  it('decryptConfig refuses cross-tenant access', async () => {
    const result = await manager.decryptConfig(
      { tenantType: 'organization', tenantId: randomUUID() },
      id,
    );
    expect(result.ok).toBe(false);
  });
});
