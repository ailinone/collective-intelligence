// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import inputValidationMiddleware from '../../src/api/middleware/input-validation.js';

// Type for request with tenant context
interface RequestWithTenant extends FastifyRequest {
  tenantContext?: {
    organizationId: string;
    userId?: string;
  };
}

async function createApp(options: {
  tenantContext?: { organizationId: string; userId?: string };
} = {}): Promise<FastifyInstance> {
  const instance = Fastify();

  if (options.tenantContext) {
    instance.addHook('onRequest', async (request: RequestWithTenant) => {
      request.tenantContext = options.tenantContext;
    });
  }

  await inputValidationMiddleware(instance);
  instance.get('/v1/usage/stats', async (request: RequestWithTenant) => ({
    ok: true,
    headerOrgId: request.headers['x-organization-id'],
    tenantContext: request.tenantContext,
  }));

  await instance.ready();

  return instance;
}

describe('Input Validation Middleware - Tenant Guardrail', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('rejects when organization header mismatches tenant context', async () => {
    app = await createApp({
      tenantContext: {
        organizationId: '11111111-1111-4111-8111-111111111111',
        userId: 'user-abc',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/usage/stats',
      headers: {
        'x-organization-id': '22222222-2222-4222-8222-222222222222',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: 'organization_mismatch',
      },
    });
  });

  it('accepts when tenant context provides organization ID with no header', async () => {
    app = await createApp({
      tenantContext: {
        organizationId: '11111111-1111-4111-8111-111111111111',
        userId: 'user-abc',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/usage/stats',
    });

    expect(response.statusCode).toBe(200);
  });

  it('validates organization header format when tenant context absent', async () => {
    app = await createApp();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/usage/stats',
      headers: {
        'x-organization-id': 'not-a-uuid',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'invalid_organization_id',
      },
    });
  });

  it('accepts x-tenant-id alias when it matches tenant context', async () => {
    app = await createApp({
      tenantContext: {
        organizationId: '33333333-3333-4333-8333-333333333333',
        userId: 'user-abc',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/usage/stats',
      headers: {
        'x-tenant-id': '33333333-3333-4333-8333-333333333333',
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects x-tenant-id alias when it mismatches tenant context', async () => {
    app = await createApp({
      tenantContext: {
        organizationId: '33333333-3333-4333-8333-333333333333',
        userId: 'user-abc',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/usage/stats',
      headers: {
        'x-tenant-id': '44444444-4444-4444-8444-444444444444',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: 'organization_mismatch',
      },
    });
  });

  it('validates x-tenant-id format when tenant context absent', async () => {
    app = await createApp();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/usage/stats',
      headers: {
        'x-tenant-id': 'invalid-tenant-id',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'invalid_organization_id',
      },
    });
  });

  it('rejects conflicting x-organization-id and x-tenant-id headers', async () => {
    app = await createApp();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/usage/stats',
      headers: {
        'x-organization-id': '55555555-5555-4555-8555-555555555555',
        'x-tenant-id': '66666666-6666-4666-8666-666666666666',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'organization_header_conflict',
      },
    });
  });
});
