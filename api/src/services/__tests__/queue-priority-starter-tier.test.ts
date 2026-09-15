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
 * `RequestQueueService.calculatePriority`'s `basePriorities` map had no
 * `starter` entry even though `'starter'` is a real, assignable
 * `TierLevel` — so for a starter-tier organization, `basePriorities.starter`
 * was `undefined`, and `undefined + jitter` produced `NaN`, corrupting the
 * BullMQ job priority for every starter-tier request queued under load
 * (exactly the scenario in which this codepath actually runs).
 *
 * `calculateQueuePriority` (queue-priority.ts) is the pure extraction of
 * that math — importing it directly (rather than
 * `@/services/request-queue-service`, whose module-level singleton opens a
 * real Redis connection + BullMQ queue as a side effect of import) keeps
 * this test hermetic.
 */
import { describe, it, expect } from 'vitest';
import { calculateQueuePriority, getBaseQueuePriorities } from '@/services/queue-priority';
import { TierLevel } from '@/domain/value-objects/organization-tier';
import { config } from '@/config';

describe('calculateQueuePriority — starter tier', () => {
  it('has a dedicated, finite basePriorities entry for every real TierLevel (prevents this class of gap recurring)', () => {
    const base = getBaseQueuePriorities();
    for (const level of Object.values(TierLevel)) {
      expect(Number.isFinite(base[level]), `basePriorities missing/invalid entry for '${level}'`).toBe(
        true
      );
    }
  });

  it('never returns NaN for a starter-tier org, across many draws (jitter is randomized)', () => {
    for (let i = 0; i < 200; i++) {
      const priority = calculateQueuePriority(TierLevel.STARTER);
      expect(Number.isNaN(priority)).toBe(false);
      expect(Number.isFinite(priority)).toBe(true);
      expect(priority).toBeGreaterThanOrEqual(1);
    }
  });

  it('is strictly greater than free and strictly less than pro — enterprise > pro > starter > free ordering holds even at jitter extremes', () => {
    const jitter = config.queue.priority.jitter;

    // Sanity-check the configured bands never overlap even at their jitter
    // extremes, so the per-draw ordering assertions below can't be flaky.
    expect(config.queue.priority.starter - jitter).toBeGreaterThan(
      config.queue.priority.pro + jitter
    );
    expect(config.queue.priority.free - jitter).toBeGreaterThan(
      config.queue.priority.starter + jitter
    );

    for (let i = 0; i < 200; i++) {
      const enterprise = calculateQueuePriority(TierLevel.ENTERPRISE);
      const pro = calculateQueuePriority(TierLevel.PRO);
      const starter = calculateQueuePriority(TierLevel.STARTER);
      const free = calculateQueuePriority(TierLevel.FREE);

      expect(enterprise).toBeLessThan(pro);
      expect(pro).toBeLessThan(starter);
      expect(starter).toBeLessThan(free);
    }
  });
});
