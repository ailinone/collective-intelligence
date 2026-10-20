// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * chat-service-identity.test.ts — the A2 guard (CAT-001).
 *
 * Covers BOTH identities' paths through the /v1/models + /v1/models/list
 * pre-handler: the dedicated chat service credential (CHAT_SERVICE_MODELS_KEY,
 * presented via x-api-key or Authorization: Bearer) is 403'd on
 * ?all=true / ?scope=all with the structured `catalog_bulk_forbidden` body,
 * while every OTHER identity (no credential, the shared gateway key, an
 * arbitrary API key) keeps byte-identical access. Unset env ⇒ inert (safe
 * default). The secret comparison is constant-time and the guard never reads
 * anything but the raw credential + querystring (these routes are public —
 * request.apiKey is never populated on them).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  catalogBulkForbiddenBody,
  chatServiceModelsKey,
  isChatServiceIdentity,
  rejectCatalogBulkForChatServicePreHandler,
} from '@/services/chat-service-identity';

const CHAT_KEY = 'chat-service-models-key-e2f1';
const OTHER_KEY = 'some-other-credential';

function fakeRequest(options: {
  url?: string;
  query?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}): FastifyRequest {
  return {
    id: 'req-1',
    url: options.url ?? '/v1/models',
    headers: options.headers ?? {},
    query: options.query ?? {},
  } as unknown as FastifyRequest;
}

function fakeReply() {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    send(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
}

beforeEach(() => {
  process.env.CHAT_SERVICE_MODELS_KEY = CHAT_KEY;
});

afterEach(() => {
  delete process.env.CHAT_SERVICE_MODELS_KEY;
});

describe('identity recognition', () => {
  it('recognizes the chat identity via x-api-key', () => {
    expect(isChatServiceIdentity(fakeRequest({ headers: { 'x-api-key': CHAT_KEY } }))).toBe(true);
  });

  it('recognizes the chat identity via Authorization: Bearer', () => {
    expect(
      isChatServiceIdentity(fakeRequest({ headers: { authorization: `Bearer ${CHAT_KEY}` } }))
    ).toBe(true);
  });

  it('does NOT recognize other credentials or absent ones', () => {
    expect(isChatServiceIdentity(fakeRequest({ headers: { 'x-api-key': OTHER_KEY } }))).toBe(false);
    expect(isChatServiceIdentity(fakeRequest({ headers: {} }))).toBe(false);
    expect(
      isChatServiceIdentity(fakeRequest({ headers: { authorization: `Bearer ${OTHER_KEY}` } }))
    ).toBe(false);
  });

  it('is inert when CHAT_SERVICE_MODELS_KEY is unset (safe default)', () => {
    delete process.env.CHAT_SERVICE_MODELS_KEY;
    expect(chatServiceModelsKey()).toBeUndefined();
    expect(isChatServiceIdentity(fakeRequest({ headers: { 'x-api-key': CHAT_KEY } }))).toBe(false);
  });

  it('never matches a PREFIX of the configured key (exact secret equality)', () => {
    expect(
      isChatServiceIdentity(fakeRequest({ headers: { 'x-api-key': CHAT_KEY.slice(0, 8) } }))
    ).toBe(false);
    expect(
      isChatServiceIdentity(fakeRequest({ headers: { 'x-api-key': `${CHAT_KEY}-suffix` } }))
    ).toBe(false);
  });
});

// ── The chat identity's path: bulk export refused ───────────────────────────
describe('the chat identity: ?all=true / ?scope=all → structured 403', () => {
  it.each([
    ['/v1/models?all=true', { all: true }],
    ['/v1/models/list?all=true', { all: 'true' }],
    ['/v1/models?scope=all', { scope: 'all' }],
    ['/v1/models/list?scope=all&limit=100', { scope: 'all', limit: 100 }],
  ])('%s is refused with catalog_bulk_forbidden', (url, query) => {
    const request = fakeRequest({
      url,
      query,
      headers: { 'x-api-key': CHAT_KEY },
    });
    const { reply, sent } = fakeReply();

    rejectCatalogBulkForChatServicePreHandler(request, reply);

    expect(sent.status).toBe(403);
    expect(sent.body).toEqual(catalogBulkForbiddenBody());
    expect((sent.body as { code: string }).code).toBe('catalog_bulk_forbidden');
  });

  it('scope values OTHER than "all" are not bulk exports', () => {
    const { reply, sent } = fakeReply();
    rejectCatalogBulkForChatServicePreHandler(
      fakeRequest({
        query: { scope: 'runnable' },
        headers: { 'x-api-key': CHAT_KEY },
      }),
      reply
    );
    expect(sent.status).toBeUndefined();
  });

  it('all=false is not a bulk export', () => {
    const { reply, sent } = fakeReply();
    rejectCatalogBulkForChatServicePreHandler(
      fakeRequest({
        query: { all: false },
        headers: { 'x-api-key': CHAT_KEY },
      }),
      reply
    );
    expect(sent.status).toBeUndefined();
  });
});

// ── Every other identity's path: unchanged ──────────────────────────────────
describe('non-chat identities: byte-identical behavior', () => {
  it.each([
    ['no credential at all (anonymous/public)', {}],
    ['the shared gateway credential', { 'x-api-key': OTHER_KEY }],
    ['bearer credential of another caller', { authorization: `Bearer ${OTHER_KEY}` }],
  ])('%s may still use ?all=true / ?scope=all', (_label, headers) => {
    for (const query of [{ all: true }, { scope: 'all' }, { all: 'true', scope: 'all' }]) {
      const { reply, sent } = fakeReply();
      rejectCatalogBulkForChatServicePreHandler(fakeRequest({ query, headers }), reply);
      expect(sent.status).toBeUndefined();
      expect(sent.body).toBeUndefined();
    }
  });

  it('the chat identity with NO bulk params passes through untouched (paginated calls fine)', () => {
    const { reply, sent } = fakeReply();
    rejectCatalogBulkForChatServicePreHandler(
      fakeRequest({
        query: { limit: 100, offset: 0 },
        headers: { 'x-api-key': CHAT_KEY },
      }),
      reply
    );
    expect(sent.status).toBeUndefined();
  });
});

// ── Route wiring (source-level, house pattern) ──────────────────────────────
describe('A2 route wiring', () => {
  it('the pre-handler is wired on BOTH /v1/models and /v1/models/list', () => {
    const code = readFileSync(
      fileURLToPath(new URL('../../routes/models/models-routes.ts', import.meta.url)),
      'utf8'
    );
    expect(code).toContain('rejectCatalogBulkForChatServicePreHandler');
    // Two registrations (one per list route), each placed in its own route config.
    expect(code.match(/preHandler: rejectCatalogBulkForChatServicePreHandler/g)?.length).toBe(2);
  });

  it('the guard does not touch the strategies catalog route (payload bounded by construction)', () => {
    const code = readFileSync(
      fileURLToPath(new URL('../../routes/models/models-strategies-routes.ts', import.meta.url)),
      'utf8'
    );
    expect(code).not.toContain('rejectCatalogBulkForChatServicePreHandler');
  });
});
