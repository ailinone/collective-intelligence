// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * free-tier-quota-gate.ts — daily free-message cap for AUTHENTICATED chat
 * users on the `ailin-auto` preset alias.
 *
 * SAFE BY CONSTRUCTION, same shape as anonymous-quota-gate.ts — this gate
 * only ever fires for ONE designated, DB-backed API key id
 * (`CHAT_FREE_TIER_API_KEY_ID`). It does NOT key on `organizationId`.
 *
 * WHY THIS MATTERS (history, kept for context): `ailin-auto` is not
 * chat-specific — `financial/src/utils/aiAssistantGateway.ts` sets it as
 * `DEFAULT_GATEWAY_MODEL`, and `guide/apps/v4/lib/playground.ts` +
 * `guide/apps/v4/components/guide/llm-playground.tsx` ship a live,
 * real-token interactive playground that defaults to `ailin-auto` against
 * both `/v1/chat/completions` and `/v1/responses`. `organizationId` is a
 * platform-wide identity (Ailin ID/SSO) shared across chat/financial/guide/id
 * for the same customer, and ci has no per-request signal saying which
 * product an org-scoped JWT request came from — so an org-keyed counter over
 * `ailin-auto` could NOT be made chat-specific; enabling it would have capped
 * every product's `ailin-auto` usage for that org, platform-wide. That is why
 * an earlier revision of this file shipped the flag permanently defaulted off
 * with no safe way to enable it.
 *
 * The fix is the same one that already makes anonymous-quota-gate.ts safe:
 * scope by a specific API key id, not by organization. Chat's backend must
 * present this one dedicated key — never its normal shared session auth —
 * specifically for the outbound request where the resolved model is the
 * free-tier default (`ailin-auto`, unforced by an explicit paid model
 * choice). A request authenticated any other way (financial, guide, id, or
 * chat's own normal per-user auth before/after this) can never match this
 * key id, so it can never be counted or capped here — structurally, not by
 * convention. See docs/chat-free-tier-key-setup.md for provisioning.
 *
 * Scope, by construction:
 *  - Only ever evaluated when BOTH (a) the request authenticated with the
 *    ONE designated key id (`CHAT_FREE_TIER_API_KEY_ID`) AND (b) the RAW,
 *    client-submitted `model` field (read BEFORE `normalizeChatRequest`
 *    rewrites it to `'auto'` for every `ailin-*` alias) is literally
 *    `ailin-auto` — mirrors `anonymous-quota-gate.ts`'s `inAnonymousQuotaScope`
 *    exactly, including reading the RAW field so normalization can't cause a
 *    mismatch. Any other key or model is a complete no-op.
 *  - If `CHAT_FREE_TIER_API_KEY_ID` is unset, the gate never fires for
 *    anyone (safe default). If it resolves to no active `api_keys` row, same
 *    silent-inert failure mode as the anonymous key — see
 *    `checkChatFreeTierApiKeyConfig` below, which turns that into a loud
 *    boot-time log line instead of silent no-op.
 *  - Deliberately does NOT match bare `model:"auto"` / an omitted model, even
 *    though both currently execute identically to `ailin-auto`. `auto`/
 *    omitted is the platform's pre-existing, always-free, zero-preference
 *    default for every authenticated caller on every product — bringing it
 *    into scope here would impose a brand new restriction on that universal
 *    default, a strictly bigger and separately-scoped decision than this
 *    file's purpose. Chat's client is expected to send the literal
 *    `ailin-auto` string over the dedicated key per the documented contract.
 *  - Within the daily allowance: no-op, request proceeds as today.
 *    `ailin-auto` never populates `ailin_tier`/`ailin_tier_rate` (verified —
 *    see anonymous-quota-gate.ts header for the same caveat about
 *    `prepaid-wallet-gate.ts`'s separate `ailin_alias` fallback bug, which
 *    applies equally to `ailin-auto`), so it is not billed through
 *    `pricing-tier-billing.ts` either.
 *  - Once exceeded: chat-routes.ts rejects the `ailin-auto` request outright
 *    with 429 `free_quota_exceeded`. This module does NOT swap the model or
 *    silently fall through to a paid tier — silently billing a user for a
 *    model they didn't explicitly choose is the wrong trust pattern. The
 *    client is expected to retry with an explicit paid `<strategy>:<tier>`
 *    model.
 *  - Cost, not just count: when in scope, chat-routes.ts also sets
 *    `ailin_free_tier_scope: true` on the request (see that file), which
 *    caps the triage-recommended execution strategy to a bounded-cost one
 *    (`applyFreeTierStrategyCap` in triage-service.ts) — a request count
 *    limit alone does not bound what a single `ailin-auto` call can cost
 *    (triage can recommend `debate`/`consensus`/`quality-multipass`, none of
 *    which carry a `maxCost`).
 *  - KNOWN LIMITATION: wired only into `POST /v1/chat/completions`
 *    (chat-routes.ts), mirroring the anonymous gate's identical, tracked
 *    limitation on `/v1/responses` (see anonymous-quota-gate.ts and the
 *    deploy report's F2 section).
 *
 * Fail-open on Redis errors: allow the request through (as if still within
 * the free allowance) rather than block it. Matches
 * `anonymous-quota-gate.ts`'s house style: fail-closed here would hard-block
 * a legitimately-in-quota user's chat entirely, which the free-tier feature
 * exists to prevent. Fail-open's downside is bounded to "some extra free
 * `ailin-auto` requests during a Redis outage" — no money moves either way,
 * since `ailin-auto` is categorically exempt from billing regardless of this
 * counter's state, and the cost-ceiling half of this gate (max_cost + the
 * strategy cap) is enforced independently in chat-routes.ts / triage-service.ts,
 * not by this module, so it does not fail open with the quota count.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { getGlobalRedisClient } from '@/cache/redis-client';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'free-tier-quota-gate' });

const REDIS_KEY_PREFIX = 'free_tier_quota:ailin-auto:';
const DEFAULT_DAILY_LIMIT = 5;
export const FREE_TIER_AUTO_ALIAS = 'ailin-auto';

/** The one API key id this gate is allowed to fire for. Unset => never fires. */
export function chatFreeTierApiKeyId(): string | undefined {
  const id = process.env.CHAT_FREE_TIER_API_KEY_ID?.trim();
  return id ? id : undefined;
}

/**
 * SAFE BY DEFAULT: off unless BOTH explicitly enabled AND
 * `CHAT_FREE_TIER_API_KEY_ID` is configured — the key-id scope (see
 * `isInChatFreeTierScope`) is what makes this safe to enable at all; the flag
 * alone is not the safety boundary anymore (unlike the earlier revision of
 * this file).
 */
export function isFreeTierAutoQuotaEnabled(): boolean {
  return process.env.FREE_TIER_AUTO_QUOTA_ENABLED === 'true' && chatFreeTierApiKeyId() !== undefined;
}

function dailyLimit(): number {
  const raw = process.env.FREE_TIER_AUTO_DAILY_LIMIT;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
}

function utcDateStamp(now: Date): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC calendar day)
}

function nextUtcMidnight(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
  );
}

export interface FreeTierQuotaResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** ISO timestamp of the next UTC-day rollover. */
  resetAt: string;
}

/**
 * Whether the RAW, client-submitted `model` field (read BEFORE
 * `normalizeChatRequest`) is this gate's alias. Compared case-insensitively
 * and trimmed to match how `resolveAilinVirtualModelAlias` itself resolves
 * the field downstream (`normalizeAlias` = `.trim().toLowerCase()`) — a raw
 * case/whitespace variant like `"Ailin-Auto"` still executes as the free
 * `ailin-auto` model there, so it must also still be counted here.
 */
export function isFreeTierAutoRawModel(rawModel: string | undefined): boolean {
  return typeof rawModel === 'string' && rawModel.trim().toLowerCase() === FREE_TIER_AUTO_ALIAS;
}

/**
 * Decide whether this request is in scope for the authenticated free-tier
 * gate — mirrors `anonymous-quota-gate.ts`'s `inAnonymousQuotaScope`. Only
 * true when BOTH the request authenticated with the one designated key id
 * AND the raw model is `ailin-auto`. `userId` is required (not fingerprinted
 * — unlike the anonymous gate, an authenticated request always carries a
 * real user id from its JWT/session, so there is no need for the anonymous
 * gate's IP/UA/cookie composite).
 */
export function isInChatFreeTierScope(input: {
  apiKeyId: string | undefined;
  rawModel: string | undefined;
  userId: string | undefined;
}): boolean {
  const keyId = chatFreeTierApiKeyId();
  if (!keyId || !input.apiKeyId || input.apiKeyId !== keyId) {
    return false;
  }
  if (!isFreeTierAutoRawModel(input.rawModel)) {
    return false;
  }
  return typeof input.userId === 'string' && input.userId.length > 0;
}

/**
 * Atomically check + increment today's `ailin-auto` count for
 * (apiKeyId, userId). Callers MUST only invoke this when
 * `isInChatFreeTierScope(...)` is true AND `isFreeTierAutoQuotaEnabled()` is
 * true.
 *
 * Keyed on (apiKeyId, userId), NOT organizationId — apiKeyId is the safety
 * boundary (see file header); userId is included so the daily allowance is
 * per-person, not shared across everyone who happens to authenticate through
 * the dedicated key.
 *
 * Fail-OPEN on Redis errors (see file header).
 */
export async function checkAndConsumeFreeTierAutoQuota(
  apiKeyId: string,
  userId: string
): Promise<FreeTierQuotaResult> {
  const limit = dailyLimit();
  const now = new Date();
  const resetDate = nextUtcMidnight(now);
  const resetAt = resetDate.toISOString();
  const key = `${REDIS_KEY_PREFIX}${apiKeyId}:${userId}:${utcDateStamp(now)}`;
  const ttlSeconds = Math.max(60, Math.ceil((resetDate.getTime() - now.getTime()) / 1000));

  try {
    const redis = getGlobalRedisClient();
    const count = await redis.incr(key);
    // Always (re)set the TTL on every call — self-healing, see
    // anonymous-quota-gate.ts for the identical rationale.
    await redis.expire(key, ttlSeconds);

    if (count > limit) {
      log.info({ apiKeyId, userId, count, limit }, 'ailin-auto free-tier quota exceeded');
      return { allowed: false, remaining: 0, limit, resetAt };
    }
    return { allowed: true, remaining: Math.max(0, limit - count), limit, resetAt };
  } catch (error) {
    log.error(
      { error, apiKeyId, userId },
      'free-tier quota check failed — allowing (fail-open, never bills)'
    );
    return { allowed: true, remaining: limit, limit, resetAt };
  }
}

/** The standard 429 body shape for an exhausted authenticated free-tier quota. */
export function freeTierQuotaExceededBody(resetAt: string): {
  error: { code: string; message: string; reset_at: string };
} {
  return {
    error: {
      code: 'free_quota_exceeded',
      message: 'Your 5 free daily messages are used. Select a paid model to continue.',
      reset_at: resetAt,
    },
  };
}

// ── Boot-time config validation ─────────────────────────────────────────
// Identical rationale to anonymous-quota-gate.ts's checkAnonymousGuestApiKeyConfig:
// `CHAT_FREE_TIER_API_KEY_ID` unset is safe (gate off). Set-but-wrong (e.g. the
// key's name or plaintext secret pasted instead of its `api_keys.id` UUID)
// looks identical to "configured correctly" from the outside — nothing ever
// matches it, so nothing 429s, nothing logs, and the free-tier cost ceiling
// this gate exists to enforce silently never applies. Fail LOUD, not CLOSED
// (a single misconfigured opt-in flag should not crash ci-api's boot for
// every product).

export type ChatFreeTierApiKeyConfigStatus =
  | 'unset' // gate intentionally off — not a misconfiguration
  | 'ok' // configured id resolves to an active key
  | 'not_found' // configured id does not match any api_keys row
  | 'inactive' // configured id matches a row, but status !== 'active'
  | 'check_failed'; // could not verify (e.g. DB unreachable at boot) — NOT the same as "ok"

export interface ChatFreeTierApiKeyConfigResult {
  status: ChatFreeTierApiKeyConfigStatus;
  configuredId?: string;
  detail?: string;
}

/**
 * Pure(ish) check, DB access injected — unit-testable without a real
 * database. `lookup` should resolve to `{ id, status }` for an existing row,
 * or `null` if no row matches `configuredId`.
 */
export async function checkChatFreeTierApiKeyConfig(
  lookup: (id: string) => Promise<{ id: string; status: string } | null>
): Promise<ChatFreeTierApiKeyConfigResult> {
  const configuredId = chatFreeTierApiKeyId();
  if (!configuredId) {
    return { status: 'unset' };
  }
  try {
    const row = await lookup(configuredId);
    if (!row) {
      return {
        status: 'not_found',
        configuredId,
        detail:
          'No api_keys row matches this id. Common mistake: this must be the DB `id` (UUID) column, ' +
          'NOT the key name and NOT the plaintext ai1sk_... secret.',
      };
    }
    if (row.status !== 'active') {
      return {
        status: 'inactive',
        configuredId,
        detail: `Matched row has status="${row.status}", not "active".`,
      };
    }
    return { status: 'ok', configuredId };
  } catch (error) {
    return {
      status: 'check_failed',
      configuredId,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const CHAT_FREE_TIER_KEY_SCOPE_VIOLATION_BODY = {
  error: {
    code: 'chat_free_tier_key_scope_violation',
    message: 'This API key is restricted to POST /v1/chat/completions with model "ailin-auto".',
  },
} as const;

/**
 * Systemic guard for every route OTHER than POST /v1/chat/completions (which
 * has its own inline in-scope-vs-out-of-scope handling in chat-routes.ts,
 * since a compliant `ailin-auto` request there IS in scope and must be
 * allowed through). Exact mirror of
 * `rejectIfAnonymousGuestKeyOutOfScope` in anonymous-quota-gate.ts — see that
 * file for the full reasoning, which applies verbatim here.
 *
 * There is no per-key "allowed routes" concept anywhere in this codebase
 * (`ApiKey.permissions` cannot express "restrict to this one model on this one
 * endpoint"). Scoping the dedicated chat-free-tier key is therefore 100%
 * dependent on every route that accepts API-key auth remembering to call this.
 * Call it as the FIRST thing after `request.apiKey` is available, before doing
 * any real work: reject outright rather than let this key reach ANY endpoint it
 * wasn't provisioned for.
 *
 * Deliberately independent of `isFreeTierAutoQuotaEnabled()` — this rejects
 * misuse of the CREDENTIAL itself (a leaked key, or a chat-backend bug pointing
 * it at the wrong endpoint), which is a security property that must hold
 * regardless of whether the quota-counting feature happens to be toggled on.
 * Same reasoning as chat-routes.ts's inline check.
 *
 * Returns true if it already sent a 403 response (caller must `return`
 * immediately); false if the request may proceed.
 */
export function rejectIfChatFreeTierKeyOutOfScope(
  apiKeyId: string | undefined,
  reply: FastifyReply
): boolean {
  const freeTierKeyId = chatFreeTierApiKeyId();
  if (freeTierKeyId && apiKeyId === freeTierKeyId) {
    reply.status(403).send(CHAT_FREE_TIER_KEY_SCOPE_VIOLATION_BODY);
    return true;
  }
  return false;
}

/**
 * Same guard as `rejectIfChatFreeTierKeyOutOfScope`, shaped as a Fastify
 * preHandler — the counterpart to
 * `rejectAnonymousGuestKeyPreHandler` in anonymous-quota-gate.ts, and wired
 * alongside it on every route file that accepts API-key auth. Must be placed
 * AFTER the route's `authenticate` preHandler in the `preHandler` array —
 * Fastify runs array entries in order, and `request.apiKey` doesn't exist until
 * `authenticate` has run.
 */
export async function rejectChatFreeTierKeyPreHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  rejectIfChatFreeTierKeyOutOfScope((request as ExtendedFastifyRequest).apiKey?.id, reply);
}

/**
 * Boot-time wrapper — call (and await, but never let it block `listen`) from
 * server.ts, alongside `logAnonymousGuestApiKeyConfigStatus`. Logs at `error`
 * level for every non-'ok'/'unset' status; never throws.
 */
export async function logChatFreeTierApiKeyConfigStatus(): Promise<void> {
  try {
    const { prisma } = await import('@/database/client');
    const result = await checkChatFreeTierApiKeyConfig(async (id) => {
      const row = await prisma.apiKey.findUnique({ where: { id }, select: { id: true, status: true } });
      return row ?? null;
    });
    if (result.status === 'unset' || result.status === 'ok') {
      log.info({ status: result.status }, 'chat-free-tier-key config check');
      return;
    }
    log.error(
      { status: result.status, configuredId: result.configuredId, detail: result.detail },
      'CHAT_FREE_TIER_API_KEY_ID is set but misconfigured — the authenticated free-tier gate is ' +
        'SILENTLY INERT for the real chat free-tier key right now (FREE_TIER_AUTO_QUOTA_ENABLED, if ' +
        'true, has no effect). Fix the env var (must be the api_keys.id UUID) — see ' +
        'docs/chat-free-tier-key-setup.md.'
    );
  } catch (error) {
    log.error({ error }, 'chat-free-tier-key config check itself failed to run');
  }
}
