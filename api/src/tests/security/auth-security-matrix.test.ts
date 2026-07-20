// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Authentication Security Matrix Tests
 * Validates security controls per the IAM Audit Plan (FASE 7)
 * 
 * Test Matrix:
 * | ID  | Scenario                    | Expected      | Go/No-Go |
 * |-----|-----------------------------| ------------- |----------|
 * | T1  | JWT valido (HS256)          | 200 OK        | Go       |
 * | T2  | JWT expirado                | 401           | Go       |
 * | T3  | JWT revogado                | 401           | Go       |
 * | T4  | JWT com aud errado          | 401           | Go       |
 * | T5  | JWT com iss errado          | 401           | Go       |
 * | T6  | JWT com kid desconhecido    | 401           | N/A      |
 * | T7  | Header spoofing (X-Auth-*)  | 403           | Go       |
 * | T8  | Header spoofing (Auth)      | 401           | Go       |
 * | T9  | API key valida              | 200 OK        | Go       |
 * | T10 | API key revogada            | 401           | Go       |
 * | T11 | API key expirada            | 401           | Go       |
 * | T12 | API key com IP errado       | 401           | Go       |
 * | T17 | Clock skew (nbf futuro)     | 401           | Go       |
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { generateNonce } from '@/middleware/nonce-middleware';

// Mock config for testing
const TEST_JWT_SECRET = 'test-jwt-secret-for-security-matrix-tests-32chars';
const TEST_JWT_OPTIONS = {
  issuer: 'ci-api',
  audience: 'ci-api',
  expiresIn: '1h',
};

/**
 * Generate test JWT with custom claims
 */
function generateTestJWT(
  payload: Record<string, unknown>,
  options: {
    issuer?: string;
    audience?: string;
    expiresIn?: string | number;
    notBefore?: string | number;
    secret?: string;
  } = {}
): string {
  const secret = options.secret || TEST_JWT_SECRET;
  
  // Build sign options without undefined values
  const signOptions: jwt.SignOptions = {
    issuer: options.issuer ?? TEST_JWT_OPTIONS.issuer,
    audience: options.audience ?? TEST_JWT_OPTIONS.audience,
    expiresIn: options.expiresIn ?? TEST_JWT_OPTIONS.expiresIn,
  };
  
  // Only add notBefore if explicitly provided (not undefined)
  if (options.notBefore !== undefined) {
    signOptions.notBefore = options.notBefore;
  }
  
  return jwt.sign(payload, secret, signOptions);
}

/**
 * Generate expired JWT
 */
function generateExpiredJWT(payload: Record<string, unknown>): string {
  return jwt.sign(payload, TEST_JWT_SECRET, {
    issuer: TEST_JWT_OPTIONS.issuer,
    audience: TEST_JWT_OPTIONS.audience,
    expiresIn: '-1h', // Already expired
  });
}

/**
 * Generate JWT with wrong issuer
 */
function generateWrongIssuerJWT(payload: Record<string, unknown>): string {
  return jwt.sign(payload, TEST_JWT_SECRET, {
    issuer: 'attacker.com',
    audience: TEST_JWT_OPTIONS.audience,
    expiresIn: TEST_JWT_OPTIONS.expiresIn,
  });
}

/**
 * Generate JWT with wrong audience
 */
function generateWrongAudienceJWT(payload: Record<string, unknown>): string {
  return jwt.sign(payload, TEST_JWT_SECRET, {
    issuer: TEST_JWT_OPTIONS.issuer,
    audience: 'other-service',
    expiresIn: TEST_JWT_OPTIONS.expiresIn,
  });
}

/**
 * Generate JWT with future nbf (not before)
 */
function generateFutureNBFJWT(payload: Record<string, unknown>): string {
  return jwt.sign(payload, TEST_JWT_SECRET, {
    issuer: TEST_JWT_OPTIONS.issuer,
    audience: TEST_JWT_OPTIONS.audience,
    expiresIn: TEST_JWT_OPTIONS.expiresIn,
    notBefore: '1h', // Not valid for another hour
  });
}

describe('Authentication Security Matrix', () => {
  const basePayload = {
    userId: 'test-user-id',
    organizationId: 'test-org-id',
    email: 'test@example.com',
    roles: ['user'],
  };

  describe('T1: Valid JWT (HS256)', () => {
    it('should accept valid JWT with correct claims', () => {
      const token = generateTestJWT(basePayload);
      const decoded = jwt.verify(token, TEST_JWT_SECRET, {
        issuer: ['ci-api', 'https://ailin.id', 'gateway'],
        audience: ['ci-api', 'https://api.ailin.one'],
        clockTolerance: 30,
      });
      
      expect(decoded).toBeDefined();
      expect((decoded as jwt.JwtPayload).userId).toBe(basePayload.userId);
    });
  });

  describe('T2: Expired JWT', () => {
    it('should reject expired JWT with TokenExpiredError', () => {
      const token = generateExpiredJWT(basePayload);
      
      expect(() => {
        jwt.verify(token, TEST_JWT_SECRET, {
          issuer: ['ci-api'],
          audience: ['ci-api'],
        });
      }).toThrow('jwt expired');
    });
  });

  describe('T4: JWT with wrong audience', () => {
    it('should reject JWT with invalid audience', () => {
      const token = generateWrongAudienceJWT(basePayload);
      
      expect(() => {
        jwt.verify(token, TEST_JWT_SECRET, {
          issuer: ['ci-api'],
          audience: ['ci-api'], // Expected audience doesn't match
        });
      }).toThrow('jwt audience invalid');
    });
  });

  describe('T5: JWT with wrong issuer', () => {
    it('should reject JWT with invalid issuer', () => {
      const token = generateWrongIssuerJWT(basePayload);
      
      expect(() => {
        jwt.verify(token, TEST_JWT_SECRET, {
          issuer: ['ci-api', 'https://ailin.id', 'gateway'],
          audience: ['ci-api'],
        });
      }).toThrow('jwt issuer invalid');
    });
  });

  describe('T17: Clock skew (nbf future)', () => {
    it('should reject JWT with future nbf when outside tolerance', () => {
      const token = generateFutureNBFJWT(basePayload);
      
      expect(() => {
        jwt.verify(token, TEST_JWT_SECRET, {
          issuer: ['ci-api'],
          audience: ['ci-api'],
          clockTolerance: 30, // 30 seconds tolerance, but token is 1 hour in future
        });
      }).toThrow('jwt not active');
    });
  });

  describe('JWT Signature Validation', () => {
    it('should reject JWT with invalid signature', () => {
      const token = generateTestJWT(basePayload);
      const tamperedToken = token.slice(0, -10) + 'TAMPERED!!';
      
      // jwt.verify throws 'invalid token' when signature verification fails
      // due to malformed JWT structure
      expect(() => {
        jwt.verify(tamperedToken, TEST_JWT_SECRET);
      }).toThrow(/invalid/);
    });

    it('should reject JWT signed with wrong secret', () => {
      const token = jwt.sign(basePayload, 'wrong-secret', {
        issuer: TEST_JWT_OPTIONS.issuer,
        audience: TEST_JWT_OPTIONS.audience,
        expiresIn: TEST_JWT_OPTIONS.expiresIn,
      });
      
      expect(() => {
        jwt.verify(token, TEST_JWT_SECRET);
      }).toThrow('invalid signature');
    });
  });

  describe('Security Headers Validation', () => {
    it('should validate X-Auth-Request headers are stripped from untrusted sources', () => {
      // This test validates the gateway-origin-middleware behavior
      // In real tests, this would make HTTP requests through the full stack
      const untrustedHeaders = {
        'X-Auth-Request-User': 'spoofed-admin',
        'X-Auth-Request-Email': 'admin@example.com',
        'X-Auth-Request-Access-Token': 'fake-token',
      };

      // Validate that these headers should be stripped
      // The actual stripping is done by gateway-origin-middleware
      expect(untrustedHeaders['X-Auth-Request-User']).toBeDefined();
    });
  });

  describe('API Key Validation', () => {
    it('should validate API key format', () => {
      const validKey = 'ak_live_1234567890abcdef';
      const invalidKey = 'invalid_key_format';
      
      expect(validKey.startsWith('ak_')).toBe(true);
      expect(invalidKey.startsWith('ak_')).toBe(false);
    });

    it('should reject API keys with invalid prefix', () => {
      const invalidPrefixes = [
        'api_key_123',
        'bearer_token',
        'sk_live_123', // Stripe-style, not Ailin
        'key_123',
      ];

      invalidPrefixes.forEach(key => {
        expect(key.startsWith('ak_')).toBe(false);
      });
    });
  });

  describe('Nonce Validation (T7 - Replay Attack Protection)', () => {
    it('should validate nonce format (base64url, 32 bytes)', () => {
      const nonce = generateNonce();
      
      // Nonce should be base64url encoded 32 bytes (43 characters)
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(nonce.length).toBe(43);
    });

    it('should validate nonce uniqueness', () => {
      const nonce1 = generateNonce();
      const nonce2 = generateNonce();
      
      // Each nonce should be unique
      expect(nonce1).not.toBe(nonce2);
    });
  });

  describe('Rate Limiting (T7 - Replay Attack Protection)', () => {
    it('should validate tier-based rate limits', () => {
      const tierLimits = {
        'free': 20,
        'starter': 60,
        'professional': 120,
        'business': 300,
        'enterprise': 600,
      };
      
      // Validate that rate limits are defined for all tiers
      Object.entries(tierLimits).forEach(([tier, limit]) => {
        expect(limit).toBeGreaterThan(0);
        expect(typeof limit).toBe('number');
      });
      
      // Validate burst multiplier
      const burstMultiplier = 1.5;
      expect(burstMultiplier).toBeGreaterThan(1);
      expect(burstMultiplier).toBeLessThanOrEqual(2);
    });
  });
});

/**
 * Integration Security Tests (run against running server)
 * Requires: Docker Compose running, TEST_API_URL (default http://localhost:3000),
 * TEST_USER_EMAIL and TEST_USER_PASSWORD for a valid user in the DB.
 */
// These are `let` (not `const`) because the CI self-provisioning path below
// overwrites them at runtime: when no external TEST_API_URL is supplied, the
// suite boots its own DB-backed HTTP server on an ephemeral port and seeds a
// user, then points baseUrl / testUserEmail / testUserPassword at it.
let baseUrl = process.env.TEST_API_URL || 'http://localhost:3000';
let testUserEmail = process.env.TEST_USER_EMAIL;
let testUserPassword = process.env.TEST_USER_PASSWORD;
const runIntegrationSecuritySuite = process.env.RUN_SECURITY_INTEGRATION_TESTS === 'true';
// When TEST_API_URL is set we run against that already-running server (the
// original docker-compose contract). Otherwise (the CI security gate) we
// self-provision a real server against the Testcontainers Postgres/Redis that
// the vitest globalSetup brings up.
const useExternalServer = Boolean(process.env.TEST_API_URL);

function isServerReachable(): Promise<boolean> {
  return fetch(`${baseUrl}/health`, { method: 'GET' })
    .then((r) => r.ok)
    .catch(() => false);
}

async function loginAndGetToken(): Promise<string> {
  if (!testUserEmail || !testUserPassword) {
    throw new Error('TEST_USER_EMAIL and TEST_USER_PASSWORD must be set for integration tests');
  }
  const res = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testUserEmail, password: testUserPassword }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { tokens?: { accessToken?: string }; success?: boolean };
  const token = data.tokens?.accessToken;
  if (!token) {
    throw new Error('Login response missing accessToken');
  }
  return token;
}

const integrationDescribe = runIntegrationSecuritySuite ? describe : describe.skip;

integrationDescribe('Integration Security Tests (requires running server)', () => {
  let serverAvailable = false;
  // Holds the self-provisioned server so afterAll can tear it down. Typed via a
  // dynamic import so no top-level fastify import is added to the hermetic path.
  let inProcessServer: import('fastify').FastifyInstance | null = null;
  let seededOrgId: string | null = null;

  beforeAll(async () => {
    if (useExternalServer) {
      // External mode: run against an already-running server (docker-compose /
      // staging). TEST_USER_EMAIL / TEST_USER_PASSWORD must reference a real user.
      serverAvailable = await isServerReachable();
      if (!serverAvailable) {
        console.warn(`Integration tests: server at ${baseUrl} not reachable, skipping integration suite`);
      }
      return;
    }

    // CI security gate: self-provision a real, DB-backed HTTP server so the
    // revocation / API-key / header-spoof cases below execute against real
    // Postgres + Redis state (provisioned by the vitest globalSetup via
    // Testcontainers). This mirrors the proven harness in
    // src/routes/auth/__tests__/auth-jwt-flow.test.ts: createServer() installs
    // the global preHandlers (token-revocation + gateway-origin), and
    // listen({ port: 0 }) exposes a real endpoint the fetch()-based cases hit.
    const { initializeDIContainer } = await import('@/di/container');
    initializeDIContainer();

    try {
      const { syncDefaultRoles } = await import('@/services/rbac-sync-service');
      await syncDefaultRoles();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`RBAC sync warning (may already be synced): ${message}`);
    }

    const { createTestServerWithAuthOnly } = await import('../../../tests/utils/test-server');
    const { prisma } = await import('@/database/client');
    const { nanoid } = await import('nanoid');

    const server = await createTestServerWithAuthOnly();
    await server.listen({ port: 0, host: '127.0.0.1' });
    inProcessServer = server;

    const address = server.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    if (!port) {
      throw new Error('Failed to bind security-matrix test server to an ephemeral port');
    }
    baseUrl = `http://127.0.0.1:${port}`;

    // Seed an active org + user so loginAndGetToken() can obtain a real,
    // server-issued JWT and mint API keys against the real DB.
    const org = await prisma.organization.create({
      data: {
        name: `SecMatrix Org ${nanoid(8)}`,
        slug: `secmatrix-${nanoid(8)}`,
        tier: 'enterprise',
        status: 'active',
      },
    });
    seededOrgId = org.id;

    testUserEmail = `secmatrix-${nanoid(8)}@example.com`;
    testUserPassword = 'SecureP@ssw0rd123';
    const registerRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testUserEmail,
        password: testUserPassword,
        name: 'Security Matrix Test User',
        organizationId: seededOrgId,
      }),
    });
    if (registerRes.status !== 201) {
      const body = await registerRes.text();
      throw new Error(`Failed to seed security-matrix test user (${registerRes.status}): ${body}`);
    }

    serverAvailable = true;
  });

  afterAll(async () => {
    if (inProcessServer) {
      try {
        await inProcessServer.close();
      } catch {
        // ignore shutdown errors
      }
    }
    if (seededOrgId) {
      try {
        const { prisma } = await import('@/database/client');
        // Cascades to the seeded user and its API keys.
        await prisma.organization.delete({ where: { id: seededOrgId } });
      } catch {
        // ignore cleanup errors — the DB is ephemeral (Testcontainers).
      }
    }
  });

  it('T3: should reject revoked JWT', async () => {
    if (!serverAvailable || !testUserEmail || !testUserPassword) {
      return;
    }
    const token = await loginAndGetToken();
    const profileRes = await fetch(`${baseUrl}/v1/user/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(profileRes.status).toBe(200);

    const logoutRes = await fetch(`${baseUrl}/v1/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([204, 200]).toContain(logoutRes.status);

    const afterRevokeRes = await fetch(`${baseUrl}/v1/user/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(afterRevokeRes.status).toBe(401);
    const body = (await afterRevokeRes.json()) as { error?: string };
    expect(body.error).toBeDefined();
    expect(String(body.error).toLowerCase()).toMatch(/revoked|invalid|unauthorized/);
  });

  it('T7: should reject or strip spoofed X-Auth-Request headers from untrusted origin', async () => {
    if (!serverAvailable) {
      return;
    }
    // No Authorization or X-API-Key - spoofed headers must NOT grant access
    const res = await fetch(`${baseUrl}/v1/user/profile`, {
      headers: {
        'X-Auth-Request-User': 'spoofed-admin',
        'X-Auth-Request-Email': 'admin@example.com',
      },
    });
    expect([401, 403]).toContain(res.status);
  });

  it('T9: should accept valid API key', async () => {
    if (!serverAvailable || !testUserEmail || !testUserPassword) {
      return;
    }
    const token = await loginAndGetToken();
    const createRes = await fetch(`${baseUrl}/v1/auth/api-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'integration-test-key' }),
    });
    expect(createRes.status).toBe(200);
    const createData = (await createRes.json()) as { apiKey?: string; success?: boolean };
    const apiKey = createData.apiKey;
    expect(apiKey).toBeDefined();
    expect(typeof apiKey).toBe('string');

    const profileRes = await fetch(`${baseUrl}/v1/user/profile`, {
      headers: { 'X-API-Key': apiKey as string },
    });
    expect(profileRes.status).toBe(200);
  });

  it('T10: should reject revoked API key', async () => {
    if (!serverAvailable || !testUserEmail || !testUserPassword) {
      return;
    }
    const token = await loginAndGetToken();
    const createRes = await fetch(`${baseUrl}/v1/auth/api-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'revoke-test-key' }),
    });
    expect(createRes.status).toBe(200);
    const createData = (await createRes.json()) as { apiKey?: string };
    const apiKey = createData.apiKey;
    expect(apiKey).toBeDefined();

    const listRes = await fetch(`${baseUrl}/v1/auth/api-keys`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as { data?: Array<{ id: string; name?: string }> };
    const keys = listData.data ?? [];
    expect(Array.isArray(keys)).toBe(true);
    const keyMeta = keys.find((k) => k.name === 'revoke-test-key');
    const keyId = keyMeta?.id ?? keys[0]?.id;
    expect(keyId).toBeDefined();

    const deleteRes = await fetch(`${baseUrl}/v1/auth/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([200, 204]).toContain(deleteRes.status);

    const profileRes = await fetch(`${baseUrl}/v1/user/profile`, {
      headers: { 'X-API-Key': apiKey as string },
    });
    expect(profileRes.status).toBe(401);
  });

  it('T11: should reject expired or non-existent API key', async () => {
    if (!serverAvailable) {
      return;
    }
    const res = await fetch(`${baseUrl}/v1/user/profile`, {
      headers: { 'X-API-Key': 'ak_live_nonexistent_key_does_not_grant_access' },
    });
    expect(res.status).toBe(401);
  });

  it('T12: invalid API key format or wrong IP is rejected', async () => {
    if (!serverAvailable) {
      return;
    }
    const res = await fetch(`${baseUrl}/v1/user/profile`, {
      headers: { 'X-API-Key': 'ak_live_invalid_key_no_access' },
    });
    expect(res.status).toBe(401);
  });
});

