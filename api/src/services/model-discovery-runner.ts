// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model discovery runner — the per-process entrypoint that fires the ~95
 * provider fetchers via central-model-discovery-service.discoverAllModels().
 *
 * Fleet-dedup fix (2026-09): startModelDiscoveryRunner() used to register a
 * plain per-process `setInterval` (default hourly, MODEL_DISCOVERY_INTERVAL_MINUTES)
 * that called discoverAllModels() independently in EVERY process. Since
 * index.ts calls this unconditionally at boot, the production topology (2
 * `ci_api` replicas + `ci_worker`) ran the full discovery sweep — real HTTP
 * calls against every provider's live API, not just a local DB query — three
 * times over, once per process, every single hour. This is the same
 * per-replica-multiplication bug class the REL-01 fix already closed for
 * every other scheduled job (see index.ts's BullMQ-cron comment) and that
 * cache-refresh-ahead.ts's own "catalog-cache-refresh" job closed for the
 * catalog hot-path query (docs/CAPACITY-SCALING-PLAN-10K-USERS.md, Track 1
 * §2.3) — reused here rather than reinvented.
 *
 * The RECURRING sweep now runs exactly once fleet-wide via the
 * "model-discovery-hourly" BullMQ repeatable job (jobs/register-scheduled-jobs.ts),
 * whose Redis lock elects one process per tick — any `ci_api` replica or
 * `ci_worker` may win, never a hardcoded "worker only" rule. That job's
 * handler calls runScheduledModelDiscovery() below.
 *
 * Deliberately UNCHANGED: the one-time at-boot discovery (`runOnStart`) still
 * fires independently in every process, same as before this fix. That is
 * intentional, not an oversight — it is what lets each replica come up with a
 * non-empty catalog immediately after a fresh deploy/restart without waiting
 * on the next fleet-wide BullMQ tick, and a handful of redundant discovery
 * runs at deploy time (which is already staggered across replicas, not
 * simultaneous) is a fundamentally different cost profile than an
 * indefinitely-repeating per-process hourly sweep. The 30s self-healing retry
 * for failed sources is the same kind of one-shot, per-process concern and is
 * also unchanged.
 *
 * MODEL_DISCOVERY_INTERVAL_MINUTES is superseded for the recurring sweep by
 * the BullMQ job's own cron pattern (default hourly, override via
 * MODEL_DISCOVERY_CRON — see register-scheduled-jobs.ts). It is deliberately
 * left unread here rather than repurposed, since production never overrides
 * it away from the code's prior 60-minute default (verified against
 * docker-compose.production.yml) — nothing observable changes for the
 * standard deployment.
 */
import { logger } from '@/utils/logger';
import { serializeError } from '@/utils/type-guards';
import { getCentralModelDiscoveryService } from '@/services/central-model-discovery-service';

type DiscoveryTrigger = 'startup' | 'interval' | 'manual';

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
        {
          groups: indexResult.groups,
          models: indexResult.models,
          durationMs: indexResult.durationMs,
        },
        'Model equivalence index rebuilt after discovery'
      );
    } catch (eqError) {
      logger.warn(
        { error: String(eqError) },
        'Failed to rebuild model equivalence index (non-critical)'
      );
    }
  } catch (error) {
    logger.error({ trigger, error }, 'Dynamic model discovery failed');
  } finally {
    discoveryInFlight = false;
  }
}

/**
 * Fleet-deduped recurring discovery tick, driven by the "model-discovery-hourly"
 * BullMQ repeatable job (register-scheduled-jobs.ts). BullMQ's Redis-locked
 * repeatable-job semantics guarantee exactly one process across the whole
 * fleet (any `ci_api` replica or `ci_worker`) executes this per tick — see
 * this module's top-of-file comment for the bug this replaces.
 */
export async function runScheduledModelDiscovery(): Promise<void> {
  await runDiscovery('interval');
}

/**
 * Starts model discovery for THIS process: the one-time at-boot run (and its
 * 30s self-healing retry), both deliberately per-process — see the top-of-file
 * comment. The recurring hourly sweep is fleet-deduped elsewhere (BullMQ job,
 * see runScheduledModelDiscovery above) and is intentionally NOT scheduled
 * from here any more.
 */
export async function startModelDiscoveryRunner(): Promise<void> {
  if (process.env.MODEL_DISCOVERY_AUTO_SYNC === 'false') {
    logger.warn('Dynamic model discovery disabled via MODEL_DISCOVERY_AUTO_SYNC=false');
    return;
  }

  const runOnStart = process.env.MODEL_DISCOVERY_RUN_ON_START !== 'false';

  if (runOnStart) {
    // Fire-and-forget so the API can bind its HTTP listener before discovery
    // (and its O(n*G) equivalence rebuild) saturates the event loop. Discovery
    // failures are already logged inside runDiscovery() and treated as non-fatal.
    runDiscovery('startup').catch((error) => {
      logger.error(
        { error: serializeError(error) },
        'Startup model discovery failed (non-blocking)'
      );
    });

    // L1 Self-Healing: Schedule retry for failed sources 30s after startup.
    // This handles the case where GCP secrets arrive after initial discovery.
    // Only retries sources that failed with retriable reasons (missing key, timeout).
    const retryDelayMs = Number(process.env.DISCOVERY_RETRY_DELAY_MS || '30000');
    setTimeout(async () => {
      try {
        const service = await getCentralModelDiscoveryService();
        const health = service.getDiscoveryHealth();
        const retriableSources = health.sources.filter((s) => s.retriable);
        if (retriableSources.length > 0 || health.criticalMissing.length > 0) {
          logger.info(
            {
              retriableSources: retriableSources.map((s) => s.sourceName),
              criticalMissing: health.criticalMissing,
            },
            'Self-healing: retrying failed discovery sources'
          );
          const results = await service.retryFailedSources();
          const totalRecovered = results.reduce((sum, r) => sum + r.modelsDiscovered, 0);
          if (totalRecovered > 0) {
            logger.info(
              { totalRecovered, sources: results.map((r) => r.source) },
              'Self-healing: recovered models from retry'
            );
          }
        }
      } catch (err) {
        logger.warn({ error: String(err) }, 'Self-healing retry failed (non-critical)');
      }
    }, retryDelayMs);
  }

  // No per-process setInterval here any more — the recurring hourly sweep is
  // registered exactly once fleet-wide as the "model-discovery-hourly" BullMQ
  // job (register-scheduled-jobs.ts). See this module's top-of-file comment.
  logger.info(
    'Dynamic model discovery: at-boot run handled per-process; recurring sweep is fleet-deduped via the "model-discovery-hourly" BullMQ job'
  );
}

/**
 * No-op retained for API compatibility: there is no longer a per-process
 * timer to stop (the recurring sweep moved to the "model-discovery-hourly"
 * BullMQ job, torn down via jobs/register-scheduled-jobs.ts's
 * shutdownScheduledTasks()). Safe to call from any existing shutdown path.
 */
export function stopModelDiscoveryRunner(): void {
  // Intentionally empty — see doc comment above.
}

export async function triggerManualModelDiscovery(): Promise<void> {
  await runDiscovery('manual');
}
