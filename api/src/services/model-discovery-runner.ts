// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { logger } from '@/utils/logger';
import { serializeError } from '@/utils/type-guards';
import { getCentralModelDiscoveryService } from '@/services/central-model-discovery-service';

type DiscoveryTrigger = 'startup' | 'interval' | 'manual';

let schedulerHandle: NodeJS.Timeout | null = null;
let discoveryInFlight = false;

/**
 * Runs a full dynamic discovery round using the central discovery service.
 */
async function runDiscovery(trigger: DiscoveryTrigger): Promise<void> {
  const service = await getCentralModelDiscoveryService();
  if (discoveryInFlight) {
    logger.warn({ trigger }, 'Model discovery already running, skipping');
    return;
  }

  discoveryInFlight = true;
  const start = Date.now();

  try {
    const results = await service.discoverAllModels();
    const totalModels = results.reduce((sum, result) => sum + result.modelsDiscovered, 0);
    const errors = results.flatMap((result) => result.errors || []);

    logger.info(
      {
        trigger,
        sourcesProcessed: results.length,
        totalModels,
        durationMs: Date.now() - start,
        errors: errors.length ? errors : undefined,
      },
      'Dynamic model discovery completed'
    );

    // L2: Rebuild model equivalence index after discovery
    // This enables cross-provider model matching (e.g., gpt-5.4-pro across openai + aihubmix)
    try {
      const { getModelEquivalenceService } = await import('@/services/model-equivalence-service');
      const eqService = getModelEquivalenceService();
      const indexResult = await eqService.buildIndex();
      logger.info(
        { groups: indexResult.groups, models: indexResult.models, durationMs: indexResult.durationMs },
        'Model equivalence index rebuilt after discovery'
      );
    } catch (eqError) {
      logger.warn({ error: String(eqError) }, 'Failed to rebuild model equivalence index (non-critical)');
    }
  } catch (error) {
    logger.error({ trigger, error }, 'Dynamic model discovery failed');
  } finally {
    discoveryInFlight = false;
  }
}

/**
 * Starts the recurring model discovery scheduler (hourly by default).
 */
export async function startModelDiscoveryRunner(): Promise<void> {
  if (process.env.MODEL_DISCOVERY_AUTO_SYNC === 'false') {
    logger.warn('Dynamic model discovery disabled via MODEL_DISCOVERY_AUTO_SYNC=false');
    return;
  }

  const intervalMinutes = Number(process.env.MODEL_DISCOVERY_INTERVAL_MINUTES || '60');
  const runOnStart = process.env.MODEL_DISCOVERY_RUN_ON_START !== 'false';

  if (runOnStart) {
    // Fire-and-forget so the API can bind its HTTP listener before discovery
    // (and its O(n*G) equivalence rebuild) saturates the event loop. Discovery
    // failures are already logged inside runDiscovery() and treated as non-fatal.
    runDiscovery('startup').catch((error) => {
      logger.error({ error: serializeError(error) }, 'Startup model discovery failed (non-blocking)');
    });

    // L1 Self-Healing: Schedule retry for failed sources 30s after startup.
    // This handles the case where GCP secrets arrive after initial discovery.
    // Only retries sources that failed with retriable reasons (missing key, timeout).
    const retryDelayMs = Number(process.env.DISCOVERY_RETRY_DELAY_MS || '30000');
    setTimeout(async () => {
      try {
        const service = await getCentralModelDiscoveryService();
        const health = service.getDiscoveryHealth();
        const retriableSources = health.sources.filter(s => s.retriable);
        if (retriableSources.length > 0 || health.criticalMissing.length > 0) {
          logger.info(
            {
              retriableSources: retriableSources.map(s => s.sourceName),
              criticalMissing: health.criticalMissing,
            },
            'Self-healing: retrying failed discovery sources'
          );
          const results = await service.retryFailedSources();
          const totalRecovered = results.reduce((sum, r) => sum + r.modelsDiscovered, 0);
          if (totalRecovered > 0) {
            logger.info({ totalRecovered, sources: results.map(r => r.source) }, 'Self-healing: recovered models from retry');
          }
        }
      } catch (err) {
        logger.warn({ error: String(err) }, 'Self-healing retry failed (non-critical)');
      }
    }, retryDelayMs);
  }

  if (intervalMinutes > 0) {
    const intervalMs = intervalMinutes * 60 * 1000;
    schedulerHandle = setInterval(() => {
      runDiscovery('interval').catch((error) => {
        logger.error({ error: serializeError(error) }, 'Scheduled model discovery run failed');
      });
    }, intervalMs);

    logger.info({ intervalMinutes }, 'Dynamic model discovery scheduler initialized');
  } else {
    logger.warn('Model discovery scheduler disabled (intervalMinutes <= 0)');
  }
}

export function stopModelDiscoveryRunner(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    logger.info('Dynamic model discovery scheduler stopped');
  }
}

export async function triggerManualModelDiscovery(): Promise<void> {
  await runDiscovery('manual');
}

