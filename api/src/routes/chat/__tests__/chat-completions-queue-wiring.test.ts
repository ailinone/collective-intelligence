// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression guard for the dead-queue-manager bug found while auditing
 * whether ci's API can absorb bursty tool-calling traffic from agentic
 * coding IDEs (Cursor, Cline, Zed, Claude Code, Goose, Opencode).
 *
 * The bug
 * ────────
 * `POST /v1/chat/completions` (chat-routes.ts) imported the queue-manager
 * preHandler as `queueManagerMiddleware as _queueManagerMiddleware` and never
 * registered it on the route — the underscore-prefixed alias only silences
 * `@typescript-eslint/no-unused-vars` (see `.eslintrc.cjs`'s
 * `varsIgnorePattern: '^_'`), it is not a marker of a deliberate design
 * decision (compare `_authenticate`, imported the same way but genuinely
 * wired into this exact route's `preHandler` array a few lines below).
 *
 * Because `queueManagerMiddleware` never ran, `request.queueContext` was
 * always `undefined`. `enqueueIfNeeded` (called on the non-streaming branch)
 * reads exactly that field and takes the `{ queued: false }` branch whenever
 * it is unset — so the load-shed protection this route's OpenAPI schema
 * already documents (see the 202 "Request queued for asynchronous
 * processing" response) never activated, no matter how overloaded the system
 * really was (`request-queue-service.ts`'s `shouldQueue()`, >80% capacity or
 * an existing waiting job).
 *
 * The fix registers `queueManagerMiddleware` as a real preHandler on
 * `POST /v1/chat/completions` (after `_authenticate`, since it requires
 * `tenantContext` to already be populated) and drops the misleading
 * underscore from the import.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ChatRequest } from '@/types';

const mocks = vi.hoisted(() => ({
  shouldQueueMock: vi.fn(),
  enqueueMock: vi.fn(),
  recordSecurityEventMock: vi.fn(),
}));

vi.mock('@/services/request-queue-service', () => ({
  requestQueueService: {
    shouldQueue: mocks.shouldQueueMock,
    enqueue: mocks.enqueueMock,
  },
}));

vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: mocks.recordSecurityEventMock,
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

const { enqueueIfNeeded, queueManagerMiddleware } = await import(
  '@/api/middleware/queue-manager'
);

function makeRequest(): FastifyRequest {
  return {
    url: '/v1/chat/completions',
    method: 'POST',
    headers: {},
    tenantContext: {
      organizationId: 'org-queue-wiring',
      userId: 'user-queue-wiring',
      tier: 'free',
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

describe('Chat-completions queue wiring (Issue 2) — functional', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shouldQueueMock.mockResolvedValue({
      queue: true,
      load: 95,
      reason: 'system_overloaded_test',
    });
    mocks.enqueueMock.mockResolvedValue({
      queueId: 'q-test-123',
      position: 2,
      estimatedWaitTimeMs: 4000,
      priority: 5,
    });
  });

  it(
    'FIXED behavior: with queueManagerMiddleware run first, a high-load decision ' +
      'actually reaches enqueueIfNeeded and returns queued:true',
    async () => {
      const request = makeRequest();
      const reply = makeReply();

      // This is exactly what the new preHandler array does: run
      // queueManagerMiddleware before the route handler calls enqueueIfNeeded.
      await queueManagerMiddleware(request, reply);
      expect((request as unknown as { queueContext?: unknown }).queueContext).toBeDefined();

      const decision = await enqueueIfNeeded(request, 'req-1', fakeChatRequest);

      expect(decision.queued).toBe(true);
      expect(decision.response?.queueId).toBe('q-test-123');
      expect(mocks.enqueueMock).toHaveBeenCalledTimes(1);
    }
  );

  it(
    'REGRESSION (the bug): without queueManagerMiddleware ever running (the old, ' +
      'dead-wiring state), enqueueIfNeeded ALWAYS reports queued:false — even ' +
      'though the system is reporting 95% load and shouldQueue() says to queue',
    async () => {
      const request = makeRequest();

      // Deliberately do NOT call queueManagerMiddleware — this reproduces the
      // production bug where the hook was imported but never registered.
      const decision = await enqueueIfNeeded(request, 'req-2', fakeChatRequest);

      expect(decision.queued).toBe(false);
      expect(mocks.enqueueMock).not.toHaveBeenCalled();
      // shouldQueue() was never even consulted — queueContext was never
      // populated because queueManagerMiddleware never ran.
      expect(mocks.shouldQueueMock).not.toHaveBeenCalled();
    }
  );
});

describe('Chat-completions queue wiring (Issue 2) — source contract', () => {
  const ROUTES_PATH = join(__dirname, '..', 'chat-routes.ts');
  const routesSource = readFileSync(ROUTES_PATH, 'utf8');

  it('imports queueManagerMiddleware WITHOUT the misleading unused-var underscore alias', () => {
    expect(routesSource).not.toMatch(/queueManagerMiddleware\s+as\s+_queueManagerMiddleware/);
    expect(routesSource).toMatch(
      /import\s*\{\s*enqueueIfNeeded\s*,\s*queueManagerMiddleware\s*\}\s*from\s*['"]@\/api\/middleware\/queue-manager['"]/
    );
  });

  it('registers queueManagerMiddleware as a real preHandler on POST /v1/chat/completions', () => {
    // Anchors on the same preHandler array _authenticate already lives in —
    // proves it is wired to the ACTUAL route that calls enqueueIfNeeded, not
    // just imported and left dangling somewhere else.
    expect(routesSource).toMatch(/preHandler:\s*\[\s*_authenticate\s*,\s*queueManagerMiddleware\s*\]/);
  });
});
