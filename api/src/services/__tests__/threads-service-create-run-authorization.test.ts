// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * BOLA regression test for `ThreadsService.createRun`.
 *
 * `createRun` took `assistant_id` from the caller and used it to create (and
 * enqueue for execution) a run against that Assistant, without ever checking
 * that the Assistant belongs to the caller's own organization. Any caller who
 * knew or guessed another tenant's `assistant_id` (a nanoid) could run that
 * tenant's private Assistant configuration. The fix mirrors the org-scoped
 * lookup already used by `AssistantsService` (e.g. `getAssistant`): look the
 * Assistant up with `organizationId` in the `where` clause and treat a miss
 * as "not found" rather than loading it unscoped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` is hoisted above the imports, so the mock functions have to be created
// inside `vi.hoisted` to exist by the time the factory runs.
const { threadFindFirst, assistantFindFirst, threadRunCreate, stepFindFirst, stepFindMany } =
  vi.hoisted(() => ({
    threadFindFirst: vi.fn(),
    assistantFindFirst: vi.fn(),
    threadRunCreate: vi.fn(),
    stepFindFirst: vi.fn(),
    stepFindMany: vi.fn(),
  }));

vi.mock('@/database/client', () => ({
  prisma: {
    thread: { findFirst: threadFindFirst },
    assistant: { findFirst: assistantFindFirst },
    threadRun: { create: threadRunCreate },
    threadRunStep: { findFirst: stepFindFirst, findMany: stepFindMany },
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

vi.mock('@/services/thread-run-queue-service', () => ({
  threadRunQueueService: {
    isAvailable: () => false,
    enqueue: vi.fn(),
  },
}));

import { ThreadsService } from '@/services/threads-service';

const userContext = { organizationId: 'org_mine', userId: 'user_1' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  threadFindFirst.mockResolvedValue({
    id: 'thread_x',
    organizationId: 'org_mine',
  });
});

describe('createRun assistant organization scoping', () => {
  it('rejects a run when the assistant belongs to another organization', async () => {
    // Scoped lookup finds nothing because the assistant is not in this org.
    assistantFindFirst.mockResolvedValue(null);

    const service = new ThreadsService();
    await expect(
      service.createRun({
        threadId: 'thread_x',
        assistant_id: 'asst_other_org',
        userContext,
        requestId: 'req_1',
      } as never)
    ).rejects.toThrow(/not found/i);

    // The lookup itself must be scoped to the caller's organization.
    expect(assistantFindFirst).toHaveBeenCalledWith({
      where: { id: 'asst_other_org', organizationId: 'org_mine' },
    });
    expect(threadRunCreate).not.toHaveBeenCalled();
  });

  it('creates the run when the assistant belongs to the caller organization', async () => {
    assistantFindFirst.mockResolvedValue({
      id: 'asst_mine',
      organizationId: 'org_mine',
    });
    threadRunCreate.mockResolvedValue({
      id: 'run_1',
      threadId: 'thread_x',
      assistantId: 'asst_mine',
      status: 'queued',
      createdAt: new Date(0),
      expiresAt: new Date(0),
      startedAt: null,
      cancelledAt: null,
      failedAt: null,
      completedAt: null,
      model: 'auto',
      instructions: null,
      tools: [],
      fileIds: [],
      metadata: {},
      temperature: null,
      topP: null,
      maxPromptTokens: null,
      maxCompletionTokens: null,
      requiredAction: null,
      lastError: null,
      usage: null,
    });

    const service = new ThreadsService();
    const run = await service.createRun({
      threadId: 'thread_x',
      assistant_id: 'asst_mine',
      userContext,
      requestId: 'req_2',
    } as never);

    expect(run.id).toBe('run_1');
    expect(threadRunCreate).toHaveBeenCalledTimes(1);
  });
});

describe('listRunSteps cursor scoping', () => {
  it('resolves after/before cursors only within the requested run', async () => {
    threadFindFirst.mockResolvedValue({
      id: 'thread_x',
      organizationId: 'org_mine',
      runs: [{ id: 'run_mine' }],
    });
    // A step id from another tenant's run does not resolve inside this run.
    stepFindFirst.mockResolvedValue(null);
    stepFindMany.mockResolvedValue([]);

    const service = new ThreadsService();
    await service.listRunSteps({
      threadId: 'thread_x',
      runId: 'run_mine',
      after: 'step_other_tenant',
      before: 'step_other_tenant_2',
      userContext,
      requestId: 'req_3',
    } as never);

    expect(stepFindFirst).toHaveBeenCalledWith({
      where: { id: 'step_other_tenant', runId: 'run_mine' },
    });
    expect(stepFindFirst).toHaveBeenCalledWith({
      where: { id: 'step_other_tenant_2', runId: 'run_mine' },
    });
    // No timestamp from a foreign step leaks into the page filter.
    expect(stepFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: 'run_mine' } })
    );
  });
});
