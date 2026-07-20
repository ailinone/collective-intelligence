// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { config } from '@/config';
import { prisma } from '@/database/client';
import { syncDefaultRoles } from '@/services/rbac-sync-service';
import { logger } from '@/utils/logger';

interface CachedRoles {
  expiresAt: number;
  roles: string[];
}

interface CachedPermissions {
  expiresAt: number;
  permissions: Set<string>;
}

const log = logger.child({ component: 'rbac-service' });
const userRoleCache = new Map<string, CachedRoles>();
const permissionCache = new Map<string, CachedPermissions>();

const ROLE_PRIORITY: Record<string, number> = {
  viewer: 1,
  auditor: 2,
  member: 3,
  developer: 4,
  admin: 5,
  owner: 6,
};

function cacheKey(userId: string, organizationId: string): string {
  return `${userId}:${organizationId}`;
}

async function updatePrimaryRole(
  userId: string,
  organizationId: string,
  roles: string[]
): Promise<void> {
  if (roles.length === 0) {
    return;
  }
  const sorted = [...roles].sort((a, b) => {
    const priorityA = ROLE_PRIORITY[a] ?? 0;
    const priorityB = ROLE_PRIORITY[b] ?? 0;
    return priorityB - priorityA;
  });
  const primary = sorted[0];
  await prisma.user.update({
    where: { id: userId },
    data: { role: primary },
  });
  log.debug({ userId, organizationId, primary }, 'Primary role updated');
}

export async function assignRoleToUser(
  userId: string,
  organizationId: string,
  roleName: string,
  assignedBy?: string
): Promise<string[]> {
  const userExists = await prisma.user.findUnique({ where: { id: userId } });
  if (!userExists) {
    log.error({ userId, organizationId, roleName }, 'Unable to assign role: user not found');
    throw new Error(`user_not_found:${userId}`);
  }

  const organizationExists = await prisma.organization.findUnique({
    where: { id: organizationId },
  });
  if (!organizationExists) {
    log.error(
      { userId, organizationId, roleName },
      'Unable to assign role: organization not found'
    );
    throw new Error(`organization_not_found:${organizationId}`);
  }

  let role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) {
    log.warn(
      { userId, organizationId, roleName },
      'Role missing in database. Synchronizing default RBAC roles and retrying'
    );
    await syncDefaultRoles();
    role = await prisma.role.findUnique({ where: { name: roleName } });
  }
  if (!role) {
    throw new Error(`Role not found: ${roleName}`);
  }
  await prisma.userRole.upsert({
    where: {
      userId_organizationId_roleId: {
        userId,
        organizationId,
        roleId: role.id,
      },
    },
    update: {},
    create: {
      userId,
      organizationId,
      roleId: role.id,
      assignedBy,
    },
  });
  invalidateRbacCache(userId, organizationId);
  const assignedRoles = await prisma.userRole.findMany({
    where: { userId, organizationId },
    include: { role: true },
  });
  const roles = assignedRoles.map((assignment) => assignment.role.name);
  await updatePrimaryRole(userId, organizationId, roles);
  return roles;
}

export async function getUserRoles(userId: string, organizationId: string): Promise<string[]> {
  const key = cacheKey(userId, organizationId);
  const cached = userRoleCache.get(key);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.roles;
  }

  const assignments = await prisma.userRole.findMany({
    where: { userId, organizationId },
    include: { role: true },
  });

  if (assignments.length === 0) {
    const roles = await assignRoleToUser(userId, organizationId, config.security.rbac.defaultRole);
    userRoleCache.set(key, {
      expiresAt: now + config.security.rbac.cacheTtlMs,
      roles,
    });
    return roles;
  }

  const roles = assignments.map((assignment) => assignment.role.name);

  userRoleCache.set(key, {
    expiresAt: now + config.security.rbac.cacheTtlMs,
    roles,
  });

  await updatePrimaryRole(userId, organizationId, roles);

  return roles;
}

export async function userHasPermission(
  userId: string,
  organizationId: string,
  permission: string
): Promise<boolean> {
  const key = cacheKey(userId, organizationId);
  const cached = permissionCache.get(key);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.permissions.has(permission);
  }

  const roles = await getUserRoles(userId, organizationId);
  const rolePermissions = await prisma.rolePermission.findMany({
    where: { role: { name: { in: roles } } },
    include: { permission: true },
  });

  const permissionSet = new Set(rolePermissions.map((entry) => entry.permission.name));

  permissionCache.set(key, {
    expiresAt: now + config.security.rbac.cacheTtlMs,
    permissions: permissionSet,
  });

  return permissionSet.has(permission);
}

export function invalidateRbacCache(userId?: string, organizationId?: string): void {
  if (!userId || !organizationId) {
    userRoleCache.clear();
    permissionCache.clear();
    return;
  }
  const key = cacheKey(userId, organizationId);
  userRoleCache.delete(key);
  permissionCache.delete(key);
}

export async function requirePermission(
  userId: string,
  organizationId: string,
  permission: string
): Promise<void> {
  const allowed = await userHasPermission(userId, organizationId, permission);
  if (!allowed) {
    log.warn({ userId, organizationId, permission }, 'RBAC permission denied');
    throw new Error('permission_denied');
  }
}

export async function getPermissionsForRoles(roles: string[]): Promise<string[]> {
  const rolePermissions = await prisma.rolePermission.findMany({
    where: { role: { name: { in: roles } } },
    include: { permission: true },
  });
  return rolePermissions.map((entry) => entry.permission.name);
}
