// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Local end-to-end validation for the /v1/internal/api-keys contract.
 *
 * Proves the ci side of the SOTA design without needing id to mint a real
 * token (id's JWKS is already proven live; the only real-chain gap is an
 * unset dev-server client secret — an operator config item). Here we mint a
 * service token with a local RSA keypair (exactly the shape id emits), prime
 * the verifier's JWKS cache with the matching public key, and:
 *
 *   1. POST   /v1/internal/api-keys   → expect 201 + ak_ plainKey
 *   2. GET    /v1/internal/api-keys   → expect the new key listed
 *   3. call the LIVE ci-api (:3002) with the ak_ key → expect auth to PASS
 *      (401 without key → non-401 with key)
 *   4. DELETE /v1/internal/api-keys/:id → expect 204
 *   5. negative checks: missing scope → 403, missing X-Acting-User → 400
 *
 * Run: npx tsx scripts/validate-internal-api-keys.ts
 */

// ── env MUST be set before any @/ module (which imports @/config) loads ──
process.env.DATABASE_URL = process.env.VALIDATE_DATABASE_URL ?? 'postgresql://ci_user:ci_password@localhost:5434/ci_db';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'local-validation-secret';
process.env.REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
process.env.REDIS_PORT = process.env.REDIS_PORT ?? '6379';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
process.env.SERVICE_AUTH_ENABLED = 'true';
// Overridable so the script can run in REAL-id mode (verify against the live
// id JWKS) or local-keypair mode (primed cache). Defaults suit keypair mode.
process.env.SERVICE_AUTH_ISSUER = process.env.SERVICE_AUTH_ISSUER ?? 'https://validation.local';
process.env.SERVICE_AUTH_AUDIENCE = process.env.SERVICE_AUTH_AUDIENCE ?? 'ailin-ci';
process.env.SERVICE_AUTH_ALLOWED_CLIENTS = process.env.SERVICE_AUTH_ALLOWED_CLIENTS ?? 'ailin-dev-server';
// Unreachable on purpose in keypair mode — we prime the JWKS cache so no fetch
// happens. In REAL-id mode, set this to the live id JWKS.
process.env.SERVICE_AUTH_JWKS_URI = process.env.SERVICE_AUTH_JWKS_URI ?? 'http://127.0.0.1:9/unused';
process.env.SKIP_PER_PLUGIN_DISCOVERY = 'true';
process.env.DEFER_CATALOG_LOAD = 'true';

import { generateKeyPairSync, type KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';
import Fastify from 'fastify';

const ACTING_USER = process.env.VALIDATE_ACTING_USER ?? '22222222-2222-2222-2222-222222222222'; // seed user test@example.com
const LIVE_CI = process.env.LIVE_CI_URL ?? 'http://localhost:3002';
const ISSUER = process.env.SERVICE_AUTH_ISSUER!;
const AUDIENCE = process.env.SERVICE_AUTH_AUDIENCE!;
const KID = 'validation-key-1';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function mintToken(scopes: string, overrides: Record<string, unknown> = {}, privatePem?: string): string {
  return jwt.sign(
    {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'ailin-dev-server',
      client_id: 'ailin-dev-server',
      token_type: 'service',
      scope: scopes,
      ...overrides,
    },
    privatePem!,
    { algorithm: 'RS256', keyid: KID },
  );
}

async function main(): Promise<void> {
  const verifier = await import('@/services/service-token-verifier');
  const realWrite = process.env.REAL_WRITE_TOKEN;
  const realRead = process.env.REAL_READ_TOKEN;

  let writeToken: string;
  let readToken: string | null;

  if (realWrite) {
    // REAL-id mode: the verifier fetches the live id JWKS (NOT primed); tokens
    // are minted by id's actual /oauth/token endpoint.
    console.log(`mode: REAL id token (issuer=${process.env.SERVICE_AUTH_ISSUER}, jwks=${process.env.SERVICE_AUTH_JWKS_URI})`);
    writeToken = realWrite;
    readToken = realRead ?? null;
  } else {
    console.log('mode: local keypair (primed JWKS)');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = (privateKey as KeyObject).export({ type: 'pkcs8', format: 'pem' }).toString();
    const jwk = (publicKey as KeyObject).export({ format: 'jwk' }) as Record<string, unknown>;
    verifier.__primeJwksForTests([{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' } as never]);
    const allScopes = 'apikeys:read:on_behalf apikeys:write:on_behalf apikeys:revoke:on_behalf';
    writeToken = mintToken(allScopes, {}, privatePem);
    readToken = mintToken('apikeys:read:on_behalf', {}, privatePem);
  }

  const { internalApiKeysRoutes } = await import('@/routes/internal/internal-api-keys-routes');

  const app = Fastify({ logger: false });
  await app.register(internalApiKeysRoutes);
  await app.ready();

  // 1. CREATE
  const createRes = await app.inject({
    method: 'POST',
    url: '/v1/internal/api-keys',
    headers: { authorization: `Bearer ${writeToken}`, 'x-acting-user': ACTING_USER, 'content-type': 'application/json' },
    payload: { name: 'local-validation-key' },
  });
  const created = createRes.json() as { id?: string; plainKey?: string; keyPrefix?: string; status?: string };
  check('POST create → 201', createRes.statusCode === 201, `status=${createRes.statusCode}`);
  check('create returns ak_ plainKey', typeof created.plainKey === 'string' && created.plainKey.startsWith('ak_'), created.plainKey?.slice(0, 8));
  check('create returns id + keyPrefix + status', Boolean(created.id && created.keyPrefix && created.status));
  const keyId = created.id!;
  const plainKey = created.plainKey!;

  // 2. LIST
  const listRes = await app.inject({
    method: 'GET',
    url: '/v1/internal/api-keys',
    headers: { authorization: `Bearer ${writeToken}`, 'x-acting-user': ACTING_USER },
  });
  const listed = listRes.json() as { apiKeys?: Array<{ id: string; status: string }> };
  check('GET list → 200', listRes.statusCode === 200, `status=${listRes.statusCode}`);
  check('list includes the new key', Array.isArray(listed.apiKeys) && listed.apiKeys.some((k) => k.id === keyId));

  // 3a. Definitive in-process proof: the minted key resolves to the acting
  //     user via the EXACT function the live auth middleware uses.
  const { getAuthService } = await import('@/services/auth-service');
  const authed = await getAuthService().verifyApiKey(plainKey);
  check('minted key authenticates (verifyApiKey resolves the user)', authed?.userId === ACTING_USER, `userId=${authed?.userId ?? 'null'}`);

  // 3b. LIVE ci-api auth on a GET endpoint (no body schema, so the auth
  //     preHandler is actually evaluated): 401 without key → non-401 with key.
  for (const path of ['/v1/projects', '/v1/organizations']) {
    try {
      const noKey = await fetch(`${LIVE_CI}${path}`, { method: 'GET' });
      const withKey = await fetch(`${LIVE_CI}${path}`, { method: 'GET', headers: { 'x-api-key': plainKey } });
      check(`live ${path}: no key → 401`, noKey.status === 401, `status=${noKey.status}`);
      check(`live ${path}: ak_ key → authenticated (not 401)`, withKey.status !== 401, `status=${withKey.status}`);
    } catch (err) {
      check(`live ${path} reachable`, false, err instanceof Error ? err.message : String(err));
    }
  }

  // 4. negative: missing required scope (read-only token cannot create)
  if (readToken) {
    const scopeRes = await app.inject({
      method: 'POST',
      url: '/v1/internal/api-keys',
      headers: { authorization: `Bearer ${readToken}`, 'x-acting-user': ACTING_USER, 'content-type': 'application/json' },
      payload: { name: 'should-fail' },
    });
    check('read-only token cannot create → 403', scopeRes.statusCode === 403, `status=${scopeRes.statusCode}`);
  } else {
    console.log('SKIP read-only scope test (no REAL_READ_TOKEN provided)');
  }

  // 5. negative: missing X-Acting-User
  const noActingRes = await app.inject({
    method: 'GET',
    url: '/v1/internal/api-keys',
    headers: { authorization: `Bearer ${writeToken}` },
  });
  check('missing X-Acting-User → 400', noActingRes.statusCode === 400, `status=${noActingRes.statusCode}`);

  // 6. negative: no token at all
  const noTokenRes = await app.inject({ method: 'GET', url: '/v1/internal/api-keys', headers: { 'x-acting-user': ACTING_USER } });
  check('no service token → 401', noTokenRes.statusCode === 401, `status=${noTokenRes.statusCode}`);

  // 7. DELETE (revoke)
  const delRes = await app.inject({
    method: 'DELETE',
    url: `/v1/internal/api-keys/${keyId}`,
    headers: { authorization: `Bearer ${writeToken}`, 'x-acting-user': ACTING_USER },
  });
  check('DELETE revoke → 204', delRes.statusCode === 204, `status=${delRes.statusCode}`);

  // cleanup: hard-delete the validation key + its rotation logs
  const { prisma } = await import('@/database/client');
  try {
    await prisma.apiKeyRotationLog.deleteMany({ where: { apiKeyId: keyId } });
    await prisma.apiKey.delete({ where: { id: keyId } });
    console.log('cleanup: removed validation key', keyId);
  } catch (err) {
    console.log('cleanup warning:', err instanceof Error ? err.message : String(err));
  }

  await app.close();
  await prisma.$disconnect().catch(() => {});

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('validation script crashed:', err);
  process.exit(1);
});
