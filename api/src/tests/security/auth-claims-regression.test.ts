// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import jwt, { type Algorithm, type SignOptions } from 'jsonwebtoken';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://ailin_dev:ailin_dev_password@localhost:5433/ailin_dev';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-claims-regression';

type AuthServiceInstance = {
  verifyToken(token: string): Promise<unknown>;
  refreshToken(token: string): Promise<{ success: boolean; error?: string }>;
};

type SecurityConfig = {
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string | string[];
  jwtAlgorithms: string[];
};

let authService: AuthServiceInstance;
let securityConfig: SecurityConfig;

function buildPayload(tokenUse: 'access' | 'refresh'): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    userId: 'f4292f61-1d70-49f2-8ea0-2e3ef06b6f6a',
    organizationId: '2f15384c-17a9-4ad8-a8ff-2445ce2726fb',
    email: 'claims-regression@example.com',
    roles: ['viewer'],
    token_use: tokenUse,
    jti: `jti_${tokenUse}_${now}`,
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
  };
}

function signWithConfiguredSecurity(
  payload: Record<string, unknown>,
  overrides: Partial<SignOptions> = {}
): string {
  const configuredAlgorithm = (securityConfig.jwtAlgorithms[0] || 'HS256') as Algorithm;
  const options: SignOptions = {
    algorithm: configuredAlgorithm,
    issuer: securityConfig.jwtIssuer,
    audience: securityConfig.jwtAudience,
    ...overrides,
  };
  return jwt.sign(payload, securityConfig.jwtSecret, options);
}

function pickDisallowedAlgorithm(allowedAlgorithms: string[]): Algorithm {
  const candidates: Algorithm[] = ['HS384', 'HS512'];
  for (const candidate of candidates) {
    if (!allowedAlgorithms.includes(candidate)) {
      return candidate;
    }
  }
  return 'none';
}

describe('Auth Claims Regression Guard', () => {
  beforeAll(async () => {
    const [{ AuthService }, { config }] = await Promise.all([
      import('@/services/auth-service'),
      import('@/config'),
    ]);
    authService = new AuthService() as AuthServiceInstance;
    securityConfig = {
      jwtSecret: config.security.jwtSecret,
      jwtIssuer: config.security.jwtIssuer,
      jwtAudience: config.security.jwtAudience,
      jwtAlgorithms: config.security.jwtAlgorithms,
    };
  });

  it('rejects token with invalid issuer', async () => {
    const token = signWithConfiguredSecurity(buildPayload('access'), {
      issuer: 'urn:malicious-issuer',
    });
    await expect(authService.verifyToken(token)).resolves.toBeNull();
  });

  it('rejects token with invalid audience', async () => {
    const token = signWithConfiguredSecurity(buildPayload('access'), {
      audience: 'urn:malicious-audience',
    });
    await expect(authService.verifyToken(token)).resolves.toBeNull();
  });

  it('rejects token with disallowed algorithm', async () => {
    const disallowedAlgorithm = pickDisallowedAlgorithm(securityConfig.jwtAlgorithms);
    const payload = buildPayload('access');

    const token =
      disallowedAlgorithm === 'none'
        ? jwt.sign(payload, '', {
            algorithm: 'none',
            issuer: securityConfig.jwtIssuer,
            audience: securityConfig.jwtAudience,
          })
        : jwt.sign(payload, securityConfig.jwtSecret, {
            algorithm: disallowedAlgorithm,
            issuer: securityConfig.jwtIssuer,
            audience: securityConfig.jwtAudience,
          });

    await expect(authService.verifyToken(token)).resolves.toBeNull();
  });

  it('rejects access token on refresh endpoint (token_use mismatch)', async () => {
    const accessToken = signWithConfiguredSecurity(buildPayload('access'));
    const result = await authService.refreshToken(accessToken);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid or expired refresh token');
  });

  it('rejects refresh token in access-token verification (token_use mismatch)', async () => {
    const refreshToken = signWithConfiguredSecurity(buildPayload('refresh'));
    await expect(authService.verifyToken(refreshToken)).resolves.toBeNull();
  });
});
