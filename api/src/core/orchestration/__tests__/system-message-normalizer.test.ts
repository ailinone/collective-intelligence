// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { normalizeSystemMessages } from '../system-message-normalizer';
import type { ChatMessage } from '@/types';

describe('normalizeSystemMessages', () => {
  it('returns the same reference for 0 system messages', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(normalizeSystemMessages(msgs)).toBe(msgs);
  });

  it('returns the same reference for exactly 1 system message', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hi' },
    ];
    expect(normalizeSystemMessages(msgs)).toBe(msgs);
  });

  it('merges multiple system messages IN ORDER into one leading message', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'STRATEGY PROMPT' },
      { role: 'system', content: 'PEER REVIEW' },
      { role: 'user', content: 'question' },
      { role: 'system', content: 'CLIENT SYSTEM' },
    ];
    const out = normalizeSystemMessages(msgs);
    const systems = out.filter((m) => m.role === 'system');
    expect(systems).toHaveLength(1);
    expect(systems[0].content).toBe('STRATEGY PROMPT\n\nPEER REVIEW\n\nCLIENT SYSTEM');
    // merged system sits at the FIRST system position; user message preserved
    expect(out[0].role).toBe('system');
    expect(out.find((m) => m.role === 'user')?.content).toBe('question');
    expect(out).toHaveLength(2);
  });

  it('extracts text from content-part arrays', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'A' }] },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'q' },
    ];
    const out = normalizeSystemMessages(msgs);
    expect(out.filter((m) => m.role === 'system')[0].content).toBe('A\n\nB');
  });

  it('drops empty system messages from the merge', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: '  ' },
      { role: 'system', content: 'real' },
      { role: 'user', content: 'q' },
    ];
    const out = normalizeSystemMessages(msgs);
    expect(out.filter((m) => m.role === 'system')[0].content).toBe('real');
  });
});
