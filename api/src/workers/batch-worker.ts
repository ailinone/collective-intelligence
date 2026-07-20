// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Batch Worker
 * Processes batch jobs asynchronously via BullMQ
 * 
 * REAL IMPLEMENTATION - No mocks, no stubs
 * 
 * Features:
 * - Parses JSONL input files
 * - Processes each request via OrchestrationEngine
 * - Updates batch status in real-time
 * - Generates output/error JSONL files
 * - Handles cancellation and errors gracefully
 */

import type { Job } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { FilesService } from '@/services/files-service';
import { getOrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import { processChatRequest } from '@/services/chat-request-processor';
import { createRedisClient, releaseRedisClient } from '@/cache/redis-client';
import { config } from '@/config';
import type { ChatRequest, ChatResponse } from '@/types';
import { serializeError } from '@/utils/type-guards';
import type { OrchestrationContext } from '@/types';

const log = logger.child({ component: 'batch-worker' });

interface BatchJobData {
  batchId: string;
  inputFileId: string;
  endpoint: string;
  organizationId: string;
  userId: string;
  requestCount: number;
  correlationId?: string; // G8 fix: propagated for end-to-end tracing
}

interface BatchRequestLine {
  custom_id?: string;
  method: string;
  url: string;
  body: ChatRequest;
}

let batchQueue: Queue<BatchJobData> | null = null;
let batchWorker: Worker<BatchJobData> | null = null;

/**
 * Initialize batch queue
 */
export function initializeBatchQueue(): Queue<BatchJobData> {
  if (batchQueue) {
    return batchQueue;
  }

  const connection = createRedisClient('batch-queue');
  batchQueue = new Queue<BatchJobData>('batch-processing', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: {
        age: 86400, // Keep completed jobs for 24 hours
        count: 1000,
      },
      removeOnFail: {
        age: 604800, // Keep failed jobs for 7 days
      },
    },
  });

  log.info('Batch queue initialized');

  // C3 fix: DLQ routing (ADR-003)
  import('@/queue/dlq-manager.js')
    .then(({ setupDLQ }) => setupDLQ(batchQueue!))
    .catch((err) => log.warn({ err: serializeError(err) }, 'Failed to setup DLQ for batch-processing queue'));

  return batchQueue;
}

/**
 * Setup batch worker
 */
export async function setupBatchWorker(): Promise<void> {
  if (batchWorker) {
    log.warn('Batch worker already initialized');
    return;
  }

  const orchestrationEngine = getOrchestrationEngine();
  if (!orchestrationEngine) {
    throw new Error('OrchestrationEngine not initialized');
  }

  const connection = createRedisClient('batch-worker');
  const filesService = new FilesService();

  batchWorker = new Worker<BatchJobData>(
    'batch-processing',
    async (job: Job<BatchJobData>) => {
      const { batchId, inputFileId, organizationId, userId, requestCount, correlationId } = job.data;
      const jobLog = log.child({ jobId: job.id, batchId, requestCount, correlationId });

      jobLog.info('Starting batch processing');

      try {
        // Step 1: Update batch status to 'in_progress'
        await prisma.batch.update({
          where: { id: batchId },
          data: {
            status: 'in_progress',
            inProgressAt: new Date(),
          },
        });

        // Step 2: Read input file
        jobLog.info({ inputFileId }, 'Reading input file');
        const _inputFile = await filesService.getFile({
          fileId: inputFileId,
          userContext: { organizationId, userId } as OrchestrationContext,
          requestId: `batch-${batchId}`,
        });

        // Download file content from GCS
        const fileContentResult = await filesService.getFileContent({
          fileId: inputFileId,
          userContext: { organizationId, userId } as OrchestrationContext,
          requestId: `batch-${batchId}`,
        });
        const fileContent = fileContentResult.content;

        // Step 3: Parse JSONL
        const lines = fileContent.toString('utf-8').split('\n').filter(line => line.trim());
        const requests: BatchRequestLine[] = [];

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as BatchRequestLine;
            if (parsed.body && parsed.method && parsed.url) {
              requests.push(parsed);
            } else {
              jobLog.warn({ line }, 'Invalid request line in JSONL');
            }
          } catch (error) {
            jobLog.warn({ line, error }, 'Failed to parse JSONL line');
          }
        }

        jobLog.info({ requestCount: requests.length }, 'Parsed JSONL file');

        // The authoritative request count is established HERE (createBatch no
        // longer downloads/parses the file just to count lines — that doubled
        // the GCS download and blocked the HTTP response on file size).
        await prisma.batch.update({
          where: { id: batchId },
          data: { requestCountsTotal: requests.length },
        });

        // Step 4: Process each request
        const outputLines: Array<{ custom_id?: string; response: ChatResponse }> = [];
        const errorLines: Array<{ custom_id?: string; error: { message: string; code?: string } }> = [];
        let completed = 0;
        let failed = 0;

        for (const requestLine of requests) {
          // Check if batch was cancelled
          const batch = await prisma.batch.findUnique({ where: { id: batchId } });
          if (!batch || batch.status === 'cancelling' || batch.status === 'cancelled') {
            jobLog.info('Batch cancelled, stopping processing');
            await prisma.batch.update({
              where: { id: batchId },
              data: {
                status: 'cancelled',
                cancelledAt: new Date(),
              },
            });
            return;
          }

          try {
            // Process request via OrchestrationEngine
            const chatRequest: ChatRequest = requestLine.body;
            const { response } = await processChatRequest({
              chatRequest,
              orchestrationEngine,
              organizationId,
              userId,
              requestId: `batch-${batchId}-${requestLine.custom_id || completed}`,
              log: jobLog,
            });

            outputLines.push({
              custom_id: requestLine.custom_id,
              response,
            });

            completed++;
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            jobLog.warn({ custom_id: requestLine.custom_id, error: errorMessage }, 'Request failed');

            errorLines.push({
              custom_id: requestLine.custom_id,
              error: {
                message: errorMessage,
                code: 'processing_error',
              },
            });

            failed++;
          }

          // Update batch progress every 10 requests
          if ((completed + failed) % 10 === 0) {
            await prisma.batch.update({
              where: { id: batchId },
              data: {
                requestCountsCompleted: completed,
                requestCountsFailed: failed,
              },
            });
          }
        }

        jobLog.info({ completed, failed }, 'Finished processing all requests');

        // Step 5: Generate output file
        let outputFileId: string | null = null;
        if (outputLines.length > 0) {
          const outputContent = outputLines.map(line => JSON.stringify(line)).join('\n') + '\n';
          const outputBuffer = Buffer.from(outputContent, 'utf-8');

          // Upload output file to GCS
          const outputFile = await filesService.uploadFile({
            fileBuffer: outputBuffer,
            filename: `batch-${batchId}-output.jsonl`,
            purpose: 'batch_output',
            userContext: { organizationId, userId } as OrchestrationContext,
            requestId: `batch-${batchId}`,
          });

          outputFileId = outputFile.id;
          jobLog.info({ outputFileId }, 'Output file created');
        }

        // Step 6: Generate error file (if any errors)
        let errorFileId: string | null = null;
        if (errorLines.length > 0) {
          const errorContent = errorLines.map(line => JSON.stringify(line)).join('\n') + '\n';
          const errorBuffer = Buffer.from(errorContent, 'utf-8');

          // Upload error file to GCS
          const errorFile = await filesService.uploadFile({
            fileBuffer: errorBuffer,
            filename: `batch-${batchId}-errors.jsonl`,
            purpose: 'batch_error',
            userContext: { organizationId, userId } as OrchestrationContext,
            requestId: `batch-${batchId}`,
          });

          errorFileId = errorFile.id;
          jobLog.info({ errorFileId }, 'Error file created');
        }

        // Step 7: Update batch status to 'completed'
        await prisma.batch.update({
          where: { id: batchId },
          data: {
            status: 'completed',
            completedAt: new Date(),
            outputFileId: outputFileId || null,
            errorFileId: errorFileId || null,
            requestCountsCompleted: completed,
            requestCountsFailed: failed,
          },
        });

        jobLog.info({ completed, failed, outputFileId, errorFileId }, 'Batch processing completed');
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        jobLog.error({ error: errorMessage }, 'Batch processing failed');

        // Update batch status to 'failed'
        await prisma.batch.update({
          where: { id: batchId },
          data: {
            status: 'failed',
            failedAt: new Date(),
          },
        });

        throw error;
      }
    },
    {
      connection,
      concurrency: config.queue.workerConcurrency || 1, // Process one batch at a time
      limiter: {
        max: 1,
        duration: 1000,
      },
    }
  );

  batchWorker.on('completed', (job) => {
    log.info({ jobId: job.id, batchId: job.data.batchId }, 'Batch job completed');
  });

  batchWorker.on('failed', (job, error) => {
    log.error(
      { jobId: job?.id, batchId: job?.data.batchId, error },
      'Batch job failed'
    );
  });

  log.info('Batch worker started');
}

/**
 * Enqueue batch job
 */
export async function enqueueBatchJob(data: BatchJobData): Promise<string> {
  const queue = initializeBatchQueue();
  const job = await queue.add('process-batch', data, {
    jobId: `batch-${data.batchId}`,
    priority: 1,
  });

  log.info({ jobId: job.id, batchId: data.batchId }, 'Batch job enqueued');
  return job.id!;
}

/**
 * Stop batch worker
 */
export async function stopBatchWorker(): Promise<void> {
  if (batchWorker) {
    await batchWorker.close();
    batchWorker = null;
    log.info('Batch worker stopped');
  }

  if (batchQueue) {
    await batchQueue.close();
    const connection = createRedisClient('batch-queue');
    await releaseRedisClient(connection);
    batchQueue = null;
    log.info('Batch queue closed');
  }
}

