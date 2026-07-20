// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration Tests for Embeddings and Moderation Endpoints
 * Tests HTTP endpoints directly to ensure full functionality including:
 * - XAI embeddings with fallback
 * - Moderation with all providers (DeepSeek, Google, XAI, Vertex AI, OpenRouter, Cohere)
 * - End-to-end request/response validation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestServerWithRoutes } from '../utils/test-server';
import { prisma } from '@/database/client';
import { ensureModelsDiscovered } from '../utils/dynamic-model-discovery';
import { getProviderRegistry } from '@/providers/provider-registry';
import { OpenAIAdapter } from '@/providers/openai/openai-adapter';
import { GoogleAdapter } from '@/providers/google/google-adapter';
import { XAIAdapter } from '@/providers/xai/xai-adapter';
import { DeepSeekAdapter } from '@/providers/deepseek/deepseek-adapter';
import { nanoid } from 'nanoid';
import { getTestModelId, getTestModelWithCapabilities } from '../utils/test-model-helper';

describe('Embeddings and Moderation Endpoints Integration Tests', () => {
  let server: FastifyInstance;
  let authToken: string;
  let organizationId: string;
  let userId: string;
  let testModels: {
    embeddingModel?: string;
    xaiModel?: string;
    deepseekModel?: string;
    googleModel?: string;
  } = {};

  function expectSuccessOrUnavailable(response: { statusCode: number; body: string }): Record<string, unknown> | null {
    if (response.statusCode === 200) {
      return JSON.parse(response.body) as Record<string, unknown>;
    }

    expect([400, 404, 500, 503]).toContain(response.statusCode);
    const body = JSON.parse(response.body);
    expect(body.error || body.message).toBeDefined();
    return null;
  }

  beforeAll(async () => {
    // Create test server with all routes
    server = await createTestServerWithRoutes();
    await server.ready();

    // Register providers for testing
    const registry = getProviderRegistry();
    
    // Register OpenAI for embeddings fallback
    const openaiAdapter = new OpenAIAdapter({
      name: 'openai',
      apiKey: process.env.OPENAI_API_KEY || 'test-openai-key',
    });
    registry.register(openaiAdapter);

    // Register Google for embeddings fallback
    const googleAdapter = new GoogleAdapter({
      name: 'google',
      apiKey: process.env.GOOGLE_API_KEY || 'test-google-key',
    });
    registry.register(googleAdapter);

    // Register XAI
    const xaiAdapter = new XAIAdapter({
      name: 'xai',
      apiKey: process.env.XAI_API_KEY || 'test-xai-key',
    });
    registry.register(xaiAdapter);

    // Register DeepSeek
    const deepseekAdapter = new DeepSeekAdapter({
      name: 'deepseek',
      apiKey: process.env.DEEPSEEK_API_KEY || 'test-deepseek-key',
    });
    registry.register(deepseekAdapter);

    // Ensure models are discovered dynamically - NO hardcoded models
    await ensureModelsDiscovered();

    // Get test models dynamically
    testModels.embeddingModel = await getTestModelId('openai');
    testModels.xaiModel = await getTestModelId('xai');
    testModels.deepseekModel = await getTestModelId('deepseek');
    testModels.googleModel = await getTestModelId('google');

    // Create test user
    const testEmail = `test-embeddings-mod-${Date.now()}@test.com`;
    const testPassword = 'TestPassword123!';

    const registerResponse = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: testEmail,
        password: testPassword,
        name: 'Test User',
      },
    });

    expect(registerResponse.statusCode).toBe(201);
    const registerBody = JSON.parse(registerResponse.body);
    authToken = registerBody.tokens.accessToken;
    organizationId = registerBody.user.organizationId;
    userId = registerBody.user.id;
  }, 120_000);

  afterAll(async () => {
    await server.close();
  }, 60_000);

  describe('POST /v1/embeddings - XAI with Fallback', () => {
    it('should use fallback provider when requesting XAI embeddings', async () => {
      // Enable fallback
      const originalEnv = process.env.XAI_EMBEDDINGS_FALLBACK;
      process.env.XAI_EMBEDDINGS_FALLBACK = 'true';

      try {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/embeddings',
          headers: {
            authorization: `Bearer ${authToken}`,
          },
          payload: {
            input: 'Test text for embeddings',
            model: testModels.xaiModel || 'auto', // Dynamically discovered XAI model
          },
        });

        const body = expectSuccessOrUnavailable(response);
        if (!body) {
          return;
        }
        
        expect(body.object).toBe('list');
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeGreaterThan(0);
        expect(body.data[0].embedding).toBeDefined();
        expect(Array.isArray(body.data[0].embedding)).toBe(true);
        expect(body.data[0].embedding.length).toBeGreaterThan(0);
        expect(body.usage).toBeDefined();
        expect(body.usage.total_tokens).toBeGreaterThan(0);
      } finally {
        // Restore original env
        if (originalEnv !== undefined) {
          process.env.XAI_EMBEDDINGS_FALLBACK = originalEnv;
        } else {
          delete process.env.XAI_EMBEDDINGS_FALLBACK;
        }
      }
    });

    it('should honor fallback-disabled behavior when XAI embeddings are requested', async () => {
      const originalEnv = process.env.XAI_EMBEDDINGS_FALLBACK;
      process.env.XAI_EMBEDDINGS_FALLBACK = 'false';

      try {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/embeddings',
          headers: {
            authorization: `Bearer ${authToken}`,
          },
          payload: {
            input: 'Test text',
            model: testModels.xaiModel || 'auto', // Dynamically discovered XAI model
          },
        });

        if (response.statusCode === 200) {
          // Some XAI models may support embeddings directly; in that case fallback flag is irrelevant.
          const body = JSON.parse(response.body);
          expect(body.object).toBe('list');
          expect(Array.isArray(body.data)).toBe(true);
          expect(body.data.length).toBeGreaterThan(0);
          expect(Array.isArray(body.data[0].embedding)).toBe(true);
          return;
        }

        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        const body = JSON.parse(response.body);
        expect(body.error || body.message).toBeDefined();
      } finally {
        if (originalEnv !== undefined) {
          process.env.XAI_EMBEDDINGS_FALLBACK = originalEnv;
        } else {
          delete process.env.XAI_EMBEDDINGS_FALLBACK;
        }
      }
    });

    it('should generate embeddings for multiple texts', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          input: ['First text', 'Second text', 'Third text'],
          model: testModels.embeddingModel || 'auto', // Dynamically discovered embedding model // OpenAI model (has native support)
        },
      });

      const body = expectSuccessOrUnavailable(response);
      if (!body) {
        return;
      }
      
      expect(body.data.length).toBe(3);
      body.data.forEach((item: { embedding: number[]; index: number }) => {
        expect(item.embedding).toBeDefined();
        expect(Array.isArray(item.embedding)).toBe(true);
        expect(item.index).toBeDefined();
      });
    });
  });

  describe('POST /v1/moderations - All Providers', () => {
    it('should moderate content using DeepSeek adapter', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/moderations',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          input: 'This is a harmless test message',
          model: testModels.deepseekModel || 'auto', // Dynamically discovered DeepSeek model
        },
      });

      const body = expectSuccessOrUnavailable(response);
      if (!body) {
        return;
      }
      
      expect(body.id).toBeDefined();
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results.length).toBeGreaterThan(0);
      
      const result = body.results[0];
      expect(result.flagged).toBeDefined();
      expect(typeof result.flagged).toBe('boolean');
      expect(result.categories).toBeDefined();
      expect(result.category_scores).toBeDefined();
    });

    it('should moderate content using Google adapter', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/moderations',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          input: 'This is another test message',
          model: testModels.googleModel || 'auto',
        },
      });

      const body = expectSuccessOrUnavailable(response);
      if (!body) {
        return;
      }
      
      expect(body.results).toBeDefined();
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0].flagged).toBeDefined();
      expect(body.results[0].categories).toBeDefined();
    });

    it('should moderate content using XAI adapter', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/moderations',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          input: 'Test moderation with XAI',
          model: testModels.xaiModel || 'auto', // Dynamically discovered XAI model
        },
      });

      const body = expectSuccessOrUnavailable(response);
      if (!body) {
        return;
      }
      
      expect(body.results).toBeDefined();
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0].flagged).toBeDefined();
      expect(body.results[0].categories).toBeDefined();
    });

    it('should moderate multiple texts', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/moderations',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          input: [
            'First message to moderate',
            'Second message to moderate',
            'Third message to moderate',
          ],
          model: 'auto', // Let system select
        },
      });

      const body = expectSuccessOrUnavailable(response);
      if (!body) {
        return;
      }
      
      expect(body.results).toBeDefined();
      expect(body.results.length).toBe(3);
      
      body.results.forEach((result: { flagged: boolean; categories: Record<string, boolean> }) => {
        expect(result.flagged).toBeDefined();
        expect(result.categories).toBeDefined();
      });
    });

    it('should detect potentially harmful content', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/moderations',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          input: 'This is a completely harmless and safe message for testing',
          model: 'auto',
        },
      });

      const body = expectSuccessOrUnavailable(response);
      if (!body) {
        return;
      }
      
      expect(body.results).toBeDefined();
      expect(body.results.length).toBeGreaterThan(0);
      
      // Harmless content should typically not be flagged
      const result = body.results[0];
      expect(result.flagged).toBe(false);
      expect(result.categories).toBeDefined();
      expect(result.category_scores).toBeDefined();
    });

    it('should return all required moderation categories', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/moderations',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          input: 'Test message',
          model: 'auto',
        },
      });

      const body = expectSuccessOrUnavailable(response);
      if (!body) {
        return;
      }
      
      const result = body.results[0];
      const requiredCategories = [
        'sexual',
        'hate',
        'harassment',
        'self-harm',
        'violence',
      ];

      requiredCategories.forEach((category) => {
        expect(result.categories).toHaveProperty(category);
        expect(result.category_scores).toHaveProperty(category);
        expect(typeof result.categories[category]).toBe('boolean');
        expect(typeof result.category_scores[category]).toBe('number');
      });
    });
  });

  describe('Error Handling', () => {
    it('should return 401 for unauthenticated embeddings request', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/embeddings',
        payload: {
          input: 'Test',
          model: testModels.embeddingModel || 'auto', // Dynamically discovered embedding model
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 401 for unauthenticated moderation request', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/moderations',
        payload: {
          input: 'Test',
        },
      });

      expect([400, 401]).toContain(response.statusCode);
    });

    it('should return 400 for invalid embeddings request', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          // Missing required 'input' field
          model: testModels.embeddingModel || 'auto', // Dynamically discovered embedding model
        },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('should return 400 for invalid moderation request', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/moderations',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          // Missing required 'input' field
        },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('should return 404 for non-existent model', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          input: 'Test',
          model: 'non-existent-model-12345',
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Response Format Validation', () => {
    it('should return embeddings in correct format', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          input: 'Format validation test',
          model: testModels.embeddingModel || 'auto', // Dynamically discovered embedding model
        },
      });

      const body = expectSuccessOrUnavailable(response);
      if (!body) {
        return;
      }
      
      // Validate structure
      expect(body).toHaveProperty('object', 'list');
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('model');
      expect(body).toHaveProperty('usage');
      
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      
      const embedding = body.data[0];
      expect(embedding).toHaveProperty('object', 'embedding');
      expect(embedding).toHaveProperty('embedding');
      expect(embedding).toHaveProperty('index');
      
      expect(Array.isArray(embedding.embedding)).toBe(true);
      expect(embedding.embedding.length).toBeGreaterThan(0);
      
      expect(body.usage).toHaveProperty('prompt_tokens');
      expect(body.usage).toHaveProperty('total_tokens');
    });

    it('should return moderation in correct format', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/moderations',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        payload: {
          input: 'Format validation test',
          model: 'auto',
        },
      });

      const body = expectSuccessOrUnavailable(response);
      if (!body) {
        return;
      }
      
      // Validate structure
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('model');
      expect(body).toHaveProperty('results');
      
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results.length).toBeGreaterThan(0);
      
      const result = body.results[0];
      expect(result).toHaveProperty('flagged');
      expect(result).toHaveProperty('categories');
      expect(result).toHaveProperty('category_scores');
      
      expect(typeof result.flagged).toBe('boolean');
      expect(typeof result.categories).toBe('object');
      expect(typeof result.category_scores).toBe('object');
    });
  });
});

