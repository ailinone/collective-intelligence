// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Extended/ultra-thinking routes — stream:true SSE contract (ci#753).
 *
 * Regression coverage for the exact gap the issue found: both routes'
 * OpenAPI schema documents `stream` as "Whether to stream responses
 * incrementally as Server-Sent Events (SSE)", but the handlers ignored the
 * flag and always returned a single JSON body. A client sending
 * `stream:true` and expecting SSE got `application/json` instead.
 *
 * Contract asserted here:
 *   - stream:true → 200 with `Content-Type: text/event-stream`, parseable
 *     `data:` frames in the repo-wide streaming shape (owner decision ci#750,
 *     implemented by #758): role-opening chunk → reasoning chunks on the
 *     DEDICATED `delta.reasoning_content` channel (one per thinking block,
 *     NEVER inside `delta.content`) → content chunks on `delta.content` →
 *     terminal chunk with finish_reason/usage/metadata → `data: [DONE]`;
 *   - stream:false / flag absent → JSON body exactly as before
 *     (backwards compatibility — the pre-fix behavior for every client).
 *
 * The heavy transitive deps (DB/prisma, provider registry, auth, billing,
 * quota gates) are all mocked out so this exercises only the route handlers
 * over a real Fastify instance (fastify.inject) — same rationale as
 * `__tests__/reasoning-effort-activation.test.ts` and
 * `responses/__tests__/responses-streaming.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { OrchestrationResult } from '@/types';

const executeMock = vi.fn();

vi.mock('@/core/orchestration/orchestration-engine', () => ({
  getOrchestrationEngine: () => ({ execute: executeMock }),
  isOrchestrationEngineInitialized: () => true,
}));

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: vi.fn(async () => {}),
}));

vi.mock('@/services/anonymous-quota-gate', () => ({
  rejectAnonymousGuestKeyPreHandler: vi.fn(async () => {}),
}));

vi.mock('@/services/free-tier-quota-gate', () => ({
  rejectChatFreeTierKeyPreHandler: vi.fn(async () => {}),
}));

vi.mock('@/services/model-repository', () => ({
  ModelRepository: class {
    // Three models: ultra-thinking requires >= 2 candidates to proceed at all.
    findModelsWithCapabilities = vi.fn().mockResolvedValue([
      {
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
      },
      {
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
      },
      {
        id: 'plainvendor/chat-2',
        providerId: 'plainvendor',
        provider: 'plainvendor',
        name: 'Chat-2',
        displayName: 'Chat 2',
        contextWindow: 32_000,
        maxOutputTokens: 4096,
        inputCostPer1k: 0.0005,
        outputCostPer1k: 0.001,
        capabilities: ['chat'],
        performance: { latencyMs: 300, throughput: 80, quality: 0.8, reliability: 0.99 },
        status: 'active',
      },
    ]);
  },
}));

vi.mock('@/services/billing-usage-tracker', () => ({
  trackChatUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/orchestration-gate', () => ({
  evaluateOrchestrationGate: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/services/prepaid-wallet-gate', () => ({
  gateChatRequest: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/services/ailin-virtual-model-service', () => ({
  resolveTierCarrier: vi.fn().mockReturnValue({}),
}));

vi.mock('@/services/prepaid-wallet-openapi', () => ({
  prepaidWalletResponses: {},
}));

import { registerExtendedThinkingRoutes } from '../extended-thinking-routes';

// ── Fixtures ────────────────────────────────────────────────────────────

function engineResult(): OrchestrationResult {
  return {
    strategyUsed: 'single',
    modelsUsed: [],
    finalResponse: {
      id: 'chatcmpl-x',
      object: 'chat.completion',
      created: 1,
      model: 'test/model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '<thinking>step by step</thinking>The final answer.',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    totalCost: 0.001,
    totalDuration: 100,
    metadata: {},
  } as OrchestrationResult;
}

/** Split an SSE body into its `data:` frame payloads (comments ignored). */
function dataFrames(body: string): string[] {
  return body
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => frame.slice('data:'.length).trim());
}

/** Parsed chunk payloads of an SSE body, excluding the [DONE] sentinel. */
function chunks(body: string): Array<Record<string, any>> {
  return dataFrames(body)
    .filter((f) => f !== '[DONE]')
    .map((f) => JSON.parse(f));
}

/**
 * Anti-leak pin (#766 follow-up): chain-of-thought text must NEVER appear in
 * any `delta.content` — reasoning rides exclusively on the dedicated
 * `delta.reasoning_content` channel.
 */
function expectNoReasoningInContent(allChunks: Array<Record<string, any>>): void {
  for (const chunk of allChunks) {
    const deltaContent = chunk.choices?.[0]?.delta?.content;
    if (typeof deltaContent === 'string') {
      expect(deltaContent).not.toContain('step by step');
    }
  }
}

// ── Harness ─────────────────────────────────────────────────────────────

async function buildApp() {
  const app = Fastify();
  await registerExtendedThinkingRoutes(app);
  return app;
}

afterEach(() => {
  executeMock.mockReset();
});

// ── Contract: stream:true → SSE ─────────────────────────────────────────

describe('POST /v1/chat/completions/extended-thinking — stream:true SSE contract', () => {
  // The FIRST test in this file pays the module transform/JIT cost of the
  // whole route graph; on slower runners that alone can approach or exceed
  // the config's 30s testTimeout (observed flaking when this file runs in
  // the same worker as its sibling suite). Generous per-test timeout.
  it(
    'returns text/event-stream with data: frames, the full chunk payload, and [DONE]',
    async () => {
      executeMock.mockResolvedValueOnce(engineResult());
      const app = await buildApp();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions/extended-thinking',
        payload: {
          messages: [{ role: 'user', content: 'Prove the Collatz conjecture.' }],
          stream: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      const frames = dataFrames(res.body);
      // Terminal sentinel, exactly as the chat SSE path emits it.
      expect(frames[frames.length - 1]).toBe('[DONE]');

      const allChunks = chunks(res.body);
      expectNoReasoningInContent(allChunks);

      // 1. Role-opening chunk.
      expect(allChunks[0].object).toBe('chat.completion.chunk');
      expect(allChunks[0].choices[0].delta).toMatchObject({ role: 'assistant' });
      expect(allChunks[0].choices[0].finish_reason).toBeNull();

      // 2. Reasoning rides the DEDICATED channel — one chunk per thinking block.
      const reasoningChunks = allChunks.filter(
        (c) => typeof c.choices?.[0]?.delta?.reasoning_content === 'string'
      );
      expect(reasoningChunks).toHaveLength(1);
      expect(reasoningChunks[0].choices[0].delta.reasoning_content).toBe('step by step');
      expect(reasoningChunks[0].choices[0].finish_reason).toBeNull();

      // 3. Answer text on delta.content — one chunk per text block.
      const contentChunks = allChunks.filter(
        (c) => typeof c.choices?.[0]?.delta?.content === 'string' && c.choices[0].delta.content !== ''
      );
      expect(contentChunks).toHaveLength(1);
      expect(contentChunks[0].choices[0].delta.content).toBe('The final answer.');
      expect(contentChunks[0].choices[0].finish_reason).toBeNull();

      // 4. Terminal chunk: finish_reason + usage + canonical metadata.
      const terminal = allChunks[allChunks.length - 1];
      expect(terminal.choices[0].delta).toEqual({});
      expect(terminal.choices[0].finish_reason).toBe('stop');
      expect(terminal.usage).toMatchObject({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
      expect(terminal.ailin_metadata).toMatchObject({
        strategy_used: 'single',
        model_count: 0,
        execution_time_ms: expect.any(Number),
        cost_usd: 0.001,
        cache_hit: false,
      });

      await app.close();
    },
    120_000
  );

  it('is NOT a raw JSON body — the response must not be the old single-JSON contract', async () => {
    executeMock.mockResolvedValueOnce(engineResult());
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions/extended-thinking',
      payload: {
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });

    expect(res.headers['content-type']).not.toContain('application/json');
    // A JSON.parse of the whole body must fail (it is an SSE stream).
    expect(() => JSON.parse(res.body)).toThrow();

    await app.close();
  });
});

describe('POST /v1/chat/completions/ultra-thinking — stream:true SSE contract', () => {
  it(
    'returns text/event-stream with data: frames, the full chunk payload, and [DONE]',
    async () => {
      executeMock.mockResolvedValueOnce(engineResult());
      const app = await buildApp();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions/ultra-thinking',
        payload: {
          messages: [{ role: 'user', content: 'Design a system.' }],
          stream: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      const frames = dataFrames(res.body);
      expect(frames[frames.length - 1]).toBe('[DONE]');

      const allChunks = chunks(res.body);
      expectNoReasoningInContent(allChunks);

      // Same dedicated-channel shape as the extended-thinking route.
      expect(allChunks[0].choices[0].delta).toMatchObject({ role: 'assistant' });
      const reasoningChunks = allChunks.filter(
        (c) => typeof c.choices?.[0]?.delta?.reasoning_content === 'string'
      );
      expect(reasoningChunks).toHaveLength(1);
      expect(reasoningChunks[0].choices[0].delta.reasoning_content).toBe('step by step');
      const contentChunks = allChunks.filter(
        (c) => typeof c.choices?.[0]?.delta?.content === 'string' && c.choices[0].delta.content !== ''
      );
      expect(contentChunks).toHaveLength(1);
      expect(contentChunks[0].choices[0].delta.content).toBe('The final answer.');
      expect(allChunks[allChunks.length - 1].choices[0].finish_reason).toBe('stop');

      await app.close();
    },
    120_000
  );
});

// ── Compatibility: stream:false / absent → JSON as before ───────────────

describe('streaming compatibility — stream:false or absent keeps the JSON contract', () => {
  it.each([
    ['stream:false explicit', false],
    ['stream absent (default)', undefined],
  ])('%s returns application/json with the pre-fix body shape', async (_name, stream) => {
    executeMock.mockResolvedValueOnce(engineResult());
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions/extended-thinking',
      payload: {
        messages: [{ role: 'user', content: 'hi' }],
        ...(stream === undefined ? {} : { stream }),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const body = JSON.parse(res.body);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toEqual([
      { type: 'thinking', thinking: 'step by step' },
      { type: 'text', text: 'The final answer.' },
    ]);

    await app.close();
  });
});
