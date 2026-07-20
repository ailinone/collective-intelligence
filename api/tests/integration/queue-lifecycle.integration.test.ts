// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Request Queue Lifecycle Integration Tests
 * Uses REAL models from dynamic discovery - NO hardcoded models
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { startTestEnvironment, stopTestEnvironment } from '../utils/test-environment';
import { getTestModelId, ensureModelsDiscovered } from '../utils/dynamic-model-discovery';

describe('Request Queue Lifecycle Integration - Real Tests (NO Hardcoded Models)', () => {
  let requestQueueService: typeof import('@/services/request-queue-service').requestQueueService;
  let queueResultService: typeof import('@/services/request-queue-result-service').queueResultService;
  let redisClient: Redis;

  beforeAll(async () => {
    await startTestEnvironment();
    await ensureModelsDiscovered();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  const waitForRecord = async (jobId: string, timeoutMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const record = await queueResultService.get(jobId);
      if (record) {
        return record;
      }
      await delay(100);
    }
    throw new Error(`Timed out waiting for queue record ${jobId}`);
  };

  const waitForStatus = async (
    jobId: string,
    expectedStatus: 'queued' | 'processing' | 'completed' | 'failed',
    timeoutMs = 10000
  ) => {
    const start = Date.now();
    let lastRecord: Awaited<ReturnType<typeof queueResultService.get>> | null = null;

    while (Date.now() - start < timeoutMs) {
      const record = await queueResultService.get(jobId);
      lastRecord = record;
      if (record?.status === expectedStatus) {
        return record;
      }
      await delay(100);
    }

    let bullState: string | undefined;
    try {
      // Access internal queue property for testing
      type QueueWithGetJob = { queue?: { getJob(id: string): Promise<Job<unknown> | undefined> } };
      const queueRef = (requestQueueService as QueueWithGetJob).queue;
      const job = await queueRef?.getJob(jobId);
      bullState = await job?.getState();
    } catch (error) {
      bullState = `error:${error instanceof Error ? error.message : String(error)}`;
    }

    throw new Error(
      `Timed out waiting for status "${expectedStatus}" on job ${jobId} (lastRecord=${
        lastRecord ? JSON.stringify(lastRecord) : 'null'
      }, bullState=${bullState ?? 'unknown'})`
    );
  };

  beforeAll(async () => {
    process.env.TEST_USE_LOCAL_SERVICES = 'true';
    process.env.QUEUE_ENABLED = 'true';
    process.env.QUEUE_NAME = 'integration-chat-jobs';
    process.env.QUEUE_WORKER_COUNT = '1';
    process.env.QUEUE_WORKER_CONCURRENCY = '2';
    process.env.QUEUE_MAX_ATTEMPTS = '1';
    process.env.QUEUE_BACKOFF_STRATEGY = 'fixed';
    process.env.QUEUE_BACKOFF_INITIAL_DELAY_MS = '100';
    process.env.QUEUE_PRIORITY_ENTERPRISE = '10';
    process.env.QUEUE_PRIORITY_PRO = '3000';
    process.env.QUEUE_PRIORITY_FREE = '9000';
    process.env.QUEUE_PRIORITY_JITTER = '0';
    process.env.QUEUE_STATUS_TTL_SECONDS = '300';
    process.env.QUEUE_RESULT_TTL_SECONDS = '900';
    process.env.QUEUE_RUN_WORKERS_IN_API = 'false';
    process.env.REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
    process.env.REDIS_PORT = process.env.REDIS_PORT || '6379';

    vi.resetModules();

    await startTestEnvironment();

    const [{ config: appConfig }, { initializeQueueRuntime }] = await Promise.all([
      import('@/config'),
      import('@/queue/queue-runtime-state'),
    ]);

    initializeQueueRuntime({
      ...appConfig.queue,
      enabled: true,
      runWorkersInApiProcess: false,
    });

    ({ requestQueueService } = await import('@/services/request-queue-service'));
    ({ queueResultService } = await import('@/services/request-queue-result-service'));
    const { getRedisClient } = await import('@/cache/redis-client');
    redisClient = getRedisClient();
  }, 60000);

  afterAll(async () => {
    if (requestQueueService) {
      await requestQueueService.stopWorkers();
    }
    await stopTestEnvironment();
  });

  it('enqueues, processes, and persists queue job lifecycle with Redis TTL', async () => {
    await requestQueueService.startWorkers(async (job) => {
      expect(job.data.organizationId).toBe('org-enterprise');
      return { ok: true, requestId: job.data.requestId };
    });

    const jobId = `job-queue-integration-${randomUUID()}`;

    // Get a real model from dynamic discovery - NO hardcoded models
    const testModelId = await getTestModelId();
    if (!testModelId) {
      return; // Skip if no models available
    }

    const enqueueResponse = await requestQueueService.enqueue(
      jobId,
      'org-enterprise',
      'user-xyz',
      {
        model: testModelId, // Use dynamically discovered model
        messages: [{ role: 'user', content: 'queue integration test' }],
      } as ChatRequest,
      {
        models: [],
        budget: 0.5,
      } as OrchestrationContext,
      'enterprise'
    );

    expect(enqueueResponse.status).toBe('queued');
    expect(enqueueResponse.queueId).toBe(jobId);

    const initialRecord = await waitForRecord(jobId);
    expect(initialRecord?.metadata.organizationId).toBe('org-enterprise');
    expect(initialRecord?.metadata.priority).toBeLessThan(1000);

    const { requestQueueService: queueServiceForHealth } = await import('@/services/request-queue-service');
    const queueHealth = await queueServiceForHealth.healthCheck();
    // eslint-disable-next-line no-console
    console.log('Queue health snapshot before awaiting completion:', queueHealth);

    const { queueResultService: queuedResultReader } = await import('@/services/request-queue-result-service');
    const currentRecord = await queuedResultReader.get(jobId);
    // eslint-disable-next-line no-console
    console.log('Queue record snapshot before awaiting completion:', currentRecord);

    const completedRecord = await waitForStatus(jobId, 'completed');
    expect(completedRecord.result).toEqual({ ok: true, requestId: jobId });
    expect(completedRecord.metadata.finishedAt).toBeGreaterThan(completedRecord.metadata.enqueueTimestamp);

    const ttl = await redisClient.ttl(`queue:job:${jobId}`);
    expect(ttl).toBeGreaterThan(0);

    await queueResultService.delete(jobId);
  });
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));


