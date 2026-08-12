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
import { recordSecurityEvent } from '@/services/security-audit-service';
import { logger } from '@/utils/logger';

interface CachedRoles {
  expiresAt: number;
  roles: string[];
}

interface CachedPermissions {
  expiresAt: number;
  permissions: Set<string>;
}

/**
 * Options accepted by {@link assignRoleToUser}.
 *
 * `allowOwner` is the structural guard behind the "an owner is only ever created
 * deliberately" rule: granting the `owner` role throws unless the caller opts in
 * explicitly.
 *
 * It must carry an authorization DECISION that the caller has already made and
 * verified — never a mirror of request input (`allowOwner: body.role === 'owner'`
 * re-derives the flag from the attacker's own payload and reduces the guard to
 * a no-op). The permitted producers are:
 *   - the operator CLIs (`scripts/security/grant-org-owner.ts`,
 *     `scripts/setup-enterprise-organizations.ts`,
 *     `scripts/provision-email-code-users.ts`) — a human at a shell with
 *     DATABASE_URL;
 *   - `authorizeRoleChange` in the user-management routes, which returns the
 *     flag ONLY after proving the caller is itself a verified owner.
 *
 * Self-registration deliberately does NOT produce it: see
 * `RegisterUserHandler` — an anonymous, unverified internet caller never
 * bootstraps an owner.
 */
export interface AssignRoleOptions {
  allowOwner?: boolean;
  assignedBy?: string;
}

const log = logger.child({ component: 'rbac-service' });
const userRoleCache = new Map<string, CachedRoles>();
const permissionCache = new Map<string, CachedPermissions>();

export const OWNER_ROLE = 'owner';

const ROLE_PRIORITY: Record<string, number> = {
  viewer: 1,
  auditor: 2,
  member: 3,
  developer: 4,
  admin: 5,
  owner: 6,
};

/**
 * Rank of a role set — the highest-privileged role it contains, 0 when empty or
 * entirely unknown. Used to stop a lower-ranked principal acting on a
 * higher-ranked one (hierarchy inversion).
 */
export function roleSetRank(roles: string[]): number {
  return roles.reduce((rank, role) => Math.max(rank, ROLE_PRIORITY[role] ?? 0), 0);
}

function cacheKey(userId: string, organizationId: string): string {
  return `${userId}:${organizationId}`;
}

function normalizeAssignOptions(
  optionsOrAssignedBy?: AssignRoleOptions | string
): AssignRoleOptions {
  if (typeof optionsOrAssignedBy === 'string') {
    return { assignedBy: optionsOrAssignedBy };
  }
  return optionsOrAssignedBy ?? {};
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `user_roles.assigned_by` is a `uuid` column (schema.prisma:1118), so only an
 * actual user id can be stored there. Non-UUID provenance labels — e.g.
 * `self-registration:new-org`, or an operator's email from the bootstrap CLI —
 * would make the INSERT fail outright, taking the whole grant with it.
 *
 * The column therefore gets the UUID (or NULL), and the FULL provenance string
 * always travels in the security-audit event metadata, where it is free-form.
 * Nothing about who did what is lost.
 */
function assignedByColumnValue(assignedBy?: string): string | undefined {
  return assignedBy && UUID_REGEX.test(assignedBy) ? assignedBy : undefined;
}

/**
 * Mirror the authoritative `user_roles` grants into the denormalized
 * `users.role` column.
 *
 * SECURITY (rbac-silent-role-downgrade): this is now reachable ONLY from
 * `assignRoleToUser` — i.e. only when a grant actually changed. It used to also
 * run from the READ path (`getUserRoles`), which turned every permission check
 * into a write and silently destroyed any privilege that lived only on
 * `users.role`. Reads no longer write anything.
 *
 * A change here is logged at `info` (previously `debug`) and audited, so a
 * demotion can never again be invisible in production.
 */
async function updatePrimaryRole(
  userId: string,
  organizationId: string,
  roles: string[],
  currentRole?: string
): Promise<void> {
  if (roles.length === 0) {
    // Never blank the column: a revocation must not erase the declared role.
    return;
  }
  const sorted = [...roles].sort((a, b) => {
    const priorityA = ROLE_PRIORITY[a] ?? 0;
    const priorityB = ROLE_PRIORITY[b] ?? 0;
    return priorityB - priorityA;
  });
  const primary = sorted[0];

  const previous =
    currentRole ??
    (await prisma.user.findUnique({ where: { id: userId }, select: { role: true } }))?.role;

  if (previous === primary) {
    return;
  }

  await prisma.user.update({
    where: { id: userId },
    data: { role: primary },
  });

  log.info({ userId, organizationId, from: previous, to: primary }, 'Primary role changed');
  await recordSecurityEvent({
    eventType: 'rbac_primary_role_changed',
    severity: 'info',
    message: 'Denormalized primary role updated from role assignments',
    userId,
    organizationId,
    metadata: { from: previous ?? null, to: primary, roles },
  });
}

/**
 * Refuse an `owner` grant that did not arrive with an explicit, caller-proven
 * authorization decision. Structural, not conventional.
 */
async function assertOwnerGrantAuthorized(
  userId: string,
  organizationId: string,
  roleName: string,
  options: AssignRoleOptions
): Promise<void> {
  if (roleName !== OWNER_ROLE || options.allowOwner === true) {
    return;
  }
  log.error(
    { userId, organizationId, roleName, assignedBy: options.assignedBy },
    'Refused owner grant without explicit authorization'
  );
  await recordSecurityEvent({
    eventType: 'rbac_owner_grant_refused',
    severity: 'warning',
    message: 'Owner role grant refused: explicit authorization flag not supplied',
    userId,
    organizationId,
    metadata: { assignedBy: options.assignedBy ?? null },
  });
  throw new Error('owner_grant_requires_explicit_authorization');
}

/**
 * Resolve the grant target and assert the TENANCY invariant.
 *
 * SECURITY: a grant is `(user, organization, role)`. Verifying that the user
 * exists and the organization exists is not enough — the user must actually
 * BELONG to that organization, otherwise a caller who reaches this primitive
 * can mint authority for a principal in a different tenant. This used to be
 * enforced only by the route handlers; it belongs here, next to the write.
 */
async function loadGrantTarget(
  userId: string,
  organizationId: string,
  roleName: string
): Promise<{ id: string; role: string; organizationId: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
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

  if (user.organizationId !== organizationId) {
    log.error(
      { userId, organizationId, userOrganizationId: user.organizationId, roleName },
      'Refused cross-tenant role assignment'
    );
    await recordSecurityEvent({
      eventType: 'rbac_cross_tenant_grant_refused',
      severity: 'warning',
      message: 'Role assignment refused: target user does not belong to the organization',
      userId,
      organizationId,
      metadata: { roleName, userOrganizationId: user.organizationId },
    });
    throw new Error('user_not_in_organization');
  }

  return user;
}

/** Look the role up, seeding the default RBAC catalog once if it is missing. */
async function resolveRoleOrSync(
  roleName: string,
  context: { userId: string; organizationId: string }
): Promise<{ id: string; name: string }> {
  let role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) {
    log.warn(
      { ...context, roleName },
      'Role missing in database. Synchronizing default RBAC roles and retrying'
    );
    await syncDefaultRoles();
    role = await prisma.role.findUnique({ where: { name: roleName } });
  }
  if (!role) {
    throw new Error(`Role not found: ${roleName}`);
  }
  return role;
}

type RoleChangeListener = (userId: string, organizationId: string) => void;

const roleChangeListeners = new Set<RoleChangeListener>();

/**
 * Subscribe to authoritative grant changes.
 *
 * The global `apiKeyAuthMiddleware` keeps its OWN 30s context cache, separate
 * from the RBAC caches below, and that is the cache which decides what
 * `requireRole` sees for API-key traffic. A demotion that only cleared the RBAC
 * cache stayed ineffective for a full TTL. The middleware registers its
 * invalidator here at module load; the dependency points middleware → service,
 * so this module stays free of request-layer imports (and unit-testable without
 * pulling the whole auth stack in).
 */
export function registerRoleChangeListener(listener: RoleChangeListener): () => void {
  roleChangeListeners.add(listener);
  return () => roleChangeListeners.delete(listener);
}

function notifyRoleChanged(userId: string, organizationId: string): void {
  for (const listener of roleChangeListeners) {
    try {
      listener(userId, organizationId);
    } catch (error) {
      log.warn({ error, userId, organizationId }, 'Role-change listener failed');
    }
  }
}

export async function assignRoleToUser(
  userId: string,
  organizationId: string,
  roleName: string,
  optionsOrAssignedBy?: AssignRoleOptions | string
): Promise<string[]> {
  const options = normalizeAssignOptions(optionsOrAssignedBy);
  const assignedBy = options.assignedBy;

  await assertOwnerGrantAuthorized(userId, organizationId, roleName, options);
  const userExists = await loadGrantTarget(userId, organizationId, roleName);
  const role = await resolveRoleOrSync(roleName, { userId, organizationId });

  // Was this grant already in place? The federated hot path re-asserts the SAME
  // roles on every single token verification, so auditing an unchanged grant
  // wrote one `security_audit_log` row per role per request and buried the real
  // `rbac_owner_grant_refused` / `rbac_role_assignment_missing` events in noise.
  // Only an actual CHANGE is an event.
  const existingGrant = await prisma.userRole.findFirst({
    where: { userId, organizationId, roleId: role.id },
    select: { userId: true },
  });

  if (!existingGrant) {
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
        assignedBy: assignedByColumnValue(assignedBy),
      },
    });
    invalidateRbacCache(userId, organizationId);
    notifyRoleChanged(userId, organizationId);
  }

  const assignedRoles = await prisma.userRole.findMany({
    where: { userId, organizationId },
    include: { role: true },
  });
  const roles = assignedRoles.map((assignment) => assignment.role.name);

  if (!existingGrant) {
    await recordSecurityEvent({
      eventType: 'rbac_role_assigned',
      severity: roleName === OWNER_ROLE ? 'warning' : 'info',
      message: `Role "${roleName}" assigned`,
      userId,
      organizationId,
      metadata: { roleName, assignedBy: assignedBy ?? null, resultingRoles: roles },
    });
  }

  await updatePrimaryRole(userId, organizationId, roles, userExists.role);
  return roles;
}

/**
 * Would replacing this principal's grants with `roleName` orphan the
 * organization? Throws `cannot_demote_last_owner` if so.
 *
 * Exported so a route can pre-flight the decision BEFORE it writes anything
 * else: `setUserRole` is normally called after the profile columns have already
 * been updated, and a throw at that point returns 409 with a half-applied
 * request.
 */
export async function assertRoleChangeAllowed(
  userId: string,
  organizationId: string,
  roleName: string
): Promise<void> {
  if (roleName === OWNER_ROLE) {
    return;
  }

  const currentAssignments = await prisma.userRole.findMany({
    where: { userId, organizationId },
    include: { role: true },
  });
  const targetIsOwner = currentAssignments.some((assignment) => assignment.role.name === OWNER_ROLE);
  if (!targetIsOwner) {
    return;
  }

  const ownerCount = await prisma.userRole.count({
    where: { organizationId, role: { name: OWNER_ROLE } },
  });
  if (ownerCount <= 1) {
    log.error(
      { userId, organizationId, roleName },
      'Refused to demote the last owner of an organization'
    );
    throw new Error('cannot_demote_last_owner');
  }
}

/**
 * Replace a user's role set within one organization with exactly `roleName`.
 *
 * `assignRoleToUser` is purely additive (upsert), so it can never express a
 * DEMOTION — "set this compromised admin back to viewer" would silently leave
 * the admin grant in place and `updatePrimaryRole` would keep resolving to
 * admin. Administrative role changes need real "set" semantics.
 *
 * The grant and the prune run in ONE transaction. Doing them as two separate
 * statements left a window in which a concurrent permission check observed the
 * union (`['admin','viewer']`) and cached it for a full `cacheTtlMs`, so the
 * demotion did not take effect for up to a minute after it "succeeded".
 *
 * Guards:
 *   - granting `owner` still requires an `allowOwner` decision proven by the
 *     caller (never mirrored from request input);
 *   - the target must belong to `organizationId`;
 *   - the LAST owner of an organization is never demoted here (that would
 *     orphan the org) — use the operator CLI's explicit revoke mode.
 *
 * LIMITS a caller must know about (a demotion is NOT instantly global):
 *   - other API instances keep their own caches until TTL
 *     (`SECURITY_RBAC_CACHE_TTL_MS`, `API_KEY_AUTH_CACHE_TTL_MS`);
 *   - for a FEDERATED principal the identity provider is authoritative. The
 *     next federated token verification re-runs `syncFederatedRoles`, which
 *     re-grants whatever the IdP still asserts. Demote such a principal at the
 *     IdP, not here.
 */
export async function setUserRole(
  userId: string,
  organizationId: string,
  roleName: string,
  optionsOrAssignedBy?: AssignRoleOptions | string
): Promise<string[]> {
  const options = normalizeAssignOptions(optionsOrAssignedBy);
  const assignedBy = options.assignedBy;

  await assertOwnerGrantAuthorized(userId, organizationId, roleName, options);
  const user = await loadGrantTarget(userId, organizationId, roleName);
  await assertRoleChangeAllowed(userId, organizationId, roleName);
  const role = await resolveRoleOrSync(roleName, { userId, organizationId });

  const previousAssignments = await prisma.userRole.findMany({
    where: { userId, organizationId },
    include: { role: true },
  });
  const previousRoles = previousAssignments.map((assignment) => assignment.role.name);
  const changed = previousRoles.length !== 1 || previousRoles[0] !== roleName;

  if (changed) {
    // Atomic: grant then prune, with no observable intermediate state.
    await prisma.$transaction([
      prisma.userRole.upsert({
        where: {
          userId_organizationId_roleId: { userId, organizationId, roleId: role.id },
        },
        update: {},
        create: {
          userId,
          organizationId,
          roleId: role.id,
          assignedBy: assignedByColumnValue(assignedBy),
        },
      }),
      prisma.userRole.deleteMany({
        where: { userId, organizationId, roleId: { not: role.id } },
      }),
    ]);

    invalidateRbacCache(userId, organizationId);
    notifyRoleChanged(userId, organizationId);

    await recordSecurityEvent({
      eventType: 'rbac_role_set',
      severity: roleName === OWNER_ROLE ? 'warning' : 'info',
      message: `Roles replaced with "${roleName}"`,
      userId,
      organizationId,
      metadata: { roleName, assignedBy: assignedBy ?? null, previousRoles },
    });
  }

  const roles = [role.name];
  await updatePrimaryRole(userId, organizationId, roles, user.role);
  return roles;
}

/**
 * Explicit provisioning helper: grant the configured baseline (default) role.
 *
 * Provisioning paths call this DELIBERATELY. The read path
 * ({@link getUserRoles}) never does — that implicit write is exactly the defect
 * this change removes.
 */
export async function ensureBaselineRole(
  userId: string,
  organizationId: string,
  assignedBy?: string
): Promise<string[]> {
  return assignRoleToUser(userId, organizationId, config.security.rbac.defaultRole, {
    assignedBy,
  });
}

/**
 * Resolve the effective roles of a principal.
 *
 * INVARIANT (rbac-silent-role-downgrade): this is a PURE READ.
 *   - A user's effective roles are EXACTLY their `user_roles` rows.
 *   - `users.role` is an untrusted hint, never a grant — it is read here only
 *     for observability, and is never persisted, mirrored, or honoured.
 *   - No rows ⇒ `[]` ⇒ fail closed. Nothing is synthesized and nothing is
 *     written, so a declared privilege survives for an operator to inspect.
 *
 * Why `users.role` may not be trusted as a seed: it was historically writable to
 * `'admin'` by the unauthenticated `POST /v1/auth/register` path and to
 * `'owner'` by any org admin through `PUT /v1/users/:id`, in both cases without
 * a matching `user_roles` row. Seeding authority from it turns the desync this
 * fix rescues into a privilege-escalation oracle — which it literally was, on
 * the primary request path, until `api/src/api/middleware/api-key-auth-middleware.ts`
 * stopped seeding `request.user.roles` from it.
 */
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
    // Caching the empty result is safe: assignRoleToUser() invalidates the
    // cache, so a just-provisioned principal is picked up immediately.
    userRoleCache.set(key, {
      expiresAt: now + config.security.rbac.cacheTtlMs,
      roles: [],
    });

    // Observability ONLY. Read the declared column so an operator can see the
    // anomaly (npm run rbac:audit) — it grants nothing.
    let declaredRole: string | null = null;
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      declaredRole = user?.role ?? null;
    } catch (error) {
      log.warn({ error, userId, organizationId }, 'Failed to read declared role for diagnostics');
    }

    const defaultRole = config.security.rbac.defaultRole;
    const declaresElevated = Boolean(declaredRole && declaredRole !== defaultRole);

    log.warn(
      { userId, organizationId, declaredRole, defaultRole, declaresElevated },
      'rbac_role_assignment_missing: user has no role grants; denying (fail-closed) without writing'
    );
    await recordSecurityEvent({
      eventType: 'rbac_role_assignment_missing',
      severity: declaresElevated ? 'warning' : 'info',
      message: 'User has no role assignments; effective roles resolved as empty (fail-closed)',
      userId,
      organizationId,
      metadata: { declaredRole, defaultRole },
    });

    return [];
  }

  const roles = assignments.map((assignment) => assignment.role.name);

  userRoleCache.set(key, {
    expiresAt: now + config.security.rbac.cacheTtlMs,
    roles,
  });

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
  if (roles.length === 0) {
    // No grants ⇒ no permissions. Deny without a pointless empty-IN query.
    permissionCache.set(key, {
      expiresAt: now + config.security.rbac.cacheTtlMs,
      permissions: new Set<string>(),
    });
    return false;
  }

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
