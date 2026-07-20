// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_TENANT_ORGANIZATION_ID, TEST_TENANT_USER_ID } from '../../utils/test-tenant';

const enqueueMock = vi.hoisted(() => vi.fn());
const shouldQueueMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/request-queue-service', () => ({
  requestQueueService: {
    enqueue: enqueueMock,
    shouldQueue: shouldQueueMock,
  },
}));

import { enqueueIfNeeded } from '@/api/middleware/queue-manager';

describe('queue-manager enqueueIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueMock.mockReset();
    shouldQueueMock.mockReset();
    enqueueMock.mockResolvedValue({
      queueId: 'job-1',
      position: 1,
      estimatedWaitTimeMs: 0,
      priority: 0,
    });
  });

  it('throws descriptive error when tenant context is missing', async () => {
    const request: any = {
      queueContext: {
        shouldQueue: true,
        load: 0.9,
        tier: 'free',
      },
      headers: {},
    };

    await expect(
      enqueueIfNeeded(request, 'req-1', { messages: [] }),
    ).rejects.toMatchObject({
      code: 'TENANT_CONTEXT_REQUIRED',
      message: 'Tenant context required for queueing',
    });

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('enqueues when tenant context present', async () => {
    const request: any = {
      tenantContext: {
        organizationId: TEST_TENANT_ORGANIZATION_ID,
        userId: TEST_TENANT_USER_ID,
        tier: 'enterprise',
      },
      queueContext: {
        shouldQueue: true,
        load: 0.7,
        tier: 'enterprise',
      },
      headers: {},
    };

    const response = await enqueueIfNeeded(
      request,
      'req-2',
      { messages: [] },
    );

    expect(response.queued).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith(
      'req-2',
      TEST_TENANT_ORGANIZATION_ID,
      TEST_TENANT_USER_ID,
      { messages: [] },
      undefined,
      'enterprise',
    );
  });
});


