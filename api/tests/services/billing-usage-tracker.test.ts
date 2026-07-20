// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Billing Usage Tracker Tests
 * Uses REAL models from dynamic discovery - NO hardcoded models
 * Note: Some mocks are still needed for usage-analytics-service and quota-service
 * but models must come from dynamic discovery
 */

import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest';

vi.mock('@/services/usage-analytics-service', () => ({
  recordUsageEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/quota-service', () => ({
  recordQuotaUsage: vi.fn().mockResolvedValue(undefined),
}));

import type { OrchestrationResult, ChatRequest } from '@/types';
import { trackChatUsage } from '@/services/billing-usage-tracker';
import { recordUsageEvents } from '@/services/usage-analytics-service';
import { recordQuotaUsage } from '@/services/quota-service';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { getTestModel, ensureModelsDiscovered } from '../utils/dynamic-model-discovery';

type MockFunction = vi.Mock<unknown[], Promise<unknown>>;
const usageEventsMock = recordUsageEvents as MockFunction;
const quotaUsageMock = recordQuotaUsage as MockFunction;

describe('trackChatUsage - Real Tests (NO Hardcoded Models)', () => {
  beforeAll(async () => {
    await startTestEnvironment();
    await ensureModelsDiscovered();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  beforeEach(() => {
    usageEventsMock.mockClear();
    quotaUsageMock.mockClear();
  });

  it('records usage and quota data using orchestration result details with real models', async () => {
    // Get a real model from dynamic discovery - NO hardcoded models
    const realModel = await getTestModel();
    if (!realModel) {
      return; // Skip if no models available
    }

    const orchestrationResult: OrchestrationResult = {
      strategyUsed: 'auto',
      totalCost: 0.123456,
      totalDuration: 1200,
      modelsUsed: [
        {
          modelId: realModel.id,
          modelName: realModel.name,
          provider: realModel.provider,
          role: 'primary',
          request: { model: realModel.id, messages: [] } as ChatRequest,
          response: {
            id: 'resp-1',
            object: 'chat.completion',
            created: Date.now(),
            model: realModel.id, // Use real model ID
            choices: [],
            usage: {
              prompt_tokens: 30,
              completion_tokens: 70,
              total_tokens: 100,
            },
          },
          cost: 0.123456,
          durationMs: 800,
          success: true,
        },
      ],
      finalResponse: {
        id: 'resp-1',
        object: 'chat.completion',
        created: Date.now(),
        model: realModel.id, // Use real model ID
        choices: [],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 70,
          total_tokens: 100,
        },
      },
      metadata: {},
    };

    await trackChatUsage({
      organizationId: 'org-1',
      userId: 'user-1',
      requestId: 'req-1',
      request: { model: realModel.id, messages: [] } as ChatRequest, // Use real model ID
      result: orchestrationResult,
      cacheHit: false,
    });

    expect(usageEventsMock).toHaveBeenCalledTimes(1);
    const eventsPayload = usageEventsMock.mock.calls[0][0];
    expect(eventsPayload.organizationId).toBe('org-1');
    expect(eventsPayload.events[0].metadata.total_tokens).toBe(100);
    expect(eventsPayload.events[0].metadata.total_cost_usd).toBeCloseTo(0.123456, 6);

    expect(quotaUsageMock).toHaveBeenCalledTimes(1);
    expect(quotaUsageMock).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        operation: expect.objectContaining({
          requests: 1,
          tokens: 100,
          cost: 0.123456,
        }),
      })
    );
  }, 60000);

  it('handles cache hits without throwing', async () => {
    // Get a real model from dynamic discovery - NO hardcoded models
    const realModel = await getTestModel();
    if (!realModel) {
      return; // Skip if no models available
    }

    await trackChatUsage({
      organizationId: 'org-cache',
      requestId: 'req-cache',
      request: { model: realModel.id, messages: [] } as ChatRequest, // Use real model ID
      cacheHit: true,
    });

    expect(usageEventsMock).toHaveBeenCalledTimes(1);
    expect(quotaUsageMock).toHaveBeenCalledTimes(1);
    expect(usageEventsMock.mock.calls[0][0].events[0].metadata.cache_hit).toBe(true);
    expect(quotaUsageMock.mock.calls[0][1].operation?.tokens).toBe(0);
  }, 60000);
});
