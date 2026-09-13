// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderMediaJudgeClient — contract tests.
 *
 * Pure / mocked. NEVER touches a real provider — uses a synthetic adapter
 * via a fake ProviderRegistry, same pattern as provider-llm-judge-client.test.ts.
 *
 * The property this file most needs to prove: `video_frame` /
 * `audio_transcript` content parts are normalized to plain `text` /
 * `image_url` BEFORE the request reaches `adapter.chatCompletion` — so
 * every existing adapter keeps seeing only the two part types it already
 * understands.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ProviderMediaJudgeClient,
  toProviderCompatibleContent,
} from './provider-media-judge-client';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ChatRequest, ChatResponse, MessageContent, Model } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

function fakeChatResponse(content: string): ChatResponse {
  return {
    id: 'media-judge-1',
    object: 'chat.completion',
    created: 0,
    model: 'vision-judge-model',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', logprobs: null },
    ],
  };
}

function fakeRegistry(adapter: Partial<ProviderAdapter>): ProviderRegistry {
  const model: Model = {
    id: 'vision-judge-model',
    providerId: 'mockprov',
    provider: 'mockprov',
    name: 'vision-judge-model',
    displayName: 'vision judge',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    capabilities: ['chat', 'vision'],
    performance: { latencyMs: 1, throughput: 100, quality: 0.9, reliability: 0.95 },
    status: 'active',
  };
  return {
    findModel: async () => ({ model, adapter: adapter as ProviderAdapter }),
  } as unknown as ProviderRegistry;
}

const sampleContent: MessageContent[] = [
  { type: 'text', text: 'rubric header' },
  {
    type: 'video_frame',
    image_url: { url: 'data:image/jpeg;base64,ZnJhbWUx' },
    timestamp_sec: 2.5,
    timestamp_measured: true,
  },
  { type: 'audio_transcript', text: 'the transcript text' },
];

describe('toProviderCompatibleContent', () => {
  it('converts video_frame to a text caption + image_url, in order', () => {
    const out = toProviderCompatibleContent(sampleContent);
    expect(out.map((p) => p.type)).toEqual(['text', 'text', 'image_url', 'text']);
    expect(out[1]).toEqual({ type: 'text', text: 'Frame at 2.5s:' });
    expect(out[2]).toMatchObject({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ZnJhbWUx' } });
  });

  it('converts audio_transcript to a labeled text block', () => {
    const out = toProviderCompatibleContent([{ type: 'audio_transcript', text: 'hi there' }]);
    expect(out).toEqual([{ type: 'text', text: 'Audio transcript:\nhi there' }]);
  });

  it('passes plain text/image_url parts through unchanged', () => {
    const parts: MessageContent[] = [
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
    ];
    expect(toProviderCompatibleContent(parts)).toEqual(parts);
  });
});

describe('ProviderMediaJudgeClient', () => {
  it('sends only text/image_url content to the adapter, never video_frame/audio_transcript', async () => {
    let seenRequest: ChatRequest | undefined;
    const adapter = {
      getName: () => 'mockprov',
      chatCompletion: vi.fn(async (req: ChatRequest) => {
        seenRequest = req;
        return fakeChatResponse('{"score":0.8,"verdict":"pass","confidence":0.9,"rationale":"ok"}');
      }),
    };
    const client = new ProviderMediaJudgeClient({ registry: fakeRegistry(adapter) });
    const r = await client.judgeMedia({
      judgeModelId: 'vision-judge-model',
      rubricVersion: 'media-v1',
      criticRole: 'artifact_quality',
      task: { taskType: 'video_generation' },
      content: sampleContent,
      maxCostUsd: 0.01,
      timeoutMs: 1000,
    });

    expect(r.score).toBe(0.8);
    expect(r.verdict).toBe('pass');
    expect(adapter.chatCompletion).toHaveBeenCalledOnce();

    const userMessage = seenRequest?.messages.find((m) => m.role === 'user');
    expect(Array.isArray(userMessage?.content)).toBe(true);
    const parts = userMessage!.content as MessageContent[];
    for (const p of parts) {
      expect(['text', 'image_url']).toContain(p.type);
    }
  });

  it('embeds the critic-specific rubric focus in the system prompt', async () => {
    let seenRequest: ChatRequest | undefined;
    const adapter = {
      getName: () => 'mockprov',
      chatCompletion: vi.fn(async (req: ChatRequest) => {
        seenRequest = req;
        return fakeChatResponse('{"score":0.5,"verdict":"uncertain"}');
      }),
    };
    const client = new ProviderMediaJudgeClient({ registry: fakeRegistry(adapter) });
    await client.judgeMedia({
      judgeModelId: 'vision-judge-model',
      rubricVersion: 'media-v1',
      criticRole: 'tone',
      task: {},
      content: [{ type: 'text', text: 'x' }],
      maxCostUsd: 0.01,
      timeoutMs: 1000,
    });
    const systemMessage = seenRequest?.messages.find((m) => m.role === 'system');
    expect(typeof systemMessage?.content).toBe('string');
    expect(systemMessage?.content as string).toContain('TONE');
  });

  it('throws when the judge model does not resolve', async () => {
    const registry = { findModel: async () => undefined } as unknown as ProviderRegistry;
    const client = new ProviderMediaJudgeClient({ registry });
    await expect(
      client.judgeMedia({
        judgeModelId: 'missing-model',
        rubricVersion: 'v1',
        criticRole: 'spec_compliance',
        task: {},
        content: [{ type: 'text', text: 'x' }],
        maxCostUsd: 0.01,
        timeoutMs: 1000,
      })
    ).rejects.toThrow('media_judge_model_not_found:missing-model');
  });
});
