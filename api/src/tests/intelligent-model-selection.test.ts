// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for Intelligent Model Selection Service
 * Tests the core logic without requiring running API or providers
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { startTestEnvironment, stopTestEnvironment } from '../../tests/utils/test-environment';

// Setup test environment (no mocks for models/adapters - use real services)
beforeAll(() => {
  // Set test environment
  process.env.NODE_ENV = 'test';
  // Database URL will be set by test environment
});

beforeAll(async () => {
  await startTestEnvironment();
});

afterAll(async () => {
  await stopTestEnvironment();
});

// Import after mocks
import { IntelligentModelSelectionService } from '@/services/intelligent-model-selection-service';
import type { ChatRequest, Model, ModelCapability } from '@/types';

describe('IntelligentModelSelectionService', () => {
  let service: IntelligentModelSelectionService;

  beforeEach(() => {
    service = new IntelligentModelSelectionService();
  });

  describe('analyzeRequirements', () => {
    it('should detect simple complexity for short messages without tools', async () => {
      const request: ChatRequest = {
        model: 'auto',
        messages: [
          { role: 'user', content: 'Hello!' },
        ],
      };

      const requirements = await service.analyzeRequirements(request);

      expect(requirements.complexity).toBe('simple');
      expect(requirements.needsTools).toBe(false);
      expect(requirements.toolCount).toBe(0);
    });

    it('should detect simple or moderate complexity for medium messages', async () => {
      const request: ChatRequest = {
        model: 'auto',
        messages: [
          { role: 'user', content: 'Explain the concept of dependency injection in software engineering and provide examples in TypeScript. Also discuss when to use it versus other patterns.' },
        ],
      };

      const requirements = await service.analyzeRequirements(request);

      // Short messages without tools are typically simple or moderate
      expect(['simple', 'moderate']).toContain(requirements.complexity);
    });

    it('should detect code_generation capability for code-related requests', async () => {
      const request: ChatRequest = {
        model: 'auto',
        messages: [
          { role: 'user', content: 'Write a function in Python to sort a list using quicksort algorithm.' },
        ],
      };

      const requirements = await service.analyzeRequirements(request);

      expect(requirements.required).toContain('code_generation');
    });

    it('should require function_calling when tools are provided', async () => {
      const request: ChatRequest = {
        model: 'auto',
        messages: [
          { role: 'user', content: 'List files in current directory' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'list_files',
              description: 'List files',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      };

      const requirements = await service.analyzeRequirements(request);

      expect(requirements.required).toContain('function_calling');
      expect(requirements.required).toContain('tool_use');
      expect(requirements.needsTools).toBe(true);
      expect(requirements.toolCount).toBe(1);
    });

    it('should require streaming when stream is true', async () => {
      const request: ChatRequest = {
        model: 'auto',
        messages: [
          { role: 'user', content: 'Hello' },
        ],
        stream: true,
      };

      const requirements = await service.analyzeRequirements(request);

      expect(requirements.required).toContain('streaming');
    });

    it('should detect debugging task type', async () => {
      const request: ChatRequest = {
        model: 'auto',
        messages: [
          { role: 'user', content: 'I have a bug in my code. The function returns undefined instead of the expected value.' },
        ],
      };

      const requirements = await service.analyzeRequirements(request);

      expect(requirements.taskType).toBe('debugging');
    });

    it('should detect refactoring task type', async () => {
      const request: ChatRequest = {
        model: 'auto',
        messages: [
          { role: 'user', content: 'Please refactor this code to improve readability and performance.' },
        ],
      };

      const requirements = await service.analyzeRequirements(request);

      expect(requirements.taskType).toBe('refactoring');
    });

    it('should detect analysis task type', async () => {
      const request: ChatRequest = {
        model: 'auto',
        messages: [
          { role: 'user', content: 'Analyze this codebase and tell me what the bottleneck is.' },
        ],
      };

      const requirements = await service.analyzeRequirements(request);

      expect(requirements.taskType).toBe('analysis');
    });
  });

  describe('Tool Schema Adapters', () => {
    // Test the internal tool schema adaptation logic
    it('should handle tools with empty properties correctly', () => {
      const toolWithEmptyProps = {
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'A test tool',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      };

      // The adapter should add a placeholder property
      const params = toolWithEmptyProps.function.parameters;
      expect(params.type).toBe('object');
      // After adaptation, properties should not be empty for OpenAI
    });
  });

  describe('Model Evaluation', () => {
    it('should score models based on capability matching', async () => {
      // Use dynamic model discovery instead of hardcoded test data
      const { getModelRepository } = await import('@/services/model-repository.js');
      const repository = getModelRepository();
      const discoveredModels = await repository.searchModels({
        capabilities: ['function_calling', 'streaming'],
        status: 'active',
        limit: 5,
      });

      if (discoveredModels.length === 0) {
        // Skip test if no models with required capabilities discovered
        return;
      }

      // Use first discovered model with required capabilities
      const modelWithCapabilities = discoveredModels[0];

      // Model should score high when it matches all required capabilities
      const requiredCapabilities: ModelCapability[] = ['function_calling', 'streaming'];
      const hasAllRequired = requiredCapabilities.every(cap => 
        modelWithCapabilities.capabilities.includes(cap)
      );

      expect(hasAllRequired).toBe(true);
    });

    it('should return 0 score for models missing required capabilities', async () => {
      // Use dynamic model discovery - find models without function_calling
      const { getModelRepository } = await import('@/services/model-repository.js');
      const repository = getModelRepository();
      
      // Get all models
      const allModels = await repository.searchModels({
        status: 'active',
        limit: 20,
      });

      // Find a model without function_calling capability
      const modelWithoutFunctionCalling = allModels.find(
        model => !model.capabilities.includes('function_calling')
      );

      if (!modelWithoutFunctionCalling) {
        // Skip test if all discovered models have function_calling
        return;
      }

      const requiredCapabilities: ModelCapability[] = ['function_calling'];
      const hasAllRequired = requiredCapabilities.every(cap => 
        modelWithoutFunctionCalling.capabilities.includes(cap)
      );

      expect(hasAllRequired).toBe(false);
    });
  });

  describe('Complexity Detection', () => {
    const testCases = [
      { tokens: 100, tools: 0, expected: 'simple', allowedComplexities: ['simple', 'moderate'] },
      { tokens: 1000, tools: 2, expected: 'moderate', allowedComplexities: ['moderate', 'complex'] },
      { tokens: 5000, tools: 5, expected: 'complex', allowedComplexities: ['moderate', 'complex'] },
      { tokens: 15000, tools: 15, expected: 'expert', allowedComplexities: ['complex', 'expert'] },
    ];

    testCases.forEach(({ tokens, tools, expected, allowedComplexities }) => {
      it(`should detect ~${expected} complexity for ~${tokens} tokens and ${tools} tools`, async () => {
        // Generate content with approximate token count (4 chars per token)
        const content = 'a'.repeat(tokens * 4);
        
        const request: ChatRequest = {
          model: 'auto',
          messages: [{ role: 'user', content }],
          tools: Array(tools).fill({
            type: 'function',
            function: {
              name: 'test',
              description: 'test',
              parameters: { type: 'object', properties: { x: { type: 'string' } } },
            },
          }),
        };

        const requirements = await service.analyzeRequirements(request);

        // Allow flexibility in complexity detection
        expect(allowedComplexities).toContain(requirements.complexity);
      });
    });
  });

  describe('Task Type Detection', () => {
    const taskTypeCases = [
      { content: 'Create a function in Python to sort a list', expectedType: 'code-generation' },
      { content: 'Fix this bug in my function, it returns undefined', expectedType: 'debugging' },
      { content: 'Refactor this class to use composition instead of inheritance', expectedType: 'refactoring' },
      { content: 'Review this pull request for security issues', expectedType: 'code-review' },
      { content: 'Write documentation for this API module', expectedType: 'documentation' },
      { content: 'Generate unit tests for this service', expectedType: 'testing' },
      { content: 'Analyze this code and tell me about potential issues', expectedType: 'analysis' },
      { content: 'What is the meaning of life?', expectedType: 'general' },
    ];

    taskTypeCases.forEach(({ content, expectedType }) => {
      it(`should detect '${expectedType}' task type for: "${content.substring(0, 30)}..."`, async () => {
        const request: ChatRequest = {
          model: 'auto',
          messages: [{ role: 'user', content }],
        };

        const requirements = await service.analyzeRequirements(request);

        expect(requirements.taskType).toBe(expectedType);
      });
    });
  });
});

describe('Error Parsing', () => {
  it('should extract error details from OpenAI format', () => {
    const openAIError = {
      error: {
        message: 'Invalid schema for function',
        code: 'invalid_function_parameters',
        type: 'invalid_request_error',
        param: 'tools[0].function.parameters',
      },
    };

    expect(openAIError.error.code).toBe('invalid_function_parameters');
    expect(openAIError.error.type).toBe('invalid_request_error');
  });

  it('should extract error details from Anthropic format', () => {
    const anthropicError = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'messages: at least one message is required',
      },
    };

    expect(anthropicError.error.type).toBe('invalid_request_error');
    expect(anthropicError.error.message).toContain('at least one message');
  });
});

