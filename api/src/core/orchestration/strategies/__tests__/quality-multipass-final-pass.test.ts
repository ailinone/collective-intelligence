// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The final "polish" pass must not be able to destroy the answer it is polishing.
 *
 * Two independent ways it could, both live in production:
 *
 * 1. TOOLS SURVIVED THE SPREAD. `buildFinalSynthesisRequest` did `...request`, so
 *    `tools`/`tool_choice` carried onto the final pass, and `generateResponse`
 *    routes a tools-bearing request through `executeModelWithTools`. For a
 *    CLIENT-owned tool that helper correctly hands the call back: finish_reason
 *    'tool_calls', EMPTY content, success === true. Acceptance was
 *    `if (polishExecution.success)` — transport-level only — so the swap was
 *    taken and a validated text answer became an empty tool-call response.
 *
 *    That is the same mechanism that silently broke the PIS/COFINS agent, which
 *    is why it is asserted here rather than left to review.
 *
 * 2. THE MODEL ANSWERED THE INSTRUCTION. The last turn used to be "produce the
 *    final polished version, incorporate all improvements", so the model
 *    answered THAT conversationally. Production returned our own instruction
 *    vocabulary echoed back: "Certainly. Here's the final polished version,
 *    incorporating…".
 */

import { describe, it, expect } from 'vitest';
import { QualityMultiPassStrategy } from '../quality-multipass-strategy';

type Private = {
  buildFinalSynthesisRequest: (r: unknown, e: unknown, n: number) => Record<string, unknown>;
  looksLikeRefinementPreamble: (s: string) => boolean;
};

const strategy = () => new QualityMultiPassStrategy() as unknown as Private;

const DRAFT = {
  response: {
    choices: [{ index: 0, message: { role: 'assistant', content: 'PIS 10, COFINS 20.' } }],
  },
};

const REQUEST = {
  model: 'ailin-auto',
  messages: [{ role: 'user', content: 'Audite a competencia 09.2024.' }],
  tools: [
    {
      type: 'function',
      function: { name: 'conciliar_pis_cofins', parameters: { type: 'object', properties: {} } },
    },
  ],
  tool_choice: 'auto',
};

describe('quality-multipass final pass request', () => {
  it('strips tools so the polish pass cannot re-emit a tool call', () => {
    const final = strategy().buildFinalSynthesisRequest(REQUEST, DRAFT, 2);
    expect(final.tools).toBeUndefined();
    expect(final.tool_choice).toBeUndefined();
  });

  it('does not mutate the caller request', () => {
    strategy().buildFinalSynthesisRequest(REQUEST, DRAFT, 2);
    expect(REQUEST.tools).toHaveLength(1);
    expect(REQUEST.tool_choice).toBe('auto');
  });

  it('keeps the rest of the request intact', () => {
    const final = strategy().buildFinalSynthesisRequest(REQUEST, DRAFT, 2);
    expect(final.model).toBe('ailin-auto');
    const messages = final.messages as { role: string; content: string }[];
    expect(messages[0].content).toBe('Audite a competencia 09.2024.');
    expect(messages[1].content).toBe('PIS 10, COFINS 20.');
  });

  it('instructs the model to emit the answer rather than announce it', () => {
    const final = strategy().buildFinalSynthesisRequest(REQUEST, DRAFT, 2);
    const messages = final.messages as { role: string; content: string }[];
    const instruction = messages[messages.length - 1].content;
    expect(instruction).toMatch(/first characters of your reply/i);
    // The old wording is what came back verbatim in the answer.
    expect(instruction).not.toMatch(/produce the final polished version/i);
  });
});

describe('refinement-preamble detection', () => {
  it.each([
    ["Certainly. Here's the final polished version, incorporating all improvements."],
    ['Sure, here is the revised answer.'],
    ['Here is the improved version:'],
    ["I've polished the draft as requested."],
  ])('rejects meta-commentary: %s', (text) => {
    expect(strategy().looksLikeRefinementPreamble(text)).toBe(true);
  });

  it.each([
    ['PIS 10, COFINS 20, diferencas 0.'],
    ['391'],
    ['A resposta e 391 porque 17 x 23 = 391.'],
    ['Certainly is an adverb, and here is why that matters.'],
    ['Here are the three gates that failed.'],
  ])('accepts a real answer: %s', (text) => {
    // A false positive costs the refinement and keeps the validated answer, so
    // the detector errs toward accepting — but it must not be so loose that it
    // fires on ordinary prose that merely starts with a similar word.
    expect(strategy().looksLikeRefinementPreamble(text)).toBe(false);
  });
});
