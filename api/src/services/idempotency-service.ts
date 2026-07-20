// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Idempotency-Key service (enterprise-grade)
 * ──────────────────────────────────────────────────────────────────────────
 * Implements at-most-once request semantics for the financially-sensitive
 * `POST /v1/chat/completions` and `POST /v1/responses` endpoints. A client
 * that retries a request (network blip, timeout, proxy re-send) with the same
 * `Idempotency-Key` gets the ORIGINAL response replayed instead of a second
 * billable inference — the core anti-double-billing guarantee.
 *
 * Design (mirrors docs/F3-F1-SOTA-IMPLEMENTATION-PLAN.md §P1):
 *
 *   - Scope is per-tenant: the Redis key is `idem:{organizationId}:{key}` so a
 *     key collision across two organizations is impossible and one tenant can
 *     never read another tenant's cached response.
 *
 *   - Record shape: `{ status:'in_flight'|'done', requestHash, httpStatus?,
 *     body?, createdAt }`, JSON-encoded. Two distinct TTLs: the transient
 *     `in_flight` lock lives for a short, request-bounded window
 *     (`IDEMPOTENCY_INFLIGHT_TTL_SECONDS`, minutes) so a crashed request does
 *     not strand the key, while the completed `done` response is cached for the
 *     full `IDEMPOTENCY_TTL_SECONDS` (24h) so retries keep replaying it.
 *
 *   - `requestHash` = SHA-256 of the STABLY-serialized request body. Two
 *     requests with the same key MUST carry the same body; a different body
 *     under the same key is a client bug (key reuse) and is rejected 409.
 *
 * Flow (see `beginIdempotentRequest`):
 *   1. `SET NX` an `in_flight` lock. If acquired ⇒ the caller owns the
 *      execution and must `finalize()` (on 2xx) or `release()` (on failure).
 *   2. If a record already exists:
 *        a. body hash differs            ⇒ `key_reuse`  (caller returns 409)
 *        b. record is `done`             ⇒ `replay`     (caller returns the
 *                                          stored httpStatus + body)
 *        c. record is still `in_flight`  ⇒ `in_progress` (caller returns 409)
 *   3. On success (2xx) the owner calls `finalize()` to flip the record to
 *      `done` with the response. On any non-2xx / thrown error the owner calls
 *      `release()` which DELETES the lock so the request can be retried — we
 *      deliberately never cache 5xx (or 4xx) responses.
 *
 * Streaming: this service is only engaged for non-streaming requests. SSE
 * responses are not buffered/replayable, so `stream:true` requests bypass
 * idempotency entirely (documented decision — see the guide doc).
 *
 * Testability: the Redis dependency is abstracted behind `IdempotencyStore`
 * (Redis in prod, a Map-backed fake in unit tests), matching the established
 * `RealtimeSessionStore` pattern in this codebase.
 */

import { createHash } from 'crypto';
import { getQueueRedisClient } from '@/cache/redis-client';
import { logger } from '@/utils/logger';

const log = logger.child({ service: 'idempotency-service' });

/**
 * Parse a positive-integer environment override, falling back to `fallback`
 * on anything absent, non-numeric, zero or negative. Mirrors the
 * `SHUTDOWN_TIMEOUT_MS` guard in `src/index.ts` so a bad env value can never
 * silently collapse a TTL to `NaN`/0.
 */
function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * TTL for a COMPLETED (`status:'done'`) idempotency record — the cached 2xx
 * response that gets replayed. 24h matches the F3/F1 plan and the common
 * industry default (Stripe). Long enough to absorb real retry windows
 * (client backoff, queue drains, operator replays) without unbounded growth.
 *
 * NOTE: this TTL applies ONLY to the finalized response cache (see
 * {@link finalizeIdempotentRequest}). The transient in-flight LOCK uses the
 * much shorter {@link IDEMPOTENCY_INFLIGHT_TTL_SECONDS} instead.
 */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * TTL for the TRANSIENT `status:'in_flight'` LOCK only — deliberately distinct
 * from (and far shorter than) the 24h response-cache TTL above.
 *
 * The lock exists only for the lifetime of a single in-progress request. If a
 * process is killed mid-request it can never run `finalize()`/`release()`, so
 * the lock is stranded until its TTL elapses. Were it to inherit the 24h
 * response TTL, every retry of that key would get 409 `idempotency_in_progress`
 * for a WHOLE DAY. Bounding the lock to a few minutes (comfortably above the
 * slowest legitimate non-streaming completion) means a crashed in-flight
 * request becomes retryable within minutes, while a genuinely in-progress
 * request is still protected and a *completed* response is still de-duplicated
 * for the full 24h.
 *
 * Default 5 minutes; override with `IDEMPOTENCY_INFLIGHT_TTL_SECONDS`. Keep it
 * above your p100 non-streaming latency so an in-flight request is never
 * declared stale while it is still legitimately running.
 */
export const IDEMPOTENCY_INFLIGHT_TTL_SECONDS = parsePositiveIntEnv(
  process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS,
  5 * 60
);

/**
 * Redis key namespace. Tenant id is interpolated to guarantee isolation.
 */
const IDEMPOTENCY_KEY_PREFIX = 'idem';

/**
 * Hard ceiling on a client-supplied Idempotency-Key length. Mirrors common
 * gateway limits and stops an attacker bloating Redis with megabyte keys.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export interface IdempotencyRecord {
  status: 'in_flight' | 'done';
  requestHash: string;
  httpStatus?: number;
  body?: unknown;
  createdAt: number;
}

/**
 * Minimal key-value contract this service needs. Redis in production, a
 * Map-backed fake in unit tests. `setNx` MUST be atomic (single round-trip
 * `SET key value NX EX ttl`) so two concurrent requests can never both
 * acquire the lock.
 */
export interface IdempotencyStore {
  /**
   * Atomically set `key`→`value` with a TTL only if `key` does not exist.
   * Returns `true` if the value was set (lock acquired), `false` otherwise.
   */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** Overwrite `key`→`value` with a fresh TTL unconditionally. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

/**
 * Uses the money-path Redis connection (`getQueueRedisClient()`), not the
 * shared cache/rate-limit connection — so cache churn or an evicting
 * `maxmemory-policy` on the general instance can never silently drop an
 * in-flight idempotency lock or a cached response (docs/audit/16, Phase 5).
 */
class RedisIdempotencyStore implements IdempotencyStore {
  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    // ioredis: SET key value EX <ttl> NX → returns 'OK' on set, null otherwise.
    const result = await getQueueRedisClient().set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await getQueueRedisClient().set(key, value, 'EX', ttlSeconds);
  }

  async get(key: string): Promise<string | null> {
    return getQueueRedisClient().get(key);
  }

  async del(key: string): Promise<void> {
    await getQueueRedisClient().del(key);
  }
}

const defaultStore: IdempotencyStore = new RedisIdempotencyStore();

/**
 * Build the tenant-scoped Redis key. Throws on an empty tenant id so a missing
 * auth context can never collapse the namespace into a shared bucket.
 */
export function buildIdempotencyRedisKey(organizationId: string, key: string): string {
  if (!organizationId) {
    throw new Error('idempotency: organizationId is required for tenant scoping');
  }
  return `${IDEMPOTENCY_KEY_PREFIX}:${organizationId}:${key}`;
}

/**
 * Stable-stringify an arbitrary JSON value so semantically-equal bodies hash
 * identically regardless of key insertion order. Objects get their keys
 * sorted recursively; arrays preserve order (array order is significant).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * SHA-256 of the stably-serialized body. The fingerprint that distinguishes a
 * legitimate retry (same body ⇒ replay) from key reuse (different body ⇒ 409).
 */
export function computeRequestHash(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

/**
 * Outcome of `beginIdempotentRequest`. The caller branches on `outcome`:
 *   - `acquired`    → owns execution; run the request, then call the returned
 *                     `finalize`/`release` (or use the handle).
 *   - `replay`      → return `record.httpStatus` + `record.body` verbatim.
 *   - `key_reuse`   → return 409 `idempotency_key_reuse`.
 *   - `in_progress` → return 409 `idempotency_in_progress`.
 */
export type IdempotencyBeginResult =
  | { outcome: 'acquired'; redisKey: string; requestHash: string }
  | { outcome: 'replay'; record: IdempotencyRecord }
  | { outcome: 'key_reuse'; record: IdempotencyRecord }
  | { outcome: 'in_progress'; record: IdempotencyRecord };

function parseRecord(raw: string | null): IdempotencyRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as IdempotencyRecord;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed.status === 'in_flight' || parsed.status === 'done') &&
      typeof parsed.requestHash === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validate a client-supplied Idempotency-Key. Returns the trimmed key or
 * `null` if it is unusable (empty / too long). Callers treat `null` like "no
 * key supplied" → passthrough, except length overflow which they may 400.
 */
export function normalizeIdempotencyKey(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

/**
 * Begin (or short-circuit) an idempotent request.
 *
 * On `acquired` the caller has exclusively locked the key and MUST eventually
 * call either {@link finalizeIdempotentRequest} (2xx) or
 * {@link releaseIdempotentRequest} (anything else / thrown) so the lock does
 * not strand a future retry. The lock is written with the short
 * {@link IDEMPOTENCY_INFLIGHT_TTL_SECONDS} so that even a crash between here and
 * finalize/release only blocks retries for minutes, not the 24h response TTL.
 */
export async function beginIdempotentRequest(args: {
  organizationId: string;
  key: string;
  requestBody: unknown;
  store?: IdempotencyStore;
}): Promise<IdempotencyBeginResult> {
  const store = args.store ?? defaultStore;
  const redisKey = buildIdempotencyRedisKey(args.organizationId, args.key);
  const requestHash = computeRequestHash(args.requestBody);

  const inFlightRecord: IdempotencyRecord = {
    status: 'in_flight',
    requestHash,
    createdAt: Date.now(),
  };

  const acquired = await store.setNx(
    redisKey,
    JSON.stringify(inFlightRecord),
    IDEMPOTENCY_INFLIGHT_TTL_SECONDS
  );

  if (acquired) {
    return { outcome: 'acquired', redisKey, requestHash };
  }

  // Key already exists — inspect the stored record.
  const existing = parseRecord(await store.get(redisKey));

  if (!existing) {
    // The lock vanished between SET NX and GET (TTL expiry / eviction / a
    // concurrent release). Treat as a fresh attempt and retry the lock once.
    const reacquired = await store.setNx(
      redisKey,
      JSON.stringify(inFlightRecord),
      IDEMPOTENCY_INFLIGHT_TTL_SECONDS
    );
    if (reacquired) {
      return { outcome: 'acquired', redisKey, requestHash };
    }
    const afterRace = parseRecord(await store.get(redisKey));
    if (!afterRace) {
      // Still nothing — degrade open rather than block the request.
      log.warn({ redisKey }, 'idempotency record disappeared during race; proceeding without lock');
      return { outcome: 'acquired', redisKey, requestHash };
    }
    return classifyExisting(afterRace, requestHash);
  }

  return classifyExisting(existing, requestHash);
}

function classifyExisting(
  record: IdempotencyRecord,
  requestHash: string
): IdempotencyBeginResult {
  if (record.requestHash !== requestHash) {
    return { outcome: 'key_reuse', record };
  }
  if (record.status === 'done') {
    return { outcome: 'replay', record };
  }
  return { outcome: 'in_progress', record };
}

/**
 * Persist the final (successful, 2xx) response under the key. Flips the record
 * to `done` with a fresh 24h TTL so subsequent retries replay it.
 */
export async function finalizeIdempotentRequest(args: {
  redisKey: string;
  requestHash: string;
  httpStatus: number;
  body: unknown;
  store?: IdempotencyStore;
}): Promise<void> {
  const store = args.store ?? defaultStore;
  const record: IdempotencyRecord = {
    status: 'done',
    requestHash: args.requestHash,
    httpStatus: args.httpStatus,
    body: args.body,
    createdAt: Date.now(),
  };
  await store.set(args.redisKey, JSON.stringify(record), IDEMPOTENCY_TTL_SECONDS);
}

/**
 * Release the in-flight lock without caching a response. Used on failure
 * (non-2xx status or a thrown error) so the request can be retried. Swallows
 * Redis errors — failing to release must never mask the original error.
 */
export async function releaseIdempotentRequest(args: {
  redisKey: string;
  store?: IdempotencyStore;
}): Promise<void> {
  const store = args.store ?? defaultStore;
  try {
    await store.del(args.redisKey);
  } catch (error) {
    log.warn(
      { redisKey: args.redisKey, error: error instanceof Error ? error.message : String(error) },
      'failed to release idempotency lock; it will expire via TTL'
    );
  }
}
