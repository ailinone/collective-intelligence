// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Response-serialization contract for POST /v1/chat/completions.
 *
 * Fastify compiles `chatCompletionResponseSchema` with fast-json-stringify and
 * serializes every 200 through it. A value the schema does not describe is not
 * coerced or dropped — fast-json-stringify throws, Fastify turns that into a
 * 500, and the caller gets `{"error":{"code":"internal_error"}}` with no clue
 * that the model actually answered.
 *
 * That is what happened here. In the OpenAI wire format an assistant message
 * that carries `tool_calls` has `content: null`. The schema described `content`
 * as `oneOf: [string, array]` with no null branch, while its own siblings
 * `refusal` and `tool_calls` both had one — so null content was the single
 * unhandled shape in the object.
 *
 * It stayed unreachable only by accident: `executeToolCallsAutomatically`
 * overwrote `message.content` with a summary string on its way out, so nothing
 * ever tried to serialize a null. Fixing that (#404) — so client-owned tool
 * calls are returned to the client instead of being eaten by the gateway —
 * made the correct shape reachable and every tool-call response began 500ing.
 *
 * These assertions mount the real exported schema on a real Fastify instance and
 * go through `inject`, so they exercise the same compile-and-serialize path that
 * produced the 500 — no network, no provider, no database. The live provider
 * suites skip without credentials, which is why this never surfaced there.
 */

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { chatCompletionResponseSchema } from './chat-routes';

/** Serializes `payload` exactly as the real route would, returning the reply. */
async function serializeThroughRoute(payload: unknown) {
  const app = Fastify();
  app.post('/v1/chat/completions', {
    schema: { response: { 200: chatCompletionResponseSchema } },
    handler: async () => payload,
  });
  try {
    return await app.inject({ method: 'POST', url: '/v1/chat/completions' });
  } finally {
    await app.close();
  }
}

const base = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1_787_582_000,
  model: 'ailin-auto',
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const toolCall = {
  id: 'call_abc123',
  type: 'function',
  function: { name: 'conciliar_pis_cofins', arguments: '{"competencia":"09.2024"}' },
};

describe('chat completion response serialization', () => {
  it('serializes an assistant message whose content is null because it carries tool_calls', async () => {
    const response = {
      ...base,
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: { role: 'assistant', content: null, tool_calls: [toolCall] },
        },
      ],
    };

    // Before the fix Fastify answered 500 here, because fast-json-stringify threw:
    //   The value of '#/properties/choices/items/properties/message/properties/content'
    //   does not match schema definition.
    const reply = await serializeThroughRoute(response);
    expect(reply.statusCode).toBe(200);
    const round = reply.json();

    expect(round.choices[0].message.content).toBeNull();
    expect(round.choices[0].finish_reason).toBe('tool_calls');
    expect(round.choices[0].message.tool_calls).toHaveLength(1);
    expect(round.choices[0].message.tool_calls[0].function.name).toBe('conciliar_pis_cofins');
    // The arguments must survive verbatim — a fiscal tool call is not re-parseable guesswork.
    expect(round.choices[0].message.tool_calls[0].function.arguments).toBe(
      '{"competencia":"09.2024"}'
    );
  });

  it('still serializes an ordinary string-content answer', async () => {
    const round = (
      await serializeThroughRoute({
        ...base,
        choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Olá.' } },
        ],
      })
    ).json();
    expect(round.choices[0].message.content).toBe('Olá.');
    expect(round.choices[0].finish_reason).toBe('stop');
  });

  it('still serializes multimodal array content', async () => {
    const round = (
      await serializeThroughRoute({
        ...base,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: [{ type: 'text', text: 'parte' }] },
          },
        ],
      })
    ).json();
    expect(round.choices[0].message.content).toEqual([{ type: 'text', text: 'parte' }]);
  });

  it('tolerates a provider that omits finish_reason rather than 500ing', async () => {
    const round = (
      await serializeThroughRoute({
        ...base,
        choices: [
          {
            index: 0,
            finish_reason: null,
            message: { role: 'assistant', content: null, tool_calls: [toolCall] },
          },
        ],
      })
    ).json();
    expect(round.choices[0].finish_reason).toBeNull();
    expect(round.choices[0].message.tool_calls).toHaveLength(1);
  });
});
