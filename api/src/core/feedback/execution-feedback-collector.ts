// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Execution Feedback Collector
 *
 * Part of Full SOTA Provider Resolution (L7: Closed Feedback Loop).
 *
 * Collects execution results and fans out to all learning subsystems:
 * 1. Provider Bandit (L5) — updates arm selection weights
 * 2. Model performance quality — updates DB via batch flush
 * 3. Credit Monitor (L4) — propagates 402/403 errors
 *
 * Also implements L14 (Idempotency Guard) via a Set of processed request IDs.
 */

import { logger } from '@/utils/logger';
import { getProviderBandit } from '@/core/learning/provider-bandit';
import { getCreditMonitorService } from '@/services/credit-monitor-service';
import { getPromptVariantBandit, isPromptVariantBanditEnabled } from '@/core/learning/prompt-variant-bandit';

const log = logger.child({ component: 'feedback-collector' });

// ─── Types ──────────────────────────────────────────────────────────────

export interface ExecutionFeedback {
  requestId: string;
  modelId: string;
  modelUid?: string;
  providerId: string;
  equivalenceGroup?: string;
  success: boolean;
  latencyMs: number;
  costUsd: number;
  qualityScore?: number;  // 0-1 from judge
  errorType?: string;
  errorCode?: string;
  timestamp: Date;
  /** Prompt variant ID used in this execution (for variant bandit learning). */
  promptVariantId?: string;
  /** Prompt key (e.g. 'consensusVoter') — identifies which prompt the variant belongs to. */
  promptKey?: string;
  /** SHA-256 hash (truncated) of prompt slot values used (for audit). */
  promptSlotHash?: string;
  /** Task type context for bandit learning. */
  taskType?: string;
  /** Complexity context for bandit learning. */
  complexity?: string;
  /** Prompt length bin for bandit context. */
  promptLength?: 'short' | 'medium' | 'long';
}

interface QualityAccumulator {
  sum: number;
  count: number;
  lastUpdated: Date;
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: ExecutionFeedbackCollector | null = null;

export function getExecutionFeedbackCollector(): ExecutionFeedbackCollector {
  if (!instance) {
    instance = new ExecutionFeedbackCollector();
  }
  return instance;
}

// ─── Service ────────────────────────────────────────────────────────────

export class ExecutionFeedbackCollector {
  // L14: Idempotency guard — track processed request IDs
  private processedIds = new Set<string>();
  private maxProcessedIds = 10_000;

  // Quality accumulator for batch DB writes
  private qualityBuffer = new Map<string, QualityAccumulator>(); // keyed by modelId
  private flushIntervalHandle: NodeJS.Timeout | null = null;
  private flushIntervalMs = 30_000; // flush every 30s

  constructor() {
    // Start periodic flush
    this.flushIntervalHandle = setInterval(() => {
      this.flushPerformanceUpdates().catch(err =>
        log.warn({ error: String(err) }, 'Feedback flush failed')
      );
    }, this.flushIntervalMs);
  }

  /**
   * Record an execution result. Fans out to all subsystems.
   * Idempotent — duplicate requestIds are silently dropped.
   */
  record(feedback: ExecutionFeedback): void {
    // L14: Idempotency guard
    if (this.processedIds.has(feedback.requestId)) {
      return; // Already processed
    }
    this.processedIds.add(feedback.requestId);

    // Prevent unbounded growth — evict oldest 20% when full
    if (this.processedIds.size > this.maxProcessedIds) {
      const evictCount = Math.floor(this.maxProcessedIds * 0.2);
      const iter = this.processedIds.values();
      for (let i = 0; i < evictCount; i++) {
        const { value, done } = iter.next();
        if (done) break;
        this.processedIds.delete(value);
      }
    }

    // 1. Update Provider Bandit (L5).
    // `getProviderBandit` is now imported at module scope — no more
    // `require()` (which TS sees as `any` and cascades unsafe-* errors).
    try {
      const bandit = getProviderBandit();
      bandit.update({
        equivalenceGroup: feedback.equivalenceGroup ?? feedback.modelId,
        providerId: feedback.providerId,
        success: feedback.success,
        qualityScore: feedback.qualityScore,
        latencyMs: feedback.latencyMs,
      });
    } catch {
      // Provider bandit not available — non-critical
    }

    // 2. Buffer quality score for batch DB update (keyed by modelUid for multi-provider correctness)
    if (feedback.qualityScore !== undefined && feedback.qualityScore > 0) {
      const bufferKey = feedback.modelUid ?? feedback.modelId; // prefer uid for multi-provider
      const existing = this.qualityBuffer.get(bufferKey);
      if (existing) {
        existing.sum += feedback.qualityScore;
        existing.count += 1;
        existing.lastUpdated = feedback.timestamp;
      } else {
        this.qualityBuffer.set(bufferKey, {
          sum: feedback.qualityScore,
          count: 1,
          lastUpdated: feedback.timestamp,
        });
      }
    }

    // 3. Propagate credit errors to Credit Monitor (L4).
    // `getCreditMonitorService` imported at module scope.
    if (!feedback.success && (feedback.errorCode === '402' || feedback.errorCode === '403' ||
        feedback.errorType === 'insufficient_quota' || feedback.errorType === 'insufficient_credits')) {
      try {
        getCreditMonitorService().onCreditError(feedback.providerId);
      } catch {
        // Credit monitor not available — non-critical
      }
    }

    // 4. Update Prompt Variant Bandit (reward for variant selection learning).
    // `getPromptVariantBandit` and `isPromptVariantBanditEnabled` imported at
    // module scope — no `require()` for either.
    if (feedback.qualityScore !== undefined && feedback.promptVariantId && feedback.promptKey) {
      try {
        if (isPromptVariantBanditEnabled()) {
          getPromptVariantBandit().update({
            promptKey: feedback.promptKey,
            variantId: feedback.promptVariantId,
            context: {
              taskType: feedback.taskType ?? 'general',
              complexity: feedback.complexity ?? 'medium',
              promptLength: feedback.promptLength ?? 'medium',
            },
            reward: feedback.qualityScore,
          });
        }
      } catch {
        // Prompt variant bandit not available — non-critical
      }
    }
  }

  /**
   * Batch-write accumulated quality scores to DB.
   * Uses exponential moving average: new_quality = 0.3 * avg_recent + 0.7 * existing
   */
  async flushPerformanceUpdates(): Promise<void> {
    if (this.qualityBuffer.size === 0) return;

    const updates = new Map(this.qualityBuffer);
    this.qualityBuffer.clear();

    try {
      const { prisma } = await import('@/database/client');
      let updated = 0;

      for (const [bufferKey, accumulator] of updates) {
        const avgQuality = accumulator.sum / accumulator.count;

        try {
          // Find the model by uid (preferred) or id (fallback) and update quality with EMA
          // bufferKey is modelUid when available, modelId otherwise
          const isUid = bufferKey.length === 25 && !bufferKey.includes('/'); // uid = 25-char MD5 hash
          const model = isUid
            ? await prisma.model.findUnique({ where: { uid: bufferKey }, select: { uid: true, performance: true } })
            : await prisma.model.findFirst({ where: { id: bufferKey }, select: { uid: true, performance: true } });

          if (model) {
            const currentPerf = (model.performance as Record<string, unknown>) ?? {};
            const currentQuality = (currentPerf.quality as number) ?? 0.8;

            // EMA: weight recent observations more, but don't swing wildly
            const emaQuality = 0.3 * avgQuality + 0.7 * currentQuality;

            await prisma.model.update({
              where: { uid: model.uid },
              data: {
                performance: {
                  ...currentPerf,
                  quality: Math.round(emaQuality * 1000) / 1000, // 3 decimal places
                  reliability: Math.round(
                    (0.3 * (accumulator.count > 0 ? 1 : 0) + 0.7 * ((currentPerf.reliability as number) ?? 0.95)) * 1000
                  ) / 1000,
                },
              },
            });
            updated++;
          }
        } catch (err) {
          log.warn({ bufferKey, error: String(err) }, 'Failed to update model quality');
        }
      }

      if (updated > 0) {
        log.debug({ updated, total: updates.size }, 'Flushed model quality updates to DB');
      }
    } catch (err) {
      log.warn({ error: String(err) }, 'Failed to flush performance updates');
      // Put back into buffer for next flush
      for (const [modelId, acc] of updates) {
        const existing = this.qualityBuffer.get(modelId);
        if (existing) {
          existing.sum += acc.sum;
          existing.count += acc.count;
        } else {
          this.qualityBuffer.set(modelId, acc);
        }
      }
    }
  }

  /**
   * Get aggregated stats for a model+provider pair.
   */
  getStats(): { bufferedModels: number; processedRequests: number } {
    return {
      bufferedModels: this.qualityBuffer.size,
      processedRequests: this.processedIds.size,
    };
  }

  /**
   * Stop the flush interval.
   */
  dispose(): void {
    if (this.flushIntervalHandle) {
      clearInterval(this.flushIntervalHandle);
      this.flushIntervalHandle = null;
    }
  }
}
