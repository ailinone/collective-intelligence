// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Rollback Service — Unit Tests
 *
 * Tests the drift→rollback pipeline: severity filtering, cooldown,
 * daily limits, weight reduction, and audit trail persistence.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DriftEventInput } from '../drift-detection';

const mockExecuteRaw = vi.fn().mockResolvedValue(0);
const mockQueryRaw = vi.fn().mockResolvedValue([]);

beforeEach(() => {
  vi.resetModules();
  mockExecuteRaw.mockReset().mockResolvedValue(0);
  mockQueryRaw.mockReset().mockResolvedValue([]);

  vi.doMock('@/database/client', () => ({
    prisma: { $executeRaw: mockExecuteRaw, $queryRaw: mockQueryRaw },
  }));
  vi.doMock('@/utils/logger', () => ({
    logger: { child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  }));
});

function makeDriftEvent(overrides: Partial<DriftEventInput> = {}): DriftEventInput {
  return {
    driftType: 'performance',
    scopeType: 'niche',
    scopeKey: 'debate|code-generation',
    severity: 'high',
    baselineValue: 0.85,
    currentValue: 0.60,
    deltaPercent: -29.4,
    evidence: { metric: 'quality', baselineSamples: 50, currentSamples: 20 },
    ...overrides,
  };
}

describe('Rollback Service', () => {
  describe('processRollbacks', () => {
    it('executes rollback for high severity drift events', async () => {
      // Order: (1) getDailyRollbackCount, (2) current weights in executeRollback
      mockQueryRaw
        .mockResolvedValueOnce([{ count: BigInt(0) }]) // daily count = 0
        .mockResolvedValueOnce([
          { task_type: 'code-generation', complexity: 'medium', weight: 1.2, avg_quality: 0.85 },
        ]); // current weights

      const { processRollbacks } = await import('../rollback-service');
      const result = await processRollbacks([makeDriftEvent({ severity: 'high' })]);

      expect(result.rollbacksExecuted).toBe(1);
      expect(result.skipped).toBe(0);
      // Should have called executeRaw twice: UPDATE weights + INSERT rollback_event
      expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
    });

    it('executes rollback for critical severity', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{ count: BigInt(0) }]) // daily count
        .mockResolvedValueOnce([{ task_type: 'code-generation', complexity: 'medium', weight: 1.0, avg_quality: 0.80 }]);

      const { processRollbacks } = await import('../rollback-service');
      const result = await processRollbacks([makeDriftEvent({ severity: 'critical' })]);

      expect(result.rollbacksExecuted).toBe(1);
    });

    it('skips low and medium severity events', async () => {
      const { processRollbacks } = await import('../rollback-service');

      const result = await processRollbacks([
        makeDriftEvent({ severity: 'low' }),
        makeDriftEvent({ severity: 'medium' }),
      ]);

      expect(result.rollbacksExecuted).toBe(0);
      // No DB calls should have been made
      expect(mockExecuteRaw).not.toHaveBeenCalled();
    });

    it('respects daily rollback limit', async () => {
      // First drift event: daily count = 0 → executes
      mockQueryRaw
        .mockResolvedValueOnce([{ task_type: 'code-generation', complexity: 'medium', weight: 1.0, avg_quality: 0.8 }])
        .mockResolvedValueOnce([{ count: BigInt(0) }]);

      const { processRollbacks } = await import('../rollback-service');

      // First rollback succeeds
      await processRollbacks([makeDriftEvent({ severity: 'high', scopeKey: 'test|scope1' })]);

      // Second call: daily count = 3 (at limit) → skipped
      mockQueryRaw.mockReset();
      mockQueryRaw.mockResolvedValueOnce([{ count: BigInt(3) }]);
      mockExecuteRaw.mockReset();

      const result2 = await processRollbacks([makeDriftEvent({ severity: 'high', scopeKey: 'test|scope1' })]);
      expect(result2.skipped).toBe(1);
      expect(result2.rollbacksExecuted).toBe(0);
    });

    it('handles DB errors gracefully during rollback', async () => {
      mockQueryRaw.mockRejectedValue(new Error('DB connection lost'));

      const { processRollbacks } = await import('../rollback-service');
      const result = await processRollbacks([makeDriftEvent({ severity: 'critical' })]);

      // Should not throw, just log and skip
      expect(result.rollbacksExecuted).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  describe('getRecentRollbacks', () => {
    it('returns mapped rollback events', async () => {
      mockQueryRaw.mockResolvedValue([{
        id: 'rb-1',
        scope_key: 'debate|code-generation',
        reason: 'Drift detected: quality degraded by -29.4%',
        executed_at: new Date(),
        validated_at: null,
      }]);

      const { getRecentRollbacks } = await import('../rollback-service');
      const rollbacks = await getRecentRollbacks();

      expect(rollbacks).toHaveLength(1);
      expect(rollbacks[0].scopeKey).toBe('debate|code-generation');
      expect(rollbacks[0].reason).toContain('quality');
    });
  });
});
