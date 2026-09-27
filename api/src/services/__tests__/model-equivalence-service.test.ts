// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model equivalence service: lookup contract and rebuild lifecycle.
 *
 * Lookup contract (2026-09-24 strict grouping): getEquivalentModels() returns
 * the group of the requested id's equivalence key, or null; never the group of
 * a similar-looking id. Lifecycle (2026-09-24 fix): background single-flight
 * rebuilds, atomic publish (groups and key context together), wall-clock
 * budget, abort on graceful shutdown, lookup-triggered rebuilds, narrow DB read.
 *
 * Hermetic: the Prisma client is mocked; the grouping runs for real. States
 * "in progress" are held deterministically (a deferred DB read, a 0 ms slice
 * so the build yields at every checkpoint, an injected clock), never by the
 * speed of the machine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handFixture,
  row,
  syntheticCatalog,
  type FixtureRow,
} from './fixtures/equivalence-catalog.fixture';

const h = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock('@/database/client', () => ({
  prisma: { $queryRaw: h.queryRaw },
}));

import {
  EquivalenceBuildStoppedError,
  getModelEquivalenceService,
  resetModelEquivalenceServiceForTests,
  resolveEquivalenceBuildSliceMs,
  scheduleModelEquivalenceIndexRebuild,
  shutdownModelEquivalenceIndex,
} from '@/services/model-equivalence-service';

const ENV_KEYS = [
  'MODEL_EQUIVALENCE_BUILD_BUDGET_MS',
  'MODEL_EQUIVALENCE_BUILD_SLICE_MS',
  'MODEL_EQUIVALENCE_MAX_AGE_MS',
  'MODEL_EQUIVALENCE_LAZY_REBUILD',
  'MODEL_EQUIVALENCE_LAZY_REBUILD_GRACE_MS',
] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

function dbRows(rows: FixtureRow[]) {
  return rows.map((r) => ({
    uid: r.uid,
    modelId: r.modelId,
    providerId: r.providerId,
    providerName: r.provider,
    sourceType: r.sourceType,
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  resetModelEquivalenceServiceForTests();
  h.queryRaw.mockReset();
  for (const key of ENV_KEYS) delete process.env[key];
  // Lookup-triggered rebuilds are covered explicitly below.
  process.env.MODEL_EQUIVALENCE_LAZY_REBUILD = 'false';
});

afterEach(async () => {
  const svc = getModelEquivalenceService();
  svc.abortRebuild('test-cleanup');
  await svc.whenIdle();
  resetModelEquivalenceServiceForTests();
  vi.useRealTimers();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('model equivalence service: build and lookups', () => {
  it('builds from one narrow query and serves lookups (native providers first)', async () => {
    h.queryRaw.mockResolvedValue(dbRows(handFixture()));
    const svc = getModelEquivalenceService();

    const result = await svc.buildIndex();

    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    const sql = (h.queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain("m.metadata->>'sourceType'");
    expect(sql).toContain("m.status = 'active'");
    expect(sql).not.toMatch(/SELECT[^;]*\bm\.metadata\s*,/);
    expect(result.models).toBe(handFixture().length);

    const group = svc.getEquivalentModels('openai/gpt-5.4-pro');
    expect(group?.groupId).toBe('gpt-5-4-pro');
    expect(group?.members.map((m) => m.sourceType)).toEqual([
      'native_api',
      'native_api',
      'router',
      'aggregator',
    ]);
    expect(svc.getEquivalentModels('anthropic/claude-sonnet-4.6')?.groupId).toBe(
      'claude-sonnet-4-6'
    );
    expect(svc.getEquivalentModels('completely-unrelated-thing-zz')).toBeNull();
    expect(svc.getStats()).toMatchObject({ models: handFixture().length, rebuilding: false });
  });

  it('maps an unknown sourceType to "unknown" and a missing provider name to the provider id', async () => {
    h.queryRaw.mockResolvedValue([
      { uid: 'a', modelId: 'm-one', providerId: 'p1', providerName: null, sourceType: 'weird' },
      { uid: 'b', modelId: 'm-one', providerId: 'p2', providerName: 'Prov2', sourceType: null },
    ]);
    const svc = getModelEquivalenceService();
    await svc.buildIndex();

    expect(svc.getEquivalentModels('m-one')?.members).toEqual([
      expect.objectContaining({ uid: 'a', provider: 'p1', sourceType: 'unknown' }),
      expect.objectContaining({ uid: 'b', provider: 'Prov2', sourceType: 'unknown' }),
    ]);
  });
});

describe('model equivalence service: lookup contract', () => {
  const catalog = (): FixtureRow[] => [
    row('claude-sonnet-4-6', 'anthropic', 'native_api'),
    row('anthropic/claude-sonnet-4.6', 'openrouter', 'router'),
    row('claude-sonnet-4-6', 'aihubmix', 'aggregator'),
    row('claude-sonnet-4-5', 'anthropic', 'native_api'),
    row('claude-sonnet-4-5-20250929', 'anthropic', 'native_api'),
    row('claude-sonnet-4', 'anthropic', 'native_api'),
    row('gemini-2.5-flash', 'gemini-openai', 'native_api'),
    row('gemini-2.5-flash-lite', 'gemini-openai', 'native_api'),
    row('llama-3.3-70b-instruct', 'groq', 'native_api'),
    row('devonho/llama-2-7b-miniguanaco', 'huggingface', 'aggregator'),
    row('devonho/llama-2-7b-miniguanaco', 'featherless-ai', 'aggregator'),
    row('mahenpatil/llama-2-7b-miniguanaco', 'huggingface', 'aggregator'),
  ];

  async function built() {
    h.queryRaw.mockResolvedValue(dbRows(catalog()));
    const svc = getModelEquivalenceService();
    await svc.buildIndex();
    return svc;
  }

  const ids = (group: { members: Array<{ modelId: string; providerId: string }> } | null) =>
    group?.members.map((m) => `${m.modelId}@${m.providerId}`) ?? null;

  it('resolves every spelling of an indexed model to its group, native providers first', async () => {
    const svc = await built();
    const expected = [
      'claude-sonnet-4-6@anthropic',
      'anthropic/claude-sonnet-4.6@openrouter',
      'claude-sonnet-4-6@aihubmix',
    ];
    for (const spelling of [
      'claude-sonnet-4-6',
      'anthropic/claude-sonnet-4.6',
      'Claude-Sonnet-4.6',
      'claude_sonnet_4.6',
      'anthropic/claude-sonnet-4-6',
      'claude-sonnet-4-6-latest',
    ]) {
      expect(ids(svc.getEquivalentModels(spelling))).toEqual(expected);
    }
    expect(ids(svc.getEquivalentModels('anthropic/claude-sonnet-4.5-20250929'))).toEqual([
      'claude-sonnet-4-5@anthropic',
      'claude-sonnet-4-5-20250929@anthropic',
    ]);
    expect(ids(svc.getEquivalentModels('devonho/llama-2-7b-miniguanaco'))).toEqual([
      'devonho/llama-2-7b-miniguanaco@huggingface',
      'devonho/llama-2-7b-miniguanaco@featherless-ai',
    ]);
  });

  it('never returns another version, size, variant or repository owner', async () => {
    const svc = await built();
    expect(svc.getEquivalentModels('claude-sonnet-4')?.members.map((m) => m.modelId)).toEqual([
      'claude-sonnet-4',
    ]);
    expect(svc.getEquivalentModels('gemini-2.5-flash')?.members.map((m) => m.modelId)).toEqual([
      'gemini-2.5-flash',
    ]);
    expect(
      svc.getEquivalentModels('mahenpatil/llama-2-7b-miniguanaco')?.members.map((m) => m.modelId)
    ).toEqual(['mahenpatil/llama-2-7b-miniguanaco']);
  });

  it('returns null for ids it does not index, however close they are (no nearest match)', async () => {
    const svc = await built();
    for (const unknown of [
      'claude-sonnet-4-7',
      'anthropic/claude-sonnet-4.7',
      'gemini-2.5-flash-max',
      'llama-3.4-70b-instruct',
      'llama-3.1-70b-instruct',
      'someorg/llama-2-7b-miniguanaco',
    ]) {
      expect(svc.getEquivalentModels(unknown)).toBeNull();
    }
  });

  it('hands out a copy: a caller cannot change the published group', async () => {
    const svc = await built();
    svc.getEquivalentModels('claude-sonnet-4-6')?.members.splice(0);
    expect(svc.getEquivalentModels('claude-sonnet-4-6')?.members).toHaveLength(3);
  });

  it('sameModelMembers keeps only members with the requested key (defense in depth)', async () => {
    const svc = await built();
    expect(svc.equivalenceKeyOf('anthropic/claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
    const group = svc.getEquivalentModels('claude-sonnet-4-6');
    const other = svc.getEquivalentModels('claude-sonnet-4-5');
    expect(group).not.toBeNull();
    expect(other).not.toBeNull();
    if (!group || !other) return;
    const forged = { ...group, members: [...group.members, ...other.members] };
    expect(svc.sameModelMembers('claude-sonnet-4-6', forged).map((m) => m.modelId)).toEqual([
      'claude-sonnet-4-6',
      'anthropic/claude-sonnet-4.6',
      'claude-sonnet-4-6',
    ]);
  });

  it('answers null and has no key context before the first build', () => {
    const svc = getModelEquivalenceService();
    expect(svc.getEquivalentModels('claude-sonnet-4-6')).toBeNull();
    expect(svc.equivalenceKeyOf('claude-sonnet-4-6')).toBeNull();
    expect(svc.getKeyContext()).toBeNull();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });
});

describe('model equivalence service: background rebuild', () => {
  it('requestRebuild returns immediately; the build runs and publishes in the background', async () => {
    const read = deferred<unknown[]>();
    h.queryRaw.mockReturnValueOnce(read.promise);
    const svc = getModelEquivalenceService();

    scheduleModelEquivalenceIndexRebuild('test');

    expect(svc.isRebuilding()).toBe(true);
    expect(svc.getStats().lastBuildAt).toBeNull();
    read.resolve(dbRows(handFixture()));
    await svc.whenIdle();
    expect(svc.getStats().lastBuildAt).toBeInstanceOf(Date);
    expect(svc.getEquivalentModels('gpt-5.4-pro')?.groupId).toBe('gpt-5-4-pro');
  });

  it('is single-flight: requests during a build queue exactly one follow-up', async () => {
    const read = deferred<unknown[]>();
    h.queryRaw.mockReturnValueOnce(read.promise).mockResolvedValue(dbRows(handFixture()));
    const svc = getModelEquivalenceService();

    svc.requestRebuild('a');
    svc.requestRebuild('b');
    svc.requestRebuild('c');
    svc.requestRebuild('d');
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    read.resolve(dbRows(handFixture()));
    await svc.whenIdle();

    expect(h.queryRaw).toHaveBeenCalledTimes(2);
  });

  it('lookups keep answering from the previous index until the new one is complete', async () => {
    h.queryRaw.mockResolvedValueOnce(dbRows(handFixture()));
    const svc = getModelEquivalenceService();
    await svc.buildIndex();

    const read = deferred<unknown[]>();
    h.queryRaw.mockReturnValueOnce(read.promise);
    svc.requestRebuild('catalog-changed');
    expect(svc.getEquivalentModels('gpt-5.4-pro')?.groupId).toBe('gpt-5-4-pro');
    expect(svc.getEquivalentModels('brand-new-model-q')).toBeNull();

    read.resolve(dbRows([row('brand-new-model-q', 'openai', 'native_api')]));
    await svc.whenIdle();
    expect(svc.getEquivalentModels('brand-new-model-q')?.groupId).toBe('brand-new-model-q');
    expect(svc.getEquivalentModels('gpt-5.4-pro')).toBeNull();
  });

  it('publishes the groups and the key context of one build together', async () => {
    // "deepinfra/gpt-5.4-pro" is gpt-5.4-pro only once deepinfra is a catalog
    // provider that serves gpt-5.4-pro: the key depends on the context, which
    // must swap with the groups.
    h.queryRaw.mockResolvedValueOnce(dbRows(handFixture()));
    const svc = getModelEquivalenceService();
    await svc.buildIndex();
    expect(svc.getEquivalentModels('deepinfra/gpt-5.4-pro')).toBeNull();
    expect(svc.getKeyContext()?.providerIds).not.toContain('deepinfra');

    const read = deferred<unknown[]>();
    h.queryRaw.mockReturnValueOnce(read.promise);
    svc.requestRebuild('new-provider');
    await tick();
    expect(svc.getEquivalentModels('deepinfra/gpt-5.4-pro')).toBeNull();

    read.resolve(dbRows([...handFixture(), row('gpt-5.4-pro', 'deepinfra', 'cloud_hub')]));
    await svc.whenIdle();
    expect(svc.getKeyContext()?.providerIds).toContain('deepinfra');
    const group = svc.getEquivalentModels('deepinfra/gpt-5.4-pro');
    expect(group?.groupId).toBe('gpt-5-4-pro');
    expect(group?.members.map((m) => m.providerId)).toEqual([
      'openai',
      'openai',
      'deepinfra',
      'openrouter',
      'edenai',
    ]);
  });

  it('stops at the wall-clock budget during the DB read and keeps the previous index', async () => {
    h.queryRaw.mockResolvedValueOnce(dbRows(handFixture()));
    const svc = getModelEquivalenceService();
    await svc.buildIndex();
    const builtAt = svc.getStats().lastBuildAt;

    process.env.MODEL_EQUIVALENCE_BUILD_BUDGET_MS = '50';
    h.queryRaw.mockReturnValueOnce(new Promise(() => undefined));
    svc.requestRebuild('slow-db');
    await svc.whenIdle();

    expect(svc.isRebuilding()).toBe(false);
    expect(svc.getStats().lastBuildAt).toBe(builtAt);
    expect(svc.getEquivalentModels('gpt-5.4-pro')?.groupId).toBe('gpt-5-4-pro');
  });

  it('stops at the wall-clock budget during the grouping and keeps the previous index', async () => {
    h.queryRaw.mockResolvedValueOnce(dbRows(handFixture()));
    const svc = getModelEquivalenceService();
    await svc.buildIndex();
    const builtAt = svc.getStats().lastBuildAt;

    // An injected clock that advances 1 ms per reading: the 20 ms budget runs
    // out a few checkpoints into the grouping of 40k rows, on any machine, and
    // the build stops at the first checkpoint past it.
    let clock = 0;
    h.queryRaw.mockResolvedValueOnce(dbRows(syntheticCatalog(40000, 21)));
    await expect(
      svc.buildIndex({ budgetMs: 20, sliceMs: 0, now: () => ++clock })
    ).rejects.toMatchObject({ name: 'EquivalenceBuildStoppedError', reason: 'deadline' });

    expect(clock).toBeGreaterThanOrEqual(21);
    expect(clock).toBeLessThanOrEqual(22);
    expect(svc.getStats().lastBuildAt).toBe(builtAt);
    expect(svc.getStats().models).toBe(handFixture().length);
    expect(svc.getEquivalentModels('gpt-5.4-pro')?.groupId).toBe('gpt-5-4-pro');
  });

  it('keeps the previous index when the DB read fails', async () => {
    h.queryRaw.mockResolvedValueOnce(dbRows(handFixture()));
    const svc = getModelEquivalenceService();
    await svc.buildIndex();

    h.queryRaw.mockRejectedValueOnce(new Error('too many clients'));
    svc.requestRebuild('db-down');
    await svc.whenIdle();

    expect(svc.isRebuilding()).toBe(false);
    expect(svc.getEquivalentModels('gpt-5.4-pro')?.groupId).toBe('gpt-5-4-pro');
  });
});

describe('model equivalence service: graceful shutdown', () => {
  it('aborts an in-progress grouping promptly and refuses new builds', async () => {
    // A 0 ms slice makes the background build yield at every checkpoint
    // (1,024 rows), so after a few event-loop turns it is inside the grouping.
    process.env.MODEL_EQUIVALENCE_BUILD_SLICE_MS = '0';
    h.queryRaw.mockResolvedValue(dbRows(syntheticCatalog(40000, 22)));
    const svc = getModelEquivalenceService();
    svc.requestRebuild('before-shutdown');
    for (let i = 0; i < 5; i++) await tick();
    expect(svc.isRebuilding()).toBe(true);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);

    // Promptly: the build is parked at a yield and stops when it resumes,
    // within the next event-loop turns.
    shutdownModelEquivalenceIndex();
    await tick();
    await tick();
    expect(svc.isRebuilding()).toBe(false);
    await svc.whenIdle();

    expect(svc.getStats().lastBuildAt).toBeNull();
    svc.requestRebuild('after-shutdown');
    scheduleModelEquivalenceIndexRebuild('after-shutdown');
    expect(svc.isRebuilding()).toBe(false);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('aborts a build that is still waiting on the DB read', async () => {
    h.queryRaw.mockReturnValueOnce(new Promise(() => undefined));
    const svc = getModelEquivalenceService();
    svc.requestRebuild('before-shutdown');

    const t0 = Date.now();
    shutdownModelEquivalenceIndex();
    await svc.whenIdle();
    expect(Date.now() - t0).toBeLessThan(200);
    expect(svc.getStats().lastBuildAt).toBeNull();
  });

  it('bounds the slice knob: a slice longer than the build would never see the abort', () => {
    for (const [raw, expected] of [
      ['0', 0],
      ['8', 8],
      ['50', 50],
      ['51', undefined],
      ['1e9', undefined],
      ['-1', undefined],
      ['soon', undefined],
      ['', undefined],
    ] as const) {
      process.env.MODEL_EQUIVALENCE_BUILD_SLICE_MS = raw;
      expect(resolveEquivalenceBuildSliceMs()).toBe(expected);
    }
  });

  it('a direct build rejects with the abort reason', async () => {
    const read = deferred<unknown[]>();
    h.queryRaw.mockReturnValueOnce(read.promise);
    const controller = new AbortController();
    const build = getModelEquivalenceService().buildIndex({ signal: controller.signal });
    controller.abort();
    await expect(build).rejects.toBeInstanceOf(EquivalenceBuildStoppedError);
  });
});

describe('model equivalence service: lookup-triggered rebuilds', () => {
  beforeEach(() => {
    process.env.MODEL_EQUIVALENCE_LAZY_REBUILD = 'true';
    process.env.MODEL_EQUIVALENCE_LAZY_REBUILD_GRACE_MS = '0';
  });

  it('the first lookup of a process with no index starts one background build', async () => {
    h.queryRaw.mockResolvedValue(dbRows(handFixture()));
    const svc = getModelEquivalenceService();

    expect(svc.getEquivalentModels('gpt-5.4-pro')).toBeNull();
    expect(svc.isRebuilding()).toBe(true);
    await svc.whenIdle();

    expect(svc.getEquivalentModels('gpt-5.4-pro')?.groupId).toBe('gpt-5-4-pro');
    svc.getEquivalentModels('claude-sonnet-4-6');
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('does not trigger during the boot grace period or when disabled', () => {
    h.queryRaw.mockResolvedValue(dbRows(handFixture()));
    const svc = getModelEquivalenceService();

    process.env.MODEL_EQUIVALENCE_LAZY_REBUILD_GRACE_MS = String(1e12);
    svc.getEquivalentModels('gpt-5.4-pro');
    process.env.MODEL_EQUIVALENCE_LAZY_REBUILD_GRACE_MS = '0';
    process.env.MODEL_EQUIVALENCE_LAZY_REBUILD = 'false';
    svc.getEquivalentModels('gpt-5.4-pro');

    expect(svc.isRebuilding()).toBe(false);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it('refreshes a stale index at most once per max-age window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T00:00:00Z'));
    process.env.MODEL_EQUIVALENCE_MAX_AGE_MS = '60000';
    h.queryRaw.mockResolvedValueOnce(dbRows(handFixture()));
    const svc = getModelEquivalenceService();
    await svc.buildIndex();

    svc.getEquivalentModels('gpt-5.4-pro');
    expect(svc.isRebuilding()).toBe(false);

    vi.setSystemTime(new Date('2026-09-24T00:01:01Z'));
    h.queryRaw.mockRejectedValueOnce(new Error('db down'));
    svc.getEquivalentModels('gpt-5.4-pro');
    expect(svc.isRebuilding()).toBe(true);
    await svc.whenIdle();

    // The refresh failed: the old index still answers, and the next attempt
    // waits for the next window instead of hammering the DB on every lookup.
    expect(svc.getEquivalentModels('gpt-5.4-pro')?.groupId).toBe('gpt-5-4-pro');
    expect(svc.isRebuilding()).toBe(false);
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
  });
});
