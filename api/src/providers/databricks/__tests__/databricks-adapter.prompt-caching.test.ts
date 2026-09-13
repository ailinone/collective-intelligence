// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DatabricksAdapter — Claude `cache_control` prompt-caching tests (ADR-025
 * follow-up, 2026-09-09).
 *
 * Databricks documents `cache_control: { type: 'ephemeral' }` on a message
 * content block for Databricks-hosted Claude models (pay-per-token
 * endpoints named `databricks-claude-*`, confirmed live against Databricks'
 * own supported-models listing). This adapter marks the system message on
 * such endpoints; every other endpoint (Llama, Mixtral, DBRX, a custom
 * fine-tune, ...) is untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DatabricksAdapter,
  applyDatabricksClaudeCacheControl,
  isDatabricksClaudeEndpoint,
} from '../databricks-adapter';
import type { ChatMessage, ChatRequest } from '@/types';

// `chatCompletion()` normalizes the requested model against the catalog
// before sending — mock the DB-backed lookup so the wiring tests below
// don't need a live database.
vi.mock('@/services/model-catalog-service', () => ({
  getModelsByProvider: vi.fn().mockResolvedValue([]),
}));

const ENV_KEYS = ['DATABRICKS_HOST', 'DATABRICKS_SERVING_ENDPOINT'] as const;
const ORIG_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    ORIG_ENV[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIG_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIG_ENV[key];
    }
  }
});

describe('isDatabricksClaudeEndpoint', () => {
  it('matches Databricks pay-per-token Claude endpoint names', () => {
    expect(isDatabricksClaudeEndpoint('databricks-claude-sonnet-4-5')).toBe(true);
    expect(isDatabricksClaudeEndpoint('databricks-claude-opus-4-1')).toBe(true);
    expect(isDatabricksClaudeEndpoint('CLAUDE-custom-alias')).toBe(true); // case-insensitive
  });

  it('does not match non-Claude endpoints', () => {
    expect(isDatabricksClaudeEndpoint('databricks-llama-3-70b-instruct')).toBe(false);
    expect(isDatabricksClaudeEndpoint('databricks-dbrx-instruct')).toBe(false);
    expect(isDatabricksClaudeEndpoint('unconfigured')).toBe(false);
  });
});

describe('applyDatabricksClaudeCacheControl', () => {
  it('marks a string-content system message with an ephemeral cache_control block', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant with a very long prompt.' },
      { role: 'user', content: 'hi' },
    ];

    const result = applyDatabricksClaudeCacheControl(messages);

    expect(result[0].content).toEqual([
      {
        type: 'text',
        text: 'You are a helpful assistant with a very long prompt.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    // The user message is untouched, and by reference where nothing changed.
    expect(result[1]).toBe(messages[1]);
  });

  it('is a no-op when there is no system message', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(applyDatabricksClaudeCacheControl(messages)).toBe(messages);
  });

  it('is a no-op when the system message content is already structured (not a plain string)', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'already structured' }] },
      { role: 'user', content: 'hi' },
    ];
    expect(applyDatabricksClaudeCacheControl(messages)).toBe(messages);
  });

  it('is a no-op when the system message content is an empty string', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '' },
      { role: 'user', content: 'hi' },
    ];
    expect(applyDatabricksClaudeCacheControl(messages)).toBe(messages);
  });

  it('does not mutate the input array (returns a new array)', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'stable instructions' },
      { role: 'user', content: 'hi' },
    ];
    const result = applyDatabricksClaudeCacheControl(messages);
    expect(result).not.toBe(messages);
    expect(typeof messages[0].content).toBe('string'); // original untouched
  });
});

describe('DatabricksAdapter — cache_control wiring on chat requests', () => {
  function jsonResponse(): Response {
    return new Response(
      JSON.stringify({
        id: 'resp-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'databricks-claude-sonnet-4-5',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  function baseRequest(): ChatRequest {
    return {
      model: 'ignored',
      messages: [
        { role: 'system', content: 'a stable system prompt' },
        { role: 'user', content: 'hi' },
      ],
    };
  }

  it('marks the system message when the endpoint is Claude-named', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse());
    const adapter = new DatabricksAdapter({
      name: 'databricks',
      enabled: true,
      providerName: 'databricks',
      apiKey: 'db-key',
      workspaceHost: 'my-co.cloud.databricks.com',
      endpoint: 'databricks-claude-sonnet-4-5',
    });

    await adapter.chatCompletion(baseRequest());

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: unknown }> };
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'a stable system prompt', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('leaves messages untouched when the endpoint is not Claude-named', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse());
    const adapter = new DatabricksAdapter({
      name: 'databricks',
      enabled: true,
      providerName: 'databricks',
      apiKey: 'db-key',
      workspaceHost: 'my-co.cloud.databricks.com',
      endpoint: 'databricks-llama-3-70b-instruct',
    });

    await adapter.chatCompletion(baseRequest());

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: unknown }> };
    expect(body.messages[0].content).toBe('a stable system prompt');
  });
});
