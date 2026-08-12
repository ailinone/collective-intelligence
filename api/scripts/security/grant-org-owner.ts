// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Owner bootstrap CLI — the ONLY way an existing organization acquires an owner.
 *
 *   pnpm run rbac:grant-owner -- --organization-id <uuid> --email <addr> \
 *                                --assigned-by <operator-identity>
 *
 * There is deliberately no code path that grants `owner` automatically: the
 * RBAC service refuses the role unless the caller passes an `allowOwner`
 * DECISION, and the only producers are this script, the two operator
 * provisioning scripts, and `authorizeRoleChange` (which first proves the
 * caller is itself a verified owner). Self-registration does NOT grant owner —
 * an anonymous internet caller never bootstraps one. Creating an owner is a
 * human decision with an audit trail, not a side effect of a deploy.
 *
 * Safety properties:
 *   - `--dry-run` is the DEFAULT, and it really is one: the run performs NO
 *     writes at all before `--confirm` (the default-role sync is a write and now
 *     happens after the prompt). Mutating requires `--confirm` AND re-typing the
 *     target email.
 *   - refuses to run when NODE_ENV=test; requires DATABASE_URL from the
 *     operator's own shell.
 *   - refuses if the organization already has an owner unless `--replace` is
 *     passed, and `--replace` only ADDS — it never deletes an existing grant.
 *   - `--revoke-owner-from <user-id>` is a separate, explicit invocation.
 *   - `--from-declared-role` materializes the target's DECLARED `users.role`
 *     instead of `owner`; it is single-user only, prints the value, and still
 *     refuses `owner` unless `--allow-owner` is also passed. This is never
 *     bulk, never inferred, and never automatic — which is exactly what keeps
 *     "seed authority from users.role" out of the request path.
 *   - every grant goes through assignRoleToUser, so `users.role` is kept
 *     coherent by updatePrimaryRole and a security audit event is written.
 *   - granting an ELEVATING role (owner/admin) to a user that still has active
 *     API keys is refused unless the operator picks `--revoke-existing-keys` or
 *     `--accept-key-elevation`: API-key roles are resolved LIVE from
 *     `user_roles`, so those keys would silently become owner credentials.
 *
 * Nothing here is invoked by CI, by a deploy, or at boot.
 */

import readline from 'node:readline';
import { prisma } from '@/database/client';
import { assignRoleToUser, invalidateRbacCache } from '@/services/rbac-service';
import { syncDefaultRoles } from '@/services/rbac-sync-service';
import { recordSecurityEvent } from '@/services/security-audit-service';

interface Args {
  organizationId?: string;
  email?: string;
  userId?: string;
  assignedBy?: string;
  confirm: boolean;
  replace: boolean;
  revokeOwnerFrom?: string;
  fromDeclaredRole: boolean;
  allowOwner: boolean;
  revokeExistingKeys: boolean;
  acceptKeyElevation: boolean;
}

/** Roles that pass `requireRole('admin','owner')` and `config.security.rbac.superRoles`. */
const ELEVATING_ROLES = ['owner', 'admin'];

function printUsage(): void {
  console.log(`
Grant organization owner (deliberate operator action)

  pnpm run rbac:grant-owner -- --organization-id <uuid> (--email <addr> | --user-id <uuid>) \\
                               --assigned-by <operator-identity> [--confirm]

Options
  --organization-id <uuid>    REQUIRED. Target organization.
  --email <addr>              Target user by email (or use --user-id).
  --user-id <uuid>            Target user by id (or use --email).
  --assigned-by <identity>    REQUIRED. Who is making this decision. Recorded in the security
                              audit event; ALSO stored in user_roles.assigned_by when the value
                              is a UUID (that column is typed uuid, so an email lands in the
                              audit event only).
  --confirm                   Actually mutate. Without it this is a DRY RUN.
  --replace                   Proceed even if the org already has an owner (ADDS only).
  --revoke-owner-from <uuid>  Separate mode: remove the owner grant from this user.
  --from-declared-role        Materialize the target's declared users.role instead of 'owner'.
  --allow-owner               Required with --from-declared-role when the declared role IS 'owner'.
  --revoke-existing-keys      Revoke the target's existing API keys BEFORE the grant (recommended:
                              an API key resolves its roles LIVE, so every pre-existing key of this
                              user would otherwise inherit owner within ~30s).
  --accept-key-elevation      Proceed WITHOUT revoking, accepting that every existing key of this
                              user becomes an owner credential. One of these two is REQUIRED when
                              granting owner/admin to a user that has active API keys.
  --help                      Show this message.

Requires DATABASE_URL. Refuses to run with NODE_ENV=test.
`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    confirm: false,
    replace: false,
    fromDeclaredRole: false,
    allowOwner: false,
    revokeExistingKeys: false,
    acceptKeyElevation: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${token}`);
      }
      index += 1;
      return value;
    };

    switch (token) {
      // `pnpm run <script> -- --flag` forwards the bare `--` separator through
      // to argv; treat it as a no-op instead of an unknown argument.
      case '--':
        break;
      case '--organization-id':
        args.organizationId = next();
        break;
      case '--email':
        args.email = next().trim().toLowerCase();
        break;
      case '--user-id':
        args.userId = next();
        break;
      case '--assigned-by':
        args.assignedBy = next();
        break;
      case '--revoke-owner-from':
        args.revokeOwnerFrom = next();
        break;
      case '--confirm':
        args.confirm = true;
        break;
      case '--replace':
        args.replace = true;
        break;
      case '--from-declared-role':
        args.fromDeclaredRole = true;
        break;
      case '--allow-owner':
        args.allowOwner = true;
        break;
      case '--revoke-existing-keys':
        args.revokeExistingKeys = true;
        break;
      case '--accept-key-elevation':
        args.acceptKeyElevation = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

async function promptForEmail(expected: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`Re-type the target email to confirm (${expected}): `, (value) => {
      rl.close();
      resolve(value.trim().toLowerCase());
    });
  });
  return answer === expected.trim().toLowerCase();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (process.env.NODE_ENV === 'test') {
    throw new Error('Refusing to run with NODE_ENV=test');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Refusing to run.');
  }
  if (!args.organizationId) {
    printUsage();
    throw new Error('--organization-id is required');
  }
  if (!args.assignedBy) {
    printUsage();
    throw new Error('--assigned-by is required (who is making this decision?)');
  }

  const targetSelector = args.revokeOwnerFrom ?? args.userId;
  if (!targetSelector && !args.email) {
    printUsage();
    throw new Error('One of --email, --user-id or --revoke-owner-from is required');
  }

  // Preflight is READ-ONLY. `syncDefaultRoles()` issues permission/role/
  // rolePermission upserts with a populated `update:` clause, so calling it here
  // meant the documented "DRY RUN — nothing was written" was false. It now runs
  // only after --confirm and the email prompt (see below).
  const seededRoleNames = (
    await prisma.role.findMany({ select: { name: true } })
  ).map((role) => role.name);
  const missingRoles = ['viewer', 'auditor', 'member', 'developer', 'admin', 'owner'].filter(
    (name) => !seededRoleNames.includes(name)
  );

  const organization = await prisma.organization.findUnique({
    where: { id: args.organizationId },
    select: { id: true, name: true, status: true },
  });
  if (!organization) {
    throw new Error(`Organization not found: ${args.organizationId}`);
  }
  if (organization.status !== 'active') {
    throw new Error(`Organization is not active (status=${organization.status})`);
  }

  const user = targetSelector
    ? await prisma.user.findUnique({
        where: { id: targetSelector },
        select: { id: true, email: true, role: true, status: true, organizationId: true },
      })
    : await prisma.user.findUnique({
        where: { email: args.email as string },
        select: { id: true, email: true, role: true, status: true, organizationId: true },
      });

  if (!user) {
    throw new Error(`User not found: ${targetSelector ?? args.email}`);
  }
  if (user.organizationId !== organization.id) {
    throw new Error(
      `User ${user.email} belongs to organization ${user.organizationId}, not ${organization.id}`
    );
  }

  const existingGrants = await prisma.userRole.findMany({
    where: { userId: user.id, organizationId: organization.id },
    include: { role: { select: { name: true } } },
  });
  const existingRoleNames = existingGrants.map((grant) => grant.role.name);

  const orgOwners = await prisma.userRole.findMany({
    where: { organizationId: organization.id, role: { name: 'owner' } },
    select: { userId: true },
  });

  const mode = args.revokeOwnerFrom ? 'revoke-owner' : args.fromDeclaredRole ? 'declared' : 'owner';
  const roleToGrant = mode === 'declared' ? user.role : 'owner';

  // The target's live API keys. This is NOT cosmetic: the request path resolves
  // an API key's roles from the user's CURRENT grants on every cache miss (30s
  // TTL) — there is no per-key role snapshot. So the moment this script raises
  // the user to owner, EVERY existing key of that user authenticates as owner,
  // including on the requireRole('admin','owner')-gated /v1/tools/* shell, git
  // and filesystem surface. A key issued years ago for a narrow job silently
  // becomes a full owner credential. Make the operator see and decide.
  const activeKeys = await prisma.apiKey.findMany({
    where: { userId: user.id, status: { notIn: ['revoked', 'expired'] } },
    select: { id: true, name: true, keyPrefix: true, expiresAt: true, lastUsedAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const elevating = mode !== 'revoke-owner' && ELEVATING_ROLES.includes(roleToGrant ?? '');

  console.log('');
  console.log('Planned action');
  console.log('──────────────');
  console.log(`  mode:                 ${mode}`);
  console.log(`  organization:         ${organization.name} (${organization.id})`);
  console.log(`  user:                 ${user.email} (${user.id})`);
  console.log(`  user status:          ${user.status}`);
  console.log(`  users.role (declared): ${user.role}`);
  console.log(`  existing grants:      [${existingRoleNames.join(', ') || 'NONE'}]`);
  console.log(`  org owners today:     ${orgOwners.length}`);
  if (mode !== 'revoke-owner') {
    console.log(`  role to grant:        ${roleToGrant}`);
  }
  console.log(`  assignedBy:           ${args.assignedBy}`);
  console.log(`  active API keys:      ${activeKeys.length}`);
  console.log(`  mutating:             ${args.confirm ? 'YES (--confirm)' : 'NO (dry run)'}`);
  if (missingRoles.length > 0) {
    console.log(
      `  NOTE: default roles missing from the DB: [${missingRoles.join(', ')}] — they will be seeded on --confirm.`
    );
  }
  console.log('');

  if (elevating && activeKeys.length > 0) {
    console.log('API keys that WILL inherit this role');
    console.log('────────────────────────────────────');
    for (const key of activeKeys) {
      console.log(
        `  ${key.keyPrefix}…  ${key.name}  expires=${key.expiresAt?.toISOString() ?? 'NEVER'}  lastUsed=${
          key.lastUsedAt?.toISOString() ?? 'never'
        }`
      );
    }
    console.log('');
    if (!args.revokeExistingKeys && !args.acceptKeyElevation) {
      throw new Error(
        `Refusing to grant "${roleToGrant}" while ${activeKeys.length} active API key(s) exist for ${user.email}: ` +
          'each of them would authenticate as that role within API_KEY_AUTH_CACHE_TTL_MS. ' +
          'Re-run with --revoke-existing-keys (recommended: revoke first, re-issue after) ' +
          'or --accept-key-elevation to proceed deliberately.'
      );
    }
  }

  if (mode === 'declared') {
    if (!roleToGrant) {
      throw new Error('User has no declared role to materialize');
    }
    if (roleToGrant === 'owner' && !args.allowOwner) {
      throw new Error(
        'Declared role is "owner". Re-run with --allow-owner to materialize it deliberately.'
      );
    }
    console.log(
      `NOTE: users.role is an untrusted hint. You are choosing to materialize "${roleToGrant}"`
    );
    console.log('      for this ONE user after reading it yourself. Nothing is inferred.');
    console.log('');
  }

  if (mode === 'owner' && orgOwners.length > 0 && !args.replace) {
    throw new Error(
      `Organization already has ${orgOwners.length} owner(s). Re-run with --replace to ADD another (no existing grant is removed).`
    );
  }

  if (mode === 'revoke-owner' && !existingRoleNames.includes('owner')) {
    throw new Error(`User ${user.email} does not hold the owner role; nothing to revoke.`);
  }
  if (mode === 'revoke-owner' && orgOwners.length <= 1) {
    throw new Error(
      'Refusing to revoke the last owner of the organization. Grant owner to someone else first.'
    );
  }

  if (!args.confirm) {
    console.log('DRY RUN — nothing was written. Re-run with --confirm to apply.');
    return;
  }

  const confirmed = await promptForEmail(user.email);
  if (!confirmed) {
    throw new Error('Confirmation did not match the target email. Aborted; nothing was written.');
  }

  // First write of the run: make sure the six default roles exist.
  await syncDefaultRoles();

  if (args.revokeExistingKeys && activeKeys.length > 0) {
    await prisma.apiKey.updateMany({
      where: { id: { in: activeKeys.map((key) => key.id) } },
      data: {
        status: 'revoked',
        statusReason: `revoked by rbac:grant-owner before granting "${roleToGrant}" (${args.assignedBy})`,
      },
    });
    await recordSecurityEvent({
      eventType: 'api_keys_revoked_before_role_grant',
      severity: 'warning',
      message: 'Existing API keys revoked before an elevating role grant',
      userId: user.id,
      organizationId: organization.id,
      metadata: {
        assignedBy: args.assignedBy,
        roleToGrant,
        revokedKeyIds: activeKeys.map((key) => key.id),
      },
    });
    console.log(`Revoked ${activeKeys.length} API key(s) before the grant.`);
  }

  if (mode === 'revoke-owner') {
    const ownerRole = await prisma.role.findUnique({ where: { name: 'owner' } });
    if (!ownerRole) {
      throw new Error('Owner role missing from the database after syncDefaultRoles()');
    }
    await prisma.userRole.deleteMany({
      where: { userId: user.id, organizationId: organization.id, roleId: ownerRole.id },
    });
    invalidateRbacCache(user.id, organization.id);
    await recordSecurityEvent({
      eventType: 'rbac_owner_revoked',
      severity: 'warning',
      message: 'Owner role revoked by operator',
      userId: user.id,
      organizationId: organization.id,
      metadata: { assignedBy: args.assignedBy, previousRoles: existingRoleNames },
    });
  } else {
    await assignRoleToUser(user.id, organization.id, roleToGrant, {
      allowOwner: roleToGrant === 'owner',
      assignedBy: args.assignedBy,
    });
    if (roleToGrant === 'owner') {
      await recordSecurityEvent({
        eventType: 'rbac_owner_granted',
        severity: 'warning',
        message: 'Owner role granted by operator',
        userId: user.id,
        organizationId: organization.id,
        metadata: { assignedBy: args.assignedBy, previousRoles: existingRoleNames },
      });
    }
  }

  const after = await prisma.user.findUnique({
    where: { id: user.id },
    select: { role: true, userRoles: { include: { role: { select: { name: true } } } } },
  });

  console.log('');
  console.log('Result');
  console.log('──────');
  console.log(`  before: users.role=${user.role}  grants=[${existingRoleNames.join(', ') || 'NONE'}]`);
  console.log(
    `  after:  users.role=${after?.role}  grants=[${(after?.userRoles ?? [])
      .map((grant) => grant.role.name)
      .join(', ')}]`
  );
  console.log('');
  if (args.revokeExistingKeys) {
    console.log('NOTE: the target\'s previous API keys were REVOKED. Issue new ones as needed.');
  } else if (activeKeys.length > 0) {
    console.log(
      `NOTE: ${activeKeys.length} pre-existing API key(s) of this user now resolve to the new role`
    );
    console.log(
      '      within API_KEY_AUTH_CACHE_TTL_MS (default 30s). API-key roles are resolved LIVE from'
    );
    console.log('      user_roles on every cache miss — there is no per-key role snapshot.');
  }
  console.log('');
}

main()
  .catch((error) => {
    console.error('');
    console.error('rbac:grant-owner failed:', error instanceof Error ? error.message : error);
    console.error('Nothing was written unless a result block was printed above.');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
