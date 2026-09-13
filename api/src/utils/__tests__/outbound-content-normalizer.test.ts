// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cases drawn from what production actually returned, not from what the shape of
 * the problem suggests. Probing all 32 strategies with "17 x 23" produced these
 * leaks verbatim:
 *
 *   agentic, hybrid       "<think>The user is asking a simple math question…"
 *   cost-cascade          "Okay, the user asked \"Quanto e 17 vezes 23?…"
 *
 * The second one is the interesting shape: it has no opening tag at all, because
 * DeepSeek-R1 and QwQ chat templates PRE-FILL the opener into the prompt, so the
 * completion carries only the closing tag.
 */

import { describe, it, expect } from 'vitest';
import {
  stripLeakedReasoning,
  normalizeOutboundResponse,
} from '@/utils/outbound-content-normalizer';
import type { ChatResponse } from '@/types';

const wrap = (content: unknown, extra: Record<string, unknown> = {}): ChatResponse =>
  ({
    id: 'chatcmpl-x',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content, ...extra } },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }) as unknown as ChatResponse;

const contentOf = (r: ChatResponse) =>
  (r.choices[0] as { message: { content: unknown } }).message.content;

describe('stripLeakedReasoning', () => {
  it('strips a leading paired block (the agentic/hybrid shape)', () => {
    const r = stripLeakedReasoning('<think>The user is asking a simple math question</think>391');
    expect(r.text).toBe('391');
    expect(r.changed).toBe(true);
  });

  it('strips an unpaired closing tag (the cost-cascade / pre-filled-opener shape)', () => {
    const r = stripLeakedReasoning('Okay, the user asked "17 x 23". That is 391.\n</think>\n\n391');
    expect(r.text).toBe('391');
    expect(r.changed).toBe(true);
  });

  it('strips several stacked leading blocks', () => {
    expect(stripLeakedReasoning('<think>a</think><thinking>b</thinking>391').text).toBe('391');
  });

  it('leaves a truncated mid-think generation alone', () => {
    // Opener with no closer: the block IS the whole generation. Removing it
    // would leave nothing, so returning the leak is the lesser harm.
    const raw = '<think>reasoning that never finished';
    expect(stripLeakedReasoning(raw)).toEqual({ text: raw, changed: false });
  });

  it('returns the original when stripping would consume everything', () => {
    // A silent blank 200 is worse than a visible leak.
    const raw = '<think>only reasoning, no answer</think>   ';
    expect(stripLeakedReasoning(raw)).toEqual({ text: raw, changed: false });
  });

  it('does not touch a closing tag inside a fenced code block', () => {
    const raw = 'To hide reasoning use:\n```html\n</think>\n```\nThat is the tag.';
    expect(stripLeakedReasoning(raw)).toEqual({ text: raw, changed: false });
  });

  it('does not touch a paired tag that appears mid-answer', () => {
    // Anchoring is the whole point: a global replace would eat this.
    const raw = 'The model emits <think>trace</think> before answering.';
    expect(stripLeakedReasoning(raw)).toEqual({ text: raw, changed: false });
  });

  it('is idempotent', () => {
    const once = stripLeakedReasoning('<think>x</think>391').text;
    expect(stripLeakedReasoning(once).text).toBe(once);
  });

  it('leaves ordinary answers byte-identical', () => {
    const raw = 'A resposta e 391.';
    expect(stripLeakedReasoning(raw)).toEqual({ text: raw, changed: false });
  });
});

describe('normalizeOutboundResponse', () => {
  it('cleans string content', () => {
    expect(contentOf(normalizeOutboundResponse(wrap('<think>t</think>391')))).toBe('391');
  });

  it('passes null content through by reference — an assistant message with tool_calls', () => {
    // This exact shape was a P0: the response schema had no null branch and
    // every tool-call response 500ed. The normalizer must never disturb it.
    const input = wrap(null, {
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'conciliar_pis_cofins', arguments: '{}' },
        },
      ],
    });
    expect(normalizeOutboundResponse(input)).toBe(input);
  });

  it('passes multimodal array content through by reference', () => {
    const input = wrap([{ type: 'text', text: '<think>x</think>391' }]);
    expect(normalizeOutboundResponse(input)).toBe(input);
  });

  it('skips a message that carries tool_calls even with string content', () => {
    const input = wrap('<think>t</think>ok', {
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }],
    });
    expect(normalizeOutboundResponse(input)).toBe(input);
  });

  it('returns the same reference when nothing changed', () => {
    // Callers persist the original payload for audit; zero allocation on the
    // hot path is the point.
    const input = wrap('391');
    expect(normalizeOutboundResponse(input)).toBe(input);
  });

  it('leaves progress/observer frames alone', () => {
    const input = {
      ...wrap('<think>x</think>y'),
      ailin_metadata: { type: 'progress' },
    } as ChatResponse;
    expect(normalizeOutboundResponse(input)).toBe(input);
  });

  it('does not disturb tool_calls, finish_reason or usage when it does clean content', () => {
    const out = normalizeOutboundResponse(wrap('<think>t</think>391'));
    const choice = out.choices[0] as { finish_reason: string };
    expect(choice.finish_reason).toBe('stop');
    expect(out.usage?.total_tokens).toBe(2);
  });

  it('survives a malformed response instead of throwing', () => {
    const bad = { id: 'x' } as unknown as ChatResponse;
    expect(() => normalizeOutboundResponse(bad)).not.toThrow();
  });
});
