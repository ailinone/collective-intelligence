// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Token Bucket Rate Limiting Middleware
 *
 * Replaces simple rate limiting with advanced token bucket algorithm.
 * Provides better burst handling and fairer resource distribution.
 *
 * v5.0 - INTEGRATED: Replaces @fastify/rate-limit with custom implementation
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { tokenBucketManager, safeLogIdentifier } from '@/core/resilience/token-bucket-limiter';
import { logger } from '@/utils/logger';
import { getTierConfig } from '@/config/multi-tenancy-config';
import type { TenantContext } from '@/api/middleware/tenant-isolation-middleware';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { getHeaderString } from '@/utils/type-guards';
import { resolveOrganizationId } from '@/utils/context-headers';

/**
 * Operational endpoints that MUST NOT be subject to product-level rate limits.
 *
 * Why these and only these
 * ------------------------
 * The product's rate limit exists to protect *paying customers* from each
 * other and the platform from abuse. Health/status/metrics endpoints describe
 * the *infrastructure*; consuming a token from the customer's bucket every
 * time Kubernetes probes liveness or Prometheus scrapes metrics would:
 *   1. Drain the customer's quota with traffic they never made.
 *   2. Hide a real outage behind a 429 — the operator hits health, sees
 *      "rate limit exceeded", and concludes "the API is up but throttling me",
 *      when in fact the *infrastructure* is failing.
 *   3. Make the operator's troubleshooting tools depend on the same systems
 *      they're trying to debug.
 *
 * This list is the exact mirror of the operational subset of `PUBLIC_ROUTES`
 * in `api-key-auth-middleware.ts`. Auth bypass + rate-limit bypass MUST stay
 * synchronized — adding an operational endpoint to one without the other
 * leaves the gap this comment is here to prevent.
 *
 * Matching is path-prefix-aware so wildcard subpaths (`/v1/status/health`,
 * `/v1/hcra/health`) resolve correctly regardless of trailing slashes or
 * query strings — `request.url` carries those, but we strip them at the call
 * site before the comparison.
 */
export const OPERATIONAL_ROUTE_PATHS: readonly string[] = [
  '/health',
  '/health/ready',
  '/health/live',
  '/health/startup',
  '/metrics',
  '/.well-known/jwks.json',
  '/console/api/v1/jwks',
  '/v1/status',
  '/v1/status/health',
  '/v1/status/ready',
  '/v1/hcra/health',
  // Internal M2M endpoints — service-token authenticated at the route level,
  // not subject to per-user product rate limits (no end-user caller identity
  // on the hook path). KEEP IN SYNC with PUBLIC_ROUTES in
  // api-key-auth-middleware.ts.
  '/v1/internal',
] as const;

/**
 * Path-only check (query string already stripped). Exact match OR prefix-with-/
 * — never a bare prefix, so `/healthcheck` is NOT treated as `/health`.
 */
function isOperationalRoute(path: string): boolean {
  for (const route of OPERATIONAL_ROUTE_PATHS) {
    if (path === route || path.startsWith(`${route}/`)) {
      return true;
    }
  }
  return false;
}

function resolveScopeConfig(scope: string, tenantContext: TenantContext | undefined) {
  const base = tokenBucketManager.getDefaultConfig(scope);
  const tierConfig = tenantContext?.tier ? getTierConfig(tenantContext.tier) : null;
  if (!tierConfig) {
    return base;
  }

  switch (scope) {
    case 'organization': {
      const capacity = Math.max(tierConfig.requestsPerMinute, 10);
      const refillRate = Math.max(capacity / 60, 1);
      return { capacity, refillRate };
    }
    case 'api-key': {
      const capacity = Math.max(Math.round(tierConfig.requestsPerMinute * 0.8), 10);
      const refillRate = Math.max(capacity / 60, 1);
      return { capacity, refillRate };
    }
    case 'user': {
      const capacity = Math.max(Math.round(tierConfig.requestsPerMinute / 4), 5);
      const refillRate = Math.max(capacity / 60, 1);
      return { capacity, refillRate };
    }
    case 'ip-address':
    default: {
      return base;
    }
  }
}

export interface RateLimitConfig {
  /**
   * Enable per-API-key rate limiting
   */
  perApiKey: boolean;

  /**
   * Enable per-IP rate limiting
   */
  perIP: boolean;

  /**
   * Enable per-user rate limiting
   */
  perUser: boolean;

  /**
   * Enable per-organization rate limiting
   */
  perOrganization: boolean;

  /**
   * Whitelist of IPs that bypass rate limiting
   */
  whitelist?: string[];
}

/**
 * Get identifier from request for rate limiting
 */
function getIdentifiers(request: FastifyRequest): {
  apiKey?: string;
  ip?: string;
  userId?: string;
  organizationId?: string;
} {
  const extendedRequest = request as ExtendedFastifyRequest;
  const tenantContext = extendedRequest.tenantContext;
  return {
    apiKey: getHeaderString(request.headers, 'x-api-key'),
    ip: request.ip,
    userId: tenantContext?.userId || extendedRequest.userId || getHeaderString(request.headers, 'x-user-id'),
    organizationId:
      tenantContext?.organizationId ||
      extendedRequest.organizationId ||
      resolveOrganizationId(request.headers, request.query),
  };
}

/**
 * Check if IP is whitelisted
 */
function isWhitelisted(ip: string, whitelist?: string[]): boolean {
  if (!whitelist || whitelist.length === 0) return false;

  return whitelist.includes(ip) || (whitelist.includes('127.0.0.1') && ip.startsWith('127.'));
}

/**
 * Token Bucket Rate Limiting Middleware
 *
 * Multi-tier rate limiting:
 * 1. Per-API-Key (strictest)
 * 2. Per-User
 * 3. Per-Organization
 * 4. Per-IP (fallback)
 */
export async function tokenBucketRateLimitMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
  config: RateLimitConfig = {
    perApiKey: true,
    perIP: true,
    perUser: false,
    perOrganization: false,
  }
): Promise<void> {
  // Defense-in-depth: if a previous preHandler hook already responded
  // (e.g., auth middleware sent a 401), do not touch the reply at all.
  // Calling `reply.header(...)` or `reply.send(...)` after `reply.sent === true`
  // is exactly what triggers FST_ERR_REP_ALREADY_SENT in Fastify. We intentionally
  // do NOT log here — the upstream middleware already logged its outcome, and a
  // second log line at warn/info would just noise up the trace.
  if (reply.sent) {
    return;
  }

  // Operational/observability endpoints (health, metrics, status) MUST bypass
  // product rate limits — see the `OPERATIONAL_ROUTE_PATHS` JSDoc above. We
  // strip the query string before matching because `request.url` carries it
  // (e.g. `/v1/hcra/health?probe=1`).
  const path = request.url.split('?')[0];
  if (isOperationalRoute(path)) {
    return;
  }

  const identifiers = getIdentifiers(request);
  const requestLog = logger.child({
    endpoint: request.url,
    // `identifiers.apiKey` is the raw `x-api-key` header value — bind a
    // safe fingerprint instead so it isn't baked into every log line
    // emitted through this child logger for the rest of the request.
    identifiers: {
      ...identifiers,
      apiKey: identifiers.apiKey ? safeLogIdentifier('api-key', identifiers.apiKey) : identifiers.apiKey,
    },
  });

  // Check whitelist
  if (identifiers.ip && isWhitelisted(identifiers.ip, config.whitelist)) {
    requestLog.debug('IP whitelisted, bypassing rate limit');
    return;
  }

  // The IP tier exists to cap **unauthenticated** traffic (anti-DoS for the
  // unauth surface). Once a request carries an authenticated identifier
  // (api-key OR user), the IP tier becomes counter-productive: every
  // authenticated client behind the same IP shares one 100-burst/1-RPS bucket
  // (see `defaultConfigs.ipAddress` in token-bucket-limiter.ts), even though
  // the per-key/per-user/per-org tiers already isolate them. Validated with
  // smoke v3 — 240 requests at 1.2s pacing produced 0× 429 vs v2's 114× 429
  // when the same workload was firing into the IP bucket. See
  // scripts/FINAL-REPORT.md §2 for the diagnosis.
  const hasAuthenticatedIdentifier = Boolean(identifiers.apiKey || identifiers.userId);

  // Try each rate limit tier in order (strictest first)
  const checks: Array<{ scope: string; identifier?: string; enabled: boolean }> = [
    { scope: 'api-key', identifier: identifiers.apiKey, enabled: config.perApiKey },
    { scope: 'user', identifier: identifiers.userId, enabled: config.perUser },
    {
      scope: 'organization',
      identifier: identifiers.organizationId,
      enabled: config.perOrganization,
    },
    {
      scope: 'ip-address',
      identifier: identifiers.ip,
      enabled: config.perIP && !hasAuthenticatedIdentifier,
    },
  ];

  // ── ALL enabled tiers, concurrently ─────────────────────────────────────────
  // The previous loop RETURNED after the first enabled tier that matched — so
  // with an api-key identifier present, the user and organization tiers were
  // never consulted at all (an org-wide or per-user cap was unenforceable for
  // API-key traffic). Every enabled tier now consumes atomically, in PARALLEL:
  // enforcement becomes correct (a request counts against key AND user AND org
  // budgets) at the wall-clock cost of max(tier RTTs), not their sum.
  //
  // Per-tier error handling stays fail-open (a tier whose Redis call throws is
  // treated as passed), matching the old "continue to next tier on error".
  const activeChecks = checks.filter(
    (check): check is { scope: string; identifier: string; enabled: boolean } =>
      check.enabled && typeof check.identifier === 'string' && check.identifier.length > 0
  );

  if (activeChecks.length === 0) {
    requestLog.debug('No rate limiting applied (no identifiers or all disabled)');
    return;
  }

  const extendedRequest = request as ExtendedFastifyRequest;
  const results = await Promise.all(
    activeChecks.map(async (check) => {
      try {
        const bucket = tokenBucketManager.getBucket(
          check.scope,
          check.identifier,
          resolveScopeConfig(check.scope, extendedRequest.tenantContext)
        );
        // Single Redis round-trip for both the allow/deny decision AND the stats
        // needed for X-RateLimit-* headers (was consume() + getStats() = 2 round-trips).
        const { allowed, stats } = await bucket.consumeWithStats();
        return { check, allowed, stats: stats as typeof stats | null };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        requestLog.error(
          {
            error: errorMessage,
            scope: check.scope,
            identifier: safeLogIdentifier(check.scope, check.identifier),
          },
          'Rate limit check failed'
        );
        return { check, allowed: true, stats: null }; // fail-open for this tier
      }
    })
  );

  // `checks` is ordered strictest-first, so the first rejection is the one to report.
  const rejected = results.find((result) => !result.allowed);
  if (rejected) {
    const retryAfter = await tokenBucketManager.getRetryAfter(
      rejected.check.scope,
      rejected.check.identifier
    );
    const retryAfterSeconds = Math.ceil(retryAfter / 1000);

    requestLog.warn(
      {
        scope: rejected.check.scope,
        identifier: safeLogIdentifier(rejected.check.scope, rejected.check.identifier),
        retryAfter: retryAfterSeconds,
      },
      'Rate limit exceeded (token bucket)'
    );

    // Set rate limit headers
    reply.header('X-RateLimit-Limit', rejected.stats ? rejected.stats.capacity.toString() : '100');
    reply.header('X-RateLimit-Remaining', '0');
    reply.header('X-RateLimit-Reset', Math.floor(Date.now() / 1000) + retryAfterSeconds);
    reply.header('Retry-After', retryAfterSeconds.toString());

    return reply.status(429).send({
      error: {
        code: 'rate_limit_exceeded',
        message: `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`,
        type: 'rate_limit_error',
        retryAfter: retryAfterSeconds,
        scope: rejected.check.scope,
      },
    });
  }

  // All tiers passed — headers reflect the most specific scope (first in order).
  const primary = results.find((result) => result.stats !== null);
  if (primary && primary.stats) {
    reply.header('X-RateLimit-Limit', primary.stats.capacity.toString());
    reply.header('X-RateLimit-Remaining', Math.floor(primary.stats.tokensAvailable).toString());
    reply.header('X-RateLimit-Scope', primary.check.scope);

    requestLog.debug(
      {
        scope: primary.check.scope,
        remaining: Math.floor(primary.stats.tokensAvailable),
        capacity: primary.stats.capacity,
      },
      'Rate limit check passed'
    );
  } else {
    requestLog.debug('No rate limiting applied (all tiers failed open)');
  }
}

/**
 * Create middleware for Fastify
 */
export function createTokenBucketMiddleware(config?: Partial<RateLimitConfig>) {
  const fullConfig: RateLimitConfig = {
    perApiKey: true,
    perIP: true,
    perUser: false,
    perOrganization: false,
    whitelist: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
    ...config,
  };

  return async (request: FastifyRequest, reply: FastifyReply) => {
    await tokenBucketRateLimitMiddleware(request, reply, fullConfig);
  };
}

/**
 * Get rate limit statistics endpoint handler
 */
export interface RateLimitStatsResponse {
  object: 'list';
  data: Array<{
    scope: string;
    identifier: string;
    tokensAvailable: number;
    capacity: number;
    refillRate: number;
    totalRequests: number;
    totalRejected: number;
    rejectionRate: number;
  }>;
  count: number;
}

export async function getRateLimitStats(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<RateLimitStatsResponse> {
  try {
    const stats = await tokenBucketManager.getAllStats();

    return reply.send({
      object: 'list',
      data: stats.map((s) => ({
        scope: s.scope,
        identifier: s.identifier,
        tokensAvailable: Math.floor(s.tokensAvailable),
        capacity: s.capacity,
        refillRate: s.refillRate,
        totalRequests: s.totalRequests,
        totalRejected: s.totalRejected,
        rejectionRate: Math.round(s.rejectionRate * 100) / 100,
      })),
      count: stats.length,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, 'Failed to get rate limit stats');
    return reply.status(500).send({
      error: {
        message: errorMessage,
      },
    });
  }
}
