// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProviderRegistry } from '@/providers/provider-registry';
import { ProviderAdapter } from '@/providers/base/provider-adapter';
import type {
  ChatRequest,
  ChatResponse,
  Model,
  Provider,
  ProviderHealth,
  ExecutionStrategyName,
  OrchestrationContext,
} from '@/types';
import { TriagingService } from '@/core/orchestration/triage-service';

class StubProviderAdapter extends ProviderAdapter {
  constructor(private readonly responses: Map<string, string>) {
    super('stub', 'Stub Provider', { apiKey: 'stub-key' });
  }

  async getProvider(): Promise<Provider> {
    return {
      id: 'stub',
      name: 'stub',
      displayName: 'Stub Provider',
      status: 'active',
      health: await this.healthCheck(),
      models: await this.getModels(),
    };
  }

  async getModels(): Promise<Model[]> {
    return [
      {
        id: 'triage-model',
        providerId: 'stub',
        provider: 'stub',
        name: 'triage-model',
        displayName: 'Triage Model',
        contextWindow: 4096,
        maxOutputTokens: 512,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        capabilities: ['json_mode'],
        performance: {
          latencyMs: 50,
          throughput: 200,
          quality: 0.9,
          reliability: 0.99,
        },
        status: 'active',
      },
    ];
  }

  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const composite = (request.messages ?? [])
      .map((message) => {
        if (typeof message.content === 'string') {
          return message.content;
        }
        try {
          return JSON.stringify(message.content);
        } catch {
          return '';
        }
      })
      .join('\n');

    let content = this.responses.get('default') ?? JSON.stringify({ intent: 'general' });
    for (const [pattern, response] of this.responses.entries()) {
      if (pattern !== 'default' && composite.includes(pattern)) {
        content = response;
        break;
      }
    }

    return {
      id: 'resp',
      object: 'chat.completion',
      created: Date.now() / 1000,
      model: request.model ?? 'triage-model',
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
    };
  }

  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse> {
    yield await this.chatCompletion(request);
  }

  async generateEmbeddings(): Promise<any> {
    throw new Error('not implemented');
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      healthy: true,
      latency: 1,
      checkedAt: new Date(),
    };
  }

  calculateCost(): number {
    return 0;
  }

  normalizeModelName(modelName: string): string {
    return modelName;
  }
}

describe('TriagingService', () => {
  let registry: ProviderRegistry;
  let context: OrchestrationContext;

  beforeEach(async () => {
    registry = new ProviderRegistry();
    context = {
      organizationId: 'org-1',
      requestId: 'req-1',
      models: [],
      taskType: 'general',
      contextSize: 0,
    };
  });

  it('parses structured triage response when adapter succeeds', async () => {
    const responses = new Map<string, string>([
      [
        'default',
        JSON.stringify({
          intent: 'code-generation',
          complexity: 'high',
          recommended_strategy: 'parallel',
          recommended_models: ['gpt-4o'],
          confidence: 0.9,
        }),
      ],
    ]);
    const adapter = new StubProviderAdapter(responses);
    registry.register(adapter);
    const findModelSpy = vi
      .spyOn(registry, 'findModelByName')
      .mockResolvedValue({ model: { id: 'triage-model', name: 'triage-model' } as Model, adapter });

    const triageService = new TriagingService(registry, {
      model: 'triage-model',
      temperature: 0,
      maxTokens: 128,
    });

    const decision = await triageService.triage(
      {
        messages: [{ role: 'user', content: 'Generate a REST API client' }],
      },
      context
    );

    expect(decision).toBeDefined();
    expect(decision?.intent).toBe('code-generation');
    expect(decision?.recommendedStrategy).toBe('parallel');
    expect(decision?.recommendedModels).toEqual(['gpt-4o']);
    findModelSpy.mockRestore();
  });

  it('falls back to heuristics when triage model unavailable', async () => {
    const findModelSpy = vi.spyOn(registry, 'findModelByName').mockResolvedValue(null);
    const triageService = new TriagingService(registry, {
      model: 'missing-model',
      temperature: 0,
      maxTokens: 128,
    });

    const decision = await triageService.triage(
      {
        messages: [{ role: 'user', content: 'Please refactor this legacy function for clarity' }],
      },
      context
    );

    expect(decision).toBeDefined();
    expect(['refactoring', 'code-generation']).toContain(decision?.intent);
    expect(
      decision?.recommendedStrategy === 'quality-multipass' ||
        decision?.recommendedStrategy === 'parallel' ||
        decision?.recommendedStrategy === undefined
    ).toBe(true);
    findModelSpy.mockRestore();
  });

  it('renders the tool catalog into the system prompt ({{TOOLS}} substituted, no raw placeholders)', async () => {
    const { toolRegistry } = await import('@/core/tools/tool-registry');
    toolRegistry.register({
      name: 'web_search',
      description: 'Search the web',
      category: 'web',
      safeForStrategies: true,
      handler: async () => ({ tool_call_id: 't', success: true, output: '' }),
    });

    let capturedSystemPrompt = '';
    const responses = new Map<string, string>([
      ['default', JSON.stringify({ intent: 'general', complexity: 'low', confidence: 0.9 })],
    ]);
    const adapter = new StubProviderAdapter(responses);
    const originalChat = adapter.chatCompletion.bind(adapter);
    adapter.chatCompletion = async (request: ChatRequest) => {
      const sys = request.messages.find((m) => m.role === 'system');
      capturedSystemPrompt = typeof sys?.content === 'string' ? sys.content : '';
      return originalChat(request);
    };
    registry.register(adapter);
    const findModelSpy = vi
      .spyOn(registry, 'findModelByName')
      .mockResolvedValue({ model: { id: 'triage-model', name: 'triage-model' } as Model, adapter });

    const triageService = new TriagingService(registry, {
      model: 'triage-model',
      temperature: 0,
      maxTokens: 128,
    });
    await triageService.triage(
      { messages: [{ role: 'user', content: 'What is happening in the world today?' }] },
      context
    );

    expect(capturedSystemPrompt).toContain('web_search (web): Search the web');
    expect(capturedSystemPrompt).toContain('Classification integrity');
    expect(capturedSystemPrompt).toContain('"route"');
    expect(capturedSystemPrompt).toContain('generation_prompt');
    expect(capturedSystemPrompt).not.toContain('{{TOOLS}}');
    expect(capturedSystemPrompt).not.toContain('{{CAPABILITIES}}');
    findModelSpy.mockRestore();
  });

  it('parses route:"direct_response" for a trivial greeting', async () => {
    const responses = new Map<string, string>([
      [
        'default',
        JSON.stringify({
          intent: 'other',
          complexity: 'low',
          confidence: 0.95,
          route: 'direct_response',
          reason: 'trivial greeting, no real task',
        }),
      ],
    ]);
    const adapter = new StubProviderAdapter(responses);
    registry.register(adapter);
    const findModelSpy = vi
      .spyOn(registry, 'findModelByName')
      .mockResolvedValue({ model: { id: 'triage-model', name: 'triage-model' } as Model, adapter });

    const triageService = new TriagingService(registry, {
      model: 'triage-model',
      temperature: 0,
      maxTokens: 128,
    });

    const decision = await triageService.triage(
      { messages: [{ role: 'user', content: 'oi' }] },
      context
    );

    expect(decision?.route).toBe('direct_response');
    findModelSpy.mockRestore();
  });

  it('parses execution_plan.recommended_tools', async () => {
    const responses = new Map<string, string>([
      [
        'default',
        JSON.stringify({
          intent: 'factual-qa',
          complexity: 'medium',
          confidence: 0.8,
          route: 'planned_execution',
          execution_plan: {
            max_tokens: 1024,
            quality_target: 0.75,
            prefer_speed: false,
            required_capabilities: ['web_search'],
            estimated_input_tokens: 50,
            strategy: 'single',
            model_count: 1,
            requires_continuation: false,
            recommended_tools: ['web_search'],
            stages: [],
          },
        }),
      ],
    ]);
    const adapter = new StubProviderAdapter(responses);
    registry.register(adapter);
    const findModelSpy = vi
      .spyOn(registry, 'findModelByName')
      .mockResolvedValue({ model: { id: 'triage-model', name: 'triage-model' } as Model, adapter });

    const triageService = new TriagingService(registry, {
      model: 'triage-model',
      temperature: 0,
      maxTokens: 128,
    });

    const decision = await triageService.triage(
      { messages: [{ role: 'user', content: 'What happened in the news today?' }] },
      context
    );

    expect(decision?.executionPlan?.recommendedTools).toEqual(['web_search']);
    findModelSpy.mockRestore();
  });

  it('truncates an overlong generation_prompt instead of failing the whole parse', async () => {
    const { TriageStageSchema } = await import('@/core/orchestration/triage-schema');
    const parsed = TriageStageSchema.parse({
      name: 'image_stage',
      strategy: 'single',
      required_capabilities: ['image_generation'],
      max_tokens: 256,
      generation_prompt: 'x'.repeat(3000),
    });
    expect(parsed.generation_prompt?.length).toBe(2000);
  });

  describe('applyTriageStrategy — hard cost filter', () => {
    it('populates maxAverageCostPer1k (hard filter) for speed/cost/balanced/adaptive, not for quality', () => {
      const triageService = new TriagingService(registry, {
        temperature: 0,
        maxTokens: 128,
      }) as unknown as {
        applyTriageStrategy: (
          strategy: string,
          request: ChatRequest,
          ctx: OrchestrationContext,
          caps: string[]
        ) => { maxAverageCostPer1k?: number };
      };
      const request: ChatRequest = { messages: [{ role: 'user', content: 'hi' }] };

      expect(
        triageService.applyTriageStrategy('speed', request, context, []).maxAverageCostPer1k
      ).toBeGreaterThan(0);
      expect(
        triageService.applyTriageStrategy('cost', request, context, []).maxAverageCostPer1k
      ).toBeGreaterThan(0);
      expect(
        triageService.applyTriageStrategy('balanced', request, context, []).maxAverageCostPer1k
      ).toBeGreaterThan(0);
      expect(
        triageService.applyTriageStrategy('adaptive', request, context, []).maxAverageCostPer1k
      ).toBeGreaterThan(0);
      // Quality strategy explicitly opts out of the hard cost cap.
      expect(
        triageService.applyTriageStrategy('quality', request, context, []).maxAverageCostPer1k
      ).toBeUndefined();
    });
  });
  describe('extractJson — balanced-brace parse hardening', () => {
    function callExtractJson(text: string): string | undefined {
      const svc = new TriagingService(registry, { temperature: 0, maxTokens: 128 });
      return (svc as unknown as { extractJson: (t: string) => string | undefined }).extractJson(text);
    }

    it('extracts JSON wrapped in markdown fences with trailing prose containing braces', () => {
      const text = [
        'Here you go:',
        '```json',
        '{"intent":"general","complexity":"low"}',
        '```',
        'Note: {braces} in prose used to corrupt the greedy slice.',
      ].join('\n');
      expect(JSON.parse(callExtractJson(text)!)).toEqual({ intent: 'general', complexity: 'low' });
    });

    it('handles braces inside JSON string values', () => {
      const text = '{"reason":"user wrote {weird} things","intent":"other"}';
      expect(JSON.parse(callExtractJson(text)!)).toEqual({ reason: 'user wrote {weird} things', intent: 'other' });
    });

    it('returns undefined for truncated (unbalanced) output instead of a corrupt slice', () => {
      const truncated = '{"intent":"general","execution_plan":{"stages":[{"name":"ma';
      expect(callExtractJson(truncated)).toBeUndefined();
    });
  });
});
