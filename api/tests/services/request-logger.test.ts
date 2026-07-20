// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Request Logger Service
 * Uses REAL models from dynamic discovery - NO hardcoded models
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { RequestLoggerService } from '@/services/request-logger';
import type { OrchestrationResult, ChatRequest, ChatResponse } from '@/types';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { getTestModel, ensureModelsDiscovered } from '../utils/dynamic-model-discovery';
import { connectDatabase, disconnectDatabase, prisma } from '@/database/client';
import { initializeDIContainer, resetDIContainer } from '@/di/container';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

// Type for testing - exposes private properties
interface RequestLoggerServiceTestable extends RequestLoggerService {
  writeQueue: Array<unknown>;
  flushInterval: NodeJS.Timeout | null;
}

// NO MOCKS - Uses real database

describe('RequestLoggerService - Real Tests (NO Hardcoded Models)', () => {
  let service: RequestLoggerService;

  beforeAll(async () => {
    await startTestEnvironment();
    initializeDIContainer();
    await connectDatabase();
    await syncDefaultRoles();
    await ensureModelsDiscovered();
  }, 60_000);

  afterAll(async () => {
    await service?.shutdown().catch(() => {
      // Ignore shutdown errors
    });
    await disconnectDatabase();
    resetDIContainer();
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(() => {
    service = new RequestLoggerService();
  });

  afterEach(async () => {
    await service.shutdown().catch(() => {
      // Ignore shutdown errors
    });
  });

  describe('logRequest', () => {
    it('should queue request log', async () => {
      // Create test organization
      const org = await prisma.organization.create({
        data: {
          name: `Test Org ${Date.now()}`,
          slug: `test-org-${Date.now()}`,
          tier: 'enterprise',
          status: 'active',
        },
      });

      const logData = {
        organizationId: org.id,
        requestId: `req-${Date.now()}`,
        endpoint: '/v1/chat/completions',
        method: 'POST',
        durationMs: 1500,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.015,
        status: 'success' as const,
      };

      await service.logRequest(logData);

      // Request should be queued
      expect((service as RequestLoggerServiceTestable).writeQueue.length).toBe(1);

      // Cleanup
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {
        // Ignore cleanup errors
      });
    });

    it('should flush when queue reaches threshold', async () => {
      // Create test organization
      const org = await prisma.organization.create({
        data: {
          name: `Test Org ${Date.now()}`,
          slug: `test-org-${Date.now()}`,
          tier: 'enterprise',
          status: 'active',
        },
      });

      // Add 100 logs to trigger auto-flush
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          service.logRequest({
            organizationId: org.id,
            requestId: `req-${i}-${Date.now()}`,
            endpoint: '/v1/chat/completions',
            method: 'POST',
            durationMs: 1000,
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            costUsd: 0.01,
            status: 'success',
          })
        );
      }

      await Promise.all(promises);

      // Wait for flush to complete
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify logs were written to database
      const logs = await prisma.requestLog.findMany({
        where: {
          organizationId: org.id,
        },
      });

      // Should have at least some logs written (may not be all 100 due to batching)
      expect(logs.length).toBeGreaterThan(0);

      // Cleanup
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {
        // Ignore cleanup errors
      });
    }, 30_000);
  });

  describe('logOrchestration', () => {
    it('should log orchestration result correctly with real models', async () => {
      // Create test organization
      const org = await prisma.organization.create({
        data: {
          name: `Test Org ${Date.now()}`,
          slug: `test-org-${Date.now()}`,
          tier: 'enterprise',
          status: 'active',
        },
      });

      // Get a real model from dynamic discovery - NO hardcoded models
      const realModel = await getTestModel();
      if (!realModel) {
        // Cleanup and skip
        await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
        return; // Skip if no models available
      }

      const mockResponse: ChatResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1234567890,
        model: realModel.id, // Use dynamically discovered model
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello!',
            },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };

      const mockResult: OrchestrationResult = {
        strategyUsed: 'single',
        modelsUsed: [
          {
            modelId: realModel.id, // Use dynamically discovered model
            modelName: realModel.name, // Use dynamically discovered model name
            provider: realModel.provider,
            role: 'primary',
            request: { messages: [{ role: 'user', content: 'Hi' }] },
            response: mockResponse,
            cost: 0.0125,
            durationMs: 1500,
            success: true,
          },
        ],
        finalResponse: mockResponse,
        totalCost: 0.0125,
        totalDuration: 1500,
        qualityScore: 0.95,
        metadata: {},
      };

      const mockRequest: ChatRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
      };

      await service.logOrchestration(
        mockResult,
        org.id,
        'user-123',
        '/v1/chat/completions',
        'POST',
        mockRequest
      );

      // Should be queued
      expect((service as RequestLoggerServiceTestable).writeQueue.length).toBe(1);

      const queued = (service as RequestLoggerServiceTestable).writeQueue[0] as Record<string, unknown>;
      expect(queued.organizationId).toBe(org.id);
      expect(queued.strategyName).toBe('single');
      expect(queued.modelCount).toBe(1);
      expect(queued.costUsd).toBe(0.0125);
      expect(queued.totalTokens).toBe(15);
      expect(queued.status).toBe('success');

      // Cleanup
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {
        // Ignore cleanup errors
      });
    });
  });

  describe('logError', () => {
    it('should log error correctly', async () => {
      // Create test organization
      const org = await prisma.organization.create({
        data: {
          name: `Test Org ${Date.now()}`,
          slug: `test-org-${Date.now()}`,
          tier: 'enterprise',
          status: 'active',
        },
      });

      const error = new Error('Test error');

      await service.logError(
        org.id,
        'user-123',
        `req-${Date.now()}`,
        '/v1/chat/completions',
        'POST',
        error,
        1000
      );

      // Should be queued
      expect((service as RequestLoggerServiceTestable).writeQueue.length).toBe(1);

      const queued = (service as RequestLoggerServiceTestable).writeQueue[0] as Record<string, unknown>;
      expect(queued.status).toBe('error');
      expect(queued.errorMessage).toBe('Test error');
      expect(queued.costUsd).toBe(0);

      // Cleanup
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {
        // Ignore cleanup errors
      });
    });
  });

  describe('flush', () => {
    it('should flush queue to database', async () => {
      // Create test organization
      const org = await prisma.organization.create({
        data: {
          name: `Test Org ${Date.now()}`,
          slug: `test-org-${Date.now()}`,
          tier: 'enterprise',
          status: 'active',
        },
      });

      // Add logs to queue
      await service.logRequest({
        organizationId: org.id,
        requestId: `req-${Date.now()}`,
        endpoint: '/v1/chat/completions',
        method: 'POST',
        durationMs: 1000,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.01,
        status: 'success',
      });

      // Verify queue has items
      expect((service as RequestLoggerServiceTestable).writeQueue.length).toBe(1);

      // Flush manually
      await service.flush();

      // Wait a bit for async write
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify logs were written to database
      const logs = await prisma.requestLog.findMany({
        where: {
          organizationId: org.id,
        },
      });

      expect(logs.length).toBeGreaterThan(0);
      
      // Queue should be empty
      expect((service as RequestLoggerServiceTestable).writeQueue.length).toBe(0);

      // Cleanup
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {
        // Ignore cleanup errors
      });
    }, 30_000);

    it('should not flush if queue is empty', async () => {
      // Get initial count
      const initialCount = await prisma.requestLog.count();

      // Flush empty queue
      await service.flush();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify no new logs were created
      const finalCount = await prisma.requestLog.count();
      expect(finalCount).toBe(initialCount);
    });
  });

  describe('shutdown', () => {
    it('should flush remaining logs and stop interval', async () => {
      // Create test organization
      const org = await prisma.organization.create({
        data: {
          name: `Test Org ${Date.now()}`,
          slug: `test-org-${Date.now()}`,
          tier: 'enterprise',
          status: 'active',
        },
      });

      // Add log
      await service.logRequest({
        organizationId: org.id,
        requestId: `req-${Date.now()}`,
        endpoint: '/v1/test',
        method: 'POST',
        durationMs: 1000,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.01,
        status: 'success',
      });

      // Verify queue has items
      expect((service as RequestLoggerServiceTestable).writeQueue.length).toBe(1);

      // Shutdown
      await service.shutdown();

      // Wait a bit for async write
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify logs were written to database
      const logs = await prisma.requestLog.findMany({
        where: {
          organizationId: org.id,
        },
      });

      expect(logs.length).toBeGreaterThan(0);
      
      // Queue should be empty
      expect((service as RequestLoggerServiceTestable).writeQueue.length).toBe(0);
      
      // Interval should be stopped
      expect((service as RequestLoggerServiceTestable).flushInterval).toBeNull();

      // Cleanup
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {
        // Ignore cleanup errors
      });
    }, 30_000);
  });
});

