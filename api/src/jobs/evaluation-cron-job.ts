// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Evaluation Cron Job
 *
 * Scheduled job that runs the closed-loop evaluation pipeline:
 * 1. Generate daily performance snapshots
 * 2. Run drift detection
 * 3. Execute rollbacks for critical drift
 * 4. Run learning validation
 *
 * Schedule: Daily at 04:00 UTC (after benchmark job at 03:00 UTC)
 * Override: EVAL_CRON env var
 */

import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '@/utils/logger';
import { generateDailySnapshots } from '@/core/evaluation/performance-snapshots';
import { detectDrift } from '@/core/evaluation/drift-detection';
import { processRollbacks } from '@/core/evaluation/rollback-service';
import { validateAllStrategies } from '@/core/evaluation/learning-validation';

const log = logger.child({ component: 'evaluation-cron' });

const CONFIG = {
  enabled: process.env.EVAL_CRON_ENABLED !== 'false',
  cronSchedule: process.env.EVAL_CRON || '0 4 * * *', // 04:00 UTC daily
};

let cronJob: ScheduledTask | null = null;

/**
 * Run the full evaluation pipeline.
 * Can be triggered by cron or manually via admin API.
 */
export async function runEvaluationPipeline(): Promise<{
  snapshots: number;
  driftsDetected: number;
  rollbacksExecuted: number;
  learningReports: number;
  durationMs: number;
}> {
  const startedAt = Date.now();
  log.info('Starting evaluation pipeline');

  // 1. Generate performance snapshots (the other steps read from these)
  const snapshots = await generateDailySnapshots();

  // 2+3. Drift detection, then rollbacks for whatever drift it found (a real
  // dependency — rollbacks need driftResult.driftsDetected). 4. Learning
  // validation reads none of the above, so it runs CONCURRENTLY with the
  // drift->rollback chain instead of after it.
  const [{ driftResult, rollbackResult }, learningReports] = await Promise.all([
    (async () => {
      const driftResult = await detectDrift();
      const rollbackResult = await processRollbacks(driftResult.driftsDetected);
      return { driftResult, rollbackResult };
    })(),
    validateAllStrategies(),
  ]);

  const durationMs = Date.now() - startedAt;

  log.info({
    snapshots,
    driftsDetected: driftResult.driftsDetected.length,
    rollbacksExecuted: rollbackResult.rollbacksExecuted,
    learningReports: learningReports.length,
    improvingStrategies: learningReports.filter(r => r.verdict === 'improving').length,
    degradingStrategies: learningReports.filter(r => r.verdict === 'degrading').length,
    durationMs,
  }, 'Evaluation pipeline completed');

  return {
    snapshots,
    driftsDetected: driftResult.driftsDetected.length,
    rollbacksExecuted: rollbackResult.rollbacksExecuted,
    learningReports: learningReports.length,
    durationMs,
  };
}

export function startEvaluationCronJob(): void {
  if (!CONFIG.enabled) {
    log.info('Evaluation cron job disabled');
    return;
  }

  if (cronJob) {
    log.warn('Evaluation cron job already running');
    return;
  }

  cronJob = cron.schedule(
    CONFIG.cronSchedule,
    async () => {
      try {
        await runEvaluationPipeline();
      } catch (err) {
        log.error({ error: String(err) }, 'Evaluation cron job failed');
      }
    },
    { timezone: 'UTC' },
  );

  log.info({ schedule: CONFIG.cronSchedule }, 'Evaluation cron job scheduled');
}

export function stopEvaluationCronJob(): void {
  if (!cronJob) return;
  cronJob.stop();
  cronJob = null;
  log.info('Evaluation cron job stopped');
}
