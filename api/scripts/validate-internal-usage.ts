// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Local validation for GET /v1/internal/usage — exercises the route via Fastify
 * inject against the real ci-postgres RequestLog data, with a local-keypair
 * service token (same shape id mints). Run: npx tsx scripts/validate-internal-usage.ts
 */

process.env.DATABASE_URL = process.env.VALIDATE_DATABASE_URL ?? 'postgresql://ci_user:ci_password@localhost:5434/ci_db';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'local-validation-secret';
process.env.REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
process.env.REDIS_PORT = process.env.REDIS_PORT ?? '6379';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
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

const ACTING_USER = '22222222-2222-2222-2222-222222222222'; // seed user w/ 82 request_logs
const KID = 'validation-key-1';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = (privateKey as KeyObject).export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwk = (publicKey as KeyObject).export({ format: 'jwk' }) as Record<string, unknown>;

  const verifier = await import('@/services/service-token-verifier');
  verifier.__primeJwksForTests([{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' } as never]);

  const token = jwt.sign(
    {
      iss: 'https://validation.local',
      aud: 'ailin-ci',
      sub: 'ailin-dev-server',
      client_id: 'ailin-dev-server',
      token_type: 'service',
      scope: 'apikeys:read:on_behalf',
    },
    privatePem,
    { algorithm: 'RS256', keyid: KID },
  );

  const { internalUsageRoutes } = await import('@/routes/internal/internal-usage-routes');
  const app = Fastify({ logger: false });
  await app.register(internalUsageRoutes);
  await app.ready();

  // Wide range to capture the test org's May logs (endpoint clamps to 92d).
  const res = await app.inject({
    method: 'GET',
    url: '/v1/internal/usage?start=2026-05-01T00:00:00.000Z&end=2026-06-20T23:59:59.000Z',
    headers: { authorization: `Bearer ${token}`, 'x-acting-user': ACTING_USER },
  });
  const body = res.json() as {
    totals?: { requests: number; totalTokens: number; costUsd: number };
    byDay?: unknown[];
    byModel?: unknown[];
  };
  check('GET usage → 200', res.statusCode === 200, `status=${res.statusCode}`);
  check('totals.requests > 0', (body.totals?.requests ?? 0) > 0, `requests=${body.totals?.requests}`);
  check('totals.costUsd > 0', (body.totals?.costUsd ?? 0) > 0, `costUsd=${body.totals?.costUsd}`);
  check('totals.totalTokens > 0', (body.totals?.totalTokens ?? 0) > 0, `tokens=${body.totals?.totalTokens}`);
  check('byDay non-empty', Array.isArray(body.byDay) && body.byDay.length > 0, `days=${body.byDay?.length}`);
  check('byModel non-empty', Array.isArray(body.byModel) && body.byModel.length > 0, `models=${body.byModel?.length}`);

  // negatives
  const noTok = await app.inject({ method: 'GET', url: '/v1/internal/usage', headers: { 'x-acting-user': ACTING_USER } });
  check('no token → 401', noTok.statusCode === 401, `status=${noTok.statusCode}`);
  const noUser = await app.inject({ method: 'GET', url: '/v1/internal/usage', headers: { authorization: `Bearer ${token}` } });
  check('missing X-Acting-User → 400', noUser.statusCode === 400, `status=${noUser.statusCode}`);

  await app.close();
  const { prisma } = await import('@/database/client');
  await prisma.$disconnect().catch(() => {});
  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('validation crashed:', err);
  process.exit(1);
});
