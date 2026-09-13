// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for AnthropicAdapter prompt-caching minimum-size gating
 * (LOTE AX, 2026-09).
 *
 * Anthropic's own documented minimum cacheable prompt length is real,
 * model-tier-dependent, and enforced silently: a `cache_control` block below
 * the threshold for the model actually being used is simply ignored (no
 * error, no `cache_creation_input_tokens`/`cache_read_input_tokens`), so
 * marking a too-short prefix cacheable is harmless but pointless bloat in
 * the request. This adapter now estimates the system+tools prefix size
 * (via the shared `estimateContextSize`) and only adds `cache_control` when
 * that estimate is at or above the real minimum for the model in use:
 *
 *   - 1,024 tokens  — Claude Sonnet 5 (this suite's default test model)
 *   -   512 tokens  — Claude Opus 5
 *   - 4,096 tokens  — Claude Haiku 4.5
 *
 * Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 * (fetched live 2026-09-06).
 */
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '@/providers/anthropic/anthropic-adapter';
import type { ChatRequest } from '@/types';

type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
type CreateArgs = {
  model: string;
  system?: SystemBlock[];
  tools?: Array<{ cache_control?: { type: 'ephemeral' } }>;
  [k: string]: unknown;
};

const OK_RESPONSE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

/** Same recording-stub pattern as anthropic-adapter.sampling-params.test.ts. */
function buildAdapter(createImpl: (args: CreateArgs) => unknown = () => OK_RESPONSE) {
  const calls: CreateArgs[] = [];
  const adapter = new AnthropicAdapter({ apiKey: 'test-key', maxRetries: 0 });
  const create = async (args: CreateArgs) => {
    calls.push(args);
    return createImpl(args);
  };
  const stub = { messages: { create } };
  (adapter as unknown as { client: unknown }).client = stub;
  (adapter as unknown as { clientPool: unknown[] }).clientPool = [stub];
  (adapter as unknown as { getRequestClient(): unknown }).getRequestClient = () => stub;
  // Keep the model id verbatim so the family/version lookup sees it as-is.
  (adapter as unknown as { normalizeModelName(m: string): Promise<string> }).normalizeModelName =
    async (m: string) => m;
  return { adapter, calls };
}

function chatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatRequest;
}

/** A system string of roughly `tokens` tokens (~4 chars/token, matching the
 * shared estimator's heuristic), comfortably clear of rounding either way. */
function systemOfTokens(tokens: number): string {
  return 'x'.repeat(tokens * 4 + 40);
}

describe('AnthropicAdapter — prompt-caching minimum-size gating (LOTE AX)', () => {
  it('omits cache_control when the system prefix is below the model minimum (Sonnet 5: 1,024 tokens)', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({
        model: 'claude-sonnet-5',
        messages: [
          { role: 'system', content: 'be helpful' }, // ~2 tokens, far under 1,024
          { role: 'user', content: 'hi' },
        ],
      })
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].system?.[0]?.cache_control).toBeUndefined();
  });

  it('adds cache_control when the system prefix is at/above the model minimum (Sonnet 5: 1,024 tokens)', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({
        model: 'claude-sonnet-5',
        messages: [
          { role: 'system', content: systemOfTokens(1024) },
          { role: 'user', content: 'hi' },
        ],
      })
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].system?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('respects a lower per-model minimum (Opus 5: 512 tokens) — a prefix too small for Sonnet 5 qualifies here', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({
        model: 'claude-opus-5',
        messages: [
          { role: 'system', content: systemOfTokens(600) }, // < 1,024 but >= 512
          { role: 'user', content: 'hi' },
        ],
      })
    );

    expect(calls[0].system?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('respects a higher per-model minimum (Haiku 4.5: 4,096 tokens) — a prefix that qualifies for Sonnet 5 does not here', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({
        model: 'claude-haiku-4-5',
        messages: [
          { role: 'system', content: systemOfTokens(1024) }, // >= Sonnet 5's min, < Haiku 4.5's
          { role: 'user', content: 'hi' },
        ],
      })
    );

    expect(calls[0].system?.[0]?.cache_control).toBeUndefined();
  });

  it('counts tools toward the cacheable-prefix estimate, marking the last tool cacheable once the combined size clears the minimum', async () => {
    const { adapter, calls } = buildAdapter();
    const bigDescription = 'd'.repeat(1024 * 4 + 40);
    await adapter.chatCompletion(
      chatRequest({
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: { name: 'lookup', description: bigDescription, parameters: {} },
          },
        ],
      })
    );

    expect(calls[0].tools?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits cache_control from both system and tools when the combined prefix stays below the minimum', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({
        model: 'claude-sonnet-5',
        messages: [
          { role: 'system', content: 'be helpful' },
          { role: 'user', content: 'hi' },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'lookup', description: 'a small tool', parameters: {} },
          },
        ],
      })
    );

    expect(calls[0].system?.[0]?.cache_control).toBeUndefined();
    expect(calls[0].tools?.[0]?.cache_control).toBeUndefined();
  });

  it('gates streaming chatCompletionStream the same way as chatCompletion', async () => {
    // Streaming returns an (async) iterable of raw SSE events, not a single
    // message — an empty array is a valid, trivially-iterable stand-in.
    const { adapter, calls } = buildAdapter(() => []);
    const stream = adapter.chatCompletionStream(
      chatRequest({
        model: 'claude-sonnet-5',
        messages: [
          { role: 'system', content: systemOfTokens(1024) },
          { role: 'user', content: 'hi' },
        ],
      })
    );
    // Draining a fake response with no content_block_delta events completes
    // immediately; we only need the recorded create() args.
    for await (const _chunk of stream) {
      void _chunk;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].system?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });
});
