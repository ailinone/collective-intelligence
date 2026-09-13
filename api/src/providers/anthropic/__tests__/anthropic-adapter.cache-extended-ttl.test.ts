// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for AnthropicAdapter's extended (1-hour) prompt-cache TTL gate
 * (mismatch fix, 2026-09).
 *
 * Real defect this closes: `session-affinity-service.ts` documented its
 * 3600s idle TTL as "matches ... Anthropic's 1h cache tier", but this
 * adapter only ever sent bare `cache_control: { type: 'ephemeral' }` —
 * Anthropic's STANDARD 5-minute tier — with no `ttl` field anywhere. A
 * session idle for 5-60 minutes kept its model pin (session-affinity's own
 * TTL genuinely covers that) but silently lost Anthropic's prompt cache and
 * repaid the full system+tools prefix on the next turn.
 *
 * Fix: once a request already carries a prior `assistant` turn (i.e. this
 * is turn 2+ of a real multi-turn exchange — see `hasConversationHistory()`
 * on the adapter), `cache_control` now requests `ttl: '1h'` — the current,
 * GA (no `anthropic-beta` header) shape confirmed live against
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching and
 * https://platform.claude.com/docs/en/about-claude/pricing#prompt-caching
 * on 2026-09-08. This is NOT unconditional: a 1-hour cache WRITE costs 2x
 * base input price vs 1.25x for the standard 5-minute tier, so it is only
 * requested once a request has already proven it isn't a one-shot call
 * (see `isExtendedCacheTtlEnabled()`'s doc comment in anthropic-adapter.ts
 * for the full cost rationale). `ANTHROPIC_EXTENDED_CACHE_TTL_ENABLED=false`
 * is the operator kill-switch back to the standard 5-minute tier.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '@/providers/anthropic/anthropic-adapter';
import type { ChatRequest } from '@/types';

type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } };
type ToolBlock = { cache_control?: { type: 'ephemeral'; ttl?: '1h' } };
type CreateArgs = {
  model: string;
  system?: SystemBlock[];
  tools?: ToolBlock[];
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

/** Same recording-stub pattern as anthropic-adapter.cache-minimum-size.test.ts. */
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

/** A system string of roughly `tokens` tokens (~4 chars/token) — comfortably
 * above Sonnet 5's 1,024-token cacheable-prefix minimum used throughout. */
function systemOfTokens(tokens: number): string {
  return 'x'.repeat(tokens * 4 + 40);
}

const CACHE_ELIGIBLE_SYSTEM = systemOfTokens(1024);

describe('AnthropicAdapter — extended (1h) prompt-cache TTL gate (mismatch fix)', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_EXTENDED_CACHE_TTL_ENABLED;
  });

  it('sends the standard 5-minute tier (no ttl) on a fresh, first-turn conversation', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({
        messages: [
          { role: 'system', content: CACHE_ELIGIBLE_SYSTEM },
          { role: 'user', content: 'hi' },
        ],
      })
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].system?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(calls[0].system?.[0]?.cache_control?.ttl).toBeUndefined();
  });

  it('requests the real 1-hour tier (type: ephemeral, ttl: 1h — no beta header involved) once the conversation already has a prior assistant turn', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({
        messages: [
          { role: 'system', content: CACHE_ELIGIBLE_SYSTEM },
          { role: 'user', content: 'turn 1' },
          { role: 'assistant', content: 'reply 1' },
          { role: 'user', content: 'turn 2' },
        ],
      })
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].system?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('marks the last tool with the same 1-hour tier once the conversation has a prior assistant turn', async () => {
    const { adapter, calls } = buildAdapter();
    const bigDescription = 'd'.repeat(1024 * 4 + 40);
    await adapter.chatCompletion(
      chatRequest({
        messages: [
          { role: 'user', content: 'turn 1' },
          { role: 'assistant', content: 'reply 1' },
          { role: 'user', content: 'turn 2' },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'lookup', description: bigDescription, parameters: {} },
          },
        ],
      })
    );

    expect(calls[0].tools?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('does not upgrade to the 1-hour tier below the model minimum cacheable size, even with prior conversation history', async () => {
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({
        messages: [
          { role: 'system', content: 'be helpful' }, // far under the 1,024-token minimum
          { role: 'user', content: 'turn 1' },
          { role: 'assistant', content: 'reply 1' },
          { role: 'user', content: 'turn 2' },
        ],
      })
    );

    expect(calls[0].system?.[0]?.cache_control).toBeUndefined();
  });

  it('falls back to the standard 5-minute tier when ANTHROPIC_EXTENDED_CACHE_TTL_ENABLED=false, even with prior conversation history', async () => {
    process.env.ANTHROPIC_EXTENDED_CACHE_TTL_ENABLED = 'false';
    const { adapter, calls } = buildAdapter();
    await adapter.chatCompletion(
      chatRequest({
        messages: [
          { role: 'system', content: CACHE_ELIGIBLE_SYSTEM },
          { role: 'user', content: 'turn 1' },
          { role: 'assistant', content: 'reply 1' },
          { role: 'user', content: 'turn 2' },
        ],
      })
    );

    expect(calls[0].system?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('gates chatCompletionStream the same way as chatCompletion (1h tier on a continuing conversation)', async () => {
    const { adapter, calls } = buildAdapter(() => []);
    const stream = adapter.chatCompletionStream(
      chatRequest({
        messages: [
          { role: 'system', content: CACHE_ELIGIBLE_SYSTEM },
          { role: 'user', content: 'turn 1' },
          { role: 'assistant', content: 'reply 1' },
          { role: 'user', content: 'turn 2' },
        ],
      })
    );
    for await (const _chunk of stream) {
      void _chunk;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].system?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});
