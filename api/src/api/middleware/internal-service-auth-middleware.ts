// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Route-level preHandler for INTERNAL service-to-service endpoints
 * (`/v1/internal/*`). These routes are exempted from the global user-auth
 * (`apiKeyAuthMiddleware`) and rate-limit hooks — see the `/v1/internal`
 * entries in `api-key-auth-middleware.ts` PUBLIC_ROUTES and
 * `token-bucket-rate-limit.ts` OPERATIONAL_ROUTE_PATHS — so security MUST be
 * enforced here, deny-by-default.
 *
 * `requireServiceAuth(scope)` verifies the id-minted service token, enforces
 * the required `:on_behalf` scope, and resolves the acting user. The acting
 * user is taken from the `X-Acting-User` header for `service` tokens, or from
 * the token `sub` for `exchanged` tokens (header is then optional). The
 * resolved context is attached at `request.serviceAuth` for the handler.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  verifyServiceToken,
  ServiceTokenError,
  type ServiceTokenContext,
} from '@/services/service-token-verifier';

export interface ServiceAuthContext {
  context: ServiceTokenContext;
  /** The end user the trusted client is acting on behalf of. */
  actingUserId: string;
  /**
   * OPTIONAL identity asserted by the trusted BFF for just-in-time provisioning
   * (X-Acting-User-Email / X-Acting-User-Tenant). Only consumed when the acting
   * user does not yet exist in ci — see resolveOrProvisionActingUser. Absent or
   * malformed values are dropped (resolver then 409s rather than provisioning).
   */
  actingUserEmail?: string;
  actingUserTenant?: string;
}

export interface ServiceAuthedRequest extends FastifyRequest {
  serviceAuth?: ServiceAuthContext;
}

// Loose UUID v1–v5 shape — id issues v4 user ids; we only need to reject
// obviously bogus values before hitting the DB.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Conservative email shape — only to reject garbage before it reaches the
// provisioning path; the authoritative trust is the service token + the BFF's
// own cryptographic JWKS verification of the user's id token at login.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return null;
  }
  if (header.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    return token.length > 0 ? token : null;
  }
  return null;
}

function getHeaderString(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return null;
}

/**
 * Builds a preHandler that requires a valid service token carrying `scope`.
 * Rejects with 401 (bad/absent token), 403 (untrusted client / token type /
 * missing scope), or 400 (missing/invalid acting user).
 */
export function requireServiceAuth(scope: string) {
  return async function serviceAuthPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = extractBearer(request);
    if (!token) {
      await reply
        .code(401)
        .send({ error: 'unauthorized', message: 'missing internal service token' });
      return;
    }

    let context: ServiceTokenContext;
    try {
      context = await verifyServiceToken(token);
    } catch (error) {
      const reason = error instanceof ServiceTokenError ? error.reason : 'invalid_token';
      request.log.warn({ reason }, 'internal service token rejected');
      // Trust-level failures (untrusted client / wrong token type) → 403;
      // everything else (bad signature, absent JWKS, malformed) → 401.
      const status = reason === 'client_not_allowed' || reason === 'wrong_token_type' ? 403 : 401;
      await reply
        .code(status)
        .send({ error: status === 403 ? 'forbidden' : 'unauthorized', message: 'invalid internal service token', reason });
      return;
    }

    if (!context.scopes.includes(scope)) {
      request.log.warn(
        { clientId: context.clientId, required: scope, granted: context.scopes },
        'internal service token missing required scope',
      );
      await reply
        .code(403)
        .send({ error: 'forbidden', message: `missing required scope: ${scope}` });
      return;
    }

    // Acting user: token `sub` for exchanged tokens (cryptographically bound),
    // else the X-Acting-User header (safe to trust because the token already
    // proved this is our own M2M client holding an :on_behalf scope).
    const headerUser = getHeaderString(request, 'x-acting-user');
    const actingUserId = context.tokenType === 'exchanged' ? context.subject ?? headerUser : headerUser;

    if (!actingUserId || !UUID_RE.test(actingUserId)) {
      await reply
        .code(400)
        .send({ error: 'bad_request', message: 'missing or invalid X-Acting-User' });
      return;
    }

    // Optional provisioning hints — kept only when well-formed. Never required:
    // an existing acting user resolves by id alone; these enable just-in-time
    // creation for first-touch on-behalf users (resolveOrProvisionActingUser).
    const rawEmail = (getHeaderString(request, 'x-acting-user-email') ?? '').trim().toLowerCase();
    const rawTenant = (getHeaderString(request, 'x-acting-user-tenant') ?? '').trim();
    const actingUserEmail = rawEmail && EMAIL_RE.test(rawEmail) ? rawEmail : undefined;
    const actingUserTenant = rawTenant && UUID_RE.test(rawTenant) ? rawTenant : undefined;

    (request as ServiceAuthedRequest).serviceAuth = {
      context,
      actingUserId,
      actingUserEmail,
      actingUserTenant,
    };
  };
}
