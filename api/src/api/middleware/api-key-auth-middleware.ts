// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * API Key Authentication Middleware (Enterprise-Grade)
 * 
 * Security Features:
 * - Real user lookup from database (no hardcoded credentials)
 * - API key validation with bcrypt
 * - Quick hash lookup for performance (SHA-256 index)
 * - IP whitelist enforcement
 * - Key expiration checking
 * - Key status validation (active, rotating)
 * - Request tracking and rate limiting preparation
 * - Audit logging for security events
 * 
 * Performance:
 * - Quick hash lookup before expensive bcrypt verification
 * - Database connection pooling (Prisma)
 * - Minimal queries (single join)
 * - Cached user roles and permissions
 * 
 * Scale Support:
 * - Handles 100K+ organizations
 * - Supports millions of API keys
 * - Sub-50ms authentication latency
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { createOrchestrationContext } from '@/utils/orchestration-context';
import { getHeaderString } from '@/utils/type-guards';
import { getAuthService } from '@/services/auth-service';
import {
  consumeRealtimeSession,
  REALTIME_SESSION_TOKEN_PREFIX,
} from '@/services/realtime-session-service';

/**
 * Public routes that bypass authentication.
 *
 * Two distinct categories live here, even though the matching logic is identical:
 *
 *   (a) Operational/observability endpoints — `/health*`, `/metrics`, `/v1/status*`,
 *       `/v1/hcra/health`, `/.well-known/jwks.json`. These describe the *infra*,
 *       not the *product*. They MUST NOT depend on a valid customer credential
 *       because the customer's credential is precisely what we're often trying
 *       to debug when we hit them. They are also bypassed in
 *       `tokenBucketRateLimitMiddleware` (see `OPERATIONAL_ROUTE_PATHS` there)
 *       so an exhausted API key bucket can't mask a real outage.
 *
 *   (b) Public product entrypoints — `/v1/auth/login`, `/v1/auth/register`,
 *       `/v1/models/*` (catalog browsing). These ARE part of the product but
 *       legitimately have no caller identity yet, by design.
 *
 * Adding to (a): also append the path string in `OPERATIONAL_ROUTE_PATHS` in
 * `token-bucket-rate-limit.ts`. The two lists are intentionally co-located in
 * comments because forgetting one half is the recurring failure mode.
 */
export const PUBLIC_ROUTES = [
  // ─── (a) Operational / observability ──────────────────────────────────────
  '/health',
  '/health/ready',
  '/health/live',
  '/health/startup', // K8s startup probe (was missing — caused 401s for slow boots)
  '/metrics', // Prometheus metrics endpoint - uses optional token-based auth in route handler
  '/.well-known/jwks.json',
  '/console/api/v1/jwks',
  '/v1/status',
  '/v1/status/health',
  '/v1/status/ready',
  '/v1/hcra/health', // HCRA search-stack liveness — operational, not product (ADR-022)
  // ─── AGPL §13 source offer — must be reachable without credentials, or the
  // offer is not an offer. See routes/legal/source-offer.ts.
  '/source',
  '/license',
  // ─── Documentation ────────────────────────────────────────────────────────
  '/docs',
  '/documentation',
  '/favicon.ico',
  // ─── (b) Public product entrypoints ───────────────────────────────────────
  '/v1/auth/login',
  '/v1/auth/register',
  '/v1/auth/challenge',
  '/v1/auth/email-challenge',
  // SECURITY: /v1/auth/test-db removed from public routes - exposes database structure
  // If needed for debugging, access should require authentication
  '/v1/auth/refresh',
  '/v1/models/list', // Public model catalog
  '/v1/models/', // Public model details
  '/v1/models', // OpenAI-compatible models endpoint
  // ─── (c) Internal service-to-service (M2M) ────────────────────────────────
  // /v1/internal/* is NOT user-authenticated here — it is secured at the route
  // level by `requireServiceAuth` (internal-service-auth-middleware.ts), which
  // verifies the id-minted service token + X-Acting-User. Bypassing the global
  // user-auth hook lets that route-level service auth own the path. KEEP IN
  // SYNC with OPERATIONAL_ROUTE_PATHS in token-bucket-rate-limit.ts.
  '/v1/internal', // matches /v1/internal and /v1/internal/*
] as const;

const PROTECTED_ROUTE_PREFIXES = ['/v1', '/console/api', '/internal'] as const;

/**
 * Extended request with authenticated user context
 */
export interface AuthenticatedRequest extends FastifyRequest {
  user: {
    userId: string;
    organizationId: string;
    roles: string[];
    email: string;
    name: string;
  };
  tenantContext: {
    organizationId: string;
    userId: string;
    tier: string;
    roles: string[];
  };
  apiKey?: {
    id: string;
    name: string;
    permissions: Record<string, unknown> | null;
  };
}

/**
 * Check if route is public (no authentication required)
 */
function isPublicRoute(url: string): boolean {
  // Remove query string
  const path = url.split('?')[0];
  
  return PUBLIC_ROUTES.some((route) => {
    if (route.endsWith('/')) {
      return path.startsWith(route);
    }
    return path === route || path.startsWith(route + '/');
  });
}

function isProtectedRoute(url: string): boolean {
  const path = url.split('?')[0];
  return PROTECTED_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Extract API key from request headers
 * Supports both x-api-key and Authorization headers
 */
function extractApiKey(request: FastifyRequest): string | null {
  const apiKeyHeader = getHeaderString(request.headers, 'x-api-key');
  const authHeader = getHeaderString(request.headers, 'authorization');

  // SECURITY: long-lived credentials are NOT accepted via query string —
  // URLs end up in proxy/gateway logs and browser history. WebSocket clients
  // that cannot set headers must bootstrap an ephemeral token via
  // POST /v1/realtime/session (see the realtime session branch in
  // apiKeyAuthMiddleware).

  // Priority 1: x-api-key header (most explicit)
  if (apiKeyHeader && apiKeyHeader.startsWith('ak_')) {
    return apiKeyHeader;
  }

  // Priority 2: Authorization header
  if (authHeader) {
    const authLower = authHeader.toLowerCase();
    
    // Direct API key (Authorization: ak_live_...)
    if (authHeader.startsWith('ak_')) {
      return authHeader;
    }
    
    // Bearer token (Authorization: Bearer ak_live_...)
    if (authLower.startsWith('bearer ')) {
      const token = authHeader.substring(7);
      if (token.startsWith('ak_')) {
        return token;
      }
    }
  }

  return null;
}

/**
 * Create SHA-256 quick hash for API key lookup
 * This is indexed in the database for fast lookups before bcrypt verification
 */
function createQuickHash(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

// ── Auth-context cache (eliminates the bcrypt+DB-join cost on repeat calls) ──
// Measured: bcrypt.compare(cost=12) alone is ~300ms — paid on EVERY non-public
// request before this cache existed, regardless of endpoint. A client issuing
// several requests in quick succession with the SAME key (the common case: a
// collective's parallel model calls, a polling client, retries) repeated that
// cost every time for an identity that hadn't changed. Cached by quickHash (a
// one-way SHA-256 derivation of the key — never the raw key, never logged).
//
// ONLY successful validations are cached — a failed lookup/bcrypt mismatch is
// rare and re-runs the full path, so there's no benefit (and real risk) to
// caching negatives. The IP whitelist is intentionally NOT part of the cached
// decision: it's revalidated against the CURRENT request's IP on every call
// (see `checkIpWhitelist` below) so a cache hit can't let a whitelisted key
// bypass IP restrictions from a different address.
//
// Bounded staleness: a revoked/rotated key can remain valid from cache for up
// to AUTH_CACHE_TTL_MS after the DB write — mitigated by `invalidateApiKeyAuthCache`
// called at the known revocation/rotation call sites (best-effort; the TTL is
// the hard upper bound regardless of whether a call site is missed).
interface CachedApiKeyContext {
  context: AuthenticatedRequest['user'] & {
    apiKey: NonNullable<AuthenticatedRequest['apiKey']>;
    tenantContext: AuthenticatedRequest['tenantContext'];
    ipWhitelist: string[];
  };
  expiresAt: number;
}
const apiKeyAuthCache = new Map<string, CachedApiKeyContext>();

function authCacheTtlMs(): number {
  return Number(process.env.API_KEY_AUTH_CACHE_TTL_MS) || 30_000; // 30s default
}

/** Invalidate a cached auth context immediately (revoke/rotate call sites). */
export function invalidateApiKeyAuthCache(quickHash: string | null | undefined): void {
  if (!quickHash) return;
  apiKeyAuthCache.delete(quickHash);
}

/** Test-only: clear the whole cache so each test resolves fresh. */
export function __resetApiKeyAuthCacheForTests(): void {
  apiKeyAuthCache.clear();
}

/**
 * Extract JWT token from Authorization header
 * Returns the JWT if it's a valid JWT (not an API key)
 */
function extractJwtToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    // JWT tokens don't start with 'ak_'
    if (!token.startsWith('ak_')) {
      return token;
    }
  }

  // SECURITY: no query-string fallback — long-lived JWTs must never appear
  // in URLs. WebSocket clients use ephemeral rst_ tokens instead
  // (POST /v1/realtime/session).

  return null;
}

/**
 * Validate JWT token and return user context
 */
async function validateJwtAndGetUser(
  token: string
): Promise<AuthenticatedRequest['user'] & { apiKey?: AuthenticatedRequest['apiKey']; tenantContext: AuthenticatedRequest['tenantContext'] } | null> {
  try {
    // WHY: Keep JWT validation centralized in AuthService so local and federated
    // tokens (issuer/audience/claims rules) are enforced consistently.
    const authService = getAuthService();
    const payload = await authService.verifyToken(token);
    if (!payload) {
      return null;
    }

    // Lookup user in database to verify they still exist and are active
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: {
        organization: true,
        userRoles: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!user) {
      logger.warn({ userId: payload.userId }, 'JWT user not found in database');
      return null;
    }

    if (user.status !== 'active') {
      logger.warn({ userId: user.id, status: user.status }, 'JWT user not active');
      return null;
    }

    if (user.organizationId !== payload.organizationId) {
      logger.warn(
        {
          userId: user.id,
          tokenOrganizationId: payload.organizationId,
          userOrganizationId: user.organizationId,
        },
        'JWT organization mismatch'
      );
      return null;
    }

    // Prefer persisted RBAC roles, then fallback to user.role/token roles.
    const roleCandidates = [
      ...user.userRoles.map((ur: { role: { name: string } }) => ur.role.name),
      user.role,
      ...payload.roles,
    ];
    const roles = Array.from(
      new Set(roleCandidates.filter((value): value is string => typeof value === 'string' && value.length > 0))
    );

    return {
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      name: user.name,
      roles,
      tenantContext: {
        organizationId: user.organizationId,
        userId: user.id,
        tier: user.organization.tier,
        roles,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn({ error: errorMessage }, 'JWT validation failed');
    return null;
  }
}

/** IP whitelist check — always run against the CURRENT request's IP, cache hit or not. */
function checkIpWhitelist(ipWhitelist: string[], clientIp: string, keyId: string): boolean {
  if (!ipWhitelist || ipWhitelist.length === 0) return true;
  if (ipWhitelist.includes(clientIp)) return true;
  logger.warn({ keyId, clientIp, whitelist: ipWhitelist }, 'API key IP whitelist violation');
  return false;
}

/**
 * Resolve the API key's identity/authorization context — the expensive,
 * CACHEABLE part (DB join + bcrypt). Deliberately excludes the IP whitelist
 * decision (see the cache comment above `apiKeyAuthCache`); callers must run
 * `checkIpWhitelist` themselves with the request's current IP.
 *
 * Security Flow:
 * 1. Cache lookup by quickHash (skips 2-4 below entirely on a hit)
 * 2. Quick hash lookup (fast, indexed)
 * 3. Verify key status and expiration
 * 4. Bcrypt verification (slow, but only after quick filters)
 * 5. Load user and organization data
 */
async function resolveApiKeyContext(
  apiKey: string
): Promise<CachedApiKeyContext['context'] | null> {
  const quickHash = createQuickHash(apiKey);
  const keyPrefix = apiKey.substring(0, 15); // "ak_live_abc123" or similar

  const cached = apiKeyAuthCache.get(quickHash);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.context;
  }

  try {
    // Step 1: Quick hash lookup (indexed query)
    const apiKeyRecord = await prisma.apiKey.findFirst({
      where: {
        OR: [
          { quickHash },
          { keyPrefix },
        ],
      },
      include: {
        user: {
          include: {
            organization: true,
            userRoles: {
              include: {
                role: true,
              },
            },
          },
        },
      },
    });

    if (!apiKeyRecord) {
      logger.warn({ keyPrefix }, 'API key not found in database');
      return null;
    }

    // Step 2: Verify key status
    if (apiKeyRecord.status === 'revoked') {
      logger.warn(
        { keyId: apiKeyRecord.id, status: apiKeyRecord.status, reason: apiKeyRecord.statusReason },
        'API key revoked'
      );
      return null;
    }

    if (apiKeyRecord.status === 'expired') {
      logger.warn({ keyId: apiKeyRecord.id, expiresAt: apiKeyRecord.expiresAt }, 'API key expired');
      return null;
    }

    // Step 3: Check expiration date
    if (apiKeyRecord.expiresAt && new Date(apiKeyRecord.expiresAt) < new Date()) {
      logger.warn({ keyId: apiKeyRecord.id, expiresAt: apiKeyRecord.expiresAt }, 'API key expired (date)');

      // Auto-expire the key
      await prisma.apiKey.update({
        where: { id: apiKeyRecord.id },
        data: { status: 'expired' },
      });

      return null;
    }

    // Step 4: Verify bcrypt hash (expensive operation, but we've already filtered)
    const isValidHash = await bcrypt.compare(apiKey, apiKeyRecord.keyHash);

    if (!isValidHash) {
      logger.warn(
        { keyId: apiKeyRecord.id, keyPrefix },
        'API key hash mismatch (possible collision or tampering)'
      );
      return null;
    }

    // Step 6: Check user status
    if (apiKeyRecord.user.status !== 'active') {
      logger.warn(
        { userId: apiKeyRecord.userId, status: apiKeyRecord.user.status },
        'User account not active'
      );
      return null;
    }

    // Step 7: Check organization status
    if (apiKeyRecord.user.organization.status !== 'active') {
      logger.warn(
        { organizationId: apiKeyRecord.organizationId, status: apiKeyRecord.user.organization.status },
        'Organization not active'
      );
      return null;
    }

    // Step 8: Extract roles (from user.role + userRoles join)
    const roles: string[] = [apiKeyRecord.user.role];

    // Add roles from RBAC system (if using UserRole table)
    if (apiKeyRecord.user.userRoles && apiKeyRecord.user.userRoles.length > 0) {
      for (const userRole of apiKeyRecord.user.userRoles) {
        if (userRole.role && !roles.includes(userRole.role.name)) {
          roles.push(userRole.role.name);
        }
      }
    }

    // Step 9: Build the context and cache it (keyed by quickHash) so the NEXT
    // request from this key skips the DB join + bcrypt entirely.
    const context: CachedApiKeyContext['context'] = {
      userId: apiKeyRecord.user.id,
      organizationId: apiKeyRecord.user.organizationId,
      roles,
      email: apiKeyRecord.user.email,
      name: apiKeyRecord.user.name,
      apiKey: {
        id: apiKeyRecord.id,
        name: apiKeyRecord.name,
        permissions: apiKeyRecord.permissions as Record<string, unknown> | null,
      },
      tenantContext: {
        organizationId: apiKeyRecord.user.organizationId,
        userId: apiKeyRecord.user.id,
        tier: apiKeyRecord.user.organization.tier,
        roles,
      },
      ipWhitelist: apiKeyRecord.ipWhitelist ?? [],
    };
    apiKeyAuthCache.set(quickHash, { context, expiresAt: Date.now() + authCacheTtlMs() });

    return context;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage, keyPrefix }, 'Error validating API key');
    return null;
  }
}

/**
 * Fire-and-forget "last used" tracking — a single indexed UPDATE by primary
 * key, run on EVERY successful auth (cache hit or miss) since it's cheap and
 * keeps usage telemetry accurate even when the expensive lookup was skipped.
 */
function trackApiKeyUsage(apiKeyId: string, clientIp: string): void {
  prisma.apiKey
    .update({
      where: { id: apiKeyId },
      data: {
        lastUsedAt: new Date(),
        requestCount: { increment: 1 },
        lastRequestIp: clientIp,
      },
    })
    .catch((error: unknown) => {
      // Non-critical: Log but don't fail request
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage, keyId: apiKeyId }, 'Failed to update API key usage tracking');
    });
}

/**
 * Validate API key and return user context — resolves the (possibly cached)
 * identity context, then ALWAYS re-checks the IP whitelist against the
 * current request's IP before granting access.
 */
async function validateApiKeyAndGetUser(
  apiKey: string,
  clientIp: string
): Promise<AuthenticatedRequest['user'] & { apiKey: AuthenticatedRequest['apiKey']; tenantContext: AuthenticatedRequest['tenantContext'] } | null> {
  const context = await resolveApiKeyContext(apiKey);
  if (!context) return null;

  if (!checkIpWhitelist(context.ipWhitelist, clientIp, context.apiKey.id)) {
    return null;
  }

  trackApiKeyUsage(context.apiKey.id, clientIp);

  const { ipWhitelist: _ipWhitelist, ...publicContext } = context;
  return publicContext;
}

/**
 * API Key Authentication Middleware
 * 
 * Enterprise-grade authentication with real database lookups,
 * security validations, and audit logging.
 * 
 * Usage:
 *   server.addHook('preHandler', apiKeyAuthMiddleware);
 */
export async function apiKeyAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const url = request.url.split('?')[0];

  // Skip authentication for public routes
  if (isPublicRoute(url)) {
    request.log.debug({ url }, 'Public route - skipping authentication');
    return;
  }

  if (!isProtectedRoute(url)) {
    request.log.debug({ url }, 'Non-API route - skipping authentication');
    return;
  }

  // ── Realtime WebSocket: ephemeral session tokens (rst_) ───────────────────
  // Accepted ONLY for the /v1/realtime upgrade. Issued single-use with a
  // 5-minute TTL by POST /v1/realtime/session, so long-lived credentials
  // never appear in WebSocket URLs (proxy logs, browser history).
  if (url === '/v1/realtime') {
    const query = request.query as Record<string, string | undefined>;
    const queryToken = query?.token;

    if (queryToken?.startsWith(REALTIME_SESSION_TOKEN_PREFIX)) {
      const identity = query?.sessionId
        ? await consumeRealtimeSession(query.sessionId, queryToken)
        : null;

      if (!identity) {
        return reply.status(401).send({
          error: {
            code: 'invalid_session_token',
            message:
              'Invalid, expired, or already-used realtime session token. Create a new session via POST /v1/realtime/session.',
            type: 'authentication_error',
          },
        });
      }

      const authenticatedRequest = request as AuthenticatedRequest & ExtendedFastifyRequest;
      authenticatedRequest.user = {
        userId: identity.userId,
        organizationId: identity.organizationId,
        roles: identity.roles,
        email: identity.email,
        name: identity.name,
      };
      authenticatedRequest.tenantContext = {
        organizationId: identity.organizationId,
        userId: identity.userId,
        tier: identity.tier,
        roles: identity.roles,
      };
      authenticatedRequest.organizationId = identity.organizationId;
      authenticatedRequest.userId = identity.userId;
      authenticatedRequest.organizationTier = identity.tier;
      authenticatedRequest.userContext = createOrchestrationContext(request);

      request.log.info(
        { userId: identity.userId, organizationId: identity.organizationId, authMethod: 'realtime_session' },
        'Realtime session token authentication successful'
      );
      return;
    }

    if (queryToken) {
      // A non-rst_ token in the URL is a long-lived credential — reject it
      // explicitly so callers migrate to the session bootstrap instead of
      // leaking keys into access logs.
      return reply.status(401).send({
        error: {
          code: 'credential_in_url',
          message:
            'Long-lived credentials are not accepted in the WebSocket URL. Create a session via POST /v1/realtime/session and connect with the returned wsUrl.',
          type: 'authentication_error',
        },
      });
    }
    // No query token: fall through to header-based auth below.
  }

  // Extract API key from headers
  const apiKey = extractApiKey(request);
  
  // Try JWT if no API key found
  if (!apiKey) {
    const jwtToken = extractJwtToken(request);
    
    if (jwtToken) {
      // Validate JWT and get user context
      const jwtContext = await validateJwtAndGetUser(jwtToken);
      
      if (jwtContext) {
        // Attach authenticated user context to request
        const authenticatedRequest = request as AuthenticatedRequest & ExtendedFastifyRequest;
        authenticatedRequest.user = {
          userId: jwtContext.userId,
          organizationId: jwtContext.organizationId,
          roles: jwtContext.roles,
          email: jwtContext.email,
          name: jwtContext.name,
        };
        authenticatedRequest.tenantContext = jwtContext.tenantContext;
        authenticatedRequest.organizationId = jwtContext.organizationId;
        authenticatedRequest.userId = jwtContext.userId;
        authenticatedRequest.organizationTier = jwtContext.tenantContext.tier;
        authenticatedRequest.userContext = createOrchestrationContext(request);
        
        request.log.info(
          {
            userId: jwtContext.userId,
            organizationId: jwtContext.organizationId,
            roles: jwtContext.roles,
            authMethod: 'jwt',
          },
          'JWT authentication successful'
        );
        return;
      }
      
      // JWT validation failed
      request.log.warn(
        { url, method: request.method },
        'JWT authentication failed'
      );

      // CRITICAL: `return reply.send(...)` (NOT `reply.send(...); return;`).
      // In Fastify, returning the reply tells the framework "response handled,
      // stop the hook chain". Without it, subsequent preHandler hooks
      // (token-bucket, sanitization, deprecation, etc.) and the route handler
      // itself still run and try to call `reply.send()` again →
      // FST_ERR_REP_ALREADY_SENT.
      return reply.status(401).send({
        error: {
          code: 'invalid_token',
          message: 'Invalid or expired JWT token',
          type: 'authentication_error',
        },
      });
    }

    // No API key or JWT provided
    request.log.warn(
      {
        url,
        method: request.method,
        headers: {
          hasAuth: !!request.headers.authorization,
          hasApiKey: !!request.headers['x-api-key'],
        }
      },
      'Authentication required - no API key or JWT provided'
    );

    return reply.status(401).send({
      error: {
        code: 'unauthorized',
        message: 'API key or JWT required. Provide via x-api-key header or Authorization: Bearer <key>',
        type: 'authentication_error',
      },
    });
  }

  // Get client IP (respecting X-Forwarded-For for proxies/load balancers)
  const forwarded = getHeaderString(request.headers, 'x-forwarded-for');
  const clientIp =
    (forwarded?.split(',')[0]?.trim()) ||
    getHeaderString(request.headers, 'x-real-ip') ||
    request.ip ||
    'unknown';

  // Validate API key and get user context
  const authContext = await validateApiKeyAndGetUser(apiKey, clientIp);

  if (!authContext) {
    request.log.warn(
      {
        url,
        method: request.method,
        clientIp,
        keyPrefix: apiKey.substring(0, 15),
      },
      'Authentication failed - invalid API key'
    );

    // `return reply` — see comment above the JWT branch.
    return reply.status(401).send({
      error: {
        code: 'invalid_api_key',
        message: 'Invalid or expired API key',
        type: 'authentication_error',
      },
    });
  }

  // Attach authenticated user context to request
  const authenticatedRequest = request as AuthenticatedRequest & ExtendedFastifyRequest;
  authenticatedRequest.user = {
    userId: authContext.userId,
    organizationId: authContext.organizationId,
    roles: authContext.roles,
    email: authContext.email,
    name: authContext.name,
  };
  authenticatedRequest.tenantContext = authContext.tenantContext;
  authenticatedRequest.apiKey = authContext.apiKey;
  authenticatedRequest.organizationId = authContext.organizationId;
  authenticatedRequest.userId = authContext.userId;
  authenticatedRequest.organizationTier = authContext.tenantContext.tier;
  authenticatedRequest.userContext = createOrchestrationContext(request);

  request.log.info(
    {
      userId: authContext.userId,
      organizationId: authContext.organizationId,
      roles: authContext.roles,
      apiKeyName: authContext.apiKey?.name,
    },
    'Authentication successful'
  );
}
