// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Streaming file-generation artifact gate — text-extraction contract.
 *
 * Two properties are load-bearing, both regressions confirmed by execution
 * in the adversarial review of the FIRST (rejected) design attempt:
 *
 *   1. LAST USER TURN ONLY — the non-streaming heuristic fallback correctly
 *      joins ALL user turns (it classifies "the conversation so far" once,
 *      per request). Reusing that same join for the streaming gate would
 *      mean one media/file request anywhere in history permanently
 *      redirects every later streaming turn away from token streaming.
 *   2. TEXT PARTS ONLY, capped — a multipart message's non-text parts
 *      (image_url) can carry multi-megabyte base64; including them in the
 *      heuristic scan measured ~2s of synchronous blocking per 2MB payload,
 *      paid on every streaming request regardless of hit/miss.
 */
import { describe, it, expect } from 'vitest';
import {
  extractLastUserTurnTextForMediaGate,
  STREAMING_MEDIA_GATE_TEXT_CAP,
} from '../chat-routes';
import type { ChatMessage } from '@/types';

describe('extractLastUserTurnTextForMediaGate', () => {
  it('returns only the LAST user turn, ignoring earlier turns entirely', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'generate a pdf of the meeting minutes' },
      { role: 'assistant', content: 'Here is your PDF.' },
      { role: 'user', content: 'thanks! now explain how diffusion models work' },
    ];
    const text = extractLastUserTurnTextForMediaGate(messages);
    expect(text).toBe('thanks! now explain how diffusion models work');
    expect(text).not.toContain('pdf');
  });

  it('ignores assistant/system/tool turns and finds the last USER turn specifically', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
      { role: 'system', content: 'a system note appended after' },
    ];
    expect(extractLastUserTurnTextForMediaGate(messages)).toBe('second question');
  });

  it('extracts ONLY text-type parts from a multipart message, skipping image_url entirely', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(2_000_000) } },
        ],
      },
    ];
    const text = extractLastUserTurnTextForMediaGate(messages);
    expect(text).toBe('describe this image');
    expect(text.length).toBeLessThan(100);
  });

  it('joins multiple text parts of the same multipart message with a newline', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'text', text: 'part two' },
        ],
      },
    ];
    expect(extractLastUserTurnTextForMediaGate(messages)).toBe('part one\npart two');
  });

  it('caps the extracted text length, bounding worst-case regex-scan cost', () => {
    const hugeText = 'x'.repeat(STREAMING_MEDIA_GATE_TEXT_CAP + 5000);
    const messages: ChatMessage[] = [{ role: 'user', content: hugeText }];
    const text = extractLastUserTurnTextForMediaGate(messages);
    expect(text.length).toBe(STREAMING_MEDIA_GATE_TEXT_CAP);
  });

  it('returns an empty string when there is no user turn at all', () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'you are a helpful assistant' }];
    expect(extractLastUserTurnTextForMediaGate(messages)).toBe('');
  });
});
