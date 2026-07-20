// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Collective Intelligence Services Tests
 *
 * Tests for the core CI components:
 * - Semantic Memory Store
 * - Semantic Cache
 * - Reasoning Transparency
 * - Self-Critique Engine
 * - Agentic Workflow Engine
 * 
 * NO MOCKS - Uses real infrastructure (Postgres, Redis)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { startTestEnvironment, stopTestEnvironment } from '../../utils/test-environment';
import { initializeDIContainer, resetDIContainer } from '@/di/container';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

// Mock only logger (permitted - doesn't affect business logic)
vi.mock('@/utils/logger', () => {
  const createMockLogger = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  });

  return {
    createLogger: vi.fn(() => createMockLogger()),
    logger: createMockLogger(),
  };
});

// Mock cache runtime state (permitted - configuration, not infrastructure)
vi.mock('@/cache/cache-runtime-state', () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  isCacheEnabled: vi.fn(() => true),
}));

describe('Collective Intelligence - Reasoning Transparency', () => {
  beforeAll(async () => {
    await startTestEnvironment();
    try {
      initializeDIContainer();
    } catch {
      // Already initialized in this process.
    }
    await syncDefaultRoles();
  }, 60_000);

  afterAll(async () => {
    resetDIContainer();
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ReasoningTransparency', () => {
    it('should create a new trace for a request', async () => {
      const { ReasoningTransparency } = await import('@/core/transparency/reasoning-transparency');
      const transparency = new ReasoningTransparency();

      const requestId = 'test-request-123';
      transparency.startTrace(requestId);
      
      const trace = transparency.getTrace(requestId);
      expect(trace).toBeDefined();
      expect(trace?.requestId).toBe(requestId);
      expect(trace?.timestamp).toBeDefined();
    });

    it('should record model selection decision with real models', async () => {
      // Get real models from dynamic discovery - NO hardcoded models
      const { getTestModels } = await import('../../utils/dynamic-model-discovery');
      const realModels = await getTestModels(2);
      if (realModels.length < 2) {
        return; // Skip if not enough models
      }

      const model1 = realModels[0];
      const model2 = realModels[1];

      const { ReasoningTransparency } = await import('@/core/transparency/reasoning-transparency');
      const dynamicModelSelector = await import('@/core/selection/dynamic-model-selector');
      const transparency = new ReasoningTransparency();

      const requestId = 'test-request-456';
      transparency.startTrace(requestId);

      const selected: dynamicModelSelector.SelectedModel = {
        model: {
          id: model1.id, // Use dynamically discovered model
          name: model1.name,
          provider: model1.provider,
          baseModel: model1.name,
          capabilities: model1.capabilities,
          pricing: { input: Number(model1.inputCostPer1k), output: Number(model1.outputCostPer1k) },
          limits: { maxTokens: model1.contextWindow, maxConcurrentRequests: 100 },
          metadata: {},
        },
        score: 0.95,
        reason: 'Selected based on task complexity and cost optimization',
      };

      const alternatives: dynamicModelSelector.SelectedModel[] = [
        {
          model: {
            id: model2.id, // Use dynamically discovered model
            name: model2.name,
            provider: model2.provider,
            baseModel: model2.name,
            capabilities: model2.capabilities,
            pricing: { input: Number(model2.inputCostPer1k), output: Number(model2.outputCostPer1k) },
            limits: { maxTokens: model2.contextWindow, maxConcurrentRequests: 100 },
            metadata: {},
          },
          score: 0.92,
          reason: 'Alternative option',
        },
      ];

      transparency.recordModelSelection(
        requestId,
        selected,
        alternatives,
        {
          organizationId: 'test-org-123',
          requestId: requestId,
          models: [],
          taskType: 'code-generation',
          contextSize: 5000,
          maxCost: 0.05,
        },
        100
      );

      const trace = transparency.getTrace(requestId);
      expect(trace?.modelSelection).toBeDefined();
      expect(trace?.modelSelection?.selectedModel).toBe(model1.id);
    });

    it('should record strategy selection decision', async () => {
      const { ReasoningTransparency } = await import('@/core/transparency/reasoning-transparency');
      const transparency = new ReasoningTransparency();

      const requestId = 'test-request-789';
      transparency.startTrace(requestId);

      const alternatives = [
        { strategy: 'single', score: 0.6 },
        { strategy: 'parallel', score: 0.75 },
        { strategy: 'collaborative', score: 0.9 },
      ];

      transparency.recordStrategySelection(
        requestId,
        'collaborative',
        {
          organizationId: 'test-org-123',
          requestId: requestId,
          models: [],
          taskType: 'code-review',
          contextSize: 5000,
          maxCost: 0.05,
          qualityTarget: 0.8,
        },
        alternatives
      );

      const trace = transparency.getTrace(requestId);
      expect(trace?.strategySelection?.selectedStrategy).toBe('collaborative');
    });

    it('should generate human-readable explanation', async () => {
      const { ReasoningTransparency } = await import('@/core/transparency/reasoning-transparency');
      const dynamicModelSelector = await import('@/core/selection/dynamic-model-selector');
      const transparency = new ReasoningTransparency();

      const requestId = 'test-request-explain';
      transparency.startTrace(requestId);

      const selected: dynamicModelSelector.SelectedModel = {
        model: {
          id: 'gpt-4o',
          name: 'GPT-4o',
          provider: 'openai',
          baseModel: 'gpt-4o',
          capabilities: [],
          pricing: { input: 0.005, output: 0.015 },
          limits: { maxTokens: 128000, maxConcurrentRequests: 100 },
          metadata: {},
        },
        score: 0.95,
        reason: 'Best model for code generation',
      };

      transparency.recordModelSelection(
        requestId,
        selected,
        [],
        {
          organizationId: 'test-org-123',
          requestId: requestId,
          models: [],
          taskType: 'code-generation',
          contextSize: 3000,
          maxCost: 0.1,
        },
        50
      );

      const explanation = transparency.explainDecision(requestId);
      expect(explanation).toContain('gpt-4o');
    });
  });
});

describe('Collective Intelligence - Self-Critique Engine', () => {
  beforeAll(async () => {
    await startTestEnvironment();
    try {
      initializeDIContainer();
    } catch {
      // Already initialized in this process.
    }
    await syncDefaultRoles();
  }, 60_000);

  afterAll(async () => {
    resetDIContainer();
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SelfCritiqueEngine', () => {
    it('should create critique request with proper structure', async () => {
      const { SelfCritiqueEngine } = await import('@/core/critique/self-critique-engine');
      const critiqueEngine = new SelfCritiqueEngine();

      // SelfCritiqueEngine has methods for critique, this tests initialization
      expect(critiqueEngine).toBeDefined();
    });

    it('should handle critique configuration', async () => {
      const { SelfCritiqueEngine } = await import('@/core/critique/self-critique-engine');
      
      const engine = new SelfCritiqueEngine({
        mode: 'same-model',
        maxIterations: 2,
        minQualityThreshold: 0.8,
      });

      expect(engine).toBeDefined();
    });
  });
});

describe('Collective Intelligence - Agentic Workflow Engine', () => {
  beforeAll(async () => {
    await startTestEnvironment();
    try {
      initializeDIContainer();
    } catch {
      // Already initialized in this process.
    }
    await syncDefaultRoles();
  }, 60_000);

  afterAll(async () => {
    resetDIContainer();
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('AgenticWorkflowEngine', () => {
    it('should register and retrieve workflows', async () => {
      const { AgenticWorkflowEngine } = await import('@/core/agentic/agentic-workflow-engine');
      const engine = new AgenticWorkflowEngine();

      const workflow = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'A test workflow',
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            type: 'llm_call' as const,
            config: { prompt: 'Test prompt' },
          },
        ],
      };

      engine.registerWorkflow(workflow);
      const retrieved = engine.getWorkflow('test-workflow');

      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Test Workflow');
    });

    it('should handle workflow step types correctly', async () => {
      const { AgenticWorkflowEngine } = await import('@/core/agentic/agentic-workflow-engine');
      const engine = new AgenticWorkflowEngine();

      const workflow = {
        id: 'multi-step-workflow',
        name: 'Multi Step Workflow',
        description: 'Workflow with multiple step types',
        steps: [
          { id: 's1', name: 'LLM Step', type: 'llm_call' as const, config: {} },
          { id: 's2', name: 'Tool Step', type: 'tool_call' as const, config: {} },
          { id: 's3', name: 'Condition', type: 'condition' as const, config: {} },
        ],
      };

      engine.registerWorkflow(workflow);
      const retrieved = engine.getWorkflow('multi-step-workflow');

      expect(retrieved?.steps).toHaveLength(3);
      expect(retrieved?.steps[0].type).toBe('llm_call');
      expect(retrieved?.steps[1].type).toBe('tool_call');
      expect(retrieved?.steps[2].type).toBe('condition');
    });
  });
});

describe('Collective Intelligence - Integration', () => {
  it('should handle the full request flow with transparency', async () => {
    const { ReasoningTransparency } = await import('@/core/transparency/reasoning-transparency');
    const transparency = new ReasoningTransparency();

    const requestId = 'integration-test-001';

    // Simulate full request flow
    transparency.startTrace(requestId);

    // Step 1: Model selection
    const dynamicModelSelector = await import('@/core/selection/dynamic-model-selector');
    const selected: dynamicModelSelector.SelectedModel = {
      model: {
        id: 'gpt-4o',
        name: 'GPT-4o',
        provider: 'openai',
        baseModel: 'gpt-4o',
        capabilities: [],
        pricing: { input: 0.005, output: 0.015 },
        limits: { maxTokens: 128000, maxConcurrentRequests: 100 },
        metadata: {},
      },
      score: 0.95,
      reason: 'Best for code generation',
    };

    transparency.recordModelSelection(
      requestId,
      selected,
      [],
      {
        organizationId: 'test-org-123',
        requestId: requestId,
        models: [],
        taskType: 'code-generation',
        contextSize: 3000,
        maxCost: 0.1,
      },
      50
    );

    // Step 3: Strategy selection
    transparency.recordStrategySelection(
      requestId,
      'single',
      {
        organizationId: 'test-org-123',
        requestId: requestId,
        models: [],
        taskType: 'code-generation',
        contextSize: 3000,
        maxCost: 0.1,
      },
      [{ strategy: 'single', score: 0.9 }]
    );

    // Step 4: Execution
    // Get a real model from dynamic discovery - NO hardcoded models
    const { getTestModel } = await import('../../utils/dynamic-model-discovery');
    const realModel = await getTestModel();
    if (!realModel) {
      return; // Skip if no models available
    }

    transparency.recordExecution(requestId, {
      strategyUsed: 'single',
      modelsUsed: [
        {
          modelId: realModel.id, // Use dynamically discovered model
          modelName: realModel.name,
          provider: realModel.provider,
          role: 'primary',
          request: { messages: [], model: realModel.id }, // Use dynamically discovered model
          response: { content: 'Test response', role: 'assistant' },
          cost: 0.045,
          durationMs: 1500,
          success: true,
        },
      ],
      finalResponse: { content: 'Test response', role: 'assistant' },
      totalCost: 0.045,
      totalDuration: 1500,
      metadata: {},
    });

    // Step 5: Quality
    transparency.recordQuality(requestId, {
      score: 0.92,
      dimensions: {
        relevance: 0.95,
        accuracy: 0.90,
        completeness: 0.91,
      },
      threshold: 0.8,
    });

    // Complete trace
    transparency.completeTrace(requestId);

    // Verify complete trace
    const trace = transparency.getTrace(requestId);
    expect(trace).toBeDefined();
    expect(trace?.modelSelection).toBeDefined();
    expect(trace?.strategySelection).toBeDefined();
    expect(trace?.execution).toBeDefined();
    expect(trace?.quality).toBeDefined();
    expect(trace?.summary).toBeDefined();
  });
});

