// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Observer chunk wire shapes — off-channel vs inline.
 *
 * The observer emits narration in one of two shapes:
 *  - buildObserverChunk: OFF-channel (delta.content empty) — naive OpenAI clients
 *    ignore it; only ailin_metadata-aware clients render it in a side panel.
 *  - buildInlineNarrationChunk: ON-channel (narration in delta.content) — the opt-in
 *    "inline process header" so naive clients see visible opening tokens in ~4s
 *    instead of the ~30-52s silence before the collective's synthesis.
 */
import { describe, it, expect } from 'vitest';
import { buildObserverChunk, buildInlineNarrationChunk } from '../observer-service';
import type { ObserverNarration } from '@/types';

function narr(text: string): ObserverNarration {
  return {
    event: { type: 'phase_start', timestamp: 1, strategy: 'debate', summary: 'opening' },
    narration: text,
    durationMs: 10,
  };
}

type MetaChunk = { choices: Array<{ delta: { content?: string } }>; ailin_metadata: { type: string; narration?: string } };

describe('observer chunk wire shapes', () => {
  it('off-channel chunk keeps delta.content empty so naive clients ignore it', () => {
    const c = buildObserverChunk(narr('olá')) as unknown as MetaChunk;
    expect(c.choices[0].delta.content).toBe('');
    expect(c.ailin_metadata.type).toBe('observer');
    expect(c.ailin_metadata.narration).toBe('olá');
  });

  it('inline chunk places the narration in delta.content as visible opening tokens', () => {
    const c = buildInlineNarrationChunk(narr('Os analistas começaram a debater.')) as unknown as MetaChunk;
    // The narration IS the visible text, with a blank line separating it from the
    // synthesis that streams after.
    expect(c.choices[0].delta.content).toBe('Os analistas começaram a debater.\n\n');
    // Marked distinctly so the ailin client recognizes it and does NOT also render it
    // in the side narration panel (no double display).
    expect(c.ailin_metadata.type).toBe('observer_inline');
  });
});
