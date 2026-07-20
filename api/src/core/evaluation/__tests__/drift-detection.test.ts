// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Drift Detection — Unit Tests
 *
 * Tests detection of performance drift across multiple metrics.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockExecuteRaw = vi.fn().mockResolvedValue(0);
const mockQueryRaw = vi.fn().mockResolvedValue([]);

beforeEach(() => {
  vi.resetModules();
  mockExecuteRaw.mockReset().mockResolvedValue(0);
  mockQueryRaw.mockReset().mockResolvedValue([]);

  vi.doMock('@/database/client', () => ({
    prisma: {
      $executeRaw: mockExecuteRaw,
      $queryRaw: mockQueryRaw,
    },
  }));
  vi.doMock('@/utils/logger', () => ({
    logger: {
      child: () => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
      }),
    },
  }));
});

describe('Drift Detection', () => {
  describe('detectDrift', () => {
    it('detects quality degradation when current window is worse than baseline', async () => {
      // First call: getActiveNiches
      mockQueryRaw
        .mockResolvedValueOnce([{ strategy: 'debate', task_type: 'general' }])
        // Second call: baseline window metrics
        .mockResolvedValueOnce([{
          sample_size: BigInt(50),
          avg_quality: 0.85,
          avg_latency_ms: 3000,
          avg_cost_usd: 0.03,
          success_rate: 0.95,
          quality_p90: 0.93,
        }])
        // Third call: current window metrics (degraded quality)
        .mockResolvedValueOnce([{
          sample_size: BigInt(20),
          avg_quality: 0.60, // 29% degradation — should trigger critical
          avg_latency_ms: 3200,
          avg_cost_usd: 0.035,
          success_rate: 0.80,
          quality_p90: 0.75,
        }]);

      const { detectDrift } = await import('../drift-detection');
      const result = await detectDrift();

      expect(result.checksPerformed).toBe(1);
      expect(result.driftsDetected.length).toBeGreaterThanOrEqual(1);

      // Should have detected quality drift
      const qualityDrift = result.driftsDetected.find(
        d => d.driftType === 'performance' && (d.evidence as Record<string, unknown>).metric === 'quality'
      );
      expect(qualityDrift).toBeDefined();
      expect(qualityDrift!.severity).toBe('critical'); // -29% exceeds critical threshold (-25%)
    });

    it('returns no drifts when metrics are stable', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{ strategy: 'single', task_type: 'general' }])
        .mockResolvedValueOnce([{
          sample_size: BigInt(50),
          avg_quality: 0.82,
          avg_latency_ms: 2000,
          avg_cost_usd: 0.02,
          success_rate: 0.92,
          quality_p90: 0.90,
        }])
        .mockResolvedValueOnce([{
          sample_size: BigInt(20),
          avg_quality: 0.83, // Slightly better — no drift
          avg_latency_ms: 1900,
          avg_cost_usd: 0.019,
          success_rate: 0.93,
          quality_p90: 0.91,
        }]);

      const { detectDrift } = await import('../drift-detection');
      const result = await detectDrift();

      expect(result.checksPerformed).toBe(1);
      expect(result.driftsDetected).toHaveLength(0);
    });

    it('skips niches with insufficient samples', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{ strategy: 'single', task_type: 'general' }])
        .mockResolvedValueOnce([{
          sample_size: BigInt(3), // Below minSamples (10)
          avg_quality: 0.85,
          avg_latency_ms: 2000,
          avg_cost_usd: 0.02,
          success_rate: 0.92,
          quality_p90: 0.90,
        }])
        .mockResolvedValueOnce([{
          sample_size: BigInt(2),
          avg_quality: 0.50,
          avg_latency_ms: 5000,
          avg_cost_usd: 0.10,
          success_rate: 0.40,
          quality_p90: 0.60,
        }]);

      const { detectDrift } = await import('../drift-detection');
      const result = await detectDrift();

      // Should not check because sample sizes are too low
      expect(result.checksPerformed).toBe(0);
      expect(result.driftsDetected).toHaveLength(0);
    });

    it('detects latency degradation', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{ strategy: 'debate', task_type: 'general' }])
        .mockResolvedValueOnce([{
          sample_size: BigInt(50),
          avg_quality: 0.85,
          avg_latency_ms: 2000,
          avg_cost_usd: 0.02,
          success_rate: 0.95,
          quality_p90: 0.93,
        }])
        .mockResolvedValueOnce([{
          sample_size: BigInt(20),
          avg_quality: 0.84, // Quality stable
          avg_latency_ms: 5000, // 150% latency increase — critical
          avg_cost_usd: 0.02,
          success_rate: 0.94,
          quality_p90: 0.92,
        }]);

      const { detectDrift } = await import('../drift-detection');
      const result = await detectDrift();

      const latencyDrift = result.driftsDetected.find(
        d => (d.evidence as Record<string, unknown>).metric === 'latency'
      );
      expect(latencyDrift).toBeDefined();
      expect(latencyDrift!.severity).toBe('critical');
    });

    it('persists drift events to database', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{ strategy: 'single', task_type: 'general' }])
        .mockResolvedValueOnce([{
          sample_size: BigInt(50), avg_quality: 0.85, avg_latency_ms: 2000,
          avg_cost_usd: 0.02, success_rate: 0.95, quality_p90: 0.93,
        }])
        .mockResolvedValueOnce([{
          sample_size: BigInt(20), avg_quality: 0.60, avg_latency_ms: 2000,
          avg_cost_usd: 0.02, success_rate: 0.70, quality_p90: 0.72,
        }]);

      const { detectDrift } = await import('../drift-detection');
      await detectDrift();

      // Should have called $executeRaw to persist drift events
      expect(mockExecuteRaw).toHaveBeenCalled();
    });
  });

  describe('getOpenDriftEvents', () => {
    it('returns open events from database', async () => {
      mockQueryRaw.mockResolvedValue([
        {
          id: 'drift-1',
          drift_type: 'performance',
          scope_key: 'debate|code-generation',
          severity: 'high',
          delta_percent: -15.5,
          detected_at: new Date(),
          status: 'open',
        },
      ]);

      const { getOpenDriftEvents } = await import('../drift-detection');
      const events = await getOpenDriftEvents();

      expect(events).toHaveLength(1);
      expect(events[0].driftType).toBe('performance');
      expect(events[0].severity).toBe('high');
    });
  });
});
