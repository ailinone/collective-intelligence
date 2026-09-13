// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for authenticate()'s forwarded-actor-identity attachment (Fase 2
 * of the chat<->ci identity-attribution work): a request already
 * authenticated via API key may additionally carry an X-Ailin-Actor-Token
 * (a client_credentials service token, scope chat:forward-identity) plus an
 * X-Acting-User header naming the real end user. When valid, userId is
 * overridden for USAGE ATTRIBUTION ONLY -- organizationId/roles must always
 * stay exactly what the API key itself authenticated, proving this can never
 * be used to escalate privilege or cross an organization boundary.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/service-token-verifier', () => {
  class ServiceTokenError extends Error {
    reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
    }
  }
  return { verifyServiceToken: vi.fn(), ServiceTokenError };
});

const verifyApiKeyMock = vi.fn();
vi.mock('@/services/auth-service', () => ({
  getAuthService: () => ({ verifyApiKey: verifyApiKeyMock }),
}));

import { verifyServiceToken } from '@/services/service-token-verifier';
import { authenticate } from '@/middleware/auth-middleware';

const verifyServiceTokenMock = vi.mocked(verifyServiceToken);

const ORG_ID = 'org-11111111-1111-1111-1111-111111111111';
const SERVICE_ACCOUNT_USER_ID = 'aaaaaaaa-0000-0000-0000-000000000000';
const REAL_END_USER_ID = 'bbbbbbbb-1111-1111-1111-111111111111';

function makeReply() {
  return {
    statusCode: null as number | null,
    body: undefined as unknown,
    code(s: number) {
      this.statusCode = s;
      return this;
    },
    send(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

function makeRequest(headers: Record<string, string>) {
  return { headers, url: '/v1/chat/completions', method: 'POST' } as unknown as Parameters<
    typeof authenticate
  >[0];
}

const API_KEY_HEADERS = { 'x-api-key': 'ai1sk_test_free_tier_key' };

beforeEach(() => {
  verifyServiceTokenMock.mockReset();
  verifyApiKeyMock.mockReset();
  verifyApiKeyMock.mockResolvedValue({
    userId: SERVICE_ACCOUNT_USER_ID,
    organizationId: ORG_ID,
    roles: ['viewer'],
    email: 'free-tier-service@example.com',
    apiKeyId: 'key-1',
  });
});

describe('authenticate() forwarded actor identity', () => {
  it('overrides userId for attribution when the actor token and header are both valid', async () => {
    verifyServiceTokenMock.mockResolvedValue({
      clientId: 'ailin-chat-server',
      tokenType: 'service',
      scopes: ['chat:forward-identity'],
    });

    const request = makeRequest({
      ...API_KEY_HEADERS,
      'x-ailin-actor-token': 'signed.actor.token',
      'x-acting-user': REAL_END_USER_ID,
    });
    const reply = makeReply();

    await authenticate(request, reply as unknown as Parameters<typeof authenticate>[1]);

    const extended = request as unknown as {
      userId?: string;
      organizationId?: string;
      user?: { userId?: string; organizationId?: string; roles?: string[] };
    };
    expect(extended.userId).toBe(REAL_END_USER_ID);
    expect(extended.user?.userId).toBe(REAL_END_USER_ID);
    // Authorization boundary is untouched: still the API key's real org/roles.
    expect(extended.organizationId).toBe(ORG_ID);
    expect(extended.user?.organizationId).toBe(ORG_ID);
    expect(extended.user?.roles).toEqual(['viewer']);
  });

  it('leaves the service-account userId untouched when no actor token is present', async () => {
    const request = makeRequest({ ...API_KEY_HEADERS });
    const reply = makeReply();

    await authenticate(request, reply as unknown as Parameters<typeof authenticate>[1]);

    expect((request as unknown as { userId?: string }).userId).toBe(SERVICE_ACCOUNT_USER_ID);
    expect(verifyServiceTokenMock).not.toHaveBeenCalled();
  });

  it('ignores an actor token that fails verification (never fails the request)', async () => {
    verifyServiceTokenMock.mockRejectedValue(new Error('boom'));

    const request = makeRequest({
      ...API_KEY_HEADERS,
      'x-ailin-actor-token': 'garbage',
      'x-acting-user': REAL_END_USER_ID,
    });
    const reply = makeReply();

    await authenticate(request, reply as unknown as Parameters<typeof authenticate>[1]);

    expect(reply.statusCode).toBeNull(); // request still succeeds
    expect((request as unknown as { userId?: string }).userId).toBe(SERVICE_ACCOUNT_USER_ID);
  });

  it('ignores a valid token missing the chat:forward-identity scope', async () => {
    verifyServiceTokenMock.mockResolvedValue({
      clientId: 'ailin-chat-server',
      tokenType: 'service',
      scopes: ['some:other:scope'],
    });

    const request = makeRequest({
      ...API_KEY_HEADERS,
      'x-ailin-actor-token': 'signed.actor.token',
      'x-acting-user': REAL_END_USER_ID,
    });
    const reply = makeReply();

    await authenticate(request, reply as unknown as Parameters<typeof authenticate>[1]);

    expect((request as unknown as { userId?: string }).userId).toBe(SERVICE_ACCOUNT_USER_ID);
  });

  it('ignores an exchanged token (only service tokens carry the chat scope grant)', async () => {
    verifyServiceTokenMock.mockResolvedValue({
      clientId: 'ailin-chat-server',
      tokenType: 'exchanged',
      scopes: ['chat:forward-identity'],
      subject: REAL_END_USER_ID,
    });

    const request = makeRequest({
      ...API_KEY_HEADERS,
      'x-ailin-actor-token': 'signed.actor.token',
      'x-acting-user': REAL_END_USER_ID,
    });
    const reply = makeReply();

    await authenticate(request, reply as unknown as Parameters<typeof authenticate>[1]);

    expect((request as unknown as { userId?: string }).userId).toBe(SERVICE_ACCOUNT_USER_ID);
  });

  it('ignores a malformed (non-UUID) X-Acting-User header', async () => {
    verifyServiceTokenMock.mockResolvedValue({
      clientId: 'ailin-chat-server',
      tokenType: 'service',
      scopes: ['chat:forward-identity'],
    });

    const request = makeRequest({
      ...API_KEY_HEADERS,
      'x-ailin-actor-token': 'signed.actor.token',
      'x-acting-user': 'not-a-uuid',
    });
    const reply = makeReply();

    await authenticate(request, reply as unknown as Parameters<typeof authenticate>[1]);

    expect((request as unknown as { userId?: string }).userId).toBe(SERVICE_ACCOUNT_USER_ID);
  });
});
