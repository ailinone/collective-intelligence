// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * billing-entitlements-client.ts
 *
 * Fase 5 do programa de hardening cross-repo (ver docs/audit da Fase
 * anterior): resolve os limites de entitlement REAIS de um tenant a partir
 * do billing (Plan/PlanFeature, já fail-closed desde a Fase 1 daquele repo)
 * via `GET /v1/plans/resolve` (billing/controllers/api/v1/entitlements.py),
 * autenticando como o client M2M dedicado `ailin-ci-billing-client`
 * (registrado em id/api/controllers/oidc_provider.py::_default_clients na
 * Fase 4 deste mesmo programa -- registrado então, mas sem nenhum caller
 * real até agora. Este módulo é esse caller).
 *
 * ## Duas categorias de falha, duas filosofias DIFERENTES neste programa
 *
 * 1. Falha de CONFIGURAÇÃO/DADO *dentro* do billing (tenant sem
 *    Subscription, plano sem PlanFeature para um recurso): billing já
 *    resolve isso fail-closed (Fase 1, services/usage_service.py) antes de
 *    responder -- cai para os limites do plano sandbox, nunca ilimitado. O
 *    corpo que chega aqui já reflete essa decisão; nada a fazer deste lado.
 * 2. Falha de REDE/DISPONIBILIDADE do serviço billing (fora do ar, erro,
 *    timeout, resposta malformada, credenciais M2M não configuradas): uma
 *    categoria DIFERENTE de falha, e deliberadamente NÃO fail-closed aqui --
 *    billing indisponível não pode travar a plataforma de orquestração de
 *    IA inteira. Esta é a exceção documentada à filosofia fail-closed usada
 *    no resto deste programa: lá, fail-closed é sobre DADO DE NEGÓCIO
 *    ausente; aqui é sobre DISPONIBILIDADE DE UM SERVIÇO EXTERNO pela rede,
 *    o que é uma categoria de falha ortogonal. Esta função NUNCA lança para
 *    o caller nesse caso -- retorna `null`, e o único caller hoje
 *    (api/src/config/multi-tenancy-config.ts::resolveEffectiveTierConfig)
 *    cai para TIER_CONFIGS hardcoded exatamente como fazia antes desta fase
 *    existir.
 *
 * ## Autenticação de saída (client_credentials contra id)
 *
 * Minting em services/billing-actor-token.ts (extraído de lá porque este
 * módulo deixou de ser o único caller real -- routes/internal/
 * internal-wallet-routes.ts's credit-checkout proxy agora usa o mesmo
 * helper, ver aquele módulo). Mesmo client_id/secret que id espera em
 * CI_BILLING_CLIENT_OIDC_CLIENT_ID/_SECRET (id/api/controllers/
 * oidc_provider.py::_default_clients -- audience=ailin-billing,
 * scope=billing:tenant-context), cacheado via o provider OAuth2
 * compartilhado já usado pelos adapters de LLM (providers/_shared/
 * oauth2-client-credentials.ts -- cache até perto da expiração, refresh
 * automático, deduplica refreshes concorrentes). Mesma política de
 * cache/refresh que chat/backend/ailin_chat/utils/ci_actor_token.py já prova
 * em produção para o mesmo tipo de fluxo (client_credentials, nunca lança
 * para o caller).
 *
 * O token é uma camada ADICIONAL (Fase 4, modo dual do lado de billing):
 * billing aceita a chamada com só o secret estático (BILLING_API_SECRET_KEY,
 * já usado por ci hoje em routes/internal/internal-wallet-routes.ts) quando
 * o token não pode ser obtido -- então credenciais M2M ausentes/id fora do
 * ar NUNCA é, por si só, motivo para desistir da chamada a billing.
 *
 * ## Cache
 *
 * Redis (cliente global/distribuído -- api/src/cache/redis-client.ts,
 * mesma escolha de free-tier-quota-gate.ts para estado cross-instância),
 * TTL configurável via BILLING_ENTITLEMENTS_CACHE_TTL_SECONDS (default
 * 300s). Uma segunda chamada para o mesmo tenant dentro do TTL nunca bate
 * na rede nem em billing.
 */

import { getGlobalRedisClient } from '@/cache/redis-client';
import { logger } from '@/utils/logger';
import { noteFailOpen } from '@/utils/metrics';
import {
  getBillingActorHeaders,
  __resetBillingActorTokenForTests,
} from '@/services/billing-actor-token';

const log = logger.child({ component: 'billing-entitlements-client' });

/** The resource_types billing's entitlement-resolve endpoint returns today
 * (services/usage_service.py::ENTITLEMENT_RESOURCE_TYPES on the billing
 * side) -- kept loose (Record) here rather than a closed union so a new
 * resource_type billing starts returning shows up without ci needing a
 * matching code change to read it. */
export interface BillingEntitlements {
  tenantId: string;
  planId: string;
  /** "subscription" when the tenant has a real Subscription row in billing,
   * "fallback_sandbox" when billing itself fell back to the sandbox plan's
   * limits (no Subscription found) -- mirrors UsageService.resolve_tenant_entitlements. */
  source: 'subscription' | 'fallback_sandbox';
  limits: Record<string, number | null>;
}

const CACHE_KEY_PREFIX = 'billing:entitlements:';
/**
 * Secondary STALE cache key prefix (A3, strategy-target-policy.ts): every
 * successful resolve is ALSO written here with a much longer TTL, so the
 * target-policy gate can decide on the last-known planId during a billing
 * outage instead of falling to the availability defaults. See
 * `readStaleFromCache`/`resolveTenantEntitlements` below — the primary
 * `getTenantEntitlements` path and its existing caller
 * (multi-tenancy-config.ts::resolveEffectiveTierConfig) keep their EXACT
 * current behavior (they never read this key).
 */
const STALE_CACHE_KEY_PREFIX = 'billing:entitlements:stale:';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CACHE_TTL_SECONDS = envInt('BILLING_ENTITLEMENTS_CACHE_TTL_SECONDS', 300);
/** Stale-read window (A3 §5): `BILLING_ENTITLEMENTS_STALE_TTL_SECONDS`, default 24 h. */
const STALE_TTL_SECONDS = envInt('BILLING_ENTITLEMENTS_STALE_TTL_SECONDS', 86_400);
const FETCH_TIMEOUT_MS = envInt('BILLING_ENTITLEMENTS_TIMEOUT_MS', 3000);

function cacheKey(organizationId: string): string {
  return `${CACHE_KEY_PREFIX}${organizationId}`;
}

function staleCacheKey(organizationId: string): string {
  return `${STALE_CACHE_KEY_PREFIX}${organizationId}`;
}

async function readFromCache(organizationId: string): Promise<BillingEntitlements | null> {
  try {
    const redis = getGlobalRedisClient();
    const cached = await redis.get(cacheKey(organizationId));
    if (!cached) return null;
    return JSON.parse(cached) as BillingEntitlements;
  } catch (error) {
    log.warn({ error, organizationId }, 'billing entitlements Redis read failed -- treating as a cache miss');
    return null;
  }
}

async function writeToCache(organizationId: string, entitlements: BillingEntitlements): Promise<void> {
  try {
    const redis = getGlobalRedisClient();
    await redis.setex(cacheKey(organizationId), CACHE_TTL_SECONDS, JSON.stringify(entitlements));
    // ONE write, two keys: also refresh the long-TTL stale copy (A3 §5). A
    // failure of the stale write alone must not fail the primary write path —
    // it only means the next outage decides on an older snapshot or on the
    // availability defaults.
    try {
      await redis.setex(staleCacheKey(organizationId), STALE_TTL_SECONDS, JSON.stringify(entitlements));
    } catch (staleError) {
      log.warn(
        { error: staleError, organizationId },
        'billing entitlements STALE Redis write failed (primary cache unaffected)'
      );
    }
  } catch (error) {
    // Not fatal — just means the next call re-fetches instead of hitting cache.
    log.warn({ error, organizationId }, 'billing entitlements Redis write failed');
  }
}

/** The long-TTL last-known-good copy, read ONLY by `resolveTenantEntitlements`
 * on a primary miss with billing unreachable — never by the primary path. */
async function readStaleFromCache(organizationId: string): Promise<BillingEntitlements | null> {
  try {
    const redis = getGlobalRedisClient();
    const cached = await redis.get(staleCacheKey(organizationId));
    if (!cached) return null;
    return JSON.parse(cached) as BillingEntitlements;
  } catch (error) {
    log.warn(
      { error, organizationId },
      'billing entitlements stale Redis read failed -- treating as a stale miss'
    );
    return null;
  }
}

function parseEntitlements(organizationId: string, data: unknown): BillingEntitlements | null {
  if (!data || typeof data !== 'object') return null;
  const v = data as Record<string, unknown>;

  if (typeof v.plan_id !== 'string' || !v.limits || typeof v.limits !== 'object') {
    return null;
  }

  const rawLimits = v.limits as Record<string, unknown>;
  const limits: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(rawLimits)) {
    if (value === null) {
      limits[key] = null;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      limits[key] = value;
    }
    // Anything else (a string, an object) is dropped rather than trusted —
    // an unexpected shape for one key shouldn't poison the whole response.
  }

  return {
    tenantId: organizationId,
    planId: v.plan_id,
    source: v.source === 'subscription' ? 'subscription' : 'fallback_sandbox',
    limits,
  };
}

/**
 * Resolves a tenant's real billing entitlements, or `null` when billing is
 * unavailable for ANY reason (not configured, unreachable, non-2xx, timeout,
 * unexpected response shape). Never throws — see the module doc comment for
 * why that is a deliberate, different fail mode than the rest of this
 * program's fail-closed defaults.
 */
export async function getTenantEntitlements(organizationId: string): Promise<BillingEntitlements | null> {
  if (!organizationId) {
    return null;
  }

  const cached = await readFromCache(organizationId);
  if (cached) {
    return cached;
  }

  const billingUrl = (process.env.BILLING_SERVICE_URL ?? '').replace(/\/+$/, '');
  const billingSecret = process.env.BILLING_API_SECRET_KEY ?? '';
  if (!billingUrl || !billingSecret) {
    // Network-unavailability category (here: "not configured at all"), not a
    // billing-side data problem — the caller falls back to TIER_CONFIGS.
    // FIX (A3 census, ENT-001): this was the module's only SILENT degradation
    // path — every other failure mode here logs; a missing-credentials
    // permanent fail-open was invisible in production. Same level as the
    // other fallbacks (warn): it is an availability event, not an error.
    log.warn(
      { organizationId },
      'billing entitlements resolve skipped: BILLING_SERVICE_URL/BILLING_API_SECRET_KEY not configured -- permanently failing open to local tier config'
    );
    return null;
  }

  const actorHeaders = await getBillingActorHeaders(organizationId);

  try {
    const response = await fetch(
      `${billingUrl}/v1/plans/resolve?tenant_id=${encodeURIComponent(organizationId)}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'billing-api-secret-key': billingSecret,
          ...actorHeaders,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      log.warn(
        { status: response.status, organizationId },
        'billing entitlements resolve returned a non-2xx status -- falling back to local tier config'
      );
      noteFailOpen('billing_entitlements_non_2xx', { organizationId, status: response.status });
      return null;
    }

    const body = (await response.json()) as { data?: unknown };
    const entitlements = parseEntitlements(organizationId, body.data);
    if (!entitlements) {
      log.warn(
        { organizationId },
        'billing entitlements resolve returned an unexpected response shape -- falling back to local tier config'
      );
      noteFailOpen('billing_entitlements_bad_shape', { organizationId });
      return null;
    }

    await writeToCache(organizationId, entitlements);
    return entitlements;
  } catch (error) {
    log.warn(
      { error, organizationId },
      'billing entitlements resolve request failed (network/timeout) -- falling back to local tier config'
    );
    noteFailOpen('billing_entitlements_network', { organizationId });
    return null;
  }
}

/**
 * HOW a decision was reached — `basis` distinguishes the three situations the
 * A3 failure-mode table (a3-deny-matrix-design.md §4) needs apart:
 *   - `fresh`: live billing resolve (or a primary-cache hit within its TTL);
 *   - `stale`: billing unreachable, but a last-known-good snapshot survived in
 *     the long-TTL stale key — good enough to key a matrix decision on;
 *   - `unavailable`: billing unreachable AND no stale copy — the caller (the
 *     target policy) applies its per-risk-class availability default.
 */
export type EntitlementsBasis = 'fresh' | 'stale' | 'unavailable';

export interface TenantEntitlementsResolution {
  entitlements: BillingEntitlements | null;
  basis: EntitlementsBasis;
}

/**
 * Entitlements WITH an availability verdict, for policy callers that must
 * distinguish "billing said" from "we remembered what billing last said" from
 * "we have no idea". The primary `getTenantEntitlements` stays unchanged for
 * its existing caller; this wrapper composes it with the stale read so there
 * is exactly ONE fetch path (A3 §5: one write, no new fetch path).
 *
 * Never throws, like everything else in this module.
 */
export async function resolveTenantEntitlements(
  organizationId: string
): Promise<TenantEntitlementsResolution> {
  if (!organizationId) {
    return { entitlements: null, basis: 'unavailable' };
  }

  const cached = await readFromCache(organizationId);
  if (cached) {
    return { entitlements: cached, basis: 'fresh' };
  }

  // Re-runs the (cheap, cache-miss) primary path — including its side effects:
  // on success `writeToCache` has already refreshed BOTH cache keys.
  const entitlements = await getTenantEntitlements(organizationId);
  if (entitlements) {
    return { entitlements, basis: 'fresh' };
  }

  const stale = await readStaleFromCache(organizationId);
  if (stale) {
    return { entitlements: stale, basis: 'stale' };
  }
  return { entitlements: null, basis: 'unavailable' };
}

/** Test-only: clears the shared actor-token provider's module-level
 * singleton (services/billing-actor-token.ts) so a fresh one (or none, if
 * secrets are unset in the test) is built on next use. */
export function __resetBillingEntitlementsClientForTests(): void {
  __resetBillingActorTokenForTests();
}
