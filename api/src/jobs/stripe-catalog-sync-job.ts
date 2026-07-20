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
import { syncStripeCatalog } from '@/services/billing-plan-service';
import { logger } from '@/utils/logger';

const log = logger.child({ job: 'stripe-catalog-sync' });

let task: ScheduledTask | null = null;

export function startStripeCatalogSyncJob(): void {
  if (!config.payments.stripe.enabled) {
    return;
  }
  if (task) {
    return;
  }

  const cronExpression = process.env.STRIPE_CATALOG_SYNC_CRON || '15 * * * *'; // hourly at minute 15

  task = schedule(cronExpression, async () => {
    try {
      await syncStripeCatalog();
    } catch (error) {
      log.error({ error }, 'Stripe catalog sync job failed');
    }
  });

  log.info({ cron: cronExpression }, 'Stripe catalog sync job scheduled');
}

export function stopStripeCatalogSyncJob(): void {
  if (task) {
    task.stop();
    task = null;
    log.info('Stripe catalog sync job stopped');
  }
}
