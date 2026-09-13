// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for AnthropicAdapter.convertMessages — multiple system messages
 * (audit finding F-02) + prompt-caching `system` shape (LOTE AW, 2026-09),
 * gated by the model's real minimum cacheable size (LOTE AX, 2026-09).
 *
 * `convertMessages` used `messages.find(role === 'system')`, silently dropping
 * every system message after the first (e.g. the peer-review prepend plus the
 * client's own system message). It must now concatenate ALL system messages,
 * in order, into the single top-level Anthropic `system` block.
 *
 * LOTE AW update: `system` is no longer a bare string — prompt caching
 * (Anthropic `cache_control`) requires it to be a content-BLOCK array, since
 * a plain string structurally cannot carry a `cache_control` marker. These
 * tests were updated to assert the new `[{type:'text', text, cache_control}]`
 * shape; the underlying F-02 concatenation logic they exist to pin is
 * unchanged (see `helpers.systemText` below, which extracts just the joined
 * text so the concatenation assertions stay readable).
 *
 * LOTE AX update: the caller now only passes a truthy `cacheControl` once
 * the system+tools prefix has been checked against the model's real
 * documented minimum cacheable length. `convertMessages` itself defaults to
 * `cacheControl = false`, so these F-02/shape tests (which call it directly
 * with no third argument) assert the marker-less shape; the dedicated gating
 * describe block below exercises the flag explicitly.
 *
 * Mismatch-fix update (2026-09): `convertMessages`/`convertTools`'s third
 * parameter is no longer a bare boolean — it now carries the actual
 * `cache_control` value to emit (`{type:'ephemeral'}` or
 * `{type:'ephemeral', ttl:'1h'}`), so the caller can also request Anthropic's
 * extended 1-hour tier. These tests only exercise the pre-existing standard
 * tier (the old `true` -> `{type:'ephemeral'}`); see
 * anthropic-adapter.cache-extended-ttl.test.ts for the 1h-tier gating itself.
 */
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '@/providers/anthropic/anthropic-adapter';
import type { ChatMessage } from '@/types';

interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl?: '1h' };
}
type Converted = {
  system?: SystemBlock[];
  messages: Array<{ role: string; content: unknown }>;
};

type CacheControl = { type: 'ephemeral'; ttl?: '1h' } | false;

type ConvertMessagesFn = (
  messages: ChatMessage[],
  model: string,
  cacheControl?: CacheControl
) => Converted;

/** The pre-existing standard-tier marker — what `cacheEligible: true` used
 * to mean before the caller started passing the marker value itself. */
const STANDARD_CACHE_CONTROL: CacheControl = { type: 'ephemeral' };

function convertMessages(messages: ChatMessage[], cacheControl?: CacheControl): Converted {
  const adapter = new AnthropicAdapter({ apiKey: 'test-key', maxRetries: 0 });
  return (adapter as unknown as { convertMessages: ConvertMessagesFn }).convertMessages(
    messages,
    'claude-3-5-sonnet',
    cacheControl
  );
}

/** Extract the joined system text, independent of the cache_control wrapper. */
function systemText(result: Converted): string | undefined {
  return result.system?.[0]?.text;
}

describe('AnthropicAdapter.convertMessages — system message handling (F-02)', () => {
  it('concatenates ALL system messages in order with a blank-line separator', () => {
    const result = convertMessages([
      { role: 'system', content: 'first system' },
      { role: 'user', content: 'hello' },
      { role: 'system', content: 'second system' },
      { role: 'system', content: 'third system' },
    ]);

    expect(systemText(result)).toBe('first system\n\nsecond system\n\nthird system');
    // Non-system messages keep their relative order and content untouched
    // (claude-3-5 models wrap string content as structured text blocks)
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  it('keeps a single system message unchanged (no extra separators)', () => {
    const result = convertMessages([
      { role: 'system', content: 'only system' },
      { role: 'user', content: 'hi' },
    ]);
    expect(systemText(result)).toBe('only system');
  });

  it('returns undefined system when there are no system messages', () => {
    const result = convertMessages([{ role: 'user', content: 'hi' }]);
    expect(result.system).toBeUndefined();
  });

  it('normalizes content-part arrays from every system message before joining', () => {
    const result = convertMessages([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'text', text: 'part two' },
        ],
      },
      { role: 'system', content: 'plain second' },
    ]);
    expect(systemText(result)).toBe('part one\npart two\n\nplain second');
  });

  it('drops system messages whose content normalizes to empty', () => {
    const result = convertMessages([
      { role: 'system', content: '' },
      { role: 'system', content: 'kept' },
    ]);
    expect(systemText(result)).toBe('kept');
  });
});

describe('AnthropicAdapter.convertMessages — prompt caching (LOTE AW, 2026-09)', () => {
  it('does NOT add cache_control by default (caller must opt in via cacheControl)', () => {
    const result = convertMessages([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
    ]);
    expect(result.system).toEqual([{ type: 'text', text: 'be helpful' }]);
  });

  it('wraps a non-empty joined system prompt as a cache_control:ephemeral text block when cacheControl is set', () => {
    const result = convertMessages(
      [
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: 'hi' },
      ],
      STANDARD_CACHE_CONTROL
    );
    expect(result.system).toEqual([
      { type: 'text', text: 'be helpful', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('does not add cache_control when cacheControl is explicitly false', () => {
    const result = convertMessages(
      [
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: 'hi' },
      ],
      false
    );
    expect(result.system).toEqual([{ type: 'text', text: 'be helpful' }]);
  });

  it('still returns undefined (not an empty array) with no system messages, cacheControl or not', () => {
    expect(convertMessages([{ role: 'user', content: 'hi' }]).system).toBeUndefined();
    expect(convertMessages([{ role: 'user', content: 'hi' }], STANDARD_CACHE_CONTROL).system).toBeUndefined();
  });
});

describe('AnthropicAdapter.convertTools — prompt caching (LOTE AX, 2026-09)', () => {
  function convertTools(tools: unknown[], cacheControl?: CacheControl) {
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', maxRetries: 0 });
    return (
      adapter as unknown as {
        convertTools(tools: unknown[], cacheControl?: CacheControl): Array<Record<string, unknown>>;
      }
    ).convertTools(tools, cacheControl);
  }

  const tools = [
    {
      type: 'function',
      function: { name: 'first', description: 'first tool', parameters: {} },
    },
    {
      type: 'function',
      function: { name: 'last', description: 'last tool', parameters: {} },
    },
  ];

  it('marks only the LAST tool cacheable when cacheControl is set', () => {
    const result = convertTools(tools, STANDARD_CACHE_CONTROL);
    expect(result[0]!.cache_control).toBeUndefined();
    expect(result[1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks no tool cacheable when cacheControl is false (default)', () => {
    const result = convertTools(tools);
    expect(result[0]!.cache_control).toBeUndefined();
    expect(result[1]!.cache_control).toBeUndefined();
  });
});

describe('AnthropicAdapter.convertMessages — cache survives compaction (LOTE AZ, 2026-09)', () => {
  /**
   * CONFIRMED BUG this pins: context-compaction-service.ts appends a
   * synthetic `role: 'system'` summary message once a long conversation
   * crosses the compaction threshold. Before the fix, convertMessages()
   * flattened EVERY system-role message — the original, stable system
   * prompt AND the freshly-regenerated summary — into ONE indivisible
   * `cache_control`-marked block. Since Anthropic invalidates a cached
   * block the instant a single byte inside it changes, and the summary
   * text changes on every request where compaction re-triggers, the ENTIRE
   * cached prefix was invalidated on every single turn from the moment
   * compaction first fired — precisely the long, expensive conversations
   * where caching matters most.
   */
  const original = { role: 'system' as const, content: 'be a helpful assistant' };
  const summaryTurn1 = {
    role: 'system' as const,
    content: '[Summary of 4 earlier conversation turns]\nUser asked about X; assistant answered Y.',
    isCompactionSummary: true,
  };
  const summaryTurn2 = {
    role: 'system' as const,
    // Simulates the NEXT request: compact() re-ran over a larger head and
    // produced different summary text — this is the byte that must NOT be
    // allowed to touch the cached block.
    content:
      '[Summary of 7 earlier conversation turns]\nUser asked about X and Z; assistant answered Y and W.',
    isCompactionSummary: true,
  };

  it('puts the stable system prompt and the compaction summary in SEPARATE content blocks', () => {
    const result = convertMessages(
      [original, summaryTurn1, { role: 'user', content: 'now what?' }],
      STANDARD_CACHE_CONTROL
    );

    expect(result.system).toHaveLength(2);
    expect(result.system?.[0]).toEqual({
      type: 'text',
      text: 'be a helpful assistant',
      cache_control: { type: 'ephemeral' },
    });
    expect(result.system?.[1]).toEqual({
      type: 'text',
      text: '[Summary of 4 earlier conversation turns]\nUser asked about X; assistant answered Y.',
    });
  });

  it('never gives the compaction-summary block a cache_control marker, even when cacheControl is set', () => {
    const result = convertMessages(
      [original, summaryTurn1, { role: 'user', content: 'hi' }],
      STANDARD_CACHE_CONTROL
    );
    expect(result.system?.[1]).not.toHaveProperty('cache_control');
  });

  it('keeps the cached stable-prompt block byte-identical across turns even as the summary text changes', () => {
    const turn1 = convertMessages(
      [original, summaryTurn1, { role: 'user', content: 'q1' }],
      STANDARD_CACHE_CONTROL
    );
    const turn2 = convertMessages(
      [original, summaryTurn2, { role: 'user', content: 'q2' }],
      STANDARD_CACHE_CONTROL
    );

    // The regression this guards: the cached block (index 0) must be
    // unaffected by — must not include — whatever compaction appended,
    // even though the summary block (index 1) legitimately differs turn to
    // turn.
    expect(turn1.system?.[0]).toEqual(turn2.system?.[0]);
    expect(turn1.system?.[1]).not.toEqual(turn2.system?.[1]);
  });

  it('handles a compaction summary with no original system message (summary-only cache block, no cache_control)', () => {
    const result = convertMessages([summaryTurn1, { role: 'user', content: 'hi' }]);
    expect(result.system).toHaveLength(1);
    expect(result.system?.[0]).toEqual({
      type: 'text',
      text: '[Summary of 4 earlier conversation turns]\nUser asked about X; assistant answered Y.',
    });
  });

  it('joins multiple compaction-summary messages (repeated compaction rounds) into their own block, still uncached', () => {
    const result = convertMessages(
      [original, summaryTurn1, summaryTurn2, { role: 'user', content: 'hi' }],
      STANDARD_CACHE_CONTROL
    );
    expect(result.system).toHaveLength(2);
    expect(result.system?.[1].text).toBe(`${summaryTurn1.content}\n\n${summaryTurn2.content}`);
    expect(result.system?.[1]).not.toHaveProperty('cache_control');
  });
});
