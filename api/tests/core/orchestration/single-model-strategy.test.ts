// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Single Model Strategy
 * Uses REAL dynamic model discovery - NO hardcoded models, NO mocks
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { SingleModelStrategy } from '@/core/orchestration/strategies/single-model-strategy';
import type { ChatRequest, OrchestrationContext, Model } from '@/types';
import { discoverModelsDynamically } from '../../utils/dynamic-model-discovery';
import { startTestEnvironment, stopTestEnvironment } from '../../utils/test-environment';

describe('SingleModelStrategy', () => {
  let strategy: SingleModelStrategy;
  let testContext: OrchestrationContext;
  let realModels: Model[];

  beforeAll(async () => {
    await startTestEnvironment();
  });

  beforeEach(async () => {
    strategy = new SingleModelStrategy();

    // Discover models dynamically from real providers (NO hardcoded models, NO mocks)
    realModels = await discoverModelsDynamically();
    
    // Take first 5 models for testing
    realModels = realModels.slice(0, 5);

    testContext = {
      organizationId: 'org-123',
      requestId: 'req-123-' + Date.now(),
      models: realModels,
      taskType: 'general',
      contextSize: 1000,
    };
  });

  describe('getMetadata', () => {
    it('should return correct metadata', () => {
      const metadata = strategy.getMetadata();

      expect(metadata.id).toBe('strategy-1');
      expect(metadata.name).toBe('single');
      expect(metadata.displayName).toBe('Single Model');
      expect(metadata.minModels).toBe(1);
      expect(metadata.maxModels).toBe(1);
      expect(metadata.estimatedCostMultiplier).toBe(1.0);
      expect(metadata.estimatedQualityBoost).toBe(0.0);
    });
  });

  describe('isSuitable', () => {
    it('should be suitable for general tasks', () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      };

      expect(strategy.isSuitable(request, testContext)).toBe(true);
    });

    it('should not be suitable if no models available', () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const emptyContext = { ...testContext, models: [] };

      expect(strategy.isSuitable(request, emptyContext)).toBe(false);
    });

    it('should not be suitable if budget too low', () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const lowBudgetContext = { ...testContext, budget: 0.0001 };

      // For very small input, might still be suitable
      // But for larger inputs, should be unsuitable
      const largeTestContext = { ...testContext, contextSize: 50000, budget: 0.0001 };
      
      expect(strategy.isSuitable(request, largeTestContext)).toBe(false);
    });
  });

  describe('scoreForRequest', () => {
    it('should score higher for suitable tasks', () => {
      const qaRequest: ChatRequest = {
        messages: [{ role: 'user', content: 'What is the capital of France?' }],
        task_type: 'qa',
      };

      const qaContext = { ...testContext, taskType: 'qa' as const };

      const score = strategy.scoreForRequest(qaRequest, qaContext);

      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('should return 0 for unsuitable requests', () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const emptyContext = { ...testContext, models: [] };

      const score = strategy.scoreForRequest(request, emptyContext);

      expect(score).toBe(0);
    });
  });

  describe('calculateEstimatedCost', () => {
    it('should calculate cost correctly with real models', () => {
      if (realModels.length === 0) {
        // Skip if no models available
        return;
      }
      const model = realModels[0];
      const inputTokens = 1000;
      const outputTokens = 500;

      const cost = strategy.calculateEstimatedCost([model], inputTokens, outputTokens);

      // Cost should be calculated based on real model pricing
      expect(cost).toBeGreaterThan(0);
      expect(typeof cost).toBe('number');
    });

    it('should calculate cost for different models', () => {
      if (realModels.length < 2) {
        // Skip if we don't have enough models
        return;
      }
      const model1 = realModels[0];
      const model2 = realModels[1];
      const inputTokens = 1000;
      const outputTokens = 1000;

      const cost1 = strategy.calculateEstimatedCost([model1], inputTokens, outputTokens);
      const cost2 = strategy.calculateEstimatedCost([model2], inputTokens, outputTokens);

      // Both should be valid costs
      expect(cost1).toBeGreaterThan(0);
      expect(cost2).toBeGreaterThan(0);
      expect(typeof cost1).toBe('number');
      expect(typeof cost2).toBe('number');
    });
  });

  describe('precomputedModelSelection (speculative parallel selection, 2026-07-14)', () => {
    it('reuses the precomputed selection on a fresh call instead of running DynamicModelSelector', async () => {
      if (realModels.length === 0) return;
      const precomputedModel = realModels[0];
      const fakeAdapter = { getName: () => 'fake-provider' } as unknown as import('@/providers/base/provider-adapter').ProviderAdapter;
      const contextWithPrecomputed: OrchestrationContext = {
        ...testContext,
        precomputedModelSelection: { model: precomputedModel, adapter: fakeAdapter },
      };
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'auto',
      };

      const result = await strategy.planStreaming(request, contextWithPrecomputed);

      expect(result).not.toBeNull();
      expect(result?.model.id).toBe(precomputedModel.id);
      expect(result?.adapter).toBe(fakeAdapter);
    });

    it('ignores the precomputed selection on a retry (excludedModelIds non-empty)', async () => {
      if (realModels.length === 0) return;
      const precomputedModel = realModels[0];
      const fakeAdapter = { getName: () => 'fake-provider' } as unknown as import('@/providers/base/provider-adapter').ProviderAdapter;
      const contextWithPrecomputed: OrchestrationContext = {
        ...testContext,
        precomputedModelSelection: { model: precomputedModel, adapter: fakeAdapter },
      };
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'auto',
      };

      // planStreaming always calls selectBestModel with an empty exclusion
      // set — retry only happens through execute()'s cross-candidate
      // fallback loop, which passes a non-empty excludedModelIds. Exercise
      // the protected method directly to prove the precomputed pick is
      // never reused once ANY candidate has already been excluded (it may
      // be the one that just failed).
      type ProtectedAccess = {
        selectBestModel: (
          request: ChatRequest,
          context: OrchestrationContext,
          excludedModelIds?: Set<string>
        ) => Promise<{ model: Model; adapter: import('@/providers/base/provider-adapter').ProviderAdapter } | null>;
      };
      // This fixture never injects a real getAdapterForModel, so falling
      // through to DynamicModelSelector's resolution legitimately throws
      // "getAdapterForModel not injected" here — that specific throw is
      // itself the proof the precomputed short-circuit was skipped (the
      // short-circuit returns instantly with no throw at all). Assert on
      // that exact error rather than a generic "something threw", so an
      // unrelated regression elsewhere doesn't silently pass this test.
      await expect(
        (strategy as unknown as ProtectedAccess).selectBestModel(
          request,
          contextWithPrecomputed,
          new Set([precomputedModel.id])
        )
      ).rejects.toThrow('getAdapterForModel not injected');
    });
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });
});

