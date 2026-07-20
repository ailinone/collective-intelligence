// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Advanced Features Integration Tests
 * Validates function calling, vision, and other advanced capabilities
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '@/server';
import { connectDatabase, disconnectDatabase, prisma } from '@/database/client';
import { ProviderRegistry, setProviderRegistry } from '@/providers/provider-registry';
import { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import type { FastifyInstance } from 'fastify';
import { createRealProviderRegistry, syncRealModelsToCatalog } from '../utils/real-provider-registry';
import { extractAccessToken } from '../utils/mock-provider';
import { getTestModelId, getTestModelWithCapabilities } from '../utils/dynamic-model-discovery';

describe('Advanced Features - Function Calling & Vision', { timeout: 120_000, hookTimeout: 120_000 }, () => {
  let server: FastifyInstance;
  let authToken: string;
  let organizationId: string;
  let providerRegistry: ProviderRegistry;

  const buildTenantHeaders = () => ({
    authorization: `Bearer ${authToken}`,
    'x-organization-id': organizationId,
  });

  beforeAll(async () => {
    await connectDatabase();

    // Use REAL provider registry with REAL models - NO mocks, NO hardcoded models
    providerRegistry = await createRealProviderRegistry();
    setProviderRegistry(providerRegistry);
    // Models are already synced from dynamic discovery
    await syncRealModelsToCatalog(providerRegistry);

    const orchestrationEngine = new OrchestrationEngine({
      providerRegistry,
      defaultStrategy: 'auto',
    });

    server = await createServer();
    const { tenantIsolationMiddleware } = await import('@/api/middleware/tenant-isolation-middleware');
    server.addHook('preHandler', tenantIsolationMiddleware);

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
        name: 'Advanced Test User',
      },
    });

    // Get auth token
    const loginResponse = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'test@ailin.dev',
        password: 'password123',
      },
    });
    const loginBody = JSON.parse(loginResponse.body);
    authToken = extractAccessToken(loginBody);
    organizationId = loginBody.user?.organizationId as string;
  });

  afterAll(async () => {
    providerRegistry?.clear();
    await prisma.user.deleteMany({ where: { email: 'test@ailin.dev' } });
    await server.close();
    await disconnectDatabase();
  });

  describe('Function Calling (Tools)', () => {
    it('should accept function/tool definitions', async () => {
      // Get a real model with function_calling capability - NO hardcoded models
      const functionCallingModel = await getTestModelWithCapabilities(['function_calling']);
      if (!functionCallingModel) {
        return; // Skip if no models available
      }

      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: buildTenantHeaders(),
        payload: {
          model: functionCallingModel.id, // Use dynamically discovered model with function_calling
          messages: [
            {
              role: 'user',
              content: 'What is the weather in San Francisco?',
            },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get the current weather in a location',
                parameters: {
                  type: 'object',
                  properties: {
                    location: {
                      type: 'string',
                      description: 'The city and state, e.g. San Francisco, CA',
                    },
                    unit: {
                      type: 'string',
                      enum: ['celsius', 'fahrenheit'],
                    },
                  },
                  required: ['location'],
                },
              },
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      
      // Response should be valid
      expect(body.choices).toBeDefined();
      expect(body.choices.length).toBeGreaterThan(0);
      
      // May or may not call the function depending on model's decision
      // But format should be correct if it does
      if (body.choices[0].message.tool_calls) {
        expect(body.choices[0].message.tool_calls).toBeInstanceOf(Array);
        expect(body.choices[0].finish_reason).toBe('tool_calls');
      }
    });

    it('should support tool_choice parameter', async () => {
      // Get a real model with function_calling capability - NO hardcoded models
      const functionCallingModel = await getTestModelWithCapabilities(['function_calling']);
      if (!functionCallingModel) {
        return; // Skip if no models available
      }

      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: buildTenantHeaders(),
        payload: {
          model: functionCallingModel.id, // Use dynamically discovered model
          messages: [{ role: 'user', content: 'Get weather' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
          tool_choice: 'auto',
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should handle tool response messages', async () => {
      // Get a real model with function_calling capability - NO hardcoded models
      const functionCallingModel = await getTestModelWithCapabilities(['function_calling']);
      if (!functionCallingModel) {
        return; // Skip if no models available
      }

      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: buildTenantHeaders(),
        payload: {
          model: functionCallingModel.id, // Use dynamically discovered model
          messages: [
            {
              role: 'user',
              content: 'What is the weather?',
            },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location":"San Francisco"}',
                  },
                },
              ],
            },
            {
              role: 'tool',
              content: '{"temperature": 72, "condition": "sunny"}',
              tool_call_id: 'call_123',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.choices[0].message.content).toBeDefined();
    });
  });

  describe('Vision Support (Multimodal)', () => {
    it('should accept image content in messages', async () => {
      // Get a real model with vision capability - NO hardcoded models
      const visionModel = await getTestModelWithCapabilities(['vision']);
      if (!visionModel) {
        return; // Skip if no models available
      }

      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: buildTenantHeaders(),
        payload: {
          model: visionModel.id, // Use dynamically discovered model with vision
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Describe this image',
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                    detail: 'low',
                  },
                },
              ],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.choices[0].message.content).toBeDefined();
    });
  });

  describe('Response Format Validation', () => {
    it('should match OpenAI API response format exactly', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: buildTenantHeaders(),
        payload: {
          messages: [{ role: 'user', content: 'Test' }],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      
      // OpenAI format validation
      expect(body.object).toBe('chat.completion');
      expect(typeof body.id).toBe('string');
      expect(typeof body.created).toBe('number');
      expect(typeof body.model).toBe('string');
      expect(Array.isArray(body.choices)).toBe(true);
      
      const choice = body.choices[0];
      expect(typeof choice.index).toBe('number');
      expect(choice.message).toBeDefined();
      expect(choice.message.role).toBe('assistant');
      expect(typeof choice.message.content).toBe('string');
      expect(typeof choice.finish_reason).toBe('string');
      
      // Usage should be present
      expect(body.usage).toBeDefined();
      expect(typeof body.usage.prompt_tokens).toBe('number');
      expect(typeof body.usage.completion_tokens).toBe('number');
      expect(typeof body.usage.total_tokens).toBe('number');
    });
  });
});

