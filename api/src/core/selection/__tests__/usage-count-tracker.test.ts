// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Usage Count Tracker — real-signal writer for the bucket-fair selection fix
 * (2026-09-07). Proves the accumulate/flush/retry-on-failure contract that
 * closes the "usage_count is written nowhere" gap the design audit found.
 *
 * `prisma.$executeRaw` is a Proxy-trapped method on the generated client
 * (confirmed while writing this: `vi.spyOn(prisma, '$executeRaw')` throws
 * "does not exist") — so this mocks `@/database/client` at the module
 * boundary via `vi.doMock` + `vi.resetModules()` + a dynamic import of the
 * module under test, matching this repo's existing convention for mocking
 * raw SQL (core/evaluation/__tests__/drift-detection.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecuteRaw = vi.fn();

async function loadTracker() {
  return import('@/core/selection/usage-count-tracker');
}

beforeEach(() => {
  vi.resetModules();
  mockExecuteRaw.mockReset();
  vi.doMock('@/database/client', () => ({
    prisma: { $executeRaw: mockExecuteRaw },
  }));
});

afterEach(() => {
  vi.doUnmock('@/database/client');
});

describe('UsageCountTracker', () => {
  it('accumulates repeated record() calls for the same (id, providerId) in memory, zero I/O', async () => {
    const { UsageCountTracker } = await loadTracker();
    const tracker = new UsageCountTracker(false); // no auto-start timer in tests
    tracker.record('gpt-4o-mini', 'openai');
    tracker.record('gpt-4o-mini', 'openai');
    tracker.record('gpt-4o-mini', 'openai');
    tracker.record('claude-haiku', 'anthropic');

    expect(mockExecuteRaw).not.toHaveBeenCalled();
    expect(tracker.__getBufferedCountForTests('gpt-4o-mini', 'openai')).toBe(3);
    expect(tracker.__getBufferedCountForTests('claude-haiku', 'anthropic')).toBe(1);
    // Different provider, same id — must not collide (compound key).
    tracker.record('gpt-4o-mini', 'aihubmix');
    expect(tracker.__getBufferedCountForTests('gpt-4o-mini', 'openai')).toBe(3);
    expect(tracker.__getBufferedCountForTests('gpt-4o-mini', 'aihubmix')).toBe(1);
  });

  it('flush() issues one batched UPDATE and clears the buffer on success', async () => {
    mockExecuteRaw.mockResolvedValue(1);
    const { UsageCountTracker } = await loadTracker();
    const tracker = new UsageCountTracker(false);
    tracker.record('gpt-4o-mini', 'openai');
    tracker.record('gpt-4o-mini', 'openai');
    tracker.record('claude-haiku', 'anthropic');

    await tracker.flush();

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    // Buffer is cleared after a successful flush.
    expect(tracker.__getBufferedCountForTests('gpt-4o-mini', 'openai')).toBe(0);
    expect(tracker.__getBufferedCountForTests('claude-haiku', 'anthropic')).toBe(0);
  });

  it('flush() with an empty buffer is a no-op (no DB call)', async () => {
    const { UsageCountTracker } = await loadTracker();
    const tracker = new UsageCountTracker(false);
    await tracker.flush();
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it('a failed flush merges deltas back into the buffer rather than dropping them', async () => {
    mockExecuteRaw.mockRejectedValue(new Error('connection reset'));
    const { UsageCountTracker } = await loadTracker();
    const tracker = new UsageCountTracker(false);
    tracker.record('gpt-4o-mini', 'openai');
    tracker.record('gpt-4o-mini', 'openai');

    await expect(tracker.flush()).rejects.toThrow();

    // The delta survives the failed flush, ready for the next attempt.
    expect(tracker.__getBufferedCountForTests('gpt-4o-mini', 'openai')).toBe(2);

    // A subsequent successful flush picks up the re-merged delta.
    mockExecuteRaw.mockResolvedValue(1);
    await tracker.flush();
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
    expect(tracker.__getBufferedCountForTests('gpt-4o-mini', 'openai')).toBe(0);
  });

  it('a retried increment after a failed flush accumulates on top of the re-merged delta', async () => {
    mockExecuteRaw.mockRejectedValue(new Error('timeout'));
    const { UsageCountTracker } = await loadTracker();
    const tracker = new UsageCountTracker(false);
    tracker.record('gpt-4o-mini', 'openai');
    await expect(tracker.flush()).rejects.toThrow();

    tracker.record('gpt-4o-mini', 'openai'); // a real execution during the outage
    expect(tracker.__getBufferedCountForTests('gpt-4o-mini', 'openai')).toBe(2);
  });

  it('ignores empty id/providerId rather than polluting the buffer', async () => {
    const { UsageCountTracker } = await loadTracker();
    const tracker = new UsageCountTracker(false);
    tracker.record('', 'openai');
    tracker.record('gpt-4o-mini', '');
    expect(tracker.__getBufferedCountForTests('', 'openai')).toBe(0);
    expect(tracker.__getBufferedCountForTests('gpt-4o-mini', '')).toBe(0);
  });
});

describe('getUsageCountTracker / recordModelUsage (singleton wiring)', () => {
  it('recordModelUsage() forwards to the process-wide singleton', async () => {
    const { getUsageCountTracker, recordModelUsage, __resetUsageCountTrackerForTests } =
      await loadTracker();
    const tracker = __resetUsageCountTrackerForTests();
    recordModelUsage('gpt-4o-mini', 'openai');
    recordModelUsage('gpt-4o-mini', 'openai');
    expect(getUsageCountTracker()).toBe(tracker);
    expect(tracker.__getBufferedCountForTests('gpt-4o-mini', 'openai')).toBe(2);
  });
});
