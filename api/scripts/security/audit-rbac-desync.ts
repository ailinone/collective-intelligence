// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RBAC desync audit — READ-ONLY.
 *
 *   pnpm run rbac:audit
 *   pnpm run rbac:audit -- --organization-id <uuid>
 *   pnpm run rbac:audit -- --json
 *
 * Reports the three states that the `users.role` / `user_roles` split can drift
 * into. It performs SELECTs only — no INSERT, UPDATE or DELETE — so it is safe
 * to run against production.
 *
 *   (1) users with ZERO `user_roles` rows. Under the fail-closed RBAC read path
 *       these principals resolve to NO roles at all: they are locked out, and
 *       whatever `users.role` claims about them is a declared hint that grants
 *       nothing. This is the worklist for `rbac:grant-owner`.
 *   (2) users whose `users.role` disagrees with the computed primary of their
 *       actual grants — the denormalized mirror has drifted (someone wrote the
 *       column out of band).
 *   (3) organizations with NO owner. An organization with no owner has nobody
 *       who can administer it; fixing that is a deliberate operator action.
 *
 * Requires DATABASE_URL in the operator's own shell. Nothing here runs at boot,
 * in CI, or as part of a deploy.
 */

import { prisma } from '@/database/client';

const ROLE_PRIORITY: Record<string, number> = {
  viewer: 1,
  auditor: 2,
  member: 3,
  developer: 4,
  admin: 5,
  owner: 6,
};

interface Args {
  organizationId?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      // `pnpm run <script> -- --flag` forwards the bare `--` separator.
      case '--':
        break;
      case '--organization-id':
        args.organizationId = argv[index + 1];
        index += 1;
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (token.startsWith('--')) {
          throw new Error(`Unknown argument: ${token}`);
        }
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`
RBAC desync audit (READ-ONLY)

  pnpm run rbac:audit [-- --organization-id <uuid>] [-- --json]

Options
  --organization-id <uuid>  Restrict the report to a single organization.
  --json                    Emit machine-readable JSON instead of a report.
  --help                    Show this message.

Requires DATABASE_URL. Performs SELECTs only.
`);
}

function computePrimary(roles: string[]): string | null {
  if (roles.length === 0) {
    return null;
  }
  return [...roles].sort((a, b) => (ROLE_PRIORITY[b] ?? 0) - (ROLE_PRIORITY[a] ?? 0))[0];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Refusing to run.');
    process.exit(1);
  }

  const userWhere = args.organizationId ? { organizationId: args.organizationId } : {};

  const users = await prisma.user.findMany({
    where: userWhere,
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      organizationId: true,
      createdAt: true,
      userRoles: { select: { role: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const withoutGrants = users
    .filter((user) => user.userRoles.length === 0)
    .map((user) => ({
      userId: user.id,
      email: user.email,
      declaredRole: user.role,
      status: user.status,
      organizationId: user.organizationId,
      createdAt: user.createdAt.toISOString(),
    }));

  const desynced = users
    .filter((user) => user.userRoles.length > 0)
    .map((user) => {
      const grantedRoles = user.userRoles.map((assignment) => assignment.role.name);
      return {
        userId: user.id,
        email: user.email,
        declaredRole: user.role,
        grantedRoles,
        computedPrimary: computePrimary(grantedRoles),
        organizationId: user.organizationId,
      };
    })
    .filter((entry) => entry.declaredRole !== entry.computedPrimary);

  const organizations = await prisma.organization.findMany({
    where: args.organizationId ? { id: args.organizationId } : {},
    select: { id: true, name: true, status: true },
    orderBy: { createdAt: 'asc' },
  });

  const ownerRows = await prisma.userRole.findMany({
    where: {
      role: { name: 'owner' },
      ...(args.organizationId ? { organizationId: args.organizationId } : {}),
    },
    select: { organizationId: true, userId: true },
  });
  const ownersByOrg = new Map<string, string[]>();
  for (const row of ownerRows) {
    const list = ownersByOrg.get(row.organizationId) ?? [];
    list.push(row.userId);
    ownersByOrg.set(row.organizationId, list);
  }

  const ownerlessOrganizations = organizations
    .filter((organization) => (ownersByOrg.get(organization.id) ?? []).length === 0)
    .map((organization) => ({
      organizationId: organization.id,
      name: organization.name,
      status: organization.status,
    }));

  const report = {
    scannedUsers: users.length,
    scannedOrganizations: organizations.length,
    usersWithoutRoleGrants: withoutGrants,
    declaredRoleDesyncs: desynced,
    organizationsWithoutOwner: ownerlessOrganizations,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('');
  console.log('RBAC desync audit (read-only)');
  console.log('─────────────────────────────');
  console.log(`Users scanned:          ${report.scannedUsers}`);
  console.log(`Organizations scanned:  ${report.scannedOrganizations}`);
  console.log('');

  console.log(`(1) Users with NO user_roles rows: ${withoutGrants.length}`);
  console.log('    These principals resolve to NO roles and are locked out.');
  console.log('    `declaredRole` is what users.role CLAIMS — it grants nothing.');
  for (const entry of withoutGrants) {
    console.log(
      `    - ${entry.email}  id=${entry.userId}  org=${entry.organizationId}  declaredRole=${entry.declaredRole}  status=${entry.status}`
    );
  }
  console.log('');

  console.log(`(2) users.role out of sync with actual grants: ${desynced.length}`);
  for (const entry of desynced) {
    console.log(
      `    - ${entry.email}  id=${entry.userId}  declared=${entry.declaredRole}  granted=[${entry.grantedRoles.join(', ')}]  computedPrimary=${entry.computedPrimary}`
    );
  }
  console.log('');

  console.log(`(3) Organizations with NO owner: ${ownerlessOrganizations.length}`);
  for (const entry of ownerlessOrganizations) {
    console.log(`    - ${entry.name}  id=${entry.organizationId}  status=${entry.status}`);
  }
  console.log('');
  console.log('Remediation is a deliberate operator action:');
  console.log('  pnpm run rbac:grant-owner -- --organization-id <uuid> --email <addr> \\');
  console.log('      --assigned-by <operator-identity>            # dry-run by default');
  console.log('');
}

main()
  .catch((error) => {
    console.error('rbac:audit failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
