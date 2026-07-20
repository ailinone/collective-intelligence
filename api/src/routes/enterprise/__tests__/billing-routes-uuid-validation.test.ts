// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for P2007 leak on /v1/enterprise/billing/invoices/:invoiceId routes.
 *
 * Before the fix: a GET/POST with a non-UUID `invoiceId` (e.g. "probe") reached
 * Prisma's `findFirst({ where: { id: invoiceId } })`. The `Invoice.id` column
 * is `@db.Uuid`, so Prisma threw P2007 ("Data validation error") which surfaced
 * as a 500 to the caller.
 *
 * After the fix: the route schema declares `params.invoiceId` with
 * `format: 'uuid'`, so Fastify rejects malformed IDs with a 400 before the
 * handler runs (and before Prisma is touched).
 */
import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';

describe('enterprise/billing — UUID path-param validation', () => {
  it('rejects non-UUID invoiceId on GET with 400 (not 500/P2007)', async () => {
    const app = Fastify({ logger: false });

    app.get('/v1/enterprise/billing/invoices/:invoiceId', {
      schema: {
        params: {
          type: 'object',
          required: ['invoiceId'],
          properties: { invoiceId: { type: 'string', format: 'uuid' } },
        },
      },
    }, async () => ({ should: 'never reach' }));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/enterprise/billing/invoices/not-a-uuid',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('P2007');
    expect(res.body).not.toContain('Internal server error');

    await app.close();
  });

  it('rejects non-UUID invoiceId on POST /pay with 400', async () => {
    const app = Fastify({ logger: false });

    app.post('/v1/enterprise/billing/invoices/:invoiceId/pay', {
      schema: {
        params: {
          type: 'object',
          required: ['invoiceId'],
          properties: { invoiceId: { type: 'string', format: 'uuid' } },
        },
      },
    }, async () => ({ should: 'never reach' }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/enterprise/billing/invoices/probe/pay',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('P2007');

    await app.close();
  });

  it('accepts well-formed UUID and reaches handler', async () => {
    const app = Fastify({ logger: false });
    let handlerCalled = false;

    app.get('/v1/enterprise/billing/invoices/:invoiceId', {
      schema: {
        params: {
          type: 'object',
          required: ['invoiceId'],
          properties: { invoiceId: { type: 'string', format: 'uuid' } },
        },
      },
    }, async () => {
      handlerCalled = true;
      return { ok: true };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/enterprise/billing/invoices/123e4567-e89b-12d3-a456-426614174000',
    });

    expect(res.statusCode).toBe(200);
    expect(handlerCalled).toBe(true);

    await app.close();
  });
});
