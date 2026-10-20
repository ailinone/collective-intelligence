// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The preSerialization hook in request-context.ts normalizes every >=400
 * object payload into the standard error envelope. It used to REBUILD the
 * payload unconditionally, discarding route-specific envelope extensions
 * (the free-tier 429's reset_at + credits_continue offer, the wallet 402's
 * balance_usd/required_usd) before the route's response-schema serializer
 * ran. These tests pin the passthrough for already-standard payloads while
 * keeping normalization for payloads that lack error.code.
 */

import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { registerRequestContext } from '@/api/middleware/request-context';

async function build() {
  const app = Fastify();
  // Fastify hooks are ENCAPSULATED: `app.register(requestContextMiddleware)`
  // would attach the hooks to a NESTED scope, so routes registered as
  // siblings never see them (a vacuous pass). Production uses
  // registerRequestContext(), which invokes the plugin function directly on
  // the root instance — use the same path here.
  await registerRequestContext(app);
  app.post('/standard-error', async (_req, reply) => {
    reply.status(429);
    return {
      error: {
        code: 'free_quota_exceeded',
        message: 'free messages used',
        reset_at: '2026-10-03T00:00:00.000Z',
      },
      credits_continue: { balance_usd: 1.5, model_cell: 'auto:base' },
    };
  });
  app.post('/nonstandard-error', async (_req, reply) => {
    reply.status(400);
    return { error: { message: 'no code here' } };
  });
  await app.ready();
  return app;
}

describe('request-context preSerialization error passthrough', () => {
  it('leaves an already-standard error payload untouched (route extras survive)', async () => {
    const app = await build();
    try {
      const res = await app.inject({ method: 'POST', url: '/standard-error' });
      expect(res.statusCode).toBe(429);
      const body = res.json();
      expect(body.error.code).toBe('free_quota_exceeded');
      expect(body.error.message).toBe('free messages used');
      expect(body.error.reset_at).toBe('2026-10-03T00:00:00.000Z');
      expect(body.credits_continue).toEqual({ balance_usd: 1.5, model_cell: 'auto:base' });
    } finally {
      await app.close();
    }
  });

  it('still normalizes a payload whose error has no code', async () => {
    const app = await build();
    try {
      const res = await app.inject({ method: 'POST', url: '/nonstandard-error' });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(typeof body.error.code).toBe('string');
      expect(body.error.code.length).toBeGreaterThan(0);
      expect(body.error.message).toBe('no code here');
      expect(typeof body.requestId).toBe('string');
    } finally {
      await app.close();
    }
  });
});
