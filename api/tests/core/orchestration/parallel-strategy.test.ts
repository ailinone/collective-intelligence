// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Parallel Strategy
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ParallelStrategy } from '@/core/orchestration/strategies/parallel-strategy';
import type { ChatRequest, OrchestrationContext, Model } from '@/types';

describe('ParallelStrategy', () => {
  let strategy: ParallelStrategy;
  let mockContext: OrchestrationContext;
  let mockModels: Model[];

  beforeEach(() => {
    strategy = new ParallelStrategy();

    // Mock models (need at least 2 for parallel)
    mockModels = [
      {
        id: 'openai-gpt-4o',
        providerId: 'openai',
        provider: 'openai',
        name: 'gpt-4o',
        displayName: 'GPT-4 Optimized',
        contextWindow: 128000,
        maxOutputTokens: 16384,
        inputCostPer1k: 0.0025,
        outputCostPer1k: 0.01,
        capabilities: ['vision', 'function_calling', 'streaming'],
        performance: { latencyMs: 2000, throughput: 100, quality: 0.95, reliability: 0.99 },
        status: 'active',
      },
      {
        id: 'anthropic-claude-3-sonnet',
        providerId: 'anthropic',
        provider: 'anthropic',
        name: 'claude-3-sonnet-20240229',
        displayName: 'Claude 3 Sonnet',
        contextWindow: 200000,
        maxOutputTokens: 4096,
        inputCostPer1k: 0.003,
        outputCostPer1k: 0.015,
        capabilities: ['vision', 'function_calling', 'streaming'],
        performance: { latencyMs: 2000, throughput: 100, quality: 0.94, reliability: 0.99 },
        status: 'active',
      },
      {
        id: 'anthropic-claude-3-haiku',
        providerId: 'anthropic',
        provider: 'anthropic',
        name: 'claude-3-haiku-20240307',
        displayName: 'Claude 3 Haiku',
        contextWindow: 200000,
        maxOutputTokens: 4096,
        inputCostPer1k: 0.00025,
        outputCostPer1k: 0.00125,
        capabilities: ['vision', 'function_calling', 'streaming'],
        performance: { latencyMs: 800, throughput: 200, quality: 0.85, reliability: 0.99 },
        status: 'active',
      },
    ];

    mockContext = {
      organizationId: 'org-123',
      requestId: 'req-123',
      models: mockModels,
      taskType: 'code-generation',
      contextSize: 2000,
    };
  });

  describe('getMetadata', () => {
    it('should return correct metadata', () => {
      const metadata = strategy.getMetadata();

      expect(metadata.id).toBe('strategy-2');
      expect(metadata.name).toBe('parallel');
      expect(metadata.displayName).toBe('Parallel Execution');
      expect(metadata.minModels).toBe(2);
      expect(metadata.maxModels).toBe(2);
      expect(metadata.estimatedCostMultiplier).toBe(2.0);
      expect(metadata.estimatedQualityBoost).toBe(0.12);
    });
  });

  describe('isSuitable', () => {
    it('should be suitable with 2+ models', () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Generate a function' }],
        task_type: 'code-generation',
      };

      expect(strategy.isSuitable(request, mockContext)).toBe(true);
    });

    it('should not be suitable with only 1 model', () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Generate a function' }],
        task_type: 'code-generation',
      };

      const singleModelContext = { ...mockContext, models: [mockModels[0]] };

      expect(strategy.isSuitable(request, singleModelContext)).toBe(false);
    });

    it('should not be suitable if task type not in suitableFor list', () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'What is 2+2?' }],
        task_type: 'qa',
      };

      const qaContext = { ...mockContext, taskType: 'qa' as const };

      // Parallel strategy is not suitable for QA tasks
      expect(strategy.isSuitable(request, qaContext)).toBe(false);
    });

    it('should not be suitable if budget too low for 2 models', () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Generate code' }],
      };

      // Budget too low for 2 models
      const lowBudgetContext = { ...mockContext, budget: 0.001 };

      expect(strategy.isSuitable(request, lowBudgetContext)).toBe(false);
    });
  });

  describe('scoreForRequest', () => {
    it('should score higher for code-generation tasks', () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Generate a sorting function' }],
        task_type: 'code-generation',
      };

      const score = strategy.scoreForRequest(request, mockContext);

      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('should return 0 for unsuitable requests', () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const singleModelContext = { ...mockContext, models: [mockModels[0]] };

      const score = strategy.scoreForRequest(request, singleModelContext);

      expect(score).toBe(0);
    });

    it('should consider quality target in scoring', () => {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'Generate code' }],
        task_type: 'code-generation',
      };

      const highQualityContext = { ...mockContext, qualityTarget: 0.95 };

      const score = strategy.scoreForRequest(request, highQualityContext);

      expect(score).toBeGreaterThan(0);
    });
  });

  describe('calculateEstimatedCost', () => {
    it('should calculate cost for 2 models', () => {
      const models = [mockModels[0], mockModels[1]]; // GPT-4o + Claude Sonnet
      const inputTokens = 1000;
      const outputTokens = 1000;

      const cost = strategy.calculateEstimatedCost(models, inputTokens, outputTokens);

      // GPT-4o: (1000 * 0.0025 / 1000) + (1000 * 0.01 / 1000) = 0.0125
      // Claude Sonnet: (1000 * 0.003 / 1000) + (1000 * 0.015 / 1000) = 0.018
      // Total: 0.0305
      expect(cost).toBe(0.0305);
    });

    it('should be roughly 2x single model cost', () => {
      const singleModel = [mockModels[0]];
      const twoModels = [mockModels[0], mockModels[0]]; // Same model twice

      const singleCost = strategy.calculateEstimatedCost(singleModel, 1000, 1000);
      const parallelCost = strategy.calculateEstimatedCost(twoModels, 1000, 1000);

      expect(parallelCost).toBe(singleCost * 2);
    });
  });
});

