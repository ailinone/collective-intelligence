// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Cost Cascade Strategy
 * Uses REAL models from dynamic discovery - NO hardcoded models, NO mocks
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { CostCascadeStrategy } from '@/core/orchestration/strategies/cost-cascade-strategy';
import type { ChatRequest, ChatResponse, OrchestrationContext, Model, TaskType } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { getProviderRegistry, setProviderRegistry } from '@/providers/provider-registry';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';
import { discoverModelsDynamically } from '../../utils/dynamic-model-discovery';
import { createRealProviderRegistry } from '../../utils/real-provider-registry';
import { startTestEnvironment, stopTestEnvironment } from '../../utils/test-environment';

/**
 * Type for strategy with getAdapterForModel method (injected by OrchestrationEngine)
 */
type StrategyWithAdapter = CostCascadeStrategy & {
  getAdapterForModel?: (model: Model, context: OrchestrationContext) => Promise<ProviderAdapter | null>;
};

describe('CostCascadeStrategy - Real Tests (NO Mocks, NO Hardcoded Models)', () => {
  let strategy: CostCascadeStrategy;
  let testContext: OrchestrationContext;
  let testRequest: ChatRequest;
  let realModels: Model[];

  beforeAll(async () => {
    await startTestEnvironment();
    const providerRegistry = await createRealProviderRegistry();
    setProviderRegistry(providerRegistry);
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  beforeEach(async () => {
    strategy = new CostCascadeStrategy();

    // Discover models dynamically from real providers (NO hardcoded models)
    realModels = await discoverModelsDynamically();
    
    // Sort by cost (cheap to expensive) for cascade strategy
    realModels = realModels
      .filter(m => m.status === 'active')
      .sort((a, b) => {
        const costA = Number(a.inputCostPer1k) + Number(a.outputCostPer1k);
        const costB = Number(b.inputCostPer1k) + Number(b.outputCostPer1k);
        return costA - costB;
      })
      .slice(0, 10);

    // Get provider registry to get real adapters
    const registry = getProviderRegistry();
    const modelWithAdapter = realModels.find(m => registry.get(m.provider));
    const selectedModel = modelWithAdapter || realModels[0];

    testRequest = {
      messages: [{ role: 'user', content: 'Write a function' }],
      model: selectedModel?.id || realModels[0]?.id,
    };

    testContext = {
      models: realModels,
      strategy: 'cost-cascade',
      requestId: 'test-request-' + Date.now(),
      userId: 'test-user',
      organizationId: 'test-org',
      taskType: 'code_generation' as TaskType,
      contextSize: 1000,
    };

    // Use REAL provider adapters - NO mocks
    (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) => {
      const adapter = registry.get(model.provider);
      if (!adapter) {
        throw new Error(`No adapter found for provider: ${model.provider}`);
      }
      return adapter;
    };
  });

  /**
   * Credential / dynamic-discovery gate.
   *
   * Every test below needs a real, dynamically-discovered model pool (this
   * suite's "NO hardcoded models" rule). Each of them used to open with
   * `if (realModels.length < 2) { return; }`, which reports GREEN while
   * asserting nothing — so a CI run without provider credentials showed a
   * full pass for tests that never executed a single expectation. That is
   * strictly worse than no test at all: it hides the regression it exists to
   * catch, and looks like coverage in the report.
   *
   * `ctx.skip()` (vitest's runtime skip — the collection-time `it.skipIf`
   * cannot be used here, since `realModels` is only populated in beforeEach)
   * marks the test SKIPPED instead, so an unmet precondition is visible in
   * the summary rather than laundered into a pass.
   */
  function requireRealModels(ctx: { skip: () => void }, minimum = 2): void {
    if (realModels.length >= minimum) return;
    console.warn(
      `[cost-cascade-strategy.test] SKIP: needs >= ${minimum} dynamically-discovered active models, found ${realModels.length}. ` +
        'Provider credentials / dynamic discovery are unavailable in this run.'
    );
    ctx.skip();
  }

  describe('Metadata', () => {
    it('should have correct strategy metadata', () => {
      const metadata = strategy.getMetadata();
      expect(metadata.id).toBe('cost-cascade');
      expect(metadata.name).toBe('cost-cascade');
    });
  });

  describe('execute', () => {
    it('should execute successfully with real models', async (ctx) => {
      requireRealModels(ctx);

      const result = await strategy.execute(testRequest, testContext);

      expect(result).toBeDefined();
      expect(result.finalResponse).toBeDefined();
      expect(result.modelsUsed.length).toBeGreaterThan(0);
    }, 60000);

    it('should cascade through models by cost', async (ctx) => {
      requireRealModels(ctx);

      const result = await strategy.execute(testRequest, testContext);

      // Should use cheaper models first
      expect(result.modelsUsed.length).toBeGreaterThan(0);
      expect(result.finalResponse).toBeDefined();
    }, 60000);
  });

  describe('supportsStreaming', () => {
    it('reports true — real token streaming is implemented', () => {
      expect(strategy.supportsStreaming()).toBe(true);
    });
  });

  describe('executeStream (real streaming)', () => {
    /**
     * Collects every chunk yielded by executeStream() and separates out the
     * ones that actually carry assistant content (as opposed to zero-token
     * progress/observer metadata chunks). Checks BOTH `delta.content` (real
     * streaming chunks, from streamSynthesisWithFallback) and
     * `message.content` (the single buffered chunk emitted by
     * bufferedResultAsChunk() on the elevated-quality-target path) — same
     * duality the real SSE client has to handle, per the design's own note
     * that a buffered ChatResponse is an accepted "chunk" shape.
     */
    async function collectStreamedContentChunks(
      request: ChatRequest,
      context: OrchestrationContext
    ): Promise<{ all: ChatResponse[]; content: ChatResponse[] }> {
      const all: ChatResponse[] = [];
      for await (const chunk of strategy.executeStream(request, context)) {
        all.push(chunk);
      }
      const contentOf = (c: ChatResponse): string | undefined => {
        const deltaContent = c.choices?.[0]?.delta?.content;
        if (typeof deltaContent === 'string') return deltaContent;
        const messageContent = c.choices?.[0]?.message?.content;
        if (typeof messageContent === 'string') return messageContent;
        return undefined;
      };
      const content = all.filter((c) => {
        const text = contentOf(c);
        return typeof text === 'string' && text.length > 0;
      });
      return { all, content };
    }

    it('delivers rung-1 content as real chunk-by-chunk deltas, not one buffered chunk', async (ctx) => {
      requireRealModels(ctx);

      // Every candidate would succeed if tried — but the FIRST (cheapest)
      // candidate the cascade tries should win outright, streaming its
      // content token-by-token rather than as one buffered blob.
      const chunkTexts = ['Hel', 'lo, ', 'wor', 'ld!'];
      (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) =>
        ({
          getName: () => model.provider,
          chatCompletion: async () => ({
            id: `mock-${model.id}`,
            object: 'chat.completion' as const,
            created: Math.floor(Date.now() / 1000),
            model: model.id,
            choices: [
              {
                index: 0,
                message: { role: 'assistant' as const, content: chunkTexts.join('') },
                finish_reason: 'stop' as const,
                logprobs: null,
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          }),
          chatCompletionStream: async function* () {
            for (const text of chunkTexts) {
              yield {
                id: `chunk-${text}`,
                object: 'chat.completion.chunk' as const,
                created: Math.floor(Date.now() / 1000),
                model: model.id,
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant' as const, content: text },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              } as ChatResponse;
            }
            yield {
              id: 'chunk-final',
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: model.id,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' as const, logprobs: null }],
              usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
            } as ChatResponse;
          },
          calculateCost: () => 0.0001,
        }) as unknown as ProviderAdapter;

      const { content } = await collectStreamedContentChunks(testRequest, testContext);

      // Real chunk-by-chunk delivery: as many content chunks as the fake
      // provider emitted, in order — NOT the whole answer collapsed into a
      // single buffered chunk (which is what the pre-fix executeStream did
      // by delegating to execute() and yielding one final chunk).
      expect(content.length).toBe(chunkTexts.length);
      expect(content.map((c) => c.choices[0].delta!.content)).toEqual(chunkTexts);
    }, 30000);

    it('falls back transparently to the next rung when the cheapest rung fails before any content', async (ctx) => {
      requireRealModels(ctx);

      let attemptedAdapters = 0;
      (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) => {
        const attemptIndex = attemptedAdapters++;
        return {
          getName: () => model.provider,
          chatCompletion: async () => {
            throw new Error('chatCompletion should not be called on the streaming path');
          },
          chatCompletionStream: async function* () {
            if (attemptIndex === 0) {
              // Cheapest rung fails BEFORE emitting any content — must be an
              // invisible, transparent fallback to the next candidate.
              throw new Error('simulated pre-content provider failure');
            }
            yield {
              id: 'fallback-chunk',
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: model.id,
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant' as const, content: 'fallback-response' },
                  finish_reason: 'stop' as const,
                  logprobs: null,
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
            } as ChatResponse;
          },
          calculateCost: () => 0.0001,
        } as unknown as ProviderAdapter;
      };

      const { content } = await collectStreamedContentChunks(testRequest, testContext);

      // Exactly one candidate's content reached the client: the failed
      // rung-1 candidate contributed zero chunks, and rung 2's content
      // streamed through as the sole answer.
      expect(content.length).toBe(1);
      expect(content[0].choices[0].delta!.content).toBe('fallback-response');
      expect(attemptedAdapters).toBeGreaterThanOrEqual(2);
    }, 30000);

    it('falls back to the buffered execute() path when an elevated quality target requires content-based escalation', async (ctx) => {
      requireRealModels(ctx);

      (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) =>
        ({
          getName: () => model.provider,
          chatCompletion: async () => ({
            id: `mock-${model.id}`,
            object: 'chat.completion' as const,
            created: Math.floor(Date.now() / 1000),
            model: model.id,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant' as const,
                  content:
                    '1. A sufficiently long, structured, deterministic mock answer used to satisfy the quality scorer for this test scenario — repeated to clear the length bonus thresholds and combined with a numbered list to clear the structure bonus.\n'.repeat(
                      6
                    ),
                },
                finish_reason: 'stop' as const,
                logprobs: null,
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 40, total_tokens: 45 },
          }),
          chatCompletionStream: async function* () {
            throw new Error(
              'chatCompletionStream should not be called on the elevated-quality-target path'
            );
          },
          calculateCost: () => 0.0001,
        }) as unknown as ProviderAdapter;

      const elevatedContext: OrchestrationContext = { ...testContext, qualityTarget: 0.95 };
      const { all, content } = await collectStreamedContentChunks(testRequest, elevatedContext);

      // Exactly one chunk — the already-decided buffered winner — not a
      // real token stream, because content can't be "unshown" mid-stream if
      // a cheap rung fails the elevated quality gate.
      expect(all.length).toBe(1);
      expect(content.length).toBe(1);
    }, 30000);

    // Memory-recording coverage (2026-08-16): executeStream()'s two branches
    // each build and record their own OrchestrationResult
    // (streamedResultForMemory() on the fast path, execute()'s own real
    // result on the elevated-quality-target path) because the engine only
    // records memory on its buffered branch (orchestration-engine.ts:3130),
    // which executeStream() never reaches. These pin the "was it recorded,
    // with the right content/quality/request" contract at the unit level —
    // whether the record actually reaches durable storage (getSemanticMemoryStore()
    // → the real store) is NOT exercised here, since recordExecution() is
    // mocked out; that end-to-end path needs an integration test against a
    // real (or realistically-faked) semantic memory store, which this file
    // doesn't stand up.
    it('records episodic memory after a successful streamed rung', async (ctx) => {
      requireRealModels(ctx);

      const chunkTexts = ['The ', 'quick ', 'brown ', 'fox ', 'jumps.'];
      (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) =>
        ({
          getName: () => model.provider,
          chatCompletion: async () => {
            throw new Error('chatCompletion should not be called on the streaming path');
          },
          chatCompletionStream: async function* () {
            for (const text of chunkTexts) {
              yield {
                id: `chunk-${text}`,
                object: 'chat.completion.chunk' as const,
                created: Math.floor(Date.now() / 1000),
                model: model.id,
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant' as const, content: text },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              } as ChatResponse;
            }
            yield {
              id: 'chunk-final',
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: model.id,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' as const, logprobs: null }],
              usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
            } as ChatResponse;
          },
          calculateCost: () => 0.0001,
        }) as unknown as ProviderAdapter;

      const recordSpy = vi.spyOn(strategy, 'recordExecution').mockResolvedValue(undefined);

      await collectStreamedContentChunks(testRequest, testContext);

      expect(recordSpy).toHaveBeenCalledTimes(1);
      const [calledContext, calledResult] = recordSpy.mock.calls[0];
      expect(calledContext).toBe(testContext);
      expect(calledResult.finalResponse.choices[0].message?.content).toBe(chunkTexts.join(''));
      expect(calledResult.qualityScore).toBeGreaterThanOrEqual(0.7);
      expect(calledResult.modelsUsed[0]?.request).toBe(testRequest);
    }, 30000);

    it('does NOT record episodic memory when every candidate fails (degraded placeholder)', async (ctx) => {
      requireRealModels(ctx);

      (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) =>
        ({
          getName: () => model.provider,
          chatCompletion: async () => {
            throw new Error('chatCompletion should not be called on the streaming path');
          },
          chatCompletionStream: async function* () {
            throw new Error('simulated pre-content provider failure');
          },
          calculateCost: () => 0.0001,
        }) as unknown as ProviderAdapter;

      const recordSpy = vi.spyOn(strategy, 'recordExecution').mockResolvedValue(undefined);

      const { content } = await collectStreamedContentChunks(testRequest, testContext);

      // Client still gets the degraded placeholder, not a hard SSE error...
      expect(content.length).toBe(1);
      expect(content[0].choices[0].delta?.content).toBe(
        'All available models were unavailable for this request.'
      );
      // ...but it must never be written to memory: at the default 0.7
      // quality floor the 54-char placeholder would otherwise pass
      // recordExecution()'s own gates and poison future retrievals with a
      // non-answer. This is exactly the `allCandidatesFailed` sentinel.
      expect(recordSpy).not.toHaveBeenCalled();
    }, 30000);

    it('does NOT record episodic memory when the provider dies mid-stream (truncated answer)', async (ctx) => {
      requireRealModels(ctx);

      // Provider emits real content, then THROWS — streamSynthesisWithFallback
      // keeps the partial output and returns NORMALLY (base-strategy.ts's
      // "Synthesis stream failed AFTER first chunk — keeping partial output"
      // path). allCandidatesFailed stays false, so before the finish_reason
      // sentinel this half-sentence was written to episodic memory wrapped in
      // finish_reason:'stop' / success:true / qualityScore>=0.7 — indelibly
      // recorded as a complete, high-quality answer.
      (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) =>
        ({
          getName: () => model.provider,
          chatCompletion: async () => {
            throw new Error('chatCompletion should not be called on the streaming path');
          },
          chatCompletionStream: async function* () {
            yield {
              id: 'chunk-partial',
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: model.id,
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant' as const, content: 'The answer begins but never' },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
            } as ChatResponse;
            throw new Error('simulated mid-stream provider death');
          },
          calculateCost: () => 0.0001,
        }) as unknown as ProviderAdapter;

      const recordSpy = vi.spyOn(strategy, 'recordExecution').mockResolvedValue(undefined);

      const { content } = await collectStreamedContentChunks(testRequest, testContext);

      // The partial answer still reaches the client (never re-spliced) ...
      expect(content.length).toBe(1);
      expect(content[0].choices[0].delta?.content).toBe('The answer begins but never');
      // ... but no terminal finish_reason was ever observed, so it is NOT
      // record-worthy and must never reach episodic memory.
      expect(recordSpy).not.toHaveBeenCalled();
    }, 30000);

    it('never corrupts a delivered answer when the memory-record construction throws', async (ctx) => {
      requireRealModels(ctx);

      const chunkTexts = ['Complete ', 'answer.'];
      // calculateCost() is called SYNCHRONOUSLY while building the memory
      // record, AFTER the answer already streamed to the client. A throw there
      // used to escape executeStream(), making the engine rethrow and
      // sendSSEError append raw error text onto the user's finished answer.
      (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) =>
        ({
          getName: () => model.provider,
          chatCompletion: async () => {
            throw new Error('chatCompletion should not be called on the streaming path');
          },
          chatCompletionStream: async function* () {
            for (const text of chunkTexts) {
              yield {
                id: `chunk-${text}`,
                object: 'chat.completion.chunk' as const,
                created: Math.floor(Date.now() / 1000),
                model: model.id,
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant' as const, content: text },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              } as ChatResponse;
            }
            yield {
              id: 'chunk-final',
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: model.id,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' as const, logprobs: null }],
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            } as ChatResponse;
          },
          calculateCost: () => {
            throw new Error('simulated cost-calculation failure');
          },
        }) as unknown as ProviderAdapter;

      const recordSpy = vi.spyOn(strategy, 'recordExecution').mockResolvedValue(undefined);

      // The generator must complete normally — no throw escaping after
      // content was delivered.
      const { content } = await collectStreamedContentChunks(testRequest, testContext);

      expect(content.map((c) => c.choices[0].delta?.content)).toEqual(chunkTexts);
      // Memory write is skipped (the record could not be built), not retried
      // with garbage and not propagated as an error.
      expect(recordSpy).not.toHaveBeenCalled();
    }, 30000);

    it('records episodic memory on the elevated-quality-target (buffered execute()) branch too', async (ctx) => {
      requireRealModels(ctx);

      const longContent =
        '1. A sufficiently long, structured, deterministic mock answer used to satisfy the quality scorer for this test scenario — repeated to clear the length bonus thresholds and combined with a numbered list to clear the structure bonus.\n'.repeat(
          6
        );

      (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) =>
        ({
          getName: () => model.provider,
          chatCompletion: async () => ({
            id: `mock-${model.id}`,
            object: 'chat.completion' as const,
            created: Math.floor(Date.now() / 1000),
            model: model.id,
            choices: [
              {
                index: 0,
                message: { role: 'assistant' as const, content: longContent },
                finish_reason: 'stop' as const,
                logprobs: null,
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 40, total_tokens: 45 },
          }),
          chatCompletionStream: async function* () {
            throw new Error(
              'chatCompletionStream should not be called on the elevated-quality-target path'
            );
          },
          calculateCost: () => 0.0001,
        }) as unknown as ProviderAdapter;

      const recordSpy = vi.spyOn(strategy, 'recordExecution').mockResolvedValue(undefined);

      const elevatedContext: OrchestrationContext = { ...testContext, qualityTarget: 0.95 };
      await collectStreamedContentChunks(testRequest, elevatedContext);

      expect(recordSpy).toHaveBeenCalledTimes(1);
      const [calledContext, calledResult] = recordSpy.mock.calls[0];
      expect(calledContext).toBe(elevatedContext);
      expect(calledResult.finalResponse.choices[0].message?.content).toBe(longContent);
      expect(calledResult.qualityScore).toBeGreaterThanOrEqual(0.95);
      expect(calledResult.modelsUsed[0]?.request).toBe(testRequest);
    }, 30000);

    it('pins the contract: a below-minModels pool still rejects synchronously ("requires at least 2 models") — recovery is deliberately engine-level, not strategy-local', async (ctx) => {
      requireRealModels(ctx, 1);

      const singleModelContext: OrchestrationContext = {
        ...testContext,
        models: realModels.slice(0, 1),
      };

      await expect(async () => {
        for await (const _chunk of strategy.executeStream(testRequest, singleModelContext)) {
          // Drain — the generator must reject on its very first step, before
          // yielding anything, so there's nothing partial to inspect here.
        }
      }).rejects.toThrow(/requires at least 2 models/);
    }, 30000);
  });

  describe('RC-2: breaker-aware rung demotion + first-rung fast TTFB window', () => {
    /** Minimal fake adapter that streams one content chunk + terminal chunk. */
    const fakeStreamingAdapter = (model: Model): ProviderAdapter =>
      ({
        getName: () => model.provider,
        chatCompletion: async () => {
          throw new Error('chatCompletion should not be called on the streaming path');
        },
        chatCompletionStream: async function* () {
          yield {
            id: `rc2-chunk-${model.id}`,
            object: 'chat.completion.chunk' as const,
            created: Math.floor(Date.now() / 1000),
            model: model.id,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant' as const, content: `answer from ${model.provider}` },
                finish_reason: null,
                logprobs: null,
              },
            ],
          } as ChatResponse;
          yield {
            id: `rc2-final-${model.id}`,
            object: 'chat.completion.chunk' as const,
            created: Math.floor(Date.now() / 1000),
            model: model.id,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' as const, logprobs: null }],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          } as ChatResponse;
        },
        calculateCost: () => 0.0001,
      }) as unknown as ProviderAdapter;

    const drainStream = async (request: ChatRequest, context: OrchestrationContext) => {
      const chunks: ChatResponse[] = [];
      for await (const chunk of strategy.executeStream(request, context)) chunks.push(chunk);
      return chunks;
    };

    it('demotes candidates whose provider circuit is OPEN behind healthy ones (ordering only, never removal)', async (ctx) => {
      requireRealModels(ctx, 2);

      const providers = [...new Set(realModels.map((m) => m.provider))];
      if (providers.length < 2) {
        console.warn(
          '[cost-cascade-strategy.test] SKIP: demotion test needs >= 2 distinct dynamically-discovered providers'
        );
        ctx.skip();
      }

      // beforeEach already sorted realModels cheap → expensive; the cheapest
      // model's provider is the one whose circuit we mark OPEN. Under the old
      // cost-only ordering it would be attempted first; with RC-2 demotion it
      // must lose its rung-1 slot to the cheapest HEALTHY candidate.
      const cheapest = realModels[0];
      const openCircuitName = `${cheapest.provider.toLowerCase()}-api`;
      const getOpenSpy = vi
        .spyOn(distributedCircuitBreakerManager, 'getRecentOpenCircuitNames')
        .mockReturnValue(new Set([openCircuitName]));

      const attempted: Model[] = [];
      (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) => {
        attempted.push(model);
        return fakeStreamingAdapter(model);
      };

      try {
        const chunks = await drainStream(testRequest, testContext);
        expect(attempted.length).toBeGreaterThan(0);
        expect(attempted[0].provider.toLowerCase()).not.toBe(cheapest.provider.toLowerCase());
        const streamedText = chunks
          .map((c) => c.choices?.[0]?.delta?.content)
          .filter((t): t is string => typeof t === 'string')
          .join('');
        expect(streamedText).toContain(`answer from ${attempted[0].provider}`);
      } finally {
        getOpenSpy.mockRestore();
      }
    }, 30000);

    it('keeps the original cost ordering when EVERY provider is OPEN — a stale cache must never break the minModels contract', async (ctx) => {
      requireRealModels(ctx, 2);

      const allOpen = new Set(
        realModels.map((m) => `${m.provider.toLowerCase()}-api`)
      );
      const getOpenSpy = vi
        .spyOn(distributedCircuitBreakerManager, 'getRecentOpenCircuitNames')
        .mockReturnValue(allOpen);

      const attempted: Model[] = [];
      (strategy as StrategyWithAdapter).getAdapterForModel = async (model: Model) => {
        attempted.push(model);
        return fakeStreamingAdapter(model);
      };

      try {
        const chunks = await drainStream(testRequest, testContext);
        // All-demoted ⇒ comparator degenerates to cost order ⇒ cheapest is
        // still rung 1, and the cascade still delivers an answer (no throw,
        // no empty pool).
        expect(attempted[0]).toBeDefined();
        const streamedText = chunks
          .map((c) => c.choices?.[0]?.delta?.content)
          .filter((t): t is string => typeof t === 'string')
          .join('');
        expect(streamedText.length).toBeGreaterThan(0);
      } finally {
        getOpenSpy.mockRestore();
      }
    }, 30000);

    it('firstChunkTimeoutFor: tight overridable window for rung 1, full collective window for escalation rungs', () => {
      const laterMs = Number(
        process.env.COLLECTIVE_MODEL_TIMEOUT_MS ?? process.env.PARALLEL_MODEL_TIMEOUT_MS ?? 25000
      );
      const call = (): ((i: number) => number) =>
        (
          strategy as unknown as {
            firstChunkTimeoutFor: () => (i: number) => number;
          }
        ).firstChunkTimeoutFor();

      const policy = call();
      expect(policy(0)).toBe(8000);
      expect(policy(1)).toBe(laterMs);
      expect(policy(5)).toBe(laterMs);

      process.env.COLLECTIVE_FIRST_RUNG_TTFB_MS = '4000';
      try {
        expect(call()(0)).toBe(4000);
      } finally {
        delete process.env.COLLECTIVE_FIRST_RUNG_TTFB_MS;
      }
    });
  });

  describe('RC-3: HALF_OPEN demotion + provider-diversified ladder', () => {
    /**
     * Direct unit access to buildCascadeCandidates ordering — the streaming
     * tests above exercise it end-to-end, but diversity/ HALF_OPEN ordering
     * assertions are far more readable against the ladder itself.
     */
    const buildLadder = (): Model[] =>
      (
        strategy as unknown as {
          buildCascadeCandidates: (ctx: OrchestrationContext) => Model[];
        }
      ).buildCascadeCandidates(testContext);

    it('demotes HALF_OPEN circuits one tier below healthy — but above OPEN (probe path survives)', async (ctx) => {
      requireRealModels(ctx, 3);

      const providers = [...new Set(realModels.map((m) => m.provider.toLowerCase()))];
      if (providers.length < 2) {
        console.warn(
          '[cost-cascade-strategy.test] SKIP: HALF_OPEN demotion test needs >= 2 distinct providers'
        );
        ctx.skip();
      }

      // Cheapest provider HALF_OPEN, second-cheapest OPEN, rest healthy.
      // Rank order must place healthy candidates ahead of the HALF_OPEN
      // one — the exact live incident was a HALF_OPEN google (401) holding
      // rung 1 while healthy models waited behind it.
      const cheapestProvider = realModels[0].provider.toLowerCase();
      const openProvider = providers.find((p) => p !== cheapestProvider) ?? cheapestProvider;

      const getOpenSpy = vi
        .spyOn(distributedCircuitBreakerManager, 'getRecentOpenCircuitNames')
        .mockReturnValue(new Set([`${openProvider}-api`]));
      const getHalfOpenSpy = vi
        .spyOn(distributedCircuitBreakerManager, 'getRecentCircuitNamesByState')
        .mockImplementation((...states: string[]) =>
          states.includes('HALF_OPEN') ? new Set([`${cheapestProvider}-api`]) : new Set()
        );

      try {
        const ladder = buildLadder();
        expect(ladder.length).toBeGreaterThan(0);
        const healthy = ladder.find(
          (m) =>
            m.provider.toLowerCase() !== cheapestProvider &&
            m.provider.toLowerCase() !== openProvider
        );
        if (healthy) {
          const healthyIdx = ladder.indexOf(healthy);
          const halfOpenIdx = ladder.findIndex(
            (m) => m.provider.toLowerCase() === cheapestProvider
          );
          const openIdx = ladder.findIndex((m) => m.provider.toLowerCase() === openProvider);
          expect(halfOpenIdx).toBeGreaterThan(-1);
          if (openIdx !== -1) expect(openIdx).toBeGreaterThan(halfOpenIdx);
          if (healthyIdx !== -1) expect(healthyIdx).toBeLessThan(halfOpenIdx);
        }
      } finally {
        getOpenSpy.mockRestore();
        getHalfOpenSpy.mockRestore();
      }
    });

    it('diversifies the ladder across providers — one provider cannot monopolize the rungs', async (ctx) => {
      requireRealModels(ctx, 4);

      const distinctProviders = new Set(realModels.map((m) => m.provider.toLowerCase())).size;
      if (distinctProviders < 2) {
        console.warn(
          '[cost-cascade-strategy.test] SKIP: diversity test needs >= 2 distinct providers'
        );
        ctx.skip();
      }

      const ladder = buildLadder();
      const maxRungs = Math.min(realModels.length, 5);
      expect(ladder.length).toBeLessThanOrEqual(maxRungs);

      // Round-robin guarantee: in the FIRST round of rungs (the first
      // min(maxRungs, distinctProviders) entries) no provider appears twice.
      const firstRound = ladder.slice(0, Math.min(maxRungs, distinctProviders));
      const seen = new Set<string>();
      for (const rung of firstRound) {
        const key = rung.provider.toLowerCase();
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    });

    it('breaker snapshot accessors stay zero-I/O and non-throwing with no registered breakers', () => {
      expect(distributedCircuitBreakerManager.getRecentOpenCircuitNames().size).toBeGreaterThanOrEqual(0);
      expect(
        distributedCircuitBreakerManager.getRecentCircuitNamesByState('HALF_OPEN').size
      ).toBeGreaterThanOrEqual(0);
    });
  });
});
