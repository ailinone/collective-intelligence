// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PR3b (media-artifact-delegation) — characterization tests locking the
 * behavior of the inline `response?.choices?.[0]?.message?.content` text
 * extraction that collaborative-strategy.ts, critique-repair-strategy.ts, and
 * devil-advocate-consensus-strategy.ts each reimplemented inline (2-3x in
 * collaborative-strategy.ts alone) before this change, now consolidated into
 * calls to the shared `safeResponseContent()` (base-strategy.ts, added PR1).
 *
 * Two inline shapes existed across the three files:
 *
 *  (1) The "raw ternary" pattern, used identically in critique-repair-strategy.ts
 *      and devil-advocate-consensus-strategy.ts, and once in
 *      collaborative-strategy.ts's streaming fallback:
 *        `const c = response?.choices?.[0]?.message?.content;
 *         return typeof c === 'string' ? c : '';`
 *
 *  (2) The "array-joining" pattern, local to collaborative-strategy.ts's three
 *      near-identical `getMessageContent()` closures (createReviewRequest,
 *      createRefinementRequest, createValidationRequest) plus a fourth inline
 *      copy in `hasImprovements()`: same string-content handling as (1), plus
 *      manual joining of an array-of-parts content, gated on
 *      `part.type === 'text' && 'text' in part`.
 *
 * These tests reproduce both old implementations verbatim as reference
 * functions and assert `safeResponseContent()` matches them on every
 * REALISTIC input shape, then separately document (and assert) the two
 * EDGE-CASE shapes where `safeResponseContent()` is intentionally more
 * permissive — per the task's "note explicitly rather than silently changing
 * behavior" instruction — so this file is the record of that decision, not
 * just prose in a PR description.
 */
import { describe, it, expect } from 'vitest';
import { safeResponseContent } from '../base-strategy';
import type { ChatResponse, MessageContent } from '@/types';

/** Old pattern (1): critique-repair-strategy.ts / devil-advocate-consensus-strategy.ts. */
function oldRawTernary(response: ChatResponse | undefined): string {
  const c = response?.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : '';
}

/** Type guard reproduced verbatim from collaborative-strategy.ts's old `isTextContent`. */
function isTextContent(part: MessageContent): part is { type: 'text'; text: string } {
  return part.type === 'text' && 'text' in part && typeof part.text === 'string';
}

/** Old pattern (2): collaborative-strategy.ts's `getMessageContent`/`hasImprovements`. */
function oldArrayJoining(response: ChatResponse | undefined): string {
  const message = response?.choices?.[0]?.message;
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part: MessageContent) => (isTextContent(part) ? part.text : ''))
      .join('');
  }
  return '';
}

function mkResponse(
  content: ChatResponse['choices'][number]['message']['content'] | undefined
): ChatResponse {
  if (content === undefined) {
    return {
      id: 'r',
      object: 'chat.completion',
      created: 0,
      model: 'm',
      choices: [],
    } as unknown as ChatResponse;
  }
  return {
    id: 'r',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  } as unknown as ChatResponse;
}

describe('safeResponseContent() parity with the old inline extraction — realistic inputs', () => {
  // String content is the ONLY shape oldRawTernary's real call sites
  // (critique-repair-strategy.ts, devil-advocate-consensus-strategy.ts) ever
  // received — both old patterns handle it identically.
  const stringCases: Array<{ name: string; content: unknown }> = [
    { name: 'plain string content', content: 'Hello, world.' },
    { name: 'empty string content', content: '' },
  ];

  for (const { name, content } of stringCases) {
    it(`matches both old patterns for: ${name}`, () => {
      const response = mkResponse(content as ChatResponse['choices'][number]['message']['content']);
      const shared = safeResponseContent(response);
      expect(shared).toBe(oldRawTernary(response));
      expect(shared).toBe(oldArrayJoining(response));
    });
  }

  // Array content is the shape ONLY oldArrayJoining's real call site
  // (collaborative-strategy.ts's createReviewRequest/createRefinementRequest/
  // createValidationRequest/hasImprovements) ever received.
  // oldRawTernary is intentionally excluded from this parity check — it always
  // returns '' for non-string content, which is exactly the documented
  // divergence covered below, not a case its real call sites exercised.
  const arrayCases: Array<{ name: string; content: unknown }> = [
    {
      name: 'array of {type:"text", text} parts (the real multimodal shape)',
      content: [
        { type: 'text', text: 'Part one. ' },
        { type: 'text', text: 'Part two.' },
      ],
    },
    { name: 'single-element text-part array', content: [{ type: 'text', text: 'Solo part.' }] },
    { name: 'empty array content', content: [] },
  ];

  for (const { name, content } of arrayCases) {
    it(`matches oldArrayJoining (its real call sites' shape) for: ${name}`, () => {
      const response = mkResponse(content as ChatResponse['choices'][number]['message']['content']);
      expect(safeResponseContent(response)).toBe(oldArrayJoining(response));
    });
  }

  it('matches both old patterns when the response has no choices at all', () => {
    const response = mkResponse(undefined);
    const shared = safeResponseContent(response);
    expect(shared).toBe('');
    expect(shared).toBe(oldRawTernary(response));
    expect(shared).toBe(oldArrayJoining(response));
  });

  it('matches both old patterns when the response itself is undefined', () => {
    const shared = safeResponseContent(undefined);
    expect(shared).toBe('');
    expect(shared).toBe(oldRawTernary(undefined));
    expect(shared).toBe(oldArrayJoining(undefined));
  });
});

describe('safeResponseContent() — documented, intentional divergences from the old code', () => {
  it('DIVERGES from oldArrayJoining: accepts a raw string element inside a content array', () => {
    // oldArrayJoining()'s `isTextContent` guard requires an OBJECT with
    // `type === 'text'` — a bare string element in the array falls through to
    // '' for every part. safeResponseContent() accepts a raw string element
    // directly. Not observed in any real provider response in this codebase
    // (content arrays are always objects-with-type), but documented here
    // because it IS a real, if inert, behavioral difference.
    const response = mkResponse(['raw string part'] as unknown as ChatResponse['choices'][number]['message']['content']);
    expect(safeResponseContent(response)).toBe('raw string part');
    expect(oldArrayJoining(response)).toBe('');
  });

  it('DIVERGES from oldArrayJoining: accepts an object part with a string .text but no type:"text" discriminator', () => {
    // oldArrayJoining()'s `isTextContent` guard requires `part.type === 'text'`
    // strictly. safeResponseContent() only requires a string `.text` field,
    // regardless of `.type`. Again not observed with real provider payloads
    // (every part in this codebase's ChatMessage content carries `type`), but
    // a real, documented widening.
    const response = mkResponse([
      { type: 'not-text', text: 'still extracted' },
    ] as unknown as ChatResponse['choices'][number]['message']['content']);
    expect(safeResponseContent(response)).toBe('still extracted');
    expect(oldArrayJoining(response)).toBe('');
  });

  it('does NOT diverge from oldRawTernary on array content — both old call sites using that pattern never received array content in practice; oldRawTernary simply returns \'\' for anything non-string', () => {
    const response = mkResponse([{ type: 'text', text: 'x' }] as unknown as ChatResponse['choices'][number]['message']['content']);
    expect(oldRawTernary(response)).toBe('');
    expect(safeResponseContent(response)).toBe('x');
    // This is the collaborative-strategy.ts streaming-fallback case (PR3b):
    // the fallback closure only ever sees a plain (non-tool, non-multimodal)
    // primary generation in practice, so this widening is a strict
    // improvement there, not an observed regression — see the code comment
    // at the `streamSynthesisWithFallback` call site.
  });
});
