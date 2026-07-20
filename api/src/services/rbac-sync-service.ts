// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { DEFAULT_PERMISSIONS, DEFAULT_ROLES } from '@/config/rbac-defaults';
import { isUniqueConstraintError } from '@/utils/prisma-error-helpers';

const log = logger.child({ component: 'rbac-sync' });

export async function syncDefaultPermissions(): Promise<void> {
  for (const permission of DEFAULT_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name: permission.name },
      update: {
        description: permission.description,
        category: permission.category ?? 'general',
      },
      create: {
        name: permission.name,
        description: permission.description,
        category: permission.category ?? 'general',
      },
    });
  }
}

export async function syncDefaultRoles(): Promise<void> {
  await syncDefaultPermissions();

  for (const role of DEFAULT_ROLES) {
    const dbRole = await prisma.role.upsert({
      where: { name: role.name },
      update: {
        description: role.description,
      },
      create: {
        name: role.name,
        description: role.description,
      },
    });

    const permissions = await prisma.permission.findMany({
      where: { name: { in: role.permissions } },
      select: { id: true, name: true },
    });

    const existing = await prisma.rolePermission.findMany({
      where: { roleId: dbRole.id },
      select: { permissionId: true },
    });

    const existingPermissionIds = new Set(existing.map((item) => item.permissionId));
    for (const permission of permissions) {
      if (!existingPermissionIds.has(permission.id)) {
        // Use upsert to handle race conditions
        // In a concurrent test environment, multiple processes may try to create the same rolePermission
        // We use upsert which is atomic, and silently ignore P2002 errors (unique constraint violations)
        // which indicate the record was created by another process
        try {
          await prisma.rolePermission.upsert({
            where: {
              roleId_permissionId: {
                roleId: dbRole.id,
                permissionId: permission.id,
              },
            },
            update: {
              // No changes needed if it already exists
            },
            create: {
              roleId: dbRole.id,
              permissionId: permission.id,
            },
          });
        } catch (error: unknown) {
          // P2002 = Unique constraint violation - another process created it concurrently
          // This is expected in parallel test execution and safe to ignore
          if (isUniqueConstraintError(error)) {
            // Silently continue - record exists now (created by concurrent process)
            // Only log at debug level to avoid noise in test logs
            log.debug(
              { roleId: dbRole.id, permissionId: permission.id },
              'RolePermission already exists (concurrent creation)'
            );
            continue;
          }
          // Re-throw non-P2002 errors (actual failures)
          throw error;
        }
      }
    }
  }

  log.info('Default RBAC roles and permissions synchronized');
}
