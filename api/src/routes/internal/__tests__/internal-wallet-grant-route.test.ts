// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Route-level tests for POST /v1/internal/wallet/grant (internal-wallet-routes.ts).
 *
 * The wallet-side logic (allocation, sweep, idempotency) is covered in
 * prepaid-wallet.test.ts; this suite pins the ROUTE contract the billing
 * campaign engine relies on:
 *   - shared-secret auth (X-Wallet-Topup-Secret), same guard as top-up
 *   - strict body validation: uuid organizationId, positive amountUsd,
 *     grantId charset/length (it becomes a wallet_grants PK and a ledger
 *     idempotency key — never a free-form string), future expiresAtMs
 *   - 200 shape {organizationId, grantId, balanceUsd, applied}
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

const grantMock = vi.fn();
const reverseGrantMock = vi.fn();
vi.mock('@/services/prepaid-wallet-gate', () => ({
  walletInstance: () => ({ grant: grantMock, reverseGrant: reverseGrantMock }),
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

async function postGrant(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  secret: string | null = SECRET
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) headers['x-wallet-topup-secret'] = secret;
  return app.inject({ method: 'POST', url: '/v1/internal/wallet/grant', payload, headers });
}

beforeEach(() => {
  process.env.WALLET_TOPUP_SECRET = SECRET;
  grantMock.mockReset();
  reverseGrantMock.mockReset();
});

afterEach(() => {
  delete process.env.WALLET_TOPUP_SECRET;
});

describe('POST /v1/internal/wallet/grant', () => {
  const validPayload = {
    organizationId: ORG,
    amountUsd: 5,
    grantId: 'campaign:11111111-1111-4111-8111-111111111111',
    expiresAtMs: Date.now() + 86_400_000,
  };

  it('rejects a missing or wrong shared secret with 401', async () => {
    const app = await buildApp();
    expect((await postGrant(app, validPayload, null)).statusCode).toBe(401);
    expect((await postGrant(app, validPayload, 'wrong-secret')).statusCode).toBe(401);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid organizationId with 400', async () => {
    const app = await buildApp();
    const res = await postGrant(app, { ...validPayload, organizationId: 'not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive amount with 400', async () => {
    const app = await buildApp();
    expect((await postGrant(app, { ...validPayload, amountUsd: 0 })).statusCode).toBe(400);
    expect((await postGrant(app, { ...validPayload, amountUsd: -5 })).statusCode).toBe(400);
    expect((await postGrant(app, { ...validPayload, amountUsd: 'five' })).statusCode).toBe(400);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('rejects a grantId outside the allowlisted charset with 400', async () => {
    const app = await buildApp();
    // The id becomes a wallet_grants PK + ledger idempotency key: whitespace,
    // quotes and unicode must never reach either.
    expect((await postGrant(app, { ...validPayload, grantId: 'has space' })).statusCode).toBe(400);
    expect((await postGrant(app, { ...validPayload, grantId: "o'brien" })).statusCode).toBe(400);
    expect((await postGrant(app, { ...validPayload, grantId: '' })).statusCode).toBe(400);
    expect(
      (await postGrant(app, { ...validPayload, grantId: 'x'.repeat(129) })).statusCode
    ).toBe(400);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('rejects a past expiry with 400 (never grant-and-immediately-reclaim)', async () => {
    const app = await buildApp();
    const res = await postGrant(app, { ...validPayload, expiresAtMs: Date.now() - 1000 });
    expect(res.statusCode).toBe(400);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('applies a valid grant and returns the wallet result', async () => {
    const app = await buildApp();
    grantMock.mockResolvedValueOnce({ balanceUsd: 5, applied: true });

    const res = await postGrant(app, validPayload);
    expect(res.statusCode).toBe(200);
    expect(grantMock).toHaveBeenCalledWith(ORG, validPayload.grantId, 5, validPayload.expiresAtMs);

    const body = res.json();
    expect(body).toEqual({
      organizationId: ORG,
      grantId: validPayload.grantId,
      balanceUsd: 5,
      applied: true,
    });
  });

  it('returns 503 (never 200) when the wallet layer throws', async () => {
    const app = await buildApp();
    grantMock.mockRejectedValueOnce(new Error('db down'));

    const res = await postGrant(app, validPayload);
    expect(res.statusCode).toBe(503);
  });
});

describe('POST /v1/internal/wallet/grant/reverse', () => {
  async function postReverse(app: FastifyInstance, payload: Record<string, unknown>, secret = SECRET) {
    return app.inject({
      method: 'POST',
      url: '/v1/internal/wallet/grant/reverse',
      payload,
      headers: { 'content-type': 'application/json', 'x-wallet-topup-secret': secret },
    });
  }

  it('rejects a missing/wrong secret with 401', async () => {
    const app = await buildApp();
    expect((await postReverse(app, { grantId: 'campaign:abc' }, 'wrong')).statusCode).toBe(401);
    expect(reverseGrantMock).not.toHaveBeenCalled();
  });

  it('rejects a grantId outside the allowlisted charset with 400', async () => {
    const app = await buildApp();
    expect((await postReverse(app, { grantId: 'has space' })).statusCode).toBe(400);
    expect((await postReverse(app, {})).statusCode).toBe(400);
    expect(reverseGrantMock).not.toHaveBeenCalled();
  });

  it('applies the reversal via the wallet and returns its result', async () => {
    const app = await buildApp();
    reverseGrantMock.mockResolvedValueOnce({ status: 'reversed', reversedUsd: 3 });

    const res = await postReverse(app, { grantId: 'campaign:abc-123' });
    expect(res.statusCode).toBe(200);
    expect(reverseGrantMock).toHaveBeenCalledWith('campaign:abc-123');
    expect(res.json()).toEqual({ grantId: 'campaign:abc-123', status: 'reversed', reversedUsd: 3 });
  });

  it('returns 503 (never 200) when the wallet layer throws', async () => {
    const app = await buildApp();
    reverseGrantMock.mockRejectedValueOnce(new Error('db down'));
    const res = await postReverse(app, { grantId: 'campaign:abc-123' });
    expect(res.statusCode).toBe(503);
  });
});
