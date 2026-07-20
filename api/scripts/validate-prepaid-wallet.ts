// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Local validation for the prepaid-wallet core: the balance gate (402 / allow /
 * no-op-for-non-tiered), the debit, and the internal wallet endpoints
 * (topup w/ shared secret, balance w/ service token). Runs against the real
 * ci-postgres organization_balance table. Gate flag is forced ON for this run.
 *
 * Run: npx tsx scripts/validate-prepaid-wallet.ts
 */

process.env.DATABASE_URL = process.env.VALIDATE_DATABASE_URL ?? 'postgresql://ci_user:ci_password@localhost:5434/ci_db';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'local-validation-secret';
process.env.REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
process.env.REDIS_PORT = process.env.REDIS_PORT ?? '6379';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
process.env.PREPAID_WALLET_GATE_ENABLED = 'true';
process.env.WALLET_TOPUP_SECRET = 'test-wallet-topup-secret';
process.env.SERVICE_AUTH_ENABLED = 'true';
process.env.SERVICE_AUTH_ISSUER = 'https://validation.local';
process.env.SERVICE_AUTH_AUDIENCE = 'ailin-ci';
process.env.SERVICE_AUTH_ALLOWED_CLIENTS = 'ailin-dev-server';
process.env.SERVICE_AUTH_JWKS_URI = 'http://127.0.0.1:9/unused';
process.env.SKIP_PER_PLUGIN_DISCOVERY = 'true';
process.env.DEFER_CATALOG_LOAD = 'true';

import { generateKeyPairSync, type KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';
import Fastify from 'fastify';

const TEST_ORG = '12121212-3434-5656-7878-909090909090';
const SEED_USER = '22222222-2222-2222-2222-222222222222'; // org 11111111…
const SEED_ORG = '11111111-1111-1111-1111-111111111111';
const KID = 'validation-key-1';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function tieredReq(model: string) {
  return { model, messages: [{ role: 'user', content: 'hello world '.repeat(20) }], max_tokens: 256 } as never;
}

async function main(): Promise<void> {
  const gate = await import('@/services/prepaid-wallet-gate');
  const { prisma } = await import('@/database/client');

  // Clean any prior state for the test org.
  await prisma.$executeRawUnsafe(`DELETE FROM credit_transaction WHERE organization_id = $1`, TEST_ORG);
  await prisma.$executeRawUnsafe(`DELETE FROM organization_balance WHERE organization_id = $1`, TEST_ORG);

  check('gate flag enabled', gate.isWalletGateEnabled());

  // 1) gate DENIES a tiered request at $0 balance
  const d0 = await gate.gateChatRequest(TEST_ORG, tieredReq('consensus:large'));
  check('tiered + $0 balance → 402 denied', d0.allowed === false && d0.status === 402, `allowed=${d0.allowed} status=${d0.status}`);

  // 2) non-tiered model is a no-op (allowed) even at $0
  const dRaw = await gate.gateChatRequest(TEST_ORG, tieredReq('gpt-4o-mini'));
  check('non-tiered model → allowed (no-op)', dRaw.allowed === true);

  // 3) top-up → balance, then gate ALLOWS
  const bal1 = await gate.walletInstance().topUp(TEST_ORG, 10);
  check('topUp 10 → balance 10', Math.abs(bal1 - 10) < 1e-6, `balance=${bal1}`);
  const dOk = await gate.gateChatRequest(TEST_ORG, tieredReq('consensus:large'));
  check('tiered + funded → allowed', dOk.allowed === true);

  // 4) debit reduces balance
  await gate.debitChatRequest({ organizationId: TEST_ORG, request: tieredReq('consensus:large'), promptTokens: 1_000_000, completionTokens: 1_000_000, requestId: 'val-1' });
  const bal2 = await gate.walletInstance().getBalanceUsd(TEST_ORG);
  // consensus:large = $4 in + $20 out per 1M → debit $24 → but balance was 10 → goes negative (debit doesn't floor).
  check('debit applied (balance decreased by ~$24)', Math.abs(bal2 - (10 - 24)) < 1e-3, `balance=${bal2}`);

  // ── endpoints ──
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = (privateKey as KeyObject).export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwk = (publicKey as KeyObject).export({ format: 'jwk' }) as Record<string, unknown>;
  const verifier = await import('@/services/service-token-verifier');
  verifier.__primeJwksForTests([{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' } as never]);
  const token = jwt.sign(
    { iss: 'https://validation.local', aud: 'ailin-ci', sub: 'ailin-dev-server', client_id: 'ailin-dev-server', token_type: 'service', scope: 'apikeys:read:on_behalf' },
    privatePem,
    { algorithm: 'RS256', keyid: KID },
  );

  const { internalWalletRoutes } = await import('@/routes/internal/internal-wallet-routes');
  const app = Fastify({ logger: false });
  await app.register(internalWalletRoutes);
  await app.ready();

  // topup endpoint WITHOUT secret → 401
  const noSec = await app.inject({ method: 'POST', url: '/v1/internal/wallet/topup', headers: { 'content-type': 'application/json' }, payload: { organizationId: SEED_ORG, amountUsd: 5 } });
  check('topup endpoint without secret → 401', noSec.statusCode === 401, `status=${noSec.statusCode}`);

  // topup endpoint WITH secret → 200 (credit the seed org so the balance endpoint can read it)
  await prisma.$executeRawUnsafe(`DELETE FROM organization_balance WHERE organization_id = $1`, SEED_ORG);
  const topup = await app.inject({ method: 'POST', url: '/v1/internal/wallet/topup', headers: { 'content-type': 'application/json', 'x-wallet-topup-secret': 'test-wallet-topup-secret' }, payload: { organizationId: SEED_ORG, amountUsd: 7.5, reference: 'val-topup' } });
  const topupBody = topup.json() as { balanceUsd?: number };
  check('topup endpoint with secret → 200 balance 7.5', topup.statusCode === 200 && Math.abs((topupBody.balanceUsd ?? 0) - 7.5) < 1e-6, `status=${topup.statusCode} balance=${topupBody.balanceUsd}`);

  // balance endpoint (service token + x-acting-user → resolves seed user's org) → 7.5
  const balRes = await app.inject({ method: 'GET', url: '/v1/internal/wallet/balance', headers: { authorization: `Bearer ${token}`, 'x-acting-user': SEED_USER } });
  const balBody = balRes.json() as { balanceUsd?: number; gateEnabled?: boolean };
  check('balance endpoint → 200 balance 7.5', balRes.statusCode === 200 && Math.abs((balBody.balanceUsd ?? 0) - 7.5) < 1e-6, `status=${balRes.statusCode} balance=${balBody.balanceUsd}`);
  check('balance endpoint reports gateEnabled', balBody.gateEnabled === true);

  // cleanup
  for (const org of [TEST_ORG, SEED_ORG]) {
    await prisma.$executeRawUnsafe(`DELETE FROM credit_transaction WHERE organization_id = $1`, org);
    await prisma.$executeRawUnsafe(`DELETE FROM organization_balance WHERE organization_id = $1`, org);
  }
  await app.close();
  await prisma.$disconnect().catch(() => {});
  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('validation crashed:', err);
  process.exit(1);
});
