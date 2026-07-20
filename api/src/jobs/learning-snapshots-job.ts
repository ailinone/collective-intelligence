// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Learning Snapshots Job (P1-3 / LN-02)
 *
 * Periodically captures longitudinal learning-system state — bandit α/β per
 * niche, configuration-archive fitness, triage calibration accuracy — so the
 * C3 analysis can show the system actually improves over time instead of
 * merely mutating internal state. Persistence primitives live in
 * core/validation/c3/learning-snapshots.ts; this job is the collector that
 * feeds them from the live singletons.
 *
 * Default ON (the whole point is an always-on longitudinal trail).
 *   LEARNING_SNAPSHOTS_ENABLED=false      — disable
 *   LEARNING_SNAPSHOTS_INTERVAL_MS=...    — capture interval (default 1h)
 */

import { logger } from '@/utils/logger';
import { strategyBandit } from '@/core/learning/strategy-bandit';
import { configurationArchive } from '@/core/learning/configuration-archive';
import { triageCalibrator } from '@/core/learning/triage-calibrator';

const log = logger.child({ component: 'learning-snapshots-job' });

let timer: NodeJS.Timeout | null = null;

async function captureOnce(): Promise<void> {
  const snaps = await import('@/core/validation/c3/learning-snapshots');
  const results = await Promise.allSettled([
    // Bandit α/β per niche — the core longitudinal learning evidence.
    ...strategyBandit.getAllParams().map(({ niche, alpha, beta }) =>
      snaps.snapshotBanditParams(niche, alpha, beta, Math.max(0, Math.round(alpha + beta - 2)))
    ),
    // Archive coverage/fitness (aggregate niche: archive snapshot is global).
    (async () => {
      const archive = configurationArchive.getSnapshot();
      const fitnesses = archive.topElites.map(e => e.fitness).filter((f): f is number => typeof f === 'number');
      const avgFitness = fitnesses.length ? fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length : 0;
      const bestFitness = fitnesses.length ? Math.max(...fitnesses) : 0;
      await snaps.snapshotArchiveFitness('global', archive.cellCount, avgFitness, bestFitness, archive.totalElites);
    })(),
    // Triage calibration accuracy.
    (async () => {
      const cal = triageCalibrator.calibrate();
      if (cal.sampleCount > 0) {
        await snaps.snapshotTriageAccuracy(
          cal.overall,
          cal.sampleCount,
          Math.round(cal.overall * cal.sampleCount),
          cal.sampleCount
        );
      }
    })(),
  ]);

  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed > 0) {
    log.warn({ failed, total: results.length }, 'Some learning snapshots failed to persist');
  } else {
    log.debug({ captured: results.length }, 'Learning snapshots captured');
  }
}

export function startLearningSnapshotsJob(): void {
  if (process.env.LEARNING_SNAPSHOTS_ENABLED === 'false') {
    log.info('Learning snapshots disabled (LEARNING_SNAPSHOTS_ENABLED=false)');
    return;
  }
  if (timer) return;

  const intervalMs = Number(process.env.LEARNING_SNAPSHOTS_INTERVAL_MS) || 3_600_000;
  timer = setInterval(() => {
    captureOnce().catch(err => log.warn({ err: String(err) }, 'Learning snapshot capture failed'));
  }, intervalMs);
  timer.unref?.();

  // First capture shortly after boot, once learning systems have seeded.
  const warmup = setTimeout(() => {
    captureOnce().catch(err => log.warn({ err: String(err) }, 'Initial learning snapshot failed'));
  }, 60_000);
  warmup.unref?.();

  log.info({ intervalMs }, 'Learning snapshots job started (longitudinal learning evidence)');
}

export function stopLearningSnapshotsJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
