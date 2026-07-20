// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Internal prepaid-wallet routes.
 *
 *   GET  /v1/internal/wallet/balance — the acting user's org balance (for the
 *        dev portal). Auth: service token + X-Acting-User (same as usage/api-keys).
 *
 *   POST /v1/internal/wallet/topup — credit an org's wallet. Called by the billing
 *        service after a successful Stripe credit purchase. Auth: a shared secret
 *        (X-Wallet-Topup-Secret == WALLET_TOPUP_SECRET) — a SYSTEM operation, not
 *        on-behalf-of a user, so the org comes from the body (== id tenant_id).
 *
 * Both live under /v1/internal/* (exempted from the global user-auth + rate-limit
 * hooks; secured here at the route level).
 *
 * SEC-01 authorization note: these are SYSTEM (machine-to-machine) routes that do
 * NOT carry a JWT principal — they never populate `request.user` / `userId` /
 * `organizationId`. They are therefore deliberately NOT gated with the JWT-based
 * RBAC `requirePermission` middleware (which resolves a user principal and would
 * 401 every legitimate caller here, locking out the billing service and the
 * portal BFF). Their deny-by-default authorization is instead the service-token
 * scope check (`requireServiceAuth(scope)`) and the shared-secret guard
 * (`requireTopupSecret`) applied as preHandlers below — the correct trust
 * boundary for the M2M surface. The billing-route-authz coverage test recognizes
 * these guards so a future ungated mutating internal route still fails CI.
 */

import { timingSafeEqual } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FastifyInstance } from 'fastify';
import { logger } from '@/utils/logger';
import {
  requireServiceAuth,
  type ServiceAuthedRequest,
} from '@/api/middleware/internal-service-auth-middleware';
import { resolveOrProvisionActingUser } from '@/services/internal-acting-user';
import { walletInstance, isWalletGateEnabled } from '@/services/prepaid-wallet-gate';

const log = logger.child({ component: 'internal-wallet-routes' });
const SCOPE_READ = 'apikeys:read:on_behalf';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secretsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Shared-secret guard for the system top-up endpoint (billing → ci). */
async function requireTopupSecret(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = process.env.WALLET_TOPUP_SECRET ?? '';
  const presented = request.headers['x-wallet-topup-secret'];
  const got = typeof presented === 'string' ? presented : '';
  if (!expected || !got || !secretsMatch(got, expected)) {
    await reply.code(401).send({ error: 'unauthorized', message: 'invalid wallet top-up secret' });
  }
}

export async function internalWalletRoutes(server: FastifyInstance): Promise<void> {
  /** GET balance — for the portal (acting user → org). */
  server.get(
    '/v1/internal/wallet/balance',
    { preHandler: [requireServiceAuth(SCOPE_READ)] },
    async (request, reply) => {
      const user = await resolveOrProvisionActingUser((request as ServiceAuthedRequest).serviceAuth!);
      if (!user) {
        return reply.code(409).send({
          error: 'acting_user_not_provisioned',
          message: 'The acting user does not exist in ci yet.',
        });
      }
      let balanceUsd = 0;
      try {
        balanceUsd = await walletInstance().getBalanceUsd(user.organizationId);
      } catch (error) {
        log.error({ error, organizationId: user.organizationId }, 'wallet balance read failed');
        return reply.code(503).send({ error: 'wallet_unavailable', message: 'Could not read balance.' });
      }
      return reply.send({
        organizationId: user.organizationId,
        balanceUsd,
        gateEnabled: isWalletGateEnabled(),
      });
    },
  );

  /** POST top-up — system credit grant (billing → ci) after a Stripe credit purchase. */
  server.post(
    '/v1/internal/wallet/topup',
    { preHandler: [requireTopupSecret] },
    async (request, reply) => {
      const body = (request.body ?? {}) as { organizationId?: unknown; amountUsd?: unknown; reference?: unknown };
      const organizationId = typeof body.organizationId === 'string' ? body.organizationId : '';
      const amountUsd = typeof body.amountUsd === 'number' ? body.amountUsd : Number(body.amountUsd);
      const reference = typeof body.reference === 'string' ? body.reference : undefined;

      if (!organizationId || !UUID_RE.test(organizationId)) {
        return reply.code(400).send({ error: 'bad_request', message: 'organizationId (uuid) is required' });
      }
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
        return reply.code(400).send({ error: 'bad_request', message: 'amountUsd must be a positive number' });
      }

      try {
        const balanceUsd = await walletInstance().topUp(organizationId, amountUsd, reference);
        log.info({ organizationId, amountUsd, reference, balanceUsd }, 'wallet topped up');
        return reply.send({ organizationId, balanceUsd });
      } catch (error) {
        log.error({ error, organizationId, amountUsd }, 'wallet top-up failed');
        return reply.code(503).send({ error: 'wallet_unavailable', message: 'Could not apply top-up.' });
      }
    },
  );

  /**
   * POST /v1/internal/billing/checkout-credits — start a Stripe credit purchase
   * for the acting user's org. ci is the integration hub (it knows the org from
   * X-Acting-User), so the portal BFF only ever talks to ci-internal. Proxies to
   * the billing service's producer; on payment, billing's webhook mirrors the
   * credit into this org's wallet (POST /v1/internal/wallet/topup).
   */
  server.post(
    '/v1/internal/billing/checkout-credits',
    { preHandler: [requireServiceAuth('apikeys:write:on_behalf')] },
    async (request, reply) => {
      const user = await resolveOrProvisionActingUser((request as ServiceAuthedRequest).serviceAuth!);
      if (!user) {
        return reply.code(409).send({ error: 'acting_user_not_provisioned', message: 'The acting user does not exist in ci yet.' });
      }

      const body = (request.body ?? {}) as { amountUsd?: unknown; successUrl?: unknown; cancelUrl?: unknown };
      const amountUsd = typeof body.amountUsd === 'number' ? body.amountUsd : Number(body.amountUsd);
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
        return reply.code(400).send({ error: 'bad_request', message: 'amountUsd must be a positive number' });
      }

      const billingUrl = (process.env.BILLING_SERVICE_URL ?? '').replace(/\/+$/, '');
      const billingSecret = process.env.BILLING_API_SECRET_KEY ?? '';
      if (!billingUrl || !billingSecret) {
        return reply.code(503).send({ error: 'billing_not_configured', message: 'Credit purchase is not available (billing not configured).' });
      }

      try {
        const res = await fetch(`${billingUrl}/v1/billing/checkout/credits`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'billing-api-secret-key': billingSecret,
            'x-tenant-id': user.organizationId,
          },
          body: JSON.stringify({
            amount_usd: amountUsd,
            customer_email: user.email,
            ...(typeof body.successUrl === 'string' ? { success_url: body.successUrl } : {}),
            ...(typeof body.cancelUrl === 'string' ? { cancel_url: body.cancelUrl } : {}),
          }),
          signal: AbortSignal.timeout(12_000),
        });
        const text = await res.text();
        const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        if (!res.ok) {
          return reply.code(res.status).send(data);
        }
        // billing wraps via ApiResponse.success — accept {url} or {data:{url}}.
        const inner = (data.data ?? data) as { url?: string; session_id?: string };
        return reply.send({ url: inner.url, sessionId: inner.session_id });
      } catch (error) {
        log.error({ error, organizationId: user.organizationId }, 'billing checkout proxy failed');
        return reply.code(502).send({ error: 'billing_unreachable', message: 'Could not reach the billing service.' });
      }
    },
  );
}
