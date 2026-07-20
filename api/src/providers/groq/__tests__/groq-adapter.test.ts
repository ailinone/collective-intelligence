// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GroqAdapter — reasoning-param injection tests.
 *
 * We verify that Groq-specific knobs (reasoning_format, reasoning_effort,
 * service_tier) are threaded through the hub's `getExtraChatPayloadFields`
 * extension hook with correct allowlisting, and that the reasoning-model
 * pattern matcher recognizes the documented model id families.
 *
 * Low-level HTTP against the hub is NOT exercised here — it's covered by the
 * hub's own test suite. We expose the hook via a narrow test harness so the
 * assertion targets the behavior that actually matters for Groq.
 */

import { describe, expect, it } from 'vitest';
import { GroqAdapter } from '../groq-adapter';
import type { ChatRequest } from '@/types';

function makeAdapter(): GroqAdapter {
  return new GroqAdapter({
    name: 'groq',
    enabled: true,
    apiKey: 'groq-test-key',
    baseUrl: 'https://api.groq.com/openai/v1',
    providerName: 'groq',
  });
}

/**
 * The hook is protected; we expose it for tests via a narrow cast. Keeps the
 * production surface clean without making adapter internals public just for
 * test access.
 */
function invokeHook(
  adapter: GroqAdapter,
  model: string,
  request: ChatRequest,
): Record<string, unknown> {
  return (
    adapter as unknown as {
      getExtraChatPayloadFields: (m: string, r: ChatRequest) => Record<string, unknown>;
    }
  ).getExtraChatPayloadFields(model, request);
}

describe('GroqAdapter — reasoning-model detection', () => {
  it('matches the documented reasoning families', () => {
    expect(GroqAdapter.isReasoningModel('openai/gpt-oss-120b')).toBe(true);
    expect(GroqAdapter.isReasoningModel('deepseek-r1-distill-llama-70b')).toBe(true);
    expect(GroqAdapter.isReasoningModel('qwen-qwq-32b')).toBe(true);
    expect(GroqAdapter.isReasoningModel('qwen/qwq-preview')).toBe(true);
    expect(GroqAdapter.isReasoningModel('groq/compound-beta')).toBe(true);
  });

  it('rejects non-reasoning models', () => {
    expect(GroqAdapter.isReasoningModel('llama-3.3-70b-versatile')).toBe(false);
    expect(GroqAdapter.isReasoningModel('mixtral-8x7b-32768')).toBe(false);
    expect(GroqAdapter.isReasoningModel('gemma2-9b-it')).toBe(false);
    expect(GroqAdapter.isReasoningModel('')).toBe(false);
  });
});

describe('GroqAdapter — getExtraChatPayloadFields hook', () => {
  it('returns empty object when no reasoning knobs present', () => {
    const adapter = makeAdapter();
    const request: ChatRequest = {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(invokeHook(adapter, request.model, request)).toEqual({});
  });

  it('reads knobs from options bag', () => {
    const adapter = makeAdapter();
    const request = {
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'reason this out' }],
      options: {
        reasoning_format: 'parsed',
        reasoning_effort: 'medium',
        service_tier: 'flex',
      },
    } as unknown as ChatRequest;

    const extras = invokeHook(adapter, request.model, request);
    expect(extras).toEqual({
      reasoning_format: 'parsed',
      reasoning_effort: 'medium',
      service_tier: 'flex',
    });
  });

  it('reads knobs from flat top-level fields when options bag absent', () => {
    const adapter = makeAdapter();
    const request = {
      model: 'deepseek-r1-distill-llama-70b',
      messages: [{ role: 'user', content: 'think' }],
      reasoning_format: 'hidden',
      reasoning_effort: 'low',
    } as unknown as ChatRequest;

    const extras = invokeHook(adapter, request.model, request);
    expect(extras).toEqual({
      reasoning_format: 'hidden',
      reasoning_effort: 'low',
    });
  });

  it('rejects invalid enum values (allowlist guard)', () => {
    const adapter = makeAdapter();
    const request = {
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'x' }],
      options: {
        reasoning_format: 'verbose', // not in the allowed set
        reasoning_effort: 'extreme', // not allowed
        service_tier: 'priority', // not allowed
        rogue_field: 'pwned', // must not leak
      },
    } as unknown as ChatRequest;

    expect(invokeHook(adapter, request.model, request)).toEqual({});
  });

  it('does not echo arbitrary option keys — only the documented three', () => {
    const adapter = makeAdapter();
    const request = {
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'x' }],
      options: {
        reasoning_format: 'raw',
        malicious_field: 'oops',
      },
    } as unknown as ChatRequest;

    const extras = invokeHook(adapter, request.model, request);
    expect(extras).toEqual({ reasoning_format: 'raw' });
    expect(extras).not.toHaveProperty('malicious_field');
  });
});
