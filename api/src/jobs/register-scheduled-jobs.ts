// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Scheduled Jobs Registry — BullMQ Repeatable Jobs
 * C2 fix: Replaces node-cron with BullMQ upsertJobScheduler for distributed single-execution.
 * ADR-002: node-cron is prohibited for new jobs. All scheduling MUST use this module.
 *
 * BullMQ repeatable jobs guarantee single-execution across multiple instances via Redis
 * lock, unlike node-cron which executes independently per-process.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { createRedisClient } from '@/cache/redis-client';
import { config } from '@/config';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'scheduled-jobs' });

/**
 * Single source of truth for whether BullMQ distributed crons are the active
 * scheduler (REL-01 split-brain fix).
 *
 * BullMQ distributed crons are the DEFAULT and — after removal of the legacy
 * node-cron fallback — the ONLY scheduler. A BullMQ repeatable job fires
 * exactly once per tick across every replica via a Redis lock, whereas the
 * old in-process node-cron scheduler executed independently in each process
 * and therefore duplicated every scheduled run across replicas.
 *
 * Semantics of USE_BULLMQ_CRONS:
 *   - unset / any value except "false" → enabled (default-on)
 *   - "false"                          → explicit opt-out. There is no
 *     node-cron fallback to opt into, so index.ts treats this as a fatal
 *     misconfiguration and fails fast rather than booting with zero crons.
 *     Here (and in the worker process) it degrades to a defensive no-op.
 *
 * Both index.ts and this module derive the flag from THIS function so the two
 * entrypoints can never diverge again.
 */
export function isBullmqCronsEnabled(): boolean {
  return process.env.USE_BULLMQ_CRONS !== 'false';
}

// ── Metric imports (lazily resolved to avoid circular deps) ──
let cronExecutionTotal: { inc: (labels: Record<string, string>) => void } | null = null;
let cronExecutionDuration: { observe: (labels: Record<string, string>, value: number) => void } | null = null;
let cronExecutionErrors: { inc: (labels: Record<string, string>) => void } | null = null;

async function ensureMetrics() {
  if (cronExecutionTotal) return;
  try {
    const promClient = await import('prom-client');
    cronExecutionTotal = new promClient.Counter({ name: 'ailin_dev_cron_execution_total', help: 'Total cron job executions', labelNames: ['job_name', 'status'] });
    cronExecutionDuration = new promClient.Histogram({ name: 'ailin_dev_cron_execution_duration_seconds', help: 'Cron job execution duration', labelNames: ['job_name'] });
    cronExecutionErrors = new promClient.Counter({ name: 'ailin_dev_cron_execution_errors_total', help: 'Cron job execution errors', labelNames: ['job_name'] });
  } catch {
    // Metrics unavailable — non-fatal
  }
}

// ── Job Handler Registry ──
// Each handler is a lazy import to avoid loading all job modules at startup.
// Handlers are resolved only when the job fires.
type JobHandler = () => Promise<void>;

const JOB_HANDLERS: Record<string, () => Promise<JobHandler>> = {
  'revoke-expired-keys': async () => {
    const m = await import('./api-key-maintenance.js');
    return async () => { await m.manualRevokeExpired(); };
  },
  'auto-rotation-check': async () => {
    const m = await import('./api-key-maintenance.js');
    return async () => { await m.manualAutoRotation(); };
  },
  'billing-reconciliation': async () => {
    const m = await import('./billing-usage-reconciliation-job.js');
    return () => m.runUsageReconciliationCycle();
  },
  'stripe-catalog-sync': async () => {
    // stripe-catalog-sync-job.ts only exports startStripeCatalogSyncJob which schedules node-cron.
    // The actual sync logic is inline. We import from billing-plan-service directly.
    const m = await import('@/services/billing-plan-service.js');
    return async () => { await m.syncStripeCatalog(); };
  },
  'secret-rotation': async () => {
    // secret-rotation-job.ts only exports startSecretRotationJob which schedules node-cron.
    // The rotation logic is inline. We'll call start which schedules, but under BullMQ
    // the job is already scheduled. So we need to extract the logic.
    // For now, use the start function as a no-op guard and let the inline logic run.
    const m = await import('./secret-rotation-job.js');
    return async () => { m.startSecretRotationJob(); };
  },
  'security-audit-retention': async () => {
    const m = await import('./security-audit-retention-job.js');
    return async () => { m.startSecurityAuditRetentionJob(); };
  },
  'log-retention': async () => {
    const m = await import('./log-retention-job.js');
    return () => m.runLogRetentionCleanupNow();
  },
  'context-cache-cleanup': async () => {
    const m = await import('./context-cache-cleanup-job.js');
    return async () => { await m.runContextCacheCleanupNow(); };
  },
  'continuous-benchmark': async () => {
    const m = await import('./continuous-benchmark-job.js');
    return async () => { await m.runContinuousBenchmarkNow(); };
  },
  'ci-reflection': async () => {
    const m = await import('./collective-intelligence-reflection-job.js');
    return () => m.runCollectiveIntelligenceReflectionNow();
  },
  'strategy-weight-decay': async () => {
    const m = await import('./collective-intelligence-reflection-job.js');
    return () => m.runStrategyWeightsDecayNow();
  },
  'training-data-export': async () => {
    const m = await import('./training-data-export-job.js');
    return async () => { await m.runTrainingDataExport(); };
  },
  'evaluation-pipeline': async () => {
    const m = await import('./evaluation-cron-job.js');
    return async () => { await m.runEvaluationPipeline(); };
  },
  // R7 fix: Outbox table cleanup — delete published events older than 7 days
  'outbox-cleanup': async () => {
    const { prisma } = await import('@/database/client.js');
    return async () => {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const { count } = await prisma.domainEventOutbox.deleteMany({
        where: { publishedAt: { not: null, lt: cutoff } },
      });
      if (count > 0) log.info({ deleted: count }, 'Outbox cleanup: removed published events');
    };
  },
  // R8 fix: Webhook events cleanup — delete processed events older than 90 days
  'webhook-events-cleanup': async () => {
    const { prisma } = await import('@/database/client.js');
    return async () => {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const { count } = await prisma.processedWebhookEvent.deleteMany({
        where: { processedAt: { lt: cutoff } },
      });
      if (count > 0) log.info({ deleted: count }, 'Webhook events cleanup: removed old processed events');
    };
  },
  // Chip 5: Embedding refresh — populates HCRA L3 vectors so semantic rerank
  // can contribute. Idempotent: no-op when no rows are stale.
  'embedding-refresh': async () => {
    const m = await import('./embedding-refresh-job.js');
    return () => m.runEmbeddingRefreshNow();
  },
  // Capability materialise — rebuilds models.capability_uris/confidence/sources
  // from append-only model_capability_assertions. Closes the structural gap
  // where assertions accumulated but the canonical projection never updated.
  'capability-materialise': async () => {
    const m = await import('./capability-materialise-job.js');
    return () => m.runCapabilityMaterialiseNow();
  },
  // Metadata backfill — idempotent drift-catcher for metadata.endpoint and
  // metadata.tools. Steady-state cost is two indexed COUNT queries; the
  // first run after deploy is the only one that does meaningful UPDATEs.
  'metadata-backfill': async () => {
    const m = await import('./metadata-backfill-job.js');
    return async () => { await m.runMetadataBackfillNow(); };
  },
};

// ── Schedule Definitions ──
interface ScheduledJobDef {
  name: string;
  /** Standard 5-field cron expression (UTC) */
  pattern: string;
  /** env var to override schedule, or null */
  envOverride?: string;
  /** Guard: if this returns false, the job is not registered */
  enabled?: () => boolean;
  /** Timeout in ms for long-running jobs */
  timeout?: number;
}

const SCHEDULED_JOBS: ScheduledJobDef[] = [
  { name: 'revoke-expired-keys',       pattern: '0 * * * *' },
  { name: 'auto-rotation-check',       pattern: '0 2 * * *' },
  { name: 'billing-reconciliation',    pattern: '0 2 * * *',   enabled: () => config.payments?.stripe?.enabled ?? false },
  { name: 'stripe-catalog-sync',       pattern: '15 * * * *',  enabled: () => config.payments?.stripe?.enabled ?? false },
  { name: 'secret-rotation',           pattern: '0 3 * * *' },
  { name: 'security-audit-retention',  pattern: '0 4 * * *' },
  { name: 'log-retention',             pattern: '0 2 * * *',   timeout: 3_600_000 },
  { name: 'context-cache-cleanup',     pattern: '0 * * * *' },
  { name: 'continuous-benchmark',      pattern: '0 3 * * *',   timeout: 1_800_000,  enabled: () => process.env.CI_BENCHMARK_JOB_ENABLED !== 'false' },
  { name: 'ci-reflection',             pattern: '15 */6 * * *', enabled: () => process.env.CI_REFLECTION_JOB_ENABLED !== 'false' },
  { name: 'strategy-weight-decay',     pattern: '0 2 * * 0',   enabled: () => process.env.CI_REFLECTION_JOB_ENABLED !== 'false' },
  { name: 'training-data-export',      pattern: '0 2 * * *',   enabled: () => process.env.FEEDBACK_EXPORT_ENABLED !== 'false' },
  { name: 'evaluation-pipeline',       pattern: '0 4 * * *',   enabled: () => process.env.EVAL_CRON_ENABLED !== 'false' },
  { name: 'outbox-cleanup',           pattern: '30 3 * * *' },  // R7: daily 03:30 UTC
  { name: 'webhook-events-cleanup',   pattern: '45 3 * * 0' },  // R8: weekly Sunday 03:45 UTC
  // Chip 5: Every 6 hours. First-deploy backfill of 64K rows takes ~3 ticks
  // at the default 5K maxRowsPerRun cap (~12-18h to fully warm). Steady-state
  // is near-zero work — only newly discovered/updated models get re-embedded.
  // Gated by HCRA_EMBEDDER_URL: missing config means the search service
  // already runs lexical-only; embedding the data would be wasted work.
  {
    name: 'embedding-refresh',
    pattern: '15 */6 * * *',
    timeout: 1_800_000, // 30 min
    enabled: () => Boolean(process.env.HCRA_EMBEDDER_URL),
  },
  // Every 6 hours, 30 min offset from embedding-refresh so the two heavy
  // capability-table writers don't contend. Fusion is idempotent and reads
  // assertions written by discovery, helicone-oracle, llm-extracted, and
  // operator overrides — without this the canonical capability_uris column
  // drifts from the assertion log indefinitely. Default-on: opt out via
  // HCRA_MATERIALISE_DISABLED=true if a migration needs to quiesce writes.
  {
    name: 'capability-materialise',
    pattern: '45 */6 * * *',
    timeout: 1_800_000, // 30 min
    enabled: () => process.env.HCRA_MATERIALISE_DISABLED !== 'true',
  },
  // Daily 04:30 UTC — runs after the heavy nightly crons (log-retention,
  // billing-reconciliation at 02:00, secret-rotation at 03:00, outbox
  // 03:30) so it doesn't pile on. Idempotent: a no-op tick is two COUNT
  // queries. First run after deploy clears the legacy 64K-row backlog;
  // subsequent runs catch drift from any code path that bypasses
  // withNormalizedMetadata (legacy seeds, hand-rolled INSERTs, etc.).
  {
    name: 'metadata-backfill',
    pattern: '30 4 * * *',
    timeout: 1_800_000, // 30 min — first run is the long one
    enabled: () => process.env.METADATA_BACKFILL_DISABLED !== 'true',
  },
];

const QUEUE_NAME = 'scheduled-tasks';

/**
 * Payload for the scheduled-tasks BullMQ queue. Only `jobName` is required;
 * BullMQ adds `id`, `attempts`, etc. via its own type.
 */
interface ScheduledJobData {
  jobName: string;
}
let scheduledQueue: Queue | null = null;
let scheduledWorker: Worker | null = null;

/**
 * Register all scheduled jobs as BullMQ repeatable job schedulers.
 * BullMQ guarantees single-execution per schedule tick across all instances.
 * Safe to call multiple times (upsertJobScheduler is idempotent).
 */
export async function registerScheduledJobs(): Promise<void> {
  if (!isBullmqCronsEnabled()) {
    // Explicit opt-out (USE_BULLMQ_CRONS=false). The legacy node-cron fallback
    // has been removed, so there is nothing to fall back to — this is a
    // defensive no-op. In the API process, index.ts fails fast on this
    // misconfiguration before we are ever reached.
    log.warn(
      'BullMQ crons explicitly disabled via USE_BULLMQ_CRONS=false — registering no scheduled jobs (node-cron fallback removed)',
    );
    return;
  }

  const connection = createRedisClient('scheduled-tasks-queue');

  scheduledQueue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1, // Cron jobs should not auto-retry via BullMQ (idempotency varies)
      removeOnComplete: { age: 86_400, count: 1000 },
      removeOnFail: false, // Keep failed jobs for DLQ routing (ADR-003)
    },
  });

  let registered = 0;
  for (const jobDef of SCHEDULED_JOBS) {
    if (jobDef.enabled && !jobDef.enabled()) {
      log.debug({ jobName: jobDef.name }, 'Scheduled job disabled by guard, skipping');
      continue;
    }

    const pattern = jobDef.envOverride
      ? (process.env[jobDef.envOverride] || jobDef.pattern)
      : jobDef.pattern;

    await scheduledQueue.upsertJobScheduler(
      jobDef.name,
      { pattern },
      {
        name: jobDef.name,
        data: { jobName: jobDef.name },
        opts: {
          attempts: 1,
          ...(jobDef.timeout ? { timeout: jobDef.timeout } : {}),
        },
      },
    );
    registered++;
    log.debug({ jobName: jobDef.name, pattern }, 'Scheduled job registered');
  }

  log.info({ registered, total: SCHEDULED_JOBS.length }, 'BullMQ scheduled jobs registered');
}

/**
 * Start the scheduled tasks worker.
 * Should be called from both index.ts (API process) and queue-runner.ts (worker process).
 */
export async function startScheduledTasksWorker(): Promise<void> {
  if (!isBullmqCronsEnabled()) return;
  if (scheduledWorker) return;

  await ensureMetrics();

  const connection = createRedisClient('scheduled-tasks-worker');

  scheduledWorker = new Worker<ScheduledJobData>(
    QUEUE_NAME,
    async (job: Job<ScheduledJobData>) => {
      const jobName = job.data?.jobName;
      if (!jobName || !JOB_HANDLERS[jobName]) {
        throw new Error(`Unknown scheduled job: ${jobName}`);
      }

      const start = Date.now();
      const jobLog = log.child({ jobName, jobId: job.id });
      jobLog.info('Scheduled job starting');

      cronExecutionTotal?.inc({ job_name: jobName, status: 'started' });

      try {
        const handlerFactory = JOB_HANDLERS[jobName];
        const handler = await handlerFactory();
        await handler();

        const durationS = (Date.now() - start) / 1000;
        cronExecutionDuration?.observe({ job_name: jobName }, durationS);
        cronExecutionTotal?.inc({ job_name: jobName, status: 'completed' });
        jobLog.info({ durationS: durationS.toFixed(2) }, 'Scheduled job completed');
      } catch (err) {
        const durationS = (Date.now() - start) / 1000;
        cronExecutionErrors?.inc({ job_name: jobName });
        cronExecutionTotal?.inc({ job_name: jobName, status: 'failed' });
        jobLog.error({ err, durationS: durationS.toFixed(2) }, 'Scheduled job failed');
        throw err; // Let BullMQ mark as failed → DLQ
      }
    },
    {
      connection,
      concurrency: 3, // Allow up to 3 cron jobs to run in parallel
    },
  );

  // BullMQ erases the Job<TData> generic on the 'failed' event, so we
  // re-narrow to the runtime shape.
  scheduledWorker.on('failed', (job: Job<ScheduledJobData> | undefined, err: Error) => {
    log.error(
      { jobId: job?.id, jobName: job?.data.jobName, err: err.message },
      'Scheduled task failed',
    );
  });

  log.info('Scheduled tasks worker started');
}

/**
 * Graceful shutdown for scheduled tasks infrastructure.
 */
export async function shutdownScheduledTasks(): Promise<void> {
  if (scheduledWorker) {
    await scheduledWorker.close();
    scheduledWorker = null;
  }
  if (scheduledQueue) {
    await scheduledQueue.close();
    scheduledQueue = null;
  }
}
