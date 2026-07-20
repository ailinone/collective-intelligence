// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for the M2M service-token verifier. Self-contained: generates a
 * local RSA keypair, primes the JWKS cache with its public JWK (no network),
 * and mints tokens with jsonwebtoken. The verifier uses config defaults
 * (issuer https://ailin.id, audience ailin-ci, client ailin-dev-server), so
 * tokens minted with those values are accepted.
 */

import { generateKeyPairSync, type KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import {
  verifyServiceToken,
  ServiceTokenError,
  __primeJwksForTests,
  __resetServiceTokenVerifierForTests,
} from '@/services/service-token-verifier';

const KID = 'test-key-1';
const ISSUER = 'https://ailin.id';
const AUDIENCE = 'ailin-ci';
const CLIENT = 'ailin-dev-server';

let privatePem: string;
let publicJwk: Record<string, unknown>;

function sign(payload: Record<string, unknown>, opts: { alg?: jwt.Algorithm; key?: string } = {}): string {
  return jwt.sign(payload, opts.key ?? privatePem, {
    algorithm: opts.alg ?? 'RS256',
    keyid: KID,
  });
}

function baseServiceClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: CLIENT,
    client_id: CLIENT,
    token_type: 'service',
    scope: 'apikeys:read:on_behalf apikeys:write:on_behalf apikeys:revoke:on_behalf',
    ...overrides,
  };
}

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privatePem = (privateKey as KeyObject).export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwk = (publicKey as KeyObject).export({ format: 'jwk' }) as Record<string, unknown>;
  publicJwk = { ...jwk, kid: KID, use: 'sig', alg: 'RS256' };
});

afterEach(() => {
  __resetServiceTokenVerifierForTests();
});

describe('verifyServiceToken', () => {
  it('accepts a valid client_credentials service token', async () => {
    __primeJwksForTests([publicJwk as never]);
    const ctx = await verifyServiceToken(sign(baseServiceClaims()));
    expect(ctx.clientId).toBe(CLIENT);
    expect(ctx.tokenType).toBe('service');
    expect(ctx.scopes).toContain('apikeys:write:on_behalf');
    // service tokens carry no acting-user claims (header-carried instead)
    expect(ctx.subject).toBeUndefined();
  });

  it('accepts a token-exchange token and surfaces the acting user claims', async () => {
    __primeJwksForTests([publicJwk as never]);
    const userId = '11111111-2222-3333-4444-555555555555';
    const token = sign({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: userId,
      token_type: 'exchanged',
      act: { client_id: CLIENT, sub: CLIENT },
      email: 'dev@example.com',
      tenant_id: '99999999-8888-7777-6666-555555555555',
      scope: 'apikeys:write:on_behalf',
    });
    const ctx = await verifyServiceToken(token);
    expect(ctx.tokenType).toBe('exchanged');
    expect(ctx.clientId).toBe(CLIENT);
    expect(ctx.subject).toBe(userId);
    expect(ctx.email).toBe('dev@example.com');
    expect(ctx.tenantId).toBe('99999999-8888-7777-6666-555555555555');
  });

  it('rejects an HS256 (shared-secret) token as unsupported algorithm', async () => {
    __primeJwksForTests([publicJwk as never]);
    const token = jwt.sign(baseServiceClaims(), 'a-shared-secret', { algorithm: 'HS256' });
    await expect(verifyServiceToken(token)).rejects.toMatchObject({ reason: 'unsupported_algorithm' });
  });

  it('rejects a wrong issuer (signature/claims verification failure)', async () => {
    __primeJwksForTests([publicJwk as never]);
    const token = sign(baseServiceClaims({ iss: 'https://evil.example' }));
    await expect(verifyServiceToken(token)).rejects.toMatchObject({ reason: 'invalid_signature' });
  });

  it('rejects a wrong audience', async () => {
    __primeJwksForTests([publicJwk as never]);
    const token = sign(baseServiceClaims({ aud: 'some-other-service' }));
    await expect(verifyServiceToken(token)).rejects.toMatchObject({ reason: 'invalid_signature' });
  });

  it('rejects a user access token (wrong token_type)', async () => {
    __primeJwksForTests([publicJwk as never]);
    const token = sign(baseServiceClaims({ token_type: 'access' }));
    await expect(verifyServiceToken(token)).rejects.toMatchObject({ reason: 'wrong_token_type' });
  });

  it('rejects a token from a non-allowlisted client', async () => {
    __primeJwksForTests([publicJwk as never]);
    const token = sign(baseServiceClaims({ client_id: 'some-rogue-client', sub: 'some-rogue-client' }));
    await expect(verifyServiceToken(token)).rejects.toMatchObject({ reason: 'client_not_allowed' });
  });

  it('fails closed when JWKS is unavailable', async () => {
    // Cache not primed and the default jwksUri is unreachable in the test env.
    const token = sign(baseServiceClaims());
    await expect(verifyServiceToken(token)).rejects.toBeInstanceOf(ServiceTokenError);
  });

  it('rejects a malformed token', async () => {
    __primeJwksForTests([publicJwk as never]);
    await expect(verifyServiceToken('not-a-jwt')).rejects.toMatchObject({ reason: 'malformed_token' });
  });
});
