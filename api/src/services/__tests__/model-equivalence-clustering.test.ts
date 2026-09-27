// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The equivalence index build: exact grouping by equivalence key, independent
 * of row order, linear work, and cooperative (yields, abort signal, wall-clock
 * deadline), so a build never pins the event loop and stops promptly.
 * The key itself is covered by model-equivalence-key.test.ts. Hermetic: pure
 * functions only; mid-build stops use deterministic seams (sliceMs 0 yields at
 * every checkpoint, an injected clock), not the speed of the machine.
 */
import { describe, it, expect } from 'vitest';
import {
  buildEquivalenceIndex,
  EquivalenceBuildStoppedError,
  type EquivalenceIndex,
} from '@/services/model-equivalence-clustering';
import {
  handFixture,
  row,
  shuffled,
  syntheticCatalog,
} from './fixtures/equivalence-catalog.fixture';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Comparable view of an index: groups by key, members in order. */
function snapshot(index: EquivalenceIndex): Array<[string, string, string[]]> {
  return [...index.groups.values()]
    .map((g): [string, string, string[]] => [
      g.groupId,
      g.canonicalName,
      g.members.map((m) => m.uid),
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

describe('model equivalence index: exact grouping', () => {
  it('groups the hand fixture by model, never by resemblance', async () => {
    const index = await buildEquivalenceIndex(handFixture());
    const groupOf = (id: string) => index.modelToKey.get(id);

    expect(groupOf('openai/gpt-5.4-pro')).toBe('gpt-5-4-pro');
    expect(groupOf('gpt-5.4-pro-2026-03-05')).toBe('gpt-5-4-pro');
    expect(index.groups.get('gpt-5-4-pro')?.members.map((m) => m.provider)).toEqual([
      'openai',
      'openai',
      'openrouter',
      'edenai',
    ]);
    expect(groupOf('anthropic/claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
    // The floating alias of 4-5 is 4-5; 4-6 is another model.
    expect(groupOf('claude-sonnet-4-5-latest')).toBe('claude-sonnet-4-5');
    expect(groupOf('claude-sonnet-4-5')).not.toBe(groupOf('claude-sonnet-4-6'));
    expect(groupOf('claude-3-5-sonnet-v2')).not.toBe(groupOf('claude-3-5-sonnet'));
    expect(groupOf('llama-3-1-70b-instruct-turbo')).not.toBe(groupOf('llama-3.1-70b-instruct'));
    expect(groupOf('llama-3.1-8b-instruct')).not.toBe(groupOf('llama-3.1-70b-instruct'));
    expect(groupOf('gemini-2.5-flash-lite@eu')).not.toBe(groupOf('gemini-2.5-flash-lite'));
    expect(groupOf('gemini-2.5-flash-preview')).not.toBe(groupOf('gemini-2.5-flash-lite'));
    expect(groupOf('deepseek-v4-flash-0731')).not.toBe(groupOf('deepseek-ai/deepseek-v4-flash'));
    expect(groupOf('o3-mini')).not.toBe(groupOf('o3'));
    // Short ids whose hashed n-gram embeddings were identical are four models.
    expect(new Set(['t3', 'mo', 'mk', 't7'].map(groupOf)).size).toBe(4);
    // The same id on two providers is one group.
    expect(index.groups.get('x')?.members.map((m) => m.provider)).toEqual([
      'huggingface',
      'featherless',
    ]);
  });

  it('every member of a group has the group key', async () => {
    const index = await buildEquivalenceIndex(syntheticCatalog(3000, 7));
    let members = 0;
    for (const [key, group] of index.groups) {
      expect(group.groupId).toBe(key);
      for (const member of group.members) {
        expect(index.modelToKey.get(member.modelId)).toBe(key);
        members++;
      }
    }
    expect(members).toBe(3000);
    expect(index.models).toBe(3000);
  });

  it('does not depend on the row order (the catalog query has no ORDER BY)', async () => {
    const rows = syntheticCatalog(4000, 3);
    const reference = snapshot(await buildEquivalenceIndex(rows));
    for (const seed of [1, 2, 3]) {
      expect(snapshot(await buildEquivalenceIndex(shuffled(rows, seed)))).toEqual(reference);
    }
    const hand = handFixture();
    expect(snapshot(await buildEquivalenceIndex(shuffled(hand, 9)))).toEqual(
      snapshot(await buildEquivalenceIndex(hand))
    );
  });
});

describe('model equivalence index: bounded, cooperative', () => {
  it('computes one key per distinct id (linear work)', async () => {
    const rows = syntheticCatalog(20000, 9);
    const index = await buildEquivalenceIndex(rows);
    const distinct = new Set(rows.map((r) => r.modelId)).size;
    expect(index.stats.distinctIds).toBe(distinct);
    expect(index.stats.keyComputations).toBe(distinct);
    expect(index.stats.rows).toBe(20000);
    expect(index.stats.keys).toBe(index.groups.size);
  });

  it('yields to the event loop at every checkpoint when the slice is 0 ms', async () => {
    let ticks = 0;
    let done = false;
    const ticker = setInterval(() => {
      if (!done) ticks++;
    }, 0);
    try {
      const index = await buildEquivalenceIndex(syntheticCatalog(10000, 12), { sliceMs: 0 });
      done = true;
      // Four passes over 10k rows with a checkpoint every 1,024 rows.
      expect(index.stats.yields).toBeGreaterThanOrEqual(40);
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(ticker);
    }
  });

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildEquivalenceIndex(handFixture(), { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'EquivalenceBuildStoppedError', reason: 'aborted' });
  });

  it('stops at its next yield when aborted mid-build', async () => {
    const controller = new AbortController();
    let settled = false;
    const build = buildEquivalenceIndex(syntheticCatalog(40000, 13), {
      signal: controller.signal,
      sliceMs: 0,
    });
    const outcome = build.then(
      () => null,
      (err: unknown) => err
    );
    void outcome.then(() => (settled = true));
    // One checkpoint (1,024 rows) per tick: after a few ticks the build is
    // still in its first pass over 40k rows.
    for (let i = 0; i < 3; i++) await tick();
    expect(settled).toBe(false);

    // Promptly: the build is parked at a yield, so it must reject when that
    // yield resumes, within the next event-loop turns (not after more work).
    controller.abort();
    await tick();
    await tick();
    expect(settled).toBe(true);
    const error = await outcome;
    expect(error).toBeInstanceOf(EquivalenceBuildStoppedError);
    expect((error as EquivalenceBuildStoppedError).reason).toBe('aborted');
  });

  it('stops at the deadline: already past, and at the first checkpoint after it', async () => {
    await expect(
      buildEquivalenceIndex(handFixture(), { deadlineAt: performance.now() - 1 })
    ).rejects.toMatchObject({ reason: 'deadline' });

    // A clock that advances 1 ms per reading (one reading per checkpoint, one
    // more per yield): the deadline falls inside the build, after it started.
    let clock = 0;
    const now = () => ++clock;
    await expect(
      buildEquivalenceIndex(syntheticCatalog(40000, 14), { deadlineAt: 25, now, sliceMs: 4 })
    ).rejects.toMatchObject({ reason: 'deadline' });
    expect(clock).toBeGreaterThanOrEqual(25);
    expect(clock).toBeLessThanOrEqual(26);
  });

  it('checks the deadline at every checkpoint, even when the slice never runs out', async () => {
    // With a slice longer than the build there is no yield at all; the
    // deadline must still stop it at a checkpoint, not after the whole build.
    let clock = 0;
    const now = () => ++clock;
    await expect(
      buildEquivalenceIndex(syntheticCatalog(40000, 15), { deadlineAt: 10, now, sliceMs: 1e9 })
    ).rejects.toMatchObject({ reason: 'deadline' });
    expect(clock).toBe(10);
  });

  it('reports the names whose snapshots keep their stamp', async () => {
    const index = await buildEquivalenceIndex([
      ...handFixture(),
      row('claude-3-5-sonnet-20240620', 'edenai', 'aggregator'),
      row('claude-3-5-sonnet-20241022', 'edenai', 'aggregator'),
    ]);
    expect(index.stats.multiSnapshotNames).toBe(1);
    // The hand fixture's only snapshot of gpt-5.4-pro still joins the name.
    expect(index.modelToKey.get('gpt-5.4-pro-2026-03-05')).toBe('gpt-5-4-pro');
    expect(index.modelToKey.get('claude-3-5-sonnet-20240620')).toBe('claude-3-5-sonnet@20240620');
    expect(index.modelToKey.get('claude-3-5-sonnet')).toBe('claude-3-5-sonnet');
  });
});
