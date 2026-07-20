// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queueManagerMiddleware } from '@/api/middleware/queue-manager';
import { requestQueueService } from '@/services/request-queue-service';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

// Types for testing
interface MockRequest extends Partial<FastifyRequest> {
  url: string;
  method?: string;
  tenantContext?: ExtendedFastifyRequest['tenantContext'];
  queueContext?: {
    shouldQueue: boolean;
    load: number;
    tier: string;
    reason: string;
  };
}

interface MockReply extends Partial<FastifyReply> {
  status: vi.Mock;
  send: vi.Mock;
}

const recordSecurityEventMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/services/request-queue-service', () => ({
  requestQueueService: {
    shouldQueue: vi.fn().mockResolvedValue({ queue: false, load: 0 }),
    enqueue: vi.fn(),
  },
}));

vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: recordSecurityEventMock,
}));

const createReply = (): MockReply => {
  const reply: MockReply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
};

describe('queueManagerMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when tenant context is missing', async () => {
    const request: MockRequest = { url: '/v1/chat/completions' };
    const reply = createReply();

    await queueManagerMiddleware(request, reply);

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'tenant_context_required' }),
      }),
    );
  });

  it('attaches queue context when tenant context is present', async () => {
    const shouldQueueMock = vi.mocked(requestQueueService).shouldQueue;
    shouldQueueMock.mockResolvedValueOnce({
      queue: true,
      load: 0.75,
      reason: 'load_high',
    });

    const request: MockRequest = {
      url: '/v1/chat/completions',
      tenantContext: {
        organizationId: 'org-123',
        tier: 'enterprise',
        userId: 'user-tenant',
        roles: ['owner'],
      },
    };
    const reply = createReply();

    await queueManagerMiddleware(request, reply);

    expect(reply.status).not.toHaveBeenCalled();
    expect(request.queueContext).toEqual({
      shouldQueue: true,
      load: 0.75,
      tier: 'enterprise',
      reason: 'load_high',
    });
  });

  it('records security event when tenant context is missing', async () => {
    const request: MockRequest = { url: '/v1/chat/completions', method: 'POST' };
    const reply = createReply();

    await queueManagerMiddleware(request, reply);

    expect(recordSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'tenant_context_missing',
        metadata: expect.objectContaining({
          path: '/v1/chat/completions',
          method: 'POST',
        }),
      })
    );

    await queueManagerMiddleware(
      {
        url: '/v1/chat/completions',
        method: 'POST',
        tenantContext: {
          organizationId: 'org-123',
          tier: 'enterprise',
          userId: 'user-tenant',
          roles: ['owner'],
        },
      } as MockRequest,
      createReply()
    );

    expect(recordSecurityEventMock).toHaveBeenCalled();
  });
});


