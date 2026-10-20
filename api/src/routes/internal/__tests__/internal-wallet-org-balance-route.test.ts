// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Route-level tests for GET /v1/internal/wallet/org-balance
 * (internal-wallet-routes.ts).
 *
 * This is the READ side of the wallet-debit mirror loop: billing's daily
 * reconciliation task (billing repo, tasks/reconciliation.py) calls it to
 * audit the convergence wallet(ci) -> Credit(billing). The mirror itself is
 * fire-and-forget; when billing is down past the ci-side retry ladder, this
 * endpoint is what makes the accounting gap visible instead of silently
 * permanent. Pins the ROUTE contract that task relies on:
 *   - shared-secret auth (X-Wallet-Topup-Secret), same guard as top-up/grant
 *     (read-only system surface: the secret is sufficient authorization)
 *   - strict query validation: uuid organizationId only
 *   - 200 shape {organizationId, balanceUsd} — balanceUsd is a number
 *   - 503 (never 200) when the wallet layer throws
 *
 * Hermetic: prepaid-wallet-gate is stubbed; no DB/network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('@/api/middleware/internal-service-auth-middleware', () => ({
  requireServiceAuth: () => async () => {},
}));

vi.mock('@/services/internal-acting-user', () => ({
  resolveOrProvisionActingUser: vi.fn(async () => null),
}));

const getBalanceUsdMock = vi.fn();
vi.mock('@/services/prepaid-wallet-gate', () => ({
  walletInstance: () => ({ getBalanceUsd: getBalanceUsdMock }),
  isWalletGateEnabled: () => true,
}));

import { internalWalletRoutes } from '@/routes/internal/internal-wallet-routes';

const SECRET = 'test-topup-secret';
const ORG = '123e4567-e89b-42d3-a456-426614174000';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await internalWalletRoutes(app);
  await app.ready();
  return app;
}

async function getOrgBalance(
  app: FastifyInstance,
  organizationId: string | null,
  secret: string | null = SECRET
) {
  const headers: Record<string, string> = {};
  if (secret) headers['x-wallet-topup-secret'] = secret;
  const url =
    organizationId === null
      ? '/v1/internal/wallet/org-balance'
      : `/v1/internal/wallet/org-balance?organizationId=${encodeURIComponent(organizationId)}`;
  return app.inject({ method: 'GET', url, headers });
}

beforeEach(() => {
  process.env.WALLET_TOPUP_SECRET = SECRET;
  getBalanceUsdMock.mockReset();
});

afterEach(() => {
  delete process.env.WALLET_TOPUP_SECRET;
});

describe('GET /v1/internal/wallet/org-balance', () => {
  it('rejects a missing or wrong shared secret with 401', async () => {
    const app = await buildApp();
    expect((await getOrgBalance(app, ORG, null)).statusCode).toBe(401);
    expect((await getOrgBalance(app, ORG, 'wrong-secret')).statusCode).toBe(401);
    expect(getBalanceUsdMock).not.toHaveBeenCalled();
  });

  it('rejects a missing or non-uuid organizationId with 400', async () => {
    const app = await buildApp();
    expect((await getOrgBalance(app, null)).statusCode).toBe(400);
    expect((await getOrgBalance(app, 'not-a-uuid')).statusCode).toBe(400);
    expect((await getOrgBalance(app, "'; drop table wallets;--")).statusCode).toBe(400);
    expect(getBalanceUsdMock).not.toHaveBeenCalled();
  });

  it('returns {organizationId, balanceUsd} for a valid org', async () => {
    getBalanceUsdMock.mockResolvedValueOnce(42.5);
    const app = await buildApp();
    const res = await getOrgBalance(app, ORG);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ organizationId: ORG, balanceUsd: 42.5 });
    expect(getBalanceUsdMock).toHaveBeenCalledWith(ORG);
  });

  it('answers 503 (never 200) when the wallet layer throws', async () => {
    getBalanceUsdMock.mockRejectedValueOnce(new Error('relation "organization_balance" does not exist'));
    const app = await buildApp();
    const res = await getOrgBalance(app, ORG);

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('wallet_unavailable');
  });
});
