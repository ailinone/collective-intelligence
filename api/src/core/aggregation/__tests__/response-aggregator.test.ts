// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for Response Aggregator
 * Voting, Merging, Synthesis, and Ranking aggregation methods
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ResponseAggregator, type ModelResponse, type AggregationContext } from '../response-aggregator';

describe('ResponseAggregator', () => {
  let aggregator: ResponseAggregator;
  let mockResponses: ModelResponse[];
  let mockContext: AggregationContext;

  beforeEach(() => {
    aggregator = new ResponseAggregator();

    mockResponses = [
      {
        modelId: 'gpt-4o',
        modelName: 'GPT-4o',
        response: {
          id: 'resp-1',
          object: 'chat.completion',
          created: Date.now(),
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Solution A: Use recursion with memoization for optimal performance.',
              },
              finish_reason: 'stop',
            },
          ],
        },
        cost: 0.002,
        durationMs: 1500,
        success: true,
      },
      {
        modelId: 'claude-3-5-sonnet',
        modelName: 'Claude 3.5 Sonnet',
        response: {
          id: 'resp-2',
          object: 'chat.completion',
          created: Date.now(),
          model: 'claude-3-5-sonnet',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Solution B: Implement iterative approach with dynamic programming.',
              },
              finish_reason: 'stop',
            },
          ],
        },
        cost: 0.0018,
        durationMs: 1200,
        success: true,
      },
      {
        modelId: 'deepseek-coder',
        modelName: 'DeepSeek Coder',
        response: {
          id: 'resp-3',
          object: 'chat.completion',
          created: Date.now(),
          model: 'deepseek-coder',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Solution C: Use recursion with memoization for optimal performance.',
              },
              finish_reason: 'stop',
            },
          ],
        },
        cost: 0.0005,
        durationMs: 800,
        success: true,
      },
    ];

    mockContext = {
      requestId: 'req-123',
      taskType: 'code-generation',
      qualityThreshold: 0.8,
    };
  });

  describe('Voting Aggregation', () => {
    it('should aggregate responses using voting', async () => {
      const result = await aggregator.aggregate(mockResponses, 'voting', mockContext);

      expect(result.method).toBe('voting');
      expect(result.response).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.metadata.sourcesUsed).toBeDefined();
      expect(result.metadata.totalSources).toBe(3);
    });

    it('should select majority solution', async () => {
      const result = await aggregator.aggregate(mockResponses, 'voting', mockContext);

      // Solutions 1 and 3 are similar (recursion with memoization)
      // Should win by majority (2 out of 3)
      expect(result.confidence).toBeGreaterThanOrEqual(0.66);
    });
  });

  describe('Merging Aggregation', () => {
    it('should merge complementary insights', async () => {
      const result = await aggregator.aggregate(mockResponses, 'merging', mockContext);

      expect(result.method).toBe('merging');
      expect(result.response).toBeDefined();
      expect(result.metadata.mergingResults).toBeDefined();
      expect(result.metadata.mergingResults.totalInsights).toBeGreaterThan(0);
    });
  });

  describe('Synthesis Aggregation', () => {
    it('should synthesize best-of-all response', async () => {
      const result = await aggregator.aggregate(mockResponses, 'synthesis', mockContext);

      expect(result.method).toBe('synthesis');
      expect(result.response).toBeDefined();
      expect(result.metadata.synthesisResults).toBeDefined();
    });
  });

  describe('Ranking Aggregation', () => {
    it('should rank and select best response', async () => {
      const result = await aggregator.aggregate(mockResponses, 'ranking', mockContext);

      expect(result.method).toBe('ranking');
      expect(result.response).toBeDefined();
      expect(result.metadata.rankingResults).toBeDefined();
      expect(result.metadata.rankingResults.rankings).toHaveLength(3);
    });

    it('should rank by quality score', async () => {
      const result = await aggregator.aggregate(mockResponses, 'ranking', mockContext);

      const rankings = result.metadata.rankingResults.rankings;
      expect(rankings[0].rank).toBe(1);
      expect(rankings[0].score).toBeGreaterThanOrEqual(rankings[1].score);
      expect(rankings[1].score).toBeGreaterThanOrEqual(rankings[2].score);
    });
  });

  describe('Error Handling', () => {
    it('should handle empty responses', async () => {
      await expect(aggregator.aggregate([], 'voting', mockContext)).rejects.toThrow();
    });

    it('should handle single response', async () => {
      const singleResponse = [mockResponses[0]];
      const result = await aggregator.aggregate(singleResponse, 'voting', mockContext);

      expect(result.response).toBe(singleResponse[0].response);
      expect(result.confidence).toBe(1.0);
    });
  });
});

