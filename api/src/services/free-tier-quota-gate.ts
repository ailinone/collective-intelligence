// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * free-tier-quota-gate.ts — daily free-message cap for AUTHENTICATED
 * organizations on the `ailin-auto` preset alias.
 *
 * ⚠️ PLATFORM-WIDE BLAST RADIUS — READ BEFORE ENABLING ⚠️
 * `ailin-auto` is NOT chat-specific. `financial/src/utils/aiAssistantGateway.ts`
 * sets it as `DEFAULT_GATEWAY_MODEL`, and `guide/apps/v4/lib/playground.ts` +
 * `guide/apps/v4/components/guide/llm-playground.tsx` ship a live, real-token
 * interactive playground (base URL `https://api.ailin.one`) that defaults to
 * `ailin-auto` against BOTH `/v1/chat/completions` and `/v1/responses` —
 * i.e. this is a real, currently-reachable, publicly-documented usage
 * pattern, not a hypothetical. (An earlier draft of this comment also cited
 * `id/web/app/graphql/route.ts` — that hit is a hardcoded `STUB_RESPONSES`
 * fallback payload id's frontend returns locally when its own backend is
 * unreachable; it is never sent to ci as a real request, so it does not
 * belong on this list. Corrected after review.)
 *
 * `organizationId` is a platform-wide identity (Ailin ID/SSO) — the SAME org
 * a customer uses in chat is the org they use in id/guide/financial/etc, and
 * ci has no per-request signal (audience claim, product id, anything) that
 * says which product a JWT/API-key-authenticated request came from. That is
 * a structural property of the current auth model, not a configuration gap
 * this file can flag its way around: an org-scoped counter over `ailin-auto`
 * CANNOT be made chat-specific while staying org-keyed. Enabling this gate
 * imposes a 5/day `ailin-auto` cap on EVERY product's `ailin-auto` usage for
 * that org, platform-wide, full stop.
 *
 * Given that, `FREE_TIER_AUTO_QUOTA_ENABLED` should be treated as
 * PERMANENTLY UNSAFE TO SET TRUE IN THIS FORM — not "enable with care" — until
 * one of:
 *   (a) chat's authenticated traffic is proxied through its own dedicated,
 *       DB-backed API key id (mirroring `ANONYMOUS_GUEST_API_KEY_ID` in
 *       anonymous-quota-gate.ts) and this gate is rekeyed to
 *       `(apiKeyId, userId, utcDate)` gated on that specific key id — this
 *       makes the gate structurally incapable of touching financial/guide/id
 *       traffic, the same property that makes the anonymous gate safe. This
 *       requires chat's authenticated users to go through that dedicated key
 *       rather than "unchanged normal auth" — a real API-contract change,
 *       not something this file can decide unilaterally; OR
 *   (b) some other chat-specific scoping signal is added.
 * This module ships the (a)-shaped primitive (flag + doc), not the (a)
 * rekeying itself, deliberately — see the deploy report for why that's an
 * open decision for a human, not something to silently implement.
 *
 * Scope, by construction:
 *  - Only ever evaluated when the RAW, client-submitted `model` field is
 *    literally the string `ailin-auto` — checked BEFORE
 *    `normalizeChatRequest` runs, mirroring `anonymous-quota-gate.ts`'s
 *    `inAnonymousQuotaScope`. Earlier draft of this file keyed off the
 *    POST-normalization `chatRequest.ailin_alias` instead; that has a real
 *    gap: `resolveAilinVirtualModelAlias('auto')` (and `''`/omitted) returns
 *    `null` BY DESIGN (it's the "let orchestration decide" sentinel), so
 *    `ailin_alias` is never set to `'ailin-auto'` for `model:"auto"` or a
 *    request with no `model` at all — even though both resolve into the
 *    exact same dynamic-orchestration execution path as `ailin-auto` today.
 *    Checking the raw field closes that gap for the literal `'ailin-auto'`
 *    string without widening scope.
 *  - Deliberately does NOT also count bare `model:"auto"` / omitted `model`
 *    against the free-tier limit, even though they currently execute
 *    identically to `ailin-auto`. `auto`/omitted is the platform's
 *    pre-existing, always-free, zero-preference default for literally every
 *    authenticated caller on every product — it was never gated for anyone,
 *    chat or otherwise. Bringing it into scope here would impose a brand
 *    new restriction on that universal default rather than just capping the
 *    `ailin-auto` preset chat opted into, which is a strictly BIGGER and
 *    separately-scoped decision than this file's purpose. Chat's own client
 *    is expected to send the literal `ailin-auto` string per the documented
 *    API contract; a caller that instead sends bare `auto` to dodge the
 *    counter is doing nothing today's platform doesn't already allow anyone,
 *    on any product, to do.
 *  - Within the daily allowance: no-op, the request proceeds exactly as
 *    today. `ailin-auto` never populates `ailin_tier`/`ailin_tier_rate`
 *    (verified — see anonymous-quota-gate.ts header for the same caveat
 *    about `prepaid-wallet-gate.ts`'s separate `ailin_alias` fallback bug,
 *    which applies equally to `ailin-auto`), so it is not billed through
 *    `pricing-tier-billing.ts` either.
 *  - Once exceeded: the caller (chat-routes.ts) rejects the `ailin-auto`
 *    request outright with 429 `free_quota_exceeded`. This module does NOT
 *    swap the model or silently fall through to a paid tier — per the
 *    product decision, silently billing a user for a model they didn't
 *    explicitly choose is the wrong trust pattern. The client is expected to
 *    retry with an explicit paid `<strategy>:<tier>` model.
 *  - KNOWN LIMITATION even while OFF-by-default: this is wired only into
 *    `POST /v1/chat/completions` (chat-routes.ts). `/v1/responses` resolves
 *    the same alias and is NOT gated here (tracked alongside the identical,
 *    already-fixed gap on the anonymous key — see anonymous-quota-gate.ts
 *    and the deploy report's F2 section). Low priority while the flag stays
 *    off, but a blocker for (a)/(b) above before ever enabling.
 *
 * Fail-open on Redis errors: allow the request through (as if still within
 * the free allowance) rather than block it. Reasoning (matches the
 * `prepaid-wallet-gate.ts` house style, which already fails open on
 * wallet/store errors): fail-closed here would either (a) hard-block a
 * legitimately-in-quota user's chat entirely, which the free-tier feature
 * exists to prevent, or (b) if implemented as "fall through to the wallet
 * gate instead," would incorrectly push a within-quota free user onto
 * `PREPAID_WALLET_GATE_ENABLED` machinery. Fail-open's downside is bounded
 * to "some extra free `ailin-auto` requests during a Redis outage" — no
 * money moves either way, since `ailin-auto` is categorically exempt from
 * billing regardless of this counter's state.
 */

import { getGlobalRedisClient } from '@/cache/redis-client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'free-tier-quota-gate' });

const REDIS_KEY_PREFIX = 'free_tier_quota:ailin-auto:';
const DEFAULT_DAILY_LIMIT = 5;
export const FREE_TIER_AUTO_ALIAS = 'ailin-auto';

/**
 * SAFE BY DEFAULT: off unless explicitly enabled. See the file header —
 * `ailin-auto` is used by guide and financial as well as chat, and ci cannot
 * currently distinguish which product an authenticated request came from,
 * so this must not activate platform-wide just because the code is
 * deployed. Treat `true` as PERMANENTLY UNSAFE until the file header's (a)
 * or (b) is addressed, not as a normal operational toggle.
 */
export function isFreeTierAutoQuotaEnabled(): boolean {
  return process.env.FREE_TIER_AUTO_QUOTA_ENABLED === 'true';
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
 * the field downstream (`normalizeAlias` = `.trim().toLowerCase()`) — a
 * raw case/whitespace variant like `"Ailin-Auto"` still executes as the free
 * `ailin-auto` model there, so it must also still be counted here. Does NOT
 * match bare `"auto"` or an omitted model — see file header for why that's
 * deliberate, not an oversight.
 */
export function isFreeTierAutoRawModel(rawModel: string | undefined): boolean {
  return typeof rawModel === 'string' && rawModel.trim().toLowerCase() === FREE_TIER_AUTO_ALIAS;
}

/**
 * Atomically check + increment today's `ailin-auto` count for organizationId.
 * Callers MUST only invoke this when `isFreeTierAutoRawModel(rawModel)` is
 * true AND `isFreeTierAutoQuotaEnabled()` is true.
 *
 * Fail-OPEN on Redis errors (see file header).
 */
export async function checkAndConsumeFreeTierAutoQuota(
  organizationId: string
): Promise<FreeTierQuotaResult> {
  const limit = dailyLimit();
  const now = new Date();
  const resetDate = nextUtcMidnight(now);
  const resetAt = resetDate.toISOString();
  const key = `${REDIS_KEY_PREFIX}${organizationId}:${utcDateStamp(now)}`;
  const ttlSeconds = Math.max(60, Math.ceil((resetDate.getTime() - now.getTime()) / 1000));

  try {
    const redis = getGlobalRedisClient();
    const count = await redis.incr(key);
    // Always (re)set the TTL on every call — self-healing, see
    // anonymous-quota-gate.ts for the identical rationale.
    await redis.expire(key, ttlSeconds);

    if (count > limit) {
      log.info({ organizationId, count, limit }, 'ailin-auto free-tier quota exceeded');
      return { allowed: false, remaining: 0, limit, resetAt };
    }
    return { allowed: true, remaining: Math.max(0, limit - count), limit, resetAt };
  } catch (error) {
    log.error(
      { error, organizationId },
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
