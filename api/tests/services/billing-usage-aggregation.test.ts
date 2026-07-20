// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Billing Usage Aggregation Tests
 * Uses REAL models from dynamic discovery - NO hardcoded models
 */

import { beforeEach, describe, expect, it, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/database/client';
import { aggregateUsageCosts } from '@/services/billing-usage-aggregation';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { getTestModels, ensureModelsDiscovered } from '../utils/test-model-helper';
import { connectDatabase, disconnectDatabase } from '@/database/client';
import { initializeDIContainer, resetDIContainer } from '@/di/container';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

// NO MOCKS - Uses real database

describe('aggregateUsageCosts - Real Tests (NO Hardcoded Models, NO Mocks)', () => {
  let testOrgId: string;

  beforeAll(async () => {
    await startTestEnvironment();
    initializeDIContainer();
    await connectDatabase();
    await syncDefaultRoles();
    await ensureModelsDiscovered();

    // Create test organization
    const org = await prisma.organization.create({
      data: {
        name: `Test Org ${Date.now()}`,
        slug: `test-org-${Date.now()}`,
        tier: 'enterprise',
        status: 'active',
      },
    });
    testOrgId = org.id;
  }, 60_000);

  afterAll(async () => {
    // Cleanup
    if (testOrgId) {
      await prisma.organization.delete({ where: { id: testOrgId } }).catch(() => {
        // Ignore cleanup errors
      });
    }
    await disconnectDatabase();
    resetDIContainer();
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(async () => {
    // Clean up usage events before each test
    await prisma.usageEvent.deleteMany({
      where: {
        organizationId: testOrgId,
      },
    }).catch(() => {
      // Ignore cleanup errors
    });
  });

  it('aggregates usage events by model and provider with real models', async () => {
    // Get real models from dynamic discovery - NO hardcoded models
    const realModels = await getTestModels(2);
    if (realModels.length < 2) {
      return; // Skip if not enough models
    }

    const model1 = realModels[0];
    const model2 = realModels[1];

    // Create test users
    const user1 = await prisma.user.create({
      data: {
        email: `user1-${Date.now()}@test.com`,
        name: 'User 1',
        passwordHash: '$2b$12$dummyhash',
        organizationId: testOrgId,
        role: 'developer',
        status: 'active',
      },
    });

    const user2 = await prisma.user.create({
      data: {
        email: `user2-${Date.now()}@test.com`,
        name: 'User 2',
        passwordHash: '$2b$12$dummyhash',
        organizationId: testOrgId,
        role: 'developer',
        status: 'active',
      },
    });

    // Create real usage events in database
    await prisma.usageEvent.createMany({
      data: [
        {
          organizationId: testOrgId,
          userId: user1.id,
          eventType: 'chat.completion',
          metadata: {
            total_cost_usd: 0.45,
            total_tokens: 120,
            models: [
              {
                modelId: `${model1.provider}:${model1.id}`,
                modelName: model1.name,
                costUsd: 0.45,
                tokens: 120,
              },
            ],
          },
        },
        {
          organizationId: testOrgId,
          userId: user2.id,
          eventType: 'chat.completion',
          metadata: {
            total_cost_usd: 0.2,
            total_tokens: 80,
            models: [
              {
                modelId: `${model2.provider}:${model2.id}`,
                modelName: model2.name,
                costUsd: 0.2,
                tokens: 80,
              },
            ],
          },
        },
      ],
    });

    const now = new Date();
    const result = await aggregateUsageCosts({
      organizationId: testOrgId,
      periodStart: new Date(now.getTime() - 86_400_000),
      periodEnd: now,
    });

    expect(result.metrics.totalCost).toBeCloseTo(0.65, 6);
    expect(result.metrics.tokenUsage).toBe(200);
    expect(result.metrics.costByModel?.[model1.name]).toBeCloseTo(0.45, 6);
    expect(result.metrics.costByModel?.[model2.name]).toBeCloseTo(0.2, 6);

    const expectedByProvider: Record<string, number> = {};
    expectedByProvider[model1.provider] = (expectedByProvider[model1.provider] ?? 0) + 0.45;
    expectedByProvider[model2.provider] = (expectedByProvider[model2.provider] ?? 0) + 0.2;
    Object.entries(expectedByProvider).forEach(([provider, cost]) => {
      expect(result.metrics.costByProvider?.[provider]).toBeCloseTo(cost, 6);
    });

    expect(result.metrics.costByUser?.[user1.id]).toBeCloseTo(0.45, 6);

    expect(result.events.length).toBeGreaterThanOrEqual(2);
    const firstEvent = result.events.find(e => e.model === model1.name);
    expect(firstEvent).toMatchObject({
      model: model1.name, // Use real model name
      cost: 0.45,
      tokensUsed: 120,
      category: model1.provider, // Use real provider
    });

    // Cleanup
    await prisma.user.deleteMany({ where: { id: { in: [user1.id, user2.id] } } }).catch(() => {});
  }, 60000);

  it('handles events without model breakdown gracefully', async () => {
    // Get a real model from dynamic discovery - NO hardcoded models
    const realModels = await getTestModels(1);
    if (realModels.length === 0) {
      return; // Skip if no models available
    }
    const model = realModels[0];

    // Create real usage event in database
    await prisma.usageEvent.create({
      data: {
        organizationId: testOrgId,
        eventType: 'chat.completion',
        metadata: {
          total_cost_usd: 0.1,
          total_tokens: 50,
          model_requested: model.id, // Use dynamically discovered model
        },
      },
    });

    const now = new Date();
    const result = await aggregateUsageCosts({
      organizationId: testOrgId,
      periodStart: new Date(now.getTime() - 86_400_000),
      periodEnd: now,
    });

    expect(result.metrics.totalCost).toBeCloseTo(0.1, 6);
    expect(result.metrics.tokenUsage).toBe(50);
    expect(result.events.length).toBeGreaterThanOrEqual(1);
    const event = result.events.find(e => e.model === model.id);
    expect(event?.model).toBe(model.id); // Use real model ID
  }, 60000);
});
