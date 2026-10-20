// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * REGRESSION: the GLOBAL apiKeyAuthMiddleware (index.ts preHandler) resolves
 * the API key ITSELF via validateApiKeyAndGetUser() — it never calls
 * authenticate(). The forwarded-actor swap added to authenticate()'s
 * short-circuit (#724) was therefore dead code for ALL key-authed traffic:
 * chat's X-Ailin-Actor-Token attribution silently stayed on the key's shared
 * service-account user, which broke the per-user free-tier bucketing and the
 * credits-continue wallet billing on the user's own org. The global
 * middleware must run the same best-effort swap after attaching its context.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

const { verifyServiceTokenMock } = vi.hoisted(() => ({ verifyServiceTokenMock: vi.fn() }));

vi.mock('@/services/service-token-verifier', () => ({
  verifyServiceToken: verifyServiceTokenMock,
  ServiceTokenError: class ServiceTokenError extends Error {
    reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
    }
  },
}));

vi.mock('@/database/client', () => ({
  prisma: {
    apiKey: { findFirst: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() })),
  },
}));

vi.mock('@/services/rbac-service', () => ({
  registerRoleChangeListener: vi.fn(() => () => {}),
}));

vi.mock('bcrypt', () => ({
  default: { compare: vi.fn(async () => true) },
}));

import { apiKeyAuthMiddleware } from '@/api/middleware/api-key-auth-middleware';
import type { AuthenticatedRequest } from '@/api/middleware/api-key-auth-middleware';
import { prisma } from '@/database/client';

const PRINCIPAL_USER_ID = 'aaaaaaaa-0000-0000-0000-000000000000';
const ACTING_USER_ID = 'bbbbbbbb-1111-1111-1111-111111111111';
const ORG_ID = '63632c52-6e75-45a3-aac6-1d91008a216b';
const API_KEY = 'ai1sk_free_tier_key_value';

function makeRequest(headers: Record<string, string>): Partial<FastifyRequest> {
  return {
    url: '/v1/chat/completions',
    method: 'POST',
    headers,
    ip: '192.168.1.100',
    log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as FastifyRequest['log'],
  };
}

function makeReply(): Partial<FastifyReply> {
  return { status: vi.fn().mockReturnThis(), send: vi.fn(), code: vi.fn().mockReturnThis() };
}

function apiKeyRecord() {
  return {
    id: 'key-1',
    name: 'chat-free-tier',
    status: 'active',
    statusReason: null,
    expiresAt: null,
    keyHash: '$2b$12$hash',
    ipWhitelist: [],
    permissions: null,
    userId: PRINCIPAL_USER_ID,
    organizationId: ORG_ID,
    user: {
      id: PRINCIPAL_USER_ID,
      email: 'chat-free-tier-service@ailin.one',
      name: 'Chat Free Tier',
      role: 'viewer',
      status: 'active',
      organizationId: ORG_ID,
      organization: { id: ORG_ID, tier: 'enterprise', status: 'active' },
      userRoles: [],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(apiKeyRecord() as never);
  vi.mocked(prisma.apiKey.update).mockResolvedValue({} as never);
});

describe('global apiKeyAuthMiddleware forwarded actor identity', () => {
  it('overrides userId for attribution when actor token + header are valid', async () => {
    verifyServiceTokenMock.mockResolvedValue({
      clientId: 'ailin-chat-server',
      tokenType: 'service',
      scopes: ['chat:forward-identity'],
    });

    const request = makeRequest({
      'x-api-key': API_KEY,
      'x-ailin-actor-token': 'signed.actor.token',
      'x-acting-user': ACTING_USER_ID,
    });
    await apiKeyAuthMiddleware(request as FastifyRequest, makeReply() as FastifyReply);

    const authenticated = request as AuthenticatedRequest;
    expect(authenticated.userId).toBe(ACTING_USER_ID);
    expect(authenticated.user?.userId).toBe(ACTING_USER_ID);
    // Authorization boundary untouched: still the API key's org.
    expect(authenticated.organizationId).toBe(ORG_ID);
    expect(authenticated.user?.organizationId).toBe(ORG_ID);
  });

  it('keeps the key principal identity when no actor token is present', async () => {
    const request = makeRequest({ 'x-api-key': API_KEY });
    await apiKeyAuthMiddleware(request as FastifyRequest, makeReply() as FastifyReply);

    const authenticated = request as AuthenticatedRequest;
    expect(authenticated.userId).toBe(PRINCIPAL_USER_ID);
    expect(verifyServiceTokenMock).not.toHaveBeenCalled();
  });

  it('never fails the request when the actor token does not verify', async () => {
    verifyServiceTokenMock.mockRejectedValue(new Error('jwks unreachable'));

    const request = makeRequest({
      'x-api-key': API_KEY,
      'x-ailin-actor-token': 'garbage',
      'x-acting-user': ACTING_USER_ID,
    });
    await apiKeyAuthMiddleware(request as FastifyRequest, makeReply() as FastifyReply);

    const authenticated = request as AuthenticatedRequest;
    expect(authenticated.userId).toBe(PRINCIPAL_USER_ID);
    expect(authenticated.user?.userId).toBe(PRINCIPAL_USER_ID);
  });
});
