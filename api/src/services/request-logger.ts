// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Request Logger Service
 * Logs all API requests to database for analytics and usage tracking
 * Enterprise-grade implementation with async writes and error handling
 */

import { createHash } from 'node:crypto';

import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import type { ChatRequest, ChatResponse, OrchestrationResult } from '@/types';
import { logger } from '@/utils/logger';
import { nanoid } from 'nanoid';
import { shardingService } from './sharding-service';
import { pushOperationalRequestBatch } from './systems-push';
import { buildSystemsTrace, type SystemsTrace } from './systems-trace';
import { getCorrelationId } from '@/api/middleware/request-context';
import { extractErrorCodeFromObject, serializeError } from '@/utils/type-guards';

/**
 * Request identity for attribution (security monitoring / per-key usage).
 * ipAddress is RAW at the call sites and hashed once (ipPseudonymHash)
 * before anything persists it — request_logs stores ip_hash, never the IP
 * (same policy as anonymous_chat_logs.ip_hash).
 */
export interface RequestIdentity {
  apiKeyId?: string;
  ipAddress?: string;
}

/** Single hash implementation shared by the DB write and the systems push,
 *  so the two can never drift. */
export function ipPseudonymHash(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

/**
 * Request log data
 */
export interface RequestLogData {
  organizationId: string;
  userId?: string;
  requestId: string;
  endpoint: string;
  method: string;

  // Attribution (see RequestIdentity) + wall-clock of the request itself
  // (the DB row's created_at is the INSERT time, up to one flush interval later).
  apiKeyId?: string;
  ipAddress?: string;
  completedAt?: string;

  // Sharding (for massive scale)
  shardId?: number; // Auto-calculated from organizationId

  // Orchestration details
  strategyId?: string;
  strategyName?: string;
  modelsUsed?: string[]; // Array of model IDs
  modelCount?: number;
  primaryModelId?: string;

  // Performance
  durationMs: number;
  queueTimeMs?: number;

  // Tokens
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;

  // Cost
  costUsd: number;

  // Quality
  qualityScore?: number;

  // Request/Response (for debugging)
  request?: {
    model?: string;
    messageCount?: number;
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    toolCount?: number;
    strategy?: string;
    task_type?: string;
  };
  response?: {
    id?: string;
    model?: string;
    choiceCount?: number;
    finish_reason?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  // Status
  status: 'success' | 'error' | 'timeout';
  errorCode?: string;
  errorMessage?: string;

  // Metadata
  metadata?: Record<string, unknown>;

  /**
   * Processing trace mirrored to Ailin Systems ONLY (correlation id, stages,
   * opt-in sealed content). Never persisted to request_logs — flush() maps
   * explicit columns, so this field cannot reach the database.
   */
  systemsTrace?: SystemsTrace;
}

/**
 * Request Logger Service
 */
export class RequestLoggerService {
  private log = logger.child({ service: 'request-logger' });
  private writeQueue: RequestLogData[] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private partitionInterval: NodeJS.Timeout | null = null;
  private isFlushActive = false;

  constructor() {
    // Start periodic flush (every 5 seconds)
    this.startPeriodicFlush();
    // Ensure the monthly request_logs partitions exist (current + next 2 months)
    // on boot and daily thereafter. Without this the INSERTs fail with
    // "no partition of relation request_logs found for row" once the calendar
    // rolls past the last pre-created partition — exactly how request logging
    // silently broke for ~a month. Fire-and-forget.
    void this.ensureUpcomingPartitions();
    this.partitionInterval = setInterval(
      () => {
        void this.ensureUpcomingPartitions();
      },
      24 * 60 * 60 * 1000
    ); // daily
  }

  /**
   * Log a request asynchronously
   * Non-blocking - queues log and returns immediately
   */
  async logRequest(data: RequestLogData): Promise<void> {
    try {
      this.log.debug(
        {
          requestId: data.requestId,
          endpoint: data.endpoint,
          status: data.status,
        },
        'Queuing request log'
      );

      // Add to queue
      this.writeQueue.push(data);

      // If queue is large, flush immediately
      if (this.writeQueue.length >= 100) {
        this.log.info(
          { queueSize: this.writeQueue.length },
          'Queue size threshold reached, flushing'
        );
        await this.flush();
      }
    } catch (error) {
      this.log.error({ error, requestId: data.requestId }, 'Failed to queue request log');
    }
  }

  /**
   * Log orchestration result
   * Convenience method to log from OrchestrationResult
   */
  async logOrchestration(
    result: OrchestrationResult,
    organizationId: string,
    userId: string | undefined,
    endpoint: string,
    method: string,
    request: ChatRequest,
    identity?: RequestIdentity
  ): Promise<void> {
    const logData: RequestLogData = {
      organizationId,
      userId,
      requestId: nanoid(),
      endpoint,
      method,

      apiKeyId: identity?.apiKeyId,
      ipAddress: identity?.ipAddress,
      completedAt: new Date().toISOString(),

      // Sharding (auto-calculated for massive scale)
      shardId: shardingService.getShardId(organizationId),

      // Orchestration details
      strategyName: result.strategyUsed,
      modelsUsed: result.modelsUsed.map((m) => m.modelId),
      modelCount: result.modelsUsed.length,
      primaryModelId: result.modelsUsed[0]?.modelId,

      // Performance
      durationMs: result.totalDuration,

      // Tokens
      inputTokens: result.finalResponse.usage?.prompt_tokens || 0,
      outputTokens: result.finalResponse.usage?.completion_tokens || 0,
      totalTokens: result.finalResponse.usage?.total_tokens || 0,

      // Cost
      costUsd: result.totalCost,

      // Quality
      qualityScore: result.qualityScore,

      // Request/Response (sanitized)
      request: this.sanitizeRequest(request),
      response: this.sanitizeResponse(result.finalResponse),

      // Status
      status: 'success',

      // Metadata
      metadata: result.metadata,

      // Systems-only trace (never written to request_logs; see RequestLogData).
      systemsTrace: buildSystemsTrace(result, request, { correlationId: getCorrelationId() }),
    };

    await this.logRequest(logData);
  }

  /**
   * Log error request
   */
  async logError(
    organizationId: string,
    userId: string | undefined,
    requestId: string,
    endpoint: string,
    method: string,
    error: Error,
    durationMs: number,
    request?: ChatRequest,
    identity?: RequestIdentity
  ): Promise<void> {
    // Extract model ID from request so error logs can be attributed to a provider.
    // The model field may be in "provider:model-name" format (database ID) or just a
    // model name. Either way, storing it in model_id allows the health query to
    // extract the provider via SPLIT_PART(model_id, ':', 1).
    const primaryModelId =
      request?.model && typeof request.model === 'string' && request.model.trim().length > 0
        ? request.model.trim()
        : undefined;

    const logData: RequestLogData = {
      organizationId,
      userId,
      requestId,
      endpoint,
      method,

      apiKeyId: identity?.apiKeyId,
      ipAddress: identity?.ipAddress,
      completedAt: new Date().toISOString(),

      // Sharding
      shardId: shardingService.getShardId(organizationId),

      // Model attribution for provider health tracking
      primaryModelId,

      durationMs,

      // Tokens (unknown for error)
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,

      // Cost (0 for error)
      costUsd: 0,

      // Request
      request: request ? this.sanitizeRequest(request) : undefined,

      // Status
      status: 'error',
      errorCode: extractErrorCodeFromObject(error) ?? 'unknown_error',
      errorMessage: error.message,
    };

    await this.logRequest(logData);
  }

  /**
   * Flush queue to database
   */
  async flush(): Promise<void> {
    if (this.isFlushActive || this.writeQueue.length === 0) {
      return;
    }

    this.isFlushActive = true;

    // Hoisted so the catch block can re-queue the failed batch.
    const batch = [...this.writeQueue];
    this.writeQueue = [];

    try {
      this.log.debug({ batchSize: batch.length }, 'Flushing request logs to database');

      // Write to database in batch
      // Type-safe mapping to Prisma RequestLogCreateManyInput
      const prismaData: Prisma.RequestLogCreateManyInput[] = batch.map((log) => ({
        organizationId: log.organizationId,
        requestId: log.requestId,
        endpoint: log.endpoint,
        method: log.method,

        // Attribution (previously dropped here — the accepted userId never
        // reached the row; see internal-usage-routes.ts). IP is stored ONLY
        // as a sha256 hash — the raw value never persists.
        userId: log.userId,
        apiKeyId: log.apiKeyId,
        ipHash: log.ipAddress ? ipPseudonymHash(log.ipAddress) : undefined,

        // Sharding (critical for massive scale)
        shardId: log.shardId,

        strategyId: log.strategyId,
        strategyName: log.strategyName,
        modelsUsed: log.modelsUsed || [],
        modelCount: log.modelCount || 1,
        modelId: log.primaryModelId,

        durationMs: log.durationMs,
        queueTimeMs: log.queueTimeMs,

        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens,
        totalTokens: log.totalTokens,

        costUsd: log.costUsd,
        qualityScore: log.qualityScore,

        request: log.request || {},
        response: log.response || {},

        status: log.status,
        errorCode: log.errorCode,
        errorMessage: log.errorMessage,

        metadata: (log.metadata || {}) as Prisma.InputJsonValue,
      }));

      await prisma.requestLog.createMany({
        data: prismaData,
        skipDuplicates: true,
      });

      // Mirror the same batch to Ailin Systems (operational metadata only —
      // systems-push maps explicit fields, never request/response/metadata
      // blobs). Fire-and-forget by contract: it never throws and never
      // re-queues; telemetry tolerates gaps, the request path must not.
      void pushOperationalRequestBatch(batch);

      this.log.info({ batchSize: batch.length }, 'Request logs flushed successfully');
    } catch (error) {
      this.log.error({ error, queueSize: this.writeQueue.length }, 'Failed to flush request logs');

      // Re-queue the failed batch in front (oldest first) so the next flush
      // retries it — the previous code claimed this but dropped the batch.
      // Capped at 1000 items, keeping the NEWEST when overflowing: under
      // sustained DB outage the oldest rows are the first to sacrifice so
      // the queue cannot grow unbounded.
      this.writeQueue = [...batch, ...this.writeQueue];
      if (this.writeQueue.length > 1000) {
        this.writeQueue = this.writeQueue.slice(-1000);
        this.log.error('Queue overflow, dropping oldest logs to protect memory');
      }
    } finally {
      this.isFlushActive = false;
    }
  }

  /**
   * Start periodic flush (every 5 seconds)
   */
  private startPeriodicFlush(): void {
    this.flushInterval = setInterval(() => {
      this.flush().catch((error) => {
        this.log.error({ error: serializeError(error) }, 'Periodic flush failed');
      });
    }, 5000); // Flush every 5 seconds

    this.log.info('Periodic flush started (interval: 5s)');
  }

  /**
   * Ensure the monthly range partitions of request_logs exist for the current
   * and next two months. Idempotent (CREATE TABLE IF NOT EXISTS). Runs on boot
   * and daily. Partition name/bounds are derived from a date (YYYY_MM), so the
   * interpolated DDL is injection-safe. Fixes the root cause of the ~1-month
   * request-logging outage: no scheduled job existed to roll partitions forward,
   * so INSERTs failed once the calendar passed the last pre-created month.
   */
  async ensureUpcomingPartitions(): Promise<void> {
    const now = new Date();
    for (let i = 0; i <= 2; i++) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const name = `request_logs_${start.getUTCFullYear()}_${String(
        start.getUTCMonth() + 1
      ).padStart(2, '0')}`;
      const startStr = start.toISOString().slice(0, 10);
      const endStr = end.toISOString().slice(0, 10);
      try {
        await prisma.$executeRawUnsafe(
          `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF request_logs FOR VALUES FROM ('${startStr}') TO ('${endStr}')`
        );
      } catch (error) {
        this.log.warn(
          { error: serializeError(error), partition: name },
          'Failed to ensure request_logs partition'
        );
      }
    }
  }

  /**
   * Stop periodic flush and flush remaining logs
   */
  async shutdown(): Promise<void> {
    this.log.info('Shutting down request logger');

    // Stop intervals
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.partitionInterval) {
      clearInterval(this.partitionInterval);
      this.partitionInterval = null;
    }

    // Flush remaining logs
    await this.flush();

    this.log.info('Request logger shutdown complete');
  }

  /**
   * Sanitize request for storage (remove sensitive data)
   */
  private sanitizeRequest(request: ChatRequest): {
    model?: string;
    messageCount: number;
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    toolCount: number;
    strategy?: string;
    task_type?: string;
  } {
    return {
      model: request.model,
      messageCount: request.messages.length,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      stream: request.stream,
      toolCount: request.tools?.length || 0,
      strategy: request.strategy,
      task_type: request.task_type,
      // Don't store full message content for privacy
    };
  }

  /**
   * Sanitize response for storage
   */
  private sanitizeResponse(response: ChatResponse): {
    id?: string;
    model?: string;
    choiceCount: number;
    finish_reason?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  } {
    return {
      id: response.id,
      model: response.model,
      choiceCount: response.choices.length,
      finish_reason: response.choices[0]?.finish_reason
        ? String(response.choices[0].finish_reason)
        : undefined,
      usage: response.usage,
      // Don't store full response content for privacy
    };
  }
}

/**
 * Global singleton instance
 */
let globalRequestLogger: RequestLoggerService | null = null;

/**
 * Get global request logger
 */
export function getRequestLogger(): RequestLoggerService {
  if (!globalRequestLogger) {
    globalRequestLogger = new RequestLoggerService();
  }
  return globalRequestLogger;
}

/**
 * Shutdown request logger (for graceful shutdown)
 */
export async function shutdownRequestLogger(): Promise<void> {
  if (globalRequestLogger) {
    await globalRequestLogger.shutdown();
    globalRequestLogger = null;
  }
}
