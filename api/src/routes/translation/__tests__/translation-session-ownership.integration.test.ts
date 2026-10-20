// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tenant ownership of real-time translation sessions, against a real Redis.
 *
 * DELETE /v1/translation/session/:id used to forward any id straight to
 * Palabra.ai, so any authenticated tenant could tear down another tenant's
 * live call. These tests drive the real routes and the real ownership store
 * (Redis provisioned by tests/global-setup.ts via Testcontainers).
 *
 * Only two boundaries are replaced: the caller identity (an `x-test-org`
 * header becomes the tenant context, standing in for `authenticate`) and the
 * Palabra.ai adapter's two network calls, a paid external API with no sandbox.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { PalabraAIAdapter } from '@/providers/palabraai/palabraai-adapter';
import { getRedisClient } from '@/cache/redis-client';
import {
  TRANSLATION_SESSION_OWNER_TTL_SECONDS,
  recordTranslationSessionOwner,
} from '@/services/translation-session-ownership';

const { palabra } = vi.hoisted(() => ({
  palabra: {
    createTranslationSession: vi.fn(),
    deleteSession: vi.fn(),
  },
}));

vi.mock('@/middleware/auth-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/middleware/auth-middleware')>();
  return {
    ...actual,
    authenticate: vi.fn(async (request: FastifyRequest) => {
      const org = request.headers['x-test-org'];
      if (typeof org === 'string' && org.length > 0) {
        (request as unknown as { tenantContext: { organizationId: string } }).tenantContext = {
          organizationId: org,
        };
      }
    }),
  };
});

vi.mock('@/services/anonymous-quota-gate', () => ({
  rejectAnonymousGuestKeyPreHandler: async () => {},
}));
vi.mock('@/services/free-tier-quota-gate', () => ({
  rejectChatFreeTierKeyPreHandler: async () => {},
}));

vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({
    get: (name: string) => {
      if (name !== 'palabraai') return undefined;
      const adapter = Object.create(PalabraAIAdapter.prototype) as PalabraAIAdapter;
      adapter.createTranslationSession = palabra.createTranslationSession;
      adapter.deleteSession = palabra.deleteSession;
      return adapter;
    },
  }),
}));

import { registerTranslationRoutes } from '@/routes/translation/translation-routes';

const ORG_A = 'org-translation-owner-a';
const ORG_B = 'org-translation-owner-b';
const OWNER_KEY_PREFIX = 'translation:session-owner:';

let app: FastifyInstance;
let sessionCounter = 0;

function nextSessionId(): string {
  sessionCounter += 1;
  return `tr-ownership-test-${Date.now()}-${sessionCounter}`;
}

async function clearOwnerKeys(): Promise<void> {
  const redis = getRedisClient();
  const keys = await redis.keys(`${OWNER_KEY_PREFIX}tr-ownership-test-*`);
  if (keys.length > 0) await redis.del(...keys);
}

function sessionPayloadFor(sessionId: string) {
  return {
    sessionId,
    webrtcUrl: 'wss://livekit.example.invalid',
    publisherToken: 'publisher-token',
    roomName: sessionId,
    translationConfig: {},
    languages: { source: 'pt', targets: ['en'] },
  };
}

async function createSession(org: string, sessionId: string) {
  palabra.createTranslationSession.mockResolvedValueOnce(sessionPayloadFor(sessionId));
  return app.inject({
    method: 'POST',
    url: '/v1/translation/session',
    headers: { 'x-test-org': org },
    payload: { sourceLanguage: 'pt', targetLanguages: ['en'] },
  });
}

describe('translation session ownership (real Redis)', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerTranslationRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await clearOwnerKeys();
    await app.close();
  });

  beforeEach(async () => {
    palabra.createTranslationSession.mockReset();
    palabra.deleteSession.mockReset();
    palabra.deleteSession.mockResolvedValue(undefined);
    await clearOwnerKeys();
  });

  it('records the creating organization as owner, with an expiry', async () => {
    const sessionId = nextSessionId();
    const res = await createSession(ORG_A, sessionId);

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).session.id).toBe(sessionId);

    const redis = getRedisClient();
    expect(await redis.get(`${OWNER_KEY_PREFIX}${sessionId}`)).toBe(ORG_A);
    const ttl = await redis.ttl(`${OWNER_KEY_PREFIX}${sessionId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(TRANSLATION_SESSION_OWNER_TTL_SECONDS);
  });

  it("never deletes another organization's session, answering the documented idempotent 200", async () => {
    const sessionId = nextSessionId();
    expect((await createSession(ORG_A, sessionId)).statusCode).toBe(201);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/translation/session/${sessionId}`,
      headers: { 'x-test-org': ORG_B },
    });

    // Same body as a genuinely unknown id: no signal that the session is live.
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ deleted: true, sessionId });
    expect(palabra.deleteSession).not.toHaveBeenCalled();
    expect(await getRedisClient().get(`${OWNER_KEY_PREFIX}${sessionId}`)).toBe(ORG_A);
  });

  it('lets the owning organization delete its session and drops the ownership record', async () => {
    const sessionId = nextSessionId();
    expect((await createSession(ORG_A, sessionId)).statusCode).toBe(201);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/translation/session/${sessionId}`,
      headers: { 'x-test-org': ORG_A },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ deleted: true, sessionId });
    expect(palabra.deleteSession).toHaveBeenCalledWith(sessionId);
    expect(await getRedisClient().get(`${OWNER_KEY_PREFIX}${sessionId}`)).toBeNull();
  });

  it('treats a session id with no ownership record as already gone (idempotent 200, no provider call)', async () => {
    const sessionId = nextSessionId();
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/translation/session/${sessionId}`,
      headers: { 'x-test-org': ORG_A },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ deleted: true, sessionId });
    expect(palabra.deleteSession).not.toHaveBeenCalled();
  });

  it('discards the Palabra session and answers 503 when ownership cannot be recorded', async () => {
    const sessionId = nextSessionId();
    // Pre-existing record for another organization: the NX write must not
    // silently hand the session to the new caller.
    await recordTranslationSessionOwner(sessionId, ORG_B);

    const res = await createSession(ORG_A, sessionId);

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.payload).error.code).toBe('translation_session_ownership_unavailable');
    expect(palabra.deleteSession).toHaveBeenCalledWith(sessionId);
    expect(await getRedisClient().get(`${OWNER_KEY_PREFIX}${sessionId}`)).toBe(ORG_B);
  });

  it('rejects create and delete without an organization context (401, as documented for invalid auth)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/translation/session',
      payload: { sourceLanguage: 'pt', targetLanguages: ['en'] },
    });
    expect(create.statusCode).toBe(401);
    expect(palabra.createTranslationSession).not.toHaveBeenCalled();

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/translation/session/${nextSessionId()}`,
    });
    expect(del.statusCode).toBe(401);
    expect(palabra.deleteSession).not.toHaveBeenCalled();
  });
});
