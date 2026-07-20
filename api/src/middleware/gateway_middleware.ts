// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared Gateway Middleware for Fastify Applications
 * 
 * This middleware provides quota and signature validation for Fastify services.
 * The gateway (Nginx) already validates JWT authentication and adds identity headers.
 * 
 * In test/development environments without the gateway services, this middleware
 * can be configured to skip external validation via GATEWAY_MIDDLEWARE_ENABLED=false
 */

import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { getHeaderString, isObject } from '@/utils/type-guards';
import {
  buildCanonicalContextHeaders,
  resolveCanonicalIdentityContext,
} from '@/utils/context-headers';

const DEFAULT_QUOTA_SERVICE_URLS = [
  'http://quota-service:5004',
  'http://gateway_quota-service:5004',
  'http://gateway-quota:5004',
];

const DEFAULT_SIGNATURE_VERIFIER_URLS = [
  'http://signature-verifier:5005',
  'http://gateway_signature-verifier:5005',
  'http://gateway-signature-verifier:5005',
];

const DEFAULT_SENSITIVE_ROUTES = ['/payment', '/billing', '/admin', '/console/api/admin'];
/**
 * Operational endpoints that MUST bypass quota validation.
 *
 * SYNC INVARIANT — keep aligned with the two sibling allowlists:
 *   - api-key-auth-middleware.PUBLIC_ROUTES (auth bypass)
 *   - token-bucket-rate-limit.OPERATIONAL_ROUTE_PATHS (rate-limit bypass)
 *
 * Adding an operational endpoint to one without the others leaves a
 * "credential-presence-gated" gap: the route returns 200 when no
 * credentials are sent (probes), but 503 quota_validation_error when
 * any junk credential header is supplied. Operational tooling sometimes
 * carries leftover credentials, so the bypass MUST be path-name-gated,
 * not credential-presence-gated.
 *
 * Matching is `startsWith` via routeMatchesPrefix (line 122). For exact
 * paths like /v1/hcra/health, the prefix is fine because no descendant
 * route exists. Operators can also override at deploy time via the
 * GATEWAY_QUOTA_SKIP_ROUTES env var.
 */
export const DEFAULT_QUOTA_SKIP_ROUTES = [
  '/health',
  '/metrics',
  '/v1/enterprise/quotas',
  '/v1/hcra/health',
  // ─── Added 2026-04-25 by the operational-route boot invariant (Caminho C) ───
  // These were latent same-family gaps as the original HCRA bug: probes
  // without credentials short-circuited (200), but probes carrying any
  // junk creds tripped the upstream quota fetch (503). Added once, covered
  // permanently by `assertOperationalRouteInvariant()` from now on.
  '/.well-known/jwks.json',
  '/console/api/v1/jwks',
  '/v1/status', // bare-prefix here covers /v1/status/health + /v1/status/ready
] as const;
const RETRYABLE_UPSTREAM_STATUS_CODES = new Set([404, 405, 408, 500, 502, 503, 504]);

function toNormalizedUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function parseServiceUrls(
  singleValue: string | undefined,
  listValue: string | undefined,
  defaults: string[]
): string[] {
  const values: string[] = [];

  for (const source of [singleValue, listValue]) {
    if (!source) {
      continue;
    }
    for (const item of source.split(',')) {
      const normalized = toNormalizedUrl(item);
      if (normalized.length > 0) {
        values.push(normalized);
      }
    }
  }

  for (const item of defaults) {
    const normalized = toNormalizedUrl(item);
    if (normalized.length > 0) {
      values.push(normalized);
    }
  }

  return Array.from(new Set(values));
}

function parseRoutePrefixes(rawValue: string | undefined, defaults: readonly string[]): string[] {
  const source = rawValue && rawValue.trim().length > 0 ? rawValue : defaults.join(',');
  return source
    .split(',')
    .map((route) => route.trim())
    .filter((route) => route.length > 0)
    .map((route) => (route.startsWith('/') ? route : `/${route}`));
}

function parseTimeoutMs(rawValue: string | undefined, defaultMs: number): number {
  if (!rawValue) {
    return defaultMs;
  }

  const trimmed = rawValue.trim().toLowerCase();
  if (trimmed.length === 0) {
    return defaultMs;
  }

  const hasMsSuffix = trimmed.endsWith('ms');
  const hasSSuffix = trimmed.endsWith('s') && !hasMsSuffix;
  const numericPart = hasMsSuffix
    ? trimmed.slice(0, -2)
    : hasSSuffix
      ? trimmed.slice(0, -1)
      : trimmed;
  const parsed = Number.parseInt(numericPart, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultMs;
  }

  if (hasMsSuffix) {
    return parsed;
  }

  if (hasSSuffix) {
    return parsed * 1000;
  }

  // Keep backward compatibility:
  // - small values (e.g. "5") are interpreted as seconds
  // - larger values are interpreted as milliseconds
  return parsed < 100 ? parsed * 1000 : parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRoutePath(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart >= 0 ? url.slice(0, queryStart) : url;
}

function routeMatchesPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

const QUOTA_SERVICE_URLS = parseServiceUrls(
  process.env.QUOTA_SERVICE_URL,
  process.env.QUOTA_SERVICE_URLS,
  DEFAULT_QUOTA_SERVICE_URLS
);
const SIGNATURE_VERIFIER_URLS = parseServiceUrls(
  process.env.SIGNATURE_VERIFIER_URL,
  process.env.SIGNATURE_VERIFIER_URLS,
  DEFAULT_SIGNATURE_VERIFIER_URLS
);
const QUOTA_SERVICE_TIMEOUT = clamp(parseTimeoutMs(process.env.QUOTA_SERVICE_TIMEOUT, 5000), 250, 60000);
const SIGNATURE_VERIFIER_TIMEOUT = clamp(
  parseTimeoutMs(process.env.SIGNATURE_VERIFIER_TIMEOUT, 5000),
  250,
  60000
);
const SENSITIVE_ROUTES = parseRoutePrefixes(process.env.SENSITIVE_ROUTES, DEFAULT_SENSITIVE_ROUTES);
/**
 * Effective (env-resolved) quota skip routes.
 *
 * Exported so the operational-route-invariant module (called at boot from
 * server.ts) can validate that the resolved list — after any operator
 * GATEWAY_QUOTA_SKIP_ROUTES override — still covers all canonical
 * operational routes. A misconfigured override that DROPS `/v1/hcra/health`
 * would otherwise pass typecheck and tests, then surface as `503
 * quota_validation_error` in production probes.
 */
export const QUOTA_SKIP_ROUTES = parseRoutePrefixes(
  process.env.GATEWAY_QUOTA_SKIP_ROUTES,
  DEFAULT_QUOTA_SKIP_ROUTES
);

// Skip gateway validation in test/development environments when services are not available
// Set GATEWAY_MIDDLEWARE_ENABLED=true to enable in any environment
const isTestEnvironment = process.env.NODE_ENV === 'test';
const gatewayExplicitlyEnabled = process.env.GATEWAY_MIDDLEWARE_ENABLED === 'true';
const gatewayExplicitlyDisabled = process.env.GATEWAY_MIDDLEWARE_ENABLED === 'false';

// By default: enabled in production, disabled in test, optional in development
const GATEWAY_MIDDLEWARE_ENABLED = gatewayExplicitlyEnabled ? true : 
                                    gatewayExplicitlyDisabled ? false :
                                    !isTestEnvironment;

type UpstreamRequestOptions = {
  baseUrls: string[];
  endpointPath: string;
  init: Omit<RequestInit, 'signal'>;
  timeoutMs: number;
  serviceName: string;
};

type UpstreamResponse = {
  response: Response;
  baseUrl: string;
};

async function fetchWithFallback(
  request: FastifyRequest,
  options: UpstreamRequestOptions
): Promise<UpstreamResponse> {
  const { baseUrls, endpointPath, init, timeoutMs, serviceName } = options;

  for (let index = 0; index < baseUrls.length; index += 1) {
    const baseUrl = baseUrls[index];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${endpointPath}`, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const hasFallbackCandidate = index < baseUrls.length - 1;
      if (hasFallbackCandidate && RETRYABLE_UPSTREAM_STATUS_CODES.has(response.status)) {
        request.log.warn(
          { serviceName, baseUrl, status: response.status },
          'Gateway middleware upstream candidate returned retryable status'
        );
        continue;
      }

      return { response, baseUrl };
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      const hasFallbackCandidate = index < baseUrls.length - 1;
      if (hasFallbackCandidate) {
        request.log.warn(
          { serviceName, baseUrl, error },
          'Gateway middleware upstream candidate request failed'
        );
        continue;
      }

      throw error;
    }
  }

  throw new Error(`No reachable upstream endpoints for ${serviceName}`);
}

/**
 * Extract user ID from gateway identity headers
 */
function getUserId(request: FastifyRequest): string | null {
  return getHeaderString(request.headers, 'x-auth-request-user') ||
         getHeaderString(request.headers, 'x-user-id') ||
         null;
}

type QuotaCheckResponse = {
  allowed: boolean;
  reason?: string;
  remaining_daily?: number;
  remaining_monthly?: number;
};

function isQuotaCheckResponse(value: unknown): value is QuotaCheckResponse {
  if (!isObject(value)) return false;
  return typeof value.allowed === 'boolean';
}

function getCanonicalIdentityContext(request: FastifyRequest) {
  return resolveCanonicalIdentityContext(request.headers, request.query);
}

/**
 * Extract tenant ID from headers or request
 */
function getTenantId(request: FastifyRequest): string | null {
  const context = getCanonicalIdentityContext(request);
  return context.tenantId ?? null;
}

/**
 * Extract API key from Authorization header
 */
function getApiKey(request: FastifyRequest): string | null {
  const authHeader = getHeaderString(request.headers, 'authorization') ?? '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return getHeaderString(request.headers, 'x-api-key') ?? null;
}

/**
 * Quota validation hook for Fastify
 */
export async function quotaValidationHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Skip if gateway middleware is disabled (e.g., test environment)
  if (!GATEWAY_MIDDLEWARE_ENABLED) {
    return;
  }

  const routePath = normalizeRoutePath(request.url);

  // Skip quota check for public/control-plane routes
  if (routeMatchesPrefix(routePath, QUOTA_SKIP_ROUTES)) {
    return;
  }

  const userId = getUserId(request);
  const apiKey = getApiKey(request);
  const identityContext = getCanonicalIdentityContext(request);
  const tenantId = getTenantId(request);

  if (!userId && !apiKey) {
    // No user or API key - might be a public route, skip quota check
    request.log.warn('Quota middleware: No user_id or api_key found, skipping quota check');
    return;
  }

  try {
    const payload = {
      api_key: apiKey || userId,
      route: routePath,
      method: request.method,
      tenant_id: tenantId
    };
    const contextHeaders = buildCanonicalContextHeaders({
      userId: identityContext.userId ?? userId ?? undefined,
      organizationId: identityContext.organizationId,
      tenantId: identityContext.tenantId,
      workspaceId: identityContext.workspaceId,
    });

    const { response, baseUrl } = await fetchWithFallback(request, {
      baseUrls: QUOTA_SERVICE_URLS,
      endpointPath: '/check',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...contextHeaders,
        },
        body: JSON.stringify(payload)
      },
      timeoutMs: QUOTA_SERVICE_TIMEOUT,
      serviceName: 'quota-service'
    });

    if (response.status === 200) {
      let data: unknown;
      try {
        data = await response.json();
      } catch (parseError: unknown) {
        request.log.error({ parseError, baseUrl }, 'Quota service returned non-JSON payload');
        reply.code(503).send({
          error: 'quota_service_invalid_response',
          message: 'Quota validation service returned invalid response'
        });
        return;
      }

      if (!isQuotaCheckResponse(data)) {
        request.log.error({ data }, 'Quota service returned invalid payload');
        reply.code(503).send({
          error: 'quota_service_invalid_response',
          message: 'Quota validation service returned invalid response'
        });
        return;
      }

      if (data.allowed === true) {
        // Quota check passed
        return;
      } else {
        // Quota exceeded
        const reason = data.reason || 'quota_exceeded';
        reply.code(429).send({
          error: 'quota_exceeded',
          reason: reason,
          remaining_daily: data.remaining_daily || 0,
          remaining_monthly: data.remaining_monthly || 0
        });
        return;
      }
    } else {
      // Quota service error
      request.log.error(
        { baseUrl, status: response.status },
        'Quota service returned unexpected status'
      );
      // Fail-closed: Deny access if quota service fails
      reply.code(503).send({
        error: 'quota_service_unavailable',
        message: 'Quota validation service is temporarily unavailable'
      });
      return;
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      request.log.error('Quota service timeout');
      // Fail-closed: Deny access on timeout
      reply.code(503).send({
        error: 'quota_service_timeout',
        message: 'Quota validation service timeout'
      });
      return;
    }
    request.log.error({ error }, 'Quota middleware error');
    // Fail-closed: Deny access on error
    reply.code(503).send({
      error: 'quota_validation_error',
      message: 'Quota validation failed'
    });
    return;
  }
}

/**
 * Signature validation hook for Fastify
 */
export async function signatureValidationHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Skip if gateway middleware is disabled (e.g., test environment)
  if (!GATEWAY_MIDDLEWARE_ENABLED) {
    return;
  }

  const routePath = normalizeRoutePath(request.url);

  // Check if route requires signature validation
  const requiresSignature = routeMatchesPrefix(routePath, SENSITIVE_ROUTES);

  if (!requiresSignature) {
    return;
  }

  const tenantId = getTenantId(request);
  const identityContext = getCanonicalIdentityContext(request);
  if (!tenantId) {
    request.log.warn('Signature middleware: No tenant_id found for sensitive route');
    // Fail-closed: Deny access without tenant_id
    reply.code(400).send({
      error: 'tenant_id_required',
      message: 'Tenant ID required for signature validation'
    });
    return;
  }

  // Extract signature headers
  const xJws = getHeaderString(request.headers, 'x-jws');
  const xSignature = getHeaderString(request.headers, 'x-signature');
  const xTimestamp = getHeaderString(request.headers, 'x-timestamp');

  if (!xJws && !xSignature) {
    // Fail-closed: Deny access without signature
    reply.code(403).send({
      error: 'signature_missing',
      message: 'Request signature required for sensitive routes'
    });
    return;
  }

  try {
    const params = new URLSearchParams({
      route: routePath,
      method: request.method,
      tenant_id: tenantId,
      date: xTimestamp ?? getHeaderString(request.headers, 'date') ?? '',
      digest: getHeaderString(request.headers, 'content-digest') ?? ''
    });

    const headers: Record<string, string> = buildCanonicalContextHeaders({
      userId: identityContext.userId ?? getUserId(request) ?? undefined,
      organizationId: identityContext.organizationId,
      tenantId: identityContext.tenantId,
      workspaceId: identityContext.workspaceId,
    });
    if (xJws) {
      headers['X-JWS'] = xJws;
    }
    if (xSignature) {
      headers['X-Signature'] = xSignature;
    }

    const { response, baseUrl } = await fetchWithFallback(request, {
      baseUrls: SIGNATURE_VERIFIER_URLS,
      endpointPath: `/verify?${params.toString()}`,
      init: {
        method: 'GET',
        headers
      },
      timeoutMs: SIGNATURE_VERIFIER_TIMEOUT,
      serviceName: 'signature-verifier'
    });

    if (response.status === 204) {
      // Signature valid
      return;
    } else if (response.status === 403) {
      // Signature invalid
      const denyReason = response.headers.get('X-Deny-Reason') || 'signature_invalid';
      reply.code(403).send({
        error: 'signature_invalid',
        reason: denyReason,
        message: 'Request signature validation failed'
      });
      return;
    } else {
      // Signature verifier error
      request.log.error(
        { baseUrl, status: response.status },
        'Signature verifier returned unexpected status'
      );
      // Fail-closed: Deny access if verifier fails
      reply.code(503).send({
        error: 'signature_verifier_unavailable',
        message: 'Signature validation service is temporarily unavailable'
      });
      return;
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      request.log.error('Signature verifier timeout');
      // Fail-closed: Deny access on timeout
      reply.code(503).send({
        error: 'signature_verifier_timeout',
        message: 'Signature validation service timeout'
      });
      return;
    }
    request.log.error({ error }, 'Signature middleware error');
    // Fail-closed: Deny access on error
    reply.code(503).send({
      error: 'signature_validation_error',
      message: 'Signature validation failed'
    });
    return;
  }
}

/**
 * Apply gateway middlewares to Fastify app
 * 
 * Usage:
 *   import { applyGatewayMiddlewares } from './middleware/gateway_middleware';
 *   await applyGatewayMiddlewares(server);
 */
export async function applyGatewayMiddlewares(server: FastifyInstance): Promise<void> {
  // Register quota validation hook (before other hooks)
  server.addHook('onRequest', quotaValidationHook);
  
  // Register signature validation hook (before other hooks)
  server.addHook('onRequest', signatureValidationHook);
  
  server.log.info('✅ Gateway middlewares applied (quota + signature)');
}
