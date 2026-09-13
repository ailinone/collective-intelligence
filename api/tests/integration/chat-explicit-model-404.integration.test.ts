// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Route-level regression for silent substitution of a NON-EXISTENT model.
 *
 * Measured before the fix: `POST /v1/chat/completions` with
 * `"model": "definitely-not-a-real-model-xyz"` returned 200, served by a
 * dynamically selected model. The pin was carried only as a hint, and every
 * consumer of that hint treated "not in the pool" as a reason to fall through
 * to automatic selection.
 *
 * The guard runs at the route edge, BEFORE the quota / governance / wallet
 * gates, so these assertions need no provider adapters and no wallet balance —
 * only a real catalog to resolve against.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { createTestServerWithRoutes } from '../utils/test-server';
import { prisma } from '@/database/client';
import { computeModelUid } from '@/database/model-uid';

const PROVIDER_ID = 'explicit-model-404-probe';
const REAL_MODEL_ID = 'explicit-model-404-probe/known-model';
const UNKNOWN_MODEL_ID = 'definitely-not-a-real-model-xyz';

describe('POST /v1/chat/completions — explicit model must exist', () => {
  let server: FastifyInstance;
  let authToken: string;

  beforeAll(async () => {
    server = await createTestServerWithRoutes();
    await server.ready();

    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    await prisma.provider.deleteMany({ where: { id: PROVIDER_ID } });
    await prisma.provider.create({
      data: {
        id: PROVIDER_ID,
        name: PROVIDER_ID,
        displayName: 'Explicit Model 404 Probe',
        status: 'active',
      },
    });
    await prisma.model.create({
      data: {
        uid: computeModelUid(PROVIDER_ID, REAL_MODEL_ID),
        id: REAL_MODEL_ID,
        providerId: PROVIDER_ID,
        name: REAL_MODEL_ID,
        displayName: REAL_MODEL_ID,
        contextWindow: 8192,
        maxOutputTokens: 4096,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        capabilities: ['chat', 'text_generation'],
        performance: {},
        status: 'active',
        metadata: {},
      },
    });

    const email = `explicit-model-404-${nanoid(8)}@example.com`;
    const registerResponse = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email,
        password: 'TestPassword123!',
        name: 'Explicit Model Probe',
        organizationName: `explicit-model-404-${nanoid(6)}`,
      },
    });
    expect(registerResponse.statusCode).toBe(201);
    authToken = JSON.parse(registerResponse.body).tokens.accessToken;
  }, 180_000);

  afterAll(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    await prisma.provider.deleteMany({ where: { id: PROVIDER_ID } });
    await server.close();
  }, 60_000);

  const post = (payload: Record<string, unknown>) =>
    server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        messages: [{ role: 'user', content: 'how much is 17 x 23?' }],
        ...payload,
      },
    });

  it('returns 404 model_not_found for an id that exists in no provider', async () => {
    const response = await post({ model: UNKNOWN_MODEL_ID });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.param).toBe('model');
    expect(body.error.message).toContain(UNKNOWN_MODEL_ID);
  });

  it('returns the same 404 on the streaming path, before any SSE frame', async () => {
    const response = await post({ model: UNKNOWN_MODEL_ID, stream: true });

    expect(response.statusCode).toBe(404);
    // A JSON error body, not a half-open text/event-stream.
    expect(response.headers['content-type']).toContain('application/json');
    expect(JSON.parse(response.body).error.code).toBe('model_not_found');
  });

  it('does not reject a model that exists in the catalog', async () => {
    // It may still fail further down (no adapter is registered for the probe
    // provider) — the assertion is only that it is not rejected as unknown.
    const response = await post({ model: REAL_MODEL_ID });

    if (response.statusCode === 404) {
      expect(JSON.parse(response.body).error?.code).not.toBe('model_not_found');
    }
  });

  it('does not reject model:"auto"', async () => {
    const response = await post({ model: 'auto' });

    if (response.statusCode === 404) {
      expect(JSON.parse(response.body).error?.code).not.toBe('model_not_found');
    }
  });

  it('does not reject a request that omits model entirely', async () => {
    const response = await post({});

    if (response.statusCode === 404) {
      expect(JSON.parse(response.body).error?.code).not.toBe('model_not_found');
    }
  });
});
