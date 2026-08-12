// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * anonymous-quota-gate.ts — daily message cap for UNAUTHENTICATED (anonymous)
 * chat visitors, proxied through a single dedicated, IP-whitelisted M2M API
 * key (see docs/anonymous-chat-guest-key-setup.md for provisioning).
 *
 * Scope, by construction — this module can NEVER affect normal platform
 * traffic:
 *  - `inAnonymousQuotaScope()` only returns true when BOTH (a) the request
 *    authenticated with the ONE designated key id
 *    (`ANONYMOUS_GUEST_API_KEY_ID` env var) AND (b) the RAW, client-submitted
 *    `model` field (checked BEFORE `normalizeChatRequest` rewrites it to
 *    `'auto'`) is literally `ailin-economy`. Any other key or model is a
 *    complete no-op — this file is never even consulted.
 *  - If `ANONYMOUS_GUEST_API_KEY_ID` is unset, the gate never fires for
 *    anyone (safe default — the feature is off until explicitly wired to a
 *    real key id). If it's set to a value that does NOT resolve to an
 *    active `api_keys` row (e.g. the operator pasted the key's `name` or its
 *    plaintext `ai1sk_...` secret instead of its DB `id`), the gate is
 *    ALSO silently inert — see `checkAnonymousGuestApiKeyConfig` below,
 *    which exists specifically to turn that silent failure into a loud
 *    boot-time log line instead.
 *
 * NOT an authentication mechanism — read before assuming this is a real
 * per-visitor control: `X-Anonymous-Visitor-Id` is an UNSIGNED, entirely
 * client (chat-backend)-supplied header. The SHA-256 in `hashVisitorId` is
 * key hygiene (never store the raw header value), not proof of identity.
 * Nothing on the ci side stops the caller from sending a fresh value per
 * request — a visitor reloading in a new incognito tab, or any script that
 * rotates the header, gets a fresh 2-message bucket for free every time.
 * There is deliberately no attempt here to invent a stronger anti-abuse
 * mechanism (e.g. binding to TLS session, proof-of-work, CAPTCHA) — that's
 * real user friction for a free tier, and this repo's own token-bucket
 * per-API-key rate limiter (`api-key-rate-limit-middleware.ts`) already
 * bounds the REAL worst case for this one dedicated key regardless of how
 * many visitor-id buckets it's spread across. Treat "2/day" as the
 * advertised allowance for a compliant caller, and the per-key rate limit
 * as the actual ceiling on abuse — not the other way around. The IP
 * whitelist restricts which HOST can present ANY visitor id on this key's
 * behalf; it says nothing about how many distinct visitor ids that host
 * presents.
 *
 * Billing: `ailin-economy` is a legacy `ailin-*` preset alias. Empirically
 * verified (see the deploy report) that it never populates
 * `ailin_tier`/`ailin_tier_rate` (the field pair `pricing-tier-billing.ts`
 * gates on), so it can never be billed through that path regardless of
 * `PRICING_TIERS_BILLING_ENABLED`.
 *   CAVEAT — NOT fixed by this change, flagged prominently in the deploy
 *   report: `prepaid-wallet-gate.ts`'s OWN `resolveTier()` re-derives a tier
 *   from `model`/`ailin_alias` independently, and because "economy" (and
 *   "auto") are themselves valid `STRATEGY_POLICY` keys in pricing-tiers.ts,
 *   it WOULD wrongly resolve `ailin-economy` (and `ailin-auto`) to a
 *   billable cell if `PREPAID_WALLET_GATE_ENABLED` is ever turned on. That
 *   flag is OFF in production as of this writing, so today this module's
 *   "never touches billing" guarantee holds — but it does not survive that
 *   flag flipping until the upstream bug is fixed. Do not flip
 *   `PREPAID_WALLET_GATE_ENABLED` without fixing that first.
 *
 * KNOWN LIMITATION: only `POST /v1/chat/completions` enforces the
 * `anonymous_key_scope_violation` restriction inline (chat-routes.ts). The
 * same dedicated key, if pointed at `/v1/responses` instead, was found to
 * completely bypass BOTH the counting and the scope restriction (confirmed:
 * `/v1/responses` resolves `ailin-*` aliases the same way and has none of
 * checkQuota/gateChatRequest/governance/this module wired in). Fixed inline
 * in `responses-routes.ts` alongside this file — see the deploy report's F2
 * section for why a single global hook wasn't attempted instead (this
 * codebase authenticates per-route, not via a global pre-auth hook, so a
 * naively-added global check would run BEFORE `request.apiKey` exists and
 * silently never fire — worse than the narrower, verified fix).
 *
 * Fail-open on Redis errors: allow the request rather than block anonymous
 * chat entirely on a transient cache outage. Bounded exposure — at most a
 * few extra `ailin-economy` (the cheapest cascade tier) requests per visitor
 * for the duration of the outage, never a billing event either way.
 */

import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getGlobalRedisClient } from '@/cache/redis-client';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'anonymous-quota-gate' });

const REDIS_KEY_PREFIX = 'anon_quota:';
const DEFAULT_DAILY_LIMIT = 2;
const ANONYMOUS_ECONOMY_MODEL = 'ailin-economy';
/** Defensive cap on the caller-supplied visitor id header before it's hashed. */
const MAX_VISITOR_ID_HEADER_LENGTH = 512;

/** The one API key id this gate is allowed to fire for. Unset => never fires. */
export function anonymousGuestApiKeyId(): string | undefined {
  const id = process.env.ANONYMOUS_GUEST_API_KEY_ID?.trim();
  return id ? id : undefined;
}

function dailyLimit(): number {
  const raw = process.env.ANONYMOUS_QUOTA_DAILY_LIMIT;
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

/** Bound + hash the caller-supplied visitor id before it ever becomes a Redis key fragment. */
function hashVisitorId(rawVisitorId: string): string {
  const bounded = rawVisitorId.slice(0, MAX_VISITOR_ID_HEADER_LENGTH);
  return createHash('sha256').update(bounded).digest('hex');
}

export interface AnonymousQuotaScopeInput {
  /** `request.apiKey?.id` — undefined for JWT-authenticated / no-key requests. */
  apiKeyId: string | undefined;
  /** The RAW, client-submitted `model` field — read BEFORE `normalizeChatRequest`. */
  rawModel: string | undefined;
  /** The `X-Anonymous-Visitor-Id` header value, if present. */
  visitorIdHeader: string | undefined;
}

export interface AnonymousQuotaScope {
  inScope: boolean;
  /** Present only when `inScope` is true. */
  visitorIdHash?: string;
}

/**
 * Decide whether this request is in scope for anonymous quota counting.
 * Deliberately checks the RAW client-submitted model (not the
 * post-`normalizeChatRequest` value, which is rewritten to `'auto'` for
 * every `ailin-*` alias) so this can't be bypassed or mismatched by
 * normalization rewriting the field out from under it.
 */
export function inAnonymousQuotaScope(input: AnonymousQuotaScopeInput): AnonymousQuotaScope {
  const guestKeyId = anonymousGuestApiKeyId();
  if (!guestKeyId || !input.apiKeyId || input.apiKeyId !== guestKeyId) {
    return { inScope: false };
  }
  if (input.rawModel !== ANONYMOUS_ECONOMY_MODEL) {
    return { inScope: false };
  }
  const visitorId = input.visitorIdHeader?.trim();
  if (!visitorId) {
    return { inScope: false };
  }
  return { inScope: true, visitorIdHash: hashVisitorId(visitorId) };
}

export interface AnonymousQuotaResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** ISO timestamp of the next UTC-day rollover. */
  resetAt: string;
}

/**
 * Atomically check + increment today's count for (apiKeyId, visitorIdHash).
 * Callers MUST have already confirmed `inAnonymousQuotaScope(...).inScope`
 * before calling this — it does not re-derive scope itself.
 *
 * Fail-OPEN on Redis errors (see file header): never blocks anonymous chat
 * on a cache outage.
 */
export async function checkAndConsumeAnonymousQuota(
  apiKeyId: string,
  visitorIdHash: string
): Promise<AnonymousQuotaResult> {
  const limit = dailyLimit();
  const now = new Date();
  const resetDate = nextUtcMidnight(now);
  const resetAt = resetDate.toISOString();
  const key = `${REDIS_KEY_PREFIX}${apiKeyId}:${visitorIdHash}:${utcDateStamp(now)}`;
  const ttlSeconds = Math.max(60, Math.ceil((resetDate.getTime() - now.getTime()) / 1000));

  try {
    const redis = getGlobalRedisClient();
    const count = await redis.incr(key);
    // Always (re)set the TTL on every call — self-healing against a crash
    // between INCR and EXPIRE (worst case: one stray key that outlives the
    // day, harmless since the key itself is date-scoped and a fresh day
    // mints a fresh key name).
    await redis.expire(key, ttlSeconds);

    if (count > limit) {
      log.info({ apiKeyId, count, limit }, 'anonymous quota exceeded');
      return { allowed: false, remaining: 0, limit, resetAt };
    }
    return { allowed: true, remaining: Math.max(0, limit - count), limit, resetAt };
  } catch (error) {
    log.error(
      { error, apiKeyId },
      'anonymous quota check failed — allowing (fail-open, never touches billing)'
    );
    return { allowed: true, remaining: limit, limit, resetAt };
  }
}

/** The standard 429 body shape for an exhausted anonymous quota. */
export function anonymousQuotaExceededBody(resetAt: string): {
  error: { code: string; message: string; reset_at: string };
} {
  return {
    error: {
      code: 'anonymous_quota_exceeded',
      message:
        'You have used your free daily messages. Sign in for a higher free allowance, or try again after the reset time.',
      reset_at: resetAt,
    },
  };
}

// ── Boot-time config validation (fixes the "wrong-but-set" silent-failure
// case) ─────────────────────────────────────────────────────────────────
//
// `ANONYMOUS_GUEST_API_KEY_ID` unset is a SAFE, common, intentional state
// (gate off). But a value that's SET and WRONG — e.g. the operator pasted
// the key's `name` or its plaintext `ai1sk_...` secret instead of the
// `api_keys.id` UUID, which sit right next to each other on the same
// object during provisioning — is dangerous precisely because it looks
// identical to "configured correctly" from the outside: no request ever
// matches it, so nothing 429s, nothing 403s, nothing logs. The REAL guest
// key just runs with zero restriction, indefinitely, until someone notices.
//
// This turns that into a loud, actionable log line. It deliberately does
// NOT crash the boot (unlike `assertOperationalRouteInvariant`, which
// guards a pure static allowlist and is always a real bug): this depends on
// live DB reachability, and a single misconfigured opt-in guest-quota
// env var crashing the ENTIRE platform's ci-api boot — blocking every
// product, not just chat — is a disproportionate failure mode for what
// this flag governs. Fail LOUD, not fail CLOSED, matching the "don't
// accidentally block all traffic" half of this whole feature's safety
// posture.

export type AnonymousGuestApiKeyConfigStatus =
  | 'unset' // gate intentionally off — not a misconfiguration
  | 'ok' // configured id resolves to an active key
  | 'not_found' // configured id does not match any api_keys row
  | 'inactive' // configured id matches a row, but status !== 'active'
  | 'check_failed'; // could not verify (e.g. DB unreachable at boot) — NOT the same as "ok"

export interface AnonymousGuestApiKeyConfigResult {
  status: AnonymousGuestApiKeyConfigStatus;
  configuredId?: string;
  detail?: string;
}

/**
 * Pure(ish) check, DB access injected — unit-testable without a real
 * database. `lookup` should resolve to `{ id, status }` for an existing
 * row, or `null` if no row matches `configuredId`.
 */
export async function checkAnonymousGuestApiKeyConfig(
  lookup: (id: string) => Promise<{ id: string; status: string } | null>
): Promise<AnonymousGuestApiKeyConfigResult> {
  const configuredId = anonymousGuestApiKeyId();
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

/**
 * Boot-time wrapper — call (and await, but never let it block `listen`) from
 * server.ts. Logs at `error` level for every non-'ok'/'unset' status; never
 * throws. See the block comment above for why this fails loud, not closed.
 */
export async function logAnonymousGuestApiKeyConfigStatus(): Promise<void> {
  try {
    const { prisma } = await import('@/database/client');
    const result = await checkAnonymousGuestApiKeyConfig(async (id) => {
      const row = await prisma.apiKey.findUnique({ where: { id }, select: { id: true, status: true } });
      return row ?? null;
    });
    if (result.status === 'unset' || result.status === 'ok') {
      log.info({ status: result.status }, 'anonymous-guest-key config check');
      return;
    }
    log.error(
      { status: result.status, configuredId: result.configuredId, detail: result.detail },
      'ANONYMOUS_GUEST_API_KEY_ID is set but misconfigured — the anonymous quota gate is SILENTLY INERT ' +
        'for the real guest key right now. Fix the env var (must be the api_keys.id UUID) — see ' +
        'docs/anonymous-chat-guest-key-setup.md.'
    );
  } catch (error) {
    log.error({ error }, 'anonymous-guest-key config check itself failed to run');
  }
}

const ANONYMOUS_KEY_SCOPE_VIOLATION_BODY = {
  error: {
    code: 'anonymous_key_scope_violation',
    message:
      'This API key is restricted to POST /v1/chat/completions with model "ailin-economy" and the X-Anonymous-Visitor-Id header set.',
  },
} as const;

/**
 * Systemic guard for every route OTHER than POST /v1/chat/completions
 * (which has its own inline in-scope-vs-out-of-scope handling, since a
 * compliant ailin-economy request there IS in scope) and POST /v1/responses
 * (first route this pattern was fixed on — see that file's comment).
 *
 * There is no per-key "allowed routes" concept anywhere in this codebase
 * (see docs/anonymous-chat-guest-key-setup.md: `ApiKey.permissions` is
 * deliberately left null because there's no way to express "restrict to
 * this one model on this one endpoint"). Scoping the dedicated anonymous-
 * guest key is therefore 100% dependent on every route that accepts API-key
 * auth remembering to call this. Call it as the FIRST thing after
 * `request.apiKey` is available, before doing any real work: reject outright
 * rather than let this key reach ANY endpoint it wasn't provisioned for.
 *
 * Returns true if it already sent a 403 response (caller must `return`
 * immediately); false if the request may proceed.
 */
export function rejectIfAnonymousGuestKeyOutOfScope(
  apiKeyId: string | undefined,
  reply: FastifyReply
): boolean {
  const guestKeyId = anonymousGuestApiKeyId();
  if (guestKeyId && apiKeyId === guestKeyId) {
    reply.status(403).send(ANONYMOUS_KEY_SCOPE_VIOLATION_BODY);
    return true;
  }
  return false;
}

/**
 * Same guard as `rejectIfAnonymousGuestKeyOutOfScope`, shaped as a Fastify
 * preHandler for routes that don't already have a per-handler call site
 * (see tools-routes.ts, extended-thinking-routes.ts, batches-routes.ts,
 * realtime-routes.ts, capabilities-routes.ts). Must be placed AFTER the
 * route's `authenticate` preHandler in the `preHandler` array — Fastify runs
 * array entries in order, and `request.apiKey` doesn't exist until
 * `authenticate` has run.
 */
export async function rejectAnonymousGuestKeyPreHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  rejectIfAnonymousGuestKeyOutOfScope((request as ExtendedFastifyRequest).apiKey?.id, reply);
}
