// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * billing-tenant-resolver.ts
 *
 * Namespace resolution ci -> billing: today every ci -> billing call addresses
 * the tenant with ci's OWN organizationId (the ci org UUID). But the canonical
 * namespace where the PLAN + Stripe customer actually live is id's tenant_id —
 * the same namespace the rest of the platform (chat, the portal BFF) already
 * uses. This module resolves that canonical `tenant_id` for a ci org, so the
 * three ci -> billing call sites (usage report, plan entitlements, wallet
 * checkout proxy) can address the tenant billing actually knows.
 *
 * ## Contract with id (frozen; the id side ships in parallel)
 *
 * `GET {ID_INTERNAL_BASE_URL}/internal/tenants/by-account/<account_id>` with a
 * client_credentials Bearer token. The `account_id` is ci's `User.id` — the
 * `ci User.id == id sub` invariant (services/internal-acting-user.ts) is what
 * makes this addressable from ci at all. 200 `{ "tenant_id", "account_id" }`;
 * 404 means the account has no tenant (negative-cached, short TTL).
 *
 * ## Resolution order (each layer shields the next)
 *
 * 1. `Organization.billingTenantId` (Postgres, write-through on every network
 *    hit) — survives Redis loss AND id outages once warm;
 * 2. Redis positive cache (~24h) — shields id and Postgres from per-request
 *    resolution storms;
 * 3. Redis NEGATIVE cache (~5min) — a 404 from id is a stable fact for the
 *    window, not an outage; caching it keeps orgs without a mapping from
 *    paying a 3s round-trip on every billing touch;
 * 4. id's internal endpoint (3s AbortSignal).
 *
 * ## Failure philosophy — fail-open to the status quo, ALWAYS
 *
 * This resolver sits in front of BILLING calls that were working before it
 * existed. It must never become a new way for those calls to fail: EVERY
 * failure (flag off, not configured, DB error, Redis error, id unreachable,
 * timeout, bad response shape) resolves to `null`, and the single public
 * entry point `billableTenantId` turns that into the caller's own
 * `organizationId` — i.e. today's exact behavior. Same house style as
 * billing-entitlements-client.ts (availability of an external service is an
 * orthogonal failure category from business data; it never fails closed).
 *
 * ## Flag
 *
 * `BILLING_TENANT_MAPPING_ENABLED` (default FALSE): with the flag off
 * `billableTenantId` returns `organizationId` WITHOUT touching DB, Redis or
 * the network — the wiring lands dark, and lighting it is a deploy-time act,
 * like every other gate in this repo.
 */

import { prisma } from '@/database/client';
import { getGlobalRedisClient } from '@/cache/redis-client';
import { logger } from '@/utils/logger';
import { createOAuth2ClientCredentialsProvider } from '@/providers/_shared/oauth2-client-credentials';
import type { TokenProvider } from '@/providers/_shared/token-provider';

const log = logger.child({ component: 'billing-tenant-resolver' });

const POSITIVE_CACHE_KEY_PREFIX = 'billing:tenant-mapping:';
const NEGATIVE_CACHE_KEY_PREFIX = 'billing:tenant-mapping:none:';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const POSITIVE_TTL_SECONDS = envInt('BILLING_TENANT_MAPPING_CACHE_TTL_SECONDS', 86_400);
const NEGATIVE_TTL_SECONDS = envInt('BILLING_TENANT_MAPPING_NEGATIVE_TTL_SECONDS', 300);
const FETCH_TIMEOUT_MS = envInt('BILLING_TENANT_MAPPING_TIMEOUT_MS', 3000);

export function isBillingTenantMappingEnabled(): boolean {
  return process.env.BILLING_TENANT_MAPPING_ENABLED === 'true';
}

function idInternalBaseUrl(): string {
  return (process.env.ID_INTERNAL_BASE_URL ?? 'http://id-api:5001').replace(/\/+$/, '');
}

// Mirrors the env-var naming pattern of the billing M2M client
// (CI_BILLING_CLIENT_OIDC_* — see billing-actor-token.ts): this is the
// DEDICATED id client for ci's tenant-namespace reads (audience=ailin-id,
// scope=tenants:read), NOT the billing client — a different audience, a
// different secret, revocable independently.
function idClientConfig() {
  return {
    tokenUrl:
      process.env.CI_ID_CLIENT_OIDC_TOKEN_URL?.trim() ||
      `${idInternalBaseUrl()}/oauth/token`,
    clientId: process.env.CI_ID_CLIENT_OIDC_CLIENT_ID?.trim() || 'ailin-ci-id-client',
    clientSecret: (process.env.CI_ID_CLIENT_OIDC_CLIENT_SECRET ?? '').trim(),
    audience: process.env.CI_ID_CLIENT_ALLOWED_AUDIENCES?.split(',')[0]?.trim() || 'ailin-id',
    scope: process.env.CI_ID_CLIENT_ALLOWED_SCOPES?.split(',')[0]?.trim() || 'tenants:read',
  };
}

let tokenProvider: TokenProvider | null | undefined; // undefined = not yet built this process

function getIdTenantTokenProvider(): TokenProvider | null {
  if (tokenProvider !== undefined) {
    return tokenProvider;
  }

  const cfg = idClientConfig();
  if (!cfg.clientSecret) {
    log.info(
      'CI_ID_CLIENT_OIDC_CLIENT_SECRET is not set -- tenant namespace resolution ' +
        'cannot reach id; every org falls back to its own organizationId'
    );
    tokenProvider = null;
    return tokenProvider;
  }

  try {
    tokenProvider = createOAuth2ClientCredentialsProvider({
      authUrl: cfg.tokenUrl,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      scope: cfg.scope,
      authStyle: 'body',
      // id's oauth/token REJECTS a client_credentials request without
      // audience (400 invalid_request) — this is load-bearing, not decoration.
      extraBodyParams: { audience: cfg.audience },
    });
  } catch (error) {
    log.warn({ error }, 'failed to construct the id tenant-token provider');
    tokenProvider = null;
  }
  return tokenProvider;
}

async function readFromDb(organizationId: string): Promise<string | null> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { billingTenantId: true },
    });
    return org?.billingTenantId ?? null;
  } catch (error) {
    log.warn(
      { error, organizationId },
      'billing tenant mapping DB read failed -- falling through to the cache/network layers'
    );
    return null;
  }
}

async function readFromCache(key: string): Promise<string | null> {
  try {
    const redis = getGlobalRedisClient();
    const cached = await redis.get(key);
    return cached || null;
  } catch (error) {
    log.warn({ error }, 'billing tenant mapping Redis read failed -- treating as a cache miss');
    return null;
  }
}

/**
 * Write-through persistence of a network hit: Postgres (the durable layer)
 * plus the ~24h positive Redis cache. Either write failing is logged and
 * swallowed — the RESOLVED VALUE is still returned to the caller either way;
 * a failed persistence only costs the next call a re-resolution.
 */
async function persistMapping(organizationId: string, tenantId: string): Promise<void> {
  try {
    await prisma.organization.update({
      where: { id: organizationId },
      data: { billingTenantId: tenantId },
    });
  } catch (error) {
    log.warn(
      { error, organizationId, tenantId },
      'billing tenant mapping DB write-through failed (resolution still returned to the caller)'
    );
  }
  try {
    const redis = getGlobalRedisClient();
    await redis.setex(positiveCacheKey(organizationId), POSITIVE_TTL_SECONDS, tenantId);
  } catch (error) {
    log.warn(
      { error, organizationId },
      'billing tenant mapping Redis write failed (DB write-through unaffected)'
    );
  }
}

async function persistNegative(organizationId: string): Promise<void> {
  try {
    const redis = getGlobalRedisClient();
    await redis.setex(
      negativeCacheKey(organizationId),
      NEGATIVE_TTL_SECONDS,
      // Sentinel marker — the negative key's EXISTENCE is the signal; the
      // value only aids debugging (redis get shows WHY it was cached).
      'no-tenant'
    );
  } catch (error) {
    log.warn({ error, organizationId }, 'billing tenant mapping negative-cache write failed');
  }
}

function positiveCacheKey(organizationId: string): string {
  return `${POSITIVE_CACHE_KEY_PREFIX}${organizationId}`;
}

function negativeCacheKey(organizationId: string): string {
  return `${NEGATIVE_CACHE_KEY_PREFIX}${organizationId}`;
}

interface IdTenantLookupResponse {
  tenant_id?: unknown;
  account_id?: unknown;
  data?: IdTenantLookupResponse;
}

/**
 * The network leg: id's internal by-account tenant lookup. Returns the
 * canonical tenant_id, or null on 404 (no mapping) / ANY failure — never
 * throws. Caller must have already checked the flag and the caches.
 */
async function resolveViaId(organizationId: string, userId: string): Promise<string | null> {
  const provider = getIdTenantTokenProvider();
  if (!provider) {
    return null;
  }

  let authHeaders: Record<string, string>;
  try {
    // Typically { Authorization: 'Bearer <jwt>' } — minted+cached by the
    // shared OAuth2 client_credentials provider (audience=ailin-id).
    authHeaders = await provider.buildAuthHeader();
  } catch (error) {
    log.warn(
      { error, organizationId },
      'failed to mint the id tenant-lookup token -- falling back to organizationId'
    );
    return null;
  }

  const baseUrl = idInternalBaseUrl();
  try {
    const response = await fetch(
      `${baseUrl}/internal/tenants/by-account/${encodeURIComponent(userId)}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...authHeaders,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );

    if (response.status === 404) {
      // A stable "this account has no tenant" — short negative cache so the
      // org stops paying the round-trip for the next few minutes.
      await persistNegative(organizationId);
      log.info(
        { organizationId, userId },
        'id returned 404 for the account tenant lookup -- no canonical tenant (negative-cached)'
      );
      return null;
    }

    if (!response.ok) {
      log.warn(
        { status: response.status, organizationId },
        'id tenant lookup returned a non-2xx status -- falling back to organizationId'
      );
      return null;
    }

    const body = (await response.json()) as IdTenantLookupResponse;
    // Contract shape is the flat {tenant_id, account_id}; the `data` unwrap is
    // the same ApiResponse-wrapped tolerance billing's clients use.
    const payload = body && typeof body === 'object' && body.data ? body.data : body;
    const tenantId =
      payload && typeof payload.tenant_id === 'string' ? payload.tenant_id.trim() : '';
    if (!tenantId) {
      log.warn(
        { organizationId },
        'id tenant lookup returned an unexpected response shape -- falling back to organizationId'
      );
      return null;
    }

    await persistMapping(organizationId, tenantId);
    return tenantId;
  } catch (error) {
    log.warn(
      { error, organizationId },
      'id tenant lookup request failed (network/timeout) -- falling back to organizationId'
    );
    return null;
  }
}

/**
 * The canonical billing tenant for a ci org, or `null` when it cannot be
 * determined (flag off, nothing cached, id unreachable/404). NEVER throws —
 * callers use `billableTenantId` unless they need to distinguish "resolved"
 * from "fell back".
 */
export async function resolveBillingTenantId(
  organizationId: string | undefined,
  userId?: string
): Promise<string | null> {
  if (!organizationId || !isBillingTenantMappingEnabled()) {
    return null;
  }

  // Layer 1: the durable write-through column.
  const fromDb = await readFromDb(organizationId);
  if (fromDb) return fromDb;

  // Layer 2: the ~24h positive cache.
  const fromCache = await readFromCache(positiveCacheKey(organizationId));
  if (fromCache) return fromCache;

  // Layer 3: the short negative cache (a known 404, not an outage).
  const negative = await readFromCache(negativeCacheKey(organizationId));
  if (negative) return null;

  // Layer 4: id. Needs the account_id — the ci User.id == id sub invariant.
  if (!userId) return null;
  return resolveViaId(organizationId, userId);
}

/**
 * THE entry point for billing call sites: the tenant id to address billing
 * with. Flag off, or any resolution failure, returns `organizationId`
 * unchanged — the exact pre-resolver behavior, so lighting this flag can
 * only ever change WHERE billing looks the tenant up, never WHETHER the
 * call happens.
 */
export async function billableTenantId(
  organizationId: string | undefined,
  userId?: string
): Promise<string> {
  if (!organizationId || !isBillingTenantMappingEnabled()) {
    return organizationId ?? '';
  }
  const resolved = await resolveBillingTenantId(organizationId, userId);
  return resolved ?? organizationId;
}

/** Test-only: clears the module-level token-provider singleton so a fresh
 * one (or none, if the secret is unset in the test) is built on next use. */
export function __resetBillingTenantResolverForTests(): void {
  tokenProvider = undefined;
}
