// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * sensitivity-consensus must answer the user, not report its own verdict.
 *
 * Every model call the coordination loop makes is a governance call: the request
 * is pinned to "respond with valid JSON only" against a decision/sensitivities
 * schema, and the user's turn is flattened to a bare task string. So no model in
 * the run is ever asked what the user asked, and the only prose that exists lives
 * inside the JSON envelope.
 *
 * The strategy then rendered an operator record — decision, confidence,
 * rationale, rounds, convergence, dissent — and assigned it straight to
 * `choices[0].message.content`. Production returned exactly that:
 *
 *   "**Decision: answer** (confidence: 100%) Rationale: …"
 *
 * The `391` a probe was looking for appeared only because it happened to sit
 * inside a rationale string. The strategy is reachable by ordinary users: it is
 * the target of the wire alias `fast`.
 */

import { describe, it, expect, vi } from 'vitest';
import { SensitivityConsensusStrategy } from '../sensitivity-consensus-strategy';

type Private = {
  composeFinalAnswer: (
    request: unknown,
    context: unknown,
    models: unknown[]
  ) => Promise<string | null>;
  getAdapterForModel?: unknown;
  executeModel: unknown;
};

const MODEL = { id: 'm1', name: 'M1' };
const REQUEST = { messages: [{ role: 'user', content: 'Quanto e 17 vezes 23?' }] };
const CONTEXT = { requestId: 'r1' };

function build(executeModel: unknown): Private {
  const strategy = new SensitivityConsensusStrategy() as unknown as Private;
  strategy.getAdapterForModel = vi.fn().mockResolvedValue({ id: 'adapter' });
  strategy.executeModel = executeModel;
  return strategy;
}

const reply = (content: unknown, success = true) => ({
  success,
  response: { choices: [{ message: { role: 'assistant', content } }] },
});

describe('sensitivity-consensus answer phase', () => {
  it('returns the model answer, not a decision record', async () => {
    const s = build(vi.fn().mockResolvedValue(reply('391')));
    await expect(s.composeFinalAnswer(REQUEST, CONTEXT, [MODEL])).resolves.toBe('391');
  });

  it('strips a leaked reasoning block unconditionally', async () => {
    // NOT behind isReasoningEnabled. The eligible pool demonstrably contains
    // reasoning models, and executeModel does not strip — so without this the
    // answer arrives as "<think>…</think>391" and one leak is traded for another.
    const s = build(vi.fn().mockResolvedValue(reply('<think>17*23 = 391</think>391')));
    await expect(s.composeFinalAnswer(REQUEST, CONTEXT, [MODEL])).resolves.toBe('391');
  });

  it('returns null when the model call fails, so the engine can recover', async () => {
    // Deliberately NOT falling back to the coordination summary: that is the
    // operator record, and serving it is the bug being fixed. An empty response
    // is picked up by the engine's recoverEmptyFinalResponse instead.
    const s = build(vi.fn().mockResolvedValue(reply('391', false)));
    await expect(s.composeFinalAnswer(REQUEST, CONTEXT, [MODEL])).resolves.toBeNull();
  });

  it('returns null on empty or whitespace-only content', async () => {
    const s = build(vi.fn().mockResolvedValue(reply('   ')));
    await expect(s.composeFinalAnswer(REQUEST, CONTEXT, [MODEL])).resolves.toBeNull();
  });

  it('returns null rather than throwing when the adapter is unavailable', async () => {
    const s = build(vi.fn());
    s.getAdapterForModel = vi.fn().mockResolvedValue(null);
    await expect(s.composeFinalAnswer(REQUEST, CONTEXT, [MODEL])).resolves.toBeNull();
  });

  it('returns null when there is no eligible model', async () => {
    const s = build(vi.fn());
    await expect(s.composeFinalAnswer(REQUEST, CONTEXT, [])).resolves.toBeNull();
  });

  it('asks the model the ORIGINAL user request', async () => {
    // The whole defect in one assertion: the coordination loop only ever sends
    // governance prompts, so the answer phase must carry the user's own turn.
    const executeModel = vi.fn().mockResolvedValue(reply('391'));
    const s = build(executeModel);
    await s.composeFinalAnswer(REQUEST, CONTEXT, [MODEL]);
    expect(executeModel).toHaveBeenCalledTimes(1);
    expect(executeModel.mock.calls[0][2]).toBe(REQUEST);
  });

  it('survives a throwing model call', async () => {
    const s = build(vi.fn().mockRejectedValue(new Error('provider exploded')));
    await expect(s.composeFinalAnswer(REQUEST, CONTEXT, [MODEL])).resolves.toBeNull();
  });
});
