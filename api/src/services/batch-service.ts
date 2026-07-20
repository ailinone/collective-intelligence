// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Batch Service
 * Manages async batch processing of API requests
 * 
 * Features:
 * - JSONL input/output format (OpenAI-compatible)
 * - Job queue integration (uses existing queue infrastructure)
 * - Status tracking (validating, in_progress, finalizing, completed, failed, cancelled)
 * - Results aggregation
 * - 50% cost discount for batch requests
 * 
 * NO HARDCODED - All processing via existing orchestration engine
 */

import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { nanoid } from 'nanoid';
import type { OrchestrationContext } from '@/types';
import { FilesService } from '@/services/files-service';

const log = logger.child({ service: 'batch' });

// ============================================
// Types
// ============================================

export interface BatchCreateOptions {
  inputFileId: string;
  endpoint: string;
  completionWindow: string;
  metadata?: Record<string, string>;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface BatchCreateResult {
  id: string;
  endpoint: string;
  input_file_id: string;
  completion_window: string;
  status: string;
  output_file_id: string | null;
  error_file_id: string | null;
  created_at: number;
  in_progress_at: number | null;
  expires_at: number;
  finalizing_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  expired_at: number | null;
  cancelling_at: number | null;
  cancelled_at: number | null;
  request_counts: {
    total: number;
    completed: number;
    failed: number;
  };
  metadata: Record<string, string> | null;
}

export interface BatchGetOptions {
  batchId: string;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface BatchListOptions {
  limit: number;
  after?: string;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface BatchListItem {
  id: string;
  object: 'batch';
  endpoint: string;
  status: string;
  created_at: number;
  request_counts: {
    total: number;
    completed: number;
    failed: number;
  };
}

export interface BatchListResult {
  batches: BatchListItem[];
  has_more: boolean;
}

export interface BatchCancelOptions {
  batchId: string;
  userContext: OrchestrationContext;
  requestId: string;
}

export interface BatchCancelResult {
  id: string;
  status: string;
  cancelling_at: number;
}

// ============================================
// Batch Service
// ============================================

export class BatchService {
  private filesService: FilesService;

  constructor() {
    this.filesService = new FilesService();
  }

  /**
   * Create batch job
   * Parses JSONL input file, enqueues requests, returns batch ID
   */
  async createBatch(options: BatchCreateOptions): Promise<BatchCreateResult> {
    const { inputFileId, endpoint, completionWindow, metadata, userContext, requestId } = options;

    const batchId = `batch-${nanoid(24)}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const expiresAt = createdAt + 24 * 3600; // 24 hours from now

    log.info({ requestId, batchId, inputFileId, endpoint }, 'Creating batch job');

    try {
      // Step 1: Validate input file exists and is accessible
      const inputFile = await this.filesService.getFile({
        fileId: inputFileId,
        userContext,
        requestId,
      });

      if (inputFile.purpose !== 'batch') {
        throw new Error(`Input file purpose must be "batch", got "${inputFile.purpose}"`);
      }

      // Step 2: Create batch record. The JSONL is NOT downloaded/parsed here —
      // that doubled the GCS download (the worker re-reads the file anyway) and
      // blocked this HTTP response for the full file size, in the endpoint that
      // exists precisely for large volumes. `request_counts.total` starts at 0
      // (status=validating, the OpenAI-compatible shape) and the worker writes
      // the authoritative count as soon as it parses the file.
      const _batch = await prisma.batch.create({
        data: {
          id: batchId,
          organizationId: userContext.organizationId,
          userId: userContext.userId,
          endpoint,
          inputFileId,
          completionWindow,
          status: 'validating',
          requestCountsTotal: 0,
          requestCountsCompleted: 0,
          requestCountsFailed: 0,
          createdAt: new Date(createdAt * 1000),
          expiresAt: new Date(expiresAt * 1000),
          metadata: metadata || {},
        },
      });

      log.info({ requestId, batchId }, 'Batch record created in database');

      // Step 3: Enqueue batch processing job
      // This will be picked up by the worker and processed asynchronously
      await this.enqueueBatchProcessing(batchId, inputFileId, endpoint, userContext);

      log.info({ requestId, batchId }, 'Batch processing job enqueued');

      return {
        id: batchId,
        endpoint,
        input_file_id: inputFileId,
        completion_window: completionWindow,
        status: 'validating',
        output_file_id: null,
        error_file_id: null,
        created_at: createdAt,
        in_progress_at: null,
        expires_at: expiresAt,
        finalizing_at: null,
        completed_at: null,
        failed_at: null,
        expired_at: null,
        cancelling_at: null,
        cancelled_at: null,
        request_counts: {
          // 0 while status=validating — the worker writes the real total right
          // after parsing; clients poll GET /v1/batches/:id (OpenAI contract).
          total: 0,
          completed: 0,
          failed: 0,
        },
        metadata: metadata || null,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, batchId, error: errorMessage }, 'Batch creation failed');
      throw error;
    }
  }

  /**
   * Get batch status
   */
  async getBatch(options: BatchGetOptions): Promise<BatchCreateResult> {
    const { batchId, userContext, requestId } = options;

    log.info({ requestId, batchId }, 'Getting batch status');

    try {
      const batch = await prisma.batch.findFirst({
        where: {
          id: batchId,
          organizationId: userContext.organizationId,
        },
      });

      if (!batch) {
        throw new Error('Batch not found');
      }

      return {
        id: batch.id,
        endpoint: batch.endpoint,
        input_file_id: batch.inputFileId,
        completion_window: batch.completionWindow,
        status: batch.status,
        output_file_id: batch.outputFileId,
        error_file_id: batch.errorFileId,
        created_at: Math.floor(batch.createdAt.getTime() / 1000),
        in_progress_at: batch.inProgressAt ? Math.floor(batch.inProgressAt.getTime() / 1000) : null,
        expires_at: Math.floor(batch.expiresAt.getTime() / 1000),
        finalizing_at: batch.finalizingAt ? Math.floor(batch.finalizingAt.getTime() / 1000) : null,
        completed_at: batch.completedAt ? Math.floor(batch.completedAt.getTime() / 1000) : null,
        failed_at: batch.failedAt ? Math.floor(batch.failedAt.getTime() / 1000) : null,
        expired_at: batch.expiredAt ? Math.floor(batch.expiredAt.getTime() / 1000) : null,
        cancelling_at: batch.cancellingAt ? Math.floor(batch.cancellingAt.getTime() / 1000) : null,
        cancelled_at: batch.cancelledAt ? Math.floor(batch.cancelledAt.getTime() / 1000) : null,
        request_counts: {
          total: batch.requestCountsTotal,
          completed: batch.requestCountsCompleted,
          failed: batch.requestCountsFailed,
        },
        metadata: (batch.metadata && typeof batch.metadata === 'object' && !Array.isArray(batch.metadata))
          ? batch.metadata as Record<string, string>
          : null,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, batchId, error: errorMessage }, 'Get batch failed');
      throw error;
    }
  }

  /**
   * List batches
   */
  async listBatches(options: BatchListOptions): Promise<BatchListResult> {
    const { limit, after, userContext, requestId } = options;

    log.info({ requestId, limit }, 'Listing batches');

    try {
      const where: {
        organizationId: string;
        id?: { gt?: string; lt?: string };
      } = {
        organizationId: userContext.organizationId,
      };

      if (after) {
        where.id = { gt: after };
      }

      const batches = await prisma.batch.findMany({
        where,
        take: limit + 1,
        orderBy: { createdAt: 'desc' },
      });

      const has_more = batches.length > limit;
      const returnBatches = has_more ? batches.slice(0, limit) : batches;

      return {
        batches: returnBatches.map((b) => ({
          id: b.id,
          object: 'batch',
          endpoint: b.endpoint,
          status: b.status,
          created_at: Math.floor(b.createdAt.getTime() / 1000),
          request_counts: {
            total: b.requestCountsTotal,
            completed: b.requestCountsCompleted,
            failed: b.requestCountsFailed,
          },
        })),
        has_more,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, error: errorMessage }, 'List batches failed');
      throw error;
    }
  }

  /**
   * Cancel batch
   */
  async cancelBatch(options: BatchCancelOptions): Promise<BatchCancelResult> {
    const { batchId, userContext, requestId } = options;

    log.info({ requestId, batchId }, 'Cancelling batch');

    try {
      const batch = await prisma.batch.findFirst({
        where: {
          id: batchId,
          organizationId: userContext.organizationId,
        },
      });

      if (!batch) {
        throw new Error('Batch not found');
      }

      if (!['validating', 'in_progress'].includes(batch.status)) {
        throw new Error(`Cannot cancel batch with status: ${batch.status}`);
      }

      const cancellingAt = new Date();

      await prisma.batch.update({
        where: { id: batchId },
        data: {
          status: 'cancelling',
          cancellingAt,
        },
      });

      log.info({ requestId, batchId }, 'Batch marked as cancelling');

      return {
        id: batchId,
        status: 'cancelling',
        cancelling_at: Math.floor(cancellingAt.getTime() / 1000),
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ requestId, batchId, error: errorMessage }, 'Cancel batch failed');
      throw error;
    }
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Enqueue batch processing job
   * REAL IMPLEMENTATION - Uses BullMQ queue
   */
  private async enqueueBatchProcessing(
    batchId: string,
    inputFileId: string,
    endpoint: string,
    userContext: OrchestrationContext
  ): Promise<void> {
    try {
      const { enqueueBatchJob } = await import('../workers/batch-worker.js');

      await enqueueBatchJob({
        batchId,
        inputFileId,
        endpoint,
        organizationId: userContext.organizationId,
        userId: userContext.userId || '',
        // Unknown until the worker parses the file (createBatch no longer
        // downloads it) — the worker logs/persists the real count itself.
        requestCount: 0,
      });

      log.info({ batchId, endpoint }, 'Batch processing job enqueued');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ batchId, error: errorMessage }, 'Failed to enqueue batch job');
      throw error;
    }
  }
}

