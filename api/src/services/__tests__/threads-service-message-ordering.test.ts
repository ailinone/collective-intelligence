// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Initial thread messages must be inserted in caller order, one at a time.
 *
 * `thread_messages.created_at` is `TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP` —
 * transaction-start time at millisecond resolution — and `listMessages` orders by
 * it. `createThread` used to dispatch every initial message with
 * `messages.map(... prisma.threadMessage.create ...)` followed by
 * `await Promise.all(...)`, so the inserts raced on separate pool connections.
 * Two of them routinely began inside the same millisecond, tied exactly, and came
 * back in whatever order the plan yielded: Postgres's sort is unstable for tied
 * keys, and the ids are random (`msg_${nanoid(24)}`), so nothing broke the tie.
 *
 * Measured against the real schema on a throwaway Postgres, 200 iterations:
 * concurrent inserts tied on `created_at` in 167/200 runs and returned the
 * assistant message first in 46% of them; the same inserts awaited sequentially
 * produced 0/100 ties and the correct order 100/100.
 *
 * That is what made `assistants-threads-e2e` fail intermittently on `main` — it
 * asserts `messages[0].role === 'user'`, which was a coin flip. It failed a
 * production deploy on 2026-08-24 while passing on the commit immediately before,
 * with no relevant code change between them.
 *
 * This test pins the mechanism rather than the symptom: it asserts the second
 * insert is not even ISSUED until the first has resolved, which is deterministic
 * and needs no database. A timing- or statistics-based test would reintroduce the
 * flakiness it exists to prevent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` is hoisted above the imports, so the mock functions have to be created
// inside `vi.hoisted` to exist by the time the factory runs.
const { threadCreate, messageCreate } = vi.hoisted(() => ({
  threadCreate: vi.fn(),
  messageCreate: vi.fn(),
}));

vi.mock('@/database/client', () => ({
  prisma: {
    thread: { create: threadCreate },
    threadMessage: { create: messageCreate },
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { ThreadsService } from '@/services/threads-service';

const userContext = { organizationId: 'org_1', userId: 'user_1' } as never;

/** Lets the event loop drain every pending microtask and immediate. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  threadCreate.mockResolvedValue({
    id: 'thread_x',
    createdAt: new Date(0),
    metadata: {},
  });
});

describe('createThread initial message ordering', () => {
  it('does not issue the second insert until the first has resolved', async () => {
    let releaseFirst!: () => void;
    const firstInsertGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    messageCreate.mockImplementation(async ({ data }: { data: { role: string } }) => {
      if (data.role === 'user') await firstInsertGate;
      return data;
    });

    const service = new ThreadsService();
    const pending = service.createThread({
      messages: [
        { role: 'user', content: 'primeira' },
        { role: 'assistant', content: 'segunda' },
      ],
      userContext,
    } as never);

    await flush();

    // With `Promise.all` over a `.map`, BOTH creates are invoked synchronously
    // inside the map and this is 2 — the race the fix removes.
    expect(messageCreate).toHaveBeenCalledTimes(1);
    expect(messageCreate.mock.calls[0][0].data.role).toBe('user');

    releaseFirst();
    await pending;

    expect(messageCreate).toHaveBeenCalledTimes(2);
    expect(messageCreate.mock.calls.map((c) => c[0].data.role)).toEqual(['user', 'assistant']);
  });

  it('preserves caller order for more than two messages', async () => {
    messageCreate.mockImplementation(async ({ data }: { data: unknown }) => data);

    const service = new ThreadsService();
    await service.createThread({
      messages: [
        { role: 'user', content: 'um' },
        { role: 'assistant', content: 'dois' },
        { role: 'user', content: 'tres' },
      ],
      userContext,
    } as never);

    expect(messageCreate.mock.calls.map((c) => c[0].data.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    // Distinct ids, so the rows are genuinely separate inserts rather than retries.
    const ids = messageCreate.mock.calls.map((c) => c[0].data.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('still creates the thread when no initial messages are given', async () => {
    messageCreate.mockImplementation(async ({ data }: { data: unknown }) => data);

    const service = new ThreadsService();
    const thread = await new ThreadsService().createThread({ userContext } as never);

    expect(messageCreate).not.toHaveBeenCalled();
    expect(thread.id).toBe('thread_x');
    expect(service).toBeInstanceOf(ThreadsService);
  });
});
