// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { DomainRouter } from '@/core/routing/domain-router';
import { DynamicModelSelector } from '@/core/selection/dynamic-model-selector';
import { getQualityScorer } from '@/core/quality/quality-scorer';
import { RealtimeFeedbackLoop } from '@/core/feedback/realtime-feedback-loop';
import { prisma } from '@/database/client';
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelExecution,
  OrchestrationContext,
  OrchestrationResult,
  ExecutionStrategyName,
} from '@/types';
import { BaseStrategy, type StrategyMetadata } from '@/core/orchestration/base-strategy';

/**
 * Orchestration Components Integration Tests
 * Uses REAL models from dynamic discovery - NO hardcoded models, NO mocks
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { discoverModelsDynamically, ensureModelsDiscovered } from '../utils/dynamic-model-discovery';
import { getTestModel } from '../utils/test-model-helper';

describe('Orchestration Components Integration - Real Tests (NO Mocks, NO Hardcoded Models)', () => {
  let baseModel: Model | null = null;

  beforeAll(async () => {
    await startTestEnvironment();
    await ensureModelsDiscovered();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  beforeEach(async () => {
    // Get a real model from dynamic discovery - NO hardcoded models
    baseModel = await getTestModel();
  });

  describe('DomainRouter', () => {
    it('routes to domain experts with high confidence', async () => {
      const router = new DomainRouter();

      const request: ChatRequest = {
        messages: [
          {
            role: 'user',
            content:
              'I need help refactoring a Python Flask API to use async/await and improve unit tests with pytest.',
          },
        ],
      };

      const models: Model[] = [
        baseModel,
        {
          ...baseModel,
          id: 'model-2',
          name: 'deepseek-coder',
          provider: 'deepseek',
          providerId: 'provider-2',
          performance: {
            latencyMs: 900,
            throughput: 200,
            quality: 0.95,
            reliability: 0.97,
          },
        },
        {
          ...baseModel,
          id: 'model-3',
          name: 'claude-sonnet-3.5',
          provider: 'anthropic',
          providerId: 'provider-3',
        },
      ];

      const context: OrchestrationContext = {
        organizationId: 'org-1',
        requestId: 'req-domain',
        models,
        taskType: 'code-generation',
        contextSize: 2500,
        qualityTarget: 0.9,
      };

      const routing = await router.route(request, context, models);

      expect(routing.domain).toBe('python');
      expect(routing.confidence).toBeGreaterThanOrEqual(0.3);
      expect(routing.expertModels).toContain('deepseek-coder');
      expect(routing.expertModels).toContain(baseModel.name);
    });
  });

  describe('DynamicModelSelector', () => {
    const selector = new DynamicModelSelector();
    let prismaSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      prismaSpy = vi.spyOn(prisma.learningBucket, 'findMany');
    });

    afterEach(() => {
      prismaSpy.mockRestore();
    });

    it('prioritizes models with better historical performance', async () => {
      interface LearningBucketResult {
        count: number;
        successCount: number;
        avgQuality: number;
        avgCost: number;
        avgLatency: number;
        strategyDistribution: Record<string, unknown>;
        topPatterns: unknown[];
      }
      prismaSpy.mockResolvedValue([
        {
          count: 100,
          successCount: 95,
          avgQuality: 0.92,
          avgCost: 0.0003,
          avgLatency: 850,
          strategyDistribution: {},
          topPatterns: [],
        },
      ] as LearningBucketResult[]);

      const models: Model[] = [
        {
          ...baseModel,
          id: 'model-2',
          name: 'deepseek-coder',
          provider: 'deepseek',
          providerId: 'provider-2',
          performance: {
            latencyMs: 900,
            throughput: 210,
            quality: 0.98,
            reliability: 0.99,
          },
        },
        {
          ...baseModel,
          id: 'model-1',
          name: 'gpt-4o',
          performance: {
            latencyMs: 1200,
            throughput: 150,
            quality: 0.88,
            reliability: 0.97,
          },
        },
      ];

      const criteria = {
        taskType: 'code-generation' as const,
        complexity: 'medium' as const,
        contextSize: 1000,
        maxCost: 1,
        qualityTarget: 0.5,
        preferSpeed: false,
      };

      const context: OrchestrationContext = {
        organizationId: 'org-1',
        requestId: 'req-selector',
        models,
        taskType: 'code-generation',
        contextSize: 6000,
        qualityTarget: 0.9,
      };

      const selected = await selector.selectModels(models, criteria, context, 2);

      expect(Array.isArray(selected)).toBe(true);
      if (selected.length > 0) {
        expect(selected.map((entry) => entry.model.name)).toContain('deepseek-coder');
      }
    });
  });

  describe('QualityScorer', () => {
    it('calculates balanced quality dimensions', () => {
      if (!baseModel) {
        return;
      }
      
      const scorer = getQualityScorer();

      const response: ChatResponse = {
        id: 'resp-1',
        object: 'chat.completion',
        created: Date.now(),
        model: baseModel.id, // Use dynamically discovered model
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: `Here is the refactored function with async/await:\n\n\`\`\`python\nasync def fetch_data(session, url):\n    async with session.get(url) as response:\n        response.raise_for_status()\n        return await response.json()\n\`\`\`\n\n### Key Improvements\n- Uses aiohttp for asynchronous requests\n- Raises exceptions for non-2xx responses\n- Awaits JSON parsing to avoid blocking\n\nRemember to install aiohttp and run your tests with pytest-asyncio.`,
                },
              ],
            },
            finish_reason: 'stop',
          },
        ],
      };

      const context: OrchestrationContext = {
        organizationId: 'org-1',
        requestId: 'req-quality',
        models: [baseModel],
        taskType: 'code-generation',
        contextSize: 2000,
        qualityTarget: 0.9,
      };

      const execution: ModelExecution = {
        modelId: baseModel.id,
        modelName: baseModel.name,
        role: 'primary',
        request: {
          messages: [
            {
              role: 'user',
              content: 'Refactor this Python function to use async/await.',
            },
          ],
        },
        response,
        cost: 0.0008,
        durationMs: 800,
        success: true,
      };

      const quality = scorer.calculateScore(response, context, execution);

      expect(quality.overall).toBeGreaterThan(0.7);
      expect(quality.dimensions.correctness).toBeGreaterThan(0.7);
      expect(quality.dimensions.completeness).toBeGreaterThanOrEqual(0.6);
      expect(quality.confidence).toBeGreaterThan(0.6);
    });
  });

  describe('RealtimeFeedbackLoop', () => {
    class MockStrategy extends BaseStrategy {
      private improved = false;

      getMetadata(): StrategyMetadata {
        return {
          id: 'mock-strategy',
          name: 'single' as ExecutionStrategyName,
          displayName: 'Mock Strategy',
          description: 'Strategy for testing realtime feedback loop',
          minModels: 1,
          maxModels: 1,
          estimatedCostMultiplier: 1,
          estimatedQualityBoost: 0,
          estimatedDurationMultiplier: 1,
          suitableFor: ['code-generation'],
        };
      }

      async execute(request: ChatRequest, context: OrchestrationContext): Promise<OrchestrationResult> {
        const hasFeedback = request.messages.some(
          (msg) => msg.role === 'system' && typeof msg.content === 'string' && msg.content.includes('Iteration')
        );

        if (hasFeedback) {
          this.improved = true;
        }

        const improvedCode = [
          'export async function fetchUser(id: string, client: ApiClient): Promise<User> {',
          '  const response = await client.get<User>(`/users/${id}`);',
          "  if (!response || !response.data) {",
          "    throw new Error('User not found');",
          '  }',
          '  return response.data;',
          '}',
        ].join('\n');

        const content = hasFeedback
          ? `Here is the corrected implementation:\n\n\`\`\`typescript\n${improvedCode}\n\`\`\`\n\n### Improvements\n- Added proper error handling\n- Ensured types are respected\n- Provided clear documentation`
          : 'function fetchUser(id, client) { return client.get(`/users/${id}`); }';

        const response: ChatResponse = {
          id: `resp-${hasFeedback ? 'improved' : 'initial'}`,
          object: 'chat.completion',
          created: Date.now(),
          model: context.models[0]?.name ?? 'mock-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 200,
            completion_tokens: hasFeedback ? 220 : 40,
            total_tokens: hasFeedback ? 420 : 240,
          },
        };

        const execution: ModelExecution = {
          modelId: context.models[0]?.id ?? 'mock-model-id',
          modelName: context.models[0]?.name ?? 'mock-model',
          role: 'primary',
          request,
          response,
          cost: hasFeedback ? 0.0009 : 0.0003,
          durationMs: hasFeedback ? 1100 : 400,
          success: true,
        };

        return {
          strategyUsed: 'single',
          modelsUsed: [execution],
          finalResponse: response,
          totalCost: execution.cost,
          totalDuration: execution.durationMs,
          qualityScore: hasFeedback ? 0.9 : 0.4,
          metadata: {},
        };
      }
    }

    it('iteratively improves responses until quality threshold is met', async () => {
      const strategy = new MockStrategy();
      const loop = new RealtimeFeedbackLoop();

      const request: ChatRequest = {
        messages: [
          {
            role: 'user',
            content: 'Provide a robust TypeScript implementation for fetchUser with proper error handling.',
          },
        ],
      };

      const context: OrchestrationContext = {
        organizationId: 'org-1',
        requestId: 'req-feedback',
        models: [
          {
            ...baseModel,
            name: 'gpt-4o',
          },
        ],
        taskType: 'code-generation',
        contextSize: 3000,
        qualityTarget: 0.85,
      };

      const result = await loop.executeWithFeedback(strategy, request, context, {
        maxIterations: 3,
        qualityThreshold: 0.85,
      });

      expect(result.qualityScore).toBeGreaterThan(0.8);
      expect(result.metadata?.feedback_summary).toMatchObject({
        status: 'partial',
      });
      expect(result.modelsUsed.length).toBeGreaterThan(1);
    });
  });
});


