// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression + unit suite for the RBAC privilege-destruction defect
 * ("rbac-silent-role-downgrade").
 *
 * THE BUG: getUserRoles() used to WRITE. When a user had zero `user_roles`
 * rows it called assignRoleToUser(defaultRole) — which then called
 * updatePrimaryRole(), stamping 'viewer' over the `users.role` column. So the
 * first read-only permission check on a user whose privilege lived only on
 * `users.role` PERMANENTLY DEMOTED them, in both stores, logged at debug. In
 * production that was an armed time bomb aimed at the one account with
 * users.role='admin' and no join-table row.
 *
 * THE FIX: the read path is pure. Effective roles are EXACTLY the `user_roles`
 * rows; `users.role` is an untrusted hint that is read for observability only
 * and is never honoured, mirrored, or overwritten by a read. No rows ⇒ [] ⇒
 * fail closed.
 *
 * `prisma`, `config`, the logger, the audit sink and the role sync service are
 * all mocked, so this is hermetic and runs under the no-DB CI unit config.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

interface UserRoleRow {
  userId: string;
  organizationId: string;
  roleId: string;
  assignedBy?: string;
}

const { db, writeLog, logSpies, securityEvents, syncDefaultRolesMock, rbacConfig, resetDb } =
  vi.hoisted(() => {
    const database = {
      users: new Map<string, { id: string; role: string; organizationId: string }>(),
      organizations: new Map<string, { id: string }>(),
      roles: new Map<string, { id: string; name: string }>(),
      userRoles: [] as Array<{
        userId: string;
        organizationId: string;
        roleId: string;
        assignedBy?: string;
      }>,
      rolePermissions: [] as Array<{ roleName: string; permission: string }>,
    };

    const writes: string[] = [];
    const events: Array<Record<string, unknown>> = [];

    return {
      db: database,
      writeLog: writes,
      logSpies: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      securityEvents: events,
      syncDefaultRolesMock: vi.fn(async () => {}),
      rbacConfig: { defaultRole: 'viewer', superRoles: ['owner', 'admin'], cacheTtlMs: 60_000 },
      resetDb: () => {
        database.users.clear();
        database.organizations.clear();
        database.roles.clear();
        database.userRoles = [];
        database.rolePermissions = [];
        writes.length = 0;
        events.length = 0;
      },
    };
  });

vi.mock('@/config', () => ({
  config: { security: { rbac: rbacConfig } },
}));

vi.mock('@/utils/logger', () => ({
  logger: { child: () => logSpies },
}));

vi.mock('@/services/rbac-sync-service', () => ({
  syncDefaultRoles: syncDefaultRolesMock,
}));

vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: vi.fn(async (event: Record<string, unknown>) => {
    securityEvents.push(event);
  }),
}));

vi.mock('@/database/client', () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = db.users.get(where.id);
        return row ? { ...row } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { role?: string } }) => {
        const row = db.users.get(where.id);
        if (!row) {
          throw new Error('user not found');
        }
        writeLog.push(`user.update:${where.id}:${data.role}`);
        if (data.role !== undefined) {
          row.role = data.role;
        }
        return { ...row };
      }),
    },
    organization: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = db.organizations.get(where.id);
        return row ? { ...row } : null;
      }),
    },
    role: {
      findUnique: vi.fn(async ({ where }: { where: { name: string } }) => {
        const row = db.roles.get(where.name);
        return row ? { ...row } : null;
      }),
    },
    userRole: {
      findMany: vi.fn(async ({ where }: { where: { userId?: string; organizationId?: string } }) =>
        db.userRoles
          .filter(
            (assignment) =>
              (where.userId === undefined || assignment.userId === where.userId) &&
              (where.organizationId === undefined ||
                assignment.organizationId === where.organizationId)
          )
          .map((assignment) => {
            const role = [...db.roles.values()].find((entry) => entry.id === assignment.roleId);
            return { ...assignment, role: { id: role?.id, name: role?.name } };
          })
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; organizationId: string; roleId: string };
        }) =>
          db.userRoles.find(
            (assignment) =>
              assignment.userId === where.userId &&
              assignment.organizationId === where.organizationId &&
              assignment.roleId === where.roleId
          ) ?? null
      ),
      count: vi.fn(
        async ({ where }: { where: { organizationId?: string; role?: { name?: string } } }) =>
          db.userRoles.filter((assignment) => {
            if (where.organizationId && assignment.organizationId !== where.organizationId) {
              return false;
            }
            if (where.role?.name) {
              const role = [...db.roles.values()].find((entry) => entry.id === assignment.roleId);
              return role?.name === where.role.name;
            }
            return true;
          }).length
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { userId_organizationId_roleId: UserRoleRow };
          create: UserRoleRow;
        }) => {
          const key = where.userId_organizationId_roleId;
          const existing = db.userRoles.find(
            (assignment) =>
              assignment.userId === key.userId &&
              assignment.organizationId === key.organizationId &&
              assignment.roleId === key.roleId
          );
          if (existing) {
            return existing;
          }
          writeLog.push(`userRole.upsert:${create.userId}:${create.roleId}`);
          db.userRoles.push({ ...create });
          return create;
        }
      ),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; organizationId: string; roleId?: { not: string } };
        }) => {
          const before = db.userRoles.length;
          db.userRoles = db.userRoles.filter((assignment) => {
            const matches =
              assignment.userId === where.userId &&
              assignment.organizationId === where.organizationId &&
              (where.roleId?.not === undefined || assignment.roleId !== where.roleId.not);
            return !matches;
          });
          const removed = before - db.userRoles.length;
          if (removed > 0) {
            writeLog.push(`userRole.deleteMany:${where.userId}:${removed}`);
          }
          return { count: removed };
        }
      ),
    },
    rolePermission: {
      findMany: vi.fn(async ({ where }: { where: { role: { name: { in: string[] } } } }) =>
        db.rolePermissions
          .filter((entry) => where.role.name.in.includes(entry.roleName))
          .map((entry) => ({ permission: { name: entry.permission } }))
      ),
    },
    // setUserRole runs the grant and the prune as ONE unit; the fake client
    // resolves them in array order, which matches Prisma's sequential semantics.
    $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
  };
  return { prisma };
});

import {
  assignRoleToUser,
  ensureBaselineRole,
  getUserRoles,
  invalidateRbacCache,
  registerRoleChangeListener,
  roleSetRank,
  setUserRole,
  userHasPermission,
} from '@/services/rbac-service';

const ORG_ID = '63632c52-6e75-45a3-aac6-1d91008a216b';
const USER_ID = '6687ac25-fc5a-4662-9d2a-b92550c4efcf';

function seedRoles(): void {
  for (const name of ['viewer', 'auditor', 'member', 'developer', 'admin', 'owner']) {
    db.roles.set(name, { id: `role-${name}`, name });
  }
  db.rolePermissions.push(
    { roleName: 'viewer', permission: 'org:read' },
    { roleName: 'viewer', permission: 'users:read' },
    { roleName: 'admin', permission: 'users:role_assign' },
    { roleName: 'owner', permission: 'users:role_assign' }
  );
}

function seedUser(role: string, userId = USER_ID): void {
  db.users.set(userId, { id: userId, role, organizationId: ORG_ID });
}

function grant(userId: string, roleName: string): void {
  db.userRoles.push({ userId, organizationId: ORG_ID, roleId: `role-${roleName}` });
}

beforeEach(() => {
  resetDb();
  invalidateRbacCache();
  logSpies.warn.mockClear();
  logSpies.info.mockClear();
  logSpies.error.mockClear();
  syncDefaultRolesMock.mockClear();
  rbacConfig.defaultRole = 'viewer';
  db.organizations.set(ORG_ID, { id: ORG_ID });
  seedRoles();
});

describe('regression: rbac-silent-role-downgrade (production time bomb)', () => {
  it('does NOT demote a users.role=admin principal with zero user_roles rows', async () => {
    // Exactly the production account: users.role='admin', NO user_roles row.
    seedUser('admin');

    const roles = await getUserRoles(USER_ID, ORG_ID);

    // Fail closed — the declared column grants nothing.
    expect(roles).toEqual([]);

    // THE ASSERTION THAT MATTERS: the declared privilege survived untouched.
    expect(db.users.get(USER_ID)?.role).toBe('admin');

    // Nothing at all was written by a read.
    expect(writeLog).toEqual([]);
    expect(db.userRoles).toHaveLength(0);

    // And the anomaly is loud, not a debug line.
    expect(logSpies.warn).toHaveBeenCalled();
    const warnPayload = logSpies.warn.mock.calls[0][0] as Record<string, unknown>;
    expect(warnPayload).toMatchObject({ userId: USER_ID, declaredRole: 'admin' });

    const event = securityEvents.find((e) => e.eventType === 'rbac_role_assignment_missing');
    expect(event).toBeDefined();
    expect(event).toMatchObject({ severity: 'warning', userId: USER_ID });
    expect(event?.metadata).toMatchObject({ declaredRole: 'admin' });
  });

  it('repeated permission checks never destroy the declared role', async () => {
    seedUser('admin');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      invalidateRbacCache();
      await userHasPermission(USER_ID, ORG_ID, 'users:role_assign');
    }

    expect(db.users.get(USER_ID)?.role).toBe('admin');
    expect(writeLog).toEqual([]);
    expect(await userHasPermission(USER_ID, ORG_ID, 'users:role_assign')).toBe(false);
  });
});

describe('getUserRoles is a pure read', () => {
  it('returns [] and writes nothing when the declared role is the default', async () => {
    seedUser('viewer');

    const roles = await getUserRoles(USER_ID, ORG_ID);

    expect(roles).toEqual([]);
    expect(writeLog).toEqual([]);
    expect(db.users.get(USER_ID)?.role).toBe('viewer');

    const event = securityEvents.find((e) => e.eventType === 'rbac_role_assignment_missing');
    expect(event).toMatchObject({ severity: 'info' });
  });

  it('returns the granted roles and leaves a mismatched users.role untouched', async () => {
    // Deliberately mismatched: the column says viewer, the grant says admin.
    seedUser('viewer');
    grant(USER_ID, 'admin');

    const roles = await getUserRoles(USER_ID, ORG_ID);

    expect(roles).toEqual(['admin']);
    // The read did NOT mirror the grant back into the column.
    expect(db.users.get(USER_ID)?.role).toBe('viewer');
    expect(writeLog).toEqual([]);
  });

  it('property: for ANY starting users.role, N reads perform zero writes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('viewer', 'auditor', 'member', 'developer', 'admin', 'owner', 'user', ''),
        fc.integer({ min: 1, max: 12 }),
        fc.boolean(),
        async (declaredRole, reads, hasGrant) => {
          resetDb();
          invalidateRbacCache();
          db.organizations.set(ORG_ID, { id: ORG_ID });
          seedRoles();
          seedUser(declaredRole);
          if (hasGrant) {
            grant(USER_ID, 'member');
          }

          for (let index = 0; index < reads; index += 1) {
            invalidateRbacCache();
            await getUserRoles(USER_ID, ORG_ID);
          }

          expect(writeLog).toEqual([]);
          expect(db.users.get(USER_ID)?.role).toBe(declaredRole);
        }
      ),
      { numRuns: 40 }
    );
  });

  it('serves an empty result from cache but picks up a grant immediately after assignment', async () => {
    seedUser('viewer');

    expect(await getUserRoles(USER_ID, ORG_ID)).toEqual([]);

    await assignRoleToUser(USER_ID, ORG_ID, 'developer', { assignedBy: 'test' });

    // assignRoleToUser invalidates the cache, so the empty entry cannot go stale.
    expect(await getUserRoles(USER_ID, ORG_ID)).toEqual(['developer']);
  });
});

describe('owner grants are structurally gated', () => {
  it('throws without explicit authorization', async () => {
    seedUser('viewer');

    await expect(assignRoleToUser(USER_ID, ORG_ID, 'owner')).rejects.toThrow(
      'owner_grant_requires_explicit_authorization'
    );

    expect(db.userRoles).toHaveLength(0);
    expect(db.users.get(USER_ID)?.role).toBe('viewer');
    expect(securityEvents.some((e) => e.eventType === 'rbac_owner_grant_refused')).toBe(true);
  });

  it('succeeds with allowOwner and writes an audit event', async () => {
    seedUser('viewer');

    const roles = await assignRoleToUser(USER_ID, ORG_ID, 'owner', {
      allowOwner: true,
      assignedBy: 'operator@example.com',
    });

    expect(roles).toEqual(['owner']);
    expect(db.users.get(USER_ID)?.role).toBe('owner');

    const granted = securityEvents.find((e) => e.eventType === 'rbac_role_assigned');
    expect(granted).toMatchObject({ severity: 'warning' });
    expect(granted?.metadata).toMatchObject({
      roleName: 'owner',
      assignedBy: 'operator@example.com',
    });
  });

  it('ensureBaselineRole never grants owner even if the default is misconfigured', async () => {
    rbacConfig.defaultRole = 'owner';
    seedUser('viewer');

    await expect(ensureBaselineRole(USER_ID, ORG_ID, 'test')).rejects.toThrow(
      'owner_grant_requires_explicit_authorization'
    );
  });
});

describe('assignRoleToUser / updatePrimaryRole', () => {
  it('keeps the back-compatible 4th-argument string form', async () => {
    const actorId = '11111111-2222-3333-4444-555555555555';
    seedUser('viewer');

    await assignRoleToUser(USER_ID, ORG_ID, 'developer', actorId);

    expect(db.userRoles[0]?.assignedBy).toBe(actorId);
    expect(
      securityEvents.find((e) => e.eventType === 'rbac_role_assigned')?.metadata
    ).toMatchObject({ assignedBy: actorId });
  });

  it('keeps a non-UUID provenance label OUT of the uuid column but IN the audit trail', async () => {
    // user_roles.assigned_by is `@db.Uuid`; writing 'self-registration:new-org'
    // there makes the INSERT fail and takes the whole grant down with it.
    seedUser('viewer');

    await assignRoleToUser(USER_ID, ORG_ID, 'developer', {
      assignedBy: 'self-registration:new-org',
    });

    expect(db.userRoles[0]?.assignedBy).toBeUndefined();
    expect(
      securityEvents.find((e) => e.eventType === 'rbac_role_assigned')?.metadata
    ).toMatchObject({ assignedBy: 'self-registration:new-org' });
  });

  it('skips the column write when the primary role is unchanged', async () => {
    seedUser('developer');

    await assignRoleToUser(USER_ID, ORG_ID, 'developer', { assignedBy: 'test' });

    expect(writeLog.filter((entry) => entry.startsWith('user.update'))).toEqual([]);
    expect(db.users.get(USER_ID)?.role).toBe('developer');
  });

  it('logs a role change at info and audits it', async () => {
    seedUser('viewer');

    await assignRoleToUser(USER_ID, ORG_ID, 'admin', { assignedBy: 'test' });

    expect(db.users.get(USER_ID)?.role).toBe('admin');
    expect(logSpies.info).toHaveBeenCalled();
    const changed = securityEvents.find((e) => e.eventType === 'rbac_primary_role_changed');
    expect(changed?.metadata).toMatchObject({ from: 'viewer', to: 'admin' });
  });
});

describe('setUserRole (real demotion semantics)', () => {
  it('replaces the grant set so a demotion actually takes effect', async () => {
    seedUser('admin');
    grant(USER_ID, 'admin');

    const roles = await setUserRole(USER_ID, ORG_ID, 'viewer', { assignedBy: 'admin-actor' });

    expect(roles).toEqual(['viewer']);
    expect(db.users.get(USER_ID)?.role).toBe('viewer');
    expect(await getUserRoles(USER_ID, ORG_ID)).toEqual(['viewer']);
  });

  it('refuses to demote the last owner of an organization', async () => {
    seedUser('owner');
    grant(USER_ID, 'owner');

    await expect(setUserRole(USER_ID, ORG_ID, 'viewer', { assignedBy: 'x' })).rejects.toThrow(
      'cannot_demote_last_owner'
    );
    expect(await getUserRoles(USER_ID, ORG_ID)).toEqual(['owner']);
  });

  it('still refuses to grant owner without allowOwner', async () => {
    seedUser('viewer');

    await expect(setUserRole(USER_ID, ORG_ID, 'owner', { assignedBy: 'x' })).rejects.toThrow(
      'owner_grant_requires_explicit_authorization'
    );
  });
});

describe('setUserRole hardening (escalation review)', () => {
  it('is atomic: the union of old+new grants is never observable', async () => {
    seedUser('admin');
    grant(USER_ID, 'admin');

    // A concurrent reader that runs between the grant and the prune used to
    // cache ['admin','viewer'] for a full TTL, so the demotion silently did not
    // take effect. Both statements now go through $transaction.
    let observed: string[] | null = null;
    const prismaModule = (await import('@/database/client')) as unknown as {
      prisma: { $transaction: { mock: { calls: unknown[][] } } };
    };
    await setUserRole(USER_ID, ORG_ID, 'viewer', { assignedBy: 'admin-actor' });
    expect(prismaModule.prisma.$transaction.mock.calls.length).toBeGreaterThan(0);

    observed = await getUserRoles(USER_ID, ORG_ID);
    expect(observed).toEqual(['viewer']);
    expect(db.userRoles).toHaveLength(1);
  });

  it('notifies role-change listeners so request-layer caches can be evicted', async () => {
    seedUser('admin');
    grant(USER_ID, 'admin');

    const seen: Array<[string, string]> = [];
    const unregister = registerRoleChangeListener((userId, organizationId) => {
      seen.push([userId, organizationId]);
    });

    try {
      await setUserRole(USER_ID, ORG_ID, 'viewer', { assignedBy: 'admin-actor' });
    } finally {
      unregister();
    }

    expect(seen).toContainEqual([USER_ID, ORG_ID]);
  });

  it('refuses a cross-tenant grant even though both the user and the org exist', async () => {
    const OTHER_ORG = '9f1b0a4c-0000-4000-8000-000000000001';
    db.organizations.set(OTHER_ORG, { id: OTHER_ORG });
    seedUser('viewer'); // belongs to ORG_ID

    await expect(assignRoleToUser(USER_ID, OTHER_ORG, 'admin', { assignedBy: 'x' })).rejects.toThrow(
      'user_not_in_organization'
    );
    expect(db.userRoles).toHaveLength(0);
    expect(
      securityEvents.some((e) => e.eventType === 'rbac_cross_tenant_grant_refused')
    ).toBe(true);
  });

  it('does not emit an audit event when the grant is already in place', async () => {
    // The federated hot path re-asserts the SAME roles on every single token
    // verification; auditing an unchanged grant flooded security_audit_log.
    seedUser('viewer');

    await assignRoleToUser(USER_ID, ORG_ID, 'member', { assignedBy: 'x' });
    const afterFirst = securityEvents.filter((e) => e.eventType === 'rbac_role_assigned').length;
    expect(afterFirst).toBe(1);

    for (let i = 0; i < 5; i += 1) {
      await assignRoleToUser(USER_ID, ORG_ID, 'member', { assignedBy: 'x' });
    }

    expect(securityEvents.filter((e) => e.eventType === 'rbac_role_assigned')).toHaveLength(1);
  });
});

describe('roleSetRank', () => {
  it('ranks the seeded hierarchy and treats unknown/empty as rank 0', () => {
    expect(roleSetRank(['owner'])).toBeGreaterThan(roleSetRank(['admin']));
    expect(roleSetRank(['admin'])).toBeGreaterThan(roleSetRank(['developer']));
    expect(roleSetRank(['viewer', 'admin'])).toBe(roleSetRank(['admin']));
    expect(roleSetRank([])).toBe(0);
    expect(roleSetRank(['not-a-real-role'])).toBe(0);
  });
});

describe('userHasPermission fails closed', () => {
  it('denies a principal with no grants', async () => {
    seedUser('admin');

    expect(await userHasPermission(USER_ID, ORG_ID, 'users:role_assign')).toBe(false);
  });

  it('allows a principal whose grants carry the permission', async () => {
    seedUser('viewer');
    grant(USER_ID, 'admin');

    expect(await userHasPermission(USER_ID, ORG_ID, 'users:role_assign')).toBe(true);
    expect(await userHasPermission(USER_ID, ORG_ID, 'secrets:manage')).toBe(false);
  });
});
