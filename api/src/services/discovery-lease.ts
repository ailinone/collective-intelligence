// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cross-process lease for the full model-discovery round.
 *
 * Why: a discovery round fans out over ~250 sources and each source ends in
 * an interactive bulk-upsert transaction, so one round can hold a large share
 * of its process's Prisma pool for minutes. The in-process coalescing in
 * CentralModelDiscoveryService.discoverAllModels() only dedupes callers
 * inside ONE process, and the BullMQ "model-discovery-hourly" job only
 * dedupes the hourly tick. Nothing stopped two processes from running a full
 * round at the same time: at-boot discovery in every api task, a stalled
 * hourly job re-dispatched to a fresh worker during a rollout, the admin
 * trigger. Production saw 206 app connections against max_connections=200
 * with two booting processes each filling their pool (2026-09-24).
 *
 * What: one Redis key on the money-path instance (`redis-lease`, noeviction, the
 * same connection BullMQ and the idempotency store use; never the LRU
 * `redis-cache`, which could evict a live lease). Acquire is a single Lua
 * script that runs `SET key token NX PX ttl` where `token` embeds a fencing
 * epoch from `INCR` on a sibling counter, so every successful acquisition
 * carries a strictly larger epoch than the previous one (for as long as the
 * counter survives in Redis). Renew and release are compare-and-set scripts
 * on that exact token, so a holder whose lease expired can never extend or
 * delete a newer holder's lease.
 *
 * Fencing: the holder renews every ttl/3 and tracks the last time Redis
 * confirmed it still owns the token. `isValid()` is a local check (no Redis
 * round trip) that turns false once a renewal was refused (another process
 * owns the key) or once a full TTL passed without a confirmed renewal (the
 * key may have expired while this process was paused). The discovery round
 * checks it before dispatching each source, so a stale holder stops starting
 * new sources and its overlap with a newer holder is bounded by the sources
 * already in flight. Those in-flight writes stay safe: bulk upserts are
 * serialized per provider by pg_advisory_xact_lock and are idempotent.
 *
 * Failure mode: if Redis does not answer within `opTimeoutMs`, acquisition
 * fails OPEN (the round runs unguarded, with a warning). The lease bounds
 * load, it does not guard correctness, and a Redis outage also stops the
 * BullMQ crons, so skipping discovery would only let the catalog go stale.
 * The queue client keeps commands queued while disconnected, so an acquire
 * that timed out may still land when Redis comes back; the worst case is an
 * orphan lease nobody renews, which expires after one TTL.
 */
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { getQueueRedisClient } from '@/cache/redis-client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'discovery-lease' });

export const DISCOVERY_LEASE_KEY = 'ci:model-discovery:lease';
export const DISCOVERY_LEASE_EPOCH_KEY = 'ci:model-discovery:lease:epoch';

/** Default lease TTL. Renewed every ttl/3 while the round runs. */
export const DEFAULT_DISCOVERY_LEASE_TTL_MS = 120_000;
/** Upper bound for any single Redis call made by the lease. */
export const DEFAULT_DISCOVERY_LEASE_OP_TIMEOUT_MS = 5_000;
const MIN_DISCOVERY_LEASE_TTL_MS = 10_000;

export type DiscoveryLeaseAcquireResult =
  { acquired: true; token: string; epoch: number } | { acquired: false; holder: string | null };

/**
 * Storage contract. Redis in production; a Map-backed fake in unit tests.
 * Every method MUST be atomic on the server side.
 */
export interface DiscoveryLeaseStore {
  /** SET NX PX with a fresh fencing epoch; reports the current holder when taken. */
  tryAcquire(ownerId: string, ttlMs: number): Promise<DiscoveryLeaseAcquireResult>;
  /** Extends the TTL only if the key still holds `token`. */
  renew(token: string, ttlMs: number): Promise<boolean>;
  /** Deletes the key only if it still holds `token`. */
  release(token: string): Promise<boolean>;
}

// KEYS[1] lease key, KEYS[2] epoch counter; ARGV[1] owner id, ARGV[2] ttl ms.
const ACQUIRE_SCRIPT = `
local holder = redis.call('GET', KEYS[1])
if holder then
  return {0, holder}
end
local epoch = redis.call('INCR', KEYS[2])
local token = tostring(epoch) .. '|' .. ARGV[1]
if redis.call('SET', KEYS[1], token, 'NX', 'PX', tonumber(ARGV[2])) then
  return {1, token}
end
return {0, redis.call('GET', KEYS[1]) or ''}
`;

// KEYS[1] lease key; ARGV[1] token, ARGV[2] ttl ms.
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 0
`;

// KEYS[1] lease key; ARGV[1] token.
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Minimal slice of ioredis the store needs (keeps the store unit-testable). */
export interface LeaseRedisClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/** Parses the epoch out of a `<epoch>|<owner>` token; NaN when malformed. */
export function parseLeaseEpoch(token: string): number {
  const separator = token.indexOf('|');
  return Number(separator > 0 ? token.slice(0, separator) : Number.NaN);
}

export function createRedisDiscoveryLeaseStore(
  getClient: () => LeaseRedisClient = getQueueRedisClient,
  keys: { lease: string; epoch: string } = {
    lease: DISCOVERY_LEASE_KEY,
    epoch: DISCOVERY_LEASE_EPOCH_KEY,
  }
): DiscoveryLeaseStore {
  return {
    async tryAcquire(ownerId, ttlMs) {
      const reply = (await getClient().eval(
        ACQUIRE_SCRIPT,
        2,
        keys.lease,
        keys.epoch,
        ownerId,
        String(ttlMs)
      )) as [number, string | null];
      const [flag, value] = reply;
      if (flag === 1 && typeof value === 'string') {
        return { acquired: true, token: value, epoch: parseLeaseEpoch(value) };
      }
      return { acquired: false, holder: typeof value === 'string' && value ? value : null };
    },
    async renew(token, ttlMs) {
      const reply = await getClient().eval(RENEW_SCRIPT, 1, keys.lease, token, String(ttlMs));
      return Number(reply) === 1;
    },
    async release(token) {
      const reply = await getClient().eval(RELEASE_SCRIPT, 1, keys.lease, token);
      return Number(reply) === 1;
    },
  };
}

/**
 * Whether the lease guards discovery in this process. Explicit
 * MODEL_DISCOVERY_LEASE_ENABLED=true/false wins; otherwise it is on only in
 * production, so hermetic unit tests and single-process dev runs never
 * reach for Redis just to run discovery.
 */
export function isDiscoveryLeaseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MODEL_DISCOVERY_LEASE_ENABLED;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return env.NODE_ENV === 'production';
}

export function resolveDiscoveryLeaseTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.MODEL_DISCOVERY_LEASE_TTL_MS ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DISCOVERY_LEASE_TTL_MS;
  return Math.max(parsed, MIN_DISCOVERY_LEASE_TTL_MS);
}

export interface DiscoveryLease {
  /** `null` when acquisition failed open (Redis unreachable). */
  readonly token: string | null;
  readonly epoch: number | null;
  /** Local fencing check; see the module comment. */
  isValid(): boolean;
  /** Stops renewing and deletes the key if this process still owns it. Idempotent. */
  release(): Promise<void>;
}

export type DiscoveryLeaseAcquisition =
  | { acquired: true; lease: DiscoveryLease; failedOpen: boolean }
  | { acquired: false; holder: string | null };

export interface AcquireDiscoveryLeaseOptions {
  store?: DiscoveryLeaseStore;
  ttlMs?: number;
  renewIntervalMs?: number;
  opTimeoutMs?: number;
  ownerId?: string;
  now?: () => number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function defaultOwnerId(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

const UNGUARDED_LEASE: DiscoveryLease = {
  token: null,
  epoch: null,
  isValid: () => true,
  release: async () => undefined,
};

/**
 * Tries to take the discovery lease. Returns `acquired: false` when another
 * process holds it, and an unguarded lease (`failedOpen: true`) when Redis
 * cannot be reached in time.
 */
export async function acquireDiscoveryLease(
  options: AcquireDiscoveryLeaseOptions = {}
): Promise<DiscoveryLeaseAcquisition> {
  const store = options.store ?? createRedisDiscoveryLeaseStore();
  const ttlMs = options.ttlMs ?? resolveDiscoveryLeaseTtlMs();
  const renewIntervalMs = options.renewIntervalMs ?? Math.max(1_000, Math.floor(ttlMs / 3));
  const opTimeoutMs = options.opTimeoutMs ?? DEFAULT_DISCOVERY_LEASE_OP_TIMEOUT_MS;
  const ownerId = options.ownerId ?? defaultOwnerId();
  const now = options.now ?? Date.now;

  // Measured BEFORE the call: Redis set the TTL at some point after this, so
  // treating this instant as "last confirmed" can only under-estimate validity.
  const acquireStartedAt = now();
  let result: DiscoveryLeaseAcquireResult;
  try {
    result = await withTimeout(
      store.tryAcquire(ownerId, ttlMs),
      opTimeoutMs,
      'discovery lease acquire'
    );
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Discovery lease unavailable (Redis unreachable); running this round without cross-process exclusion'
    );
    return { acquired: true, lease: UNGUARDED_LEASE, failedOpen: true };
  }

  if (!result.acquired) {
    return { acquired: false, holder: result.holder };
  }

  const { token, epoch } = result;
  let lastConfirmedAt = acquireStartedAt;
  let lost = false;
  let released = false;
  let renewing = false;

  const markLost = (reason: string): void => {
    if (lost) return;
    lost = true;
    clearInterval(heartbeat);
    log.warn(
      { epoch, reason },
      'Discovery lease lost; no new discovery sources will be dispatched'
    );
  };

  const heartbeat = setInterval(() => {
    if (renewing || lost || released) return;
    renewing = true;
    const startedAt = now();
    withTimeout(store.renew(token, ttlMs), opTimeoutMs, 'discovery lease renew')
      .then((stillOwner) => {
        if (released) return;
        if (stillOwner) {
          lastConfirmedAt = startedAt;
        } else {
          markLost('renewal refused: the key expired or another process owns it');
        }
      })
      .catch((error: unknown) => {
        // Transient Redis trouble: keep trying until a full TTL passes
        // without confirmation, at which point isValid() already says no.
        log.warn(
          { epoch, error: error instanceof Error ? error.message : String(error) },
          'Discovery lease renewal failed; will retry'
        );
      })
      .finally(() => {
        renewing = false;
      });
  }, renewIntervalMs);
  heartbeat.unref?.();

  const lease: DiscoveryLease = {
    token,
    epoch,
    isValid: () => !lost && !released && now() - lastConfirmedAt < ttlMs,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      if (lost) return;
      try {
        await withTimeout(store.release(token), opTimeoutMs, 'discovery lease release');
      } catch (error) {
        // The key expires on its own within ttlMs.
        log.warn(
          { epoch, error: error instanceof Error ? error.message : String(error) },
          'Discovery lease release failed; it will expire on its own'
        );
      }
    },
  };

  log.info({ epoch, ttlMs }, 'Discovery lease acquired');
  return { acquired: true, lease, failedOpen: false };
}
