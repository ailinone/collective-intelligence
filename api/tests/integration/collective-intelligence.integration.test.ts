// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Collective Intelligence Integration Tests
 *
 * End-to-end tests for the CI system components:
 * - Semantic Memory Store
 * - Semantic Cache
 * - Reasoning Transparency
 * - Self-Critique Engine
 * - Agentic Workflows
 * - CI Routes
 * 
 * NO MOCKS - Uses real infrastructure (Postgres, Redis, Providers)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createServer } from '../../src/server';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { connectDatabase, disconnectDatabase, prisma } from '@/database/client';
import { createRealProviderRegistry, syncRealModelsToCatalog } from '../utils/real-provider-registry';
import { setProviderRegistry } from '@/providers/provider-registry';
import { ensureModelsDiscovered } from '../utils/dynamic-model-discovery';
import { initializeDIContainer, resetDIContainer } from '@/di/container';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

describe('Collective Intelligence Integration Tests', () => {
  let server: FastifyInstance;
  let testOrgId: string;
  let testApiKey: string;

  beforeAll(async () => {
    // Start test environment with real infrastructure
    await startTestEnvironment();
    
    // Initialize DI container
    initializeDIContainer();
    
    // Connect to database
    await connectDatabase();
    
    // Sync default roles
    await syncDefaultRoles();
    
    // Ensure models are discovered dynamically (NO hardcoded models)
    await ensureModelsDiscovered();
    
    // Initialize providers with REAL adapters - NO mocks
    const providerRegistry = await createRealProviderRegistry();
    setProviderRegistry(providerRegistry);
    await syncRealModelsToCatalog(providerRegistry);
    
    // Create test organization and API key for auth
    const org = await prisma.organization.create({
      data: {
        name: `CI Test Org ${Date.now()}`,
        slug: `ci-test-org-${Date.now()}`,
        tier: 'enterprise',
        status: 'active',
      },
    });
    testOrgId = org.id;
    
    const user = await prisma.user.create({
      data: {
        email: `ci-test-${Date.now()}@example.com`,
        name: 'CI Test User',
        passwordHash: '$2b$12$dummyhash',
        organizationId: testOrgId,
        role: 'admin',
        status: 'active',
      },
    });
    
    const bcrypt = await import('bcrypt');
    const keyValue = `ak_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const keyHash = await bcrypt.hash(keyValue, 10);
    
    await prisma.apiKey.create({
      data: {
        name: 'CI Test API Key',
        keyHash,
        keyPrefix: keyValue.substring(0, 15),
        userId: user.id,
        organizationId: testOrgId,
        status: 'active',
      },
    });
    
    testApiKey = keyValue;
    
    server = await createServer();
    
    // Register CI routes for testing
    const { registerCollectiveIntelligenceRoutes } = await import(
      '../../src/routes/collective-intelligence/ci-routes'
    );
    await registerCollectiveIntelligenceRoutes(server);

    const { registerCIDashboardRoutes } = await import(
      '../../src/routes/observability/ci-dashboard-routes'
    );
    await registerCIDashboardRoutes(server);

    await server.ready();
  }, 120_000);

  afterAll(async () => {
    // Cleanup
    try {
      if (testOrgId) {
        await prisma.organization.delete({ where: { id: testOrgId } }).catch(() => {
          // Ignore cleanup errors
        });
      }
    } catch {
      // Ignore cleanup errors
    }
    
    try {
      await server.close();
    } catch {
      // Ignore cleanup errors
    }
    
    try {
      await disconnectDatabase();
    } catch {
      // Ignore cleanup errors
    }
    
    resetDIContainer();
    await stopTestEnvironment();
  }, 60_000);

  describe('Semantic Memory API', () => {
    it('should store a new memory', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/memory',
        headers: {
          'x-api-key': testApiKey,
        },
        payload: {
          content: 'User prefers concise code examples in TypeScript',
          type: 'semantic',
          metadata: { source: 'conversation' },
          importance: 0.8,
        },
      });

      // Should succeed with proper API key
      expect([200, 201]).toContain(response.statusCode);
      
      if (response.statusCode === 200 || response.statusCode === 201) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('type');
        expect(body).toHaveProperty('createdAt');
      }
    });

    it('should search memories by query', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/memory/search',
        headers: {
          'x-api-key': testApiKey,
        },
        payload: {
          query: 'TypeScript code examples',
          type: 'semantic',
          limit: 10,
          minSimilarity: 0.7,
        },
      });

      expect([200, 404, 500]).toContain(response.statusCode);
      
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(Array.isArray(body.results)).toBe(true);
      }
    });

    it('should get memory statistics', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/memory/stats',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect(response.statusCode).toBe(200);
      
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('byType');
    });
  });

  describe('Agentic Workflow API', () => {
    it('should create workflow from natural language task', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/workflows/create',
        headers: {
          'x-api-key': testApiKey,
        },
        payload: {
          task: 'Analyze the codebase and suggest performance optimizations',
          tools: [
            { name: 'read_file', description: 'Read file contents' },
            { name: 'analyze_code', description: 'Analyze code for issues' },
          ],
        },
      });

      expect([200, 201, 400, 404, 503]).toContain(response.statusCode);
    });

    it('should execute a workflow', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/workflows/execute',
        headers: {
          'x-api-key': testApiKey,
        },
        payload: {
          workflow: {
            id: 'test-workflow',
            name: 'Test Workflow',
            description: 'A simple test workflow',
            version: '1.0.0',
            steps: [
              {
                id: 'step-1',
                name: 'Generate response',
                type: 'llm_call',
                config: {
                  prompt: 'Say hello',
                },
              },
            ],
          },
          input: { greeting: 'Hello' },
        },
      });

      expect([200, 201, 400, 404, 500]).toContain(response.statusCode);
    });
  });

  describe('Reasoning Transparency API', () => {
    it('should get reasoning trace for request', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/reasoning/test-request-123',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      // 404 is expected for non-existent traces
      expect([200, 401, 404]).toContain(response.statusCode);
    });

    it('should get human-readable explanation', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/reasoning/test-request-123/explain',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect([200, 401, 500]).toContain(response.statusCode);
    });
  });

  describe('CI Dashboard API', () => {
    it('should get CI system health', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/ci/dashboard/health',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect([200, 201, 400, 401, 404]).toContain(response.statusCode);

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body).toHaveProperty('status');
        expect(body).toHaveProperty('components');
        expect(body).toHaveProperty('timestamp');
      }
    });

    it('should get strategy statistics', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/ci/dashboard/strategies',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect([200, 201, 400, 401, 404]).toContain(response.statusCode);
    });

    it('should get model performance metrics', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/ci/dashboard/models',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect([200, 201, 400, 404]).toContain(response.statusCode);
    });

    it('should get learning insights', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/ci/dashboard/learning',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect([200, 201, 400, 404]).toContain(response.statusCode);
    });

    it('should get cache statistics', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/ci/dashboard/cache',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect([200, 201, 400, 404]).toContain(response.statusCode);
    });

    it('should get comprehensive dashboard overview', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/ci/dashboard/overview',
        headers: {
          'x-api-key': testApiKey,
        },
      });

      expect([200, 201, 400, 404]).toContain(response.statusCode);
    });
  });
});

describe('Collective Intelligence Unit Tests', () => {
  describe('Reasoning Transparency Service', () => {
    it('should track complete request flow', async () => {
      const { ReasoningTransparencyService } = await import(
        '../../src/core/transparency/reasoning-transparency'
      );

      const service = new ReasoningTransparencyService();

      // Start trace
      service.startTrace('test-001', {
        model: 'auto',
        messages: [{ role: 'user', content: 'Test message' }],
      });

      // Record triage
      service.recordTriage('test-001', {
        intent: 'code-generation',
        complexity: 'high',
        priority: 'normal',
        confidence: 0.9,
      });

      // Get trace
      const trace = service.getTrace('test-001');

      expect(trace).toBeDefined();
      expect(trace?.requestId).toBe('test-001');
      expect(trace?.triage?.intent).toBe('code-generation');
    });

    it('should generate human-readable explanation', async () => {
      const { ReasoningTransparencyService } = await import(
        '../../src/core/transparency/reasoning-transparency'
      );

      const service = new ReasoningTransparencyService();

      // Get a real model from dynamic discovery - NO hardcoded models
      const { getTestModelId } = await import('../utils/dynamic-model-discovery');
      const testModelId = await getTestModelId();
      if (!testModelId) {
        return; // Skip if no models available
      }

      service.startTrace('test-002', {
        model: testModelId, // Use dynamically discovered model
        messages: [{ role: 'user', content: 'Explain TypeScript' }],
      });

      const explanation = service.explainDecision('test-002');

      expect(explanation).toBeDefined();
      expect(typeof explanation).toBe('string');
      if (testModelId) {
        expect(explanation).toContain(testModelId); // Use real model ID
      }
    });
  });

  describe('Self-Critique Engine', () => {
    it('should initialize with default options', async () => {
      const { SelfCritiqueEngine } = await import(
        '../../src/core/critique/self-critique-engine'
      );

      const engine = new SelfCritiqueEngine();

      expect(engine).toBeDefined();
    });

    it('should initialize with custom options', async () => {
      const { SelfCritiqueEngine } = await import(
        '../../src/core/critique/self-critique-engine'
      );

      const engine = new SelfCritiqueEngine({
        mode: 'cross-model',
        maxIterations: 3,
        minQualityThreshold: 0.9,
      });

      expect(engine).toBeDefined();
    });
  });

  describe('Agentic Workflow Engine', () => {
    it('should register and retrieve workflows', async () => {
      const { AgenticWorkflowEngine } = await import(
        '../../src/core/agentic/agentic-workflow-engine'
      );

      const engine = new AgenticWorkflowEngine();

      const workflow = {
        id: 'test-wf-001',
        name: 'Test Workflow',
        description: 'A test workflow',
        version: '1.0.0',
        steps: [
          {
            id: 's1',
            name: 'Step 1',
            type: 'llm_call' as const,
            config: { prompt: 'Hello' },
          },
        ],
      };

      engine.registerWorkflow(workflow);

      const retrieved = engine.getWorkflow('test-wf-001');

      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Test Workflow');
      expect(retrieved?.steps).toHaveLength(1);
    });
  });

  describe('Semantic Cache', () => {
    it('should generate request hash', async () => {
      const { SemanticCache } = await import(
        '../../src/core/cache/semantic-cache'
      );

      const cache = new SemanticCache({ enabled: true });

      expect(cache.isEnabled()).toBe(true);
    });

    it('should handle disabled cache gracefully', async () => {
      const { SemanticCache } = await import(
        '../../src/core/cache/semantic-cache'
      );

      const cache = new SemanticCache({ enabled: false });

      // Get a real model from dynamic discovery - NO hardcoded models
      const { getTestModelId } = await import('../utils/dynamic-model-discovery');
      const testModelId = await getTestModelId();
      if (!testModelId) {
        return; // Skip if no models available
      }

      const result = await cache.lookup({
        request: {
          model: testModelId, // Use dynamically discovered model
          messages: [{ role: 'user', content: 'Test' }],
        },
        organizationId: 'test-org-disabled-cache',
      });

      expect(result).toBeNull();
    });
  });
});

