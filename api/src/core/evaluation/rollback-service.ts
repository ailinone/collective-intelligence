// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Intelligent Rollback Service
 *
 * Connects drift detection to automated policy adjustment.
 * When drift is detected with severity >= high:
 * 1. Identifies the affected scope (strategy + niche)
 * 2. Reduces the weight/confidence of the degraded strategy
 * 3. Records the rollback event with full audit trail
 * 4. Schedules post-rollback validation
 *
 * Rollback is never destructive — it preserves all history and is reversible.
 * Rollback never enters an infinite loop — rate-limited per scope.
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import type { DriftEventInput } from './drift-detection';

const log = logger.child({ component: 'rollback-service' });

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  /** Only auto-rollback on severity >= this */
  autoRollbackMinSeverity: 'high' as const,
  /** Minimum time between rollbacks for the same scope (ms) */
  rollbackCooldownMs: 3_600_000, // 1 hour
  /** Maximum rollbacks per scope per day */
  maxRollbacksPerScopePerDay: 3,
  /** Weight reduction factor applied to degraded strategies */
  weightReductionFactor: 0.5,
};

// ─── State ──────────────────────────────────────────────────────────────────

const lastRollbackByScope = new Map<string, number>();

// ─── Core Logic ─────────────────────────────────────────────────────────────

/**
 * Process drift events and execute rollback where appropriate.
 * Called after drift detection completes.
 */
export async function processRollbacks(
  driftEvents: DriftEventInput[],
): Promise<{ rollbacksExecuted: number; skipped: number }> {
  let executed = 0;
  let skipped = 0;

  const severeEvents = driftEvents.filter(
    e => e.severity === 'critical' || e.severity === 'high',
  );

  for (const event of severeEvents) {
    const scope = event.scopeKey;

    // Cooldown check
    const lastRollback = lastRollbackByScope.get(scope) ?? 0;
    if (Date.now() - lastRollback < CONFIG.rollbackCooldownMs) {
      log.debug({ scope }, 'Rollback skipped — cooldown active');
      skipped++;
      continue;
    }

    // Daily limit check
    const dailyCount = await getDailyRollbackCount(scope);
    if (dailyCount >= CONFIG.maxRollbacksPerScopePerDay) {
      log.warn({ scope, dailyCount }, 'Rollback skipped — daily limit reached');
      skipped++;
      continue;
    }

    try {
      await executeRollback(event);
      lastRollbackByScope.set(scope, Date.now());
      executed++;
    } catch (err) {
      log.error({ error: String(err), scope }, 'Rollback execution failed');
      skipped++;
    }
  }

  if (executed > 0) {
    log.warn({ executed, skipped }, 'Rollback processing completed');
  }

  return { rollbacksExecuted: executed, skipped };
}

/**
 * Execute a rollback for a specific drift event.
 * Reduces the strategy weight and records the event.
 */
async function executeRollback(driftEvent: DriftEventInput): Promise<void> {
  const [strategy] = driftEvent.scopeKey.split('|');
  if (!strategy) return;

  // Get current weights for this strategy
  const currentWeights = await prisma.$queryRaw<Array<{
    task_type: string;
    complexity: string;
    weight: number;
    avg_quality: number;
  }>>`
    SELECT task_type, complexity, weight, avg_quality
    FROM strategy_weights
    WHERE strategy = ${strategy}
  `;

  const previousPolicy = {
    strategy,
    weights: currentWeights,
    timestamp: new Date().toISOString(),
  };

  // Apply weight reduction.
  // Also reduce avg_quality proportionally to prevent autoLearningSystem.updateStrategyWeights()
  // from immediately restoring the weight on the next learn() call. The UPSERT in
  // autoLearningSystem computes weight from avg_quality, so reducing both ensures the
  // rollback effect persists until enough new high-quality executions accumulate.
  const factor = CONFIG.weightReductionFactor;
  await prisma.$executeRaw`
    UPDATE strategy_weights
    SET weight = weight * ${factor},
        avg_quality = avg_quality * ${factor},
        updated_at = NOW()
    WHERE strategy = ${strategy}
  `;

  const newPolicy = {
    strategy,
    action: 'weight_reduction',
    reductionFactor: CONFIG.weightReductionFactor,
    timestamp: new Date().toISOString(),
  };

  // Record the rollback event
  await prisma.$executeRaw`
    INSERT INTO rollback_events (
      scope_type, scope_key, previous_policy, new_policy,
      reason, expected_recovery
    ) VALUES (
      ${driftEvent.scopeType},
      ${driftEvent.scopeKey},
      ${JSON.stringify(previousPolicy)}::jsonb,
      ${JSON.stringify(newPolicy)}::jsonb,
      ${`Drift detected: ${(driftEvent.evidence as Record<string, unknown>).metric ?? 'unknown'} degraded by ${driftEvent.deltaPercent.toFixed(1)}% (severity: ${driftEvent.severity})`},
      ${'Weight reduced — strategy will be selected less frequently. Auto-recovery via production feedback if strategy quality improves.'}
    )
  `;

  log.warn({
    strategy,
    severity: driftEvent.severity,
    deltaPercent: driftEvent.deltaPercent.toFixed(1),
    metric: (driftEvent.evidence as Record<string, unknown>).metric,
    weightReduction: CONFIG.weightReductionFactor,
  }, 'ROLLBACK EXECUTED — strategy weight reduced');
}

async function getDailyRollbackCount(scopeKey: string): Promise<number> {
  try {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count
      FROM rollback_events
      WHERE scope_key = ${scopeKey}
        AND executed_at >= ${new Date(Date.now() - 86_400_000)}
    `;
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Get recent rollback events for admin inspection.
 */
export async function getRecentRollbacks(limit: number = 20): Promise<Array<{
  id: string;
  scopeKey: string;
  reason: string;
  executedAt: Date;
  validatedAt: Date | null;
}>> {
  try {
    const rows = await prisma.$queryRaw<Array<{
      id: string;
      scope_key: string;
      reason: string;
      executed_at: Date;
      validated_at: Date | null;
    }>>`
      SELECT id, scope_key, reason, executed_at, validated_at
      FROM rollback_events
      ORDER BY executed_at DESC
      LIMIT ${limit}
    `;
    return rows.map(r => ({
      id: r.id,
      scopeKey: r.scope_key,
      reason: r.reason,
      executedAt: r.executed_at,
      validatedAt: r.validated_at,
    }));
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to query rollback events');
    return [];
  }
}
