// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration tests for API server
 * Validates end-to-end functionality
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '@/server';
import { connectDatabase, disconnectDatabase, prisma } from '@/database/client';
import { ProviderRegistry, setProviderRegistry } from '@/providers/provider-registry';
import { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import type { FastifyInstance } from 'fastify';
import { createMockProviderRegistry, extractAccessToken, syncMockModelsToCatalog } from '../utils/mock-provider';
import { getAllCatalogModels } from '@/services/model-catalog-service';
import type { Model } from '@/types';

/**
 * Type for model data returned from API endpoints
 */
type ModelResponseData = Partial<Model> & {
  id: string;
  name: string;
  provider: string;
};

describe('API Server Integration Tests', () => {
  let server: FastifyInstance;
  let authToken: string;
  let refreshToken: string;
  let providerRegistry: ProviderRegistry;
  let organizationId: string;

  beforeAll(async () => {
    // Connect to test database
    await connectDatabase();
    const { initializeDIContainer } = await import('@/di/container');
    initializeDIContainer();
    const { syncDefaultRoles } = await import('@/services/rbac-sync-service');
    await syncDefaultRoles();
    const roleCount = await prisma.role.count();
    if (roleCount === 0) {
      throw new Error('Default RBAC roles not seeded');
    }

    // Initialize providers
    providerRegistry = createMockProviderRegistry();
    setProviderRegistry(providerRegistry);
    // Sync mock models to catalog database
    await syncMockModelsToCatalog(providerRegistry);
    const seededModels = await getAllCatalogModels();
    if (seededModels.length === 0) {
      throw new Error('Model catalog synchronization failed');
    }

    // Initialize orchestration engine
    const orchestrationEngine = new OrchestrationEngine({
      providerRegistry,
      defaultStrategy: 'auto',
    });

    // Create server
    server = await createServer();

    // Register routes
    const { registerAuthRoutes } = await import('@/routes/auth/auth-routes');
    const { registerModelRoutes } = await import('@/routes/models/models-routes');
    const { registerChatRoutes } = await import('@/routes/chat/chat-routes');
    const { registerEmbeddingsRoutes } = await import('@/routes/embeddings/embeddings-routes');
    const { registerUsageRoutes } = await import('@/routes/usage/usage-routes');
    const { registerUserRoutes } = await import('@/routes/user/user-routes');

    await registerAuthRoutes(server);
    await registerModelRoutes(server, providerRegistry);
    await registerChatRoutes(server, orchestrationEngine);
    await registerEmbeddingsRoutes(server, providerRegistry);
    await registerUsageRoutes(server);
    await registerUserRoutes(server);

    await server.ready();

    await prisma.user.deleteMany({ where: { email: 'test@ailin.dev' } });

    await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'test@ailin.dev',
        password: 'password123',
        name: 'API Server Tester',
      },
    });
  }, 120_000);

  afterAll(async () => {
    providerRegistry?.clear();
    await prisma.user.deleteMany({ where: { email: 'test@ailin.dev' } });
    await server.close();
    await disconnectDatabase();
    const { resetDIContainer } = await import('@/di/container');
    resetDIContainer();
  }, 60_000);

  describe('Health Checks', () => {
    it('GET /health should return OK', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.version).toBe('0.1.0');
      expect(body.uptime).toBeGreaterThan(0);
    });

    it('GET /health/ready should return ready', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ready');
    });

    it('GET /health/live should return alive', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health/live',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('alive');
    });
  });

  describe('Authentication', () => {
    it('POST /v1/auth/login should authenticate user and return JWT', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'test@ailin.dev',
          password: 'password123',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.tokens).toBeDefined();
      expect(body.tokens.accessToken).toBeDefined();
      expect(body.tokens.refreshToken).toBeDefined();
      expect(body.tokens.expiresIn).toBeGreaterThan(0);
      expect(body.user.email).toBe('test@ailin.dev');
      expect(body.user).toHaveProperty('organizationId');

      // Save tokens for subsequent tests
      authToken = body.tokens.accessToken;
      refreshToken = body.tokens.refreshToken;
      organizationId = body.user.organizationId;
    });

    it('POST /v1/auth/login should reject invalid credentials', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'test@ailin.dev',
          password: 'wrong',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Authentication Failed');
      expect(body.message).toBe('Invalid email or password');
    });

    it('POST /v1/auth/refresh should refresh token', async () => {
      expect(refreshToken).toBeDefined();

      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: {
          refreshToken,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.tokens?.accessToken).toBeDefined();
      expect(body.tokens?.refreshToken).toBeDefined();
      expect(body.tokens?.accessToken).not.toBe(authToken);

      authToken = body.tokens.accessToken;
      refreshToken = body.tokens.refreshToken;
    });
  });

  describe('Models API', () => {
    beforeAll(async () => {
      // Ensure we have auth token
      if (!authToken) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: {
            email: 'test@ailin.dev',
            password: 'password123',
          },
        });
        const body = JSON.parse(response.body);
        authToken = extractAccessToken(body);
        refreshToken = body?.tokens?.refreshToken ?? refreshToken;
      }
    });

    it('GET /v1/models/list should return all available models', async () => {
      expect(authToken).toBeDefined();
      expect(organizationId).toBeDefined();

      const response = await server.inject({
        method: 'GET',
        url: '/v1/models/list',
        headers: {
          authorization: `Bearer ${authToken}`,
          'x-organization-id': organizationId,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.object).toBe('list');
      expect(body.data).toBeInstanceOf(Array);
      expect(body.data.length).toBeGreaterThan(0);

      // Validate model structure
      const model = body.data[0];
      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('name');
      expect(model).toHaveProperty('displayName');
      expect(model).toHaveProperty('provider');
      expect(model).toHaveProperty('contextWindow');
      expect(model).toHaveProperty('capabilities');
    });

    it('GET /v1/models/list should include the gpt-5.1 model', async () => {
      expect(authToken).toBeDefined();
      expect(organizationId).toBeDefined();

      const response = await server.inject({
        method: 'GET',
        url: '/v1/models/list',
        headers: {
          authorization: `Bearer ${authToken}`,
          'x-organization-id': organizationId,
        },
      });

      const body = JSON.parse(response.body) as { data: ModelResponseData[] };
      const gpt51 = body.data.find((m: ModelResponseData) => {
        const name = String(m.name ?? '').toLowerCase();
        const id = String(m.id ?? '').toLowerCase();
        return name.includes('gpt-5.1') || id.includes('gpt-5.1');
      });

      expect(gpt51).toBeDefined();
      expect(gpt51).toHaveProperty('provider');
    });

    it('GET /v1/models/list should include the Claude model', async () => {
      expect(authToken).toBeDefined();
      expect(organizationId).toBeDefined();

      const response = await server.inject({
        method: 'GET',
        url: '/v1/models/list',
        headers: {
          authorization: `Bearer ${authToken}`,
          'x-organization-id': organizationId,
        },
      });

      const body = JSON.parse(response.body) as { data: ModelResponseData[] };
      const claude = body.data.find((m: ModelResponseData) => {
        const name = String(m.name ?? '').toLowerCase();
        const id = String(m.id ?? '').toLowerCase();
        return name.includes('claude') || id.includes('claude');
      });

      expect(claude).toBeDefined();
      expect(claude).toHaveProperty('provider');
    });

    it('GET /v1/models/:id should return specific model', async () => {
      // First get list to get a valid ID
      expect(authToken).toBeDefined();
      expect(organizationId).toBeDefined();

      const listResponse = await server.inject({
        method: 'GET',
        url: '/v1/models/list',
        headers: {
          authorization: `Bearer ${authToken}`,
          'x-organization-id': organizationId,
        },
      });

      expect(listResponse.statusCode).toBe(200);
      const listBody = JSON.parse(listResponse.body);
      expect(listBody.data).toBeInstanceOf(Array);
      expect(listBody.data.length).toBeGreaterThan(0);

      const models = listBody.data;
      const modelId = models[0].id;
      expect(modelId).toBeDefined();
      expect(typeof modelId).toBe('string');

      // Get specific model
      const response = await server.inject({
        method: 'GET',
        url: `/v1/models/${modelId}`,
        headers: {
          authorization: `Bearer ${authToken}`,
          'x-organization-id': organizationId,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('id');
      expect(body.id).toBe(modelId);
    });

    it('GET /v1/models/:id should return 404 for invalid model', async () => {
      expect(authToken).toBeDefined();
      expect(organizationId).toBeDefined();

      const response = await server.inject({
        method: 'GET',
        url: '/v1/models/invalid-model-id',
        headers: {
          authorization: `Bearer ${authToken}`,
          'x-organization-id': organizationId,
        },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('model_not_found');
    });
  });

  describe('User API', () => {
    beforeAll(async () => {
      if (!authToken) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: {
            email: 'test@ailin.dev',
            password: 'password123',
          },
        });
        const body = JSON.parse(response.body);
        authToken = extractAccessToken(body);
        refreshToken = body?.tokens?.refreshToken ?? refreshToken;
      }
    });

    it('GET /v1/user/profile should return user profile', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('user');
      expect(body.user).toBeDefined();
      expect(body.user).toHaveProperty('id');
      expect(body.user).toHaveProperty('email', 'test@ailin.dev');
      expect(body.user).toHaveProperty('organizationId');
    });

    it('PUT /v1/user/profile should update profile', async () => {
      const response = await server.inject({
        method: 'PUT',
        url: '/v1/user/profile',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          name: 'Test User',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });
  });

  describe('Usage API', () => {
    beforeAll(async () => {
      if (!authToken) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: {
            email: 'test@ailin.dev',
            password: 'password123',
          },
        });
        const body = JSON.parse(response.body);
        authToken = extractAccessToken(body);
        refreshToken = body?.tokens?.refreshToken ?? refreshToken;
      }
    });

    it('GET /v1/usage/stats should return usage statistics', async () => {
      expect(authToken).toBeDefined();
      expect(organizationId).toBeDefined();

      const response = await server.inject({
        method: 'GET',
        url: '/v1/usage/stats',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('period');
      expect(body).toHaveProperty('requestCount');
      expect(body).toHaveProperty('costUsd');
      expect(body).toHaveProperty('topModels');
      expect(body).toHaveProperty('topStrategies');
    });

    it('GET /v1/usage/stats should support period parameter', async () => {
      expect(authToken).toBeDefined();
      expect(organizationId).toBeDefined();

      const response = await server.inject({
        method: 'GET',
        url: '/v1/usage/stats?period=month',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.period).toBe('month');
    });
  });

  describe('Authentication Protection', () => {
    it('should reject requests without authentication', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/usage/stats',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should reject requests with invalid token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/usage/stats',
        headers: {
          authorization: 'Bearer invalid-token',
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });
});


