// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for requireServiceAuth — the route-level preHandler that secures
 * /v1/internal/*. The verifier is mocked so these tests focus purely on the
 * middleware's decision logic: bearer extraction, scope enforcement,
 * acting-user resolution, and the deny-by-default error mapping.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the verifier module. We re-implement ServiceTokenError so the
// middleware's `instanceof` reason-mapping still works.
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

import {
  verifyServiceToken,
  ServiceTokenError,
} from '@/services/service-token-verifier';
import { requireServiceAuth } from '@/api/middleware/internal-service-auth-middleware';

const verifyMock = vi.mocked(verifyServiceToken);

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

interface FakeReply {
  statusCode: number | null;
  body: unknown;
  code: (s: number) => FakeReply;
  send: (b: unknown) => FakeReply;
}

function makeReply(): FakeReply {
  const reply: FakeReply = {
    statusCode: null,
    body: undefined,
    code(s: number) {
      this.statusCode = s;
      return this;
    },
    send(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return reply;
}

function makeRequest(headers: Record<string, string>): {
  headers: Record<string, string>;
  log: { warn: ReturnType<typeof vi.fn> };
  serviceAuth?: unknown;
} {
  return { headers, log: { warn: vi.fn() } };
}

beforeEach(() => {
  verifyMock.mockReset();
});

describe('requireServiceAuth', () => {
  it('401s when no bearer token is present', async () => {
    const handler = requireServiceAuth('apikeys:write:on_behalf');
    const req = makeRequest({});
    const reply = makeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, reply as any);
    expect(reply.statusCode).toBe(401);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('403s when the client is not allowlisted', async () => {
    verifyMock.mockRejectedValue(new ServiceTokenError('client_not_allowed', 'nope'));
    const handler = requireServiceAuth('apikeys:write:on_behalf');
    const req = makeRequest({ authorization: 'Bearer x', 'x-acting-user': USER_ID });
    const reply = makeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, reply as any);
    expect(reply.statusCode).toBe(403);
  });

  it('401s on a bad signature', async () => {
    verifyMock.mockRejectedValue(new ServiceTokenError('invalid_signature', 'bad'));
    const handler = requireServiceAuth('apikeys:write:on_behalf');
    const req = makeRequest({ authorization: 'Bearer x', 'x-acting-user': USER_ID });
    const reply = makeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, reply as any);
    expect(reply.statusCode).toBe(401);
  });

  it('403s when the required scope is missing', async () => {
    verifyMock.mockResolvedValue({
      clientId: 'ailin-dev-server',
      tokenType: 'service',
      scopes: ['apikeys:read:on_behalf'],
    });
    const handler = requireServiceAuth('apikeys:write:on_behalf');
    const req = makeRequest({ authorization: 'Bearer x', 'x-acting-user': USER_ID });
    const reply = makeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, reply as any);
    expect(reply.statusCode).toBe(403);
  });

  it('400s when X-Acting-User is missing for a service token', async () => {
    verifyMock.mockResolvedValue({
      clientId: 'ailin-dev-server',
      tokenType: 'service',
      scopes: ['apikeys:write:on_behalf'],
    });
    const handler = requireServiceAuth('apikeys:write:on_behalf');
    const req = makeRequest({ authorization: 'Bearer x' });
    const reply = makeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, reply as any);
    expect(reply.statusCode).toBe(400);
  });

  it('400s when X-Acting-User is not a UUID', async () => {
    verifyMock.mockResolvedValue({
      clientId: 'ailin-dev-server',
      tokenType: 'service',
      scopes: ['apikeys:write:on_behalf'],
    });
    const handler = requireServiceAuth('apikeys:write:on_behalf');
    const req = makeRequest({ authorization: 'Bearer x', 'x-acting-user': 'not-a-uuid' });
    const reply = makeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, reply as any);
    expect(reply.statusCode).toBe(400);
  });

  it('passes and attaches serviceAuth for a valid service token + header', async () => {
    verifyMock.mockResolvedValue({
      clientId: 'ailin-dev-server',
      tokenType: 'service',
      scopes: ['apikeys:write:on_behalf'],
    });
    const handler = requireServiceAuth('apikeys:write:on_behalf');
    const req = makeRequest({ authorization: 'Bearer x', 'x-acting-user': USER_ID });
    const reply = makeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, reply as any);
    expect(reply.statusCode).toBeNull(); // no error sent
    expect(req.serviceAuth).toMatchObject({ actingUserId: USER_ID });
  });

  it('uses the token sub as acting user for an exchanged token (no header needed)', async () => {
    verifyMock.mockResolvedValue({
      clientId: 'ailin-dev-server',
      tokenType: 'exchanged',
      scopes: ['apikeys:write:on_behalf'],
      subject: USER_ID,
    });
    const handler = requireServiceAuth('apikeys:write:on_behalf');
    const req = makeRequest({ authorization: 'Bearer x' });
    const reply = makeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, reply as any);
    expect(reply.statusCode).toBeNull();
    expect(req.serviceAuth).toMatchObject({ actingUserId: USER_ID });
  });

  it('attaches well-formed X-Acting-User-Email/Tenant provisioning hints', async () => {
    const TENANT_ID = '11111111-2222-3333-4444-555555555555';
    verifyMock.mockResolvedValue({
      clientId: 'ailin-dev-server',
      tokenType: 'service',
      scopes: ['apikeys:write:on_behalf'],
    });
    const handler = requireServiceAuth('apikeys:write:on_behalf');
    const req = makeRequest({
      authorization: 'Bearer x',
      'x-acting-user': USER_ID,
      'x-acting-user-email': 'AI@Ailin.One',
      'x-acting-user-tenant': TENANT_ID,
    });
    const reply = makeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, reply as any);
    expect(reply.statusCode).toBeNull();
    // email is normalized to lower-case; tenant kept verbatim.
    expect(req.serviceAuth).toMatchObject({
      actingUserId: USER_ID,
      actingUserEmail: 'ai@ailin.one',
      actingUserTenant: TENANT_ID,
    });
  });

  it('drops malformed provisioning hints (still passes, hints undefined)', async () => {
    verifyMock.mockResolvedValue({
      clientId: 'ailin-dev-server',
      tokenType: 'service',
      scopes: ['apikeys:write:on_behalf'],
    });
    const handler = requireServiceAuth('apikeys:write:on_behalf');
    const req = makeRequest({
      authorization: 'Bearer x',
      'x-acting-user': USER_ID,
      'x-acting-user-email': 'not-an-email',
      'x-acting-user-tenant': 'not-a-uuid',
    });
    const reply = makeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, reply as any);
    expect(reply.statusCode).toBeNull();
    const auth = req.serviceAuth as { actingUserEmail?: string; actingUserTenant?: string };
    expect(auth.actingUserEmail).toBeUndefined();
    expect(auth.actingUserTenant).toBeUndefined();
  });
});
