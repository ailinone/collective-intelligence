// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * API Key Maintenance Jobs (v5.0)
 *
 * Scheduled jobs for API key rotation maintenance:
 * - Hourly: Revoke expired rotating keys (after grace period)
 * - Daily: Check and trigger auto-rotation for keys
 *
 * Uses node-cron for scheduling
 */

import * as cron from 'node-cron';
import { ApiKeyRotationService } from '../services/api-key-rotation.js';
import { logger } from '../utils/logger.js';
import { getErrorMessage, isError } from '../utils/type-guards.js';

// ============================================
// Job Configurations
// ============================================

const JOBS_ENABLED = process.env.API_KEY_JOBS_ENABLED !== 'false'; // Default: enabled

const SCHEDULES = {
  // Every hour at minute 0
  REVOKE_EXPIRED: '0 * * * *',

  // Every day at 2:00 AM (low traffic time)
  AUTO_ROTATION: '0 2 * * *',

  // Every 5 minutes (for testing, disabled in production)
  TEST_FREQUENT: '*/5 * * * *',
};

// ============================================
// Job: Revoke Expired Keys
// ============================================

/**
 * Revoke API keys that have exceeded their grace period
 * Runs hourly
 */
let revokeExpiredKeysJob: cron.ScheduledTask;

// Initialize but don't start yet
function initRevokeExpiredKeysJob(): cron.ScheduledTask {
  return cron.schedule(SCHEDULES.REVOKE_EXPIRED, async () => {
    const jobStart = Date.now();

    try {
      logger.info('Starting expired keys revocation job...');

      const revokedCount = await ApiKeyRotationService.revokeExpiredKeys();

      const duration = Date.now() - jobStart;

      logger.info(
        {
          revokedCount,
          durationMs: duration,
          job: 'revoke-expired-keys',
        },
        `Expired keys revocation job completed (${revokedCount} keys revoked)`
      );

      // Send metrics to Prometheus (v5.0)
      const { apiKeyJobDuration, apiKeyRevokedTotal } = await import('../utils/metrics.js');
      apiKeyJobDuration.observe({ job: 'revoke-expired' }, duration / 1000); // Convert to seconds
      apiKeyRevokedTotal.inc({ reason: 'expired' }, revokedCount);
    } catch (error) {
      const duration = Date.now() - jobStart;
      logger.error(
        {
          error,
          job: 'revoke-expired-keys',
          durationMs: duration,
        },
        'Failed to revoke expired keys'
      );

      // Send error metrics and alert (v5.0)
      const { apiKeyJobErrors } = await import('../utils/metrics.js');
      apiKeyJobErrors.inc({
        job: 'revoke-expired',
        error_type: (isError(error) ? error.name : 'unknown'),
      });

      // Log alert-level event (monitored by external systems)
      logger.fatal(
        {
          alert: 'api_key_job_failure',
          job: 'revoke-expired-keys',
          error: getErrorMessage(error),
          durationMs: duration,
        },
        '🚨 ALERT: API Key revocation job failed'
      );
    }
  });
}

// ============================================
// Job: Auto-Rotation Check
// ============================================

/**
 * Check and trigger auto-rotation for keys that need it
 * Runs daily at 2:00 AM UTC
 */
let autoRotationJob: cron.ScheduledTask;

// Initialize but don't start yet
function initAutoRotationJob(): cron.ScheduledTask {
  return cron.schedule(SCHEDULES.AUTO_ROTATION, async () => {
    const jobStart = Date.now();

    try {
      logger.info('Starting auto-rotation check job...');

      const rotatedCount = await ApiKeyRotationService.checkAutoRotation();

      const duration = Date.now() - jobStart;

      logger.info(
        {
          rotatedCount,
          durationMs: duration,
          job: 'auto-rotation',
        },
        `Auto-rotation job completed (${rotatedCount} keys rotated)`
      );

      // Send metrics to Prometheus (v5.0)
      const { apiKeyJobDuration, apiKeyRotatedTotal } = await import('../utils/metrics.js');
      apiKeyJobDuration.observe({ job: 'auto-rotation' }, duration / 1000); // Convert to seconds
      apiKeyRotatedTotal.inc({ reason: 'auto-rotation' }, rotatedCount);
    } catch (error) {
      const duration = Date.now() - jobStart;
      logger.error(
        {
          error,
          job: 'auto-rotation',
          durationMs: duration,
        },
        'Failed to check auto-rotation'
      );

      // Send error metrics and alert (v5.0)
      const { apiKeyJobErrors } = await import('../utils/metrics.js');
      apiKeyJobErrors.inc({
        job: 'auto-rotation',
        error_type: (isError(error) ? error.name : 'unknown'),
      });

      // Log alert-level event (monitored by external systems)
      logger.fatal(
        {
          alert: 'api_key_job_failure',
          job: 'auto-rotation',
          error: getErrorMessage(error),
          durationMs: duration,
        },
        '🚨 ALERT: API Key auto-rotation job failed'
      );
    }
  });
}

// ============================================
// Job Management
// ============================================

/**
 * Start all API key maintenance jobs
 */
export function startApiKeyJobs(): void {
  if (!JOBS_ENABLED) {
    logger.warn('API key maintenance jobs are DISABLED (API_KEY_JOBS_ENABLED=false)');
    return;
  }

  logger.info('Starting API key maintenance jobs...');

  // Initialize jobs (they start automatically)
  revokeExpiredKeysJob = initRevokeExpiredKeysJob();
  autoRotationJob = initAutoRotationJob();

  logger.info(
    {
      jobs: [
        { name: 'revoke-expired-keys', schedule: SCHEDULES.REVOKE_EXPIRED },
        { name: 'auto-rotation', schedule: SCHEDULES.AUTO_ROTATION },
      ],
    },
    '✅ API key maintenance jobs started'
  );
}

/**
 * Stop all API key maintenance jobs
 * Called during graceful shutdown
 */
export function stopApiKeyJobs(): void {
  logger.info('Stopping API key maintenance jobs...');

  if (revokeExpiredKeysJob) revokeExpiredKeysJob.stop();
  if (autoRotationJob) autoRotationJob.stop();

  logger.info('✅ API key maintenance jobs stopped');
}

/**
 * Get status of all jobs
 */
export function getJobsStatus(): {
  enabled: boolean;
  jobs: Array<{
    name: string;
    schedule: string;
    running: boolean;
  }>;
} {
  return {
    enabled: JOBS_ENABLED,
    jobs: [
      {
        name: 'revoke-expired-keys',
        schedule: SCHEDULES.REVOKE_EXPIRED,
        running: !!revokeExpiredKeysJob,
      },
      {
        name: 'auto-rotation',
        schedule: SCHEDULES.AUTO_ROTATION,
        running: !!autoRotationJob,
      },
    ],
  };
}

// ============================================
// Manual Triggers (for testing/admin)
// ============================================

/**
 * Manually trigger expired keys revocation
 * Useful for testing or immediate cleanup
 */
export async function manualRevokeExpired(): Promise<number> {
  logger.info('Manual trigger: revoke expired keys');
  return await ApiKeyRotationService.revokeExpiredKeys();
}

/**
 * Manually trigger auto-rotation check
 * Useful for testing or immediate rotation
 */
export async function manualAutoRotation(): Promise<number> {
  logger.info('Manual trigger: auto-rotation check');
  return await ApiKeyRotationService.checkAutoRotation();
}

// ============================================
// Exports
// ============================================

// Named exports only (no default export to avoid initialization issues)
