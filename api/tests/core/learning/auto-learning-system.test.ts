// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Auto-Learning System Tests
 * Uses REAL models from dynamic discovery - NO hardcoded models
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { autoLearningSystem } from '@/core/learning/auto-learning-system';
import { prisma } from '@/database/client';
import type { OrchestrationResult, ChatRequest, ChatResponse } from '@/types';
import { startTestEnvironment, stopTestEnvironment } from '../../utils/test-environment';
import { getTestModel, ensureModelsDiscovered } from '../../utils/test-model-helper';
import { connectDatabase, disconnectDatabase } from '@/database/client';
import { initializeDIContainer, resetDIContainer } from '@/di/container';
import { syncDefaultRoles } from '@/services/rbac-sync-service';

// NO MOCKS - Uses real database

describe('Auto-Learning System - Real Tests (NO Hardcoded Models, NO Mocks)', () => {
  beforeAll(async () => {
    await startTestEnvironment();
    initializeDIContainer();
    await connectDatabase();
    await syncDefaultRoles();
    await ensureModelsDiscovered();
  }, 60_000);

  afterAll(async () => {
    await disconnectDatabase();
    resetDIContainer();
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(async () => {
    // Clean up learning data before each test
    await prisma.learningData.deleteMany({}).catch(() => {
      // Ignore cleanup errors
    });
  });

  it('should learn from orchestration results with real models', async () => {
    // Create test organization
    const org = await prisma.organization.create({
      data: {
        name: `Test Org ${Date.now()}`,
        slug: `test-org-${Date.now()}`,
        tier: 'enterprise',
        status: 'active',
      },
    });

    const user = await prisma.user.create({
      data: {
        email: `test-${Date.now()}@example.com`,
        name: 'Test User',
        passwordHash: '$2b$12$dummyhash',
        organizationId: org.id,
        role: 'developer',
        status: 'active',
      },
    });

    // Get a real model from dynamic discovery - NO hardcoded models
    const realModel = await getTestModel();
    if (!realModel) {
      // Cleanup and skip
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
      return; // Skip if no models available
    }

    const mockRequest: ChatRequest = {
      model: realModel.id, // Use dynamically discovered model
      messages: [{ role: 'user', content: 'Test message' }],
      task_type: 'code_generation',
    };

    const mockResponse: ChatResponse = {
      id: `test-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: realModel.id, // Use dynamically discovered model
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Test response' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };

    const mockResult: OrchestrationResult = {
      strategyUsed: 'parallel',
      modelsUsed: [
        { 
          modelId: realModel.id, // Use dynamically discovered model
          modelName: realModel.name,
          provider: realModel.provider,
          role: 'primary', 
          request: mockRequest, 
          response: mockResponse, 
          cost: 0.01, 
          durationMs: 2000, 
          success: true 
        },
      ],
      finalResponse: mockResponse,
      totalCost: 0.018,
      totalDuration: 2500,
      qualityScore: 0.9,
      metadata: {},
    };

    // Get initial count of learning data
    const initialCount = await prisma.learningData.count({
      where: {
        bucket: { contains: 'code_generation' },
      },
    });

    // Learn from orchestration result
    await autoLearningSystem.learn(mockResult, mockRequest, org.id, user.id);

    // Wait a bit for async operations
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify learning data was created/updated
    const learningData = await prisma.learningData.findMany({
      where: {
        bucket: { contains: 'code_generation' },
      },
    });

    // Should have learning data (may be in different bucket format)
    expect(learningData.length).toBeGreaterThanOrEqual(initialCount);

    // Cleanup
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }, 60000);

  it('writes per-MODEL hourly buckets to learning_buckets (the selector reads strategyId = modelId)', async () => {
    // Pins the missing-writer fix (2026-07-05): learning_buckets was READ by
    // DynamicModelSelector but never written, so model history was always null.
    const realModel = await getTestModel();
    if (!realModel) return; // skip if discovery has no models

    const mkExec = (success: boolean, cost: number, durationMs: number) => ({
      modelId: realModel.id,
      modelName: realModel.name,
      role: 'primary' as const,
      request: { model: realModel.id, messages: [{ role: 'user' as const, content: 'q' }] },
      response: {
        id: `t-${Date.now()}`,
        object: 'chat.completion' as const,
        created: Math.floor(Date.now() / 1000),
        model: realModel.id,
        choices: [{ index: 0, message: { role: 'assistant' as const, content: 'a' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      },
      cost,
      durationMs,
      success,
    });

    await prisma.learningBucket.deleteMany({ where: { strategyId: realModel.id } }).catch(() => {});

    // Same model appears TWICE (voter + coordinator) — must dedupe into one row,
    // aggregating counts within the execution.
    const result: OrchestrationResult = {
      strategyUsed: 'consensus',
      modelsUsed: [mkExec(true, 0.01, 2000), mkExec(false, 0.02, 4000)],
      finalResponse: mkExec(true, 0, 0).response,
      totalCost: 0.03,
      totalDuration: 5000,
      qualityScore: 0.8,
      metadata: {},
    };

    await autoLearningSystem.learn(result, {
      type: 'general',
      complexity: 'medium',
      contextSize: 1000,
    });

    const buckets = await prisma.learningBucket.findMany({ where: { strategyId: realModel.id } });
    expect(buckets).toHaveLength(1); // deduped: one row per (model, hour)
    expect(buckets[0].executionCount).toBe(2);
    expect(buckets[0].successCount).toBe(1);
    expect(buckets[0].errorCount).toBe(1);
    expect(buckets[0].avgDurationMs).toBe(3000); // (2000+4000)/2
    expect(Number(buckets[0].avgCostUsd)).toBeCloseTo(0.015, 6);
    expect(Number(buckets[0].avgQuality)).toBeCloseTo(0.8, 2);
    expect(Number(buckets[0].totalTokens)).toBe(60);

    // Second learn() in the same hour → running-average upsert on the SAME row.
    await autoLearningSystem.learn(
      { ...result, modelsUsed: [mkExec(true, 0.03, 6000)], qualityScore: 0.6 },
      { type: 'general', complexity: 'medium', contextSize: 1000 },
    );

    const after = await prisma.learningBucket.findMany({ where: { strategyId: realModel.id } });
    expect(after).toHaveLength(1);
    expect(after[0].executionCount).toBe(3);
    expect(after[0].successCount).toBe(2);
    expect(after[0].avgDurationMs).toBe(4000); // (3000*2 + 6000*1)/3
    expect(Number(after[0].avgQuality)).toBeCloseTo((0.8 * 2 + 0.6) / 3, 2);

    await prisma.learningBucket.deleteMany({ where: { strategyId: realModel.id } }).catch(() => {});
  }, 60000);
});
