// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration tests for the broadcast destinations routes — exercises the
 * full Fastify handler pipeline via `server.inject`, with a stubbed
 * authenticate middleware and an in-memory DestinationManager.
 *
 * Focus areas (route-layer boundary):
 *   - 400 on invalid config payload (Zod validation bubbles up as `invalid_config`)
 *   - 404 (NOT 403) on cross-tenant reads — no existence leak
 *   - 201 on create; response body NEVER contains the decrypted config
 *   - GET list is tenant-scoped (user A never sees user B's destinations)
 *   - PATCH rotates DEK when config present (observed via kekResource + a
 *     fresh destination from DB)
 *   - DELETE returns 204 and subsequent GET returns 404 (soft-delete hides it)
 */

import { randomUUID, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before dynamic import) ─────────────────────────────

// Stub authenticate to inject a preset tenant identity. The route reads
// `request.userId` / `request.organizationId`, so we just set those.
const TEST_ORG_A = '11111111-1111-1111-1111-111111111111';
const TEST_ORG_B = '22222222-2222-2222-2222-222222222222';
const TEST_USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

let currentAuth: { userId: string; organizationId: string } = {
  userId: TEST_USER_A,
  organizationId: TEST_ORG_A,
};

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: async (request: FastifyRequest, _reply: FastifyReply) => {
    const r = request as unknown as { userId: string; organizationId: string };
    r.userId = currentAuth.userId;
    r.organizationId = currentAuth.organizationId;
  },
  requireRole: () => async (_request: FastifyRequest, _reply: FastifyReply) => {
    /* no-op: we rely on route-level tenant checks */
  },
}));

// Stub the composition-root cipher with a local KEK (no GCP KMS dependency).
vi.mock('@/broadcast/composition/broadcast-composition-root', async () => {
  const { DestinationConfigCipher } = await import('@/broadcast/infrastructure/encryption');
  const { LocalKekProvider } = await import('@/broadcast/infrastructure/encryption/kek-provider');
  const cipher = new DestinationConfigCipher({
    kek: new LocalKekProvider(randomBytes(32), 'local://route-test'),
  });
  return { getBroadcastCipher: () => cipher };
});

// In-memory fake for the prisma surface the DestinationManager uses.
// Mirrors the fake in destination-manager.test.ts but lives at module scope
// so the route's singleton manager sees it.
vi.mock('@/database/client', async () => {
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

  const rows = new Map<string, Row>();
  (globalThis as unknown as { __broadcastDestRows: Map<string, Row> }).__broadcastDestRows = rows;

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
      const result = [...rows.values()].filter(
        (r) =>
          r.tenantType === where.tenantType &&
          r.tenantId === where.tenantId &&
          (where.deletedAt === null ? r.deletedAt === null : true),
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
      const merged: Row = { ...row, ...(data as Partial<Row>), updatedAt: new Date() };
      rows.set(where.id, merged);
      return merged;
    },
  };
  return { prisma: { broadcastDestination } };
});

// ─── Test setup ─────────────────────────────────────────────────────────

async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify();
  const { broadcastDestinationsRoutes } = await import('../broadcast-destinations.routes');
  await server.register(broadcastDestinationsRoutes);
  await server.ready();
  return server;
}

function resetState() {
  const rows = (globalThis as unknown as { __broadcastDestRows?: Map<string, unknown> })
    .__broadcastDestRows;
  rows?.clear();
}

function validWebhookConfig() {
  return {
    url: 'https://hooks.example.com/receive',
    secret: 'super-secret-at-least-16-chars',
    signatureScheme: 'v1',
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('broadcast-destinations.routes — create', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetState();
    currentAuth = { userId: TEST_USER_A, organizationId: TEST_ORG_A };
    server = await buildServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it('POST /v1/broadcast/destinations returns 201 with metadata (no decrypted config)', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/broadcast/destinations',
      payload: {
        destinationType: 'webhook',
        name: 'Test webhook',
        config: validWebhookConfig(),
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { destination: Record<string, unknown> };
    expect(body.destination.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.destination.destinationType).toBe('webhook');
    expect(body.destination.tenantType).toBe('organization');
    expect(body.destination.tenantId).toBe(TEST_ORG_A);
    // Hard assertion: the response MUST NOT leak any part of the config.
    expect(body.destination).not.toHaveProperty('config');
    expect(body.destination).not.toHaveProperty('configCiphertext');
    expect(body.destination).not.toHaveProperty('configDekWrapped');
    expect(JSON.stringify(body)).not.toContain('super-secret-at-least-16-chars');
  });

  it('POST returns 400 on invalid config (bad URL)', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/broadcast/destinations',
      payload: {
        destinationType: 'webhook',
        name: 'Bad',
        config: { url: 'not-a-url', secret: 'super-secret-at-least-16-chars', signatureScheme: 'v1' },
      },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: string };
    expect(body.error).toBe('invalid_config');
  });

  it('POST rejects cross-scope scope=user when userId missing from auth', async () => {
    currentAuth = { userId: '', organizationId: TEST_ORG_A } as unknown as typeof currentAuth;
    const response = await server.inject({
      method: 'POST',
      url: '/v1/broadcast/destinations?scope=user',
      payload: {
        destinationType: 'webhook',
        name: 'x',
        config: validWebhookConfig(),
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('broadcast-destinations.routes — list + get', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetState();
    currentAuth = { userId: TEST_USER_A, organizationId: TEST_ORG_A };
    server = await buildServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it('GET returns only the authenticated tenant\'s destinations', async () => {
    // Create one as org A, then switch identity to org B and create another.
    await server.inject({
      method: 'POST',
      url: '/v1/broadcast/destinations',
      payload: { destinationType: 'webhook', name: 'A', config: validWebhookConfig() },
    });
    currentAuth = { userId: 'u-b', organizationId: TEST_ORG_B };
    await server.inject({
      method: 'POST',
      url: '/v1/broadcast/destinations',
      payload: { destinationType: 'webhook', name: 'B', config: validWebhookConfig() },
    });

    // List as org B — must see exactly 1 (not 2).
    const listB = await server.inject({ method: 'GET', url: '/v1/broadcast/destinations' });
    expect(listB.statusCode).toBe(200);
    const bodyB = JSON.parse(listB.body) as { destinations: Array<{ name: string }> };
    expect(bodyB.destinations).toHaveLength(1);
    expect(bodyB.destinations[0]?.name).toBe('B');

    // Flip back and verify org A also sees exactly 1.
    currentAuth = { userId: TEST_USER_A, organizationId: TEST_ORG_A };
    const listA = await server.inject({ method: 'GET', url: '/v1/broadcast/destinations' });
    const bodyA = JSON.parse(listA.body) as { destinations: Array<{ name: string }> };
    expect(bodyA.destinations).toHaveLength(1);
    expect(bodyA.destinations[0]?.name).toBe('A');
  });

  it('GET by id across tenants returns 404 (not 403 — existence is private)', async () => {
    // Create as org A.
    const create = await server.inject({
      method: 'POST',
      url: '/v1/broadcast/destinations',
      payload: { destinationType: 'webhook', name: 'A-dest', config: validWebhookConfig() },
    });
    const id = (JSON.parse(create.body) as { destination: { id: string } }).destination.id;

    // Switch to org B — try to fetch org A's id.
    currentAuth = { userId: 'u-b', organizationId: TEST_ORG_B };
    const get = await server.inject({
      method: 'GET',
      url: `/v1/broadcast/destinations/${id}`,
    });
    expect(get.statusCode).toBe(404);
    const body = JSON.parse(get.body) as { error: string };
    expect(body.error).toBe('not_found');
  });
});

describe('broadcast-destinations.routes — update + delete', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetState();
    currentAuth = { userId: TEST_USER_A, organizationId: TEST_ORG_A };
    server = await buildServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it('PATCH metadata-only (no config) succeeds and does NOT rotate DEK', async () => {
    const create = await server.inject({
      method: 'POST',
      url: '/v1/broadcast/destinations',
      payload: { destinationType: 'webhook', name: 'original', config: validWebhookConfig() },
    });
    const id = (JSON.parse(create.body) as { destination: { id: string } }).destination.id;

    const rows = (globalThis as unknown as { __broadcastDestRows: Map<string, { configDekWrapped: Uint8Array }> })
      .__broadcastDestRows;
    const dekBefore = Buffer.from(rows.get(id)!.configDekWrapped);

    const patch = await server.inject({
      method: 'PATCH',
      url: `/v1/broadcast/destinations/${id}`,
      payload: { name: 'renamed', samplingRate: 0.5 },
    });
    expect(patch.statusCode).toBe(200);
    const body = JSON.parse(patch.body) as { destination: { name: string; samplingRate: unknown } };
    expect(body.destination.name).toBe('renamed');
    expect(Number(body.destination.samplingRate)).toBe(0.5);

    const dekAfter = Buffer.from(rows.get(id)!.configDekWrapped);
    expect(Buffer.compare(dekBefore, dekAfter)).toBe(0); // unchanged
  });

  it('PATCH with config rotates the DEK', async () => {
    const create = await server.inject({
      method: 'POST',
      url: '/v1/broadcast/destinations',
      payload: { destinationType: 'webhook', name: 'x', config: validWebhookConfig() },
    });
    const id = (JSON.parse(create.body) as { destination: { id: string } }).destination.id;

    const rows = (globalThis as unknown as { __broadcastDestRows: Map<string, { configDekWrapped: Uint8Array }> })
      .__broadcastDestRows;
    const dekBefore = Buffer.from(rows.get(id)!.configDekWrapped);

    const patch = await server.inject({
      method: 'PATCH',
      url: `/v1/broadcast/destinations/${id}`,
      payload: {
        config: {
          ...validWebhookConfig(),
          url: 'https://new-endpoint.example.com/hook',
        },
      },
    });
    expect(patch.statusCode).toBe(200);

    const dekAfter = Buffer.from(rows.get(id)!.configDekWrapped);
    expect(Buffer.compare(dekBefore, dekAfter)).not.toBe(0); // rotated
  });

  it('PATCH with invalid config returns 400', async () => {
    const create = await server.inject({
      method: 'POST',
      url: '/v1/broadcast/destinations',
      payload: { destinationType: 'webhook', name: 'x', config: validWebhookConfig() },
    });
    const id = (JSON.parse(create.body) as { destination: { id: string } }).destination.id;

    const patch = await server.inject({
      method: 'PATCH',
      url: `/v1/broadcast/destinations/${id}`,
      payload: { config: { url: 'not-a-url', secret: 'short', signatureScheme: 'v1' } },
    });
    expect(patch.statusCode).toBe(400);
  });

  it('DELETE returns 204 and subsequent GET returns 404', async () => {
    const create = await server.inject({
      method: 'POST',
      url: '/v1/broadcast/destinations',
      payload: { destinationType: 'webhook', name: 'doomed', config: validWebhookConfig() },
    });
    const id = (JSON.parse(create.body) as { destination: { id: string } }).destination.id;

    const del = await server.inject({
      method: 'DELETE',
      url: `/v1/broadcast/destinations/${id}`,
    });
    expect(del.statusCode).toBe(204);

    const get = await server.inject({
      method: 'GET',
      url: `/v1/broadcast/destinations/${id}`,
    });
    expect(get.statusCode).toBe(404);
  });

  it('DELETE of another tenant\'s id returns 404 (not 403)', async () => {
    const create = await server.inject({
      method: 'POST',
      url: '/v1/broadcast/destinations',
      payload: { destinationType: 'webhook', name: 'A', config: validWebhookConfig() },
    });
    const id = (JSON.parse(create.body) as { destination: { id: string } }).destination.id;

    currentAuth = { userId: 'u-b', organizationId: TEST_ORG_B };
    const del = await server.inject({
      method: 'DELETE',
      url: `/v1/broadcast/destinations/${id}`,
    });
    expect(del.statusCode).toBe(404);
  });

  it('POST with unknown destinationType is rejected by Fastify schema (400)', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/broadcast/destinations',
      payload: {
        destinationType: 'definitely-not-a-real-type',
        name: 'x',
        config: validWebhookConfig(),
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
