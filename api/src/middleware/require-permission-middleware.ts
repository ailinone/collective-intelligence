// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Fine-grained RBAC authorization middleware.
 *
 * SEC-01: the RBAC data model (Role / Permission / RolePermission / UserRole)
 * is seeded by `scripts/security/sync-roles.ts` (via `syncDefaultRoles`) but was
 * never consulted at request time — authorization relied solely on the coarse
 * JWT-claim `requireRole`. `requirePermission` closes that gap: it resolves the
 * authenticated principal's *effective* permissions (UserRole -> RolePermission
 * -> Permission, scoped to the principal's organization) and denies by default.
 *
 * Design notes:
 *   - Effective-permission resolution + caching is delegated to
 *     `userHasPermission` in `@/services/rbac-service`, which already keeps a
 *     short in-memory cache keyed by `${userId}:${organizationId}` with TTL
 *     `config.security.rbac.cacheTtlMs` (default 60s). Reusing it means we do
 *     NOT add a second cache to keep coherent, and cache invalidation on role
 *     changes (`invalidateRbacCache`) already flows through.
 *   - This middleware is a Fastify preHandler and is meant to be COMPOSED
 *     ALONGSIDE the existing `requireRole(...)` / `authenticate` preHandlers —
 *     it tightens, it does not replace them.
 *   - Error envelopes match `requireRole` exactly (`{ error, message }`) so the
 *     403/401 shape is identical across the authorization layer.
 *
 * Safety / no-lockout (rollout):
 *   - Gated behind `RBAC_ENFORCE`, which DEFAULTS TO ON. Set `RBAC_ENFORCE=false`
 *     to fully bypass (the middleware becomes a no-op), restoring pre-RBAC
 *     behavior without touching any route wiring.
 *   - Even with enforcement ON, a principal that holds a configured super-role
 *     (`config.security.rbac.superRoles`, default `owner,admin`) is allowed
 *     through WITHOUT a permission-table lookup. This mirrors the existing
 *     coarse `requireRole('admin'|'owner')` check and guarantees a legitimately
 *     authenticated privileged user is never locked out while the RBAC tables
 *     are still being seeded / rolled out.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '@/config';
import { userHasPermission } from '@/services/rbac-service';
import { logger } from '@/utils/logger';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

const log = logger.child({ component: 'require-permission-middleware' });

interface ResolvedPrincipal {
  userId: string;
  organizationId: string;
  roles: string[];
}

/**
 * Enforcement is ON unless RBAC_ENFORCE is explicitly the string "false".
 * (Deny-by-default: any other value — including unset — enforces.)
 */
export function isRbacEnforced(): boolean {
  return process.env.RBAC_ENFORCE !== 'false';
}

/**
 * Extract roles from the attached principal, mirroring `requireRole`'s logic
 * (supports both the `roles: string[]` claim and a legacy `role: string`).
 */
function extractRoles(user: unknown): string[] {
  if (user && typeof user === 'object') {
    if ('roles' in user && Array.isArray((user as { roles?: unknown }).roles)) {
      return ((user as { roles: unknown[] }).roles).filter(
        (role): role is string => typeof role === 'string'
      );
    }
    if ('role' in user && typeof (user as { role?: unknown }).role === 'string') {
      return [(user as { role: string }).role];
    }
  }
  return [];
}

/**
 * Resolve the authenticated principal (userId + organizationId + roles) from a
 * request already processed by `authenticate`. Returns null when the request is
 * unauthenticated (no ids attached), so callers can emit a 401.
 */
function resolvePrincipal(request: FastifyRequest): ResolvedPrincipal | null {
  const extended = request as ExtendedFastifyRequest;
  const user = extended.user;

  const userId =
    typeof extended.userId === 'string' && extended.userId.length > 0
      ? extended.userId
      : user && typeof user === 'object' && 'userId' in user && typeof user.userId === 'string'
        ? user.userId
        : undefined;

  const organizationId =
    typeof extended.organizationId === 'string' && extended.organizationId.length > 0
      ? extended.organizationId
      : user &&
          typeof user === 'object' &&
          'organizationId' in user &&
          typeof user.organizationId === 'string'
        ? user.organizationId
        : undefined;

  if (!userId || !organizationId) {
    return null;
  }

  return { userId, organizationId, roles: extractRoles(user) };
}

function hasSuperRole(roles: string[]): boolean {
  const superRoles = config.security.rbac.superRoles;
  return roles.some((role) => superRoles.includes(role));
}

function sendUnauthenticated(reply: FastifyReply): FastifyReply | void {
  if (reply.sent) {
    return;
  }
  return reply.code(401).send({
    error: 'Unauthorized',
    message: 'Authentication required',
  });
}

function sendForbidden(reply: FastifyReply): FastifyReply | void {
  if (reply.sent) {
    return;
  }
  return reply.code(403).send({
    error: 'Forbidden',
    message: 'Insufficient permissions',
  });
}

/**
 * Core evaluation shared by `requirePermission` / `requireAnyPermission`.
 * Resolves the principal, applies the no-lockout super-role fallback, and then
 * consults the RBAC tables (any-of semantics). Returns a discriminated result
 * the preHandlers translate into HTTP responses.
 */
async function evaluate(
  request: FastifyRequest,
  permissions: string[]
): Promise<'allow' | 'unauthenticated' | 'forbidden' | 'error'> {
  const principal = resolvePrincipal(request);
  if (!principal) {
    return 'unauthenticated';
  }

  // No-lockout fallback: a configured super-role satisfies any permission and
  // never triggers a DB lookup (safe while RBAC tables are unseeded).
  if (hasSuperRole(principal.roles)) {
    return 'allow';
  }

  try {
    for (const permission of permissions) {
      if (await userHasPermission(principal.userId, principal.organizationId, permission)) {
        return 'allow';
      }
    }
  } catch (error) {
    // Fail closed: an unresolved permission check is not an authorization.
    log.error(
      {
        error,
        userId: principal.userId,
        organizationId: principal.organizationId,
        permissions,
        url: request.url,
        method: request.method,
      },
      'RBAC permission check failed unexpectedly'
    );
    return 'error';
  }

  log.warn(
    {
      userId: principal.userId,
      organizationId: principal.organizationId,
      roles: principal.roles,
      requiredPermissions: permissions,
      url: request.url,
      method: request.method,
    },
    'RBAC permission denied'
  );
  return 'forbidden';
}

/**
 * Require that the authenticated principal holds `permission`.
 *
 * Compose alongside `authenticate` (and optionally `requireRole`) in a route's
 * preHandler chain, e.g.
 *
 *   { preHandler: [authenticate, requireRole('admin', 'owner'), requirePermission('org:update')] }
 *
 * Behavior:
 *   - `RBAC_ENFORCE=false`  → no-op (bypass).
 *   - unauthenticated       → 401.
 *   - super-role principal  → allowed (no DB lookup).
 *   - has the permission    → allowed.
 *   - otherwise             → 403.
 */
export function requirePermission(permission: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isRbacEnforced()) {
      return;
    }

    const outcome = await evaluate(request, [permission]);
    switch (outcome) {
      case 'allow':
        return;
      case 'unauthenticated':
        sendUnauthenticated(reply);
        return;
      case 'error':
        if (!reply.sent) {
          reply.code(500).send({
            error: 'Internal Server Error',
            message: 'Authorization check failed',
          });
        }
        return;
      case 'forbidden':
      default:
        sendForbidden(reply);
        return;
    }
  };
}

/**
 * Require that the authenticated principal holds AT LEAST ONE of `permissions`.
 * Same semantics/rollout guards as `requirePermission`.
 */
export function requireAnyPermission(permissions: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isRbacEnforced()) {
      return;
    }

    if (permissions.length === 0) {
      // Nothing to check — treat as an authenticated-only guard.
      const principal = resolvePrincipal(request);
      if (!principal) {
        sendUnauthenticated(reply);
      }
      return;
    }

    const outcome = await evaluate(request, permissions);
    switch (outcome) {
      case 'allow':
        return;
      case 'unauthenticated':
        sendUnauthenticated(reply);
        return;
      case 'error':
        if (!reply.sent) {
          reply.code(500).send({
            error: 'Internal Server Error',
            message: 'Authorization check failed',
          });
        }
        return;
      case 'forbidden':
      default:
        sendForbidden(reply);
        return;
    }
  };
}
