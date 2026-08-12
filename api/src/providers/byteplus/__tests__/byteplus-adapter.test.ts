// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * BytePlusModelArkAdapter — wire contract tests (mocked fetch).
 *
 * Covers, per capability: REQUEST-SHAPE COMPOSITION (the ModelArk-specific
 * overrides that differ from OpenAI), RESPONSE PARSING (including the
 * non-OpenAI shapes: object-not-array embeddings, `content.video_url`,
 * inline per-item image errors), and ERROR HANDLING (the `ModelNotOpen`
 * entitlement gate, the split 429 retry taxonomy, and the 200-empty-body
 * absent-route signal).
 *
 * Response fixtures are modelled on real observed payloads from the
 * 2026-08-02 live probe wherever one was obtainable (`/models`,
 * `/tokenization`, `/ping`, the error envelopes) and on the documented
 * verbatim samples elsewhere. No live credentials needed — `fetch` is
 * stubbed per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BytePlusModelArkAdapter } from '../byteplus-adapter';
import type { Model } from '@/types';
import { narrowAs } from '@/utils/type-guards';

const BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';

type FetchCall = { url: string; init: RequestInit; body: Record<string, unknown> };
let calls: FetchCall[] = [];

/** Stub returning one canned JSON response for every call. */
function stubJson(jsonBody: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    });
    const text = typeof jsonBody === 'string' ? jsonBody : JSON.stringify(jsonBody);
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => jsonBody,
      text: async () => text,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Stub returning a different canned response per sequential call. */
function stubSequence(responses: Array<{ body: unknown; ok?: boolean; status?: number }>) {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i++;
    calls.push({
      url: String(url),
      init: init ?? {},
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    });
    const text = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => spec.body,
      text: async () => text,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeAdapter(opts: { apiKey?: string } = {}): BytePlusModelArkAdapter {
  return new BytePlusModelArkAdapter({
    apiKey: opts.apiKey ?? 'byteplus-test-key',
    baseUrl: BASE,
    // Keep retry-driven tests fast and deterministic.
    maxRetries: 1,
    retryDelay: 1,
  });
}

function chatFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: '0217426318107460cfa43dc3f3683b1de1c09624ff49085a456ac',
    object: 'chat.completion',
    created: 1742631811,
    model: 'seed-2-0-lite-260228',
    service_tier: 'default',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Hello! How can I help you today?' },
      },
    ],
    usage: { prompt_tokens: 19, completion_tokens: 9, total_tokens: 28 },
    ...overrides,
  };
}

const model = (id: string): Model => narrowAs<Model>({ id, name: id, provider: 'byteplus' });

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Discovery ───────────────────────────────────────────────────────────

describe('BytePlusModelArkAdapter — getModels (real GET /models)', () => {
  const listing = {
    object: 'list',
    data: [
      {
        id: 'seed-2-0-lite-260228',
        name: 'seed-2-0-lite',
        version: '260228',
        object: 'model',
        domain: 'VLM',
        task_type: ['VisualQuestionAnswering', 'TextGeneration'],
        modalities: { input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] },
        token_limits: {
          context_window: 262144,
          max_output_token_length: 131072,
          max_reasoning_token_length: 131072,
        },
        features: {
          tools: { function_calling: true },
          structured_outputs: { json_object: true, json_schema: true },
        },
      },
      {
        id: 'seedream-4-0-250828',
        object: 'model',
        domain: 'ImageGeneration',
        task_type: ['ImageToImage', 'TextToImage'],
        modalities: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
      },
      {
        id: 'dreamina-seedance-2-0-260128',
        object: 'model',
        domain: 'VideoGeneration',
        task_type: ['MultimodalToVideo', 'VideoEditing', 'VideoExtension'],
        modalities: {
          input_modalities: ['image', 'video', 'audio', 'text'],
          output_modalities: ['video'],
        },
      },
      {
        id: 'skylark-embedding-vision-251215',
        object: 'model',
        task_type: ['ImageEmbedding', 'MultimodalEmbedding', 'TextEmbedding'],
        modalities: { input_modalities: ['text', 'image', 'video'] },
      },
      {
        id: 'deepseek-r1-250120',
        object: 'model',
        domain: 'LLM',
        status: 'Shutdown',
        task_type: ['TextGeneration'],
        modalities: { input_modalities: ['text'], output_modalities: ['text'] },
      },
      {
        id: 'skylark-pro',
        object: 'model',
        domain: 'LLM',
        status: 'Retiring',
        task_type: ['TextGeneration'],
        modalities: { input_modalities: ['text'], output_modalities: ['text'] },
      },
    ],
  };

  it('GETs /models with Bearer auth and parses the listing', async () => {
    const restore = stubJson(listing);
    try {
      const models = await makeAdapter().getModels();
      expect(calls[0].url).toBe(`${BASE}/models`);
      expect(calls[0].init.method).toBe('GET');
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer byteplus-test-key');
      expect(models.map((m) => m.id)).toContain('seed-2-0-lite-260228');
    } finally {
      restore();
    }
  });

  it('filters out `Shutdown` models (listed but NOT callable) and keeps `Retiring` ones', async () => {
    const restore = stubJson(listing);
    try {
      const models = await makeAdapter().getModels();
      const ids = models.map((m) => m.id);
      expect(ids).not.toContain('deepseek-r1-250120');
      expect(ids).toContain('skylark-pro');
      // Retiring is still callable, but flagged so callers can migrate off it.
      expect(models.find((m) => m.id === 'skylark-pro')?.status).toBe('deprecated');
    } finally {
      restore();
    }
  });

  it('derives capabilities from vendor-declared task_type/modalities/features, not name regexes', async () => {
    const restore = stubJson(listing);
    try {
      const models = await makeAdapter().getModels();
      const byId = (id: string) => models.find((m) => m.id === id)!;

      const chat = byId('seed-2-0-lite-260228');
      expect(chat.capabilities).toEqual(
        expect.arrayContaining([
          'chat',
          'streaming',
          'vision',
          'video_understanding',
          'tool_use',
          'json_mode',
          'reasoning',
        ])
      );
      expect(chat.contextWindow).toBe(262144);
      expect(chat.maxOutputTokens).toBe(131072);

      expect(byId('seedream-4-0-250828').capabilities).toEqual(
        expect.arrayContaining(['image_generation', 'image_editing'])
      );
      expect(byId('dreamina-seedance-2-0-260128').capabilities).toEqual(
        expect.arrayContaining(['video_generation', 'video_editing'])
      );
      expect(byId('skylark-embedding-vision-251215').capabilities).toContain('embeddings');
      // An image-output model must NOT be advertised as chat-capable.
      expect(byId('seedream-4-0-250828').capabilities).not.toContain('chat');
    } finally {
      restore();
    }
  });

  it('emits pdf_understanding for image-in/text-out models so /v1/pdf/analyze can select them', async () => {
    // ci's PDFService searches on ['pdf_understanding','multimodal']. Without
    // the tag no byteplus model is EVER selectable for PDF, regardless of
    // whether the request would have worked.
    const restore = stubJson(listing);
    try {
      const models = await makeAdapter().getModels();
      const chat = models.find((m) => m.id === 'seed-2-0-lite-260228')!;
      expect(chat.capabilities).toEqual(
        expect.arrayContaining(['pdf_understanding', 'multimodal', 'image_captioning'])
      );
      // Not claimed for a model that cannot produce text.
      expect(models.find((m) => m.id === 'seedream-4-0-250828')!.capabilities).not.toContain(
        'pdf_understanding'
      );
    } finally {
      restore();
    }
  });

  it('derives long_context from token_limits and audio_input from modalities', async () => {
    const restore = stubJson(listing);
    try {
      const models = await makeAdapter().getModels();
      expect(models.find((m) => m.id === 'seed-2-0-lite-260228')!.capabilities).toContain(
        'long_context'
      );
      expect(models.find((m) => m.id === 'skylark-pro')!.capabilities).not.toContain(
        'long_context'
      );
      expect(
        models.find((m) => m.id === 'dreamina-seedance-2-0-260128')!.capabilities
      ).toContain('audio_input');
    } finally {
      restore();
    }
  });

  it('falls back to output_modalities when task_type is empty or unrecognised', async () => {
    // task_type is an OPEN, undocumented vocabulary observed on one live
    // probe. A model using a token minted later must not end up with zero
    // capabilities and become router-invisible.
    const restore = stubJson({
      object: 'list',
      data: [
        {
          id: 'future-image-model-270101',
          object: 'model',
          domain: 'ImageGeneration',
          task_type: ['SomeTokenInventedLater'],
          modalities: { input_modalities: ['text'], output_modalities: ['image'] },
        },
        {
          id: 'future-video-model-270101',
          object: 'model',
          task_type: [],
          modalities: { input_modalities: ['text'], output_modalities: ['video'] },
        },
      ],
    });
    try {
      const models = await makeAdapter().getModels();
      expect(models[0].capabilities).toContain('image_generation');
      expect(models[1].capabilities).toContain('video_generation');
    } finally {
      restore();
    }
  });

  it('fails soft (empty inventory, no throw) when discovery errors', async () => {
    const restore = stubJson({ error: { code: 'AuthenticationError' } }, { ok: false, status: 401 });
    try {
      await expect(makeAdapter().getModels()).resolves.toEqual([]);
    } finally {
      restore();
    }
  });
});

// ─── Chat request composition ────────────────────────────────────────────

describe('BytePlusModelArkAdapter — chatCompletion request shape', () => {
  it('POSTs /chat/completions and disables `thinking` by default (upstream default is ENABLED)', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hello!' }],
      });
      expect(calls[0].url).toBe(`${BASE}/chat/completions`);
      expect(calls[0].body.thinking).toEqual({ type: 'disabled' });
    } finally {
      restore();
    }
  });

  it('enables `thinking` only when the caller opts in via thinking_budget', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hello!' }],
        thinking_budget: 2048,
      });
      expect(calls[0].body.thinking).toEqual({ type: 'enabled' });
    } finally {
      restore();
    }
  });

  it('never sends max_completion_tokens alongside max_tokens (sending both is an immediate error)', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
      });
      expect(calls[0].body.max_tokens).toBe(100);
      expect(calls[0].body).not.toHaveProperty('max_completion_tokens');
    } finally {
      restore();
    }
  });

  it('switches to max_completion_tokens when reasoning is on — the only cap that bounds billed CoT', async () => {
    // max_tokens caps the ANSWER only. With thinking enabled it leaves
    // chain-of-thought tokens completely unbounded on a platform that bills
    // them, so the combined cap is used instead (they are mutually
    // exclusive, so it is one or the other).
    const restore = stubJson(chatFixture());
    try {
      const adapter = makeAdapter();
      await adapter.chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1000,
        thinking_budget: 4000,
      });
      expect(calls[0].body).not.toHaveProperty('max_tokens');
      expect(calls[0].body.max_completion_tokens).toBe(5000);

      // Clamped to the documented [1, 65536] range.
      calls = [];
      await adapter.chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 60_000,
        thinking_budget: 60_000,
      });
      expect(calls[0].body.max_completion_tokens).toBe(65_536);
    } finally {
      restore();
    }
  });

  it('forwards an explicit reasoning_effort only when thinking is enabled', async () => {
    const restore = stubJson(chatFixture());
    try {
      const adapter = makeAdapter();
      await adapter.chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
        thinking_budget: 1024,
        metadata: { reasoning_effort: 'high' },
      });
      expect(calls[0].body.reasoning_effort).toBe('high');

      // Not a member of the documented enum → dropped rather than 400'd.
      calls = [];
      await adapter.chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
        thinking_budget: 1024,
        metadata: { reasoning_effort: 'turbo' },
      });
      expect(calls[0].body).not.toHaveProperty('reasoning_effort');
    } finally {
      restore();
    }
  });

  it('omits top_p entirely when unset, so ModelArk’s own 0.7 default is not silently re-anchored', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(calls[0].body).not.toHaveProperty('top_p');
    } finally {
      restore();
    }
  });

  it('strips frequency/presence penalties for model families that reject them', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-1-8-251228',
        messages: [{ role: 'user', content: 'Hi' }],
        frequency_penalty: 0.5,
        presence_penalty: 0.5,
      });
      expect(calls[0].body).not.toHaveProperty('frequency_penalty');
      expect(calls[0].body).not.toHaveProperty('presence_penalty');
    } finally {
      restore();
    }
  });

  it('strips penalties on any request carrying a non-text part (visual requests reject them)', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'glm-4-7-251222',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
            ],
          },
        ],
        frequency_penalty: 0.5,
      });
      expect(calls[0].body).not.toHaveProperty('frequency_penalty');
    } finally {
      restore();
    }
  });

  it('keeps penalties for families that DO accept them', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'glm-4-7-251222',
        messages: [{ role: 'user', content: 'Hi' }],
        frequency_penalty: 0.5,
        presence_penalty: 0.25,
      });
      expect(calls[0].body.frequency_penalty).toBe(0.5);
      expect(calls[0].body.presence_penalty).toBe(0.25);
    } finally {
      restore();
    }
  });

  it('caps `stop` at 4 entries and normalises a bare string', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
        stop: ['a', 'b', 'c', 'd', 'e', 'f'],
      });
      expect(calls[0].body.stop).toEqual(['a', 'b', 'c', 'd']);

      calls = [];
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
        stop: 'END',
      });
      expect(calls[0].body.stop).toEqual(['END']);
    } finally {
      restore();
    }
  });

  it('sends tools[].type=function and tool_choice.type=function_call — the two fields have different evidence', async () => {
    // These are NOT the same discriminator and were wrongly coupled before.
    //  · tools[].type: the doc's field table says "function_call", but the
    //    tool-calling guide (doc 1449737) prints a complete working curl
    //    against /chat/completions whose tools[] entry is
    //    {"type":"function",…} — twice. A worked example outranks a field
    //    table, and it agrees with the response side and with ci's own Tool.
    //  · tool_choice.type: the doc says "set it to function_call" with NO
    //    counter-example anywhere. Sent as documented.
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      });
      const tools = calls[0].body.tools as Array<Record<string, unknown>>;
      expect(tools[0].type).toBe('function');
      expect(tools[0].function).toMatchObject({ name: 'get_weather', description: 'Get weather' });
      expect(calls[0].body.tool_choice).toEqual({
        type: 'function_call',
        function: { name: 'get_weather' },
      });
    } finally {
      restore();
    }
  });

  it('retries ONCE with the flipped tool discriminator on a tool-shaped 400, then pins the winner', async () => {
    // The one unsettleable request field gets a runtime fallback rather than
    // a coin flip: if the first shape is rejected, the other is tried once.
    const restore = stubSequence([
      {
        ok: false,
        status: 400,
        body: {
          error: {
            code: 'InvalidParameter',
            message: 'invalid value for tools[0].type',
            type: 'BadRequest',
          },
        },
      },
      { body: chatFixture() },
      { body: chatFixture() },
    ]);
    try {
      const adapter = makeAdapter();
      const tools = [
        {
          type: 'function' as const,
          function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
        },
      ];
      await adapter.chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'weather?' }],
        tools,
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      });
      expect(calls).toHaveLength(2);
      expect((calls[0].body.tools as Array<Record<string, unknown>>)[0].type).toBe('function');
      expect((calls[1].body.tools as Array<Record<string, unknown>>)[0].type).toBe('function_call');
      expect((calls[1].body.tool_choice as Record<string, unknown>).type).toBe('function');

      // The winner is remembered — the next call goes out flipped first time.
      calls = [];
      await adapter.chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'again?' }],
        tools,
      });
      expect(calls).toHaveLength(1);
      expect((calls[0].body.tools as Array<Record<string, unknown>>)[0].type).toBe('function_call');
    } finally {
      restore();
    }
  });

  it('does NOT flip the discriminator for a 400 unrelated to tools', async () => {
    const restore = stubSequence([
      {
        ok: false,
        status: 400,
        body: { error: { code: 'InvalidParameter', message: 'temperature out of range' } },
      },
      { body: chatFixture() },
    ]);
    try {
      await expect(
        makeAdapter().chatCompletion({
          model: 'seed-2-0-lite-260228',
          messages: [{ role: 'user', content: 'hi' }],
          temperature: 99,
        })
      ).rejects.toThrow(/temperature out of range/);
      expect(calls).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('pins reasoning_effort=minimal when disabling thinking on models whose default is higher', async () => {
    // Documented HARD ERROR: with thinking.type='disabled' only `minimal` is
    // accepted, and glm-5-2 defaults to `max`, dola-seed-2-1-turbo to `high`.
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'glm-5-2-260617',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(calls[0].body.thinking).toEqual({ type: 'disabled' });
      expect(calls[0].body.reasoning_effort).toBe('minimal');

      calls = [];
      await makeAdapter().chatCompletion({
        model: 'dola-seed-2-1-turbo-260628',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(calls[0].body.reasoning_effort).toBe('minimal');

      // Not sent to models with no documented non-minimal default — the
      // parameter is not documented as universally accepted.
      calls = [];
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(calls[0].body).not.toHaveProperty('reasoning_effort');
    } finally {
      restore();
    }
  });

  it('drops `stop` when the caller opted into reasoning (deep-reasoning models reject it)', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
        stop: ['END'],
        thinking_budget: 2048,
      });
      expect(calls[0].body.thinking).toEqual({ type: 'enabled' });
      expect(calls[0].body).not.toHaveProperty('stop');
    } finally {
      restore();
    }
  });

  it('forwards a documented service_tier from metadata and drops anything else', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
        metadata: { service_tier: 'fast' },
      });
      expect(calls[0].body.service_tier).toBe('fast');

      calls = [];
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
        // `scale` is a RESPONSE-only value and is never a valid request value.
        metadata: { service_tier: 'scale' },
      });
      expect(calls[0].body).not.toHaveProperty('service_tier');
    } finally {
      restore();
    }
  });

  it('translates ci PDFService’s data:application/pdf image_url part into ModelArk’s `file` part', async () => {
    // ci's PDFService ships a PDF as {type:'image_url', image_url:{url:
    // 'data:application/pdf;base64,…'}}. ModelArk's image_url accepts only
    // real image MIME types; a PDF must be {type:'file',file:{file_data,
    // filename}} with filename REQUIRED. Forwarding verbatim would 400 on
    // every /v1/pdf/analyze call routed here.
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260428',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'summarise this' },
              { type: 'image_url', image_url: { url: 'data:application/pdf;base64,JVBERi0x' } },
            ],
          },
        ],
      });
      const parts = (calls[0].body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
        .content;
      expect(parts[1]).toEqual({
        type: 'file',
        file: { file_data: 'data:application/pdf;base64,JVBERi0x', filename: 'document.pdf' },
      });
    } finally {
      restore();
    }
  });

  it('translates an http(s) .pdf image_url into a `file` part and leaves real images alone', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260428',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'https://example.com/docs/report.pdf' } },
              { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
            ],
          },
        ],
      });
      const parts = (calls[0].body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
        .content;
      expect(parts[0]).toEqual({
        type: 'file',
        file: { file_url: 'https://example.com/docs/report.pdf', filename: 'report.pdf' },
      });
      expect(parts[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/a.png' },
      });
    } finally {
      restore();
    }
  });

  it('passes unknown-but-typed content parts through verbatim (video/audio/file understanding)', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260428',
        messages: [
          narrowAs<never>({
            role: 'user',
            content: [
              { type: 'video_url', video_url: { url: 'https://example.com/a.mp4', fps: 2 } },
              { type: 'file', file: { file_id: 'file-20251018114827-6zgrb' } },
              { type: 'text', text: 'summarise' },
            ],
          }),
        ],
      });
      const messages = calls[0].body.messages as Array<{ content: Array<{ type: string }> }>;
      expect(messages[0].content.map((p) => p.type)).toEqual(['video_url', 'file', 'text']);
    } finally {
      restore();
    }
  });

  it('always sends an X-Client-Request-Id correlation header', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers['X-Client-Request-Id']).toMatch(/^ailin-\d+-[a-z0-9]+$/);
      expect(headers['Content-Type']).toBe('application/json');
    } finally {
      restore();
    }
  });

  it('rejects a request with no model rather than calling with an empty id', async () => {
    const restore = stubJson(chatFixture());
    try {
      await expect(
        makeAdapter().chatCompletion({ messages: [{ role: 'user', content: 'Hi' }] })
      ).rejects.toThrow(/requires a model id/);
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

// ─── Chat response parsing ───────────────────────────────────────────────

describe('BytePlusModelArkAdapter — chatCompletion response parsing', () => {
  it('maps the documented completion shape into ChatResponse', async () => {
    const restore = stubJson(chatFixture());
    try {
      const res = await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hello!' }],
      });
      expect(res.object).toBe('chat.completion');
      expect(res.model).toBe('seed-2-0-lite-260228');
      expect(res.choices[0].message?.content).toBe('Hello! How can I help you today?');
      expect(res.choices[0].finish_reason).toBe('stop');
      expect(res.usage).toEqual({ prompt_tokens: 19, completion_tokens: 9, total_tokens: 28 });
    } finally {
      restore();
    }
  });

  it('preserves reasoning_content and encrypted_content (a follow-up turn must echo the latter back)', async () => {
    const restore = stubJson(
      chatFixture({
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'answer',
              reasoning_content: 'step 1, step 2',
              encrypted_content: 'ENC-BLOB',
            },
          },
        ],
      })
    );
    try {
      const res = await makeAdapter().chatCompletion({
        model: 'seed-1-8-251228',
        messages: [{ role: 'user', content: 'Hi' }],
        thinking_budget: 1024,
      });
      const message = res.choices[0].message as unknown as Record<string, unknown>;
      expect(message.reasoning_content).toBe('step 1, step 2');
      expect(message.encrypted_content).toBe('ENC-BLOB');
    } finally {
      restore();
    }
  });

  it('preserves finish_reason=content_filter and moderation_hit_type instead of collapsing to stop', async () => {
    // ModelArk returns a content-filtered refusal as HTTP 200 with a
    // plausible assistant message; flattening it would make a refusal
    // indistinguishable from a real answer.
    const restore = stubJson(
      chatFixture({
        choices: [
          {
            index: 0,
            finish_reason: 'content_filter',
            moderation_hit_type: 'severe_violation',
            message: { role: 'assistant', content: "Let's talk about something else" },
          },
        ],
      })
    );
    try {
      const res = await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(res.choices[0].finish_reason).toBe('content_filter');
      expect((res.choices[0] as unknown as Record<string, unknown>).moderation_hit_type).toBe(
        'severe_violation'
      );
    } finally {
      restore();
    }
  });

  it('maps tool_calls through unchanged', async () => {
    const restore = stubJson(
      chatFixture({
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
                },
              ],
            },
          },
        ],
      })
    );
    try {
      const res = await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'weather?' }],
      });
      expect(res.choices[0].finish_reason).toBe('tool_calls');
      expect(res.choices[0].message?.tool_calls?.[0].function.name).toBe('get_weather');
    } finally {
      restore();
    }
  });

  it('maps an unrecognised finish_reason to null rather than inventing one', async () => {
    const restore = stubJson(
      chatFixture({
        choices: [{ index: 0, finish_reason: 'something_new', message: { role: 'assistant', content: 'x' } }],
      })
    );
    try {
      const res = await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(res.choices[0].finish_reason).toBeNull();
    } finally {
      restore();
    }
  });
});

// ─── Streaming ───────────────────────────────────────────────────────────

describe('BytePlusModelArkAdapter — chatCompletionStream', () => {
  function stubSse(frames: string[]) {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        init: init ?? {},
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
      });
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      });
      return { ok: true, status: 200, body: stream, headers: new Headers() } as unknown as Response;
    }) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it('sets stream + stream_options.include_usage and parses SSE frames until [DONE]', async () => {
    const restore = stubSse([
      'data: {"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n',
      'data: {"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}\n',
      'data: [DONE]\n',
      'data: {"id":"IGNORED-AFTER-DONE"}\n',
    ]);
    try {
      const chunks = [];
      for await (const chunk of makeAdapter().chatCompletionStream({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }
      expect(calls[0].body.stream).toBe(true);
      expect(calls[0].body.stream_options).toEqual({ include_usage: true });
      expect(chunks).toHaveLength(2);
      expect(chunks[0].object).toBe('chat.completion.chunk');
      expect(chunks.map((c) => c.choices[0].delta?.content).join('')).toBe('Hello');
      expect(chunks[1].choices[0].finish_reason).toBe('stop');
    } finally {
      restore();
    }
  });

  it('does NOT drop the chunk carrying only encrypted_content (empty content + empty reasoning)', async () => {
    // Regression guard for the classic `if (!delta.content) continue` bug:
    // ModelArk delivers encrypted_content in a chunk where both content and
    // reasoning_content are empty strings, and a follow-up turn needs it.
    const restore = stubSse([
      'data: {"id":"1","model":"m","choices":[{"index":0,"delta":{"content":"","reasoning_content":"","encrypted_content":"ENC"}}]}\n',
      'data: [DONE]\n',
    ]);
    try {
      const chunks = [];
      for await (const chunk of makeAdapter().chatCompletionStream({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(1);
      expect(
        (chunks[0].choices[0].delta as unknown as Record<string, unknown>).encrypted_content
      ).toBe('ENC');
    } finally {
      restore();
    }
  });

  it('tolerates a frame split across chunk boundaries and skips unparseable frames', async () => {
    const restore = stubSse([
      'data: {"id":"1","model":"m","choices":[{"index":0,"delta":',
      '{"content":"ok"}}]}\ndata: {not json}\n',
      'data: [DONE]\n',
    ]);
    try {
      const chunks = [];
      for await (const chunk of makeAdapter().chatCompletionStream({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(1);
      expect(chunks[0].choices[0].delta?.content).toBe('ok');
    } finally {
      restore();
    }
  });

  it('surfaces an HTTP error before any chunk is yielded', async () => {
    const restore = stubJson(
      { error: { code: 'ModelNotOpen', message: 'not activated' } },
      { ok: false, status: 404 }
    );
    try {
      const iterate = async () => {
        for await (const _ of makeAdapter().chatCompletionStream({
          model: 'seed-2-0-lite-260228',
          messages: [{ role: 'user', content: 'Hi' }],
        })) {
          /* no chunk expected */
        }
      };
      await expect(iterate()).rejects.toThrow(/ModelNotOpen/);
    } finally {
      restore();
    }
  });
});

// ─── Vision ──────────────────────────────────────────────────────────────

describe('BytePlusModelArkAdapter — vision', () => {
  it('forwards ModelArk’s non-OpenAI `xhigh` detail instead of coercing it to auto', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().vision(model('seed-2-0-pro-260328'), {
        prompt: 'describe',
        image: 'https://example.com/a.png',
        options: { detail: 'xhigh' },
      });
      const messages = calls[0].body.messages as Array<{
        content: Array<{ type: string; image_url?: { url: string; detail?: string } }>;
      }>;
      const part = messages[0].content.find((p) => p.type === 'image_url');
      expect(part?.image_url?.detail).toBe('xhigh');
      expect(part?.image_url?.url).toBe('https://example.com/a.png');
    } finally {
      restore();
    }
  });

  it('SNIFFS the real image format for the data URI instead of hardcoding png', async () => {
    // ModelArk requires data:image/<format> to match the real payload and
    // accepts jpeg/png/webp/bmp/tiff/gif/heic/heif. The base class hardcodes
    // png, which mislabels every non-PNG upload.
    const restore = stubJson(chatFixture());
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    try {
      await makeAdapter().vision(model('seed-2-0-pro-260328'), {
        prompt: 'describe',
        image: pngBytes,
        options: { image_pixel_limit: { max_pixels: 3014080, min_pixels: 3136 } },
      });
      const messages = calls[0].body.messages as Array<{
        content: Array<{ type: string; image_url?: Record<string, unknown> }>;
      }>;
      const part = messages[0].content.find((p) => p.type === 'image_url');
      expect(String(part?.image_url?.url)).toMatch(/^data:image\/png;base64,/);
      expect(part?.image_url?.image_pixel_limit).toEqual({ max_pixels: 3014080, min_pixels: 3136 });
    } finally {
      restore();
    }
  });

  it('labels a JPEG buffer as jpeg and a WebP buffer as webp', async () => {
    const restore = stubJson(chatFixture());
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP', 'ascii'),
      Buffer.alloc(8),
    ]);
    const sentImageUrl = (): string => {
      const messages = calls[0].body.messages as Array<{
        content: Array<{ type: string; image_url?: { url?: string } }>;
      }>;
      return messages[0].content.find((p) => p.type === 'image_url')?.image_url?.url ?? '';
    };
    try {
      const adapter = makeAdapter();
      await adapter.vision(model('seed-2-0-pro-260328'), { prompt: 'x', image: jpeg });
      expect(sentImageUrl()).toMatch(/^data:image\/jpeg;base64,/);

      calls = [];
      await adapter.vision(model('seed-2-0-pro-260328'), { prompt: 'x', image: webp });
      expect(sentImageUrl()).toMatch(/^data:image\/webp;base64,/);
    } finally {
      restore();
    }
  });

  it('returns the assistant text as VisionResponse.content', async () => {
    const restore = stubJson(chatFixture());
    try {
      const res = await makeAdapter().vision(model('seed-2-0-pro-260328'), {
        prompt: 'describe',
        image: 'https://example.com/a.png',
      });
      expect(res.content).toBe('Hello! How can I help you today?');
    } finally {
      restore();
    }
  });
});

// ─── Embeddings ──────────────────────────────────────────────────────────

describe('BytePlusModelArkAdapter — generateEmbeddings', () => {
  const embeddingFixture = {
    created: 1752133360,
    id: '021752133359863906427fb4b36437c414d645f52206dfc398f85',
    model: 'skylark-embedding-vision-251215',
    object: 'list',
    // NB: `data` is a single OBJECT, not an array.
    data: { embedding: [-0.046875, 0.125, 0.5], object: 'embedding' },
    usage: { prompt_tokens: 25, total_tokens: 25 },
  };

  it('targets /embeddings/multimodal with typed input parts, not bare strings', async () => {
    const restore = stubJson(embeddingFixture);
    try {
      await makeAdapter().generateEmbeddings({
        model: 'skylark-embedding-vision-251215',
        input: 'The sky is blue',
      });
      expect(calls[0].url).toBe(`${BASE}/embeddings/multimodal`);
      expect(calls[0].body.input).toEqual([{ type: 'text', text: 'The sky is blue' }]);
      expect(calls[0].body.encoding_format).toBe('float');
    } finally {
      restore();
    }
  });

  it('reads the object-shaped `data.embedding` (resp.data[0] would break)', async () => {
    const restore = stubJson(embeddingFixture);
    try {
      const res = await makeAdapter().generateEmbeddings({
        model: 'skylark-embedding-vision-251215',
        input: 'The sky is blue',
      });
      expect(res.object).toBe('list');
      expect(res.data).toHaveLength(1);
      expect(res.data[0].embedding).toEqual([-0.046875, 0.125, 0.5]);
      expect(res.data[0].index).toBe(0);
      expect(res.usage.total_tokens).toBe(25);
    } finally {
      restore();
    }
  });

  it('also tolerates the array-shaped `data` (the vendor docs contradict themselves)', async () => {
    const restore = stubJson({ ...embeddingFixture, data: [{ embedding: [1, 2, 3] }] });
    try {
      const res = await makeAdapter().generateEmbeddings({
        model: 'skylark-embedding-vision-251215',
        input: 'x',
      });
      expect(res.data[0].embedding).toEqual([1, 2, 3]);
    } finally {
      restore();
    }
  });

  it('fans out N inputs into N requests (one vector per request upstream) and keeps order', async () => {
    const restore = stubSequence([
      { body: { ...embeddingFixture, data: { embedding: [1] } } },
      { body: { ...embeddingFixture, data: { embedding: [2] } } },
      { body: { ...embeddingFixture, data: { embedding: [3] } } },
    ]);
    try {
      const res = await makeAdapter().generateEmbeddings({
        model: 'skylark-embedding-vision-251215',
        input: ['a', 'b', 'c'],
      });
      expect(calls).toHaveLength(3);
      expect(res.data.map((d) => d.index)).toEqual([0, 1, 2]);
      // Sum of per-request usage, not just the first response's.
      expect(res.usage.total_tokens).toBe(75);
    } finally {
      restore();
    }
  });

  it('gates `dimensions` on the documented 250615 VERSION THRESHOLD, not a single-build blacklist', async () => {
    // Docs: supported by "skylark-embedding-vision-250615 and subsequent
    // versions". A `-250328` blacklist would happily send it to any OTHER
    // pre-250615 build and get rejected.
    const restore = stubJson(embeddingFixture);
    try {
      const adapter = makeAdapter();
      for (const model of ['skylark-embedding-vision-251215', 'skylark-embedding-vision-250615']) {
        calls = [];
        await adapter.generateEmbeddings({ model, input: 'x', dimensions: 1024 });
        expect(calls[0].body.dimensions).toBe(1024);
      }
      for (const model of [
        'skylark-embedding-vision-250328',
        'skylark-embedding-vision-241215',
        'skylark-embedding-vision-250614',
      ]) {
        calls = [];
        await adapter.generateEmbeddings({ model, input: 'x', dimensions: 1024 });
        expect(calls[0].body).not.toHaveProperty('dimensions');
      }
      // An unversioned family alias resolves SERVER-side to the current
      // preset (live-observed), so the parameter is not withheld from it.
      calls = [];
      await adapter.generateEmbeddings({
        model: 'skylark-embedding-vision',
        input: 'x',
        dimensions: 1024,
      });
      expect(calls[0].body.dimensions).toBe(1024);
    } finally {
      restore();
    }
  });

  it('forwards `instructions` when supplied (and only to 251215+) but never fabricates one', async () => {
    // The docs insist the default degrades quality — and equally, the
    // adapter cannot know a good instruction for an arbitrary corpus, so
    // inventing one would silently change every vector ci stores.
    const restore = stubJson(embeddingFixture);
    try {
      const adapter = makeAdapter();
      await adapter.generateEmbeddings({
        model: 'skylark-embedding-vision-251215',
        input: 'x',
        options: { instructions: 'Target_modality: text.\nInstruction:Compress.\nQuery:' },
      });
      expect(calls[0].body.instructions).toBe(
        'Target_modality: text.\nInstruction:Compress.\nQuery:'
      );

      calls = [];
      await adapter.generateEmbeddings({ model: 'skylark-embedding-vision-251215', input: 'x' });
      expect(calls[0].body).not.toHaveProperty('instructions');

      // instructions landed in 251215; older builds reject it.
      calls = [];
      await adapter.generateEmbeddings({
        model: 'skylark-embedding-vision-250615',
        input: 'x',
        options: { instructions: 'anything' },
      });
      expect(calls[0].body).not.toHaveProperty('instructions');
    } finally {
      restore();
    }
  });

  it('honours encoding_format and the opt-in sparse_embedding switch', async () => {
    const restore = stubJson(embeddingFixture);
    try {
      const adapter = makeAdapter();
      await adapter.generateEmbeddings({
        model: 'skylark-embedding-vision-251215',
        input: 'x',
        encoding_format: 'base64',
        options: { sparse_embedding: true },
      });
      expect(calls[0].body.encoding_format).toBe('base64');
      expect(calls[0].body.sparse_embedding).toEqual({ type: 'enabled' });

      calls = [];
      await adapter.generateEmbeddings({ model: 'skylark-embedding-vision-251215', input: 'x' });
      expect(calls[0].body.encoding_format).toBe('float');
      expect(calls[0].body).not.toHaveProperty('sparse_embedding');
    } finally {
      restore();
    }
  });

  it('emits image_url/video_url input parts for media inputs — the whole point of the vision family', async () => {
    // /embeddings/multimodal accepts {type:'image_url'|'video_url'} parts.
    // ci's EmbeddingRequest.input is string|string[], so the media form is
    // read off the caller's own data rather than invented.
    const restore = stubJson(embeddingFixture);
    try {
      await makeAdapter().generateEmbeddings({
        model: 'skylark-embedding-vision-251215',
        input: [
          'The sky is blue',
          'https://example.com/a.jpg',
          'https://example.com/clip.mp4',
          'data:image/png;base64,iVBOR',
          'https://example.com/page.html',
        ],
      });
      expect(calls.map((c) => (c.body.input as Array<{ type: string }>)[0].type)).toEqual([
        'text',
        'image_url',
        'video_url',
        'image_url',
        'text',
      ]);
    } finally {
      restore();
    }
  });

  it('lets a caller force URL-as-text with options.input_type', async () => {
    const restore = stubJson(embeddingFixture);
    try {
      await makeAdapter().generateEmbeddings({
        model: 'skylark-embedding-vision-251215',
        input: 'https://example.com/a.jpg',
        options: { input_type: 'text' },
      });
      expect(calls[0].body.input).toEqual([
        { type: 'text', text: 'https://example.com/a.jpg' },
      ]);
    } finally {
      restore();
    }
  });

  it('throws rather than returning an empty vector when the response has none', async () => {
    const restore = stubJson({ ...embeddingFixture, data: {} });
    try {
      await expect(
        makeAdapter().generateEmbeddings({ model: 'skylark-embedding-vision-251215', input: 'x' })
      ).rejects.toThrow(/no vector/);
    } finally {
      restore();
    }
  });
});

// ─── Image generation & editing ──────────────────────────────────────────

describe('BytePlusModelArkAdapter — imageGenerate', () => {
  const imageFixture = {
    model: 'seedream-4-0-250828',
    created: 1589478378,
    data: [{ b64_json: Buffer.from('img-bytes').toString('base64'), size: '2048x2048' }],
    usage: { generated_images: 1, output_tokens: 16280, total_tokens: 16280 },
  };

  it('defaults watermark to FALSE (upstream default is TRUE) and size to the 2K tier token', async () => {
    const restore = stubJson(imageFixture);
    try {
      await makeAdapter().imageGenerate(model('seedream-4-0-250828'), { prompt: 'a red cube' });
      expect(calls[0].url).toBe(`${BASE}/images/generations`);
      expect(calls[0].body.watermark).toBe(false);
      // "1024x1024" is BELOW the total-pixel floor for seedream-4-5 /
      // seedream-5-0-lite and would be rejected; "2K" is universally valid.
      expect(calls[0].body.size).toBe('2K');
      expect(calls[0].body.response_format).toBe('b64_json');
    } finally {
      restore();
    }
  });

  it('honours an explicit watermark opt-in and explicit WIDTHxHEIGHT size', async () => {
    const restore = stubJson(imageFixture);
    try {
      await makeAdapter().imageGenerate(model('seedream-4-0-250828'), {
        prompt: 'a red cube',
        size: '2048x2048',
        options: { watermark: true },
      });
      expect(calls[0].body.watermark).toBe(true);
      expect(calls[0].body.size).toBe('2048x2048');
    } finally {
      restore();
    }
  });

  it('maps n>1 to sequential_image_generation (there is no `n` parameter on this API)', async () => {
    const restore = stubJson(imageFixture);
    try {
      await makeAdapter().imageGenerate(model('seedream-4-0-250828'), {
        prompt: 'x',
        options: { n: 4 },
      });
      expect(calls[0].body).not.toHaveProperty('n');
      expect(calls[0].body.sequential_image_generation).toBe('auto');
      expect(calls[0].body.sequential_image_generation_options).toEqual({ max_images: 4 });
    } finally {
      restore();
    }
  });

  it('omits the sequential fields for dola-seedream-5-0-pro-260628, which ERRORS on them', async () => {
    const restore = stubJson(imageFixture);
    try {
      await makeAdapter().imageGenerate(model('dola-seedream-5-0-pro-260628'), {
        prompt: 'x',
        options: { n: 4 },
      });
      expect(calls[0].body).not.toHaveProperty('sequential_image_generation');
      expect(calls[0].body).not.toHaveProperty('sequential_image_generation_options');
    } finally {
      restore();
    }
  });

  it('decodes b64_json into a Buffer and reports the API-default jpeg, not png', async () => {
    // ModelArk's `output_format` request DEFAULT is jpeg, and only
    // seedream-5-0-pro echoes the field back. seedream-4-5/4-0 are JPEG-ONLY.
    // Defaulting this to 'png' handed every caller a mislabelled buffer —
    // wrong file extension, wrong Content-Type, wrong decoder.
    const restore = stubJson(imageFixture);
    try {
      const res = await makeAdapter().imageGenerate(model('seedream-4-0-250828'), { prompt: 'x' });
      expect(res.image.toString()).toBe('img-bytes');
      expect(res.format).toBe('jpeg');
    } finally {
      restore();
    }
  });

  it('echoes the format the model reported, then the format the caller requested', async () => {
    const echoed = stubJson({
      ...imageFixture,
      data: [{ ...imageFixture.data[0], output_format: 'png' }],
    });
    try {
      const res = await makeAdapter().imageGenerate(model('dola-seedream-5-0-pro-260628'), {
        prompt: 'x',
      });
      expect(res.format).toBe('png');
    } finally {
      echoed();
    }

    // No echo (every model but 5-0-pro) but the caller asked for png — the
    // request was accepted, so png is what the bytes are.
    calls = [];
    const silent = stubJson(imageFixture);
    try {
      const res = await makeAdapter().imageGenerate(model('seedream-5-0-lite-260128'), {
        prompt: 'x',
        options: { output_format: 'png' },
      });
      expect(calls[0].body.output_format).toBe('png');
      expect(res.format).toBe('png');
    } finally {
      silent();
    }
  });

  it('does not force the 2K tier token onto seedream-3-0-t2i, which has no tier tokens', async () => {
    const restore = stubJson(imageFixture);
    try {
      const adapter = makeAdapter();
      await adapter.imageGenerate(model('seedream-3-0-t2i-250415'), { prompt: 'x' });
      // Its documented default is 1024x1024 from a pixel RANGE; sending a
      // tier token it does not define would be rejected.
      expect(calls[0].body).not.toHaveProperty('size');

      calls = [];
      await adapter.imageGenerate(model('seedream-3-0-t2i-250415'), {
        prompt: 'x',
        size: '1024x1024',
      });
      expect(calls[0].body.size).toBe('1024x1024');
    } finally {
      restore();
    }
  });

  it('throws on an INLINE per-item error that arrives with HTTP 200', async () => {
    // Partial failure on this API is inline, not an HTTP error — assuming
    // data[0] is an image without checking data[0].error is a real hazard.
    const restore = stubJson({
      model: 'seedream-4-0-250828',
      created: 1,
      data: [
        {
          error: {
            code: 'OutputImageSensitiveContentDetected',
            message: 'The request failed because the output image may contain sensitive information.',
          },
        },
      ],
    });
    try {
      await expect(
        makeAdapter().imageGenerate(model('seedream-4-0-250828'), { prompt: 'x' })
      ).rejects.toThrow(/OutputImageSensitiveContentDetected/);
    } finally {
      restore();
    }
  });

  it('throws on a top-level error object returned with HTTP 200', async () => {
    const restore = stubJson({ error: { code: 'InternalServiceError', message: 'boom' } });
    try {
      await expect(
        makeAdapter().imageGenerate(model('seedream-4-0-250828'), { prompt: 'x' })
      ).rejects.toThrow(/InternalServiceError/);
    } finally {
      restore();
    }
  });
});

describe('BytePlusModelArkAdapter — imageEdit', () => {
  const imageFixture = {
    model: 'seedream-4-0-250828',
    created: 1,
    data: [{ b64_json: Buffer.from('edited').toString('base64') }],
  };

  it('POSTs JSON to /images/generations with an `image` field — NOT multipart to /images/edits', async () => {
    // /images/edits does not exist on ModelArk (live-verified as an
    // absent route), so a generic multipart implementation would post
    // into a void.
    const restore = stubJson(imageFixture);
    try {
      const res = await makeAdapter().imageEdit(model('seedream-4-0-250828'), {
        image: Buffer.from('original'),
        prompt: 'make it blue',
      });
      expect(calls[0].url).toBe(`${BASE}/images/generations`);
      expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json'
      );
      // Format SNIFFED from the bytes — 'original' is not a PNG, and the
      // data URI must declare what the payload really is.
      expect(String(calls[0].body.image)).toMatch(/^data:image\/jpeg;base64,/);
      expect(calls[0].body.prompt).toBe('make it blue');
      expect(res.image.toString()).toBe('edited');
    } finally {
      restore();
    }
  });

  it('labels the uploaded buffer with its REAL format, not a hardcoded png', async () => {
    const restore = stubJson(imageFixture);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP', 'ascii'),
      Buffer.alloc(8),
    ]);
    try {
      const adapter = makeAdapter();
      await adapter.imageEdit(model('seedream-4-0-250828'), { image: png, prompt: 'p' });
      expect(String(calls[0].body.image)).toMatch(/^data:image\/png;base64,/);

      calls = [];
      await adapter.imageEdit(model('seedream-4-0-250828'), { image: webp, prompt: 'p' });
      expect(String(calls[0].body.image)).toMatch(/^data:image\/webp;base64,/);

      // An explicit options.input_format wins over the sniff.
      calls = [];
      await adapter.imageEdit(model('seedream-4-0-250828'), {
        image: webp,
        prompt: 'p',
        options: { input_format: 'gif' },
      });
      expect(String(calls[0].body.image)).toMatch(/^data:image\/gif;base64,/);
    } finally {
      restore();
    }
  });

  it('sends MULTI-REFERENCE images as an `image` ARRAY (up to 10–14 refs upstream)', async () => {
    const restore = stubJson(imageFixture);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
    try {
      await makeAdapter().imageEdit(model('seedream-4-0-250828'), {
        image: jpeg,
        prompt: 'combine these',
        options: { images: ['https://example.com/ref1.png', jpeg] },
      });
      const images = calls[0].body.image as string[];
      expect(Array.isArray(images)).toBe(true);
      expect(images).toHaveLength(3);
      expect(images[0]).toMatch(/^data:image\/jpeg;base64,/);
      expect(images[1]).toBe('https://example.com/ref1.png');
      expect(images[2]).toMatch(/^data:image\/jpeg;base64,/);
    } finally {
      restore();
    }
  });

  it('REFUSES seedream-3-0-t2i, which rejects the `image` parameter outright', async () => {
    const restore = stubJson(imageFixture);
    try {
      await expect(
        makeAdapter().imageEdit(model('seedream-3-0-t2i-250415'), {
          image: Buffer.from('original'),
          prompt: 'make it blue',
        })
      ).rejects.toThrow(/text-to-image only/);
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('THROWS when a mask is supplied instead of silently editing the whole image', async () => {
    const restore = stubJson(imageFixture);
    try {
      await expect(
        makeAdapter().imageEdit(model('seedream-4-0-250828'), {
          image: Buffer.from('original'),
          mask: Buffer.from('mask'),
          prompt: 'make it blue',
        })
      ).rejects.toThrow(/does not support `mask`/);
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

// ─── Video generation (submit → poll) ────────────────────────────────────

describe('BytePlusModelArkAdapter — videoGenerate', () => {
  // Collapse the real 3s→30s poll cadence so these tests don't spend ~20s
  // asleep. Exercises the same code path; only the interval differs.
  const pollEnv = {
    BYTEPLUS_VIDEO_POLL_INTERVAL_MS: process.env.BYTEPLUS_VIDEO_POLL_INTERVAL_MS,
    BYTEPLUS_VIDEO_POLL_MAX_INTERVAL_MS: process.env.BYTEPLUS_VIDEO_POLL_MAX_INTERVAL_MS,
  };
  beforeEach(() => {
    process.env.BYTEPLUS_VIDEO_POLL_INTERVAL_MS = '1';
    process.env.BYTEPLUS_VIDEO_POLL_MAX_INTERVAL_MS = '2';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(pollEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('submits content parts with roles, polls, and reads content.video_url', async () => {
    const restore = stubSequence([
      // Submit response is EXACTLY {id} — no `status` field at all.
      { body: { id: 'cgt-20260802-abcde' } },
      { body: { id: 'cgt-20260802-abcde', status: 'running' } },
      {
        body: {
          id: 'cgt-20260802-abcde',
          status: 'succeeded',
          model: 'dreamina-seedance-2-0-260128',
          content: { video_url: 'https://tos.example.com/out.mp4' },
          usage: { completion_tokens: 108900, total_tokens: 108900 },
          framespersecond: 24,
        },
      },
    ]);
    try {
      const res = await makeAdapter().videoGenerate(model('dreamina-seedance-2-0-260128'), {
        prompt: 'a girl holding a fox',
        startImage: 'https://example.com/first.png',
        endImage: 'https://example.com/last.png',
        duration: 5,
        aspectRatio: '16:9',
        options: { resolution: '720p', generate_audio: true },
      });

      expect(calls[0].url).toBe(`${BASE}/contents/generations/tasks`);
      expect(calls[0].init.method).toBe('POST');
      const content = calls[0].body.content as Array<Record<string, unknown>>;
      expect(content.map((c) => c.type)).toEqual(['text', 'image_url', 'image_url']);
      expect(content[1].role).toBe('first_frame');
      expect(content[2].role).toBe('last_frame');
      expect(calls[0].body.ratio).toBe('16:9');
      expect(calls[0].body.resolution).toBe('720p');
      expect(calls[0].body.duration).toBe(5);
      expect(calls[0].body.generate_audio).toBe(true);

      // Poll GETs the templated per-task path, not a static listing route.
      expect(calls[1].url).toBe(`${BASE}/contents/generations/tasks/cgt-20260802-abcde`);
      expect(calls[1].init.method).toBe('GET');

      expect(res.video).toEqual([{ id: 'cgt-20260802-abcde', url: 'https://tos.example.com/out.mp4' }]);
      expect(res.format).toBe('mp4');
    } finally {
      restore();
    }
  });

  it('does NOT retry the submit (it enqueues a billed async job)', async () => {
    // A retried submit after an ambiguous failure can start 2+ billed
    // generations, so the submit deliberately bypasses withRetry.
    const restore = stubJson(
      { error: { code: 'InternalServiceError', message: 'boom' } },
      { ok: false, status: 500 }
    );
    try {
      await expect(
        makeAdapter().videoGenerate(model('dreamina-seedance-2-0-260128'), { prompt: 'x' })
      ).rejects.toThrow(/InternalServiceError/);
      expect(calls).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('treats `failed` as terminal and surfaces error.code/message', async () => {
    const restore = stubSequence([
      { body: { id: 'cgt-1' } },
      { body: { id: 'cgt-1', status: 'failed', error: { code: 'ContentFilter', message: 'blocked' } } },
    ]);
    try {
      await expect(
        makeAdapter().videoGenerate(model('dreamina-seedance-2-0-260128'), { prompt: 'x' })
      ).rejects.toThrow(/ended 'failed'.*ContentFilter.*blocked/s);
    } finally {
      restore();
    }
  });

  it('treats `expired` and `cancelled` as terminal FAILURES, not silent successes', async () => {
    for (const status of ['expired', 'cancelled']) {
      calls = [];
      const restore = stubSequence([{ body: { id: 'cgt-1' } }, { body: { id: 'cgt-1', status } }]);
      try {
        await expect(
          makeAdapter().videoGenerate(model('dreamina-seedance-2-0-260128'), { prompt: 'x' })
        ).rejects.toThrow(new RegExp(`ended '${status}'`));
      } finally {
        restore();
      }
    }
  });

  it('throws when the submit response carries no id', async () => {
    const restore = stubJson({ ok: true });
    try {
      await expect(
        makeAdapter().videoGenerate(model('dreamina-seedance-2-0-260128'), { prompt: 'x' })
      ).rejects.toThrow(/no task id/);
    } finally {
      restore();
    }
  });

  it('rejects a free-form aspectRatio rather than forwarding it into the closed `ratio` enum', async () => {
    const restore = stubSequence([
      { body: { id: 'cgt-1' } },
      { body: { id: 'cgt-1', status: 'succeeded', content: { video_url: 'https://x/o.mp4' } } },
    ]);
    try {
      await makeAdapter().videoGenerate(model('dreamina-seedance-2-0-260128'), {
        prompt: 'x',
        aspectRatio: '1920:1080',
      });
      expect(calls[0].body).not.toHaveProperty('ratio');
    } finally {
      restore();
    }
  });

  it('requires a prompt or at least one media input', async () => {
    const restore = stubJson({ id: 'cgt-1' });
    try {
      await expect(
        makeAdapter().videoGenerate(model('dreamina-seedance-2-0-260128'), { prompt: '' })
      ).rejects.toThrow(/requires a prompt or at least one media input/);
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('forwards the documented Seedance params: priority, draft, execution_expires_after, safety_identifier', async () => {
    const restore = stubSequence([
      { body: { id: 'cgt-1' } },
      { body: { id: 'cgt-1', status: 'succeeded', content: { video_url: 'https://x/o.mp4' } } },
    ]);
    try {
      await makeAdapter().videoGenerate(model('dreamina-seedance-2-0-260128'), {
        prompt: 'x',
        options: {
          priority: 7,
          draft: true,
          execution_expires_after: 7200,
          safety_identifier: 'org-42',
          reference_images: ['https://example.com/ref.png'],
          draft_task_id: 'cgt-2026-pzjqb',
        },
      });
      expect(calls[0].body.priority).toBe(7);
      expect(calls[0].body.draft).toBe(true);
      expect(calls[0].body.execution_expires_after).toBe(7200);
      expect(calls[0].body.safety_identifier).toBe('org-42');
      const content = calls[0].body.content as Array<Record<string, unknown>>;
      expect(content).toContainEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/ref.png' },
        role: 'reference_image',
      });
      expect(content).toContainEqual({
        type: 'draft_task',
        draft_task: { id: 'cgt-2026-pzjqb' },
      });
    } finally {
      restore();
    }
  });

  it('drops `priority` when service_tier is flex (documented mutual exclusion) and out-of-range values', async () => {
    const restore = stubSequence([
      { body: { id: 'cgt-1' } },
      { body: { id: 'cgt-1', status: 'succeeded', content: { video_url: 'https://x/o.mp4' } } },
      { body: { id: 'cgt-2' } },
      { body: { id: 'cgt-2', status: 'succeeded', content: { video_url: 'https://x/o.mp4' } } },
    ]);
    try {
      const adapter = makeAdapter();
      await adapter.videoGenerate(model('dreamina-seedance-2-0-260128'), {
        prompt: 'x',
        options: { priority: 5, service_tier: 'flex' },
      });
      expect(calls[0].body).not.toHaveProperty('priority');
      expect(calls[0].body.service_tier).toBe('flex');

      calls = [];
      await adapter.videoGenerate(model('dreamina-seedance-2-0-260128'), {
        prompt: 'x',
        options: { priority: 42, execution_expires_after: 60 },
      });
      expect(calls[0].body).not.toHaveProperty('priority');
      expect(calls[0].body).not.toHaveProperty('execution_expires_after');
    } finally {
      restore();
    }
  });

  it('sends `frames` INSTEAD of duration (frames takes precedence upstream) and validates the 25+4n lattice', async () => {
    const restore = stubSequence([
      { body: { id: 'cgt-1' } },
      { body: { id: 'cgt-1', status: 'succeeded', content: { video_url: 'https://x/o.mp4' } } },
      { body: { id: 'cgt-2' } },
      { body: { id: 'cgt-2', status: 'succeeded', content: { video_url: 'https://x/o.mp4' } } },
    ]);
    try {
      const adapter = makeAdapter();
      await adapter.videoGenerate(model('seedance-1-0-pro-250528'), {
        prompt: 'x',
        duration: 5,
        options: { frames: 121 },
      });
      expect(calls[0].body.frames).toBe(121);
      expect(calls[0].body).not.toHaveProperty('duration');

      // 120 is not on the 25+4n lattice — fall back to duration rather than
      // send a value the strictly-validated body will reject.
      calls = [];
      await adapter.videoGenerate(model('seedance-1-0-pro-250528'), {
        prompt: 'x',
        duration: 5,
        options: { frames: 120 },
      });
      expect(calls[0].body).not.toHaveProperty('frames');
      expect(calls[0].body.duration).toBe(5);
    } finally {
      restore();
    }
  });

  it('surfaces content.last_frame_url as a second asset instead of burying it in raw', async () => {
    const restore = stubSequence([
      { body: { id: 'cgt-1' } },
      {
        body: {
          id: 'cgt-1',
          status: 'succeeded',
          content: { video_url: 'https://x/o.mp4', last_frame_url: 'https://x/last.png' },
        },
      },
    ]);
    try {
      const res = await makeAdapter().videoGenerate(model('dreamina-seedance-2-0-260128'), {
        prompt: 'x',
        options: { return_last_frame: true },
      });
      expect(res.video).toEqual([
        { id: 'cgt-1', url: 'https://x/o.mp4' },
        { id: 'cgt-1:last_frame', url: 'https://x/last.png' },
      ]);
    } finally {
      restore();
    }
  });
});

// ─── 3D generation (same route as video, result at content.file_url) ──────

describe('BytePlusModelArkAdapter — generateAsset3D', () => {
  const savedPollEnv = {
    BYTEPLUS_VIDEO_POLL_INTERVAL_MS: process.env.BYTEPLUS_VIDEO_POLL_INTERVAL_MS,
    BYTEPLUS_VIDEO_POLL_MAX_INTERVAL_MS: process.env.BYTEPLUS_VIDEO_POLL_MAX_INTERVAL_MS,
  };
  beforeEach(() => {
    process.env.BYTEPLUS_VIDEO_POLL_INTERVAL_MS = '1';
    process.env.BYTEPLUS_VIDEO_POLL_MAX_INTERVAL_MS = '2';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedPollEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('drives the SAME /contents/generations/tasks route and reads content.file_url', async () => {
    const restore = stubSequence([
      { body: { id: 'cgt-3d-1' } },
      {
        body: {
          id: 'cgt-3d-1',
          status: 'succeeded',
          content: { file_url: 'https://x/asset.glb' },
        },
      },
    ]);
    try {
      const res = await makeAdapter().generateAsset3D(model('seed3d-1-0-250928'), {
        prompt: 'a ceramic mug',
      });
      expect(calls[0].url).toBe(`${BASE}/contents/generations/tasks`);
      expect(res.url).toBe('https://x/asset.glb');
      expect(res.id).toBe('cgt-3d-1');
    } finally {
      restore();
    }
  });

  it('throws rather than returning an empty handle when file_url is absent', async () => {
    const restore = stubSequence([
      { body: { id: 'cgt-3d-2' } },
      { body: { id: 'cgt-3d-2', status: 'succeeded', content: {} } },
    ]);
    try {
      await expect(
        makeAdapter().generateAsset3D(model('seed3d-1-0-250928'), { prompt: 'x' })
      ).rejects.toThrow(/content\.file_url is absent/);
    } finally {
      restore();
    }
  });
});

// ─── Batch chat + file upload (no ProviderAdapter contract) ───────────────

describe('BytePlusModelArkAdapter — batchChatCompletion', () => {
  it('POSTs the identical chat body to /batch/chat/completions', async () => {
    const restore = stubJson(chatFixture());
    try {
      const res = await makeAdapter().batchChatCompletion({
        model: 'ep-bi-20260802120000-abcde',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(calls[0].url).toBe(`${BASE}/batch/chat/completions`);
      expect(calls[0].body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
      expect(calls[0].body.thinking).toEqual({ type: 'disabled' });
      expect(res.choices[0].message?.content).toBe('Hello! How can I help you today?');
    } finally {
      restore();
    }
  });

  it('refuses a plain model id — the batch route requires an ep-bi- endpoint', async () => {
    const restore = stubJson(chatFixture());
    try {
      await expect(
        makeAdapter().batchChatCompletion({
          model: 'seed-2-0-lite-260228',
          messages: [{ role: 'user', content: 'Hi' }],
        })
      ).rejects.toThrow(/requires a BATCH endpoint id/);
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe('BytePlusModelArkAdapter — uploadFile', () => {
  it('POSTs multipart to /files with purpose=user_data and no explicit Content-Type', async () => {
    const restore = stubJson({ object: 'file', id: 'file-20251018114827-6zgrb', bytes: 11 });
    try {
      const res = await makeAdapter().uploadFile({
        data: Buffer.from('hello world'),
        filename: 'demo.pdf',
        contentType: 'application/pdf',
      });
      expect(calls[0].url).toBe(`${BASE}/files`);
      // fetch must set the multipart boundary itself.
      expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
      expect(res.id).toBe('file-20251018114827-6zgrb');
    } finally {
      restore();
    }
  });
});

// ─── Speech-to-text ──────────────────────────────────────────────────────

describe('BytePlusModelArkAdapter — speechToText', () => {
  it('routes through /chat/completions with an input_audio part (no /audio/transcriptions exists)', async () => {
    const restore = stubJson(
      chatFixture({
        choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello world' } },
        ],
      })
    );
    try {
      const res = await makeAdapter().speechToText(model('seed-2-0-lite-260428'), {
        audio: Buffer.from('audio-bytes'),
        options: { format: 'wav' },
      });
      expect(calls[0].url).toBe(`${BASE}/chat/completions`);
      const messages = calls[0].body.messages as Array<{
        content: Array<{ type: string; input_audio?: { data: string; format: string } }>;
      }>;
      const audioPart = messages[0].content.find((p) => p.type === 'input_audio');
      expect(audioPart?.input_audio?.format).toBe('wav');
      expect(audioPart?.input_audio?.data).toBe(Buffer.from('audio-bytes').toString('base64'));
      expect(res.text).toBe('hello world');
    } finally {
      restore();
    }
  });

  it('folds `language` into the prompt (there is no language parameter)', async () => {
    const restore = stubJson(chatFixture());
    try {
      await makeAdapter().speechToText(model('seed-2-0-lite-260428'), {
        audio: Buffer.from('a'),
        language: 'pt',
      });
      const messages = calls[0].body.messages as Array<{
        content: Array<{ type: string; text?: string }>;
      }>;
      expect(messages[0].content.find((p) => p.type === 'text')?.text).toMatch(
        /spoken language is pt/
      );
    } finally {
      restore();
    }
  });

  it('infers the required `format` from filename/mimeType, defaulting to mp3', async () => {
    const restore = stubJson(chatFixture());
    const read = () => {
      const messages = calls[calls.length - 1].body.messages as Array<{
        content: Array<{ type: string; input_audio?: { format: string } }>;
      }>;
      return messages[0].content.find((p) => p.type === 'input_audio')?.input_audio?.format;
    };
    try {
      const adapter = makeAdapter();
      const m = model('seed-2-0-lite-260428');
      await adapter.speechToText(m, { audio: Buffer.from('a'), options: { filename: 'x.m4a' } });
      expect(read()).toBe('m4a');
      await adapter.speechToText(m, { audio: Buffer.from('a'), options: { mimeType: 'audio/mpeg' } });
      expect(read()).toBe('mp3');
      await adapter.speechToText(m, { audio: Buffer.from('a') });
      expect(read()).toBe('mp3');
    } finally {
      restore();
    }
  });

  it('opens the prompt-driven ASR surface: diarization, timestamps, translation, custom prompt', async () => {
    // ModelArk states outright that timestamps / diarization / translation
    // are prompt-driven, not parameter-driven — a single hardcoded
    // "transcribe verbatim" makes most of the advertised surface unreachable.
    const restore = stubJson(chatFixture());
    const promptText = () => {
      const messages = calls[calls.length - 1].body.messages as Array<{
        content: Array<{ type: string; text?: string }>;
      }>;
      return messages[0].content.find((p) => p.type === 'text')?.text ?? '';
    };
    try {
      const adapter = makeAdapter();
      const m = model('seed-2-0-lite-260428');

      await adapter.speechToText(m, { audio: Buffer.from('a'), options: { diarize: true } });
      expect(promptText()).toMatch(/\[spkN\]\[start-end\]/);
      expect(promptText()).not.toMatch(/Return only the transcript text/);

      await adapter.speechToText(m, { audio: Buffer.from('a'), options: { timestamps: true } });
      expect(promptText()).toMatch(/\[start-end\] timestamp/);

      await adapter.speechToText(m, {
        audio: Buffer.from('a'),
        options: { translateTo: 'Portuguese' },
      });
      expect(promptText()).toMatch(/translate the transcript into Portuguese/);

      // An explicit prompt replaces the built-in instruction entirely.
      await adapter.speechToText(m, {
        audio: Buffer.from('a'),
        options: { prompt: 'Produce SRT subtitles.' },
      });
      expect(promptText()).toBe('Produce SRT subtitles.');

      // Default is unchanged for existing callers.
      await adapter.speechToText(m, { audio: Buffer.from('a'), language: 'en' });
      expect(promptText()).toBe(
        'Transcribe this audio verbatim. The spoken language is en. Return only the transcript text.'
      );
    } finally {
      restore();
    }
  });

  it('accepts the url / file_id forms of input_audio so stored audio is not re-uploaded inline', async () => {
    const restore = stubJson(chatFixture());
    const audioPart = () => {
      const messages = calls[calls.length - 1].body.messages as Array<{
        content: Array<{ type: string; input_audio?: Record<string, unknown> }>;
      }>;
      return messages[0].content.find((p) => p.type === 'input_audio')?.input_audio;
    };
    try {
      const adapter = makeAdapter();
      const m = model('seed-2-0-lite-260428');

      await adapter.speechToText(m, {
        audio: Buffer.alloc(0),
        options: { file_id: 'file-20251018114827-6zgrb' },
      });
      expect(audioPart()).toEqual({ file_id: 'file-20251018114827-6zgrb' });

      await adapter.speechToText(m, {
        audio: Buffer.alloc(0),
        options: { audio_url: 'https://example.com/a.mp3' },
      });
      // `format` is only required for the inline `data` form.
      expect(audioPart()).toEqual({ url: 'https://example.com/a.mp3' });
    } finally {
      restore();
    }
  });
});

// ─── Tokenization ────────────────────────────────────────────────────────

describe('BytePlusModelArkAdapter — countTokens', () => {
  it('POSTs /tokenization and returns per-input token totals', async () => {
    // Fixture copied from a real live 200 on 2026-08-02.
    const restore = stubJson({
      id: '021785689114024718115c1869987166c12ff7f50db9b4e768b0b',
      model: 'seed-2-0-lite-260228',
      created: 1785689114,
      object: 'list',
      data: [
        {
          index: 0,
          object: 'tokenization',
          total_tokens: 2,
          token_ids: [40889, 2725],
          offset_mapping: [
            [0, 5],
            [5, 11],
          ],
        },
      ],
    });
    try {
      const totals = await makeAdapter().countTokens('seed-2-0-lite-260228', ['hello world']);
      expect(calls[0].url).toBe(`${BASE}/tokenization`);
      expect(calls[0].body).toEqual({ model: 'seed-2-0-lite-260228', text: ['hello world'] });
      expect(totals).toEqual([2]);
    } finally {
      restore();
    }
  });
});

// ─── Health check ────────────────────────────────────────────────────────

describe('BytePlusModelArkAdapter — healthCheck', () => {
  it('probes GET {hostRoot}/ping — the HOST ROOT, not under /api/v3', async () => {
    const restore = stubJson({ message: 'pong' });
    try {
      const res = await makeAdapter().healthCheck();
      expect(calls[0].url).toBe('https://ark.ap-southeast.bytepluses.com/ping');
      expect(calls[0].url).not.toContain('/api/v3');
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
        'Bearer byteplus-test-key'
      );
      expect(res.healthy).toBe(true);
      expect(typeof res.latency).toBe('number');
    } finally {
      restore();
    }
  });

  it('reports unhealthy with a key-rejected message on 401', async () => {
    const restore = stubJson(
      { error: { code: 'AuthenticationError' } },
      { ok: false, status: 401 }
    );
    try {
      const res = await makeAdapter().healthCheck();
      expect(res.healthy).toBe(false);
      expect(res.error).toMatch(/BYTEPLUS_API_KEY rejected/);
    } finally {
      restore();
    }
  });

  it('reports unhealthy without touching the network when no key is configured', async () => {
    const restore = stubJson({ message: 'pong' });
    try {
      const res = await new BytePlusModelArkAdapter({ apiKey: '', baseUrl: BASE }).healthCheck();
      expect(res.healthy).toBe(false);
      expect(res.error).toMatch(/not configured/);
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

// ─── Error handling ──────────────────────────────────────────────────────

describe('BytePlusModelArkAdapter — error handling', () => {
  it('turns ModelNotOpen into an actionable operator message, not a generic model-not-found', async () => {
    const restore = stubJson(
      {
        error: {
          code: 'ModelNotOpen',
          message:
            'Your account 3003814011 has not activated the model seed-2-0-lite-260228. Please activate the model service in the Ark Console. Request id: 0217856889436799',
          param: '',
          type: 'Not Found',
        },
      },
      { ok: false, status: 404 }
    );
    try {
      await expect(
        makeAdapter().chatCompletion({
          model: 'seed-2-0-lite-260228',
          messages: [{ role: 'user', content: 'Hi' }],
        })
      ).rejects.toThrow(/OPERATOR ACTION REQUIRED.*Ark Console.*not an integration defect/s);
    } finally {
      restore();
    }
  });

  it('flags ModelIDAccessDisabled with the endpoint-id remedy', async () => {
    const restore = stubJson(
      {
        error: {
          code: 'InvalidEndpointOrModel.ModelIDAccessDisabled',
          message: 'Accessing the model via Model ID is not allowed for your account.',
        },
      },
      { ok: false, status: 404 }
    );
    try {
      await expect(
        makeAdapter().chatCompletion({
          model: 'seed-2-0-lite-260228',
          messages: [{ role: 'user', content: 'Hi' }],
        })
      ).rejects.toThrow(/custom.*endpoint id \(ep-…\)/);
    } finally {
      restore();
    }
  });

  it('retries a retryable 429 (ServerOverloaded) but NOT SetLimitExceeded', async () => {
    const overloaded = {
      body: { error: { code: 'ServerOverloaded', message: 'busy' } },
      ok: false,
      status: 429,
    };
    let restore = stubSequence([overloaded, { body: chatFixture() }]);
    try {
      const res = await makeAdapter().chatCompletion({
        model: 'seed-2-0-lite-260228',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(calls).toHaveLength(2);
      expect(res.choices[0].message?.content).toBe('Hello! How can I help you today?');
    } finally {
      restore();
    }

    // SetLimitExceeded is a 429 that is NOT retryable — a backoff loop on
    // it spins forever while failed requests keep counting against the
    // per-minute limit.
    calls = [];
    restore = stubJson(
      { error: { code: 'SetLimitExceeded', message: 'account paused' } },
      { ok: false, status: 429 }
    );
    try {
      await expect(
        makeAdapter().chatCompletion({
          model: 'seed-2-0-lite-260228',
          messages: [{ role: 'user', content: 'Hi' }],
        })
      ).rejects.toThrow(/NOT retryable/);
      expect(calls).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('treats a 200 with an EMPTY body as an absent route, not an empty result', async () => {
    // ModelArk answers unknown routes with HTTP 200 + zero-length body
    // (verified against a deliberately bogus path). Parsing that as
    // "success with no data" would let a nonexistent route masquerade as
    // an empty result set forever.
    const restore = stubJson('', { ok: true, status: 200 });
    try {
      await expect(
        makeAdapter().countTokens('seed-2-0-lite-260228', 'hi')
      ).rejects.toThrow(/EMPTY body.*route that does not exist/s);
    } finally {
      restore();
    }
  });
});

// ─── Deliberately unsupported surfaces ───────────────────────────────────

describe('BytePlusModelArkAdapter — unsupported surfaces throw with the reason', () => {
  it('textToSpeech: ModelArk publishes no speech-synthesis endpoint', async () => {
    await expect(
      makeAdapter().textToSpeech(model('any'), { text: 'hello' })
    ).rejects.toThrow(/no speech-synthesis endpoint or voice catalog/);
  });

  it('imageVariation: no variation endpoint and no prompt-free image-to-image mode', async () => {
    await expect(
      makeAdapter().imageVariation(model('seedream-4-0-250828'), { image: Buffer.from('x') })
    ).rejects.toThrow(/no image-variation endpoint/);
  });

  it('moderate: no /moderations route; the signal is chat-response metadata instead', async () => {
    await expect(
      makeAdapter().moderate(model('any'), { text: 'hello' })
    ).rejects.toThrow(/no \/moderations endpoint/);
  });

  it('webSearch: left as the base throw rather than emulated through chat', async () => {
    await expect(makeAdapter().webSearch(model('any'), { query: 'x' })).rejects.toThrow(
      /webSearch not implemented/
    );
  });

  it('checkBalance returns null ("unable to check") — no data-plane balance endpoint', async () => {
    await expect(makeAdapter().checkBalance()).resolves.toBeNull();
  });
});

// ─── Naming / cost ───────────────────────────────────────────────────────

describe('BytePlusModelArkAdapter — normalizeModelName / calculateCost', () => {
  it('is identity (trim only) — the platform normalises server-side, so never munge ids', () => {
    const adapter = makeAdapter();
    expect(adapter.normalizeModelName('  seed-2-0-lite-260228 ')).toBe('seed-2-0-lite-260228');
    // Dotted forms and endpoint ids alike pass through untouched.
    expect(adapter.normalizeModelName('doubao-1.5-pro-32k-250115')).toBe(
      'doubao-1.5-pro-32k-250115'
    );
    expect(adapter.normalizeModelName('ep-20240522022935-4pwju')).toBe('ep-20240522022935-4pwju');
  });

  it('reports zero cost (catalog pricingMode is `none`) rather than fabricating rates', () => {
    expect(makeAdapter().calculateCost(model('seed-2-0-lite-260228'), 1000, 1000)).toBe(0);
  });
});
