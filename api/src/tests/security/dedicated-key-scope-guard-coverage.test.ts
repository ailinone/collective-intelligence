// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Coverage guard for the two DEDICATED, single-purpose M2M API keys.
 *
 * Background — the thing this test exists to stop from silently regressing:
 *
 *   Two API keys are provisioned for exactly one narrow job each:
 *     - the anonymous-guest key (`ANONYMOUS_GUEST_API_KEY_ID`) — only
 *       `POST /v1/chat/completions` with `model:"ailin-economy"` + the
 *       `X-Anonymous-Visitor-Id` header;
 *     - the chat-free-tier key (`CHAT_FREE_TIER_API_KEY_ID`) — only
 *       `POST /v1/chat/completions` with `model:"ailin-auto"`.
 *
 *   There is NO per-key "allowed routes" concept in this codebase.
 *   `ApiKey.permissions` cannot express "restrict to this one model on this one
 *   endpoint" (see docs/anonymous-chat-guest-key-setup.md), so scoping these two
 *   credentials is 100% dependent on every route file that an API key can reach
 *   remembering to wire `rejectAnonymousGuestKeyPreHandler` +
 *   `rejectChatFreeTierKeyPreHandler`. A NEW route file added later would
 *   reintroduce the gap silently — a leaked key (or a chat-backend bug) would
 *   get free, unmetered, uncounted access to images / embeddings / videos /
 *   code-execution / fine-tuning / vector-stores, i.e. real cost and real
 *   capability, not "a few free chat completions".
 *
 * This test is STATIC on purpose: it reads the route files' source text rather
 * than booting a server, so it costs nothing in CI and cannot be defeated by a
 * route that fails to register for an unrelated reason.
 *
 * Reachability model (the reason nearly every route file needs the guard):
 * `apiKeyAuthMiddleware` is registered as a GLOBAL `preHandler` hook in
 * `src/index.ts`. It authenticates — and populates `request.apiKey` — for EVERY
 * path under `PROTECTED_ROUTE_PREFIXES` that is not listed in `PUBLIC_ROUTES`,
 * regardless of whether the route file wires an `authenticate` preHandler of its
 * own. So "this route only takes JWT sessions" is not, by itself, a reason to
 * skip the guard.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PUBLIC_ROUTES,
  PROTECTED_ROUTE_PREFIXES,
} from '@/api/middleware/api-key-auth-middleware';

const ROUTES_DIR = fileURLToPath(new URL('../../routes', import.meta.url));

const ANON_GUARD = 'rejectAnonymousGuestKeyPreHandler';
const FREE_TIER_GUARD = 'rejectChatFreeTierKeyPreHandler';

/**
 * Route files that legitimately carry NO guard, each with the reason it can
 * never be reached by either dedicated key. Adding an entry here is a
 * deliberate, reviewable act — which is the whole point of keeping the list in
 * the test rather than inferring the exemption.
 */
const EXEMPT: Record<string, string> = {
  // These two ALLOW the keys for their one legitimate request shape and reject
  // every other shape with their own finer-grained inline 403
  // (`anonymous_key_scope_violation` / `chat_free_tier_key_scope_violation`).
  // Wiring the blanket-reject preHandler here would 403 real anonymous and
  // free-tier traffic — see the separate assertion below that pins this.
  'chat/chat-routes.ts': 'has its own finer-grained inline scope checks (must ALLOW the keys)',
  'responses/responses-routes.ts': 'has its own finer-grained inline scope check',

  // Not a Fastify module at all: a framework-neutral descriptor factory that is
  // intentionally never imported by the runtime bootstrap, so it has no
  // preHandler chain to wire a guard into.
  'admin/routing-admin-routes.ts': 'framework-neutral route-descriptor factory, never registered',

  // `/v1/internal` is in PUBLIC_ROUTES precisely so the global user-auth hook
  // does NOT run: these routes are authorized by `requireServiceAuth` (the
  // id-minted service token + X-Acting-User) and never resolve an `api_keys`
  // row, so `request.apiKey` is never populated and an M2M API key can never
  // authenticate here in the first place.
  'internal/internal-api-keys-routes.ts': 'service-token auth only (/v1/internal is not API-key auth)',
  'internal/internal-usage-routes.ts': 'service-token auth only (/v1/internal is not API-key auth)',
  'internal/internal-wallet-routes.ts': 'service-token auth only (/v1/internal is not API-key auth)',

  // Registers only `/v1/models` + `/v1/models/list`, both in PUBLIC_ROUTES, and
  // carries no route-level auth: the public catalog is readable with no
  // credential at all, so `request.apiKey` is never populated and restricting
  // the dedicated keys here would protect nothing anyone else cannot already read.
  'models/models-routes.ts': 'public model catalog — no auth, no request.apiKey',

  // Same shape: `/v1/status*` is in PUBLIC_ROUTES with no route-level auth.
  'status/status-routes.ts': 'public status endpoints — no auth, no request.apiKey',

  // A three-line re-export of `user-routes-clean.ts`; registers nothing itself.
  'user/user-routes.ts': 're-export shim, registers no routes',
};

function listRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('-routes.ts'))
    .map((rel) => rel.split(path.sep).join('/'))
    .sort();
}

/** Mirrors `isPublicRoute` in api-key-auth-middleware.ts. */
function isPublicRoute(p: string): boolean {
  return PUBLIC_ROUTES.some((route) =>
    route.endsWith('/') ? p.startsWith(route) : p === route || p.startsWith(`${route}/`)
  );
}

/** Mirrors `isProtectedRoute` in api-key-auth-middleware.ts. */
function isProtectedRoute(p: string): boolean {
  return PROTECTED_ROUTE_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(`${prefix}/`)
  );
}

/**
 * Every path-like string literal in the file. Deliberately over-inclusive (it
 * also picks up paths named in comments): over-matching pushes a file TOWARD
 * needing the guard, which is the safe direction for a security backstop.
 */
function pathLiterals(src: string): string[] {
  return [...src.matchAll(/['"`](\/[A-Za-z0-9_\-./:*{}]*)['"`]/g)].map((m) => m[1]);
}

/** Route-level auth preHandlers, any of which populate `request.apiKey`. */
function hasRouteLevelAuth(src: string): boolean {
  return (
    /\b(?:preHandler|onRequest)\b[\s\S]{0,80}?\bauthenticate(?:Request)?\b/.test(src) ||
    /authenticatedServer\.authenticate/.test(src)
  );
}

function acceptsApiKeyAuth(src: string): boolean {
  if (hasRouteLevelAuth(src)) return true;
  // No route-level auth — but the GLOBAL apiKeyAuthMiddleware still
  // authenticates (and sets request.apiKey on) any protected, non-public path.
  return pathLiterals(src).some((p) => isProtectedRoute(p) && !isPublicRoute(p));
}

const routeFiles = listRouteFiles();
const sources = new Map(
  routeFiles.map((rel) => [rel, readFileSync(path.join(ROUTES_DIR, rel), 'utf8')])
);

describe('dedicated-key scope-guard coverage across *-routes.ts', () => {
  it('finds the route files (sanity — a broken glob must not vacuously pass)', () => {
    expect(routeFiles.length).toBeGreaterThan(50);
    expect(routeFiles).toContain('chat/chat-routes.ts');
    expect(routeFiles).toContain('images/images-routes.ts');
  });

  it('every route file reachable with an API key wires at least one scope guard', () => {
    const unguarded = routeFiles.filter((rel) => {
      if (rel in EXEMPT) return false;
      const src = sources.get(rel) as string;
      if (!acceptsApiKeyAuth(src)) return false;
      return !src.includes(ANON_GUARD) && !src.includes(FREE_TIER_GUARD);
    });

    expect(
      unguarded,
      'These route files accept API-key authentication but wire neither ' +
        `${ANON_GUARD} nor ${FREE_TIER_GUARD}. The dedicated anonymous-guest / ` +
        'chat-free-tier keys would reach them with full, unmetered access. Wire both ' +
        "guards as preHandlers AFTER the route's own auth preHandler, or add an entry " +
        'to EXEMPT in this test explaining why the key can never authenticate there.'
    ).toEqual([]);
  });

  it('wires BOTH guards wherever either one is wired (they are always a pair)', () => {
    const halfGuarded = routeFiles.filter((rel) => {
      if (rel in EXEMPT) return false;
      const src = sources.get(rel) as string;
      const anon = src.includes(ANON_GUARD);
      const free = src.includes(FREE_TIER_GUARD);
      return anon !== free;
    });
    expect(halfGuarded).toEqual([]);
  });

  it('every EXEMPT entry still names a real file (no stale exemptions)', () => {
    const stale = Object.keys(EXEMPT).filter((rel) => !routeFiles.includes(rel));
    expect(stale).toEqual([]);
  });

  it('each guard is placed AFTER the auth preHandler it depends on', () => {
    // `request.apiKey` does not exist until auth has run; a guard listed before
    // `authenticate` in the same array silently never fires.
    const misordered: string[] = [];
    let arraysInspected = 0;
    for (const rel of routeFiles) {
      const src = sources.get(rel) as string;
      const arrays = src.matchAll(
        /(?:preHandler:|onRequest:|PreHandler\s*=)\s*(\[[^\]]*\])/g
      );
      for (const [, block] of arrays) {
        arraysInspected += 1;
        if (!block.includes(ANON_GUARD) && !block.includes(FREE_TIER_GUARD)) continue;
        const authAt = block.search(/\bauthenticate(?:Request)?\b|authenticatedServer\.authenticate/);
        if (authAt === -1) continue; // no auth in this array (e.g. global-auth-only routes)
        const guardAt = Math.min(
          ...[block.indexOf(ANON_GUARD), block.indexOf(FREE_TIER_GUARD)].filter((i) => i >= 0)
        );
        if (guardAt < authAt) misordered.push(`${rel}: ${block.slice(0, 80)}`);
      }
    }
    // Guard against the check silently matching nothing (a regex typo here would
    // make this test vacuously pass forever).
    expect(arraysInspected).toBeGreaterThan(50);
    expect(misordered).toEqual([]);
  });

  it('does NOT wire the blanket-reject preHandler into chat/responses routes', () => {
    // Regression guard in the OTHER direction: these two must keep allowing the
    // keys' one legitimate request shape. Wiring the unconditional preHandler
    // here would 403 all real anonymous / free-tier chat traffic in production.
    for (const rel of ['chat/chat-routes.ts', 'responses/responses-routes.ts']) {
      const src = sources.get(rel) as string;
      expect(src, `${rel} must not wire ${ANON_GUARD}`).not.toContain(ANON_GUARD);
      expect(src, `${rel} must not wire ${FREE_TIER_GUARD}`).not.toContain(FREE_TIER_GUARD);
    }
    // ...and must still carry their own inline scope checks.
    expect(sources.get('chat/chat-routes.ts')).toContain('anonymous_key_scope_violation');
    expect(sources.get('chat/chat-routes.ts')).toContain('chat_free_tier_key_scope_violation');
    expect(sources.get('responses/responses-routes.ts')).toContain(
      'anonymous_key_scope_violation'
    );
  });
});

describe('the two guard primitives reject only their own key', () => {
  const ANON_ENV = 'ANONYMOUS_GUEST_API_KEY_ID';
  const FREE_ENV = 'CHAT_FREE_TIER_API_KEY_ID';

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
    return { reply, sent };
  }

  it('rejectIfChatFreeTierKeyOutOfScope 403s the free-tier key and nothing else', async () => {
    const { rejectIfChatFreeTierKeyOutOfScope } = await import('@/services/free-tier-quota-gate');
    const prev = process.env[FREE_ENV];
    process.env[FREE_ENV] = 'free-tier-key-id';
    try {
      const hit = fakeReply();
      expect(
        rejectIfChatFreeTierKeyOutOfScope('free-tier-key-id', hit.reply as never)
      ).toBe(true);
      expect(hit.sent.status).toBe(403);
      expect(hit.sent.body).toMatchObject({
        error: { code: 'chat_free_tier_key_scope_violation' },
      });

      const miss = fakeReply();
      expect(rejectIfChatFreeTierKeyOutOfScope('some-other-key', miss.reply as never)).toBe(false);
      expect(rejectIfChatFreeTierKeyOutOfScope(undefined, miss.reply as never)).toBe(false);
      expect(miss.sent.status).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env[FREE_ENV];
      else process.env[FREE_ENV] = prev;
    }
  });

  it('is inert when CHAT_FREE_TIER_API_KEY_ID is unset (safe default)', async () => {
    const { rejectIfChatFreeTierKeyOutOfScope } = await import('@/services/free-tier-quota-gate');
    const prev = process.env[FREE_ENV];
    delete process.env[FREE_ENV];
    try {
      const r = fakeReply();
      expect(rejectIfChatFreeTierKeyOutOfScope(undefined, r.reply as never)).toBe(false);
      expect(r.sent.status).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env[FREE_ENV] = prev;
    }
  });

  it('the two guards do not cross-reject each other’s key', async () => {
    const { rejectIfChatFreeTierKeyOutOfScope } = await import('@/services/free-tier-quota-gate');
    const { rejectIfAnonymousGuestKeyOutOfScope } = await import('@/services/anonymous-quota-gate');
    const prevAnon = process.env[ANON_ENV];
    const prevFree = process.env[FREE_ENV];
    process.env[ANON_ENV] = 'anon-key-id';
    process.env[FREE_ENV] = 'free-key-id';
    try {
      const a = fakeReply();
      expect(rejectIfChatFreeTierKeyOutOfScope('anon-key-id', a.reply as never)).toBe(false);
      const b = fakeReply();
      expect(rejectIfAnonymousGuestKeyOutOfScope('free-key-id', b.reply as never)).toBe(false);
    } finally {
      if (prevAnon === undefined) delete process.env[ANON_ENV];
      else process.env[ANON_ENV] = prevAnon;
      if (prevFree === undefined) delete process.env[FREE_ENV];
      else process.env[FREE_ENV] = prevFree;
    }
  });
});
