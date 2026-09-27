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
 * Update (2026-09-24): that "handful of redundant runs" turned out to be the
 * main source of connection exhaustion during rollouts (each booting api task
 * filled its whole Prisma pool with one unbounded round). Production now sets
 * MODEL_DISCOVERY_RUN_ON_START=false on the api service, which isBootDiscoveryEnabled()
 * below applies to BOTH boot entry points, and every round (boot, hourly job,
 * admin trigger) takes the fleet-wide discovery lease (discovery-lease.ts), so
 * at most one process runs a round at a time. Two per-process side effects a
 * round used to provide are kept without it: the provider balance map is
 * refreshed on its own timer (startProviderBalanceRefresh() below), and the
 * auto-disable circuit breaker reads a fleet-wide health verdict
 * (discovery-fleet-health.ts) instead of this process's own map.
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
import { scheduleModelEquivalenceIndexRebuild } from '@/services/model-equivalence-service';

type DiscoveryTrigger = 'startup' | 'interval' | 'manual';
type BalanceRefreshReason = 'boot' | 'interval' | 'lease-skipped';

/** Default period of the per-process provider balance refresh. */
export const DEFAULT_PROVIDER_BALANCE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const MIN_PROVIDER_BALANCE_REFRESH_INTERVAL_MS = 60 * 1000;

let discoveryInFlight = false;
let balanceRefreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * PROVIDER_BALANCE_REFRESH_INTERVAL_MS: period of the per-process balance
 * refresh, floored at one minute. "0" turns the refresh off (balances then
 * come only from discovery rounds this process runs, the old behaviour).
 * An invalid value falls back to the hourly default.
 */
export function resolveProviderBalanceRefreshIntervalMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.PROVIDER_BALANCE_REFRESH_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PROVIDER_BALANCE_REFRESH_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PROVIDER_BALANCE_REFRESH_INTERVAL_MS;
  if (parsed === 0) return 0;
  return Math.max(parsed, MIN_PROVIDER_BALANCE_REFRESH_INTERVAL_MS);
}

/**
 * One balance refresh for THIS process, skipped when the map was refreshed
 * within half an interval (by a round or an earlier refresh). Never throws.
 */
async function refreshProviderBalancesQuietly(reason: BalanceRefreshReason): Promise<void> {
  const intervalMs = resolveProviderBalanceRefreshIntervalMs();
  if (intervalMs === 0) return;
  try {
    const service = await getCentralModelDiscoveryService();
    const refreshed = await service.refreshProviderBalances({ maxAgeMs: intervalMs / 2 });
    if (refreshed) {
      logger.info(
        { reason, providersWithBalance: service.getProviderBalanceStatus().size },
        'Provider balances refreshed outside a discovery round'
      );
    }
  } catch (error) {
    logger.warn(
      { reason, error: serializeError(error) },
      'Provider balance refresh failed (non-critical, retried on the next interval)'
    );
  }
}

/**
 * Runs a full dynamic discovery round using the central discovery service.
 *
 * The model equivalence index is NOT rebuilt here any more: that rebuild was
 * awaited inside this function (and so inside discoveryInFlight and the
 * hourly job), and on the 118k-model catalog it never finished (2026-09-24),
 * so the flag stayed true, every later tick was a no-op, and the job kept the
 * worker from shutting down. It is now requested in the background once the
 * round is done (model-equivalence-service.ts, single-flight and budgeted).
 */
async function runDiscovery(trigger: DiscoveryTrigger, signal?: AbortSignal): Promise<void> {
  const service = await getCentralModelDiscoveryService();
  if (discoveryInFlight) {
    logger.warn({ trigger }, 'Model discovery already running, skipping');
    return;
  }

  discoveryInFlight = true;
  const start = Date.now();
  let round: ReturnType<typeof service.discoverAllModelsExclusive> | undefined;

  try {
    round = service.discoverAllModelsExclusive();
    const outcome = await untilAborted(round, signal);
    if (outcome.status === 'skipped') {
      // Another process holds the fleet-wide discovery lease and is running
      // the round (and will schedule its own equivalence index rebuild).
      // Rebuilding here would only burn CPU on a catalog this process did
      // not change.
      logger.info(
        { trigger, holder: outcome.holder },
        'Model discovery skipped: another process holds the discovery lease'
      );
      // The skipped round would have refreshed this process's balance map
      // at its end; keep that map fresh anyway (no-op when it already is).
      void refreshProviderBalancesQuietly('lease-skipped');
      return;
    }
    const results = outcome.results;
    const totalModels = results.reduce((sum, result) => sum + result.modelsDiscovered, 0);
    const errors = results.flatMap((result) => result.errors || []);

    logger.info(
      {
        trigger,
        sourcesProcessed: results.length,
        totalModels,
        leaseEpoch: outcome.leaseEpoch,
        durationMs: Date.now() - start,
        errors: errors.length ? errors : undefined,
      },
      'Dynamic model discovery completed'
    );

    // L2: cross-provider model matching (e.g. gpt-5.4-pro across openai +
    // aihubmix). Background, never awaited; see the function comment.
    scheduleModelEquivalenceIndexRebuild('discovery');
  } catch (error) {
    if (signal?.aborted) {
      logger.warn(
        { trigger, durationMs: Date.now() - start, error: serializeError(error) },
        'Model discovery wait abandoned (job deadline or shutdown); the round continues in the background'
      );
      // Only a round this process actually ran changed the catalog; one the
      // lease skipped leaves the rebuild to the process that holds it.
      void round?.then(
        (outcome) => {
          if (outcome.status === 'completed') {
            scheduleModelEquivalenceIndexRebuild('discovery-after-abandon');
          }
        },
        () => undefined
      );
    } else {
      logger.error({ trigger, error }, 'Dynamic model discovery failed');
    }
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
 *
 * `signal` is the job's deadline/shutdown signal: when it aborts, this returns
 * promptly and releases the in-flight flag (the job itself is failed by the
 * scheduler, so BullMQ never re-dispatches it as stalled).
 */
export async function runScheduledModelDiscovery(signal?: AbortSignal): Promise<void> {
  await runDiscovery('interval', signal);
}

/**
 * Single source of truth for "does THIS process run a discovery round at
 * boot". Both boot entry points consult it: the runner below and index.ts's
 * MODEL_CATALOG_AUTO_SYNC block (syncDiscoveredModels). Before this existed,
 * MODEL_DISCOVERY_RUN_ON_START=false only silenced the runner while the
 * MODEL_CATALOG_AUTO_SYNC path still ran the full round at boot, so the flag
 * did not do what its name says (observed in production 2026-09-24: every
 * booting api task filled its 100-connection pool with discovery).
 */
export function isBootDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MODEL_DISCOVERY_AUTO_SYNC !== 'false' && env.MODEL_DISCOVERY_RUN_ON_START !== 'false';
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

  const runOnStart = isBootDiscoveryEnabled();

  if (runOnStart) {
    // Fire-and-forget so the API can bind its HTTP listener before discovery
    // saturates the event loop. Discovery failures are already logged inside
    // runDiscovery() and treated as non-fatal.
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
 * Keeps THIS process's provider balance map fresh, independent of discovery
 * rounds: one refresh now, then one per PROVIDER_BALANCE_REFRESH_INTERVAL_MS
 * (default hourly), each a no-op when a round or an earlier refresh already
 * updated the map within half an interval.
 *
 * Why: the selector's funding gate and balance score read a per-process map
 * that only a discovery round used to fill. With no boot round on the api
 * and one round fleet-wide per tick, an api task could serve every request
 * with all providers `unknown` (2026-09-24 review). Balance probes are HTTP
 * only, with a 5 s timeout each.
 *
 * Call it once the provider registry and the provider catalog are loaded
 * (index.ts does, after the post-listen catalog load when
 * DEFER_CATALOG_LOAD=true): a refresh before that probes nothing. Idempotent:
 * a second call replaces the timer. Off with MODEL_DISCOVERY_AUTO_SYNC=false
 * (discovery fully off, same as before) or PROVIDER_BALANCE_REFRESH_INTERVAL_MS=0.
 */
export function startProviderBalanceRefresh(): void {
  if (process.env.MODEL_DISCOVERY_AUTO_SYNC === 'false') return;
  const intervalMs = resolveProviderBalanceRefreshIntervalMs();
  if (intervalMs === 0) {
    logger.info(
      'Per-process provider balance refresh disabled (PROVIDER_BALANCE_REFRESH_INTERVAL_MS=0)'
    );
    return;
  }

  stopProviderBalanceRefresh();
  void refreshProviderBalancesQuietly('boot');
  balanceRefreshTimer = setInterval(() => {
    void refreshProviderBalancesQuietly('interval');
  }, intervalMs);
  balanceRefreshTimer.unref?.();
  logger.info({ intervalMs }, 'Per-process provider balance refresh started');
}

export function stopProviderBalanceRefresh(): void {
  if (balanceRefreshTimer) {
    clearInterval(balanceRefreshTimer);
    balanceRefreshTimer = null;
  }
}

/**
 * Stops this process's provider balance refresh timer. The recurring
 * discovery sweep itself has no per-process timer (it is the
 * "model-discovery-hourly" BullMQ job, torn down via
 * jobs/register-scheduled-jobs.ts's shutdownScheduledTasks()). Safe to call
 * from any shutdown path, any number of times.
 */
export function stopModelDiscoveryRunner(): void {
  stopProviderBalanceRefresh();
}

export async function triggerManualModelDiscovery(): Promise<void> {
  await runDiscovery('manual');
}

/**
 * Resolves or rejects with `promise`, or rejects as soon as `signal` aborts
 * (the scheduled job's deadline or a graceful shutdown). The underlying work
 * is not cancelled: an abandoned discovery round keeps running (still holding
 * the fleet-wide discovery lease until it ends) and a later
 * discoverAllModelsExclusive() call joins it (central-model-discovery-service
 * keeps one in-flight round per process), so releasing the flag early can
 * never start a second concurrent round.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('Model discovery aborted'));
    };
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}
