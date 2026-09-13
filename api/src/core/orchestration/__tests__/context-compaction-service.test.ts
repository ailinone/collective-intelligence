// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Long-context compaction (LOTE AW, 2026-09).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ContextCompactionService,
  pickDelegationModel,
} from '../context-compaction-service';
import type { ChatMessage, Model, OrchestrationContext } from '@/types';

const context = { requestId: 'r1' } as OrchestrationContext;

function messages(n: number): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: 'be helpful' }];
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` });
  }
  return out;
}

describe('ContextCompactionService.shouldCompact', () => {
  const service = new ContextCompactionService();

  it('triggers at/above the 0.75 default threshold', () => {
    expect(service.shouldCompact(750, 1000)).toBe(true);
    expect(service.shouldCompact(749, 1000)).toBe(false);
  });

  it('never triggers with an unknown/zero contextWindow', () => {
    expect(service.shouldCompact(999_999, 0)).toBe(false);
    expect(service.shouldCompact(999_999, undefined)).toBe(false);
  });

  it('honors CONTEXT_COMPACTION_THRESHOLD override', () => {
    process.env.CONTEXT_COMPACTION_THRESHOLD = '0.5';
    try {
      expect(service.shouldCompact(500, 1000)).toBe(true);
      expect(service.shouldCompact(499, 1000)).toBe(false);
    } finally {
      delete process.env.CONTEXT_COMPACTION_THRESHOLD;
    }
  });
});

describe('ContextCompactionService.compact', () => {
  afterEach(() => {
    delete process.env.CONTEXT_COMPACTION_KEEP_TURNS;
  });

  it('does nothing when there are not more than keepTurns messages', async () => {
    const service = new ContextCompactionService();
    const msgs = messages(4); // default keepTurns=6, 4 non-system messages
    const outcome = await service.compact(msgs, context);
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toBe(msgs);
  });

  it('keeps the system message + the most recent keepTurns messages verbatim, summarizing the rest', async () => {
    process.env.CONTEXT_COMPACTION_KEEP_TURNS = '4';
    const summarize = async (text: string) => `SUMMARY(${text.split('\n').length} lines)`;
    const service = new ContextCompactionService(summarize);

    const msgs = messages(10); // 1 system + 10 non-system
    const outcome = await service.compact(msgs, context);

    expect(outcome.compacted).toBe(true);
    expect(outcome.collapsedMessageCount).toBe(6); // 10 - 4 kept
    // system message preserved first
    expect(outcome.messages[0].role).toBe('system');
    expect(outcome.messages[0].content).toBe('be helpful');
    // synthetic summary message second
    expect(outcome.messages[1].role).toBe('system');
    expect(String(outcome.messages[1].content)).toContain('SUMMARY(6 lines)');
    // LOTE AZ, 2026-09: the synthetic summary is tagged so provider adapters
    // can keep it out of the stable cache_control prefix (see
    // anthropic-adapter.convert-messages.test.ts); the original system
    // message must NOT carry the tag.
    expect(outcome.messages[1].isCompactionSummary).toBe(true);
    expect(outcome.messages[0].isCompactionSummary).toBeUndefined();
    // tail preserved verbatim, in order, untouched
    const tail = outcome.messages.slice(2);
    expect(tail).toHaveLength(4);
    expect(tail.map((m) => m.content)).toEqual(['turn 6', 'turn 7', 'turn 8', 'turn 9']);
  });

  it('fails open (does not compact) when the summarizer throws', async () => {
    const service = new ContextCompactionService(async () => {
      throw new Error('cheap model unavailable');
    });
    const msgs = messages(10);
    const outcome = await service.compact(msgs, context);
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toBe(msgs);
  });

  it('falls back to bounded heuristic truncation with no summarizer wired', async () => {
    const service = new ContextCompactionService();
    const msgs = messages(10); // default keepTurns=6 -> 10-6=4 collapsed
    const outcome = await service.compact(msgs, context);
    expect(outcome.compacted).toBe(true);
    expect(outcome.collapsedMessageCount).toBe(4);
    expect(String(outcome.messages[1].content)).toContain('Summary of 4 earlier conversation turns');
  });

  it('never changes the FIRST user message or the system message — the stable-prefix hash input', async () => {
    // Session affinity's stable-prefix hash is derived from (system message,
    // first user message). Compaction must never touch either, no matter
    // how much history it collapses.
    process.env.CONTEXT_COMPACTION_KEEP_TURNS = '2';
    const service = new ContextCompactionService();
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'FIRST_USER_MESSAGE' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ];
    const outcome = await service.compact(msgs, context);
    expect(outcome.compacted).toBe(true);
    expect(outcome.messages[0]).toEqual(msgs[0]); // system untouched
    // FIRST_USER_MESSAGE got folded into the summary text (it's older than
    // the kept tail), but the ORIGINAL messages array — what the caller
    // hashes BEFORE calling compact() — is never mutated.
    expect(msgs[1].content).toBe('FIRST_USER_MESSAGE');
  });
});

describe('pickDelegationModel', () => {
  const m = (id: string, provider: string, contextWindow: number, quality = 0.5): Model =>
    ({ id, provider, contextWindow, performance: { quality } }) as Model;

  it('prefers a same-provider sibling with enough room', () => {
    const pool = [
      m('small-same', 'acme', 8_000),
      m('big-same', 'acme', 200_000, 0.9),
      m('big-other', 'other', 300_000, 0.99),
    ];
    const picked = pickDelegationModel(pool, { id: 'current', provider: 'acme' }, 100_000);
    expect(picked?.id).toBe('big-same');
  });

  it('falls back to any operational model with enough room when no same-provider sibling fits', () => {
    const pool = [m('small-same', 'acme', 8_000), m('big-other', 'other', 300_000)];
    const picked = pickDelegationModel(pool, { id: 'current', provider: 'acme' }, 100_000);
    expect(picked?.id).toBe('big-other');
  });

  it('returns null when nothing has enough room', () => {
    const pool = [m('a', 'acme', 1_000), m('b', 'other', 2_000)];
    expect(pickDelegationModel(pool, { id: 'current', provider: 'acme' }, 100_000)).toBeNull();
  });

  it('never picks the current model itself', () => {
    const pool = [m('current', 'acme', 500_000)];
    expect(pickDelegationModel(pool, { id: 'current', provider: 'acme' }, 100_000)).toBeNull();
  });
});
