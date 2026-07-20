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
import { getSecretsManager } from '@/config/secrets-manager';
import { Prisma, prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import crypto from 'crypto';

let rotationTask: ScheduledTask | null = null;

function isRotationDue(lastRotatedAt: Date | null | undefined, intervalDays: number): boolean {
  if (!lastRotatedAt) {
    return true;
  }
  const nextRotation = new Date(lastRotatedAt.getTime() + intervalDays * 24 * 60 * 60 * 1000);
  return nextRotation <= new Date();
}

export function startSecretRotationJob(): void {
  if (config.secrets.rotation.managedKeys.length === 0) {
    return;
  }
  if (rotationTask) {
    return;
  }

  rotationTask = schedule(config.secrets.rotation.cron || '0 3 * * *', async () => {
    try {
      const manager = getSecretsManager();

      const providers = manager.getProviders();

      for (const entry of config.secrets.rotation.managedKeys) {
        const existing = await prisma.managedSecret.findUnique({
          where: { secretKey: entry.key },
        });
        const providerId =
          entry.providerId || existing?.providerId || providers[0]?.id || 'unknown';

        const record = existing
          ? await prisma.managedSecret.update({
              where: { secretKey: entry.key },
              data: {
                providerId,
                length: entry.length,
                intervalDays: entry.intervalDays,
              },
            })
          : await prisma.managedSecret.create({
              data: {
                secretKey: entry.key,
                providerId,
                length: entry.length,
                intervalDays: entry.intervalDays,
              },
            });

        if (!isRotationDue(record.lastRotatedAt, entry.intervalDays)) {
          continue;
        }

        try {
          const newValue = await manager.rotateSecret(entry.key, entry.length, providerId);
          const hashed = crypto.createHash('sha256').update(newValue).digest('hex');
          const currentMetadata =
            record.metadata &&
            typeof record.metadata === 'object' &&
            !Array.isArray(record.metadata)
              ? (record.metadata as Record<string, unknown>)
              : {};

          await prisma.managedSecret.update({
            where: { secretKey: entry.key },
            data: {
              lastRotatedAt: new Date(),
              metadata: {
                ...currentMetadata,
                lastHash: hashed,
              } as Prisma.JsonObject,
            },
          });

          logger.info(
            {
              secretKey: entry.key,
              providerId: entry.providerId,
              length: entry.length,
            },
            'Secret rotated successfully'
          );
        } catch (error) {
          logger.error({ secretKey: entry.key, error }, 'Secret rotation failed');
        }
      }
    } catch (error) {
      logger.error({ error }, 'Secret rotation job failed');
    }
  });

  logger.info(
    { cron: config.secrets.rotation.cron, keys: config.secrets.rotation.managedKeys.length },
    'Secret rotation job scheduled'
  );
}

export async function stopSecretRotationJob(): Promise<void> {
  if (rotationTask) {
    rotationTask.stop();
    rotationTask = null;
    logger.info('Secret rotation job stopped');
  }
}
