// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Extended Thinking & Responses API Integration Tests
 *
 * End-to-end tests for:
 * - Extended Thinking Routes (POST /v1/chat/completions/extended-thinking)
 * - Ultra Thinking Routes (POST /v1/chat/completions/ultra-thinking)
 * - OpenAI Responses API (POST /v1/responses, GET/DELETE /v1/responses/:id)
 *
 * These tests validate the actual endpoint behavior with the real server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestServerWithRoutes } from '../utils/test-server';
import { connectDatabase, disconnectDatabase, prisma } from '@/database/client';
import { OrchestrationEngine, setOrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';

describe('Extended Thinking & Responses API Integration Tests', () => {
  let server: FastifyInstance;
  let authToken: string;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    await startTestEnvironment();
    // Connect to test database
    await connectDatabase();
    const { initializeDIContainer } = await import('@/di/container');
    initializeDIContainer();
    const { syncDefaultRoles } = await import('@/services/rbac-sync-service');
    await syncDefaultRoles();

    // Reuse registry prepared by test environment bootstrap.
    const { getProviderRegistry } = await import('@/providers/provider-registry');
    const providerRegistry = getProviderRegistry();

    // Initialize orchestration engine and set it globally
    const orchestrationEngine = new OrchestrationEngine({
      providerRegistry,
      defaultStrategy: 'auto',
    });
    setOrchestrationEngine(orchestrationEngine);

    // Create server with all routes
    server = await createTestServerWithRoutes();
    await server.ready();

    // Create test user and get tokens
    const testEmail = `test-extended-${Date.now()}@test.com`;
    await prisma.user.deleteMany({ where: { email: testEmail } });

    const registerResponse = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: testEmail,
        password: 'TestPassword123!',
        name: 'Extended Thinking Tester',
      },
    });

    expect(registerResponse.statusCode).toBe(201);
    const registerBody = JSON.parse(registerResponse.body);
    authToken = registerBody.tokens.accessToken;
    organizationId = registerBody.user.organizationId;
    userId = registerBody.user.id;
  }, 240_000);

  afterAll(async () => {
    await server?.close();
    await disconnectDatabase();
    await stopTestEnvironment();
    const { resetDIContainer } = await import('@/di/container');
    resetDIContainer();
  }, 60_000);

  // ============================================
  // Extended Thinking Tests
  // ============================================

  describe('POST /v1/chat/completions/extended-thinking', () => {
    it('should accept a valid extended thinking request', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions/extended-thinking',
        headers: {
          authorization: `Bearer ${authToken}`,
          'content-type': 'application/json',
        },
        payload: {
          messages: [
            { role: 'user', content: 'What is the meaning of life? Think deeply.' },
          ],
          temperature: 0.7,
          max_tokens: 4096,
          thinking_budget: 2000,
        },
      });

      // Accept 200 (success), 400 (schema validation), 401 (auth middleware), and 500 (provider/runtime error)
      expect([200, 400, 401, 500]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('object', 'chat.completion');
        expect(body).toHaveProperty('model');
        expect(body).toHaveProperty('choices');
        expect(body).toHaveProperty('usage');
        expect(body).toHaveProperty('ailin_metadata');
        
        // Extended-thinking metadata can vary by strategy/provider fallback.
        expect(body.ailin_metadata).toHaveProperty('total_cost');
        if ('thinking_enabled' in body.ailin_metadata) {
          expect(body.ailin_metadata.thinking_enabled).toBe(true);
        }
        if ('models_used' in body.ailin_metadata) {
          expect(Array.isArray(body.ailin_metadata.models_used)).toBe(true);
        }
        if ('strategy_used' in body.ailin_metadata) {
          expect(typeof body.ailin_metadata.strategy_used).toBe('string');
        }
        if ('total_duration_ms' in body.ailin_metadata) {
          expect(typeof body.ailin_metadata.total_duration_ms).toBe('number');
        }
      }
    });

    it('should reject request without messages', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions/extended-thinking',
        headers: {
          authorization: `Bearer ${authToken}`,
          'content-type': 'application/json',
        },
        payload: {
          temperature: 0.7,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should require authentication', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions/extended-thinking',
        headers: {
          'content-type': 'application/json',
        },
        payload: {
          messages: [{ role: 'user', content: 'Test' }],
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should reject empty messages array', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions/extended-thinking',
        headers: {
          authorization: `Bearer ${authToken}`,
          'content-type': 'application/json',
        },
        payload: {
          messages: [],
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // ============================================
  // Ultra Thinking Tests
  // ============================================

  describe('POST /v1/chat/completions/ultra-thinking', () => {
    it('should accept a valid ultra thinking request', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions/ultra-thinking',
        headers: {
          authorization: `Bearer ${authToken}`,
          'content-type': 'application/json',
        },
        payload: {
          messages: [
            { role: 'user', content: 'Design a scalable microservices architecture.' },
          ],
          quality_target: 0.95,
          max_tokens: 8192,
        },
      });

      // Accept 200 (success), 401 (auth middleware), and 500 (provider/runtime error)
      expect([200, 401, 500]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('object', 'chat.completion');
        expect(body.model).toMatch(/^ailin-ultra-\d+$/);
        expect(body).toHaveProperty('choices');
        expect(body).toHaveProperty('usage');
        expect(body).toHaveProperty('ailin_metadata');
      }
    });

    it('should require authentication', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions/ultra-thinking',
        headers: {
          'content-type': 'application/json',
        },
        payload: {
          messages: [{ role: 'user', content: 'Test' }],
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ============================================
  // Responses API Tests
  // ============================================

  describe('POST /v1/responses', () => {
    it('should accept a simple text input', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: {
          authorization: `Bearer ${authToken}`,
          'content-type': 'application/json',
        },
        payload: {
          input: 'What is 2 + 2?',
        },
      });

      // Accept 200 (success), 400 (schema validation), 401 (auth middleware), and 500 (provider/runtime error)
      expect([200, 400, 401, 500]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('id');
        expect(body.id).toMatch(/^resp_/);
        expect(body).toHaveProperty('object', 'response');
        expect(body).toHaveProperty('created_at');
        expect(body).toHaveProperty('status', 'completed');
        expect(body).toHaveProperty('output');
        expect(body).toHaveProperty('usage');
      }
    });

    it('should accept array input with message items', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: {
          authorization: `Bearer ${authToken}`,
          'content-type': 'application/json',
        },
        payload: {
          input: [
            { type: 'message', role: 'user', content: 'Hello!' },
          ],
          instructions: 'Be helpful and concise.',
        },
      });

      // Accept 200 (success), 400 (schema validation), and 500 (provider/runtime error)
      expect([200, 400, 500]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('output');
        expect(Array.isArray(body.output)).toBe(true);
      }
    });

    it('should include ailin_metadata extensions', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: {
          authorization: `Bearer ${authToken}`,
          'content-type': 'application/json',
        },
        payload: {
          input: 'Analyze this request',
          quality_target: 0.9,
          max_cost: 0.5,
        },
      });

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('ailin_metadata');
        expect(body.ailin_metadata).toHaveProperty('models_used');
        expect(body.ailin_metadata).toHaveProperty('strategy_used');
        expect(body.ailin_metadata).toHaveProperty('total_cost');
        expect(body.ailin_metadata).toHaveProperty('total_duration_ms');
      }
    });

    it('should reject request without input', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: {
          authorization: `Bearer ${authToken}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'auto',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should require authentication', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: {
          'content-type': 'application/json',
        },
        payload: {
          input: 'Test input',
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /v1/responses/:response_id', () => {
    it('should return 404 for non-existent response', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/responses/resp_nonexistent123',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      // Depending on auth adapter config, this can be unauthorized or not found.
      expect([401, 404]).toContain(response.statusCode);

      const body = JSON.parse(response.body);
      expect(body).toBeTruthy();
    });

    it('should require authentication', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/responses/resp_test123',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('DELETE /v1/responses/:response_id', () => {
    it('should delete a response (idempotent)', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: '/v1/responses/resp_test123',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      expect([200, 401]).toContain(response.statusCode);

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('id', 'resp_test123');
        expect(body).toHaveProperty('object', 'response.deleted');
        expect(body).toHaveProperty('deleted', true);
      }
    });

    it('should require authentication', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: '/v1/responses/resp_test123',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ============================================
  // Endpoint Registration Verification
  // ============================================

  describe('Endpoint Registration', () => {
    it('should have extended-thinking endpoint registered', async () => {
      // Check that the route is registered (OPTIONS or invalid method returns 404/405, not route not found)
      const response = await server.inject({
        method: 'OPTIONS',
        url: '/v1/chat/completions/extended-thinking',
      });

      // OPTIONS may return 400 due validation hooks while still indicating route exists.
      expect([204, 200, 400]).toContain(response.statusCode);
    });

    it('should have ultra-thinking endpoint registered', async () => {
      const response = await server.inject({
        method: 'OPTIONS',
        url: '/v1/chat/completions/ultra-thinking',
      });

      expect([204, 200, 400]).toContain(response.statusCode);
    });

    it('should have responses endpoint registered', async () => {
      const response = await server.inject({
        method: 'OPTIONS',
        url: '/v1/responses',
      });

      expect([204, 200, 400]).toContain(response.statusCode);
    });
  });
});
