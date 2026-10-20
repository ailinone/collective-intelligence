// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * chat-service-identity.ts — the dedicated chat M2M audience key + the
 * `?all=true` / `?scope=all` bulk ban on the model catalog list routes
 * (CAT-001 / A2).
 *
 * ## Why the credential VALUE, not an api_keys row id
 *
 * The free-tier/anonymous-guest precedent (`rejectChatFreeTierKeyPreHandler`)
 * scopes by an api_keys row id — but those routes run behind the global
 * apiKeyAuthMiddleware, which populates `request.apiKey`. `/v1/models` and
 * `/v1/models/list` are in PUBLIC_ROUTES (api-key-auth-middleware.ts) — the
 * catalog is readable with no credential at all, so `request.apiKey` is NEVER
 * populated there and there is no row id to match on. The dedicated chat
 * identity is therefore recognized the only way a public route can: by the
 * raw presented credential (`x-api-key` header or `Authorization: Bearer`)
 * matching `CHAT_SERVICE_MODELS_KEY` exactly.
 *
 * ## Choice of mechanism (documented per the Phase 1 plan)
 *
 * Of the two options the plan named — recognizing the chat repo's
 * `ci_actor_token.py` client-credentials flow vs a dedicated service API key
 * via env — the static service key is the one the EXISTING infra supports
 * most directly: it needs no JWKS/OIDC validation on a public route, and the
 * chat BFF already presents a static key today (the shared gateway key); this
 * swaps WHICH secret it presents, not the auth scheme. Deployment: provision
 * `CHAT_SERVICE_MODELS_KEY` on ci and have chat's models proxy present it —
 * that both isolates chat's rate-bucket from the shared gateway key (the
 * coupling CAT-001 calls out) and makes the bulk ban enforceable.
 *
 * ## Scope of the ban
 *
 * `?all=true` streams the ENTIRE ~64k-row catalog as one JSON array — the
 * payload-size surface CAT-001 refuses for chat, whose `/api/models` proxy is
 * the caller that historically bulk-loaded ~20k rows into browser memory.
 * `?scope=all` widens the result set the same way. When a request presents
 * the chat identity AND asks for either, it gets a structured 403
 * (`catalog_bulk_forbidden`). Every other identity — including anonymous —
 * is untouched: the ban narrows what the CHAT CREDENTIAL may do, never what
 * anyone else may do. Unset env ⇒ the guard is inert (safe default, same as
 * the free-tier key gate).
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'chat-service-identity' });

/** The dedicated chat service key VALUE. Unset ⇒ the chat identity does not
 * exist and the bulk ban never fires. */
export function chatServiceModelsKey(): string | undefined {
  const key = process.env.CHAT_SERVICE_MODELS_KEY?.trim();
  return key ? key : undefined;
}

/** Constant-time equality over the two secrets (a public route compares
 * attacker-controlled input on every request — never use `===` for this). */
function secretMatches(presented: string, configured: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(configured, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Whether this request carries the chat service identity: the presented
 * credential — `x-api-key` (string or the first element of an array) or an
 * `Authorization: Bearer <key>` — equals CHAT_SERVICE_MODELS_KEY.
 */
export function isChatServiceIdentity(request: FastifyRequest): boolean {
  const configured = chatServiceModelsKey();
  if (!configured) return false;

  const headerBag = request.headers as Record<string, string | string[] | undefined>;
  const presented: string | undefined = (() => {
    const xApiKey = headerBag['x-api-key'];
    if (typeof xApiKey === 'string' && xApiKey.length > 0) return xApiKey;
    if (Array.isArray(xApiKey)) {
      const first = xApiKey.find((value) => typeof value === 'string' && value.length > 0);
      if (first) return first;
    }
    const authorization = headerBag.authorization;
    if (typeof authorization === 'string' && /^bearer\s+/i.test(authorization)) {
      const token = authorization.replace(/^bearer\s+/i, '').trim();
      if (token.length > 0) return token;
    }
    return undefined;
  })();

  return presented !== undefined && secretMatches(presented, configured);
}

/** The structured 403 body (CAT-001 contract). */
export function catalogBulkForbiddenBody(): {
  code: 'catalog_bulk_forbidden';
  message: string;
} {
  return {
    code: 'catalog_bulk_forbidden',
    message:
      'The chat service identity may not request bulk catalog exports (?all=true / ?scope=all). ' +
      'Use the paginated list, the strategy catalog (GET /v1/models/strategies), or resolve ' +
      'individual targets via GET /v1/models/:id.',
  };
}

/** Whether the parsed querystring asks for the unbounded/full-scope export. */
function requestsBulkExport(query: unknown): boolean {
  if (!query || typeof query !== 'object') return false;
  const q = query as Record<string, unknown>;
  const all = q.all === true || q.all === 'true';
  const scopeAll = q.scope === 'all';
  return all || scopeAll;
}

/**
 * Route preHandler for GET /v1/models and GET /v1/models/list: structured 403
 * when the CHAT identity asks for `?all=true` or `?scope=all`. Every other
 * request — including chat's own paginated calls — passes through untouched.
 * Runs after the global middleware (which does NOT populate request.apiKey on
 * these public routes; see the module header for why the identity check reads
 * the raw credential instead). Must stay async: fastify 5.12.5 deadlocks on
 * sync preHandlers that return undefined (request hangs past the preHandler
 * stage — reproduced on inject() and a real listener).
 */
export async function rejectCatalogBulkForChatServicePreHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!isChatServiceIdentity(request)) return;
  if (!requestsBulkExport(request.query)) return;
  log.warn(
    { requestId: request.id, url: request.url },
    'catalog_bulk_forbidden: the chat service identity requested a bulk catalog export'
  );
  await reply.status(403).send(catalogBulkForbiddenBody());
}
