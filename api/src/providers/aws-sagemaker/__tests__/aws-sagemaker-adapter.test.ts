// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * AWSSageMakerAdapter tests.
 *
 * Mirrors the Batch 7 Bedrock mocking pattern:
 *   1. `@aws-sdk/client-sagemaker-runtime` and `@aws-sdk/client-sagemaker` are
 *      vi.mock()-ed at module scope so no real AWS calls happen.
 *   2. Pure helpers (buildRequestBody, buildOpenAIStyleBody, buildJumpstartBody,
 *      buildHfTgiBody, flattenMessagesToPrompt, parseEndpointResponse,
 *      extractTextByScheme, mapOpenAIFinishReason, mapTgiFinishReason) are
 *      tested in isolation without the adapter.
 *   3. Adapter integration tests assert `InvokeEndpointCommand.input` after
 *      the mocked `.send()` call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── SDK mocks (declared before imports that use them) ─────────────────

const mockRuntimeSend = vi.fn();
const mockControlSend = vi.fn();

vi.mock('@aws-sdk/client-sagemaker-runtime', () => {
  const SageMakerRuntimeClient = vi.fn(() => ({ send: mockRuntimeSend }));
  class InvokeEndpointCommand {
    constructor(public readonly input: unknown) {}
  }
  return { SageMakerRuntimeClient, InvokeEndpointCommand };
});

vi.mock('@aws-sdk/client-sagemaker', () => {
  const SageMakerClient = vi.fn(() => ({ send: mockControlSend }));
  class ListEndpointsCommand {
    constructor(public readonly input: unknown) {}
  }
  return { SageMakerClient, ListEndpointsCommand };
});

vi.mock('@/services/model-catalog-service', () => ({
  getModelsByProvider: vi.fn(async () => []),
}));

import {
  AWSSageMakerAdapter,
  buildRequestBody,
  buildOpenAIStyleBody,
  buildJumpstartBody,
  buildHfTgiBody,
  flattenMessagesToPrompt,
  parseEndpointResponse,
  extractTextByScheme,
  mapOpenAIFinishReason,
  mapTgiFinishReason,
  type SageMakerPayloadSchema,
} from '../aws-sagemaker-adapter';

const ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_SAGEMAKER_REGION',
  'AWS_SAGEMAKER_ENDPOINT_NAME',
  'AWS_SAGEMAKER_PAYLOAD_SCHEMA',
  'AWS_SAGEMAKER_CUSTOM_ATTRIBUTES',
] as const;

const ORIG_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    ORIG_ENV[k] = process.env[k];
    delete process.env[k];
  }
  mockRuntimeSend.mockReset();
  mockControlSend.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_ENV[k];
  }
});

// ═══ buildOpenAIStyleBody ═════════════════════════════════════════════

describe('buildOpenAIStyleBody', () => {
  it('preserves OAI-shaped messages array plus core sampling fields', () => {
    const body = buildOpenAIStyleBody({
      model: 'my-endpoint',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi' },
      ],
      max_tokens: 128,
      temperature: 0.2,
      top_p: 0.95,
    });
    expect(body).toEqual({
      model: 'my-endpoint',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi' },
      ],
      max_tokens: 128,
      temperature: 0.2,
      top_p: 0.95,
    });
  });

  it('omits undefined sampling fields (endpoint applies its own defaults)', () => {
    const body = buildOpenAIStyleBody({
      model: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(body).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect('max_tokens' in body).toBe(false);
    expect('temperature' in body).toBe(false);
  });

  it('passes through tool definitions (endpoint must support tools)', () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
    const body = buildOpenAIStyleBody({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      tools,
    });
    expect(body.tools).toEqual(tools);
  });
});

// ═══ buildJumpstartBody ═══════════════════════════════════════════════

describe('buildJumpstartBody', () => {
  it('flattens messages into `inputs` string and maps sampling to parameters', () => {
    const body = buildJumpstartBody({
      model: 'm',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 100,
      temperature: 0.5,
    });
    expect(body).toEqual({
      inputs: 'System: Be brief.\n\nUser: Hello\n\nAssistant:',
      parameters: { max_new_tokens: 100, temperature: 0.5 },
    });
  });

  it('renames max_tokens → max_new_tokens (HF convention)', () => {
    const body = buildJumpstartBody({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      max_tokens: 256,
    }) as { parameters: { max_new_tokens?: number; max_tokens?: number } };
    expect(body.parameters.max_new_tokens).toBe(256);
    expect(body.parameters.max_tokens).toBeUndefined();
  });

  it('normalises a single-string stop to an array', () => {
    const body = buildJumpstartBody({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      stop: '\n\n',
    }) as { parameters: { stop: unknown } };
    expect(body.parameters.stop).toEqual(['\n\n']);
  });
});

// ═══ buildHfTgiBody ═══════════════════════════════════════════════════

describe('buildHfTgiBody', () => {
  it('sets do_sample=true when temperature > 0 (TGI sampling toggle)', () => {
    const body = buildHfTgiBody({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      temperature: 0.7,
    }) as { parameters: { do_sample?: boolean; temperature?: number } };
    expect(body.parameters.do_sample).toBe(true);
    expect(body.parameters.temperature).toBe(0.7);
  });

  it('sets do_sample=false at temperature 0 (deterministic decoding)', () => {
    const body = buildHfTgiBody({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      temperature: 0,
    }) as { parameters: { do_sample?: boolean } };
    expect(body.parameters.do_sample).toBe(false);
  });
});

// ═══ buildRequestBody (dispatcher) ════════════════════════════════════

describe('buildRequestBody (dispatcher)', () => {
  const req = {
    model: 'm',
    messages: [{ role: 'user', content: 'Hi' }] as const,
    max_tokens: 50,
  } as unknown as Parameters<typeof buildRequestBody>[0];

  it('openai schema → OAI-shaped messages body', () => {
    const b = buildRequestBody(req, 'openai') as { messages: unknown };
    expect(Array.isArray(b.messages)).toBe(true);
  });

  it('jumpstart schema → inputs+parameters body', () => {
    const b = buildRequestBody(req, 'jumpstart') as { inputs: string; parameters: unknown };
    expect(typeof b.inputs).toBe('string');
    expect(b.parameters).toBeDefined();
  });

  it('hf-tgi schema → inputs+parameters body with TGI knobs', () => {
    const b = buildRequestBody(req, 'hf-tgi') as { inputs: string; parameters: unknown };
    expect(typeof b.inputs).toBe('string');
    expect(b.parameters).toBeDefined();
  });

  it('throws on an unknown schema value (exhaustiveness)', () => {
    expect(() => buildRequestBody(req, 'invalid' as SageMakerPayloadSchema)).toThrow(
      /unknown payloadSchema/,
    );
  });
});

// ═══ flattenMessagesToPrompt ══════════════════════════════════════════

describe('flattenMessagesToPrompt', () => {
  it('labels each turn with its role and primes an Assistant turn', () => {
    const prompt = flattenMessagesToPrompt([
      { role: 'system', content: 'Rule A' },
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ]);
    expect(prompt).toBe(
      'System: Rule A\n\nUser: Q1\n\nAssistant: A1\n\nUser: Q2\n\nAssistant:',
    );
  });

  it('drops empty-content messages rather than emitting dangling labels', () => {
    const prompt = flattenMessagesToPrompt([
      { role: 'user', content: '' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(prompt).toBe('User: Hi\n\nAssistant:');
  });

  it('joins array-text-part content with newlines', () => {
    const prompt = flattenMessagesToPrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Line A' },
          { type: 'text', text: 'Line B' },
        ] as unknown as string,
      },
    ]);
    expect(prompt).toBe('User: Line A\nLine B\n\nAssistant:');
  });

  it('surfaces tool/function roles rather than silently dropping them', () => {
    const prompt = flattenMessagesToPrompt([
      { role: 'user', content: 'q' },
      { role: 'tool', content: 'tool-output', tool_call_id: 't1' },
    ]);
    expect(prompt).toContain('tool: tool-output');
  });
});

// ═══ parseEndpointResponse ════════════════════════════════════════════

function bytesOf(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

describe('parseEndpointResponse — openai schema', () => {
  it('extracts assistant content + finish_reason + usage', () => {
    const chat = parseEndpointResponse(
      {
        Body: bytesOf({
          choices: [
            {
              message: { role: 'assistant', content: 'Hi there' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        }),
      } as unknown as Parameters<typeof parseEndpointResponse>[0],
      'my-endpoint',
      'openai',
    );
    expect(chat.choices[0].message?.content).toBe('Hi there');
    expect(chat.choices[0].finish_reason).toBe('stop');
    expect(chat.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 13,
    });
  });

  it('handles an empty body gracefully (no crash, empty content)', () => {
    const chat = parseEndpointResponse(
      { Body: undefined } as unknown as Parameters<typeof parseEndpointResponse>[0],
      'ep',
      'openai',
    );
    expect(chat.choices[0].message?.content).toBe('');
    expect(chat.choices[0].finish_reason).toBe(null);
  });

  it('handles a non-JSON body by wrapping it as generated_text', () => {
    const chat = parseEndpointResponse(
      { Body: new TextEncoder().encode('plain-text-reply') } as unknown as Parameters<
        typeof parseEndpointResponse
      >[0],
      'ep',
      // Route through hf-tgi so the wrapped { generated_text } shape is picked up.
      'hf-tgi',
    );
    expect(chat.choices[0].message?.content).toBe('plain-text-reply');
  });
});

describe('parseEndpointResponse — jumpstart/hf-tgi schemas', () => {
  it('extracts generated_text from an array-wrapped response', () => {
    const chat = parseEndpointResponse(
      {
        Body: bytesOf([{ generated_text: 'Reply from TGI' }]),
      } as unknown as Parameters<typeof parseEndpointResponse>[0],
      'ep',
      'hf-tgi',
    );
    expect(chat.choices[0].message?.content).toBe('Reply from TGI');
  });

  it('extracts generated_text + details.generated_tokens for usage (TGI-rich)', () => {
    const chat = parseEndpointResponse(
      {
        Body: bytesOf([
          {
            generated_text: 'Reply',
            details: {
              finish_reason: 'eos_token',
              generated_tokens: 5,
              prefill: [{}, {}, {}],
            },
          },
        ]),
      } as unknown as Parameters<typeof parseEndpointResponse>[0],
      'ep',
      'hf-tgi',
    );
    expect(chat.choices[0].message?.content).toBe('Reply');
    expect(chat.choices[0].finish_reason).toBe('stop');
    expect(chat.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 5,
      total_tokens: 8,
    });
  });

  it('handles a single-object (not array-wrapped) generated_text response', () => {
    const chat = parseEndpointResponse(
      {
        Body: bytesOf({ generated_text: 'Single-object reply' }),
      } as unknown as Parameters<typeof parseEndpointResponse>[0],
      'ep',
      'jumpstart',
    );
    expect(chat.choices[0].message?.content).toBe('Single-object reply');
  });
});

// ═══ extractTextByScheme ══════════════════════════════════════════════

describe('extractTextByScheme', () => {
  it('dispatches openai-shape to the OAI extractor', () => {
    const r = extractTextByScheme(
      { choices: [{ message: { content: 'X' }, finish_reason: 'length' }] },
      'openai',
    );
    expect(r.text).toBe('X');
    expect(r.finishReason).toBe('length');
  });

  it('dispatches jumpstart/hf-tgi to the generated_text extractor', () => {
    const r = extractTextByScheme([{ generated_text: 'Y' }], 'jumpstart');
    expect(r.text).toBe('Y');
  });
});

// ═══ mapOpenAIFinishReason ════════════════════════════════════════════

describe('mapOpenAIFinishReason', () => {
  it('maps known OAI reasons straight through', () => {
    expect(mapOpenAIFinishReason('stop')).toBe('stop');
    expect(mapOpenAIFinishReason('length')).toBe('length');
    expect(mapOpenAIFinishReason('tool_calls')).toBe('tool_calls');
    expect(mapOpenAIFinishReason('content_filter')).toBe('content_filter');
  });

  it('maps eos_token to stop (HF containers sometimes emit this through OAI wrapping)', () => {
    expect(mapOpenAIFinishReason('eos_token')).toBe('stop');
  });

  it('maps function_call (legacy) to tool_calls', () => {
    expect(mapOpenAIFinishReason('function_call')).toBe('tool_calls');
  });

  it('returns null for unknown / undefined', () => {
    expect(mapOpenAIFinishReason(undefined)).toBe(null);
    expect(mapOpenAIFinishReason('mysterious')).toBe(null);
  });
});

// ═══ mapTgiFinishReason ═══════════════════════════════════════════════

describe('mapTgiFinishReason', () => {
  it('maps TGI eos_token / stop_sequence → stop', () => {
    expect(mapTgiFinishReason('eos_token')).toBe('stop');
    expect(mapTgiFinishReason('stop_sequence')).toBe('stop');
  });

  it('maps length → length', () => {
    expect(mapTgiFinishReason('length')).toBe('length');
  });

  it('returns null for unknown / undefined', () => {
    expect(mapTgiFinishReason(undefined)).toBe(null);
    expect(mapTgiFinishReason('??')).toBe(null);
  });
});

// ═══ AWSSageMakerAdapter — construction ═══════════════════════════════

describe('AWSSageMakerAdapter — construction', () => {
  it('constructs with explicit creds + region', () => {
    const adapter = new AWSSageMakerAdapter({
      apiKey: 'AKIA',
      accessKeyId: 'AKIA',
      secretAccessKey: 's',
      region: 'us-west-2',
      endpointName: 'chat-endpoint',
    });
    expect(adapter.getName()).toBe('aws-sagemaker');
    expect(adapter.getDisplayName()).toBe('AWS SageMaker');
    expect(adapter.getRegion()).toBe('us-west-2');
    expect(adapter.getPayloadSchema()).toBe('openai');
  });

  it('falls back to AWS_SAGEMAKER_REGION over AWS_REGION (SageMaker-scoped override)', () => {
    process.env.AWS_ACCESS_KEY_ID = 'k';
    process.env.AWS_SECRET_ACCESS_KEY = 's';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_SAGEMAKER_REGION = 'eu-central-1';
    const adapter = new AWSSageMakerAdapter({ apiKey: 'k' });
    expect(adapter.getRegion()).toBe('eu-central-1');
  });

  it('defaults to us-east-1 when no region is set anywhere', () => {
    process.env.AWS_ACCESS_KEY_ID = 'k';
    process.env.AWS_SECRET_ACCESS_KEY = 's';
    const adapter = new AWSSageMakerAdapter({ apiKey: 'k' });
    expect(adapter.getRegion()).toBe('us-east-1');
  });

  it('reads payloadSchema from AWS_SAGEMAKER_PAYLOAD_SCHEMA env var', () => {
    process.env.AWS_ACCESS_KEY_ID = 'k';
    process.env.AWS_SECRET_ACCESS_KEY = 's';
    process.env.AWS_SAGEMAKER_PAYLOAD_SCHEMA = 'jumpstart';
    const adapter = new AWSSageMakerAdapter({ apiKey: 'k' });
    expect(adapter.getPayloadSchema()).toBe('jumpstart');
  });

  it('throws when accessKeyId is missing everywhere', () => {
    expect(
      () => new AWSSageMakerAdapter({ apiKey: '', secretAccessKey: 's' }),
    ).toThrow(/accessKeyId/);
  });

  it('throws when secretAccessKey is missing', () => {
    expect(
      () => new AWSSageMakerAdapter({ apiKey: 'k', accessKeyId: 'k' }),
    ).toThrow(/secretAccessKey/);
  });
});

// ═══ AWSSageMakerAdapter — normalizeModelName ═════════════════════════

describe('AWSSageMakerAdapter — normalizeModelName', () => {
  function adapter(): AWSSageMakerAdapter {
    return new AWSSageMakerAdapter({
      apiKey: 'k',
      accessKeyId: 'k',
      secretAccessKey: 's',
      endpointName: 'default-ep',
    });
  }

  it('strips aws-sagemaker/ prefix', () => {
    expect(adapter().normalizeModelName('aws-sagemaker/my-endpoint')).toBe('my-endpoint');
  });

  it('strips sagemaker/ prefix (accepts both spellings)', () => {
    expect(adapter().normalizeModelName('sagemaker/my-endpoint')).toBe('my-endpoint');
  });

  it('passes through an un-prefixed endpoint id unchanged', () => {
    expect(adapter().normalizeModelName('my-endpoint')).toBe('my-endpoint');
  });
});

// ═══ AWSSageMakerAdapter — chatCompletion integration ═════════════════

describe('AWSSageMakerAdapter — chatCompletion integration (openai schema)', () => {
  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'k';
    process.env.AWS_SECRET_ACCESS_KEY = 's';
    process.env.AWS_SAGEMAKER_REGION = 'us-east-1';
  });

  it('invokes InvokeEndpointCommand with OAI-shaped body and the resolved endpoint name', async () => {
    mockRuntimeSend.mockResolvedValueOnce({
      Body: bytesOf({
        choices: [{ message: { content: 'Hi back' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }),
    });

    const adapter = new AWSSageMakerAdapter({
      apiKey: 'k',
      endpointName: 'chat-endpoint',
      payloadSchema: 'openai',
    });

    const result = await adapter.chatCompletion({
      model: 'chat-endpoint',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(mockRuntimeSend).toHaveBeenCalledTimes(1);
    const command = mockRuntimeSend.mock.calls[0][0];
    expect(command.input.EndpointName).toBe('chat-endpoint');
    expect(command.input.ContentType).toBe('application/json');
    const body = JSON.parse(new TextDecoder().decode(command.input.Body));
    expect(body).toEqual({
      model: 'chat-endpoint',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.choices[0].message?.content).toBe('Hi back');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage?.total_tokens).toBe(4);
  });

  it('resolves endpoint from the model string when request.model encodes it', async () => {
    mockRuntimeSend.mockResolvedValueOnce({
      Body: bytesOf({ choices: [{ message: { content: 'ok' } }] }),
    });

    const adapter = new AWSSageMakerAdapter({
      apiKey: 'k',
      // No default endpointName — must come from model string.
      payloadSchema: 'openai',
    });

    await adapter.chatCompletion({
      model: 'aws-sagemaker/customer-endpoint-42',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const command = mockRuntimeSend.mock.calls[0][0];
    expect(command.input.EndpointName).toBe('customer-endpoint-42');
  });

  it('attaches CustomAttributes when configured', async () => {
    mockRuntimeSend.mockResolvedValueOnce({
      Body: bytesOf({ choices: [{ message: { content: 'ok' } }] }),
    });

    const adapter = new AWSSageMakerAdapter({
      apiKey: 'k',
      endpointName: 'ep',
      payloadSchema: 'openai',
      customAttributes: 'route=low-latency',
    });

    await adapter.chatCompletion({
      model: 'ep',
      messages: [{ role: 'user', content: 'q' }],
    });

    const command = mockRuntimeSend.mock.calls[0][0];
    expect(command.input.CustomAttributes).toBe('route=low-latency');
  });

  it('throws when no endpoint can be resolved (no default, no model prefix)', async () => {
    const adapter = new AWSSageMakerAdapter({
      apiKey: 'k',
      payloadSchema: 'openai',
    });
    await expect(
      adapter.chatCompletion({
        model: '',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toThrow(/no endpoint to invoke/);
  });
});

describe('AWSSageMakerAdapter — chatCompletion integration (jumpstart schema)', () => {
  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'k';
    process.env.AWS_SECRET_ACCESS_KEY = 's';
  });

  it('sends a flattened inputs+parameters body and parses generated_text', async () => {
    mockRuntimeSend.mockResolvedValueOnce({
      Body: bytesOf([{ generated_text: 'JumpStart reply' }]),
    });

    const adapter = new AWSSageMakerAdapter({
      apiKey: 'k',
      endpointName: 'legacy-endpoint',
      payloadSchema: 'jumpstart',
    });

    const result = await adapter.chatCompletion({
      model: 'legacy-endpoint',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Q' },
      ],
      max_tokens: 64,
    });

    const command = mockRuntimeSend.mock.calls[0][0];
    const body = JSON.parse(new TextDecoder().decode(command.input.Body));
    // Flattened prompt + renamed parameter.
    expect(body.inputs).toBe('System: Be brief.\n\nUser: Q\n\nAssistant:');
    expect(body.parameters.max_new_tokens).toBe(64);

    expect(result.choices[0].message?.content).toBe('JumpStart reply');
  });
});

// ═══ AWSSageMakerAdapter — listDeployedEndpoints ══════════════════════

describe('AWSSageMakerAdapter — listDeployedEndpoints', () => {
  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'k';
    process.env.AWS_SECRET_ACCESS_KEY = 's';
  });

  it('maps SDK response to { name, status, creationTime } tuples', async () => {
    const now = new Date();
    mockControlSend.mockResolvedValueOnce({
      Endpoints: [
        { EndpointName: 'ep-a', EndpointStatus: 'InService', CreationTime: now },
        { EndpointName: 'ep-b', EndpointStatus: 'Creating' },
      ],
    });
    const adapter = new AWSSageMakerAdapter({ apiKey: 'k' });
    const eps = await adapter.listDeployedEndpoints();
    expect(eps).toEqual([
      { name: 'ep-a', status: 'InService', creationTime: now },
      { name: 'ep-b', status: 'Creating', creationTime: undefined },
    ]);
  });

  it('returns [] and does NOT throw when ListEndpoints fails (IAM missing, etc.)', async () => {
    mockControlSend.mockRejectedValueOnce(
      new Error('AccessDeniedException: sagemaker:ListEndpoints not allowed'),
    );
    const adapter = new AWSSageMakerAdapter({ apiKey: 'k' });
    const eps = await adapter.listDeployedEndpoints();
    expect(eps).toEqual([]);
  });
});

// ═══ AWSSageMakerAdapter — healthCheck ════════════════════════════════

describe('AWSSageMakerAdapter — healthCheck', () => {
  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'k';
    process.env.AWS_SECRET_ACCESS_KEY = 's';
  });

  it('returns healthy=true when ListEndpoints succeeds', async () => {
    mockControlSend.mockResolvedValueOnce({ Endpoints: [] });
    const adapter = new AWSSageMakerAdapter({ apiKey: 'k' });
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(true);
    expect(typeof result.latency).toBe('number');
  });

  it('returns healthy=false with error message when ListEndpoints throws', async () => {
    mockControlSend.mockRejectedValueOnce(new Error('region unreachable'));
    const adapter = new AWSSageMakerAdapter({ apiKey: 'k' });
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.error).toContain('region unreachable');
  });
});

// ═══ AWSSageMakerAdapter — unsupported capabilities ═══════════════════

describe('AWSSageMakerAdapter — unsupported capabilities throw', () => {
  const adapter = new AWSSageMakerAdapter({
    apiKey: 'k',
    accessKeyId: 'k',
    secretAccessKey: 's',
    endpointName: 'ep',
  });
  const dummyModel = { id: 'm', name: 'm' } as unknown as import('@/types').Model;

  it('throws on imageEdit', async () => {
    await expect(
      adapter.imageEdit(
        dummyModel,
        {} as unknown as import('@/types/model-client').ImageEditRequest,
      ),
    ).rejects.toThrow(/imageEdit/);
  });

  it('throws on imageVariation', async () => {
    await expect(
      adapter.imageVariation(
        dummyModel,
        {} as unknown as import('@/types/model-client').ImageVariationRequest,
      ),
    ).rejects.toThrow(/imageVariation/);
  });

  it('throws on moderate (endpoint-dependent hint)', async () => {
    await expect(
      adapter.moderate(
        dummyModel,
        {} as unknown as import('@/types/model-client').ModerationRequest,
      ),
    ).rejects.toThrow(/moderate/);
  });

  it('throws on generateEmbeddings with follow-up hint', async () => {
    await expect(
      adapter.generateEmbeddings(
        {} as unknown as import('@/types').EmbeddingRequest,
      ),
    ).rejects.toThrow(/embeddings pack/);
  });
});

// ═══ AWSSageMakerAdapter — calculateCost ══════════════════════════════

describe('AWSSageMakerAdapter — calculateCost', () => {
  it('computes cost from operator-supplied per-1k pricing', () => {
    const a = new AWSSageMakerAdapter({
      apiKey: 'k',
      accessKeyId: 'k',
      secretAccessKey: 's',
    });
    // SageMaker is infra-priced (you pay for the endpoint hour, not per
    // token) — the operator is expected to plug in an approximation via the
    // canonical Model pricing fields. Same shape as every other native
    // adapter in the repo: flat `inputCostPer1k` / `outputCostPer1k` Prisma
    // Decimals, NOT the legacy nested `pricing.inputCostPer1M`.
    //
    // $2 per 1M tokens = $0.002 per 1k tokens (equivalent rate).
    const model = {
      id: 'm',
      name: 'm',
      inputCostPer1k: 0.002,
      outputCostPer1k: 0.010,
    } as unknown as import('@/types').Model;
    // 1M input × $0.002/1k = $2 ; 0.5M output × $0.010/1k = $5 ; total $7
    expect(a.calculateCost(model, 1_000_000, 500_000)).toBeCloseTo(7, 5);
  });

  it('returns 0 when pricing is absent (SageMaker is infra-priced — operator-supplied approximation)', () => {
    const a = new AWSSageMakerAdapter({
      apiKey: 'k',
      accessKeyId: 'k',
      secretAccessKey: 's',
    });
    const model = { id: 'm', name: 'm' } as unknown as import('@/types').Model;
    expect(a.calculateCost(model, 1000, 500)).toBe(0);
  });
});
