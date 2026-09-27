// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Conditional (compare-and-swap) publish of the fleet-wide catalog snapshot.
 *
 * Before this, publishCatalogSnapshotToRedis did two plain SETs, so the last
 * writer won: a producer whose Postgres read started earlier but finished
 * later (slow query under contention, a boot rebuild racing the elected
 * `catalog-cache-refresh` job) overwrote a newer snapshot with older rows.
 *
 * Protocol, one extra round trip and no large Lua argument:
 *   1. SET the serialized snapshot under a unique staging key (short TTL).
 *   2. EVAL a small script that, atomically:
 *        - returns -1 if the staging key is gone (evicted, the cache Redis is
 *          allkeys-lru);
 *        - returns 0 and drops the staging key if the published meta carries
 *          a newer version AND its snapshot is still there;
 *        - otherwise RENAMEs staging over the live key (O(1), no copy), sets
 *          its TTL and writes the meta, and returns 1.
 *
 * The snapshot itself (>100 MB) deliberately never goes through EVAL: Redis
 * copies script arguments into the Lua heap and again into the stored
 * value, which would roughly double the transient memory of a publish on a
 * `redis-cache` capped at 400 MB (container limit 512 MB). RENAME moves the
 * already-stored value instead.
 *
 * The version is meta.generatedAt, the wall-clock ms at which the producer
 * STARTED its Postgres read (the rows reflect the database as of about that
 * instant). All producers run on the same Swarm node today; across nodes the
 * comparison is only as good as NTP, and a skewed clock can at worst reject
 * a publish until the next tick.
 *
 * Snapshot and meta now change together in one atomic step, which is
 * stronger than the previous "snapshot first, meta second" ordering.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  CATALOG_REDIS_KEY,
  CATALOG_REDIS_META_KEY,
  type CatalogSnapshotMeta,
} from '@/services/catalog-hot-path';

/** Lifetime of an unclaimed staging copy (publisher crashed between steps). */
export const CATALOG_SNAPSHOT_STAGING_TTL_MS = 120_000;

export const CATALOG_SNAPSHOT_STAGING_PREFIX = `${CATALOG_REDIS_KEY}:staging:`;

/**
 * KEYS[1] staging snapshot, KEYS[2] live snapshot, KEYS[3] live meta.
 * ARGV[1] meta JSON, ARGV[2] version (ms), ARGV[3] TTL (ms) for live keys.
 */
export const CATALOG_SNAPSHOT_PUBLISH_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return -1
end
local current = redis.call('GET', KEYS[3])
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and type(decoded) == 'table' then
    local currentVersion = tonumber(decoded['generatedAt'])
    if currentVersion and currentVersion > tonumber(ARGV[2])
      and redis.call('EXISTS', KEYS[2]) == 1 then
      redis.call('DEL', KEYS[1])
      return 0
    end
  end
end
redis.call('RENAME', KEYS[1], KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[1], 'PX', ARGV[3])
return 1
`;

export type CatalogSnapshotPublishOutcome =
  /** Snapshot and meta replaced atomically. */
  | 'published'
  /** A newer snapshot is live; this one was discarded. */
  | 'superseded'
  /** The staging copy disappeared before the swap (eviction); nothing changed. */
  | 'staging-lost';

export type CatalogSnapshotRedis = Pick<Redis, 'set' | 'eval' | 'del'>;

export async function publishCatalogSnapshotCas(
  redis: CatalogSnapshotRedis,
  snapshot: { json: string; meta: CatalogSnapshotMeta },
  ttlMs: number
): Promise<CatalogSnapshotPublishOutcome> {
  const stagingKey = `${CATALOG_SNAPSHOT_STAGING_PREFIX}${randomUUID()}`;
  await redis.set(stagingKey, snapshot.json, 'PX', CATALOG_SNAPSHOT_STAGING_TTL_MS);
  let result: unknown;
  try {
    result = await redis.eval(
      CATALOG_SNAPSHOT_PUBLISH_SCRIPT,
      3,
      stagingKey,
      CATALOG_REDIS_KEY,
      CATALOG_REDIS_META_KEY,
      JSON.stringify(snapshot.meta),
      String(snapshot.meta.generatedAt),
      String(Math.max(1, Math.floor(ttlMs)))
    );
  } catch (error) {
    // Do not leave a >100 MB orphan in an LRU cache for the staging TTL.
    await redis.del(stagingKey).catch(() => undefined);
    throw error;
  }
  switch (Number(result)) {
    case 1:
      return 'published';
    case 0:
      return 'superseded';
    case -1:
      return 'staging-lost';
    default:
      await redis.del(stagingKey).catch(() => undefined);
      throw new Error(`catalog snapshot publish script returned ${String(result)}`);
  }
}
