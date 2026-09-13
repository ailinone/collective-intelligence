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
 * Mesmo client_id/secret que id espera em CI_BILLING_CLIENT_OIDC_CLIENT_ID/
 * _SECRET (id/api/controllers/oidc_provider.py::_default_clients --
 * audience=ailin-billing, scope=billing:tenant-context), cacheado via o
 * provider OAuth2 compartilhado já usado pelos adapters de LLM
 * (providers/_shared/oauth2-client-credentials.ts -- cache até perto da
 * expiração, refresh automático, deduplica refreshes concorrentes). Mesma
 * política de cache/refresh que chat/backend/ailin_chat/utils/
 * ci_actor_token.py já prova em produção para o mesmo tipo de fluxo
 * (client_credentials, nunca lança para o caller).
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
import { createOAuth2ClientCredentialsProvider } from '@/providers/_shared/oauth2-client-credentials';
import type { TokenProvider } from '@/providers/_shared/token-provider';

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

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CACHE_TTL_SECONDS = envInt('BILLING_ENTITLEMENTS_CACHE_TTL_SECONDS', 300);
const FETCH_TIMEOUT_MS = envInt('BILLING_ENTITLEMENTS_TIMEOUT_MS', 3000);

// Mirrors the exact env var names id's oidc_provider.py::_default_clients
// reads for THIS SAME client registration (CI_BILLING_CLIENT_OIDC_CLIENT_ID/
// _SECRET) -- client_id/secret are a shared value between the two
// deployments, so reusing id's own env var names here (rather than inventing
// ci-specific ones) is deliberate: one secret, one pair of names, set once
// per environment on both sides.
function actorClientConfig() {
  return {
    tokenUrl: process.env.CI_BILLING_CLIENT_OIDC_TOKEN_URL?.trim() || 'https://ailin.id/oauth/token',
    clientId: process.env.CI_BILLING_CLIENT_OIDC_CLIENT_ID?.trim() || 'ailin-ci-billing-client',
    clientSecret: (process.env.CI_BILLING_CLIENT_OIDC_CLIENT_SECRET ?? '').trim(),
    // Only the FIRST configured audience/scope is used to request a token —
    // id's client registration may allow a comma-separated list for other
    // purposes, but a client_credentials request presents exactly one of each.
    audience: process.env.CI_BILLING_CLIENT_ALLOWED_AUDIENCES?.split(',')[0]?.trim() || 'ailin-billing',
    scope: process.env.CI_BILLING_CLIENT_ALLOWED_SCOPES?.split(',')[0]?.trim() || 'billing:tenant-context',
  };
}

let tokenProvider: TokenProvider | null | undefined; // undefined = not yet built this process

function getTokenProvider(): TokenProvider | null {
  if (tokenProvider !== undefined) {
    return tokenProvider;
  }

  const cfg = actorClientConfig();
  if (!cfg.clientSecret) {
    log.info(
      'CI_BILLING_CLIENT_OIDC_CLIENT_SECRET is not set -- billing calls will rely on the ' +
        'static Billing-Api-Secret-Key alone (billing accepts that in dual mode)'
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
      extraBodyParams: { audience: cfg.audience },
    });
  } catch (error) {
    log.warn({ error }, 'failed to construct the billing actor token provider');
    tokenProvider = null;
  }
  return tokenProvider;
}

/**
 * Bearer header for the outbound call, plus X-Acting-Tenant-Id (the
 * `service`-token tenant-assertion channel billing's verify_service_token
 * cross-checks against the route's own tenant_id — see that decorator's
 * docstring on the billing side). Never throws: any failure to mint a token
 * returns `{}`, which still lets the call proceed on the static secret alone
 * (billing's dual mode).
 */
async function getBillingActorHeaders(organizationId: string): Promise<Record<string, string>> {
  const provider = getTokenProvider();
  if (!provider) {
    return {};
  }
  try {
    const authHeader = await provider.buildAuthHeader();
    return { ...authHeader, 'X-Acting-Tenant-Id': organizationId };
  } catch (error) {
    log.warn(
      { error },
      'failed to mint a billing actor token -- falling back to the static secret only for this call'
    );
    return {};
  }
}

function cacheKey(organizationId: string): string {
  return `${CACHE_KEY_PREFIX}${organizationId}`;
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
  } catch (error) {
    // Not fatal — just means the next call re-fetches instead of hitting cache.
    log.warn({ error, organizationId }, 'billing entitlements Redis write failed');
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
      return null;
    }

    const body = (await response.json()) as { data?: unknown };
    const entitlements = parseEntitlements(organizationId, body.data);
    if (!entitlements) {
      log.warn(
        { organizationId },
        'billing entitlements resolve returned an unexpected response shape -- falling back to local tier config'
      );
      return null;
    }

    await writeToCache(organizationId, entitlements);
    return entitlements;
  } catch (error) {
    log.warn(
      { error, organizationId },
      'billing entitlements resolve request failed (network/timeout) -- falling back to local tier config'
    );
    return null;
  }
}

/** Test-only: clears the module-level token-provider singleton so a fresh
 * one (or none, if secrets are unset in the test) is built on next use. */
export function __resetBillingEntitlementsClientForTests(): void {
  tokenProvider = undefined;
}
