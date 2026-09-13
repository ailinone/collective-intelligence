// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared context-size estimator (LOTE AW, 2026-09) — consolidates five
 * previously-drifted, broken copies. See context-size-estimator.ts's doc
 * comment for the full audit. These tests pin the two concrete bugs that
 * motivated the consolidation:
 *   1. `request.tools` must be counted (none of the five prior copies did).
 *   2. Structured/array message content must be JSON.stringify'd, not
 *      `.toString()`'d into the literal string "[object Object]".
 */
import { describe, it, expect } from 'vitest';
import { estimateContextSize } from '../context-size-estimator';
import type { ChatRequest, Tool } from '@/types';

describe('estimateContextSize', () => {
  it('estimates ~4 chars/token for plain string message content', () => {
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'a'.repeat(400) }],
    };
    expect(estimateContextSize(request)).toBe(100);
  });

  it('counts request.tools — the bug every prior copy shared', () => {
    const tool: Tool = {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      },
    };
    const withoutTools: ChatRequest = { messages: [{ role: 'user', content: 'hi' }] };
    const withTools: ChatRequest = { ...withoutTools, tools: [tool] };

    expect(estimateContextSize(withTools)).toBeGreaterThan(estimateContextSize(withoutTools));
    // Sanity: the tool schema alone is worth a meaningful number of tokens,
    // not a rounding-error bump — this is what fed the hard context-window
    // gate an under-count for tool-heavy agentic sessions.
    expect(estimateContextSize(withTools) - estimateContextSize(withoutTools)).toBeGreaterThan(10);
  });

  it('JSON.stringifies structured content instead of producing "[object Object]"', () => {
    const request: ChatRequest = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'describe this image' }],
        },
      ],
    };
    // ".toString()" on an array of one object would yield "[object Object]"
    // (17 chars -> ~4 tokens) regardless of the real content size. The real
    // JSON-stringified form is longer, so a bigger structured payload must
    // produce a bigger estimate — the old bug made every structured message
    // estimate the SAME tiny size no matter its real content.
    const bigger: ChatRequest = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'describe this image in extremely fine detail'.repeat(20) }],
        },
      ],
    };
    expect(estimateContextSize(bigger)).toBeGreaterThan(estimateContextSize(request));
    expect(estimateContextSize(request)).toBeGreaterThan(4); // not the fixed "[object Object]" size
  });

  it('accepts a bare ChatMessage[] (tools not counted — matches those call sites pre-existing scope)', () => {
    const size = estimateContextSize([{ role: 'user', content: 'a'.repeat(40) }]);
    expect(size).toBe(10);
  });

  it('handles empty/undefined messages without throwing', () => {
    expect(estimateContextSize({ messages: [] })).toBe(0);
    expect(estimateContextSize([])).toBe(0);
  });

  it('rounds up (Math.ceil) — the conservative direction for a hard-gate input', () => {
    // 1 char -> 0.25 tokens -> ceil to 1, never 0.
    expect(estimateContextSize({ messages: [{ role: 'user', content: 'a' }] })).toBe(1);
  });

  it('counts msg.tool_calls — the sixth undercount found by the context-window preflight audit', () => {
    // An agentic tool-calling turn (the exact traffic shape Cursor/Cline/
    // Zed/Claude Code/Goose/Opencode produce against an OpenAI-compatible
    // backend): the assistant's tool_calls carry a full file's worth of
    // argument payload, but `msg.content` on that same message is empty.
    // Before this fix, that whole payload was invisible to the estimator.
    const bigArgs = JSON.stringify({ path: '/repo/big-file.ts', contents: 'x'.repeat(4000) });
    const withoutToolCalls: ChatRequest = {
      messages: [{ role: 'assistant', content: '' }],
    };
    const withToolCalls: ChatRequest = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'write_file', arguments: bigArgs },
            },
          ],
        },
      ],
    };

    expect(estimateContextSize(withToolCalls)).toBeGreaterThan(estimateContextSize(withoutToolCalls));
    // Sanity: the tool-call payload alone is worth a meaningful number of
    // tokens (~1000), not a rounding-error bump.
    expect(
      estimateContextSize(withToolCalls) - estimateContextSize(withoutToolCalls)
    ).toBeGreaterThan(900);
  });

  it('counts msg.function_call — the legacy single-function-call shape', () => {
    const bigArgs = JSON.stringify({ query: 'y'.repeat(2000) });
    const withoutFunctionCall: ChatRequest = {
      messages: [{ role: 'assistant', content: '' }],
    };
    const withFunctionCall: ChatRequest = {
      messages: [
        {
          role: 'assistant',
          content: '',
          function_call: { name: 'search', arguments: bigArgs },
        },
      ],
    };

    expect(estimateContextSize(withFunctionCall)).toBeGreaterThan(
      estimateContextSize(withoutFunctionCall)
    );
    expect(
      estimateContextSize(withFunctionCall) - estimateContextSize(withoutFunctionCall)
    ).toBeGreaterThan(400);
  });
});
