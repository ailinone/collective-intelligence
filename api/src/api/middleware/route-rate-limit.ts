// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Route-Scoped Rate Limiting
 *
 * Several handlers perform an authorization check (role/tenant/ownership
 * verification, often followed by a DB read or write) but sit behind
 * routing structures where no rate limiter is visible to static analysis —
 * e.g. `/v1/internal/*` is explicitly exempted from the global token-bucket
 * hook (see `OPERATIONAL_ROUTE_PATHS` in `token-bucket-rate-limit.ts`), and
 * even where the global hook DOES apply, it is registered dynamically at
 * boot (`server.addHook` inside an `await import(...)`), which is invisible
 * to CodeQL's per-route `js/missing-rate-limiting` analysis.
 *
 * This module reuses the SAME token-bucket implementation already used by
 * `token-bucket-rate-limit.ts` (`TokenBucketManager` — Redis-backed,
 * per-replica in-memory fallback) so the algorithm and failure semantics are
 * identical to the rest of the codebase. It deliberately uses a DISTINCT
 * bucket scope (`route:<routeKey>`) rather than the global 'api-key' /
 * 'user' / 'organization' / 'ip-address' scopes: those are already consumed
 * once per request by the global hook, and re-consuming the same bucket
 * here would silently halve a legitimate caller's overall budget just for
 * hitting one of these specific routes. A separate namespace adds a real,
 * additional ceiling on the flagged handler without changing the behavior
 * of the existing global limits.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { tokenBucketManager } from '@/core/resilience/token-bucket-limiter';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { getHeaderString } from '@/utils/type-guards';

/**
 * Best available caller identity for scoping the bucket, strictest first:
 * internal-service acting-user > authenticated user > organization > API
 * key > source IP. IP is always available so pre-auth endpoints (e.g.
 * login) are still bounded.
 */
function resolveIdentifier(request: FastifyRequest): string {
  const extended = request as ExtendedFastifyRequest & {
    serviceAuth?: { actingUserId?: string };
  };

  if (typeof extended.serviceAuth?.actingUserId === 'string' && extended.serviceAuth.actingUserId) {
    return `svc-user:${extended.serviceAuth.actingUserId}`;
  }

  const userFromObject =
    typeof extended.user === 'object' && extended.user && 'userId' in extended.user
      ? (extended.user as { userId?: unknown }).userId
      : undefined;
  const userId = extended.userId || (typeof userFromObject === 'string' ? userFromObject : undefined);
  if (typeof userId === 'string' && userId.length > 0) {
    return `user:${userId}`;
  }

  if (typeof extended.organizationId === 'string' && extended.organizationId.length > 0) {
    return `org:${extended.organizationId}`;
  }

  const apiKeyHeader = getHeaderString(request.headers, 'x-api-key');
  if (apiKeyHeader) {
    return `key:${apiKeyHeader}`;
  }

  return `ip:${request.ip}`;
}

export interface RouteRateLimitOptions {
  /** Burst capacity (max tokens in the bucket). */
  capacity?: number;
  /** Sustained tokens added per second. */
  refillRate?: number;
}

const DEFAULT_CAPACITY = 60;
const DEFAULT_REFILL_RATE = 1; // 1 req/s sustained, 60-request burst

/**
 * Build a Fastify preHandler that enforces a dedicated token-bucket limit
 * for one route (or a small group of closely-related routes sharing a
 * `routeKey`). Sets the same `X-RateLimit-*` / `Retry-After` headers and
 * 429 error envelope shape as the global token-bucket middleware.
 */
export function createRouteRateLimit(routeKey: string, options?: RouteRateLimitOptions) {
  const capacity = options?.capacity ?? DEFAULT_CAPACITY;
  const refillRate = options?.refillRate ?? DEFAULT_REFILL_RATE;
  const scope = `route:${routeKey}`;

  return async function routeRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Defense-in-depth: never touch the reply once a prior preHandler
    // already sent one (mirrors the guard in token-bucket-rate-limit.ts).
    if (reply.sent) {
      return;
    }

    const identifier = resolveIdentifier(request);
    const bucket = tokenBucketManager.getBucket(scope, identifier, { capacity, refillRate });
    const { allowed, stats } = await bucket.consumeWithStats();

    reply.header('X-RateLimit-Limit', stats.capacity.toString());
    reply.header('X-RateLimit-Remaining', Math.max(0, Math.floor(stats.tokensAvailable)).toString());

    if (!allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((await bucket.getRetryAfter()) / 1000));
      reply.header('Retry-After', retryAfterSeconds.toString());

      await reply.status(429).send({
        error: {
          code: 'rate_limit_exceeded',
          message: `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`,
          type: 'rate_limit_error',
          retryAfter: retryAfterSeconds,
          scope,
        },
      });
    }
  };
}
