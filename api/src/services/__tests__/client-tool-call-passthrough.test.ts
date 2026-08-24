// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * A caller that supplies its own `tools` owns the resulting `tool_calls`.
 *
 * By the OpenAI tool-calling contract the gateway must return those calls so
 * the caller can execute them. Two independent layers used to intercept them
 * instead:
 *
 *   1. `base-strategy.executeModelWithTools` ran EVERY tool call through
 *      `toolRegistry`. A client-owned name is not in that registry, so
 *      `Tool "X" not found in registry.` came back, was appended as a
 *      role:'tool' message, and the loop re-prompted the model with its own
 *      tool "failing". The model apologised in prose and the caller received a
 *      response with no tool_calls at all.
 *
 *   2. `chat-request-processor.executeToolCallsAutomatically` ran ungated on
 *      every non-streaming completion and overwrote `message.content` with
 *      "Executed 1 tool call(s): 0 succeeded, 1 failed."
 *
 * Layer 1 is the mechanism behind the PIS/COFINS agent never invoking
 * `conciliar_pis_cofins` in production: the schema reached the model, the model
 * emitted the call, and the strategy loop consumed it.
 *
 * Both layers must now fail closed toward the caller: auto-execute only tools
 * this server registered with `safeForStrategies: true`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CLIENT_TOOL = 'conciliar_pis_cofins';
const SERVER_TOOL = 'web_search';

function toolCall(name: string, id = 'call_1') {
  return { id, type: 'function' as const, function: { name, arguments: '{}' } };
}

function responseWith(names: string[]) {
  return {
    id: 'resp-1',
    object: 'chat.completion' as const,
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant' as const,
          content: '',
          tool_calls: names.map((n, i) => toolCall(n, `call_${i}`)),
        },
        finish_reason: 'tool_calls' as const,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** Mirrors the guard both layers now apply. */
function serverOwnsEveryToolCall(
  registry: {
    isInitialized: () => boolean;
    get: (n: string) => { safeForStrategies: boolean } | undefined;
  },
  calls: Array<{ function: { name: string } }>,
  blocked: Set<string> = new Set()
): boolean {
  return (
    registry.isInitialized() &&
    calls.every(
      (c) =>
        !blocked.has(c.function?.name ?? '') &&
        registry.get(c.function?.name ?? '')?.safeForStrategies === true
    )
  );
}

const registry = {
  isInitialized: () => true,
  get: (n: string) => (n === SERVER_TOOL ? { safeForStrategies: true } : undefined),
};

describe('client-owned tool calls are returned, not executed', () => {
  it('does not claim ownership of a tool the server never registered', () => {
    const r = responseWith([CLIENT_TOOL]);
    expect(serverOwnsEveryToolCall(registry, r.choices[0].message.tool_calls)).toBe(false);
  });

  it('still auto-executes a server-registered, strategy-safe tool', () => {
    const r = responseWith([SERVER_TOOL]);
    expect(serverOwnsEveryToolCall(registry, r.choices[0].message.tool_calls)).toBe(true);
  });

  it('refuses the whole batch when ANY call is client-owned', () => {
    // Mixed batches must fail closed: executing half and reporting failure for
    // the rest is what produced "0 succeeded, 1 failed" in the caller's content.
    const r = responseWith([SERVER_TOOL, CLIENT_TOOL]);
    expect(serverOwnsEveryToolCall(registry, r.choices[0].message.tool_calls)).toBe(false);
  });

  it('respects the chat blocklist even for a registered tool', () => {
    const r = responseWith([SERVER_TOOL]);
    expect(
      serverOwnsEveryToolCall(registry, r.choices[0].message.tool_calls, new Set([SERVER_TOOL]))
    ).toBe(false);
  });

  it('fails closed when the registry has not booted', () => {
    const cold = { isInitialized: () => false, get: () => ({ safeForStrategies: true }) };
    const r = responseWith([SERVER_TOOL]);
    expect(serverOwnsEveryToolCall(cold, r.choices[0].message.tool_calls)).toBe(false);
  });

  it('tolerates a malformed tool call without throwing', () => {
    const malformed = [{ function: {} } as unknown as { function: { name: string } }];
    expect(() => serverOwnsEveryToolCall(registry, malformed)).not.toThrow();
    expect(serverOwnsEveryToolCall(registry, malformed)).toBe(false);
  });
});

describe('source guards are actually wired in', () => {
  const read = (p: string) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:fs').readFileSync(require('node:path').join(__dirname, p), 'utf8');

  it('base-strategy gates its tool loop on server ownership', () => {
    const src = read('../../core/orchestration/base-strategy.ts');
    expect(src).toContain('serverOwnsEveryToolCall');
    expect(src).toContain('safeForStrategies');
  });

  it('chat-request-processor gates auto-execution on server ownership', () => {
    const src = read('../chat-request-processor.ts');
    expect(src).toContain('serverOwnsEveryToolCall');
    expect(src).toContain('client-owned');
  });
});
