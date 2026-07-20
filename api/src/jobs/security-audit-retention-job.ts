// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { schedule, type ScheduledTask } from 'node-cron';
import { config } from '@/config';
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

let retentionTask: ScheduledTask | null = null;

export function startSecurityAuditRetentionJob(): void {
  if (!config.security.audit.enabled) {
    return;
  }
  if (retentionTask) {
    return;
  }

  const cronExpression = process.env.SECURITY_AUDIT_RETENTION_CRON || '0 4 * * *';

  retentionTask = schedule(cronExpression, async () => {
    const cutoff = new Date(Date.now() - config.security.audit.retentionDays * 24 * 60 * 60 * 1000);
    try {
      const deleted = await prisma.securityAuditLog.deleteMany({
        where: {
          createdAt: {
            lt: cutoff,
          },
        },
      });
      if (deleted.count > 0) {
        logger.info(
          { deleted: deleted.count, cutoff },
          'Security audit retention job removed old records'
        );
      }
    } catch (error) {
      logger.error({ error }, 'Security audit retention job failed');
    }
  });

  logger.info(
    { cron: cronExpression, retentionDays: config.security.audit.retentionDays },
    'Security audit retention job scheduled'
  );
}

export function stopSecurityAuditRetentionJob(): void {
  if (retentionTask) {
    retentionTask.stop();
    retentionTask = null;
    logger.info('Security audit retention job stopped');
  }
}
