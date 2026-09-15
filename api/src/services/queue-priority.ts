// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Queue priority calculation (BullMQ) — extracted from RequestQueueService
 * as a small, pure, side-effect-free module.
 *
 * WHY THIS IS ITS OWN FILE (not a method on RequestQueueService)
 * ---------------------------------------------------------------
 * `request-queue-service.ts`'s module scope constructs and exports a
 * singleton (`export const requestQueueService = new RequestQueueService()`)
 * whose constructor opens a real Redis connection and a BullMQ `Queue`.
 * Merely importing that module — even just to reach a pure helper function
 * — triggers those side effects, which is why every existing test that
 * touches queue behavior (`chat-completions-queue-wiring.test.ts`,
 * `tests/api/middleware/queue-manager.test.ts`) fully `vi.mock`s
 * `@/services/request-queue-service` rather than importing it directly.
 *
 * Pulling the priority math out here lets it be covered by a real,
 * hermetic unit test (no Redis/BullMQ mocking required) while
 * `RequestQueueService.calculatePriority` keeps delegating to it, so
 * production behavior (including the config reads and jitter randomness)
 * is unchanged.
 */
import { config } from '@/config';
import { TierLevel } from '@/domain/value-objects/organization-tier';

/**
 * Base (pre-jitter) BullMQ priority per organization tier — lower numbers
 * are processed first by BullMQ.
 *
 * Typed `Record<TierLevel, number>` rather than a bare object literal so
 * that adding a new `TierLevel` member without a matching
 * `config.queue.priority` key is a TypeScript compile error, not a silent
 * `undefined` (and therefore `NaN` once jitter is added) at runtime. This
 * is exactly the bug being guarded against: 'starter' was a real,
 * assignable `TierLevel` with no entry in this map, so
 * `basePriorities['starter']` was `undefined`, and `undefined + jitter`
 * produced `NaN`, corrupting the BullMQ job priority for every starter-tier
 * request queued while the system was under load.
 */
export function getBaseQueuePriorities(): Record<TierLevel, number> {
  return {
    [TierLevel.ENTERPRISE]: config.queue.priority.enterprise,
    [TierLevel.PRO]: config.queue.priority.pro,
    [TierLevel.STARTER]: config.queue.priority.starter,
    [TierLevel.FREE]: config.queue.priority.free,
  };
}

/**
 * Calculate the BullMQ job priority for a request from an organization on
 * `tier`, adding jitter (bounded by `config.queue.priority.jitter`) to
 * avoid starving any one tier's requests within its own band.
 *
 * Priority tiers (1 = highest, 10000 = lowest):
 *   - Enterprise: ~500  (highest priority)
 *   - Pro:        ~3000
 *   - Starter:    ~5000
 *   - Free:       ~7500 (lowest priority)
 */
export function calculateQueuePriority(tier: TierLevel): number {
  const basePriorities = getBaseQueuePriorities();

  const jitterRange = config.queue.priority.jitter;
  const jitter =
    jitterRange > 0 ? Math.floor(Math.random() * (jitterRange * 2 + 1)) - jitterRange : 0;

  return Math.max(1, basePriorities[tier] + jitter);
}
