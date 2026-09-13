// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * V0Adapter — Platform API wire contract tests (mocked fetch).
 *
 * Exercises the v0.dev-shaped request body (`{ message, system?,
 * modelConfiguration }` to `POST /chats`, NOT OpenAI `/chat/completions`),
 * the `latestVersion.files[]` + `messages[]` response mapping back into
 * `ChatResponse`, auth header construction, and error handling. No live
 * credentials needed — `fetch` is stubbed per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { V0Adapter } from '../v0-adapter';

const BASE = 'https://api.v0.dev/v1';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];

function stubFetch(jsonBody: unknown, init: { ok?: boolean; status?: number } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, fetchInit?: RequestInit) => {
    calls.push({ url: String(url), init: fetchInit ?? {} });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => jsonBody,
      text: async () => JSON.stringify(jsonBody),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeAdapter(opts: { apiKey?: string } = {}): V0Adapter {
  return new V0Adapter({
    apiKey: opts.apiKey ?? 'v0-test-key',
    baseUrl: BASE,
  });
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('V0Adapter — getModels (no bulk /models)', () => {
  it('returns the pinned modelConfiguration.modelId enum without hitting the wire', async () => {
    const sentinel = { count: 0 };
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      sentinel.count++;
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      } as Response);
    }) as unknown as typeof fetch;
    try {
      const adapter = makeAdapter();
      const models = await adapter.getModels();
      expect(models.map((m) => m.id).sort()).toEqual(
        ['v0-auto', 'v0-max', 'v0-max-fast', 'v0-mini', 'v0-pro'].sort()
      );
      expect(sentinel.count).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  // 2026-09-09 capability-mismatch fix: v0's documented POST /chats schema
  // (https://v0.app/docs/api/platform/reference/chats/create) has no
  // tools/tool_choice/functions field on any model — attachedSkillIds/
  // skills (pre-registered skills.sh/memory/project skills, max 3) and
  // mcpServerIds (pre-registered MCP servers v0 may consult autonomously)
  // are not a substitute for caller-supplied JSON-schema function-calling,
  // and chatCompletion/buildV0Message never read request.tools/tool_choice
  // (see the "tools/tool_choice (no wire equivalent)" describe block
  // below). No pinned model may claim `tool_use`.
  it('never declares tool_use on any pinned model — v0 has no tools/tool_choice wire equivalent', async () => {
    const adapter = makeAdapter();
    const models = await adapter.getModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.capabilities).not.toContain('tool_use');
    }
  });
});

describe('V0Adapter — chatCompletion request shape', () => {
  it('POSTs { message, responseMode: sync, modelConfiguration } to /chats with Bearer auth', async () => {
    const restore = stubFetch({
      id: 'chat-123',
      object: 'chat',
      createdAt: '2026-08-02T00:00:00.000Z',
      modelConfiguration: { modelId: 'v0-auto' },
      messages: [{ role: 'assistant', content: 'Here is your component.' }],
      latestVersion: { status: 'completed', files: [] },
    });
    try {
      const adapter = makeAdapter();
      const res = await adapter.chatCompletion({
        model: 'v0-auto',
        messages: [{ role: 'user', content: 'Build me a button' }],
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${BASE}/chats`);
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer v0-test-key');
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(String(calls[0].init.body));
      expect(body.message).toBe('Build me a button');
      expect(body.responseMode).toBe('sync');
      expect(body.modelConfiguration).toEqual({ modelId: 'v0-auto' });
      expect(body.system).toBeUndefined();

      expect(res.id).toBe('chat-123');
      expect(res.object).toBe('chat.completion');
      expect(res.model).toBe('v0-auto');
      expect(res.choices[0].finish_reason).toBe('stop');
      expect(res.choices[0].message?.content).toBe('Here is your component.');
    } finally {
      restore();
    }
  });

  it('joins system-role messages into the `system` field', async () => {
    const restore = stubFetch({
      id: 'chat-sys',
      messages: [{ role: 'assistant', content: 'ok' }],
      latestVersion: { status: 'completed', files: [] },
    });
    try {
      const adapter = makeAdapter();
      await adapter.chatCompletion({
        model: 'v0-auto',
        messages: [
          { role: 'system', content: 'You are a UI expert.' },
          { role: 'user', content: 'Build a form' },
        ],
      });
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.system).toBe('You are a UI expert.');
      expect(body.message).toBe('Build a form');
    } finally {
      restore();
    }
  });

  it('flattens multi-turn history into a labeled User:/Assistant: transcript', async () => {
    const restore = stubFetch({
      id: 'chat-multi',
      messages: [{ role: 'assistant', content: 'ok' }],
      latestVersion: { status: 'completed', files: [] },
    });
    try {
      const adapter = makeAdapter();
      await adapter.chatCompletion({
        model: 'v0-auto',
        messages: [
          { role: 'user', content: 'Build a button' },
          { role: 'assistant', content: 'Here it is.' },
          { role: 'user', content: 'Make it blue' },
        ],
      });
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.message).toBe(
        'User: Build a button\n\nAssistant: Here it is.\n\nUser: Make it blue'
      );
    } finally {
      restore();
    }
  });

  it('throws when there is no user/assistant message', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.chatCompletion({
        model: 'v0-auto',
        messages: [{ role: 'system', content: 'You are helpful.' }],
      })
    ).rejects.toThrow(/at least one user message/);
  });
});

describe('V0Adapter — chatCompletion response mapping', () => {
  it('serializes latestVersion.files[] as fenced code blocks appended after the assistant text', async () => {
    const restore = stubFetch({
      id: 'chat-files',
      createdAt: '2026-08-02T00:00:00.000Z',
      modelConfiguration: { modelId: 'v0-pro' },
      messages: [{ role: 'assistant', content: "I've created your app." }],
      latestVersion: {
        status: 'completed',
        files: [
          { name: 'app/page.tsx', content: 'export default function Page() { return null; }' },
          { name: 'package.json', content: '{"name":"demo"}' },
        ],
      },
    });
    try {
      const adapter = makeAdapter();
      const res = await adapter.chatCompletion({
        model: 'v0-auto',
        messages: [{ role: 'user', content: 'Build me an app' }],
      });
      const content = res.choices[0].message?.content as string;
      expect(content).toContain("I've created your app.");
      expect(content).toContain('```app/page.tsx');
      expect(content).toContain('export default function Page()');
      expect(content).toContain('```package.json');
      expect(res.model).toBe('v0-pro'); // echoes v0's actual auto-routed model, not the request's
    } finally {
      restore();
    }
  });

  it('omits usage entirely rather than fabricating token counts', async () => {
    const restore = stubFetch({
      id: 'chat-usage',
      messages: [{ role: 'assistant', content: 'ok' }],
      latestVersion: { status: 'completed', files: [] },
    });
    try {
      const adapter = makeAdapter();
      const res = await adapter.chatCompletion({
        model: 'v0-auto',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.usage).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('throws when latestVersion.status is failed', async () => {
    const restore = stubFetch({
      id: 'chat-failed',
      messages: [],
      latestVersion: { status: 'failed', files: [] },
    });
    try {
      const adapter = makeAdapter();
      await expect(
        adapter.chatCompletion({
          model: 'v0-auto',
          messages: [{ role: 'user', content: 'hi' }],
        })
      ).rejects.toThrow(/generation failed/);
    } finally {
      restore();
    }
  });

  it('throws on an unexpected non-completed status for a sync request', async () => {
    const restore = stubFetch({
      id: 'chat-pending',
      messages: [],
      latestVersion: { status: 'pending', files: [] },
    });
    try {
      const adapter = makeAdapter();
      await expect(
        adapter.chatCompletion({
          model: 'v0-auto',
          messages: [{ role: 'user', content: 'hi' }],
        })
      ).rejects.toThrow(/unexpected latestVersion.status 'pending'/);
    } finally {
      restore();
    }
  });
});

describe('V0Adapter — tools/tool_choice (no wire equivalent on this surface)', () => {
  // v0's documented POST /chats body has no OpenAI-style `tools`/`tool_choice`
  // field (only `attachedSkillIds`/`mcpServerIds`, which are not a mapping
  // target for arbitrary caller-supplied function schemas). These tests
  // guard the concrete, testable contract: neither field ever leaks into the
  // outgoing body, for both chatCompletion and chatCompletionStream (which
  // delegates to chatCompletion), regardless of what tool_choice value is
  // requested.
  const TOOLS = [
    {
      type: 'function' as const,
      function: {
        name: 'get_weather',
        description: 'Get current weather',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];

  it('chatCompletion never forwards tools or tool_choice to POST /chats (tool_choice: auto)', async () => {
    const restore = stubFetch({
      id: 'chat-tools-auto',
      messages: [{ role: 'assistant', content: 'ok' }],
      latestVersion: { status: 'completed', files: [] },
    });
    try {
      const adapter = makeAdapter();
      await adapter.chatCompletion({
        model: 'v0-auto',
        messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
        tools: TOOLS,
        tool_choice: 'auto',
      });
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(Object.keys(body).sort()).toEqual(['message', 'modelConfiguration', 'responseMode']);
    } finally {
      restore();
    }
  });

  it('chatCompletion never forwards tools or tool_choice to POST /chats (tool_choice: none)', async () => {
    const restore = stubFetch({
      id: 'chat-tools-none',
      messages: [{ role: 'assistant', content: 'ok' }],
      latestVersion: { status: 'completed', files: [] },
    });
    try {
      const adapter = makeAdapter();
      await adapter.chatCompletion({
        model: 'v0-auto',
        messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
        tools: TOOLS,
        tool_choice: 'none',
      });
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('chatCompletion never forwards tools or a forced {type:function} tool_choice to POST /chats', async () => {
    const restore = stubFetch({
      id: 'chat-tools-forced',
      messages: [{ role: 'assistant', content: 'ok' }],
      latestVersion: { status: 'completed', files: [] },
    });
    try {
      const adapter = makeAdapter();
      await adapter.chatCompletion({
        model: 'v0-auto',
        messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
        tools: TOOLS,
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      });
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('chatCompletionStream (delegates to chatCompletion) also never forwards tools or tool_choice', async () => {
    const restore = stubFetch({
      id: 'chat-tools-stream',
      messages: [{ role: 'assistant', content: 'ok' }],
      latestVersion: { status: 'completed', files: [] },
    });
    try {
      const adapter = makeAdapter();
      const chunks: unknown[] = [];
      for await (const chunk of adapter.chatCompletionStream({
        model: 'v0-auto',
        messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
        tools: TOOLS,
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      })) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(1);
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('does not throw when tools/tool_choice are present — the request still completes normally', async () => {
    const restore = stubFetch({
      id: 'chat-tools-noop',
      messages: [{ role: 'assistant', content: 'Paris is sunny.' }],
      latestVersion: { status: 'completed', files: [] },
    });
    try {
      const adapter = makeAdapter();
      const res = await adapter.chatCompletion({
        model: 'v0-auto',
        messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
        tools: TOOLS,
        tool_choice: 'required' as never, // not part of the internal union, but must not crash
      });
      expect(res.choices[0].message?.content).toBe('Paris is sunny.');
    } finally {
      restore();
    }
  });
});

describe('V0Adapter — HTTP error handling', () => {
  it('throws with status + body on a non-200 response', async () => {
    const restore = stubFetch({ error: { type: 'not_found_error' } }, { ok: false, status: 404 });
    try {
      const adapter = makeAdapter();
      await expect(
        adapter.chatCompletion({
          model: 'v0-auto',
          messages: [{ role: 'user', content: 'hi' }],
        })
      ).rejects.toThrow(/v0 chat HTTP 404/);
    } finally {
      restore();
    }
  });
});

describe('V0Adapter — healthCheck', () => {
  it('returns unhealthy when apiKey missing (no network call)', async () => {
    const sentinel = { count: 0 };
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      sentinel.count++;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
    }) as unknown as typeof fetch;
    try {
      const adapter = new V0Adapter({ apiKey: '', baseUrl: BASE });
      const result = await adapter.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.error).toMatch(/V0_API_KEY/);
      expect(sentinel.count).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('probes GET /projects (cheap, no generation) and reports healthy on 200', async () => {
    const restore = stubFetch({ projects: [] });
    try {
      const adapter = makeAdapter();
      const result = await adapter.healthCheck();
      expect(result.healthy).toBe(true);
      expect(calls[0].url).toBe(`${BASE}/projects`);
      expect(calls[0].init.method).toBe('GET');
    } finally {
      restore();
    }
  });

  it('reports unhealthy on HTTP 401', async () => {
    const restore = stubFetch({ error: 'unauthorized' }, { ok: false, status: 401 });
    try {
      const adapter = makeAdapter();
      const result = await adapter.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.error).toMatch(/401/);
    } finally {
      restore();
    }
  });
});

describe('V0Adapter — unsupported surfaces', () => {
  it('generateEmbeddings throws', async () => {
    const adapter = makeAdapter();
    await expect(adapter.generateEmbeddings({ model: 'v0-auto', input: 'x' })).rejects.toThrow(
      /not supported/
    );
  });

  it('imageEdit/imageVariation/moderate throw', async () => {
    const adapter = makeAdapter();
    const model = { id: 'v0-auto', name: 'v0-auto' } as never;
    await expect(adapter.imageEdit(model, {} as never)).rejects.toThrow(/not supported/);
    await expect(adapter.imageVariation(model, {} as never)).rejects.toThrow(/not supported/);
    await expect(adapter.moderate(model, {} as never)).rejects.toThrow(/not supported/);
  });
});

describe('V0Adapter — normalizeModelName', () => {
  it('defaults to v0-auto when blank', () => {
    const adapter = makeAdapter();
    expect(adapter.normalizeModelName('')).toBe('v0-auto');
    expect(adapter.normalizeModelName('  ')).toBe('v0-auto');
  });

  it('trims and passes through a provided model id', () => {
    const adapter = makeAdapter();
    expect(adapter.normalizeModelName(' v0-max ')).toBe('v0-max');
  });
});
