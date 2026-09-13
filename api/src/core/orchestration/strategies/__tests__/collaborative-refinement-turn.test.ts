// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The reviewer's note must be a USER turn.
 *
 * As a trailing `system` message it was doubly broken:
 *
 * 1. The engine has ALREADY prepended two system messages (identity/conduct, and
 *    the peer-review prompt), so `normalizeSystemMessages` merged all three and
 *    hoisted the reviewer's free text into the HEAD system block. It stopped being
 *    the last thing said.
 * 2. That left the conversation ending on an ASSISTANT turn with nothing addressed
 *    to the model. The natural completion is meta-commentary about having been
 *    reviewed — and for Anthropic it is an assistant PREFILL, whose adapter lifts
 *    the system message out and keeps the rest, so the prior answer could be
 *    dropped outright.
 *
 * Measured in production on "Quanto e 17 vezes 23?" — 2 correct out of 6, with the
 * failures being "Thank you for providing your feedback and…", "I'm sorry for the
 * confusion earlier, but…", and an outright refusal.
 */

import { describe, it, expect } from 'vitest';
import { CollaborativeStrategy } from '../collaborative-strategy';

type Private = {
  createRefinementRequest: (
    request: unknown,
    primary: unknown,
    review: unknown
  ) => { messages: { role: string; content: string }[] };
};

const reply = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });

const REQUEST = {
  model: 'ailin-auto',
  messages: [
    { role: 'system', content: 'You are Ailin.' },
    { role: 'user', content: 'Quanto e 17 vezes 23?' },
  ],
};

const build = () => {
  const strategy = new CollaborativeStrategy() as unknown as Private;
  return strategy.createRefinementRequest(REQUEST, reply('391'), reply('Looks correct.'));
};

describe('collaborative refinement turn', () => {
  it('ends the conversation on a user turn, not an assistant one', () => {
    // The whole defect: a model with nothing addressed to it answers the only
    // thing that changed — the fact that it was reviewed.
    const messages = build().messages;
    expect(messages[messages.length - 1].role).toBe('user');
  });

  it('does not deliver the review as a system message', () => {
    // A trailing system message gets merged into the head block by
    // normalizeSystemMessages, so it is not even delivered where it was written.
    const messages = build().messages;
    const systemMessages = messages.filter((m) => m.role === 'system');
    expect(systemMessages.every((m) => !m.content.includes('Looks correct.'))).toBe(true);
  });

  it('still carries the reviewer feedback and the draft answer', () => {
    const messages = build().messages;
    expect(messages[messages.length - 1].content).toContain('Looks correct.');
    expect(messages.some((m) => m.role === 'assistant' && m.content === '391')).toBe(true);
  });

  it('tells the model to answer the original question, not to react to the review', () => {
    const instruction = build().messages.slice(-1)[0].content;
    expect(instruction).toMatch(/answer the original question again/i);
    expect(instruction).toMatch(/do not thank the reviewer/i);
    expect(instruction).toMatch(/repeat it unchanged/i);
  });

  it('preserves the original turns ahead of the refinement', () => {
    const messages = build().messages;
    expect(messages[0]).toEqual({ role: 'system', content: 'You are Ailin.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Quanto e 17 vezes 23?' });
  });
});
