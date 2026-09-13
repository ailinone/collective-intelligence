// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Authentication Middleware
 * JWT and API Key validation for Fastify
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { getAuthService, type JWTPayload } from '@/services/auth-service';
import { logger } from '@/utils/logger';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { getHeaderString } from '@/utils/type-guards';
import { resolveOrganizationId } from '@/utils/context-headers';
import { looksLikeApiKey } from '@/utils/api-key-format';
import { config } from '@/config';
import { recordSecurityEvent } from '@/services/security-audit-service';
import { verifyServiceToken, ServiceTokenError } from '@/services/service-token-verifier';

const log = logger.child({ component: 'auth-middleware' });

// See ailin-chat-server in the id repo and chat's _is_ci_connection/
// X-Ailin-Actor-Token wiring in the chat repo.
const CHAT_FORWARD_IDENTITY_SCOPE = 'chat:forward-identity';
const ACTOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Attaches a forwarded end-user identity for USAGE/QUOTA ATTRIBUTION ONLY --
 * never for authorization. Called after the request's own auth (its API key)
 * has already resolved organizationId/roles/userId; those are NEVER
 * overwritten here except userId, which this may replace with the real
 * per-user id a chat-completions request is actually for (today it collapses
 * onto the API key's own shared service-account id, e.g. for the free-tier
 * or anonymous-guest keys, which breaks free-tier-quota-gate.ts's per-user
 * bucketing -- see that file's own "always carries a real user id" comment).
 *
 * Best-effort and silent on any failure: a missing/invalid/expired token or
 * header here just leaves userId as whatever the primary auth already set.
 * This is an attribution *enhancement*, never a reason to fail a chat
 * completion the caller's real API key already authenticated correctly.
 */
async function attachForwardedActorIdentity(
  request: FastifyRequest,
  extendedRequest: ExtendedFastifyRequest
): Promise<void> {
  const actorToken = getHeaderString(request.headers, 'x-ailin-actor-token');
  if (!actorToken) {
    return;
  }

  let context;
  try {
    context = await verifyServiceToken(actorToken);
  } catch (error) {
    const reason = error instanceof ServiceTokenError ? error.reason : 'invalid_token';
    log.debug({ reason }, 'forwarded actor token rejected; keeping the primary auth identity');
    return;
  }

  if (context.tokenType !== 'service' || !context.scopes.includes(CHAT_FORWARD_IDENTITY_SCOPE)) {
    log.warn(
      { clientId: context.clientId, tokenType: context.tokenType, scopes: context.scopes },
      'forwarded actor token lacks the chat:forward-identity scope; ignoring'
    );
    return;
  }

  const actingUserId = getHeaderString(request.headers, 'x-acting-user');
  if (!actingUserId || !ACTOR_UUID_RE.test(actingUserId)) {
    return;
  }

  extendedRequest.userId = actingUserId;
  if (extendedRequest.user && typeof extendedRequest.user === 'object') {
    (extendedRequest.user as { userId?: string }).userId = actingUserId;
  }
}

function getExistingAuthIds(
  request: ExtendedFastifyRequest
): { userId: string; organizationId: string } | null {
  if (
    typeof request.userId === 'string' &&
    request.userId.length > 0 &&
    typeof request.organizationId === 'string' &&
    request.organizationId.length > 0
  ) {
    return { userId: request.userId, organizationId: request.organizationId };
  }

  const user = request.user;
  if (
    typeof user === 'object' &&
    user !== null &&
    !Buffer.isBuffer(user) &&
    'userId' in user &&
    'organizationId' in user
  ) {
    const userId = (user as { userId?: unknown }).userId;
    const organizationId = (user as { organizationId?: unknown }).organizationId;
    if (
      typeof userId === 'string' &&
      typeof organizationId === 'string' &&
      userId &&
      organizationId
    ) {
      return { userId, organizationId };
    }
  }

  return null;
}

/**
 * Authenticate request (JWT or API Key)
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const extendedRequest = request as ExtendedFastifyRequest;
    const existing = getExistingAuthIds(extendedRequest);
    if (existing) {
      // Ensure IDs are present on the request object (some middleware only populates `user` / `tenantContext`).
      extendedRequest.userId = existing.userId;
      extendedRequest.organizationId = existing.organizationId;
      return;
    }

    const authHeader = getHeaderString(request.headers, 'authorization');
    const apiKeyHeader = getHeaderString(request.headers, 'x-api-key');
    const organizationHeader = resolveOrganizationId(request.headers, request.query);

    // SECURITY: credentials are NOT accepted via query string — URLs leak into
    // proxy/gateway logs and browser history. WebSocket clients that cannot set
    // headers bootstrap an ephemeral single-use token via POST /v1/realtime/session
    // (validated upstream in apiKeyAuthMiddleware, scoped to /v1/realtime only;
    // it attaches userId/organizationId so getExistingAuthIds() short-circuits here).

    if (!authHeader && !apiKeyHeader) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing authentication credentials',
      });
    }

    const authService = getAuthService();

    // Bearer token (JWT)
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      // WHY: AuthService is the single source for local and federated token
      // validation, including issuer/audience checks and principal sync rules.
      const payload = await authService.verifyToken(token);

      if (!payload) {
        return reply.code(401).send({
          error: 'Invalid token',
          message: 'Invalid or expired token',
        });
      }

      // Attach user info to request
      const extendedRequest = request as ExtendedFastifyRequest;
      extendedRequest.user = {
        userId: payload.userId,
        organizationId: payload.organizationId,
        roles: payload.roles,
        email: payload.email,
        name: payload.email, // Use email as name fallback
      };
      extendedRequest.organizationId = payload.organizationId;
      extendedRequest.userId = payload.userId;
      return;
    }

    const apiKey = (() => {
      if (authHeader && looksLikeApiKey(authHeader)) {
        return authHeader;
      }
      if (apiKeyHeader && looksLikeApiKey(apiKeyHeader)) {
        return apiKeyHeader;
      }
      return undefined;
    })();

    if (apiKey) {
      let payload: JWTPayload | null = null;
      try {
        payload = await authService.verifyApiKey(apiKey);
      } catch (error: unknown) {
        // Log error but don't expose details to client
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.warn({ error: errorMessage }, 'API key verification error');
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Invalid API key',
        });
      }

      if (!payload) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Invalid API key',
        });
      }

      // Attach user info to request
      const extendedRequest = request as ExtendedFastifyRequest;
      // SECURITY (org-header-spoofing, 2026-09-09): `organizationHeader` is
      // 100% client-controlled (the `X-Organization-Id` header or an
      // `organizationId`/`organization_id` query param — see
      // resolveOrganizationId()/context-headers.ts) and was previously used
      // to OVERRIDE the authenticated organization for API-key requests,
      // with no check that it matched the key's real org. `payload.roles`
      // always reflected the key's REAL organization's grants, but the
      // organizationId attached to the request could be forged to any
      // value — completely defeating isPlatformAdminRequest()/
      // requirePlatformAdmin() (any tenant key could claim to be the
      // reserved platform org) and the "same organization" ownership checks
      // in api-key-rotation-routes.ts (trivially satisfied by forging the
      // header to match the target's org). An API key is scoped to exactly
      // ONE organization (ApiKey.organizationId in prisma/schema.prisma —
      // there is no multi-org grant per key), so for API-key auth the
      // request's organizationId is ALWAYS the key's real organization; the
      // header/query param is never consulted for authorization. (The JWT
      // bearer path above never read this header at all.)
      if (organizationHeader && organizationHeader !== payload.organizationId) {
        log.warn(
          {
            apiKeyId: payload.apiKeyId,
            userId: payload.userId,
            realOrganizationId: payload.organizationId,
            spoofedOrganizationId: organizationHeader,
            url: request.url,
          },
          'API key request supplied X-Organization-Id/organizationId that does not match the key\'s real organization; ignoring it (org-header-spoofing guard)'
        );
      }
      const organizationId = payload.organizationId;
      extendedRequest.user = {
        userId: payload.userId,
        organizationId,
        roles: payload.roles,
        email: payload.email,
        name: payload.email, // Use email as name fallback
      };
      extendedRequest.organizationId = organizationId;
      extendedRequest.userId = payload.userId;

      // Attach API key info if present
      if (payload.apiKeyId) {
        extendedRequest.apiKey = {
          id: payload.apiKeyId,
          name: 'API Key',
          permissions: payload.apiKeyPermissions || null,
        };
      }

      await attachForwardedActorIdentity(request, extendedRequest);
      return;
    }

    // Invalid format
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Invalid authorization format. Use "Bearer <token>" or API key',
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ error: errorMessage }, 'Authentication error');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Authentication failed',
    });
  }
}

/**
 * Optional authentication (doesn't fail if no auth)
 */
export async function optionalAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    return; // Continue without auth
  }

  try {
    await authenticate(request, reply);
  } catch (error: unknown) {
    // Log but don't fail
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.debug({ error: errorMessage }, 'Optional auth failed');
  }
}

/**
 * Require specific role
 */
export function requireRole(...roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const extendedRequest = request as ExtendedFastifyRequest;
    const user = extendedRequest.user;

    if (!user) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    // Type guard for user object.
    //
    // SECURITY (rbac-silent-role-downgrade): ONLY the `roles: string[]` array
    // counts. The former fallback to a scalar `role: string` accepted exactly
    // the shape of the denormalized `users.role` hint column, which is not a
    // grant — the same laundering that made `apiKeyAuthMiddleware` resolve a
    // role-less principal to `admin`. Every producer attaches an array; absent
    // or non-array now means no roles, and the check below denies.
    const userRoles: string[] =
      user && typeof user === 'object' && 'roles' in user && Array.isArray(user.roles)
        ? user.roles
        : [];

    // Extract userId for logging (type-safe)
    const getUserId = (userObj: typeof user): string => {
      if (typeof userObj === 'object' && userObj !== null) {
        if ('userId' in userObj && typeof userObj.userId === 'string') {
          return userObj.userId;
        }
        if ('id' in userObj && typeof userObj.id === 'string') {
          return userObj.id;
        }
      }
      return 'unknown';
    };

    // Log for debugging (only in test environment)
    if (process.env.NODE_ENV === 'test') {
      const userId = getUserId(user);
      log.debug(
        {
          userId,
          userRoles,
          requiredRoles: roles,
          url: request.url,
          method: request.method,
        },
        'Role check'
      );
    }

    const hasRole = userRoles.some((role) => roles.includes(role));

    if (!hasRole) {
      const userId = getUserId(user);
      log.warn(
        {
          userId,
          userRoles,
          requiredRoles: roles,
          url: request.url,
          method: request.method,
        },
        'Role check failed - insufficient permissions'
      );

      // Do NOT use reply.hijack() here. Hijacking marks the reply as already sent and will
      // cause Fastify to throw `FST_ERR_REP_ALREADY_SENT` when calling `send()`, leading to
      // hung requests/timeouts in tests.
      if (reply.sent) {
        return;
      }

      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Insufficient permissions',
      });
    }
  };
}

/**
 * Require true platform-operator authority — NOT a tenant's own admin/owner.
 *
 * SECURITY (platform-admin-vs-tenant-admin, 2026-09-08): `requireRole('admin',
 * 'owner')` checks a PER-ORGANIZATION UserRole grant. Any tenant's own org
 * `owner` can self-service-promote another user in the SAME org to `admin`
 * via `PUT /v1/users/:id` — there is no platform-superadmin concept in that
 * check. Routes that operate on GLOBAL/cross-tenant resources (the model
 * catalog/discovery, benchmark & experiment infrastructure, DLQ replay,
 * cross-org API-key rotation, the shared shell/git tool-execution surface)
 * were gated with `requireRole('admin','owner')` alone, which any tenant's
 * self-promoted admin also satisfies — an unintended privilege-tier
 * confusion, not a deliberate grant. Audit: see the platform-admin-rbac-audit
 * findings (2026-09-08).
 *
 * Reuses the EXISTING per-org RBAC primitives with zero schema change: one
 * reserved Organization row (`config.security.platformOrganizationId`,
 * provisioned out-of-band by an operator, e.g. via `pnpm run rbac:grant-owner`
 * against that org) is designated the platform org. A caller is a platform
 * admin only if their token's `organizationId` IS that reserved org AND their
 * `roles` include `admin` or `owner` *for that org* — i.e., admin/owner of
 * the platform org, not of their own tenant.
 *
 * Fails CLOSED: if `platformOrganizationId` is unset (not yet provisioned),
 * every route behind this check denies everyone and logs at error level,
 * rather than silently falling back to "any tenant admin" — so shipping this
 * fix immediately closes the hole even before an operator finishes
 * provisioning the real platform org.
 */
function getUserIdFromRequestUser(user: ExtendedFastifyRequest['user']): string {
  if (typeof user === 'object' && user !== null) {
    if ('userId' in user && typeof user.userId === 'string') return user.userId;
    if ('id' in user && typeof user.id === 'string') return user.id;
  }
  return 'unknown';
}

/**
 * Pure check: is this authenticated request a genuine platform admin — i.e.
 * admin/owner of the reserved `config.security.platformOrganizationId` org,
 * not merely admin/owner of the caller's own tenant? Returns `false` (never
 * throws) when unauthenticated or when `platformOrganizationId` is unset.
 *
 * Exported separately from {@link requirePlatformAdmin} so a route that
 * legitimately serves BOTH "a tenant managing its own resource" and "a
 * platform operator managing any tenant's resource" can branch on this
 * instead of being fully gated — see e.g. api-key-rotation-routes.ts, where
 * a tenant may rotate its OWN key but only a platform admin may target
 * another organization's.
 */
export function isPlatformAdminRequest(request: FastifyRequest): boolean {
  const extendedRequest = request as ExtendedFastifyRequest;
  const user = extendedRequest.user;
  if (!user) return false;

  const platformOrgId = config.security.platformOrganizationId;
  if (!platformOrgId) return false;

  const callerOrgId =
    typeof user === 'object' && user !== null && 'organizationId' in user
      ? String((user as { organizationId?: unknown }).organizationId ?? '')
      : '';
  // SECURITY (rbac-silent-role-downgrade): same rule as requireRole() — only
  // the `roles: string[]` array counts, never a scalar `role` hint.
  const userRoles: string[] =
    user && typeof user === 'object' && 'roles' in user && Array.isArray(user.roles)
      ? user.roles
      : [];

  return callerOrgId === platformOrgId && userRoles.some((role) => role === 'admin' || role === 'owner');
}

export function requirePlatformAdmin() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const extendedRequest = request as ExtendedFastifyRequest;
    const user = extendedRequest.user;

    if (!user) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    const userId = getUserIdFromRequestUser(user);
    const callerOrgId =
      typeof user === 'object' && user !== null && 'organizationId' in user
        ? String((user as { organizationId?: unknown }).organizationId ?? '')
        : '';

    const platformOrgId = config.security.platformOrganizationId;

    if (!platformOrgId) {
      log.error(
        { userId, url: request.url, method: request.method },
        'requirePlatformAdmin: PLATFORM_ORGANIZATION_ID is not configured — denying by default (fail closed)'
      );
      if (reply.sent) return;
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Platform administration is not configured',
      });
    }

    const userRoles: string[] =
      user && typeof user === 'object' && 'roles' in user && Array.isArray(user.roles)
        ? user.roles
        : [];
    const authorized = isPlatformAdminRequest(request);

    if (!authorized) {
      log.warn(
        {
          userId,
          callerOrgId,
          userRoles,
          url: request.url,
          method: request.method,
        },
        'requirePlatformAdmin: denied — caller is not admin/owner of the platform organization'
      );
      await recordSecurityEvent({
        eventType: 'platform_admin_check_failed',
        severity: 'warning',
        message: 'Platform-admin route denied to a non-platform-admin caller',
        userId,
        organizationId: callerOrgId || undefined,
        metadata: { requiredOrganizationId: platformOrgId, userRoles, url: request.url },
      });
      if (reply.sent) return;
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Platform administrator privileges required',
      });
    }
  };
}

/**
 * Require organization membership
 */
export function requireOrganization(request: FastifyRequest, reply: FastifyReply): void {
  const extendedRequest = request as ExtendedFastifyRequest;
  const user = extendedRequest.user;

  // Type guard for user object
  const organizationId =
    user &&
    typeof user === 'object' &&
    'organizationId' in user &&
    typeof user.organizationId === 'string'
      ? user.organizationId
      : undefined;

  if (!user || !organizationId) {
    reply.code(403).send({
      error: 'Forbidden',
      message: 'Organization membership required',
    });
    return;
  }
}
