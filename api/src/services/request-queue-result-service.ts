// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { getRedisClient } from '@/cache/redis-client';
import { config } from '@/config';
import { logger } from '@/utils/logger';

type QueueStatus = 'queued' | 'processing' | 'completed' | 'failed';

interface QueueMetadata {
  organizationId: string;
  userId?: string;
  enqueueTimestamp: number;
  startedAt?: number;
  finishedAt?: number;
  priority: number;
  tier: 'enterprise' | 'pro' | 'free';
  queueTimeMs?: number;
  error?: {
    message: string;
    name: string;
    stack?: string;
  };
}

interface QueueRecord {
  status: QueueStatus;
  metadata: QueueMetadata;
  result?: unknown;
}

const log = logger.child({ component: 'queue-result-service' });
const KEY_PREFIX = 'queue:job:';

function getKey(jobId: string): string {
  return `${KEY_PREFIX}${jobId}`;
}

async function writeRecord(
  jobId: string,
  record: QueueRecord,
  ttlSeconds = config.queue.statusTtlSeconds
): Promise<void> {
  const client = getRedisClient();
  const key = getKey(jobId);
  const payload = JSON.stringify(record);

  await client.set(key, payload, 'EX', ttlSeconds);

  log.debug({ jobId, status: record.status }, 'Queue record persisted');
}

export const queueResultService = {
  async setQueued(
    jobId: string,
    metadata: Omit<QueueMetadata, 'startedAt' | 'finishedAt' | 'queueTimeMs' | 'error'>
  ): Promise<void> {
    await writeRecord(jobId, {
      status: 'queued',
      metadata,
    });
  },

  async setProcessing(jobId: string): Promise<void> {
    const record = await this.get(jobId);
    const metadata: QueueMetadata = {
      ...(record?.metadata ?? ({} as QueueMetadata)),
      startedAt: Date.now(),
    };

    await writeRecord(jobId, {
      status: 'processing',
      metadata,
    });
  },

  async setCompleted(jobId: string, result: unknown, queueTimeMs?: number): Promise<void> {
    const record = await this.get(jobId);
    const metadata: QueueMetadata = {
      ...(record?.metadata ?? ({} as QueueMetadata)),
      queueTimeMs,
      finishedAt: Date.now(),
    };

    await writeRecord(
      jobId,
      {
        status: 'completed',
        metadata,
        result,
      },
      config.queue.resultTtlSeconds
    );
  },

  async setFailed(jobId: string, error: Error): Promise<void> {
    const record = await this.get(jobId);
    const metadata: QueueMetadata = {
      ...(record?.metadata ?? ({} as QueueMetadata)),
      finishedAt: Date.now(),
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack,
      },
    };

    await writeRecord(
      jobId,
      {
        status: 'failed',
        metadata,
      },
      config.queue.resultTtlSeconds
    );
  },

  async get(jobId: string): Promise<QueueRecord | null> {
    const client = getRedisClient();
    const raw = await client.get(getKey(jobId));
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as QueueRecord;
    } catch (error) {
      log.error({ error, jobId }, 'Failed to parse queue record');
      return null;
    }
  },

  async delete(jobId: string): Promise<void> {
    const client = getRedisClient();
    await client.del(getKey(jobId));
  },
};
