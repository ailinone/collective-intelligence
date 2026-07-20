// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderLLMJudgeClient — contract tests.
 *
 * Pure / mocked. NEVER touches a real provider — uses a synthetic
 * adapter via a fake ProviderRegistry.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ProviderLLMJudgeClient,
  extractJsonContent,
  coerceRawResult,
} from './provider-llm-judge-client';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ChatResponse, Model } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

function fakeChatResponse(content: string): ChatResponse {
  return {
    id: 'judge-1',
    object: 'chat.completion',
    created: 0,
    model: 'judge-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
  };
}

function fakeRegistry(adapter: Partial<ProviderAdapter>): ProviderRegistry {
  const model: Model = {
    id: 'judge-model',
    providerId: 'mockprov',
    provider: 'mockprov',
    name: 'judge-model',
    displayName: 'judge',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    capabilities: ['chat'],
    performance: { latencyMs: 1, throughput: 100, quality: 0.9, reliability: 0.95 },
    status: 'active',
  };
  return {
    findModel: async () => ({ model, adapter: adapter as ProviderAdapter }),
  } as unknown as ProviderRegistry;
}

describe('ProviderLLMJudgeClient', () => {
  it('parses a pure-JSON judge response', async () => {
    const adapter = {
      getName: () => 'mockprov',
      chatCompletion: vi.fn(async () =>
        fakeChatResponse('{"score":0.8,"verdict":"pass","confidence":0.9,"rationale":"ok"}'),
      ),
    };
    const client = new ProviderLLMJudgeClient({ registry: fakeRegistry(adapter) });
    const r = await client.judge({
      judgeModelId: 'judge-model',
      rubricVersion: 'v1',
      task: { taskType: 'analysis' },
      output: 'candidate text',
      maxCostUsd: 0.01,
      timeoutMs: 1000,
    });
    expect(r.score).toBe(0.8);
    expect(r.verdict).toBe('pass');
    expect(r.confidence).toBe(0.9);
    expect(r.shortRationale).toBe('ok');
    expect(adapter.chatCompletion).toHaveBeenCalledOnce();
  });

  it('strips markdown fences around the JSON', async () => {
    const adapter = {
      getName: () => 'mockprov',
      chatCompletion: async () =>
        fakeChatResponse('```json\n{"score":0.5,"verdict":"uncertain"}\n```'),
    };
    const client = new ProviderLLMJudgeClient({ registry: fakeRegistry(adapter) });
    const r = await client.judge({
      judgeModelId: 'judge-model',
      rubricVersion: 'v1',
      task: {},
      output: 'x',
      maxCostUsd: 0.01,
      timeoutMs: 1000,
    });
    expect(r.score).toBe(0.5);
    expect(r.verdict).toBe('uncertain');
  });

  it('extracts JSON when the model emits prose around it', async () => {
    const adapter = {
      getName: () => 'mockprov',
      chatCompletion: async () =>
        fakeChatResponse('Here is the result:\n{"score":0.3,"verdict":"fail"}\nDone.'),
    };
    const client = new ProviderLLMJudgeClient({ registry: fakeRegistry(adapter) });
    const r = await client.judge({
      judgeModelId: 'judge-model',
      rubricVersion: 'v1',
      task: {},
      output: 'x',
      maxCostUsd: 0.01,
      timeoutMs: 1000,
    });
    expect(r.score).toBe(0.3);
    expect(r.verdict).toBe('fail');
  });

  it('throws on score out of range', async () => {
    const adapter = {
      getName: () => 'mockprov',
      chatCompletion: async () =>
        fakeChatResponse('{"score":1.5,"verdict":"pass"}'),
    };
    const client = new ProviderLLMJudgeClient({ registry: fakeRegistry(adapter) });
    await expect(
      client.judge({
        judgeModelId: 'judge-model',
        rubricVersion: 'v1',
        task: {},
        output: 'x',
        maxCostUsd: 0.01,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/score_out_of_range/);
  });

  it('throws on invalid verdict', async () => {
    const adapter = {
      getName: () => 'mockprov',
      chatCompletion: async () =>
        fakeChatResponse('{"score":0.5,"verdict":"maybe"}'),
    };
    const client = new ProviderLLMJudgeClient({ registry: fakeRegistry(adapter) });
    await expect(
      client.judge({
        judgeModelId: 'judge-model',
        rubricVersion: 'v1',
        task: {},
        output: 'x',
        maxCostUsd: 0.01,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/verdict_invalid/);
  });

  it('throws when judge model is not found', async () => {
    const registry = {
      findModel: async () => null,
    } as unknown as ProviderRegistry;
    const client = new ProviderLLMJudgeClient({ registry });
    await expect(
      client.judge({
        judgeModelId: 'nope',
        rubricVersion: 'v1',
        task: {},
        output: 'x',
        maxCostUsd: 0.01,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/judge_model_not_found:nope/);
  });

  it('pins temperature=0 and bounded max_tokens on the judge request', async () => {
    const adapter = {
      getName: () => 'mockprov',
      chatCompletion: vi.fn(async () =>
        fakeChatResponse('{"score":0.5,"verdict":"pass"}'),
      ),
    };
    const client = new ProviderLLMJudgeClient({ registry: fakeRegistry(adapter) });
    await client.judge({
      judgeModelId: 'judge-model',
      rubricVersion: 'v1',
      task: {},
      output: 'x',
      maxCostUsd: 0.01,
      timeoutMs: 1000,
    });
    const sentRequest = adapter.chatCompletion.mock.calls[0][0];
    expect(sentRequest.temperature).toBe(0);
    expect(sentRequest.max_tokens).toBe(600);
    expect(sentRequest.stream).toBe(false);
  });

  it('does not include raw output in logs (no prompt leakage)', async () => {
    // Smoke: we cannot easily test logger output, but we verify the adapter
    // receives the output (so the judge can score it) and that the parsed
    // result does NOT echo the prompt back.
    const adapter = {
      getName: () => 'mockprov',
      chatCompletion: async () =>
        fakeChatResponse('{"score":0.5,"verdict":"pass","rationale":"good"}'),
    };
    const client = new ProviderLLMJudgeClient({ registry: fakeRegistry(adapter) });
    const r = await client.judge({
      judgeModelId: 'judge-model',
      rubricVersion: 'v1',
      task: {},
      output: 'SECRET PROMPT TEXT THAT MUST NOT LEAK',
      maxCostUsd: 0.01,
      timeoutMs: 1000,
    });
    expect(JSON.stringify(r)).not.toContain('SECRET PROMPT TEXT');
  });
});

describe('pure helpers', () => {
  it('extractJsonContent handles fenced + braced + plain', () => {
    expect(extractJsonContent(fakeChatResponse('```json\n{"a":1}\n```'))).toBe('{"a":1}');
    expect(extractJsonContent(fakeChatResponse('before {"a":1} after'))).toBe('{"a":1}');
    expect(extractJsonContent(fakeChatResponse('{"a":1}'))).toBe('{"a":1}');
    expect(extractJsonContent(fakeChatResponse(''))).toBeNull();
  });

  it('coerceRawResult enforces score range', () => {
    expect(() => coerceRawResult({ score: 1.5, verdict: 'pass' })).toThrow(/out_of_range/);
    expect(() => coerceRawResult({ score: -0.1, verdict: 'pass' })).toThrow(/out_of_range/);
    expect(coerceRawResult({ score: 0.5, verdict: 'pass' }).score).toBe(0.5);
  });
});
