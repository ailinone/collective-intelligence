// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * ErrorLearningSystem unit tests
 * 
 * These tests validate the health score computation logic using vi.mock
 * to intercept database calls at the module level, avoiding issues with
 * Prisma's proxy-based export.
 * 
 * IMPORTANT: vi.mock is hoisted to the top of the file, so we must use
 * vi.hoisted() to create mock functions that are accessible in the mock factory.
 */

// Create mock functions using vi.hoisted() to ensure they are available when vi.mock runs
const { mockQueryRaw, mockConnect, mockDisconnect } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockDisconnect: vi.fn().mockResolvedValue(undefined),
}));

// Mock the database client module to avoid proxy issues
vi.mock('@/database/client', () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
    $connect: mockConnect,
    $disconnect: mockDisconnect,
  },
}));

// Import after mocking
import { errorLearningSystem } from '@/core/learning/error-learning-system';

describe.sequential('ErrorLearningSystem.getProviderHealthScores', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('computes reliability and rate-limit frequency from aggregated data', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        provider: 'openai',
        total_requests: BigInt(1200),
        success_count: BigInt(1150),
        error_count: BigInt(50),
        rate_limit_count: BigInt(12),
        avg_latency: 842.6,
        last_error_epoch: 1_700_000_000,
        recommended_tasks: ['code_generation', 'chat_assistance'],
      },
    ]);

    const scores = await errorLearningSystem.getProviderHealthScores();

    expect(scores).toHaveLength(1);
    const score = scores[0];
    expect(score.provider).toBe('openai');
    expect(score.reliability).toBeCloseTo(1150 / 1200, 4);
    expect(score.rateLimitFrequency).toBeCloseTo((12 / 1200) * 1000, 2);
    expect(score.avgLatency).toBe(Math.round(842.6));
    expect(score.lastError).toBe(1_700_000_000_000);
    expect(score.recommendedForTasks).toEqual(['code_generation', 'chat_assistance']);
  });

  it('returns empty array when query fails', async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error('database unavailable'));

    const scores = await errorLearningSystem.getProviderHealthScores();

    expect(scores).toEqual([]);
  });
});
