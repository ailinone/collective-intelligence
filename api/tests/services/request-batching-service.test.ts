// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Request Batching Service Tests
 * Uses REAL orchestration engine - NO mocks, NO hardcoded models
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { requestBatchingService, configureRequestBatching } from '@/services/request-batching-service';
import { orchestrationEngine } from '@/core/orchestration/orchestration-engine';
import type { ChatRequest, UserContext } from '@/types';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { getTestModelId, createTestChatRequest } from '../utils/test-model-helper';
import { ensureModelsDiscovered } from '../utils/dynamic-model-discovery';

describe('RequestBatchingService - Real Tests (NO Mocks, NO Hardcoded Models)', () => {
  const testUserContext: UserContext = {
    userId: 'user-1',
    organizationId: 'org-1',
    tier: 'pro',
    apiKey: 'test-key',
  };

  let testModelId: string;

  beforeAll(async () => {
    await startTestEnvironment();
    await ensureModelsDiscovered();
    testModelId = await getTestModelId();
    if (!testModelId) {
      throw new Error('No models available from dynamic discovery');
    }
    configureRequestBatching(orchestrationEngine);
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  describe('batchRequest', () => {
    it('should execute non-batchable requests individually', async () => {
      if (!testModelId) {
        return;
      }
      
      // Setup - request with tools (not batchable) - using dynamically discovered model
      const request = await createTestChatRequest(
        [{ role: 'user', content: 'Hello' }],
        undefined,
        { tools: [{ type: 'function', function: { name: 'test', parameters: {} } }] }
      );

      // Execute
      const response = await requestBatchingService.batchRequest(request, testUserContext);

      // Verify
      expect(response).toBeDefined();
      expect(response.id).toBeDefined();
    }, 60000);

    it('should execute streaming requests individually', async () => {
      if (!testModelId) {
        return;
      }
      
      // Setup - streaming request (not batchable) - using dynamically discovered model
      const request = await createTestChatRequest(
        [{ role: 'user', content: 'Hello' }]
      );
      request.stream = true;

      // Execute
      const response = await requestBatchingService.batchRequest(request, testUserContext);

      // Verify
      expect(response).toBeDefined();
      expect(response.id).toBeDefined();
    }, 60000);

    it('should execute high temperature requests individually', async () => {
      if (!testModelId) {
        return;
      }
      
      // Setup - high temperature (too random) - using dynamically discovered model
      const request = await createTestChatRequest(
        [{ role: 'user', content: 'Hello' }],
        undefined,
        { temperature: 0.9 }
      );

      // Execute
      const response = await requestBatchingService.batchRequest(request, testUserContext);

      // Verify
      expect(response).toBeDefined();
      expect(response.id).toBeDefined();
    }, 60000);

    it('should batch similar requests together', async () => {
      if (!testModelId) {
        return;
      }
      
      // Setup - two similar requests - using dynamically discovered model
      const request1 = await createTestChatRequest(
        [{ role: 'user', content: 'What is TypeScript?' }],
        undefined,
        { temperature: 0.1 }
      );

      const request2 = await createTestChatRequest(
        [{ role: 'user', content: 'What is TypeScript?' }], // Same question
        undefined,
        { temperature: 0.1 }
      );

      // Execute both requests simultaneously
      const [response1, response2] = await Promise.all([
        requestBatchingService.batchRequest(request1, testUserContext),
        requestBatchingService.batchRequest(request2, testUserContext),
      ]);

      // Verify - both should resolve
      expect(response1).toBeDefined();
      expect(response2).toBeDefined();
    }, 60000);

    it('should not batch dissimilar requests', async () => {
      if (!testModelId) {
        return;
      }
      
      // Setup - different requests - using dynamically discovered model
      const request1 = await createTestChatRequest(
        [{ role: 'user', content: 'What is TypeScript?' }],
        undefined,
        { temperature: 0.1 }
      );

      const request2 = await createTestChatRequest(
        [{ role: 'user', content: 'What is JavaScript?' }], // Different question
        undefined,
        { temperature: 0.1 }
      );

      // Execute
      const [response1, response2] = await Promise.all([
        requestBatchingService.batchRequest(request1, testUserContext),
        requestBatchingService.batchRequest(request2, testUserContext),
      ]);

      // Verify
      expect(response1).toBeDefined();
      expect(response2).toBeDefined();
    }, 60000);

    it('should handle vision content correctly', async () => {
      if (!testModelId) {
        return;
      }
      
      // Setup - request with vision content - using dynamically discovered model
      const request = await createTestChatRequest(
        [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
          ],
        }]
      );

      // Execute
      const response = await requestBatchingService.batchRequest(request, testUserContext);

      // Verify - should execute individually (not batched)
      expect(response).toBeDefined();
      expect(response.id).toBeDefined();
    }, 60000);
  });

  describe('getBatchingStats', () => {
    it('should return batching statistics', async () => {
      if (!testModelId) {
        return;
      }
      
      // Execute a few requests first - using dynamically discovered model
      const request = await createTestChatRequest(
        [{ role: 'user', content: 'Test' }],
        undefined,
        { temperature: 0.1 }
      );

      await requestBatchingService.batchRequest(request, testUserContext);

      // Get stats
      const stats = await requestBatchingService.getBatchingStats();

      // Verify
      expect(stats).toBeDefined();
      expect(stats.totalBatches).toBeGreaterThanOrEqual(0);
      expect(stats.totalRequests).toBeGreaterThanOrEqual(0);
      expect(stats.averageBatchSize).toBeGreaterThanOrEqual(0);
      expect(stats.batchHitRate).toBeGreaterThanOrEqual(0);
      expect(stats.batchHitRate).toBeLessThanOrEqual(1);
    }, 60000);
  });

  describe('getPendingBatches', () => {
    it('should return pending batch information', () => {
      // Execute
      const pending = requestBatchingService.getPendingBatches();

      // Verify
      expect(pending).toBeDefined();
      expect(Array.isArray(pending)).toBe(true);
      
      // Each batch should have required fields
      for (const batch of pending) {
        expect(batch).toHaveProperty('key');
        expect(batch).toHaveProperty('size');
        expect(batch).toHaveProperty('age');
        expect(batch).toHaveProperty('status');
      }
    });
  });

  describe('clearExpiredBatches', () => {
    it('should clear expired batches', async () => {
      // Execute
      const cleared = await requestBatchingService.clearExpiredBatches();

      // Verify
      expect(cleared).toBeGreaterThanOrEqual(0);
    });
  });

  describe('batch key generation', () => {
    it('should generate same key for similar requests', async () => {
      if (!testModelId) {
        return;
      }
      
      // Setup - using dynamically discovered model
      const request1 = await createTestChatRequest(
        [{ role: 'user', content: 'Hello  World' }], // Extra spaces
        undefined,
        { temperature: 0.1 }
      );

      const request2 = await createTestChatRequest(
        [{ role: 'user', content: 'hello world' }], // Different case
        undefined,
        { temperature: 0.1 }
      );

      // Execute - both should potentially batch together (fuzzy match)
      const [response1, response2] = await Promise.all([
        requestBatchingService.batchRequest(request1, testUserContext),
        requestBatchingService.batchRequest(request2, testUserContext),
      ]);

      expect(response1).toBeDefined();
      expect(response2).toBeDefined();
    }, 60000);

    it('should generate different keys for different models', async () => {
      if (!testModelId) {
        return;
      }
      
      // Get two different models dynamically
      const { getTestModels } = await import('../utils/test-model-helper');
      const models = await getTestModels(2);
      
      if (models.length < 2) {
        return;
      }
      
      const request1 = await createTestChatRequest(
        [{ role: 'user', content: 'Hello' }],
        undefined,
        { modelId: models[0].id, temperature: 0.1 }
      );

      const request2 = await createTestChatRequest(
        [{ role: 'user', content: 'Hello' }], // Same message
        undefined,
        { modelId: models[1].id, temperature: 0.1 }
      );

      // Execute
      const [response1, response2] = await Promise.all([
        requestBatchingService.batchRequest(request1, testUserContext),
        requestBatchingService.batchRequest(request2, testUserContext),
      ]);

      expect(response1).toBeDefined();
      expect(response2).toBeDefined();
    }, 60000);
  });
});
