// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { autoLearningSystem } from '@/core/learning/auto-learning-system';
import { getSemanticMemoryStore } from '@/core/memory/semantic-memory-store';
import { strategyWeightAge } from '@/observability/ci-metrics';

const log = logger.child({ component: 'ci-reflection-job' });

const CONFIG = {
  enabled: process.env.CI_REFLECTION_JOB_ENABLED !== 'false',
  cronSchedule: process.env.CI_REFLECTION_CRON || '15 */6 * * *',
  // Weekly decay: every Sunday at 02:00 UTC (override via env)
  decayCronSchedule: process.env.CI_DECAY_CRON || '0 2 * * 0',
  maxOrganizations: Math.max(1, Number(process.env.CI_REFLECTION_MAX_ORGANIZATIONS || 200)),
  cleanupLearningData: process.env.CI_REFLECTION_CLEANUP_LEARNING_DATA === 'true',
  // Decay parameters
  decayFactor: parseFloat(process.env.CI_DECAY_FACTOR || '0.95'),
  decayStaleDays: parseInt(process.env.CI_DECAY_STALE_DAYS || '7', 10),
  decayStabilityThreshold: parseInt(process.env.CI_DECAY_STABILITY_THRESHOLD || '100', 10),
};

let cronJob: ScheduledTask | null = null;
let decayCronJob: ScheduledTask | null = null;

export async function runCollectiveIntelligenceReflectionNow(): Promise<void> {
  if (!CONFIG.enabled) {
    log.info('Collective intelligence reflection job is disabled');
    return;
  }

  const startedAt = Date.now();
  log.info(
    {
      maxOrganizations: CONFIG.maxOrganizations,
      cleanupLearningData: CONFIG.cleanupLearningData,
    },
    'Starting collective intelligence reflection cycle'
  );

  const optimization = await autoLearningSystem.optimizeStrategyWeights();

  // Update strategy weight age gauge
  try {
    const weights = await prisma.$queryRaw<
      Array<{ task_type: string; complexity: string; strategy: string; updated_at: Date }>
    >`SELECT task_type, complexity, strategy, updated_at FROM strategy_weights`;
    const now = Date.now();
    for (const w of weights) {
      const ageDays = (now - new Date(w.updated_at).getTime()) / (1000 * 60 * 60 * 24);
      strategyWeightAge.set(
        { task_type: w.task_type, complexity: w.complexity, strategy: w.strategy },
        Math.round(ageDays * 10) / 10
      );
    }
  } catch {
    // Non-fatal
  }
  let cleanup: { deleted: number; compressed: number } | null = null;
  if (CONFIG.cleanupLearningData) {
    cleanup = await autoLearningSystem.cleanup();
  }

  const organizations = await prisma.semanticMemory.findMany({
    select: { organizationId: true },
    distinct: ['organizationId'],
    take: CONFIG.maxOrganizations,
  });

  const memoryStore = getSemanticMemoryStore();
  let consolidated = 0;
  let merged = 0;
  let pruned = 0;

  for (const organization of organizations) {
    try {
      const result = await memoryStore.consolidate(organization.organizationId);
      consolidated += 1;
      merged += result.merged;
      pruned += result.pruned;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(
        { organizationId: organization.organizationId, error: message },
        'Memory consolidation failed for organization'
      );
    }
  }

  const durationMs = Date.now() - startedAt;
  log.info(
    {
      durationMs,
      optimization,
      cleanup,
      organizationsSeen: organizations.length,
      organizationsConsolidated: consolidated,
      memoryMerged: merged,
      memoryPruned: pruned,
    },
    'Collective intelligence reflection cycle completed'
  );
}

export async function runStrategyWeightsDecayNow(): Promise<void> {
  if (!CONFIG.enabled) return;
  log.info(
    { decayFactor: CONFIG.decayFactor, staleDays: CONFIG.decayStaleDays },
    'Running strategy weights decay'
  );
  await autoLearningSystem.decayStrategyWeights({
    decayFactor: CONFIG.decayFactor,
    staleDays: CONFIG.decayStaleDays,
    stabilityThreshold: CONFIG.decayStabilityThreshold,
  });
}

export function startCollectiveIntelligenceReflectionJob(): void {
  if (!CONFIG.enabled) {
    log.info('Collective intelligence reflection scheduled job disabled');
    return;
  }

  if (cronJob) {
    log.warn('Collective intelligence reflection job is already running');
    return;
  }

  cronJob = cron.schedule(
    CONFIG.cronSchedule,
    async () => {
      try {
        await runCollectiveIntelligenceReflectionNow();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.error({ error: message }, 'Collective intelligence reflection cycle failed');
      }
    },
    { timezone: 'UTC' }
  );

  log.info({ schedule: CONFIG.cronSchedule }, 'Collective intelligence reflection job scheduled');

  // Weekly temporal decay of strategy weights
  if (!decayCronJob) {
    decayCronJob = cron.schedule(
      CONFIG.decayCronSchedule,
      async () => {
        try {
          await runStrategyWeightsDecayNow();
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          log.error({ error: message }, 'Strategy weights decay failed');
        }
      },
      { timezone: 'UTC' }
    );
    log.info({ schedule: CONFIG.decayCronSchedule }, 'Strategy weights decay job scheduled');
  }
}

export function stopCollectiveIntelligenceReflectionJob(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
  if (decayCronJob) {
    decayCronJob.stop();
    decayCronJob = null;
  }
  log.info('Collective intelligence reflection and decay jobs stopped');
}

