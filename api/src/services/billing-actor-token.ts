// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * billing-actor-token.ts
 *
 * Shared minting of the Fase 4 signed service-token channel for ci -> billing
 * calls (see billing-entitlements-client.ts's original module doc for the
 * full design: client_credentials against `id` as the `ailin-ci-billing-client`
 * M2M client, audience=ailin-billing, scope=billing:tenant-context; billing's
 * `verify_service_token` cross-checks the resulting `X-Acting-Tenant-Id`
 * against the route's own tenant_id, in ADDITIVE dual mode alongside the
 * static `Billing-Api-Secret-Key`).
 *
 * Extracted out of billing-entitlements-client.ts (its sole caller until now)
 * so a SECOND real ci -> billing caller (routes/internal/internal-wallet-routes.ts's
 * credit-checkout proxy) mints the exact same token the exact same way,
 * sharing the same cached OAuth2 client_credentials provider/token instead of
 * each hand-rolling and separately refreshing its own copy — it is the same
 * M2M identity for the same destination either way.
 */

import { logger } from '@/utils/logger';
import { createOAuth2ClientCredentialsProvider } from '@/providers/_shared/oauth2-client-credentials';
import type { TokenProvider } from '@/providers/_shared/token-provider';

const log = logger.child({ component: 'billing-actor-token' });

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

function getBillingTokenProvider(): TokenProvider | null {
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
 * cross-checks against the route's own tenant_id — see this module's doc
 * comment). Never throws: any failure to mint a token returns `{}`, which
 * still lets the call proceed on the static secret alone (billing's dual
 * mode) — minting must never be a new way for a billing call to fail.
 */
export async function getBillingActorHeaders(organizationId: string): Promise<Record<string, string>> {
  const provider = getBillingTokenProvider();
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

/** Test-only: clears the module-level token-provider singleton so a fresh
 * one (or none, if secrets are unset in the test) is built on next use. */
export function __resetBillingActorTokenForTests(): void {
  tokenProvider = undefined;
}
