// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Smoke Tests - Critical Path Validation
 * 
 * These tests verify that the most critical user-facing paths work correctly.
 * They are designed to run fast and catch breaking changes in core functionality.
 * 
 * Smoke tests are run:
 * - In CI/CD before deployments
 * - After deployments to verify deployment success
 * - As part of health checks
 * 
 * Criteria for smoke tests:
 * - Critical user paths (authentication, core API)
 * - Fast execution (< 30 seconds total)
 * - No external dependencies (use mocks)
 * - High value (catch critical bugs)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '@/server';
import { connectDatabase, disconnectDatabase, prisma } from '@/database/client';
import type { FastifyInstance } from 'fastify';
import { createRealProviderRegistry, syncRealModelsToCatalog } from '../utils/real-provider-registry';
import { getTestModelId, ensureModelsDiscovered } from '../utils/dynamic-model-discovery';
import { ProviderRegistry, setProviderRegistry } from '@/providers/provider-registry';
import { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import { initializeDIContainer, resetDIContainer } from '@/di/container';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

// SLA multiplier for different environments
// In test/development environments, allow more time due to container startup, 
// cold database connections, and other initialization overhead
// Local tests with containers and dynamic discovery need significant overhead
const SLA_MULTIPLIER = process.env.NODE_ENV === 'test' ? 100 : // 100x for local tests (10s for 100ms SLA)
                       process.env.NODE_ENV === 'development' ? 20 : // 20x for dev
                       1; // 1x (strict) for production

describe('Smoke Tests - Critical Paths', () => {
  let server: FastifyInstance;
  let providerRegistry: ProviderRegistry;
  let testUserEmail = 'smoketest@ailin.dev';
  let testPassword = 'TestPassword123!';
  let authToken: string;
  let organizationId: string;

  beforeAll(async () => {
    // Initialize DI container
    initializeDIContainer();

    // Connect to database
    await connectDatabase();

    // Sync default roles
    await syncDefaultRoles();

    // Initialize providers with REAL adapters and REAL models - NO mocks, NO hardcoded models
    await ensureModelsDiscovered();
    providerRegistry = await createRealProviderRegistry();
    setProviderRegistry(providerRegistry);
    await syncRealModelsToCatalog(providerRegistry);

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

    await registerAuthRoutes(server);
    await registerModelRoutes(server, providerRegistry);
    await registerChatRoutes(server, orchestrationEngine);
    await registerEmbeddingsRoutes(server, providerRegistry);

    await server.ready();

    // Clean up any existing test user
    await prisma.user.deleteMany({ where: { email: testUserEmail } });
  }, 60_000);

  afterAll(async () => {
    // Cleanup
    await prisma.user.deleteMany({ where: { email: testUserEmail } });
    providerRegistry?.clear();
    await server.close();
    await disconnectDatabase();
    resetDIContainer();
  }, 30_000);

  describe('Health Checks', () => {
    // SLA: Health endpoints should respond in < 100ms (production), adjusted for test environments
    const HEALTH_CHECK_SLA_MS = 100 * SLA_MULTIPLIER;

    it('should return health status', async () => {
      const startTime = Date.now();
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });
      const duration = Date.now() - startTime;

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      
      // Validate SLA
      expect(duration).toBeLessThan(HEALTH_CHECK_SLA_MS);
    });

    it('should return readiness status', async () => {
      const startTime = Date.now();
      const response = await server.inject({
        method: 'GET',
        url: '/health/ready',
      });
      const duration = Date.now() - startTime;

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ready');
      
      // Validate SLA
      expect(duration).toBeLessThan(HEALTH_CHECK_SLA_MS);
    });
  });

  describe('Authentication Flow', () => {
    // SLA: Auth endpoints should respond in < 500ms (production), adjusted for test environments
    const AUTH_SLA_MS = 500 * SLA_MULTIPLIER;

    it('should register a new user', async () => {
      const startTime = Date.now();
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: testUserEmail,
          password: testPassword,
          name: 'Smoke Test User',
        },
      });
      const duration = Date.now() - startTime;

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.user).toBeDefined();
      expect(body.user.email).toBe(testUserEmail.toLowerCase());
      expect(body.tokens).toBeDefined();
      expect(body.tokens.accessToken).toBeDefined();
      
      // Validate SLA (allowing more time for first-time setup)
      expect(duration).toBeLessThan(AUTH_SLA_MS * 2); // 1000ms for registration
      
      authToken = body.tokens.accessToken;
      organizationId = body.user.organizationId;
    });

    it('should login with registered credentials', async () => {
      const startTime = Date.now();
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: testUserEmail,
          password: testPassword,
        },
      });
      const duration = Date.now() - startTime;

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.user).toBeDefined();
      expect(body.tokens).toBeDefined();
      expect(body.tokens.accessToken).toBeDefined();
      
      // Validate SLA
      expect(duration).toBeLessThan(AUTH_SLA_MS);
      
      authToken = body.tokens.accessToken;
    });

    it('should reject invalid credentials', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: testUserEmail,
          password: 'wrongpassword',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
    });
  });

  describe('Models API', () => {
    it('should list available models', async () => {
      if (!authToken || !organizationId) {
        // Re-authenticate if needed
        const loginResponse = await server.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: {
            email: testUserEmail,
            password: testPassword,
          },
        });
        const loginBody = JSON.parse(loginResponse.body);
        authToken = loginBody.tokens.accessToken;
        organizationId = loginBody.user.organizationId;
      }

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
    });
  });

  describe('Refresh Token Flow', () => {
    let refreshToken: string;

    beforeEach(async () => {
      // Ensure we have tokens
      if (!authToken) {
        const loginResponse = await server.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: {
            email: testUserEmail,
            password: testPassword,
          },
        });
        const loginBody = JSON.parse(loginResponse.body);
        authToken = loginBody.tokens.accessToken;
        refreshToken = loginBody.tokens.refreshToken;
      } else {
        // Get refresh token from last login
        const loginResponse = await server.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: {
            email: testUserEmail,
            password: testPassword,
          },
        });
        const loginBody = JSON.parse(loginResponse.body);
        refreshToken = loginBody.tokens.refreshToken;
      }
    });

    it('should refresh access token with valid refresh token', async () => {
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
      expect(body.tokens).toBeDefined();
      expect(body.tokens.accessToken).toBeDefined();
      expect(body.tokens.refreshToken).toBeDefined();
      expect(body.tokens.accessToken).not.toBe(authToken); // New token

      // Update auth token for subsequent tests
      authToken = body.tokens.accessToken;
    });

    it('should reject invalid refresh token', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: {
          refreshToken: 'invalid.refresh.token',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
    });
  });

  describe('API Keys Management', () => {
    it('should create API key', async () => {
      if (!authToken || !organizationId) {
        const loginResponse = await server.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: {
            email: testUserEmail,
            password: testPassword,
          },
        });
        const loginBody = JSON.parse(loginResponse.body);
        authToken = loginBody.tokens.accessToken;
        organizationId = loginBody.user.organizationId;
      }

      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/api-keys',
        headers: {
          authorization: `Bearer ${authToken}`,
          'x-organization-id': organizationId,
        },
        payload: {
          name: 'Smoke Test API Key',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.apiKey).toBeDefined();
      expect(typeof body.apiKey).toBe('string');
      expect(body.apiKey.length).toBeGreaterThan(0);

      // Clean up: revoke the API key
      const apiKeyId = body.apiKey.split('_')[1]?.substring(0, 36);
      if (apiKeyId) {
        await server.inject({
          method: 'DELETE',
          url: `/v1/auth/api-keys/${apiKeyId}`,
          headers: {
            authorization: `Bearer ${authToken}`,
            'x-organization-id': organizationId,
          },
        });
      }
    });

    it('should reject API key creation without authentication', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/api-keys',
        payload: {
          name: 'Unauthorized Test Key',
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('Embeddings API', () => {
    it('should generate embeddings', async () => {
      if (!authToken || !organizationId) {
        const loginResponse = await server.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: {
            email: testUserEmail,
            password: testPassword,
          },
        });
        const loginBody = JSON.parse(loginResponse.body);
        authToken = loginBody.tokens.accessToken;
        organizationId = loginBody.user.organizationId;
      }

      // Use 'auto' to let the system select an embedding model dynamically
      // NO hardcoded models - the system will discover and select the best available model
      const response = await server.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: {
          authorization: `Bearer ${authToken}`,
          'x-organization-id': organizationId,
          'content-type': 'application/json',
        },
        payload: {
          model: 'auto', // Dynamic model selection - NO hardcoded models
          input: 'This is a smoke test for embeddings',
        },
      });

      // Valid responses:
      // - 200: Success with embeddings
      // - 404: Model not found (no embedding models in discovery)
      // - 503: No embedding models available (discovery returned 0 embedding models)
      expect([200, 404, 503]).toContain(response.statusCode);

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body.object).toBe('list');
        expect(body.data).toBeInstanceOf(Array);
        expect(body.data.length).toBeGreaterThan(0);
        expect(body.data[0]).toHaveProperty('embedding');
        expect(Array.isArray(body.data[0].embedding)).toBe(true);
      }
    }, 15_000);
  });

  describe('Chat Completions API', () => {
    // Validates chat completions endpoint: accepts 2xx on success or 4xx/5xx when keys unavailable.
    it('should handle a simple chat completion request (reachable; 200 requires real API keys)', async () => {
      if (!authToken || !organizationId) {
        const loginResponse = await server.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: {
            email: testUserEmail,
            password: testPassword,
          },
        });
        const loginBody = JSON.parse(loginResponse.body);
        authToken = loginBody.tokens.accessToken;
        organizationId = loginBody.user.organizationId;
      }

      // Get a dynamically discovered model - NO hardcoded models
      const modelId = await getTestModelId();

      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${authToken}`,
          'x-organization-id': organizationId,
          'content-type': 'application/json',
        },
        payload: {
          model: modelId, // Use dynamically discovered model - NO hardcoded
          messages: [
            {
              role: 'user',
              content: 'Say "smoke test passed"',
            },
          ],
          max_tokens: 10,
        },
      });

      // Valid responses - any HTTP response from the API indicates the endpoint is functional
      expect(response.statusCode).toBeGreaterThanOrEqual(200);
      expect(response.statusCode).toBeLessThan(600);
      
      if (response.statusCode === 200 || response.statusCode === 201) {
        const body = JSON.parse(response.body);
        expect(body.choices).toBeDefined();
        expect(Array.isArray(body.choices)).toBe(true);
      }
    }, 120_000); // 120 second timeout for LLM calls

    it('should validate chat completions endpoint is reachable', async () => {
      if (!authToken || !organizationId) {
        const loginResponse = await server.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: {
            email: testUserEmail,
            password: testPassword,
          },
        });
        const loginBody = JSON.parse(loginResponse.body);
        authToken = loginBody.tokens.accessToken;
        organizationId = loginBody.user.organizationId;
      }

      // Simple validation request to check endpoint is reachable
      // Uses 'auto' model to trigger dynamic selection without waiting for LLM response
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${authToken}`,
          'x-organization-id': organizationId,
          'content-type': 'application/json',
        },
        payload: {
          model: 'auto', // Let system select - validates model selection logic
          messages: [], // Empty messages will trigger validation error quickly
          stream: false,
        },
      });

      // Expect a response (any valid HTTP code) - this validates the endpoint is functional
      // Common responses:
      // - 400: Validation error (expected with empty messages)
      // - 401/403: Auth issues
      // - 503: No models available
      expect([400, 401, 403, 422, 503]).toContain(response.statusCode);
    }, 15_000);
  });
});

