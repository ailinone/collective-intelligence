// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit contract of publishCatalogSnapshotCas (catalog-snapshot-publisher.ts):
 * what it sends to Redis and how it maps the script result, against a
 * Map-backed fake that models the script (fake-catalog-redis.ts). The Lua
 * itself runs against a real Redis 7 in
 * catalog-snapshot-publisher.integration.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { CATALOG_REDIS_KEY, CATALOG_REDIS_META_KEY } from '@/services/catalog-hot-path';
import {
  CATALOG_SNAPSHOT_PUBLISH_SCRIPT,
  CATALOG_SNAPSHOT_STAGING_PREFIX,
  CATALOG_SNAPSHOT_STAGING_TTL_MS,
  publishCatalogSnapshotCas,
} from '@/services/catalog-snapshot-publisher';
import { runCatalogPublishScript } from './fake-catalog-redis';

function makeFakeRedis(store = new Map<string, string>()) {
  const set = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  });
  const del = vi.fn(async (key: string) => (store.delete(key) ? 1 : 0));
  const evalFn = vi.fn(async (script: unknown, numKeys: unknown, ...args: unknown[]) =>
    runCatalogPublishScript(store, script, numKeys, ...args)
  );
  const client = { set, del, eval: evalFn } as unknown as Redis;
  return { store, set, del, eval: evalFn, client };
}

function snapshot(ids: string[], generatedAt: number) {
  return {
    json: JSON.stringify(ids.map((id) => ({ id }))),
    meta: { fingerprint: `fp-${ids.join('-')}`, rowCount: ids.length, generatedAt },
  };
}

function liveIds(store: Map<string, string>): string[] {
  return (JSON.parse(store.get(CATALOG_REDIS_KEY) ?? '[]') as Array<{ id: string }>).map((m) => m.id);
}

function liveVersion(store: Map<string, string>): number | undefined {
  const raw = store.get(CATALOG_REDIS_META_KEY);
  return raw ? (JSON.parse(raw) as { generatedAt: number }).generatedAt : undefined;
}

describe('publishCatalogSnapshotCas', () => {
  it('stages the payload with a short TTL, then swaps via one EVAL with keys and args in script order', async () => {
    const redis = makeFakeRedis();
    const snap = snapshot(['a'], 1_000);

    await expect(publishCatalogSnapshotCas(redis.client, snap, 90_000)).resolves.toBe('published');

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [stagingKey, payload, mode, stagingTtl] = redis.set.mock.calls[0] as unknown as [
      string,
      string,
      string,
      number,
    ];
    expect(stagingKey.startsWith(CATALOG_SNAPSHOT_STAGING_PREFIX)).toBe(true);
    expect(payload).toBe(snap.json);
    expect(mode).toBe('PX');
    expect(stagingTtl).toBe(CATALOG_SNAPSHOT_STAGING_TTL_MS);

    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.eval.mock.calls[0]).toEqual([
      CATALOG_SNAPSHOT_PUBLISH_SCRIPT,
      3,
      stagingKey,
      CATALOG_REDIS_KEY,
      CATALOG_REDIS_META_KEY,
      JSON.stringify(snap.meta),
      '1000',
      '90000',
    ]);
    // The large payload never travels as a script argument.
    expect((redis.eval.mock.calls[0] as unknown[]).includes(snap.json)).toBe(false);

    expect(liveIds(redis.store)).toEqual(['a']);
    expect(liveVersion(redis.store)).toBe(1_000);
    expect([...redis.store.keys()].sort()).toEqual([CATALOG_REDIS_KEY, CATALOG_REDIS_META_KEY].sort());
  });

  it('rejects an older version when a newer snapshot is live, and removes its staging copy', async () => {
    const redis = makeFakeRedis();
    await publishCatalogSnapshotCas(redis.client, snapshot(['new'], 2_000), 90_000);

    await expect(
      publishCatalogSnapshotCas(redis.client, snapshot(['old'], 1_000), 90_000)
    ).resolves.toBe('superseded');

    expect(liveIds(redis.store)).toEqual(['new']);
    expect(liveVersion(redis.store)).toBe(2_000);
    expect([...redis.store.keys()].some((k) => k.startsWith(CATALOG_SNAPSHOT_STAGING_PREFIX))).toBe(false);
  });

  it('accepts a newer or equal version', async () => {
    const redis = makeFakeRedis();
    await publishCatalogSnapshotCas(redis.client, snapshot(['v1'], 1_000), 90_000);

    await expect(publishCatalogSnapshotCas(redis.client, snapshot(['v1b'], 1_000), 90_000)).resolves.toBe(
      'published'
    );
    expect(liveIds(redis.store)).toEqual(['v1b']);

    await expect(publishCatalogSnapshotCas(redis.client, snapshot(['v2'], 3_000), 90_000)).resolves.toBe(
      'published'
    );
    expect(liveIds(redis.store)).toEqual(['v2']);
    expect(liveVersion(redis.store)).toBe(3_000);
  });

  it('publishes an older version when the newer meta has lost its snapshot (evicted), so readers are not left without one', async () => {
    const redis = makeFakeRedis();
    await publishCatalogSnapshotCas(redis.client, snapshot(['new'], 2_000), 90_000);
    redis.store.delete(CATALOG_REDIS_KEY);

    await expect(publishCatalogSnapshotCas(redis.client, snapshot(['old'], 1_000), 90_000)).resolves.toBe(
      'published'
    );
    expect(liveIds(redis.store)).toEqual(['old']);
    expect(liveVersion(redis.store)).toBe(1_000);
  });

  it('treats a malformed or legacy meta as absent', async () => {
    const redis = makeFakeRedis();
    redis.store.set(CATALOG_REDIS_KEY, '[]');
    redis.store.set(CATALOG_REDIS_META_KEY, '{not json');

    await expect(publishCatalogSnapshotCas(redis.client, snapshot(['a'], 1_000), 90_000)).resolves.toBe(
      'published'
    );
    expect(liveIds(redis.store)).toEqual(['a']);
  });

  it('reports staging-lost when the staging copy is gone before the swap, leaving the live pair untouched', async () => {
    const redis = makeFakeRedis();
    await publishCatalogSnapshotCas(redis.client, snapshot(['live'], 1_000), 90_000);
    redis.set.mockImplementationOnce(async () => 'OK'); // staging write "evicted" immediately

    await expect(publishCatalogSnapshotCas(redis.client, snapshot(['next'], 2_000), 90_000)).resolves.toBe(
      'staging-lost'
    );
    expect(liveIds(redis.store)).toEqual(['live']);
    expect(liveVersion(redis.store)).toBe(1_000);
  });

  it('deletes the staging copy and rethrows when the script call fails', async () => {
    const redis = makeFakeRedis();
    redis.eval.mockRejectedValueOnce(new Error('NOSCRIPT or connection reset'));

    await expect(
      publishCatalogSnapshotCas(redis.client, snapshot(['a'], 1_000), 90_000)
    ).rejects.toThrow('connection reset');

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.store.size).toBe(0);
  });

  it('treats an unexpected script reply as a failure and cleans up', async () => {
    const redis = makeFakeRedis();
    redis.eval.mockResolvedValueOnce('OK' as unknown as number);

    await expect(publishCatalogSnapshotCas(redis.client, snapshot(['a'], 1_000), 90_000)).rejects.toThrow(
      /returned OK/
    );
    expect(redis.store.size).toBe(0);
  });
});
