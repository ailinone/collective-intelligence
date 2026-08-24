// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, afterEach } from 'vitest';
import { isTrivialSingleTurn } from '../trivial-request-triage';
import type { ChatRequest } from '@/types';

function req(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    messages: [{ role: 'user', content: 'oi' }],
    ...overrides,
  } as ChatRequest;
}

describe('isTrivialSingleTurn (simple-query fast path)', () => {
  afterEach(() => {
    delete process.env.TRIVIAL_MESSAGE_MAX_CHARS;
  });

  it('classifies a plain short single-turn message as trivial', () => {
    expect(isTrivialSingleTurn(req())).toBe(true);
    expect(isTrivialSingleTurn(req({ messages: [{ role: 'system', content: 'you are helpful' }, { role: 'user', content: 'obrigado' }] }))).toBe(true);
  });

  it('rejects multi-turn history', () => {
    expect(
      isTrivialSingleTurn(
        req({
          messages: [
            { role: 'user', content: 'oi' },
            { role: 'assistant', content: 'olá!' },
            { role: 'user', content: 'oi' },
          ],
        })
      )
    ).toBe(false);
  });

  it('rejects long messages', () => {
    expect(isTrivialSingleTurn(req({ messages: [{ role: 'user', content: 'a'.repeat(65) }] }))).toBe(false);
    expect(isTrivialSingleTurn(req({ messages: [{ role: 'user', content: 'a'.repeat(64) }] }))).toBe(true);
  });

  it('honors TRIVIAL_MESSAGE_MAX_CHARS env override', () => {
    process.env.TRIVIAL_MESSAGE_MAX_CHARS = '8';
    expect(isTrivialSingleTurn(req())).toBe(true); // "oi" = 2 chars
    expect(isTrivialSingleTurn(req({ messages: [{ role: 'user', content: 'bom dia, tudo bem?' }] }))).toBe(false);
  });

  it('rejects tool-bearing requests', () => {
    expect(isTrivialSingleTurn(req({ tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] as never }))).toBe(false);
    expect(isTrivialSingleTurn(req({ tool_choice: 'auto' }))).toBe(false);
  });

  it('rejects web search and RAG config', () => {
    expect(isTrivialSingleTurn(req({ webSearch: true }))).toBe(false);
    expect(isTrivialSingleTurn(req({ rag_config: { vector_store_ids: ['vs1'] } } as Partial<ChatRequest>))).toBe(false);
  });

  it('rejects multimodal (structured) content and tool results', () => {
    expect(
      isTrivialSingleTurn(
        req({ messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }] })
      )
    ).toBe(false);
    expect(
      isTrivialSingleTurn(
        req({ messages: [{ role: 'user', content: 'oi', tool_results: [{} as never] }] })
      )
    ).toBe(false);
  });
});
