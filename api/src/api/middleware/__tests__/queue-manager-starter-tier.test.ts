// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test (cross-repo quota/tier hardening, P0 finding #1):
 * `queueManagerMiddleware` used to resolve `tenantContext.tier` via
 * `tenantContext.tier as 'enterprise' | 'pro' | 'free'` — a cast that did
 * not include the real `'starter'` TierLevel. That untyped, unvalidated
 * value fed straight into `RequestQueueService.calculatePriority`'s
 * `basePriorities[tier] + jitter`, where `basePriorities` (until this fix)
 * had no `starter` key — so `undefined + jitter` produced `NaN`, corrupting
 * the BullMQ job priority for every starter-tier organization queued while
 * the system was under load (exactly the scenario in which this middleware
 * actually queues anything).
 *
 * This test exercises the real `resolveQueueTier` logic through the public
 * `queueManagerMiddleware` + `enqueueIfNeeded` surface (mocking only
 * `@/services/request-queue-service`, which owns real Redis/BullMQ side
 * effects and is unmockable-free to import directly — see
 * `chat-completions-queue-wiring.test.ts` for the same pattern).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ChatRequest } from '@/types';
import { TierLevel } from '@/domain/value-objects/organization-tier';

const mocks = vi.hoisted(() => ({
  shouldQueueMock: vi.fn(),
  enqueueMock: vi.fn(),
}));

vi.mock('@/services/request-queue-service', () => ({
  requestQueueService: {
    shouldQueue: mocks.shouldQueueMock,
    enqueue: mocks.enqueueMock,
  },
}));

vi.mock('@/utils/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child } };
});

const { queueManagerMiddleware, enqueueIfNeeded } = await import('@/api/middleware/queue-manager');

function makeRequest(tier: string): FastifyRequest {
  return {
    url: '/v1/chat/completions',
    method: 'POST',
    headers: {},
    tenantContext: {
      organizationId: 'org-starter-tier',
      userId: 'user-starter-tier',
      tier,
      roles: [],
    },
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply & { statusCode?: number; body?: unknown } {
  const reply = {
    status: vi.fn(function (this: typeof reply, code: number) {
      this.statusCode = code;
      return this;
    }),
    send: vi.fn(function (this: typeof reply, body: unknown) {
      this.body = body;
      return this;
    }),
  } as unknown as FastifyReply & { statusCode?: number; body?: unknown };
  return reply;
}

const fakeChatRequest = { model: 'auto', messages: [] } as unknown as ChatRequest;

describe('queueManagerMiddleware — starter tier priority (P0 NaN regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shouldQueueMock.mockResolvedValue({
      queue: true,
      load: 95,
      reason: 'system_overloaded_test',
    });
    mocks.enqueueMock.mockResolvedValue({
      queueId: 'q-starter-1',
      position: 3,
      estimatedWaitTimeMs: 6000,
      priority: 5000,
    });
  });

  it('resolves a starter-tier tenant to TierLevel.STARTER (not undefined/NaN) in queueContext', async () => {
    const request = makeRequest('starter');
    const reply = makeReply();

    await queueManagerMiddleware(request, reply);

    const queueContext = (request as unknown as { queueContext?: { tier: string } }).queueContext;
    expect(queueContext).toBeDefined();
    expect(queueContext?.tier).toBe(TierLevel.STARTER);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('propagates the starter tier all the way into requestQueueService.enqueue (no NaN, no silent drop)', async () => {
    const request = makeRequest('starter');
    const reply = makeReply();

    await queueManagerMiddleware(request, reply);
    const decision = await enqueueIfNeeded(request, 'req-starter-1', fakeChatRequest);

    expect(decision.queued).toBe(true);
    expect(mocks.enqueueMock).toHaveBeenCalledTimes(1);
    // 6th positional arg to requestQueueService.enqueue(requestId, orgId, userId, request, context, tier)
    expect(mocks.enqueueMock.mock.calls[0]?.[5]).toBe(TierLevel.STARTER);
  });

  it('falls back to TierLevel.FREE (fail-closed) for an unrecognized tier value instead of propagating garbage', async () => {
    const request = makeRequest('some-unknown-future-tier');
    const reply = makeReply();

    await queueManagerMiddleware(request, reply);

    const queueContext = (request as unknown as { queueContext?: { tier: string } }).queueContext;
    expect(queueContext?.tier).toBe(TierLevel.FREE);

    await enqueueIfNeeded(request, 'req-unknown-tier', fakeChatRequest);
    expect(mocks.enqueueMock.mock.calls[0]?.[5]).toBe(TierLevel.FREE);
  });

  it.each([TierLevel.ENTERPRISE, TierLevel.PRO, TierLevel.STARTER, TierLevel.FREE])(
    'resolves every real TierLevel member (%s) to itself, unchanged',
    async (tier) => {
      const request = makeRequest(tier);
      const reply = makeReply();

      await queueManagerMiddleware(request, reply);

      const queueContext = (request as unknown as { queueContext?: { tier: string } }).queueContext;
      expect(queueContext?.tier).toBe(tier);
    }
  );
});
