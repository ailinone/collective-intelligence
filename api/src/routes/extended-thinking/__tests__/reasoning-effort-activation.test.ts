// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Extended/ultra-thinking routes — REAL native-thinking activation
 * (LOTE AZ follow-up, fix/extended-thinking-real-native, 2026-09).
 *
 * Regression coverage for the exact gap the audit found: this route's header
 * claimed "REAL IMPLEMENTATION" while `buildThinkingSystemPrompt` only ever
 * asked the model to narrate its reasoning inside `<thinking>` tags and
 * parsed the response by regex — for EVERY model, including ones with real
 * native extended-thinking support — never attaching the canonical
 * `reasoning_effort`/`thinking_budget` fields to the `ChatRequest` forwarded
 * to the orchestration engine.
 *
 * These tests assert the ACTUAL `ChatRequest` built for `engine.execute()`:
 *   - a native-thinking-capable candidate gets `reasoning_effort` +
 *     `thinking_budget` attached, and its messages are sent UNTOUCHED (no
 *     <thinking>-tag prompt injection);
 *   - a non-native candidate gets neither field, and keeps the exact
 *     pre-existing prompt-injection fallback;
 *   - the response parser prefers real `metadata.reasoning_traces` (the
 *     codebase-wide convention for surfacing native reasoning) over the
 *     regex parse when both could apply.
 *
 * The heavy transitive deps (DB, provider registry, billing) are mocked out
 * so this exercises only the testable core — same rationale as
 * `chat/__tests__/reasoning-effort-propagation.test.ts` and
 * `responses/__tests__/responses-streaming.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, Model, OrchestrationContext, OrchestrationResult } from '@/types';
import { EFFORT_THINKING_BUDGETS } from '@/utils/reasoning-effort';

const executeMock = vi.fn();

// `executeMock` backs the SAME mocked `getOrchestrationEngine()` across every
// test in this file — without clearing it between tests, `.mock.calls[0]`
// keeps pointing at the FIRST test's call forever, silently asserting on
// stale data instead of the current test's request.
beforeEach(() => {
  executeMock.mockClear();
});

vi.mock('@/core/orchestration/orchestration-engine', () => ({
  getOrchestrationEngine: () => ({ execute: executeMock }),
  isOrchestrationEngineInitialized: () => true,
}));

vi.mock('@/services/model-repository', () => ({
  ModelRepository: class {
    findModelsWithCapabilities = vi.fn();
  },
}));

vi.mock('@/services/billing-usage-tracker', () => ({
  trackChatUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/orchestration-gate', () => ({
  evaluateOrchestrationGate: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { ExtendedThinkingService } from '../extended-thinking-routes';

// ── Fixtures ────────────────────────────────────────────────────────────

function nativeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'nativevendor/thinker-1',
    providerId: 'nativevendor',
    provider: 'nativevendor',
    name: 'Thinker-1',
    displayName: 'Thinker 1',
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat', 'reasoning', 'thinking_mode'],
    performance: { latencyMs: 500, throughput: 50, quality: 0.9, reliability: 0.99 },
    status: 'active',
    ...overrides,
  };
}

function nonNativeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'plainvendor/chat-1',
    providerId: 'plainvendor',
    provider: 'plainvendor',
    name: 'Chat-1',
    displayName: 'Chat 1',
    contextWindow: 32_000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.0005,
    outputCostPer1k: 0.001,
    capabilities: ['chat', 'reasoning'],
    performance: { latencyMs: 300, throughput: 80, quality: 0.8, reliability: 0.99 },
    status: 'active',
    ...overrides,
  };
}

function context(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    organizationId: 'org_test',
    userId: 'user_test',
    requestId: 'req_test',
    models: [],
    taskType: 'reasoning',
    contextSize: 100,
    ...overrides,
  };
}

function engineResult(overrides: Partial<OrchestrationResult> = {}): OrchestrationResult {
  return {
    strategyUsed: 'single',
    modelsUsed: [],
    finalResponse: {
      id: 'chatcmpl-x',
      object: 'chat.completion',
      created: 1,
      model: 'test/model',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'The final answer.' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    totalCost: 0.001,
    totalDuration: 100,
    metadata: {},
    ...overrides,
  } as OrchestrationResult;
}

describe('ExtendedThinkingService.executeExtendedThinking — native activation', () => {
  it('attaches reasoning_effort/thinking_budget and sends UNTOUCHED messages for a native-thinking candidate', async () => {
    const service = new ExtendedThinkingService();
    const repo = (service as unknown as { modelRepo: { findModelsWithCapabilities: ReturnType<typeof vi.fn> } })
      .modelRepo;
    repo.findModelsWithCapabilities.mockResolvedValueOnce([nativeModel()]);
    executeMock.mockResolvedValueOnce(engineResult());

    await service.executeExtendedThinking(
      { messages: [{ role: 'user', content: 'Prove the Collatz conjecture.' }] },
      context()
    );

    expect(executeMock).toHaveBeenCalledTimes(1);
    const sentRequest = executeMock.mock.calls[0][0] as ChatRequest;

    expect(sentRequest.reasoning_effort).toBe('medium'); // default when caller sends neither field
    expect(sentRequest.thinking_budget).toBe(EFFORT_THINKING_BUDGETS.medium);
    expect(sentRequest.ailin_constraints?.enable_reasoning).toBe(true);
    // No <thinking>-tag prompt injection: exactly the caller's own messages.
    expect(sentRequest.messages).toEqual([{ role: 'user', content: 'Prove the Collatz conjecture.' }]);
  });

  it('maps an explicit reasoning_effort to its documented budget for a native candidate', async () => {
    const service = new ExtendedThinkingService();
    const repo = (service as unknown as { modelRepo: { findModelsWithCapabilities: ReturnType<typeof vi.fn> } })
      .modelRepo;
    repo.findModelsWithCapabilities.mockResolvedValueOnce([nativeModel()]);
    executeMock.mockResolvedValueOnce(engineResult());

    await service.executeExtendedThinking(
      { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' },
      context()
    );

    const sentRequest = executeMock.mock.calls[0][0] as ChatRequest;
    expect(sentRequest.reasoning_effort).toBe('low');
    expect(sentRequest.thinking_budget).toBe(EFFORT_THINKING_BUDGETS.low);
  });

  it('an explicit numeric thinking_budget wins verbatim even for a native candidate', async () => {
    const service = new ExtendedThinkingService();
    const repo = (service as unknown as { modelRepo: { findModelsWithCapabilities: ReturnType<typeof vi.fn> } })
      .modelRepo;
    repo.findModelsWithCapabilities.mockResolvedValueOnce([nativeModel()]);
    executeMock.mockResolvedValueOnce(engineResult());

    await service.executeExtendedThinking(
      { messages: [{ role: 'user', content: 'hi' }], thinking_budget: 12345 },
      context()
    );

    const sentRequest = executeMock.mock.calls[0][0] as ChatRequest;
    expect(sentRequest.thinking_budget).toBe(12345);
  });

  it('keeps the EXACT prompt-injection fallback for a non-native candidate — no canonical fields attached', async () => {
    const service = new ExtendedThinkingService();
    const repo = (service as unknown as { modelRepo: { findModelsWithCapabilities: ReturnType<typeof vi.fn> } })
      .modelRepo;
    repo.findModelsWithCapabilities.mockResolvedValueOnce([nonNativeModel()]);
    executeMock.mockResolvedValueOnce(engineResult());

    await service.executeExtendedThinking(
      { messages: [{ role: 'user', content: 'Explain gravity.' }] },
      context()
    );

    const sentRequest = executeMock.mock.calls[0][0] as ChatRequest;
    expect(sentRequest.reasoning_effort).toBeUndefined();
    expect(sentRequest.thinking_budget).toBeUndefined();
    expect(sentRequest.ailin_constraints).toBeUndefined();
    // The fallback system message asking for <thinking> tags is prepended.
    expect(sentRequest.messages[0]).toMatchObject({ role: 'system' });
    expect(String(sentRequest.messages[0].content)).toContain('<thinking>');
    expect(sentRequest.messages[1]).toEqual({ role: 'user', content: 'Explain gravity.' });
  });

  it('prefers real metadata.reasoning_traces over the regex parse when the strategy populated them', async () => {
    const service = new ExtendedThinkingService();
    const repo = (service as unknown as { modelRepo: { findModelsWithCapabilities: ReturnType<typeof vi.fn> } })
      .modelRepo;
    repo.findModelsWithCapabilities.mockResolvedValueOnce([nativeModel()]);
    executeMock.mockResolvedValueOnce(
      engineResult({
        metadata: {
          reasoning_traces: [
            { model_id: 'nativevendor/thinker-1', model_name: 'Thinker-1', reasoning: 'Genuine native chain of thought.' },
          ],
        },
      })
    );

    const response = await service.executeExtendedThinking(
      { messages: [{ role: 'user', content: 'hi' }] },
      context()
    );

    const thinking = response.choices[0].message.content.find((c) => c.type === 'thinking');
    const text = response.choices[0].message.content.find((c) => c.type === 'text');
    expect(thinking).toMatchObject({ type: 'thinking', thinking: 'Genuine native chain of thought.' });
    expect(text).toMatchObject({ type: 'text', text: 'The final answer.' });
  });

  it('falls back to regex-parsing <think>/<thinking> tags when no native reasoning_traces exist', async () => {
    const service = new ExtendedThinkingService();
    const repo = (service as unknown as { modelRepo: { findModelsWithCapabilities: ReturnType<typeof vi.fn> } })
      .modelRepo;
    repo.findModelsWithCapabilities.mockResolvedValueOnce([nonNativeModel()]);
    executeMock.mockResolvedValueOnce(
      engineResult({
        finalResponse: {
          id: 'chatcmpl-y',
          object: 'chat.completion',
          created: 1,
          model: 'test/model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '<thinking>step by step</thinking>final answer' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      })
    );

    const response = await service.executeExtendedThinking(
      { messages: [{ role: 'user', content: 'hi' }] },
      context()
    );

    const thinking = response.choices[0].message.content.find((c) => c.type === 'thinking');
    const text = response.choices[0].message.content.find((c) => c.type === 'text');
    expect(thinking).toMatchObject({ thinking: 'step by step' });
    expect(text).toMatchObject({ text: 'final answer' });
  });
});

describe('ExtendedThinkingService.executeUltraThinking — native activation', () => {
  it('always attaches canonical reasoning_effort/thinking_budget to the collective ChatRequest, defaulting to high', async () => {
    const service = new ExtendedThinkingService();
    const repo = (service as unknown as { modelRepo: { findModelsWithCapabilities: ReturnType<typeof vi.fn> } })
      .modelRepo;
    repo.findModelsWithCapabilities.mockResolvedValueOnce([
      nativeModel(),
      nonNativeModel(),
      nonNativeModel({ id: 'plainvendor/chat-2', name: 'Chat-2' }),
    ]);
    executeMock.mockResolvedValueOnce(engineResult());

    await service.executeUltraThinking(
      { messages: [{ role: 'user', content: 'Design a system.' }] },
      context()
    );

    const sentRequest = executeMock.mock.calls[0][0] as ChatRequest;
    expect(sentRequest.reasoning_effort).toBe('high');
    expect(sentRequest.thinking_budget).toBe(EFFORT_THINKING_BUDGETS.high);
    expect(sentRequest.ailin_constraints?.enable_reasoning).toBe(true);
  });

  it('honors an explicit reasoning_effort for the collective request', async () => {
    const service = new ExtendedThinkingService();
    const repo = (service as unknown as { modelRepo: { findModelsWithCapabilities: ReturnType<typeof vi.fn> } })
      .modelRepo;
    repo.findModelsWithCapabilities.mockResolvedValueOnce([nativeModel(), nonNativeModel()]);
    executeMock.mockResolvedValueOnce(engineResult());

    await service.executeUltraThinking(
      { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' },
      context()
    );

    const sentRequest = executeMock.mock.calls[0][0] as ChatRequest;
    expect(sentRequest.reasoning_effort).toBe('low');
    expect(sentRequest.thinking_budget).toBe(EFFORT_THINKING_BUDGETS.low);
  });
});
