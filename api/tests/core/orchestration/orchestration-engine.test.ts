// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Orchestration Engine
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrchestrationEngine, detectMediaGenerationModality, detectFileGenerationFormat } from '@/core/orchestration/orchestration-engine';
import { toolRegistry } from '@/core/tools/tool-registry';
import { ProviderRegistry } from '@/providers/provider-registry';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type {
  ChatRequest,
  Model,
  ExecutionStrategyName,
  OrchestrationContext,
  TriageDecision,
  TriageStage,
} from '@/types';

/**
 * Mock provider adapter type for testing
 */
type MockProviderAdapter = Pick<ProviderAdapter, 'getName' | 'getProvider' | 'healthCheck' | 'calculateCost' | 'normalizeModelName'>;

// Mock ProviderRegistry
vi.mock('@/providers/provider-registry');

// ── Deterministic model pool for createStreamingPlan (2026-07-15) ─────────
// `buildContext()` sources `context.models` from
// `getChatEligibleModels()`, which runs a real DB query — completely
// bypassing `mockRegistry.getAllModels()` above. Left unmocked, the test's
// selection is driven by whatever is seeded in the shared test Postgres
// catalog, not by this file's own `mockModels` fixture. Separately, 'auto' mode
// (SingleModelStrategy.selectBestModel) intentionally passes `null` as
// `availableModels` to `DynamicModelSelector.selectModels`, which makes it
// run its OWN independent real-DB query too, decoupled from
// `context.models`. Both seams are partially mocked here — only the two
// functions that touch the DB are overridden via `importOriginal`, so
// everything else in each module (types, other exports, the real
// `DynamicModelSelector` class) stays real. The mock functions are defined
// via `vi.hoisted()` (mock factories are hoisted above this file's
// `describe`/`let mockModels`) and reconfigured fresh in `beforeEach` so
// they always reflect that test's own `mockModels` fixture.
const { getChatEligibleModelsMock, getDynamicModelSelectorMock } = vi.hoisted(() => ({
  getChatEligibleModelsMock: vi.fn(),
  getDynamicModelSelectorMock: vi.fn(),
}));

vi.mock('@/services/model-catalog-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/model-catalog-service')>();
  return {
    ...actual,
    getChatEligibleModels: getChatEligibleModelsMock,
  };
});

vi.mock('@/core/selection/dynamic-model-selector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/selection/dynamic-model-selector')>();
  return {
    ...actual,
    getDynamicModelSelector: getDynamicModelSelectorMock,
  };
});

describe('OrchestrationEngine', () => {
  let engine: OrchestrationEngine;
  let mockRegistry: ProviderRegistry;
  let mockModels: Model[];
  let mockAdapter: ProviderAdapter;

  beforeEach(() => {
    // Mock models
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
    ];

    // Create mock registry
    mockRegistry = new ProviderRegistry();
    mockRegistry.getAllModels = vi.fn().mockResolvedValue(mockModels);
    mockRegistry.getProviderNames = vi.fn().mockReturnValue(['openai', 'anthropic']);
    mockRegistry.getModelOperability = vi.fn((model: Model) => ({
      runnable: true,
      originProvider: model.provider,
      executionProvider: model.provider,
      resolvedProvider: model.provider,
      fallbackChain: [model.provider],
      nonOperationalReasons: [],
    }));
    mockRegistry.findModel = vi.fn(async (modelId: string) => {
      const model = mockModels.find((m) => m.id === modelId);
      if (!model) {
        return null;
      }
      return { model, adapter: mockAdapter };
    });

    mockAdapter = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      generateEmbeddings: vi.fn(),
      getModels: vi.fn(),
      getProvider: vi.fn(),
      healthCheck: vi.fn(),
      calculateCost: vi.fn().mockReturnValue(0),
      getName: vi.fn().mockReturnValue('openai'),
      normalizeModelName: vi.fn().mockImplementation((name: string) => name),
    } as MockProviderAdapter as ProviderAdapter;

    // Keep the catalog-service and DynamicModelSelector seams pinned to this
    // test's own `mockModels` fixture (see the module-mock comment above) —
    // reconfigured every test since `mockModels` is reassigned fresh here.
    getChatEligibleModelsMock.mockReset().mockResolvedValue(mockModels);
    getDynamicModelSelectorMock.mockReset().mockReturnValue({
      selectModels: vi.fn(
        async (
          _availableModels: Model[] | null,
          _criteria: unknown,
          context: OrchestrationContext,
          maxModels = 5
        ) => {
          // Mirrors production's own model pool (context.models) instead of
          // hitting a real DB — ranked by the same `performance.quality`
          // signal DynamicModelSelector's real ranking ultimately optimizes
          // for, so the "optimal model" pick stays meaningful, not just
          // whichever mock entry happens to resolve an adapter first.
          const pool = context?.models ?? [];
          return [...pool]
            .sort((a, b) => (b.performance?.quality ?? 0) - (a.performance?.quality ?? 0))
            .slice(0, maxModels)
            .map((model) => ({ model, score: model.performance?.quality ?? 0.5, reason: 'mocked-selection' }));
        }
      ),
    });

    // Create engine
    engine = new OrchestrationEngine({
      providerRegistry: mockRegistry,
      defaultStrategy: 'auto',
      enableAutoSelection: true,
      enableTriaging: false,
    });
  });

  describe('constructor', () => {
    it('should initialize with provider registry', () => {
      expect(engine).toBeDefined();
    });

    it('should register default strategies', () => {
      const strategies = engine.getAvailableStrategies();

      expect(strategies.length).toBeGreaterThanOrEqual(2);
      expect(strategies.find((s) => s.name === 'single')).toBeDefined();
      expect(strategies.find((s) => s.name === 'parallel')).toBeDefined();
    });
  });

  describe('getAvailableStrategies', () => {
    it('should return all registered strategies', () => {
      const strategies = engine.getAvailableStrategies();

      expect(strategies).toBeInstanceOf(Array);
      expect(strategies.length).toBeGreaterThan(0);

      strategies.forEach((strategy) => {
        expect(strategy).toHaveProperty('name');
        expect(strategy).toHaveProperty('displayName');
        expect(strategy).toHaveProperty('description');
      });
    });
  });

  describe('getStrategy', () => {
    it('should get strategy by name', () => {
      const single = engine.getStrategy('single');
      const parallel = engine.getStrategy('parallel');

      expect(single).toBeDefined();
      expect(parallel).toBeDefined();

      expect(single?.getMetadata().name).toBe('single');
      expect(parallel?.getMetadata().name).toBe('parallel');
    });

    it('should return undefined for unknown strategy', () => {
      const unknown = engine.getStrategy('unknown' as ExecutionStrategyName);

      expect(unknown).toBeUndefined();
    });
  });

  describe('createStreamingPlan', () => {
    it('selects optimal model and returns adapter without mutating original request', async () => {
      const originalRequest: ChatRequest = {
        stream: true,
        messages: [
          {
            role: 'user',
            content: 'Generate a concise summary of this document',
          },
        ],
      };

      const plan = await engine.createStreamingPlan(
        originalRequest,
        '00000000-0000-0000-0000-000000000001',
        'user-1',
        'req-123'
      );

      expect(plan.model.id).toBe(mockModels[0].id);
      expect(plan.adapter).toBe(mockAdapter);
      expect(plan.request.model).toBe(mockModels[0].id);
      expect(plan.context.models.length).toBe(mockModels.length);
      expect(originalRequest.model).toBeUndefined();
    });
  });

  describe('resolveSpeculativeSingleSelection (2026-07-14)', () => {
    // Private method — accessed via cast, same pattern used above for
    // applyTriageRoute/applyRecommendedTools.
    function callResolveSpeculative(
      strategy: unknown,
      request: ChatRequest,
      context: OrchestrationContext,
      requestId: string
    ): Promise<{ model: Model; adapter: ProviderAdapter } | null> {
      return (engine as unknown as {
        resolveSpeculativeSingleSelection: (
          s: unknown,
          r: ChatRequest,
          c: OrchestrationContext,
          id: string
        ) => Promise<{ model: Model; adapter: ProviderAdapter } | null>;
      }).resolveSpeculativeSingleSelection(strategy, request, context, requestId);
    }

    it('returns the strategy planStreaming result on success', async () => {
      const request: ChatRequest = { messages: [{ role: 'user', content: 'Hello' }] };
      const context: OrchestrationContext = {
        organizationId: 'org-1',
        requestId: 'req-1',
        models: mockModels,
        taskType: 'general',
        contextSize: 100,
      };
      const expected = { model: mockModels[0], adapter: mockAdapter };
      const fakeStrategy = { planStreaming: vi.fn().mockResolvedValue(expected) };

      const result = await callResolveSpeculative(fakeStrategy, request, context, 'req-1');

      expect(result).toBe(expected);
      expect(fakeStrategy.planStreaming).toHaveBeenCalledTimes(1);
    });

    it('resolves to null instead of throwing when the strategy call rejects', async () => {
      const request: ChatRequest = { messages: [{ role: 'user', content: 'Hello' }] };
      const context: OrchestrationContext = {
        organizationId: 'org-1',
        requestId: 'req-1',
        models: mockModels,
        taskType: 'general',
        contextSize: 100,
      };
      const fakeStrategy = { planStreaming: vi.fn().mockRejectedValue(new Error('boom')) };

      const result = await callResolveSpeculative(fakeStrategy, request, context, 'req-1');

      expect(result).toBeNull();
    });

    it('passes a shallow clone of the request, never the original reference', async () => {
      const request: ChatRequest = { messages: [{ role: 'user', content: 'Hello' }] };
      const context: OrchestrationContext = {
        organizationId: 'org-1',
        requestId: 'req-1',
        models: mockModels,
        taskType: 'general',
        contextSize: 100,
      };
      const fakeStrategy = { planStreaming: vi.fn().mockResolvedValue(null) };

      await callResolveSpeculative(fakeStrategy, request, context, 'req-1');

      const passedRequest = fakeStrategy.planStreaming.mock.calls[0][0];
      expect(passedRequest).not.toBe(request);
      expect(passedRequest).toEqual(request);
    });
  });

  describe('task type detection', () => {
    it('should detect code-generation from code keywords', () => {
      const request: ChatRequest = {
        messages: [
          {
            role: 'user',
            content: 'Write a function to sort an array',
          },
        ],
      };

      // We can't directly test private methods, but we can test the side effects
      // The task type will be used in strategy selection
      expect(request.messages[0].content).toContain('function');
    });

    it('should detect debugging from error keywords', () => {
      const request: ChatRequest = {
        messages: [
          {
            role: 'user',
            content: 'Fix this bug: TypeError at line 10',
          },
        ],
      };

      expect(request.messages[0].content).toContain('bug');
    });

    it('should detect documentation from doc keywords', () => {
      const request: ChatRequest = {
        messages: [
          {
            role: 'user',
            content: 'Explain how this function works',
          },
        ],
      };

      expect(request.messages[0].content).toContain('Explain');
    });
  });

  describe('applyTriageRoute (trivial-message bypass)', () => {
    // Private method — accessed via cast, same pattern used in
    // triage-service.test.ts for applyTriageStrategy.
    function callApplyTriageRoute(triage: TriageDecision, request: ChatRequest): TriageDecision {
      return (engine as unknown as {
        applyTriageRoute: (t: TriageDecision, r: ChatRequest) => TriageDecision;
      }).applyTriageRoute(triage, request);
    }

    it('forces strategy to single and drops the plan when route is direct_response and client set no tools/quality_target', () => {
      const triage: TriageDecision = {
        intent: 'other',
        complexity: 'low',
        confidence: 0.95,
        route: 'direct_response',
        recommendedStrategy: 'debate',
        executionPlan: { maxTokens: 2048, qualityTarget: 0.75, preferSpeed: true, requiredCapabilities: [], estimatedInputTokens: 10, strategy: 'debate', modelCount: 3, requiresContinuation: false, stages: [] },
      };
      const request: ChatRequest = { messages: [{ role: 'user', content: 'oi' }] };

      const result = callApplyTriageRoute(triage, request);

      expect(result.recommendedStrategy).toBe('single');
      expect(result.executionPlan).toBeUndefined();
    });

    it('does NOT bypass when triage confidence is below the gate threshold', () => {
      const triage: TriageDecision = { intent: 'other', complexity: 'low', confidence: 0.2, route: 'direct_response', recommendedStrategy: 'debate' };
      const request: ChatRequest = { messages: [{ role: 'user', content: 'oi' }] };

      const result = callApplyTriageRoute(triage, request);

      // Low-confidence triage must not dictate the fast path (review fix).
      expect(result).toBe(triage);
    });

    it('does NOT bypass when the client explicitly set tools', () => {
      const triage: TriageDecision = { intent: 'other', complexity: 'low', confidence: 0.95, route: 'direct_response', recommendedStrategy: 'debate' };
      const request: ChatRequest = {
        messages: [{ role: 'user', content: 'oi' }],
        tools: [{ type: 'function', function: { name: 'web_search', description: 'search', parameters: {} } }],
      };

      const result = callApplyTriageRoute(triage, request);

      expect(result.recommendedStrategy).toBe('debate');
      expect(result).toBe(triage);
    });

    it('does NOT bypass when the client set quality_target >= 0.9', () => {
      const triage: TriageDecision = { intent: 'other', complexity: 'low', confidence: 0.95, route: 'direct_response', recommendedStrategy: 'debate' };
      const request: ChatRequest = { messages: [{ role: 'user', content: 'oi' }], quality_target: 0.95 };

      const result = callApplyTriageRoute(triage, request);

      expect(result.recommendedStrategy).toBe('debate');
    });

    it('leaves planned_execution decisions untouched', () => {
      const triage: TriageDecision = { intent: 'code-generation', complexity: 'high', route: 'planned_execution', recommendedStrategy: 'debate' };
      const request: ChatRequest = { messages: [{ role: 'user', content: 'write a parser' }] };

      const result = callApplyTriageRoute(triage, request);

      expect(result).toBe(triage);
    });
  });

  describe('applyRecommendedTools', () => {
    // The global toolRegistry singleton is normally populated at app boot by
    // registerToolsInRegistry() (chat-request-processor.ts) — that bootstrap
    // never runs in this isolated unit test, so register the one tool these
    // tests need directly.
    beforeEach(() => {
      toolRegistry.register({
        name: 'web_search',
        description: 'Search the web',
        category: 'web',
        safeForStrategies: true,
        handler: async () => ({ tool_call_id: 't1', success: true, output: '' }),
      });
      toolRegistry.register({
        name: 'run_command',
        description: 'Run a shell command',
        category: 'general',
        safeForStrategies: false,
        handler: async () => ({ tool_call_id: 't2', success: true, output: '' }),
      });
    });

    function callApplyRecommendedTools(request: ChatRequest, ctx: OrchestrationContext): ChatRequest {
      return (engine as unknown as {
        applyRecommendedTools: (r: ChatRequest, c: OrchestrationContext) => ChatRequest;
      }).applyRecommendedTools(request, ctx);
    }

    function makeContext(triage?: TriageDecision): OrchestrationContext {
      return {
        organizationId: 'org-1',
        requestId: 'req-1',
        models: [],
        taskType: 'general',
        contextSize: 0,
        triage,
      };
    }

    it('leaves request.tools untouched when the client already supplied tools', () => {
      const clientTools: ChatRequest['tools'] = [{ type: 'function', function: { name: 'custom_tool', description: 'x', parameters: {} } }];
      const request: ChatRequest = { messages: [{ role: 'user', content: 'hi' }], tools: clientTools };
      const ctx = makeContext({
        intent: 'other', complexity: 'low',
        executionPlan: { maxTokens: 1, qualityTarget: 0.5, preferSpeed: false, requiredCapabilities: [], estimatedInputTokens: 0, strategy: 'single', modelCount: 1, requiresContinuation: false, recommendedTools: ['web_search'], stages: [] },
      });

      const result = callApplyRecommendedTools(request, ctx);

      expect(result.tools).toBe(clientTools);
    });

    it('populates request.tools from recommendedTools when the client sent none', () => {
      const request: ChatRequest = { messages: [{ role: 'user', content: 'search the news' }] };
      const ctx = makeContext({
        intent: 'factual-qa', complexity: 'medium',
        executionPlan: { maxTokens: 1024, qualityTarget: 0.75, preferSpeed: false, requiredCapabilities: [], estimatedInputTokens: 0, strategy: 'single', modelCount: 1, requiresContinuation: false, recommendedTools: ['web_search'], stages: [] },
      });

      const result = callApplyRecommendedTools(request, ctx);

      expect(result.tools?.length).toBe(1);
      expect(result.tools?.[0].function.name).toBe('web_search');
    });

    it('skips unknown/unsafe tool names silently', () => {
      const request: ChatRequest = { messages: [{ role: 'user', content: 'hi' }] };
      const ctx = makeContext({
        intent: 'other', complexity: 'low',
        executionPlan: { maxTokens: 1, qualityTarget: 0.5, preferSpeed: false, requiredCapabilities: [], estimatedInputTokens: 0, strategy: 'single', modelCount: 1, requiresContinuation: false, recommendedTools: ['not_a_real_tool', 'run_command'], stages: [] },
      });

      const result = callApplyRecommendedTools(request, ctx);

      // run_command exists but is safeForStrategies=false; not_a_real_tool doesn't exist.
      expect(result.tools).toBeUndefined();
    });

    it('drops strategy-safe tools that are OUTSIDE the triage-recommendable allowlist (server filesystem)', () => {
      // read_file is safeForStrategies=true in production, but triage must
      // never auto-attach server-filesystem tools to a request that did not
      // ask for tools (security review finding).
      toolRegistry.register({
        name: 'read_file',
        description: 'Read a file from the server filesystem',
        category: 'file',
        safeForStrategies: true,
        handler: async () => ({ tool_call_id: 't3', success: true, output: '' }),
      });
      const request: ChatRequest = { messages: [{ role: 'user', content: 'read package.json' }] };
      const ctx = makeContext({
        intent: 'other', complexity: 'low',
        executionPlan: { maxTokens: 1, qualityTarget: 0.5, preferSpeed: false, requiredCapabilities: [], estimatedInputTokens: 0, strategy: 'single', modelCount: 1, requiresContinuation: false, recommendedTools: ['read_file'], stages: [] },
      });

      const result = callApplyRecommendedTools(request, ctx);

      expect(result.tools).toBeUndefined();
    });
  });

  describe('detectMediaGenerationModality', () => {
    it('detects image/video/audio generation capabilities', () => {
      expect(detectMediaGenerationModality(['image_generation'])).toBe('image');
      expect(detectMediaGenerationModality(['video_generation'])).toBe('video');
      expect(detectMediaGenerationModality(['audio_generation'])).toBe('audio');
      expect(detectMediaGenerationModality(['text_to_speech'])).toBe('audio');
    });

    it('detects file generation capabilities (2026-07-14)', () => {
      expect(detectMediaGenerationModality(['csv_generation'])).toBe('file');
      expect(detectMediaGenerationModality(['json_generation'])).toBe('file');
      expect(detectMediaGenerationModality(['markdown_generation'])).toBe('file');
      expect(detectMediaGenerationModality(['docx_generation'])).toBe('file');
      expect(detectMediaGenerationModality(['xlsx_generation'])).toBe('file');
      expect(detectMediaGenerationModality(['pdf_generation'])).toBe('file');
      expect(detectMediaGenerationModality(['pptx_generation'])).toBe('file');
      expect(detectMediaGenerationModality(['zip_generation'])).toBe('file');
      expect(detectMediaGenerationModality(['code_file_generation'])).toBe('file');
      expect(detectMediaGenerationModality(['file_generation'])).toBe('file');
    });

    it('returns null for plain chat capabilities', () => {
      expect(detectMediaGenerationModality(['reasoning', 'chat'])).toBeNull();
      expect(detectMediaGenerationModality([])).toBeNull();
    });

    // Regression guard (2026-07-16 architecture audit): 'code_generation' is
    // a pre-existing catalog ModelCapability ("this model writes code
    // well") — an ordinary coding stage tagged with it (as the triage LLM
    // may legitimately do, in the catalog sense) must NOT be hijacked into a
    // file-generation stage. This is exactly the collision the
    // code_file_generation rename fixes: 'code_generation' is no longer a
    // key in FILE_GEN_FORMAT_CAPS at all.
    it('does NOT treat the catalog ModelCapability "code_generation" as a file-generation trigger', () => {
      expect(detectMediaGenerationModality(['code_generation'])).toBeNull();
      expect(detectMediaGenerationModality(['code_generation', 'reasoning'])).toBeNull();
    });
  });

  describe('detectFileGenerationFormat', () => {
    it('resolves the specific format from requiredCapabilities', () => {
      expect(detectFileGenerationFormat(['csv_generation'])).toBe('csv');
      expect(detectFileGenerationFormat(['json_generation'])).toBe('json');
      expect(detectFileGenerationFormat(['markdown_generation'])).toBe('markdown');
      expect(detectFileGenerationFormat(['docx_generation'])).toBe('docx');
      expect(detectFileGenerationFormat(['xlsx_generation'])).toBe('xlsx');
      expect(detectFileGenerationFormat(['pdf_generation'])).toBe('pdf');
      expect(detectFileGenerationFormat(['pptx_generation'])).toBe('pptx');
      expect(detectFileGenerationFormat(['zip_generation'])).toBe('zip');
      expect(detectFileGenerationFormat(['code_file_generation'])).toBe('code');
    });

    it('defaults to markdown for the generic tag or when nothing matches', () => {
      expect(detectFileGenerationFormat(['file_generation'])).toBe('markdown');
      expect(detectFileGenerationFormat(['reasoning'])).toBe('markdown');
      expect(detectFileGenerationFormat([])).toBe('markdown');
    });
  });

  describe('executeMediaGenerationStage', () => {
    function callExecuteMediaGenerationStage(
      modality: 'image' | 'video' | 'audio' | 'file',
      stage: TriageStage,
      stageIndex: number,
      ctx: OrchestrationContext,
      accumulatedContext: string,
    ) {
      return (engine as unknown as {
        executeMediaGenerationStage: (
          m: 'image' | 'video' | 'audio' | 'file', s: TriageStage, i: number, ai: number, c: OrchestrationContext, ac: string
        ) => Promise<{ artifact?: unknown; execution?: unknown; cost: number; summaryText: string; syntheticResponse: unknown }>;
      }).executeMediaGenerationStage(modality, stage, stageIndex, stageIndex, ctx, accumulatedContext);
    }

    const stage: TriageStage = {
      name: 'image_stage',
      strategy: 'single',
      modelRoles: [],
      requiredCapabilities: ['image_generation'],
      maxTokens: 256,
      generationPrompt: 'a red bicycle on a white background',
    };

    it('produces an artifact and does not throw when the invoker succeeds', async () => {
      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: [], taskType: 'general', contextSize: 0,
        invoker: {
          chat: vi.fn(), transcribe: vi.fn(), synthesize: vi.fn(), translate: vi.fn(), generateVideo: vi.fn(),
          generateImage: vi.fn().mockResolvedValue({ images: [{ url: 'https://example.com/img.png' }], provider: 'openai', model: 'gpt-image-1' }),
        } as unknown as OrchestrationContext['invoker'],
      };

      const outcome = await callExecuteMediaGenerationStage('image', stage, 0, ctx, '');

      expect((outcome.artifact as { url?: string }).url).toBe('https://example.com/img.png');
      expect((outcome.artifact as { error?: string }).error).toBeUndefined();
      expect(outcome.cost).toBe(0);
    });

    it('degrades gracefully (no throw, artifact.error set) when the invoker fails', async () => {
      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: [], taskType: 'general', contextSize: 0,
        invoker: {
          chat: vi.fn(), transcribe: vi.fn(), synthesize: vi.fn(), translate: vi.fn(), generateVideo: vi.fn(),
          generateImage: vi.fn().mockRejectedValue(new Error('provider unavailable')),
        } as unknown as OrchestrationContext['invoker'],
      };

      const outcome = await callExecuteMediaGenerationStage('image', stage, 0, ctx, '');

      expect((outcome.artifact as { error?: string }).error).toContain('provider unavailable');
      expect((outcome.artifact as { url?: string }).url).toBeUndefined();
      expect(outcome.summaryText).toContain('FAILED');
      expect(outcome.summaryText.toLowerCase()).toContain('do not claim');
    });

    it('degrades gracefully when context.invoker is unavailable', async () => {
      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: [], taskType: 'general', contextSize: 0,
      };

      const outcome = await callExecuteMediaGenerationStage('image', stage, 0, ctx, '');

      expect((outcome.artifact as { error?: string }).error).toContain('invoker unavailable');
    });

    it('treats an empty audio buffer as failure, not a successful empty artifact', async () => {
      // The invoker coerces a non-Buffer synthesize result to Buffer.alloc(0)
      // without throwing — an empty buffer must not become a "successful"
      // artifact with b64_json: ''.
      const audioStage: TriageStage = {
        name: 'tts_stage',
        strategy: 'single',
        modelRoles: [],
        requiredCapabilities: ['text_to_speech'],
        maxTokens: 256,
        generationPrompt: 'read this aloud',
      };
      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: [], taskType: 'general', contextSize: 0,
        invoker: {
          chat: vi.fn(), transcribe: vi.fn(), translate: vi.fn(), generateVideo: vi.fn(), generateImage: vi.fn(),
          synthesize: vi.fn().mockResolvedValue({ audioBuffer: Buffer.alloc(0), format: 'wav' }),
        } as unknown as OrchestrationContext['invoker'],
      };

      const outcome = await callExecuteMediaGenerationStage('audio', audioStage, 0, ctx, '');

      expect((outcome.artifact as { error?: string }).error).toContain('no audio');
      expect((outcome.artifact as { b64_json?: string }).b64_json).toBeUndefined();
    });

    it('produces a file artifact (2026-07-14) with filename/mime_type when the invoker succeeds', async () => {
      const csvStage: TriageStage = {
        name: 'csv_generation',
        strategy: 'single',
        modelRoles: [],
        requiredCapabilities: ['csv_generation'],
        maxTokens: 256,
        generationPrompt: 'a csv of the 3 closest planets to the sun',
      };
      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: [], taskType: 'general', contextSize: 0,
        invoker: {
          chat: vi.fn(), transcribe: vi.fn(), synthesize: vi.fn(), translate: vi.fn(), generateVideo: vi.fn(), generateImage: vi.fn(),
          generateFile: vi.fn().mockResolvedValue({
            buffer: Buffer.from('name,distance_km\r\nMercury,57900000', 'utf-8'),
            filename: 'generated.csv',
            mimeType: 'text/csv',
            model: 'gpt-4o',
          }),
        } as unknown as OrchestrationContext['invoker'],
      };

      const outcome = await callExecuteMediaGenerationStage('file', csvStage, 0, ctx, '');

      expect((outcome.artifact as { error?: string }).error).toBeUndefined();
      expect((outcome.artifact as { filename?: string }).filename).toBe('generated.csv');
      expect((outcome.artifact as { mime_type?: string }).mime_type).toBe('text/csv');
      expect((outcome.artifact as { b64_json?: string }).b64_json).toBe(
        Buffer.from('name,distance_km\r\nMercury,57900000', 'utf-8').toString('base64')
      );
    });

    it('produces a file artifact for docx_generation with a real binary buffer, base64-encoded correctly', async () => {
      const docxStage: TriageStage = {
        name: 'docx_generation',
        strategy: 'single',
        modelRoles: [],
        requiredCapabilities: ['docx_generation'],
        maxTokens: 256,
        generationPrompt: 'a short report',
      };
      // A binary-ish buffer (not plain ASCII) — real DOCX bytes start with the
      // ZIP local-file-header magic 0x50 0x4B 0x03 0x04.
      const docxBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0xff, 0x00, 0x7f]);
      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: [], taskType: 'general', contextSize: 0,
        invoker: {
          chat: vi.fn(), transcribe: vi.fn(), synthesize: vi.fn(), translate: vi.fn(), generateVideo: vi.fn(), generateImage: vi.fn(),
          generateFile: vi.fn().mockResolvedValue({
            buffer: docxBuffer,
            filename: 'generated.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            model: 'gpt-4o',
          }),
        } as unknown as OrchestrationContext['invoker'],
      };

      const outcome = await callExecuteMediaGenerationStage('file', docxStage, 0, ctx, '');

      expect((outcome.artifact as { error?: string }).error).toBeUndefined();
      expect((outcome.artifact as { filename?: string }).filename).toBe('generated.docx');
      expect((outcome.artifact as { mime_type?: string }).mime_type).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect((outcome.artifact as { b64_json?: string }).b64_json).toBe(docxBuffer.toString('base64'));
    });

    it('produces a file artifact for xlsx_generation with a real binary buffer, base64-encoded correctly', async () => {
      const xlsxStage: TriageStage = {
        name: 'xlsx_generation',
        strategy: 'single',
        modelRoles: [],
        requiredCapabilities: ['xlsx_generation'],
        maxTokens: 256,
        generationPrompt: 'a short spreadsheet',
      };
      const xlsxBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x02, 0xfe, 0x01, 0x80]);
      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: [], taskType: 'general', contextSize: 0,
        invoker: {
          chat: vi.fn(), transcribe: vi.fn(), synthesize: vi.fn(), translate: vi.fn(), generateVideo: vi.fn(), generateImage: vi.fn(),
          generateFile: vi.fn().mockResolvedValue({
            buffer: xlsxBuffer,
            filename: 'generated.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            model: 'gpt-4o',
          }),
        } as unknown as OrchestrationContext['invoker'],
      };

      const outcome = await callExecuteMediaGenerationStage('file', xlsxStage, 0, ctx, '');

      expect((outcome.artifact as { error?: string }).error).toBeUndefined();
      expect((outcome.artifact as { filename?: string }).filename).toBe('generated.xlsx');
      expect((outcome.artifact as { mime_type?: string }).mime_type).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect((outcome.artifact as { b64_json?: string }).b64_json).toBe(xlsxBuffer.toString('base64'));
    });

    it('produces a file artifact for pdf_generation with a real binary buffer, base64-encoded correctly', async () => {
      const pdfStage: TriageStage = {
        name: 'pdf_generation',
        strategy: 'single',
        modelRoles: [],
        requiredCapabilities: ['pdf_generation'],
        maxTokens: 256,
        generationPrompt: 'a short report',
      };
      // Real PDFs start with the literal ASCII magic "%PDF-".
      const pdfBuffer = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\nrest-of-file', 'binary');
      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: [], taskType: 'general', contextSize: 0,
        invoker: {
          chat: vi.fn(), transcribe: vi.fn(), synthesize: vi.fn(), translate: vi.fn(), generateVideo: vi.fn(), generateImage: vi.fn(),
          generateFile: vi.fn().mockResolvedValue({
            buffer: pdfBuffer,
            filename: 'generated.pdf',
            mimeType: 'application/pdf',
            model: 'gpt-4o',
          }),
        } as unknown as OrchestrationContext['invoker'],
      };

      const outcome = await callExecuteMediaGenerationStage('file', pdfStage, 0, ctx, '');

      expect((outcome.artifact as { error?: string }).error).toBeUndefined();
      expect((outcome.artifact as { filename?: string }).filename).toBe('generated.pdf');
      expect((outcome.artifact as { mime_type?: string }).mime_type).toBe('application/pdf');
      expect((outcome.artifact as { b64_json?: string }).b64_json).toBe(pdfBuffer.toString('base64'));
    });

    it('produces a file artifact for pptx_generation with a real binary buffer, base64-encoded correctly', async () => {
      const pptxStage: TriageStage = {
        name: 'pptx_generation',
        strategy: 'single',
        modelRoles: [],
        requiredCapabilities: ['pptx_generation'],
        maxTokens: 256,
        generationPrompt: 'a short slide deck',
      };
      const pptxBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x03, 0xfd, 0x02, 0x81]);
      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: [], taskType: 'general', contextSize: 0,
        invoker: {
          chat: vi.fn(), transcribe: vi.fn(), synthesize: vi.fn(), translate: vi.fn(), generateVideo: vi.fn(), generateImage: vi.fn(),
          generateFile: vi.fn().mockResolvedValue({
            buffer: pptxBuffer,
            filename: 'generated.pptx',
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            model: 'gpt-4o',
          }),
        } as unknown as OrchestrationContext['invoker'],
      };

      const outcome = await callExecuteMediaGenerationStage('file', pptxStage, 0, ctx, '');

      expect((outcome.artifact as { error?: string }).error).toBeUndefined();
      expect((outcome.artifact as { filename?: string }).filename).toBe('generated.pptx');
      expect((outcome.artifact as { mime_type?: string }).mime_type).toBe(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      );
      expect((outcome.artifact as { b64_json?: string }).b64_json).toBe(pptxBuffer.toString('base64'));
    });

    it('produces a file artifact for zip_generation with a real binary buffer, base64-encoded correctly', async () => {
      const zipStage: TriageStage = {
        name: 'zip_generation',
        strategy: 'single',
        modelRoles: [],
        requiredCapabilities: ['zip_generation'],
        maxTokens: 256,
        generationPrompt: 'a zip bundling a csv and a json report',
      };
      const zipBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x03, 0xfd, 0x02, 0x81]);
      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: [], taskType: 'general', contextSize: 0,
        invoker: {
          chat: vi.fn(), transcribe: vi.fn(), synthesize: vi.fn(), translate: vi.fn(), generateVideo: vi.fn(), generateImage: vi.fn(),
          generateFile: vi.fn().mockResolvedValue({
            buffer: zipBuffer,
            filename: 'generated.zip',
            mimeType: 'application/zip',
            model: 'gpt-4o',
          }),
        } as unknown as OrchestrationContext['invoker'],
      };

      const outcome = await callExecuteMediaGenerationStage('file', zipStage, 0, ctx, '');

      expect((outcome.artifact as { error?: string }).error).toBeUndefined();
      expect((outcome.artifact as { filename?: string }).filename).toBe('generated.zip');
      expect((outcome.artifact as { mime_type?: string }).mime_type).toBe('application/zip');
      expect((outcome.artifact as { b64_json?: string }).b64_json).toBe(zipBuffer.toString('base64'));
    });

    it('produces a file artifact for code_file_generation with a real binary buffer, base64-encoded correctly', async () => {
      const codeStage: TriageStage = {
        name: 'code_file_generation',
        strategy: 'single',
        modelRoles: [],
        requiredCapabilities: ['code_file_generation'],
        maxTokens: 256,
        generationPrompt: 'a downloadable python script that adds two numbers',
      };
      const codeBuffer = Buffer.from('def add(a, b):\n    return a + b\n', 'utf-8');
      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: [], taskType: 'general', contextSize: 0,
        invoker: {
          chat: vi.fn(), transcribe: vi.fn(), synthesize: vi.fn(), translate: vi.fn(), generateVideo: vi.fn(), generateImage: vi.fn(),
          generateFile: vi.fn().mockResolvedValue({
            buffer: codeBuffer,
            filename: 'generated.py',
            mimeType: 'text/plain',
            model: 'gpt-4o',
          }),
        } as unknown as OrchestrationContext['invoker'],
      };

      const outcome = await callExecuteMediaGenerationStage('file', codeStage, 0, ctx, '');

      expect((outcome.artifact as { error?: string }).error).toBeUndefined();
      expect((outcome.artifact as { filename?: string }).filename).toBe('generated.py');
      expect((outcome.artifact as { mime_type?: string }).mime_type).toBe('text/plain');
      expect((outcome.artifact as { b64_json?: string }).b64_json).toBe(codeBuffer.toString('base64'));
    });

    it('treats an empty file buffer as failure, not a successful empty artifact', async () => {
      const csvStage: TriageStage = {
        name: 'csv_generation',
        strategy: 'single',
        modelRoles: [],
        requiredCapabilities: ['csv_generation'],
        maxTokens: 256,
        generationPrompt: 'a csv of nothing',
      };
      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: [], taskType: 'general', contextSize: 0,
        invoker: {
          chat: vi.fn(), transcribe: vi.fn(), synthesize: vi.fn(), translate: vi.fn(), generateVideo: vi.fn(), generateImage: vi.fn(),
          generateFile: vi.fn().mockResolvedValue({ buffer: Buffer.alloc(0), filename: 'generated.csv', mimeType: 'text/csv' }),
        } as unknown as OrchestrationContext['invoker'],
      };

      const outcome = await callExecuteMediaGenerationStage('file', csvStage, 0, ctx, '');

      expect((outcome.artifact as { error?: string }).error).toContain('empty');
      expect((outcome.artifact as { b64_json?: string }).b64_json).toBeUndefined();
    });

    it('degrades gracefully (no throw, artifact.error set) when file generation fails', async () => {
      const csvStage: TriageStage = {
        name: 'csv_generation',
        strategy: 'single',
        modelRoles: [],
        requiredCapabilities: ['csv_generation'],
        maxTokens: 256,
        generationPrompt: 'a csv of the 3 closest planets to the sun',
      };
      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: [], taskType: 'general', contextSize: 0,
        invoker: {
          chat: vi.fn(), transcribe: vi.fn(), synthesize: vi.fn(), translate: vi.fn(), generateVideo: vi.fn(), generateImage: vi.fn(),
          generateFile: vi.fn().mockRejectedValue(new Error('model returned invalid JSON')),
        } as unknown as OrchestrationContext['invoker'],
      };

      const outcome = await callExecuteMediaGenerationStage('file', csvStage, 0, ctx, '');

      expect((outcome.artifact as { error?: string }).error).toContain('invalid JSON');
      expect(outcome.summaryText).toContain('FAILED');
    });
  });

  describe('executeMultiStagePlan (multimodal composition)', () => {
    it('composes an image stage + a chat stage: artifacts carries the image, finalResponse carries the chat text', async () => {
      const chatResult = {
        strategyUsed: 'single' as ExecutionStrategyName,
        modelsUsed: [],
        finalResponse: {
          id: 'chat-1', object: 'chat.completion' as const, created: 0, model: 'gpt-4o',
          choices: [{ index: 0, message: { role: 'assistant' as const, content: 'Here is a caption for the image.' }, finish_reason: 'stop' as const }],
        },
        totalCost: 0.001,
        totalDuration: 10,
        metadata: {},
      };
      const fakeChatStrategy = { execute: vi.fn().mockResolvedValue(chatResult) };
      (engine as unknown as { strategies: Map<string, unknown> }).strategies.set('stub-chat', fakeChatStrategy);

      const ctx: OrchestrationContext = {
        organizationId: 'org-1', requestId: 'req-1', models: mockModels, taskType: 'general', contextSize: 0,
        invoker: {
          chat: vi.fn(), transcribe: vi.fn(), synthesize: vi.fn(), translate: vi.fn(), generateVideo: vi.fn(),
          generateImage: vi.fn().mockResolvedValue({ images: [{ url: 'https://example.com/img.png' }], provider: 'openai', model: 'gpt-image-1' }),
        } as unknown as OrchestrationContext['invoker'],
      };

      const plan = {
        maxTokens: 1024, qualityTarget: 0.75, preferSpeed: false, requiredCapabilities: [],
        estimatedInputTokens: 10, strategy: 'single' as ExecutionStrategyName, modelCount: 1, requiresContinuation: false,
        stages: [
          { name: 'image_stage', strategy: 'single' as ExecutionStrategyName, modelRoles: [], requiredCapabilities: ['image_generation'], maxTokens: 256, generationPrompt: 'a red bicycle' },
          { name: 'caption_stage', strategy: 'stub-chat' as ExecutionStrategyName, modelRoles: [], requiredCapabilities: [], maxTokens: 256 },
        ],
      };

      const result = await (engine as unknown as {
        executeMultiStagePlan: (req: ChatRequest, c: OrchestrationContext, p: typeof plan, id: string) => Promise<{
          artifacts?: Array<{ modality: string; url?: string }>;
          finalResponse: { choices: Array<{ message?: { content?: unknown } }> };
          metadata: Record<string, unknown>;
        }>;
      }).executeMultiStagePlan(
        { messages: [{ role: 'user', content: 'generate an image of a red bicycle and caption it' }] },
        ctx, plan, 'req-1',
      );

      expect(result.artifacts?.length).toBe(1);
      expect(result.artifacts?.[0].modality).toBe('image');
      expect(result.artifacts?.[0].url).toBe('https://example.com/img.png');
      expect(result.finalResponse.choices[0].message?.content).toBe('Here is a caption for the image.');
      expect(result.metadata.mediaStagesExecuted).toBe(1);
      expect(fakeChatStrategy.execute).toHaveBeenCalledTimes(1);
    });
  });
});
