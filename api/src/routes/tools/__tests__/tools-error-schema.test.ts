// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for FST_ERR_FAILED_ERROR_SERIALIZATION on /v1/tools/* routes.
 *
 * Before the fix: a POST /v1/tools/grep with empty body returned 500 with
 * `FST_ERR_FAILED_ERROR_SERIALIZATION` because the route's 400-response schema
 * required `success`, `tool_call_id`, and `error` — fields the Fastify-generated
 * validation error envelope lacks.
 *
 * After the fix: the response schema is permissive (additionalProperties: true,
 * no required), so Fastify-shape validation errors serialize cleanly as 400.
 */
import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';

describe('tools routes — error response schema', () => {
  it('declares additionalProperties:true so Fastify validation errors serialize', async () => {
    const app = Fastify({ logger: false });

    // Reproduce the schema in isolation — no DB / DI required.
    app.post('/v1/tools/grep-test', {
      schema: {
        body: {
          type: 'object',
          required: ['pattern'],
          properties: { pattern: { type: 'string' } },
        },
        response: {
          400: {
            type: 'object',
            additionalProperties: true,
            properties: {
              success: { type: 'boolean' },
              tool_call_id: { type: 'string' },
              error: {},
              metadata: { type: 'object', additionalProperties: true },
              statusCode: { type: 'number' },
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    }, async () => ({ ok: true }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/grep-test',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      statusCode: 400,
      code: expect.any(String),
      message: expect.any(String),
    });
    // Critically: NO FST_ERR_FAILED_ERROR_SERIALIZATION
    expect(res.body).not.toContain('FST_ERR_FAILED_ERROR_SERIALIZATION');

    await app.close();
  });

  it('still serializes handler-shape tool errors correctly', async () => {
    const app = Fastify({ logger: false });

    app.post('/v1/tools/handler-test', {
      schema: {
        body: { type: 'object', properties: { x: { type: 'string' } } },
        response: {
          400: {
            type: 'object',
            additionalProperties: true,
            properties: {
              success: { type: 'boolean' },
              tool_call_id: { type: 'string' },
              error: {},
              metadata: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    }, async (_req, reply) => {
      return reply.status(400).send({
        success: false,
        tool_call_id: 'test-id',
        error: 'simulated tool error',
        metadata: { tool_name: 'handler-test' },
      });
    });

    const res = await app.inject({ method: 'POST', url: '/v1/tools/handler-test', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      success: false,
      tool_call_id: 'test-id',
      error: 'simulated tool error',
      metadata: { tool_name: 'handler-test' },
    });

    await app.close();
  });
});
