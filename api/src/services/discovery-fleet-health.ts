// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Fleet-wide discovery health, the input of the auto-disable circuit breaker
 * (pricing-integrity-job.ts, sweep 2).
 *
 * Why: CentralModelDiscoveryService keeps per-source health in process
 * memory, and only a discovery round that ran IN THAT PROCESS fills it. With
 * the discovery lease (discovery-lease.ts) only one process runs a round at a
 * time, and with MODEL_DISCOVERY_RUN_ON_START=false no api task runs one at
 * boot, so the process that picks up the daily auto-disable tick usually has
 * no health data at all. getProvidersWithoutHealthyDiscovery() cannot flag a
 * provider it has no data for, so on such a process the breaker exempted
 * nothing and the sweep could disable a provider's whole stale catalog while
 * that provider's discovery was broken: the 2026-09-08 and 2026-09-13
 * incident class.
 *
 * What:
 *   - The process that completes a FULL round (every source dispatched, none
 *     skipped because the lease was lost) publishes the breaker verdict it
 *     computed (providers with no healthy discovery source, completion time)
 *     to one key on `redis-lease`, the noeviction instance the lease uses.
 *   - The sweep takes the freshest verdict it can prove, from this process or
 *     from the fleet key, and exempts the union of the flagged providers of
 *     every fresh verdict. When no verdict is fresh it disables nothing that
 *     tick (fail closed): a missed daily sweep only delays a disable, while a
 *     blind sweep can take a provider's catalog offline.
 *
 * Plain SET with a TTL, no compare-and-set: the reader enforces freshness by
 * `completedAt`, and rounds are serialized by the lease, so the worst case of
 * an out-of-order write is a slightly older verdict that is still fresh.
 * Redis trouble never throws out of this module: a failed publish is a
 * warning, and a failed read counts as "no fleet verdict".
 */
import { hostname } from 'os';
import { getQueueRedisClient } from '@/cache/redis-client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'discovery-fleet-health' });

export const DISCOVERY_HEALTH_SNAPSHOT_KEY = 'ci:model-discovery:health-snapshot';

/** Garbage-collection TTL of the key; freshness is decided by the reader. */
export const DISCOVERY_HEALTH_SNAPSHOT_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Oldest complete discovery round the auto-disable sweep still trusts.
 * Discovery runs hourly, so 3 h tolerates two missed ticks.
 */
export const DEFAULT_DISCOVERY_SIGNAL_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/** Upper bound for any single Redis call made by this module. */
export const DEFAULT_DISCOVERY_HEALTH_OP_TIMEOUT_MS = 5_000;

export interface DiscoveryHealthSnapshot {
  version: 1;
  /** Epoch ms at which the publishing process finished the round. */
  completedAt: number;
  /** getProvidersWithoutHealthyDiscovery() of the publisher, sorted. */
  unhealthyProviders: string[];
  /** Number of sources the round dispatched. */
  sourcesAttempted: number;
  /** `<hostname>:<pid>` of the publisher, for logs. */
  owner: string;
  /** Lease epoch the round ran under; null when the lease failed open. */
  leaseEpoch: number | null;
}

/** Storage contract. Redis in production; an in-memory fake in unit tests. */
export interface DiscoveryHealthSnapshotStore {
  read(): Promise<string | null>;
  write(value: string, ttlMs: number): Promise<void>;
}

/** Minimal slice of ioredis the store needs (keeps the store unit-testable). */
export interface SnapshotRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
}

function defaultSnapshotRedisClient(): SnapshotRedisClient {
  const redis = getQueueRedisClient();
  return {
    get: (key) => redis.get(key),
    set: (key, value, mode, ttlMs) => redis.set(key, value, mode, ttlMs),
  };
}

export function createRedisDiscoveryHealthSnapshotStore(
  getClient: () => SnapshotRedisClient = defaultSnapshotRedisClient,
  key: string = DISCOVERY_HEALTH_SNAPSHOT_KEY
): DiscoveryHealthSnapshotStore {
  return {
    async read() {
      return getClient().get(key);
    },
    async write(value, ttlMs) {
      await getClient().set(key, value, 'PX', ttlMs);
    },
  };
}

/**
 * MODEL_AUTO_DISABLE_DISCOVERY_MAX_AGE_MS overrides the default; an invalid
 * or non-positive value falls back to it.
 */
export function resolveDiscoverySignalMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.MODEL_AUTO_DISABLE_DISCOVERY_MAX_AGE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DISCOVERY_SIGNAL_MAX_AGE_MS;
}

export function discoveryHealthOwnerId(): string {
  return `${hostname()}:${process.pid}`;
}

/** Validates a stored snapshot; anything unexpected reads as "no verdict". */
export function parseDiscoveryHealthSnapshot(raw: unknown): DiscoveryHealthSnapshot | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return null;
  if (typeof v.completedAt !== 'number' || !Number.isFinite(v.completedAt)) return null;
  if (!Array.isArray(v.unhealthyProviders)) return null;
  const rawProviders: unknown[] = v.unhealthyProviders;
  const unhealthyProviders: string[] = [];
  for (const provider of rawProviders) {
    if (typeof provider !== 'string') return null;
    unhealthyProviders.push(provider);
  }
  if (typeof v.sourcesAttempted !== 'number' || !Number.isFinite(v.sourcesAttempted)) return null;
  return {
    version: 1,
    completedAt: v.completedAt,
    unhealthyProviders,
    sourcesAttempted: v.sourcesAttempted,
    owner: typeof v.owner === 'string' ? v.owner : 'unknown',
    leaseEpoch: typeof v.leaseEpoch === 'number' ? v.leaseEpoch : null,
  };
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

export interface DiscoveryHealthStoreOptions {
  store?: DiscoveryHealthSnapshotStore;
  opTimeoutMs?: number;
}

/** Best-effort publish; returns false (and warns) instead of throwing. */
export async function publishDiscoveryHealthSnapshot(
  snapshot: DiscoveryHealthSnapshot,
  options: DiscoveryHealthStoreOptions = {}
): Promise<boolean> {
  const store = options.store ?? createRedisDiscoveryHealthSnapshotStore();
  const opTimeoutMs = options.opTimeoutMs ?? DEFAULT_DISCOVERY_HEALTH_OP_TIMEOUT_MS;
  try {
    await withTimeout(
      store.write(JSON.stringify(snapshot), DISCOVERY_HEALTH_SNAPSHOT_TTL_MS),
      opTimeoutMs,
      'discovery health publish'
    );
    return true;
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Could not publish the fleet discovery health snapshot; other processes keep the previous one'
    );
    return false;
  }
}

/** Reads the fleet verdict; null when absent, malformed or unreachable. */
export async function readDiscoveryHealthSnapshot(
  options: DiscoveryHealthStoreOptions = {}
): Promise<DiscoveryHealthSnapshot | null> {
  const store = options.store ?? createRedisDiscoveryHealthSnapshotStore();
  const opTimeoutMs = options.opTimeoutMs ?? DEFAULT_DISCOVERY_HEALTH_OP_TIMEOUT_MS;
  let raw: string | null;
  try {
    raw = await withTimeout(store.read(), opTimeoutMs, 'discovery health read');
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Could not read the fleet discovery health snapshot; treating it as absent'
    );
    return null;
  }
  const snapshot = parseDiscoveryHealthSnapshot(raw);
  if (raw !== null && snapshot === null) {
    log.warn('Fleet discovery health snapshot is malformed; treating it as absent');
  }
  return snapshot;
}

/** One verdict the breaker may use: this process's own, or the fleet's. */
export interface DiscoverySignalCandidate {
  basis: 'local' | 'fleet';
  completedAt: number;
  unhealthyProviders: Iterable<string>;
}

export type AutoDisableDiscoverySignal =
  | {
      trusted: true;
      /** Where the newest fresh verdict came from. */
      basis: 'local' | 'fleet';
      completedAt: Date;
      ageMs: number;
      /** Union of the flagged providers of every fresh verdict. */
      unhealthyProviders: Set<string>;
    }
  | {
      trusted: false;
      reason: string;
      /** Newest verdict seen, even if too old; null when there was none. */
      newestCompletedAt: Date | null;
    };

/**
 * Pure decision behind the breaker. Trusted only when at least one verdict
 * comes from a complete round no older than `maxAgeMs`.
 */
export function decideAutoDisableDiscoverySignal(
  candidates: ReadonlyArray<DiscoverySignalCandidate | null>,
  maxAgeMs: number,
  now: number
): AutoDisableDiscoverySignal {
  const present = candidates.filter((c): c is DiscoverySignalCandidate => c !== null);
  const fresh = present
    .filter((c) => now - c.completedAt <= maxAgeMs)
    .sort((a, b) => b.completedAt - a.completedAt);

  if (fresh.length === 0) {
    const newest = present.reduce<number | null>(
      (acc, c) => (acc === null || c.completedAt > acc ? c.completedAt : acc),
      null
    );
    const reason =
      newest === null
        ? 'no complete discovery round has been recorded by this process or the fleet'
        : `the newest complete discovery round finished ${Math.round((now - newest) / 60_000)} min ago, ` +
          `older than the ${Math.round(maxAgeMs / 60_000)} min limit`;
    return {
      trusted: false,
      reason,
      newestCompletedAt: newest === null ? null : new Date(newest),
    };
  }

  const unhealthyProviders = new Set<string>();
  for (const candidate of fresh) {
    for (const provider of candidate.unhealthyProviders) unhealthyProviders.add(provider);
  }
  const newest = fresh[0];
  return {
    trusted: true,
    basis: newest.basis,
    completedAt: new Date(newest.completedAt),
    ageMs: Math.max(0, now - newest.completedAt),
    unhealthyProviders,
  };
}
