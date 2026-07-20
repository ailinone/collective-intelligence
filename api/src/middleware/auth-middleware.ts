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

const log = logger.child({ component: 'auth-middleware' });

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
    if (typeof userId === 'string' && typeof organizationId === 'string' && userId && organizationId) {
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
      if (authHeader && authHeader.startsWith('ak_')) {
        return authHeader;
      }
      if (apiKeyHeader && apiKeyHeader.startsWith('ak_')) {
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
      const organizationId = organizationHeader || payload.organizationId;
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

    // Type guard for user object
    const userRoles: string[] = 
      user && typeof user === 'object' && 'roles' in user && Array.isArray(user.roles)
        ? user.roles
        : user && typeof user === 'object' && 'role' in user && typeof user.role === 'string'
          ? [user.role]
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
      log.debug({
        userId,
        userRoles,
        requiredRoles: roles,
        url: request.url,
        method: request.method,
      }, 'Role check');
    }

    const hasRole = userRoles.some((role) => roles.includes(role));

    if (!hasRole) {
      const userId = getUserId(user);
      log.warn({
        userId,
        userRoles,
        requiredRoles: roles,
        url: request.url,
        method: request.method,
      }, 'Role check failed - insufficient permissions');

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
 * Require organization membership
 */
export function requireOrganization(request: FastifyRequest, reply: FastifyReply): void {
  const extendedRequest = request as ExtendedFastifyRequest;
  const user = extendedRequest.user;

  // Type guard for user object
  const organizationId = 
    user && typeof user === 'object' && 'organizationId' in user && typeof user.organizationId === 'string'
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
