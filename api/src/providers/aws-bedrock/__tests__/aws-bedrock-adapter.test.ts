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
  // Real enum value re-declared here (not imported from the actual SDK,
  // which this vi.mock replaces entirely) — the adapter only ever reads
  // `CachePointType.DEFAULT`, and the SDK models it as the literal
  // string 'default' (see @aws-sdk/client-bedrock-runtime's enums.d.ts).
  const CachePointType = { DEFAULT: 'default' } as const;
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand, CachePointType };
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
  isBedrockClaudeModel,
  resolveClaudeCacheMinimumTokens,
  applyClaudeCacheCheckpoint,
  buildConverseInput,
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
    const { system, messages } = splitSystemFromMessages([{ role: 'user', content: 'Hi' }]);
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
    expect(convertMessageToConverse({ role: 'tool' as unknown as 'user', content: 'out' })).toEqual(
      { role: 'user', content: [{ text: 'out' }] }
    );
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
      content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] as unknown as string,
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
      })
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
    expect(buildInferenceConfig({ model: 'm', messages: [], stop: ['<END>', 'STOP'] })).toEqual({
      stopSequences: ['<END>', 'STOP'],
    });
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
    const tools = convertTools([{ type: 'function', function: { name: 'no_args' } }]);
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
      'anthropic.claude-3-5-sonnet-20241022-v2:0'
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
      'm'
    );
    expect(chat.choices[0].message.content).toBe('Part A. Part B.');
  });

  it('handles empty response (no crash, empty content, null finish_reason)', () => {
    const chat = parseConverseResponse(
      {} as unknown as Parameters<typeof parseConverseResponse>[0],
      'm'
    );
    expect(chat.choices[0].message.content).toBe('');
    expect(chat.choices[0].finish_reason).toBe(null);
    expect(chat.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  // Audit finding, 2026-09-08: a non-streaming Converse response whose
  // content included a `toolUse` block previously had it silently dropped —
  // only `text` blocks were ever extracted, so `tool_calls` never reached
  // the caller even though this is the NON-streaming path (see
  // `parseConverseResponse`'s doc comment for the fuller context).
  it('extracts a single toolUse block into OAI-shaped tool_calls', () => {
    const chat = parseConverseResponse(
      {
        output: {
          message: {
            role: 'assistant',
            content: [
              {
                toolUse: {
                  toolUseId: 'tooluse_abc123',
                  name: 'get_weather',
                  input: { city: 'Lisbon' },
                },
              },
            ],
          },
        },
        stopReason: 'tool_use',
      } as unknown as Parameters<typeof parseConverseResponse>[0],
      'anthropic.claude-3-5-sonnet-20241022-v2:0'
    );
    expect(chat.choices[0].finish_reason).toBe('tool_calls');
    expect(chat.choices[0].message.tool_calls).toEqual([
      {
        id: 'tooluse_abc123',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Lisbon"}' },
        index: 0,
      },
    ]);
  });

  it('extracts text AND a toolUse block from the same turn (Claude commonly emits both)', () => {
    const chat = parseConverseResponse(
      {
        output: {
          message: {
            role: 'assistant',
            content: [
              { text: 'Let me check that for you.' },
              { toolUse: { toolUseId: 'tooluse_def456', name: 'get_weather', input: { city: 'Porto' } } },
            ],
          },
        },
        stopReason: 'tool_use',
      } as unknown as Parameters<typeof parseConverseResponse>[0],
      'm'
    );
    expect(chat.choices[0].message.content).toBe('Let me check that for you.');
    expect(chat.choices[0].message.tool_calls).toHaveLength(1);
    expect(chat.choices[0].message.tool_calls?.[0]).toMatchObject({
      id: 'tooluse_def456',
      function: { name: 'get_weather' },
      index: 0,
    });
  });

  it('extracts multiple parallel toolUse blocks with dense zero-based indices', () => {
    const chat = parseConverseResponse(
      {
        output: {
          message: {
            role: 'assistant',
            content: [
              { toolUse: { toolUseId: 'call_a', name: 'get_weather', input: { city: 'Lisbon' } } },
              { toolUse: { toolUseId: 'call_b', name: 'get_time', input: { tz: 'UTC' } } },
            ],
          },
        },
        stopReason: 'tool_use',
      } as unknown as Parameters<typeof parseConverseResponse>[0],
      'm'
    );
    const calls = chat.choices[0].message.tool_calls;
    expect(calls).toHaveLength(2);
    expect(calls?.[0]).toMatchObject({ id: 'call_a', index: 0 });
    expect(calls?.[1]).toMatchObject({ id: 'call_b', index: 1 });
  });

  it('omits tool_calls entirely when no toolUse block is present', () => {
    const chat = parseConverseResponse(
      {
        output: { message: { role: 'assistant', content: [{ text: 'Just text' }] } },
        stopReason: 'end_turn',
      } as unknown as Parameters<typeof parseConverseResponse>[0],
      'm'
    );
    expect(chat.choices[0].message.tool_calls).toBeUndefined();
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

// ═══ Prompt caching (LOTE AZ) ═════════════════════════════════════════
//
// Real per-model minimums sourced from AWS's own Bedrock docs (see
// ADR-025) — these numbers are the external API contract, not arbitrary
// test fixtures, so the assertions below pin the exact documented values
// rather than "some positive number".

describe('isBedrockClaudeModel', () => {
  it('recognizes a plain anthropic.claude-* model id', () => {
    expect(isBedrockClaudeModel('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(true);
  });

  it('recognizes a cross-region-routed us.anthropic.claude-* model id', () => {
    expect(isBedrockClaudeModel('us.anthropic.claude-3-7-sonnet-20250219-v1:0')).toBe(true);
  });

  it('rejects non-Claude Bedrock model families', () => {
    expect(isBedrockClaudeModel('amazon.titan-text-express-v1')).toBe(false);
    expect(isBedrockClaudeModel('meta.llama3-1-70b-instruct-v1:0')).toBe(false);
    expect(isBedrockClaudeModel('mistral.mistral-large-2407-v1:0')).toBe(false);
  });
});

describe('resolveClaudeCacheMinimumTokens', () => {
  it('resolves 1,024 tokens for Claude 3.5 Sonnet v2 and 3.7 Sonnet', () => {
    expect(resolveClaudeCacheMinimumTokens('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(
      1024
    );
    expect(resolveClaudeCacheMinimumTokens('anthropic.claude-3-7-sonnet-20250219-v1:0')).toBe(
      1024
    );
  });

  it('resolves 4,096 tokens for Claude Haiku 4.5', () => {
    expect(resolveClaudeCacheMinimumTokens('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(4096);
  });

  it('resolves 1,024 tokens for Claude Opus 4.8 and Sonnet 4.5', () => {
    expect(resolveClaudeCacheMinimumTokens('anthropic.claude-opus-4-8')).toBe(1024);
    expect(resolveClaudeCacheMinimumTokens('anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(
      1024
    );
  });

  it('falls back to the conservative 4,096-token default for an unlisted Claude model', () => {
    // Not in the table on purpose — proves unknown/future Claude ids degrade
    // to "requires more" rather than crashing or silently under-gating.
    expect(resolveClaudeCacheMinimumTokens('anthropic.claude-3-opus-20240229-v1:0')).toBe(4096);
  });

  it('is case-insensitive on the model id', () => {
    expect(resolveClaudeCacheMinimumTokens('ANTHROPIC.CLAUDE-3-5-SONNET-20241022-V2:0')).toBe(
      1024
    );
  });
});

describe('applyClaudeCacheCheckpoint', () => {
  const CLAUDE_35_SONNET = 'anthropic.claude-3-5-sonnet-20241022-v2:0'; // 1,024-token minimum

  it('passes through unchanged for a non-Claude Bedrock model regardless of size', () => {
    const bigSystem = [{ text: 'x'.repeat(10_000) }];
    const result = applyClaudeCacheCheckpoint(bigSystem, [], 'amazon.titan-text-express-v1');
    expect(result.system).toEqual(bigSystem);
    expect(result.tools).toEqual([]);
  });

  it('does not add a cachePoint when the system prompt is well below the minimum', () => {
    const system = [{ text: 'Be concise.' }]; // ~3 tokens, far under 1,024
    const result = applyClaudeCacheCheckpoint(system, [], CLAUDE_35_SONNET);
    expect(result.system).toEqual(system);
  });

  it('appends a cachePoint to the end of system once the minimum is met', () => {
    const system = [{ text: 'x'.repeat(4200) }]; // ~1,050 tokens, over 1,024
    const result = applyClaudeCacheCheckpoint(system, [], CLAUDE_35_SONNET);
    expect(result.system).toEqual([...system, { cachePoint: { type: 'default' } }]);
  });

  it('appends a cachePoint to the end of tools when no system prompt is present', () => {
    const tools = convertTools([
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'd'.repeat(4200), // ~1,050 tokens once stringified
        },
      },
    ]);
    const result = applyClaudeCacheCheckpoint([], tools, CLAUDE_35_SONNET);
    expect(result.tools).toEqual([...tools, { cachePoint: { type: 'default' } }]);
    expect(result.system).toEqual([]);
  });

  it('gates on the CUMULATIVE tools+system tokens, not either section alone', () => {
    // Neither section alone reaches 1,024 tokens, but together they do.
    const system = [{ text: 'x'.repeat(2000) }]; // ~500 tokens
    const tools = convertTools([
      { type: 'function', function: { name: 'f', description: 'd'.repeat(2200) } }, // ~551 tokens
    ]);
    const result = applyClaudeCacheCheckpoint(system, tools, CLAUDE_35_SONNET);
    // Checkpoint lands at the end of system (the later, more-encompassing
    // section) per AWS's single-breakpoint guidance — tools is untouched.
    expect(result.tools).toEqual(tools);
    expect(result.system).toEqual([...system, { cachePoint: { type: 'default' } }]);
  });

  it('does not add a cachePoint when neither system nor tools are present', () => {
    const result = applyClaudeCacheCheckpoint([], [], CLAUDE_35_SONNET);
    expect(result).toEqual({ system: [], tools: [] });
  });
});

describe('buildConverseInput — caching integration', () => {
  const CLAUDE_35_SONNET = 'anthropic.claude-3-5-sonnet-20241022-v2:0';

  it('carries a cachePoint on system for a large enough system prompt', () => {
    const { converseInput } = buildConverseInput(
      {
        model: CLAUDE_35_SONNET,
        messages: [
          { role: 'system', content: 'x'.repeat(4200) },
          { role: 'user', content: 'Hi' },
        ],
      },
      CLAUDE_35_SONNET
    );
    expect(converseInput.system).toEqual([
      { text: 'x'.repeat(4200) },
      { cachePoint: { type: 'default' } },
    ]);
    expect(converseInput.messages).toEqual([{ role: 'user', content: [{ text: 'Hi' }] }]);
  });

  it('omits cachePoint for a short system prompt (below the model minimum)', () => {
    const { converseInput } = buildConverseInput(
      {
        model: CLAUDE_35_SONNET,
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hi' },
        ],
      },
      CLAUDE_35_SONNET
    );
    expect(converseInput.system).toEqual([{ text: 'Be concise.' }]);
  });

  it('never adds a cachePoint for a non-Claude Bedrock model', () => {
    const { converseInput } = buildConverseInput(
      {
        model: 'amazon.titan-text-express-v1',
        messages: [
          { role: 'system', content: 'x'.repeat(10_000) },
          { role: 'user', content: 'Hi' },
        ],
      },
      'amazon.titan-text-express-v1'
    );
    expect(converseInput.system).toEqual([{ text: 'x'.repeat(10_000) }]);
  });

  it('omits both system and toolConfig keys entirely when neither is present', () => {
    const { converseInput } = buildConverseInput(
      { model: CLAUDE_35_SONNET, messages: [{ role: 'user', content: 'Hi' }] },
      CLAUDE_35_SONNET
    );
    expect(converseInput.system).toBeUndefined();
    expect(converseInput.toolConfig).toBeUndefined();
  });
});

// ═══ buildConverseInput — tool_choice mapping (tool-choice-forwarding fix) ═
//
// Audited gap: `toolConfig.tools` was populated whenever `request.tools` was
// non-empty, but the sibling `toolConfig.toolChoice` field was never built
// from `request.tool_choice` at all — a client forcing a specific tool or
// suppressing tool use for a turn was silently downgraded to Bedrock's
// default unconstrained behavior. `buildConverseInput` is the single
// function shared by both `chatCompletion` and `chatCompletionStream` (see
// its own doc comment), so exercising it here covers both request paths.

describe('buildConverseInput — tool_choice mapping', () => {
  const CLAUDE_35_SONNET = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
  const NOVA_PRO = 'amazon.nova-pro-v1:0';
  const LLAMA = 'meta.llama3-1-70b-instruct-v1:0';

  const TOOLS: NonNullable<Parameters<typeof buildConverseInput>[0]['tools']> = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    },
  ];

  it("maps 'auto' to {auto:{}}", () => {
    const { converseInput } = buildConverseInput(
      { model: CLAUDE_35_SONNET, messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS, tool_choice: 'auto' },
      CLAUDE_35_SONNET
    );
    expect(converseInput.toolConfig?.toolChoice).toEqual({ auto: {} });
  });

  it("maps 'required' to {any:{}} — NOT the same as 'auto'", () => {
    const { converseInput } = buildConverseInput(
      {
        model: CLAUDE_35_SONNET,
        messages: [{ role: 'user', content: 'Hi' }],
        tools: TOOLS,
        tool_choice: 'required' as never,
      },
      CLAUDE_35_SONNET
    );
    expect(converseInput.toolConfig?.toolChoice).toEqual({ any: {} });
  });

  it("maps a forced function choice to {tool:{name}} on a Claude model (documented as supported)", () => {
    const { converseInput } = buildConverseInput(
      {
        model: CLAUDE_35_SONNET,
        messages: [{ role: 'user', content: 'Hi' }],
        tools: TOOLS,
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      },
      CLAUDE_35_SONNET
    );
    expect(converseInput.toolConfig?.toolChoice).toEqual({ tool: { name: 'get_weather' } });
  });

  it('also allows {tool:{name}} on an Amazon Nova model (documented as supported)', () => {
    const { converseInput } = buildConverseInput(
      {
        model: NOVA_PRO,
        messages: [{ role: 'user', content: 'Hi' }],
        tools: TOOLS,
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      },
      NOVA_PRO
    );
    expect(converseInput.toolConfig?.toolChoice).toEqual({ tool: { name: 'get_weather' } });
  });

  it('falls back to {any:{}} for a forced function choice on a model family that does not support named tool_choice (Llama)', () => {
    const { converseInput } = buildConverseInput(
      {
        model: LLAMA,
        messages: [{ role: 'user', content: 'Hi' }],
        tools: TOOLS,
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      },
      LLAMA
    );
    // Not {tool:{name}}: AWS documents `tool` as supported only by Anthropic
    // Claude and Amazon Nova — sending it to Llama would be rejected. Falls
    // back to `any` (forces *a* tool call) instead of silently dropping to
    // unconstrained `auto`.
    expect(converseInput.toolConfig?.toolChoice).toEqual({ any: {} });
  });

  it("suppresses tools/toolConfig entirely for 'none' — Bedrock's ToolChoice union has no none member", () => {
    const { converseInput } = buildConverseInput(
      {
        model: CLAUDE_35_SONNET,
        messages: [{ role: 'user', content: 'Hi' }],
        tools: TOOLS,
        tool_choice: 'none',
      },
      CLAUDE_35_SONNET
    );
    expect(converseInput.toolConfig).toBeUndefined();
  });

  it('omits toolChoice entirely when the caller sends none — preserves prior behavior', () => {
    const { converseInput } = buildConverseInput(
      { model: CLAUDE_35_SONNET, messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS },
      CLAUDE_35_SONNET
    );
    expect(converseInput.toolConfig).toEqual({ tools: expect.any(Array) });
    expect(converseInput.toolConfig?.toolChoice).toBeUndefined();
  });

  it('never sends toolChoice when there are no tools, even if the caller set one', () => {
    const { converseInput } = buildConverseInput(
      { model: CLAUDE_35_SONNET, messages: [{ role: 'user', content: 'Hi' }], tool_choice: 'auto' },
      CLAUDE_35_SONNET
    );
    expect(converseInput.toolConfig).toBeUndefined();
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
    expect(() => new AWSBedrockAdapter({ apiKey: '', secretAccessKey: 's' })).toThrow(
      /accessKeyId/
    );
  });

  it('throws when secretAccessKey is missing', () => {
    expect(() => new AWSBedrockAdapter({ apiKey: 'k', accessKeyId: 'k' })).toThrow(
      /secretAccessKey/
    );
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
    expect(command.input.messages).toEqual([{ role: 'user', content: [{ text: 'Hello' }] }]);
    expect(command.input.inferenceConfig).toEqual({ maxTokens: 100, temperature: 0.5 });

    // Response should be OAI-shaped
    expect(result.choices[0].message.content).toBe('Reply');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage?.total_tokens).toBe(7);
  });

  it('sends a real ConverseCommand with a cachePoint for a large Claude system prompt', async () => {
    mockSend.mockResolvedValueOnce({
      output: { message: { role: 'assistant', content: [{ text: 'Reply' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    });

    const adapter = new AWSBedrockAdapter({ apiKey: 'k' });
    await adapter.chatCompletion({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [
        { role: 'system', content: 'x'.repeat(4200) }, // ~1,050 tokens, over the 1,024 minimum
        { role: 'user', content: 'Hi' },
      ],
    });

    const command = mockSend.mock.calls[0][0];
    expect(command.input.system).toEqual([
      { text: 'x'.repeat(4200) },
      { cachePoint: { type: 'default' } },
    ]);
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

// ═══ AWSBedrockAdapter — chatCompletionStream tool-call reconstruction ═
//
// Audit finding, 2026-09-08: the streaming loop previously only inspected
// `contentBlockDelta.delta.text` and `messageStop` — every `contentBlockStart`
// and tool-use `contentBlockDelta` event was silently dropped, so
// `stream: true` + `tools` discarded every tool call. These tests simulate a
// real ConverseStream event sequence per
// https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
// (contract-only — not live-verified against a real Bedrock account).

async function* fakeBedrockStream(
  events: Array<Record<string, unknown>>
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  for (const event of events) {
    yield event;
  }
}

function singleToolUseStreamEvents(): Array<Record<string, unknown>> {
  return [
    {
      contentBlockStart: {
        contentBlockIndex: 0,
        start: { toolUse: { toolUseId: 'tooluse_01', name: 'get_weather' } },
      },
    },
    {
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { toolUse: { input: '{"city":' } },
      },
    },
    {
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { toolUse: { input: '"Lisbon"}' } },
      },
    },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'tool_use' } },
  ];
}

describe('AWSBedrockAdapter — chatCompletionStream tool-call reconstruction', () => {
  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'k';
    process.env.AWS_SECRET_ACCESS_KEY = 's';
  });

  async function collectToolCalls(events: Array<Record<string, unknown>>) {
    mockSend.mockResolvedValueOnce({ stream: fakeBedrockStream(events) });
    const adapter = new AWSBedrockAdapter({ apiKey: 'k' });
    const collected: import('@/types').ToolCall[] = [];
    const chunks: import('@/types').ChatResponse[] = [];
    for await (const chunk of adapter.chatCompletionStream({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      stream: true,
      messages: [{ role: 'user', content: "what's the weather in Lisbon?" }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    })) {
      chunks.push(chunk);
      const toolCalls = chunk.choices[0]?.delta?.tool_calls;
      if (toolCalls) collected.push(...toolCalls);
    }
    return { collected, chunks };
  }

  it('emits an announce delta (id + name, empty arguments) from contentBlockStart', async () => {
    const { collected } = await collectToolCalls(singleToolUseStreamEvents());
    expect(collected[0]).toMatchObject({
      id: 'tooluse_01',
      type: 'function',
      index: 0,
      function: { name: 'get_weather', arguments: '' },
    });
  });

  it('streams toolUse.input fragments tagged with the same id/name/index, reassembling to valid JSON', async () => {
    const { collected } = await collectToolCalls(singleToolUseStreamEvents());
    for (const delta of collected) {
      expect(delta.id).toBe('tooluse_01');
      expect(delta.function.name).toBe('get_weather');
      expect(delta.index).toBe(0);
    }
    // First delta is the announce (arguments: ''), the rest are fragments.
    const reassembled = collected.map((d) => d.function.arguments).join('');
    expect(reassembled).toBe('{"city":"Lisbon"}');
    expect(JSON.parse(reassembled)).toEqual({ city: 'Lisbon' });
  });

  it('remaps parallel tool calls to dense zero-based indices, not raw contentBlockIndex', async () => {
    const events: Array<Record<string, unknown>> = [
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: 'call_a', name: 'get_weather' } },
        },
      },
      {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: 'call_b', name: 'get_time' } },
        },
      },
      {
        contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"city":"Lisbon"}' } } },
      },
      {
        contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"tz":"UTC"}' } } },
      },
      { messageStop: { stopReason: 'tool_use' } },
    ];
    const { collected } = await collectToolCalls(events);
    const byIndex = new Map<number, import('@/types').ToolCall[]>();
    for (const delta of collected) {
      const bucket = byIndex.get(delta.index!) ?? [];
      bucket.push(delta);
      byIndex.set(delta.index!, bucket);
    }
    expect(byIndex.size).toBe(2);
    expect(byIndex.get(0)!.every((d) => d.id === 'call_a')).toBe(true);
    expect(byIndex.get(1)!.every((d) => d.id === 'call_b')).toBe(true);
  });

  it('still streams text deltas unaffected by tool-call handling', async () => {
    const events: Array<Record<string, unknown>> = [
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello ' } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'world' } } },
      { messageStop: { stopReason: 'end_turn' } },
    ];
    mockSend.mockResolvedValueOnce({ stream: fakeBedrockStream(events) });
    const adapter = new AWSBedrockAdapter({ apiKey: 'k' });
    let text = '';
    let finishReason: string | null = null;
    for await (const chunk of adapter.chatCompletionStream({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      if (typeof chunk.choices[0]?.delta?.content === 'string') text += chunk.choices[0].delta.content;
      if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    }
    expect(text).toBe('Hello world');
    expect(finishReason).toBe('stop');
  });

  it('emits a terminal chunk with finish_reason "tool_calls" mapped from messageStop.stopReason', async () => {
    const { chunks } = await collectToolCalls(singleToolUseStreamEvents());
    const withFinish = chunks.filter((c) => c.choices[0]?.finish_reason !== null);
    expect(withFinish).toHaveLength(1);
    expect(withFinish[0]?.choices[0]?.finish_reason).toBe('tool_calls');
  });
});

// ═══ AWSBedrockAdapter — misc ═════════════════════════════════════════

describe('AWSBedrockAdapter — normalizeModelName', () => {
  it('strips aws-bedrock/ prefix', () => {
    const a = new AWSBedrockAdapter({ apiKey: 'k', accessKeyId: 'k', secretAccessKey: 's' });
    expect(a.normalizeModelName('aws-bedrock/anthropic.claude-3-opus-20240229-v1:0')).toBe(
      'anthropic.claude-3-opus-20240229-v1:0'
    );
  });

  it('strips bedrock/ prefix (accepts both spellings)', () => {
    const a = new AWSBedrockAdapter({ apiKey: 'k', accessKeyId: 'k', secretAccessKey: 's' });
    expect(a.normalizeModelName('bedrock/amazon.titan-text-express-v1')).toBe(
      'amazon.titan-text-express-v1'
    );
  });

  it('passes through already-normalized model ids unchanged', () => {
    const a = new AWSBedrockAdapter({ apiKey: 'k', accessKeyId: 'k', secretAccessKey: 's' });
    expect(a.normalizeModelName('meta.llama3-1-70b-instruct-v1:0')).toBe(
      'meta.llama3-1-70b-instruct-v1:0'
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
      adapter.imageEdit(
        dummyModel,
        {} as unknown as import('@/types/model-client').ImageEditRequest
      )
    ).rejects.toThrow(/imageEdit/);
  });

  it('throws on imageVariation', async () => {
    await expect(
      adapter.imageVariation(
        dummyModel,
        {} as unknown as import('@/types/model-client').ImageVariationRequest
      )
    ).rejects.toThrow(/imageVariation/);
  });

  it('throws on moderate with guardrails hint', async () => {
    await expect(
      adapter.moderate(
        dummyModel,
        {} as unknown as import('@/types/model-client').ModerationRequest
      )
    ).rejects.toThrow(/guardrails/);
  });

  it('throws on generateEmbeddings with follow-up hint', async () => {
    await expect(
      adapter.generateEmbeddings({} as unknown as import('@/types').EmbeddingRequest)
    ).rejects.toThrow(/embeddings pack/);
  });
});
