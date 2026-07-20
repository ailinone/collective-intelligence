// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * AWSBedrockAdapter tests.
 *
 * Strategy — same as Batch 6:
 *   1. Pure helpers (splitSystemFromMessages, convertMessageToConverse,
 *      buildInferenceConfig, convertTools, parseConverseResponse,
 *      mapStopReason) are tested in isolation. They're deterministic, need
 *      no mocks, and are the load-bearing pieces for correctness.
 *   2. Adapter construction + identity tests verify the SDK-client wiring
 *      without actually hitting AWS.
 *   3. One mocked-SDK integration test verifies ConverseCommand is invoked
 *      with a correctly-shaped input (system extracted, messages mapped,
 *      inferenceConfig built).
 *
 * We mock `@aws-sdk/client-bedrock-runtime` and `@aws-sdk/client-bedrock`
 * at module scope so no real SDK clients are ever constructed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── SDK mocks (declared before imports that use them) ─────────────────

const mockSend = vi.fn();
const mockControlSend = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  const BedrockRuntimeClient = vi.fn(() => ({ send: mockSend }));
  // ConverseCommand / ConverseStreamCommand are just wrappers around input;
  // the mock captures input via the send() argument.
  class ConverseCommand {
    constructor(public readonly input: unknown) {}
  }
  class ConverseStreamCommand {
    constructor(public readonly input: unknown) {}
  }
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand };
});

vi.mock('@aws-sdk/client-bedrock', () => {
  const BedrockClient = vi.fn(() => ({ send: mockControlSend }));
  class ListFoundationModelsCommand {
    constructor(public readonly input: unknown) {}
  }
  return { BedrockClient, ListFoundationModelsCommand };
});

vi.mock('@/services/model-catalog-service', () => ({
  getModelsByProvider: vi.fn(async () => []),
}));

import {
  AWSBedrockAdapter,
  splitSystemFromMessages,
  convertMessageToConverse,
  buildInferenceConfig,
  convertTools,
  parseConverseResponse,
  mapStopReason,
} from '../aws-bedrock-adapter';

const ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_BEDROCK_REGION',
  'AWS_BEDROCK_INFERENCE_PROFILE_ARN',
] as const;

const ORIG_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    ORIG_ENV[k] = process.env[k];
    delete process.env[k];
  }
  mockSend.mockReset();
  mockControlSend.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_ENV[k];
  }
});

// ═══ splitSystemFromMessages ══════════════════════════════════════════

describe('splitSystemFromMessages', () => {
  it('hoists a single system message into the system[] array', () => {
    const { messages, system } = splitSystemFromMessages([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(system).toEqual([{ text: 'You are a helpful assistant.' }]);
    expect(messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('hoists multiple system messages preserving order (separate blocks)', () => {
    const { system } = splitSystemFromMessages([
      { role: 'system', content: 'Rule A' },
      { role: 'user', content: 'Q1' },
      { role: 'system', content: 'Rule B' },
    ]);
    // Converse treats each system-block independently; order preserved.
    expect(system).toEqual([{ text: 'Rule A' }, { text: 'Rule B' }]);
  });

  it('handles array-content system messages by joining text parts', () => {
    const { system } = splitSystemFromMessages([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Line 1' } as unknown as { text: string },
          { type: 'text', text: 'Line 2' } as unknown as { text: string },
        ] as unknown as string,
      },
    ]);
    expect(system).toEqual([{ text: 'Line 1\nLine 2' }]);
  });

  it('produces empty system[] when no system messages present', () => {
    const { system, messages } = splitSystemFromMessages([
      { role: 'user', content: 'Hi' },
    ]);
    expect(system).toEqual([]);
    expect(messages).toHaveLength(1);
  });
});

// ═══ convertMessageToConverse ═════════════════════════════════════════

describe('convertMessageToConverse', () => {
  it('maps string-content user message to Converse text block', () => {
    expect(convertMessageToConverse({ role: 'user', content: 'Hello' })).toEqual({
      role: 'user',
      content: [{ text: 'Hello' }],
    });
  });

  it('maps assistant role unchanged (user|assistant are the only Converse roles)', () => {
    expect(convertMessageToConverse({ role: 'assistant', content: 'Sure' })).toEqual({
      role: 'assistant',
      content: [{ text: 'Sure' }],
    });
  });

  it('falls through non-user/assistant roles to user (safest default)', () => {
    // 'tool' role isn't a Converse role — we downgrade to user rather than
    // drop the message (losing context is worse than a role mismatch).
    expect(
      convertMessageToConverse({ role: 'tool' as unknown as 'user', content: 'out' }),
    ).toEqual({ role: 'user', content: [{ text: 'out' }] });
  });

  it('maps text-parts array content to multiple Converse text blocks', () => {
    const msg = convertMessageToConverse({
      role: 'user',
      content: [
        { type: 'text', text: 'Part A' },
        { type: 'text', text: 'Part B' },
      ] as unknown as string,
    });
    expect(msg).toEqual({ role: 'user', content: [{ text: 'Part A' }, { text: 'Part B' }] });
  });

  it('drops image_url parts with an empty stub (vision deferred to follow-up)', () => {
    const msg = convertMessageToConverse({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'https://x/y.png' } },
      ] as unknown as string,
    });
    // No image support in this pack — result is a single empty text block
    // rather than crashing or sending a malformed image payload.
    expect(msg.content).toEqual([{ text: '' }]);
  });
});

// ═══ buildInferenceConfig ═════════════════════════════════════════════

describe('buildInferenceConfig', () => {
  it('maps max_tokens / temperature / top_p correctly', () => {
    expect(
      buildInferenceConfig({
        model: 'm',
        messages: [],
        max_tokens: 512,
        temperature: 0.3,
        top_p: 0.9,
      }),
    ).toEqual({ maxTokens: 512, temperature: 0.3, topP: 0.9 });
  });

  it('emits empty config when all optional fields omitted (SDK uses per-family defaults)', () => {
    expect(buildInferenceConfig({ model: 'm', messages: [] })).toEqual({});
  });

  it('normalizes a single-string stop into stopSequences array', () => {
    expect(buildInferenceConfig({ model: 'm', messages: [], stop: '\n\n' })).toEqual({
      stopSequences: ['\n\n'],
    });
  });

  it('passes array stop sequences through unchanged', () => {
    expect(
      buildInferenceConfig({ model: 'm', messages: [], stop: ['<END>', 'STOP'] }),
    ).toEqual({ stopSequences: ['<END>', 'STOP'] });
  });
});

// ═══ convertTools ═════════════════════════════════════════════════════

describe('convertTools', () => {
  it('maps OAI function tool to Converse toolSpec', () => {
    const tools = convertTools([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ]);
    expect(tools).toEqual([
      {
        toolSpec: {
          name: 'get_weather',
          description: 'Get weather for a city',
          inputSchema: {
            json: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      },
    ]);
  });

  it('defaults missing parameters to empty object schema', () => {
    const tools = convertTools([
      { type: 'function', function: { name: 'no_args' } },
    ]);
    expect(tools[0].toolSpec?.inputSchema).toEqual({ json: {} });
  });
});

// ═══ parseConverseResponse ════════════════════════════════════════════

describe('parseConverseResponse', () => {
  it('extracts assistant text from output.message.content blocks', () => {
    const chat = parseConverseResponse(
      {
        output: {
          message: { role: 'assistant', content: [{ text: 'Hello world' }] },
        },
        stopReason: 'end_turn',
        usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
      } as unknown as Parameters<typeof parseConverseResponse>[0],
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
    );
    expect(chat.choices[0].message.content).toBe('Hello world');
    expect(chat.choices[0].finish_reason).toBe('stop');
    expect(chat.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19,
    });
    expect(chat.model).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
  });

  it('concatenates multiple text blocks into a single string', () => {
    const chat = parseConverseResponse(
      {
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'Part A.' }, { text: ' Part B.' }],
          },
        },
      } as unknown as Parameters<typeof parseConverseResponse>[0],
      'm',
    );
    expect(chat.choices[0].message.content).toBe('Part A. Part B.');
  });

  it('handles empty response (no crash, empty content, null finish_reason)', () => {
    const chat = parseConverseResponse(
      {} as unknown as Parameters<typeof parseConverseResponse>[0],
      'm',
    );
    expect(chat.choices[0].message.content).toBe('');
    expect(chat.choices[0].finish_reason).toBe(null);
    expect(chat.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });
});

// ═══ mapStopReason ════════════════════════════════════════════════════

describe('mapStopReason', () => {
  it('maps end_turn / stop_sequence → "stop"', () => {
    expect(mapStopReason('end_turn')).toBe('stop');
    expect(mapStopReason('stop_sequence')).toBe('stop');
  });

  it('maps max_tokens → "length" (OAI convention)', () => {
    expect(mapStopReason('max_tokens')).toBe('length');
  });

  it('maps tool_use → "tool_calls" (OAI convention)', () => {
    expect(mapStopReason('tool_use')).toBe('tool_calls');
  });

  it('maps guardrail_intervened / content_filtered → "content_filter"', () => {
    expect(mapStopReason('guardrail_intervened')).toBe('content_filter');
    expect(mapStopReason('content_filtered')).toBe('content_filter');
  });

  it('maps unknown / undefined to null (not a crash)', () => {
    expect(mapStopReason(undefined)).toBe(null);
    expect(mapStopReason('unknown_future_reason')).toBe(null);
  });
});

// ═══ AWSBedrockAdapter — construction + identity ══════════════════════

describe('AWSBedrockAdapter — construction', () => {
  it('constructs with explicit access key + secret + region', () => {
    const adapter = new AWSBedrockAdapter({
      apiKey: 'AKIA...',
      accessKeyId: 'AKIA...',
      secretAccessKey: 'supersecret',
      region: 'us-west-2',
    });
    expect(adapter.getName()).toBe('aws-bedrock');
    expect(adapter.getDisplayName()).toBe('AWS Bedrock');
    expect(adapter.getRegion()).toBe('us-west-2');
  });

  it('falls back to AWS env vars when config omits credentials', () => {
    process.env.AWS_ACCESS_KEY_ID = 'env-access-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'env-secret';
    process.env.AWS_BEDROCK_REGION = 'eu-west-1';

    const adapter = new AWSBedrockAdapter({ apiKey: 'env-access-key' });
    expect(adapter.getRegion()).toBe('eu-west-1');
  });

  it('defaults to us-east-1 when no region env or config given', () => {
    process.env.AWS_ACCESS_KEY_ID = 'k';
    process.env.AWS_SECRET_ACCESS_KEY = 's';
    const adapter = new AWSBedrockAdapter({ apiKey: 'k' });
    expect(adapter.getRegion()).toBe('us-east-1');
  });

  it('prefers AWS_BEDROCK_REGION over AWS_REGION (Bedrock-scoped override)', () => {
    // This ordering matters — a deploy may have AWS_REGION set for SES
    // but route Bedrock to a different region entirely.
    process.env.AWS_ACCESS_KEY_ID = 'k';
    process.env.AWS_SECRET_ACCESS_KEY = 's';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_BEDROCK_REGION = 'us-west-2';
    const adapter = new AWSBedrockAdapter({ apiKey: 'k' });
    expect(adapter.getRegion()).toBe('us-west-2');
  });

  it('throws when neither config nor env provides accessKeyId', () => {
    expect(
      () => new AWSBedrockAdapter({ apiKey: '', secretAccessKey: 's' }),
    ).toThrow(/accessKeyId/);
  });

  it('throws when secretAccessKey is missing', () => {
    expect(
      () => new AWSBedrockAdapter({ apiKey: 'k', accessKeyId: 'k' }),
    ).toThrow(/secretAccessKey/);
  });
});

// ═══ AWSBedrockAdapter — chatCompletion (mocked SDK) ══════════════════

describe('AWSBedrockAdapter — chatCompletion integration', () => {
  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'k';
    process.env.AWS_SECRET_ACCESS_KEY = 's';
    process.env.AWS_BEDROCK_REGION = 'us-east-1';
  });

  it('invokes ConverseCommand with system extracted + messages mapped', async () => {
    mockSend.mockResolvedValueOnce({
      output: {
        message: { role: 'assistant', content: [{ text: 'Reply' }] },
      },
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    });

    const adapter = new AWSBedrockAdapter({ apiKey: 'k' });
    const result = await adapter.chatCompletion({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 100,
      temperature: 0.5,
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    // ConverseCommand wraps input — the mock class exposes it directly
    expect(command.input.modelId).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(command.input.system).toEqual([{ text: 'Be concise.' }]);
    expect(command.input.messages).toEqual([
      { role: 'user', content: [{ text: 'Hello' }] },
    ]);
    expect(command.input.inferenceConfig).toEqual({ maxTokens: 100, temperature: 0.5 });

    // Response should be OAI-shaped
    expect(result.choices[0].message.content).toBe('Reply');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage?.total_tokens).toBe(7);
  });

  it('uses inferenceProfileArn when configured (cross-region routing)', async () => {
    mockSend.mockResolvedValueOnce({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
    });

    const adapter = new AWSBedrockAdapter({
      apiKey: 'k',
      inferenceProfileArn:
        'arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-3-5-sonnet-v2',
    });
    await adapter.chatCompletion({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const command = mockSend.mock.calls[0][0];
    // Profile ARN takes precedence over the raw model id.
    expect(command.input.modelId).toContain('inference-profile');
  });
});

// ═══ AWSBedrockAdapter — misc ═════════════════════════════════════════

describe('AWSBedrockAdapter — normalizeModelName', () => {
  it('strips aws-bedrock/ prefix', () => {
    const a = new AWSBedrockAdapter({ apiKey: 'k', accessKeyId: 'k', secretAccessKey: 's' });
    expect(a.normalizeModelName('aws-bedrock/anthropic.claude-3-opus-20240229-v1:0')).toBe(
      'anthropic.claude-3-opus-20240229-v1:0',
    );
  });

  it('strips bedrock/ prefix (accepts both spellings)', () => {
    const a = new AWSBedrockAdapter({ apiKey: 'k', accessKeyId: 'k', secretAccessKey: 's' });
    expect(a.normalizeModelName('bedrock/amazon.titan-text-express-v1')).toBe(
      'amazon.titan-text-express-v1',
    );
  });

  it('passes through already-normalized model ids unchanged', () => {
    const a = new AWSBedrockAdapter({ apiKey: 'k', accessKeyId: 'k', secretAccessKey: 's' });
    expect(a.normalizeModelName('meta.llama3-1-70b-instruct-v1:0')).toBe(
      'meta.llama3-1-70b-instruct-v1:0',
    );
  });
});

describe('AWSBedrockAdapter — calculateCost', () => {
  it('computes input + output cost from per-1k rates', () => {
    const a = new AWSBedrockAdapter({ apiKey: 'k', accessKeyId: 'k', secretAccessKey: 's' });
    // Canonical Model shape: top-level `inputCostPer1k` / `outputCostPer1k`
    // (per-1k rates) — NOT the legacy nested `pricing.inputCostPer1M`. The
    // adapter was rewritten in this batch to read the canonical fields;
    // keeping the stale nested shape here would silently return 0 (via
    // `Number(undefined) || 0`) and hide the drift.
    //
    // $3 per 1M tokens = $0.003 per 1k tokens (equivalent rate).
    const model = {
      id: 'm',
      name: 'm',
      inputCostPer1k: 0.003,
      outputCostPer1k: 0.015,
    } as unknown as import('@/types').Model;
    // 1M input × $0.003/1k = $3 ; 0.5M output × $0.015/1k = $7.5 ; total $10.5
    expect(a.calculateCost(model, 1_000_000, 500_000)).toBeCloseTo(10.5, 5);
  });

  it('returns 0 when pricing is absent (rather than NaN)', () => {
    const a = new AWSBedrockAdapter({ apiKey: 'k', accessKeyId: 'k', secretAccessKey: 's' });
    const model = { id: 'm', name: 'm' } as unknown as import('@/types').Model;
    expect(a.calculateCost(model, 1000, 500)).toBe(0);
  });
});

describe('AWSBedrockAdapter — unsupported capabilities throw', () => {
  const adapter = new AWSBedrockAdapter({
    apiKey: 'k',
    accessKeyId: 'k',
    secretAccessKey: 's',
  });
  const dummyModel = { id: 'm', name: 'm' } as unknown as import('@/types').Model;

  it('throws on imageEdit', async () => {
    await expect(
      adapter.imageEdit(dummyModel, {} as unknown as import('@/types/model-client').ImageEditRequest),
    ).rejects.toThrow(/imageEdit/);
  });

  it('throws on imageVariation', async () => {
    await expect(
      adapter.imageVariation(dummyModel, {} as unknown as import('@/types/model-client').ImageVariationRequest),
    ).rejects.toThrow(/imageVariation/);
  });

  it('throws on moderate with guardrails hint', async () => {
    await expect(
      adapter.moderate(dummyModel, {} as unknown as import('@/types/model-client').ModerationRequest),
    ).rejects.toThrow(/guardrails/);
  });

  it('throws on generateEmbeddings with follow-up hint', async () => {
    await expect(
      adapter.generateEmbeddings({} as unknown as import('@/types').EmbeddingRequest),
    ).rejects.toThrow(/embeddings pack/);
  });
});
