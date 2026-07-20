// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for Collaborative Strategy
 * 3-phase execution: Primary → Reviewer → Refinement → Quality Validation
 * 
 * Uses dynamic model discovery - no hardcoded models
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { CollaborativeStrategy } from '../strategies/collaborative-strategy';
import { prisma } from '@/database/client';
import type { ChatRequest, OrchestrationContext, TaskType, Model } from '@/types';

describe('CollaborativeStrategy', () => {
  let strategy: CollaborativeStrategy;
  let testContext: OrchestrationContext;
  let testRequest: ChatRequest;
  let discoveredModels: Model[] = [];

  beforeAll(async () => {
    // Discover models dynamically from database (no hardcoded models).
    //
    // We explicitly filter by capabilities: ['chat'] because the catalog mixes
    // chat models with embedding/audio/image-only models, and the strategy's
    // eligibility filter (`base-strategy.ts:189`, `pool-builder.ts:71`) rejects
    // any model that doesn't carry 'chat' or 'text_generation'. Without this
    // filter, slice(0, 3) can pick up an embedding row first (createdAt DESC
    // ordering is non-deterministic w.r.t. modality) and the test sees only
    // 2 eligible chat models — below the 3-minimum the strategy needs.
    const { getModelRepository } = await import('@/services/model-repository.js');
    const repository = getModelRepository();
    discoveredModels = await repository.searchModels({
      status: 'active',
      capabilities: ['chat'],
      limit: 10,
    });

    // If no chat models discovered, the test environment should ensure models are available
    if (discoveredModels.length === 0) {
      // Trigger discovery if needed
      const { getCentralModelDiscoveryService } = await import('@/services/central-model-discovery-service.js');
      const discoveryService = await getCentralModelDiscoveryService();
      await discoveryService.discoverAllModels();

      // Try again
      discoveredModels = await repository.searchModels({
        status: 'active',
        capabilities: ['chat'],
        limit: 10,
      });
    }
  });

  beforeEach(() => {
    strategy = new CollaborativeStrategy();

    // Use dynamically discovered models (at least 3 for collaborative strategy)
    const modelsForTest = discoveredModels.length >= 3 
      ? discoveredModels.slice(0, 3)
      : discoveredModels;

    testContext = {
      organizationId: 'org-123',
      userId: 'user-456',
      requestId: 'req-789',
      models: modelsForTest,
      taskType: 'code-generation',
      contextSize: 1000,
      preferSpeed: false,
      qualityTarget: 0.9,
    };

    testRequest = {
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: 'Create a function to calculate fibonacci numbers',
        },
      ],
      temperature: 0.7,
      max_tokens: 1000,
    };
  });

  describe('Metadata', () => {
    it('should return correct metadata', () => {
      const metadata = strategy.getMetadata();

      expect(metadata.name).toBe('collaborative');
      expect(metadata.minModels).toBe(3);
      expect(metadata.maxModels).toBe(3);
      expect(metadata.estimatedCostMultiplier).toBe(2.5);
      expect(metadata.estimatedQualityBoost).toBe(0.25);
    });
  });

  describe('Suitability', () => {
    it('should be suitable for code-generation tasks when enough models available', () => {
      if (testContext.models.length < 3) {
        // Skip if not enough models discovered
        return;
      }
      const suitable = strategy.isSuitable(testRequest, testContext);
      expect(suitable).toBe(true);
    });

    it('should not be suitable with less than 3 models', () => {
      const contextWith2Models = {
        ...testContext,
        models: testContext.models.slice(0, 2),
      };

      const suitable = strategy.isSuitable(testRequest, contextWith2Models);
      expect(suitable).toBe(false);
    });

    it('should be suitable for code-review tasks when enough models available', () => {
      if (testContext.models.length < 3) {
        // Skip if not enough models discovered
        return;
      }
      const reviewContext = {
        ...testContext,
        taskType: 'code-review' as TaskType,
      };

      const suitable = strategy.isSuitable(testRequest, reviewContext);
      expect(suitable).toBe(true);
    });
  });

  describe('Scoring', () => {
    it('should score higher for code tasks when enough models available', () => {
      if (testContext.models.length < 3) {
        // Skip if not enough models discovered
        return;
      }
      const score = strategy.scoreForRequest(testRequest, testContext);
      // scoreForRequest returns a score between 0 and 1, not 0-100
      expect(score).toBeGreaterThan(0.7);
    });

    it('should score lower for simple QA tasks', () => {
      if (testContext.models.length < 3) {
        // Skip if not enough models discovered
        return;
      }
      const qaContext = {
        ...testContext,
        taskType: 'qa' as TaskType,
      };

      const score = strategy.scoreForRequest(testRequest, qaContext);
      // scoreForRequest returns a score between 0 and 1, not 0-100
      expect(score).toBeLessThan(0.5);
    });

    it('should score 0 with insufficient models', () => {
      const contextWith2Models = {
        ...testContext,
        models: testContext.models.slice(0, 2),
      };

      const score = strategy.scoreForRequest(testRequest, contextWith2Models);
      expect(score).toBe(0);
    });
  });
});

