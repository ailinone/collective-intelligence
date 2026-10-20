// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CI-CHAT-0005 — transient thinking-tag flash in token-streamed narration.
 *
 * The narrator backend streams raw deltas; `<reasoning>`/`<think>` blocks are
 * stripped only from the FULLY ASSEMBLED text, so tag content can appear
 * transiently in the fragment stream before the strip runs. The streaming
 * tag filter must suppress tag content and hold back partial-tag prefixes
 * split across deltas.
 */
import { describe, it, expect } from 'vitest';
import { createThinkingTagFilter } from '../observer-service';

function feedAll(filter: ReturnType<typeof createThinkingTagFilter>, chunks: string[]): string {
  return chunks
    .map((c) => filter.feed(c))
    .join('');
}

describe('createThinkingTagFilter', () => {
  it('passes clean text through unchanged', () => {
    const f = createThinkingTagFilter();
    expect(f.feed('Os analistas estão deliberando. ')).toBe(
      'Os analistas estão deliberando. '
    );
    expect(f.flush()).toBe('');
  });

  it('suppresses a complete <reasoning> block across split deltas', () => {
    const out = feedAll(createThinkingTagFilter(), [
      'Resumo visível. ',
      '<rea',
      'soning>segredo interno do narrador</reasoning>',
      ' Continuação visível.',
    ]);
    expect(out).toBe('Resumo visível.  Continuação visível.');
    expect(out).not.toContain('segredo');
  });

  it('suppresses a complete <think> block (case-insensitive)', () => {
    const out = feedAll(createThinkingTagFilter(), [
      'Visible. ',
      '<THINK>hidden</THINK>',
      'More visible.',
    ]);
    expect(out).toBe('Visible. More visible.');
  });

  it('holds back a partial tag prefix at the end of the stream buffer', () => {
    const f = createThinkingTagFilter();
    expect(f.feed('Texto seguro <')).toBe('Texto seguro ');
    expect(f.feed('reasoning>conteúdo')).toBe('');
    expect(f.feed('</reasoning>e depois')).toBe('e depois');
  });

  it('drops an unclosed tag block at flush (never emits buffered tag content)', () => {
    const f = createThinkingTagFilter();
    f.feed('Ok. <think>começou e não fechou');
    expect(f.flush()).not.toContain('começou');
  });

  it('releases held safe text at flush when no tag was open', () => {
    const f = createThinkingTagFilter();
    f.feed('Frase terminando em <');
    expect(f.flush()).toBe('<');
  });
});
