// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for Arbitration System
 * LLM-based arbitration, consensus building, and iterative refinement
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ArbitrationSystem, type CompetitiveSolution } from '../arbitration-system';

describe('ArbitrationSystem', () => {
  let arbitrationSystem: ArbitrationSystem;
  let mockSolutions: CompetitiveSolution[];

  beforeEach(() => {
    arbitrationSystem = new ArbitrationSystem();

    mockSolutions = [
      {
        modelId: 'gpt-4o',
        modelName: 'GPT-4o',
        provider: 'openai',
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
                content: `Here's a comprehensive solution with code examples:\n\n\`\`\`python\ndef fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)\n\`\`\`\n\nThis is a recursive implementation.`,
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 },
        },
        cost: 0.0025,
        durationMs: 1500,
      },
      {
        modelId: 'claude-3-5-sonnet',
        modelName: 'Claude 3.5 Sonnet',
        provider: 'anthropic',
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
                content: `I'll provide an optimized solution:\n\n\`\`\`python\ndef fibonacci(n, memo={}):\n    if n in memo:\n        return memo[n]\n    if n <= 1:\n        return n\n    memo[n] = fibonacci(n-1, memo) + fibonacci(n-2, memo)\n    return memo[n]\n\`\`\`\n\nThis uses memoization for O(n) time complexity.`,
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 180, total_tokens: 280 },
        },
        cost: 0.0027,
        durationMs: 1200,
      },
      {
        modelId: 'deepseek-coder',
        modelName: 'DeepSeek Coder',
        provider: 'deepseek',
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
                content: 'Simple recursive fibonacci function.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        },
        cost: 0.0005,
        durationMs: 800,
      },
    ];
  });

  describe('Arbitration', () => {
    it('should arbitrate between multiple solutions', async () => {
      const arbiterModels = [
        { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
        { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'anthropic' },
      ];

      const result = await arbitrationSystem.arbitrate(mockSolutions, arbiterModels, 0.85);

      expect(result).toBeDefined();
      expect(result.action).toMatch(/accept|request_refinement|reject/);
      expect(result.allScores).toHaveLength(2); // 2 arbiters
      expect(result.allScores![0]).toHaveLength(3); // 3 solutions
    });

    it('should accept high-quality solutions', async () => {
      const arbiterModels = [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }];

      const result = await arbitrationSystem.arbitrate(mockSolutions, arbiterModels, 0.7);

      expect(result.action).toBe('accept');
      expect(result.selectedSolution).toBeDefined();
      expect(result.aggregatedScore).toBeGreaterThanOrEqual(0.7);
    });

    it('should request refinement for medium-quality solutions', async () => {
      const arbiterModels = [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }];

      const result = await arbitrationSystem.arbitrate(mockSolutions, arbiterModels, 0.95);

      if (result.action === 'request_refinement') {
        expect(result.selectedSolution).toBeDefined();
        expect(result.suggestedImprovements).toBeDefined();
        expect(result.aggregatedScore).toBeGreaterThanOrEqual(0.7);
        expect(result.aggregatedScore).toBeLessThan(0.95);
      }
    });
  });

  describe('Consensus Building', () => {
    it('should build consensus from multiple solutions', () => {
      const mockEvaluations = [
        {
          arbiterModel: 'gpt-4o',
          scores: [85, 90, 70],
          strengths: [['Good'], ['Better'], ['OK']],
          weaknesses: [[], [], ['Too brief']],
          recommendation: 'Solution 2 is best',
          suggestedImprovements: [[], [], ['Add more detail']],
          confidence: 0.9,
        },
        {
          arbiterModel: 'claude-3-5-sonnet',
          scores: [80, 95, 65],
          strengths: [['Clear'], ['Excellent'], ['Fast']],
          weaknesses: [[], [], ['Lacks detail']],
          recommendation: 'Solution 2 is best',
          suggestedImprovements: [[], [], ['Expand explanation']],
          confidence: 0.85,
        },
      ];

      const consensus = arbitrationSystem.buildConsensus(mockSolutions, mockEvaluations);

      expect(consensus.consensusSolution).toBeDefined();
      expect(consensus.consensusScore).toBeGreaterThan(0);
      expect(consensus.agreement).toBeGreaterThan(0);
      expect(consensus.agreement).toBeLessThanOrEqual(1);
    });
  });

  describe('Iterative Refinement', () => {
    it('should refine solution until quality threshold', async () => {
      const arbiterModel = { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' };

      const result = await arbitrationSystem.iterativeRefinement(
        mockSolutions[2], // Low quality solution
        arbiterModel,
        0.9,
        3
      );

      expect(result.finalSolution).toBeDefined();
      expect(result.iterations).toBeGreaterThan(0);
      expect(result.iterations).toBeLessThanOrEqual(3);
      expect(result.finalScore).toBeGreaterThan(0);
    });
  });
});

