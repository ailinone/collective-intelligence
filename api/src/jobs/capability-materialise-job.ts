// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability Materialise Job (ADR-022, Sprint 2 closure)
 *
 * Rebuilds the `models.capability_uris` / `capability_confidence` /
 * `capability_sources` projection from the append-only
 * `model_capability_assertions` log via Bayesian noisy-OR fusion + depth-1
 * hierarchical propagation. Without this job running on a schedule, the
 * canonical capability column drifts away from new assertions written by:
 *
 *   - Discovery service (provider-declared, parameter-derived assertions)
 *   - Helicone oracle cross-checks
 *   - LLM-extracted doc mining
 *   - Operator overrides via the admin route
 *   - Backfill scripts (`api/scripts/_*-assertions-*.ts`)
 *
 * The bandit recall layer (L5/L10) reads `capability_uris` to filter the
 * candidate pool. Stale projection ⇒ stale routing decisions, which the
 * downstream feedback loop only partially corrects.
 *
 * Why a thin wrapper around `materialiseAllCapabilities`:
 *   - Same boundary discipline as `embedding-refresh-job`: the worker module
 *     is pg-only; it shouldn't know about BullMQ or env-var gating.
 *   - The function is already idempotent (running twice with no new
 *     assertions produces the same result), so no concurrency guard is
 *     needed beyond the BullMQ single-execution lock.
 *
 * Why no per-tick row cap (cf. embedding-refresh's 5,000):
 *   - The materialiser streams assertions per-model and writes one UPDATE
 *     per model. A full rebuild over ~64K models is dominated by I/O, not
 *     CPU; capping it would just stretch the window without reducing peak
 *     load. The 30-minute timeout below catches genuinely-stuck runs.
 */

import { logger } from '@/utils/logger';
import { materialiseAllCapabilities } from '@/capability/assertions/materialiser';
import { getCapabilityPool } from '@/capability/db/capability-pool';

const log = logger.child({ component: 'capability-materialise-job' });

/**
 * Whether the materialiser is enabled. Default true: the cost of running
 * over zero assertions is one streaming SELECT, so the safer default is to
 * keep the canonical projection fresh. Operators can disable via the env
 * var below if they need to quiesce the cluster for a migration.
 */
export function isCapabilityMaterialiseEnabled(): boolean {
  return process.env.HCRA_MATERIALISE_DISABLED !== 'true';
}

export async function runCapabilityMaterialiseNow(): Promise<void> {
  if (!isCapabilityMaterialiseEnabled()) {
    log.info('HCRA_MATERIALISE_DISABLED=true — skipping capability materialise tick');
    return;
  }

  const pool = getCapabilityPool();
  const stats = await materialiseAllCapabilities(pool);

  log.info(
    {
      modelsWritten: stats.modelsWritten,
      modelsCleared: stats.modelsCleared,
      capabilitiesEmitted: stats.capabilitiesEmitted,
      capabilitiesSuppressed: stats.capabilitiesSuppressed,
      elapsedMs: stats.elapsedMs,
    },
    'Capability materialise tick complete',
  );
}
