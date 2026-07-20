// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Triage Learning System
 * 
 * Learns from triage decisions and execution results to improve:
 * - Strategy selection (speed/cost/quality/balanced/adaptive)
 * - Model selection for triage
 * - Automatic strategy detection from user prompts
 * 
 * Architecture:
 * - Records triage decisions and their outcomes
 * - Learns which strategies work best for different request patterns
 * - Provides recommendations based on historical performance
 * - Automatic strategy detection from prompt analysis
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { serializeError } from '@/utils/type-guards';
import type { TriageStrategy, TaskType } from '@/types';

/**
 * Triage decision outcome for learning
 */
export interface TriageDecisionOutcome {
  // Triage context
  triageStrategy: TriageStrategy;
  triageModelId: string;
  triageModelName: string;
  
  // Request characteristics
  taskType: TaskType | string;
  complexity: 'low' | 'medium' | 'high';
  contextSize: number;
  promptCharacteristics: {
    urgency?: boolean;
    costSensitive?: boolean;
    qualityCritical?: boolean;
    messageCount: number;
    hasTools: boolean;
  };
  
  // Triage decision
  intent: string;
  confidence: number;
  
  // Execution outcome
  executionStrategy: string;
  executionSuccess: boolean;
  executionQuality: number; // 0-1
  executionCost: number;
  executionLatency: number; // ms
  
  // Timestamp
  timestamp: number;
}

/**
 * Strategy performance metrics (learned)
 */
export interface StrategyPerformanceMetrics {
  strategy: TriageStrategy;
  taskType: string;
  complexity: string;
  successRate: number;
  avgQuality: number;
  avgCost: number;
  avgLatency: number;
  sampleCount: number;
  recommendationScore: number; // 0-1, higher = better
}

/**
 * Triage Learning System
 */
class TriageLearningSystem {
  private log = logger.child({ component: 'triage-learning' });
  private outcomeBuffer: TriageDecisionOutcome[] = [];
  private BUFFER_SIZE = 50;
  private FLUSH_INTERVAL = 30000; // Flush every 30 seconds
  private static readonly DECIMAL_10_6_MAX = 9999.999999;
  
  // Cache for strategy recommendations (updated periodically)
  private strategyRecommendationCache: Map<string, StrategyPerformanceMetrics[]> = new Map();
  private cacheValidUntil: number = 0;
  private CACHE_TTL = 300000; // 5 minutes

  constructor() {
    this.startPeriodicFlush();
  }

  /**
   * Record triage decision outcome for learning
   */
  recordOutcome(outcome: Omit<TriageDecisionOutcome, 'timestamp'>): void {
    const fullOutcome: TriageDecisionOutcome = {
      ...outcome,
      timestamp: Date.now(),
    };

    this.outcomeBuffer.push(fullOutcome);

    if (this.outcomeBuffer.length >= this.BUFFER_SIZE) {
      // Flush immediately if buffer is full
      this.flush().catch((error) => {
        this.log.error({ error: serializeError(error) }, 'Failed to flush triage outcomes');
      });
    }
  }

  /**
   * Detect optimal triage strategy from prompt analysis
   * Analyzes prompt characteristics to recommend strategy
   */
  detectStrategyFromPrompt(
    prompt: string,
    context: {
      messageCount: number;
      hasTools: boolean;
      contextSize: number;
    }
  ): {
    recommendedStrategy: TriageStrategy;
    confidence: number;
    reasoning: string;
  } {
    const lower = prompt.toLowerCase();
    
    // Urgency indicators (speed strategy)
    const urgencyIndicators = [
      /\burgent|asap|immediately|quick|fast|hurry|deadline|rush/gi,
      /\btime.*critical|need.*now|cant.*wait/gi,
    ];
    const isUrgent = urgencyIndicators.some(pattern => pattern.test(lower));
    
    // Cost-sensitive indicators (cost strategy)
    const costIndicators = [
      /\bbudget|cheap|cost.*effective|low.*cost|affordable|minimize.*cost/gi,
      /\boptimize.*cost|reduce.*spend|save.*money/gi,
    ];
    const isCostSensitive = costIndicators.some(pattern => pattern.test(lower));
    
    // Quality-critical indicators (quality strategy)
    const qualityIndicators = [
      /\bquality|accurate|precise|best.*result|high.*quality|excellent/gi,
      /\bperfect|polish|refine|production.*ready|critical.*accuracy/gi,
    ];
    const isQualityCritical = qualityIndicators.some(pattern => pattern.test(lower));
    
    // Complexity indicators (adaptive strategy)
    const complexityIndicators = [
      /\bcomplex|complicated|sophisticated|enterprise|architect/gi,
      context.messageCount > 10,
      context.contextSize > 5000,
      context.hasTools,
    ];
    const isComplex = complexityIndicators.some(indicator => 
      typeof indicator === 'boolean' ? indicator : indicator.test(lower)
    );
    
    // Decision logic
    if (isUrgent && !isQualityCritical) {
      return {
        recommendedStrategy: 'speed',
        confidence: 0.85,
        reasoning: 'Prompt indicates urgency - speed strategy recommended',
      };
    }
    
    if (isCostSensitive && !isQualityCritical && !isUrgent) {
      return {
        recommendedStrategy: 'cost',
        confidence: 0.80,
        reasoning: 'Prompt indicates cost sensitivity - cost strategy recommended',
      };
    }
    
    if (isQualityCritical && !isUrgent) {
      return {
        recommendedStrategy: 'quality',
        confidence: 0.85,
        reasoning: 'Prompt indicates quality criticality - quality strategy recommended',
      };
    }
    
    if (isComplex) {
      return {
        recommendedStrategy: 'adaptive',
        confidence: 0.75,
        reasoning: 'Request appears complex - adaptive strategy recommended',
      };
    }
    
    // Default to balanced
    return {
      recommendedStrategy: 'balanced',
      confidence: 0.60,
      reasoning: 'No specific indicators found - balanced strategy recommended',
    };
  }

  /**
   * Get recommended strategy based on learned performance
   */
  async getRecommendedStrategy(
    taskType: TaskType | string,
    complexity: 'low' | 'medium' | 'high',
    promptCharacteristics?: {
      urgency?: boolean;
      costSensitive?: boolean;
      qualityCritical?: boolean;
    }
  ): Promise<{
    recommendedStrategy: TriageStrategy;
    confidence: number;
    reasoning: string;
    basedOnLearning: boolean;
  }> {
    // Check cache first
    const cacheKey = `${taskType}:${complexity}`;
    const now = Date.now();
    
    if (now < this.cacheValidUntil && this.strategyRecommendationCache.has(cacheKey)) {
      const cached = this.strategyRecommendationCache.get(cacheKey);
      if (cached && cached.length > 0) {
        // Find best performing strategy
        const best = cached[0];
        return {
          recommendedStrategy: best.strategy as TriageStrategy,
          confidence: Math.min(best.recommendationScore, 0.95),
          reasoning: `Based on ${best.sampleCount} historical decisions: ${best.strategy} has ${(best.successRate * 100).toFixed(1)}% success rate, ${(best.avgQuality * 100).toFixed(1)}% avg quality`,
          basedOnLearning: true,
        };
      }
    }
    
    // Query database for learned performance
    try {
      const metrics = await this.getStrategyPerformanceMetrics(taskType, complexity);
      
      if (metrics.length > 0) {
        // Update cache
        this.strategyRecommendationCache.set(cacheKey, metrics);
        this.cacheValidUntil = now + this.CACHE_TTL;
        
        // Filter by prompt characteristics if provided
        let filteredMetrics = metrics;
        if (promptCharacteristics) {
          if (promptCharacteristics.urgency) {
            filteredMetrics = metrics.filter(m => m.strategy === 'speed' || m.avgLatency < 1000);
          }
          if (promptCharacteristics.costSensitive) {
            filteredMetrics = metrics.filter(m => m.strategy === 'cost' || m.avgCost < 0.001);
          }
          if (promptCharacteristics.qualityCritical) {
            filteredMetrics = metrics.filter(m => m.strategy === 'quality' || m.avgQuality > 0.8);
          }
        }
        
        if (filteredMetrics.length === 0) {
          filteredMetrics = metrics; // Fallback to all metrics
        }
        
        // Select best performing strategy
        const best = filteredMetrics[0];
        return {
          recommendedStrategy: best.strategy as TriageStrategy,
          confidence: Math.min(best.recommendationScore, 0.95),
          reasoning: `Based on ${best.sampleCount} historical decisions: ${best.strategy} has ${(best.successRate * 100).toFixed(1)}% success rate, ${(best.avgQuality * 100).toFixed(1)}% avg quality`,
          basedOnLearning: true,
        };
      }
    } catch (error) {
      this.log.warn({ error, taskType, complexity }, 'Failed to get learned strategy recommendation');
    }
    
    // Fallback: use prompt analysis if no learned data
    if (promptCharacteristics) {
      const detected = this.detectStrategyFromPrompt('', {
        messageCount: 0,
        hasTools: false,
        contextSize: 0,
      });
      return {
        ...detected,
        basedOnLearning: false,
      };
    }
    
    // Default fallback
    return {
      recommendedStrategy: 'balanced',
      confidence: 0.5,
      reasoning: 'No historical data available - using balanced strategy',
      basedOnLearning: false,
    };
  }

  /**
   * Get strategy performance metrics from database
   */
  private async getStrategyPerformanceMetrics(
    taskType: string,
    complexity: string
  ): Promise<StrategyPerformanceMetrics[]> {
    try {
      const rows = await prisma.strategyWeight.findMany({
        where: {
          taskType,
          complexity,
          sampleCount: { gte: 5 },
        },
        orderBy: [
          { successRate: 'desc' },
          { avgQuality: 'desc' },
          { avgCostEfficiency: 'desc' },
        ],
        take: 10,
      });

      return rows.map((row) => {
        const sampleCount = row.sampleCount;
        const successRate = this.toNumeric(row.successRate);
        const avgQuality = this.toNumeric(row.avgQuality);
        const avgCostEfficiency = this.toNumeric(row.avgCostEfficiency);
        const avgCost =
          avgCostEfficiency > 0
            ? Number((Math.max(avgQuality, 0.000001) / avgCostEfficiency).toFixed(6))
            : 0;
        const avgLatency = 0;

        const normalizedCostEfficiency = Math.min(avgCostEfficiency / 500, 1);
        const recommendationScore = Math.max(
          0,
          Math.min(
            1,
            successRate * 0.45 +
              avgQuality * 0.4 +
              normalizedCostEfficiency * 0.15
          )
        );

        return {
          strategy: row.strategy as TriageStrategy,
          taskType,
          complexity,
          successRate,
          avgQuality,
          avgCost,
          avgLatency,
          sampleCount,
          recommendationScore,
        };
      });
    } catch (error) {
      this.log.error({ error, taskType, complexity }, 'Failed to query strategy performance metrics');
      return [];
    }
  }

  /**
   * Flush outcome buffer to database
   */
  private async flush(): Promise<void> {
    if (this.outcomeBuffer.length === 0) return;

    const outcomes = [...this.outcomeBuffer];
    this.outcomeBuffer = [];

    this.log.debug({ count: outcomes.length }, 'Flushing triage outcomes to database');

    try {
      type BucketAggregate = {
        bucket: string;
        taskType: string;
        complexity: 'low' | 'medium' | 'high';
        count: number;
        successCount: number;
        qualitySum: number;
        costSum: number;
        latencySum: number;
        strategyCounts: Record<string, number>;
      };

      type StrategyAggregate = {
        taskType: string;
        complexity: 'low' | 'medium' | 'high';
        strategy: string;
        count: number;
        successCount: number;
        qualitySum: number;
        costSum: number;
      };

      const bucketAggregates = new Map<string, BucketAggregate>();
      const strategyAggregates = new Map<string, StrategyAggregate>();

      for (const outcome of outcomes) {
        const bucket = this.getBucketKey(outcome.timestamp);
        const taskType = String(outcome.taskType || 'general');
        const complexity = outcome.complexity;

        const bucketKey = `${bucket}|${taskType}|${complexity}`;
        const existingBucket = bucketAggregates.get(bucketKey) || {
          bucket,
          taskType,
          complexity,
          count: 0,
          successCount: 0,
          qualitySum: 0,
          costSum: 0,
          latencySum: 0,
          strategyCounts: {},
        };

        existingBucket.count += 1;
        existingBucket.successCount += outcome.executionSuccess ? 1 : 0;
        existingBucket.qualitySum += outcome.executionQuality;
        existingBucket.costSum += outcome.executionCost;
        existingBucket.latencySum += outcome.executionLatency;
        existingBucket.strategyCounts[outcome.triageStrategy] =
          (existingBucket.strategyCounts[outcome.triageStrategy] || 0) + 1;
        bucketAggregates.set(bucketKey, existingBucket);

        const strategyKey = `${taskType}|${complexity}|${outcome.triageStrategy}`;
        const existingStrategy = strategyAggregates.get(strategyKey) || {
          taskType,
          complexity,
          strategy: outcome.triageStrategy,
          count: 0,
          successCount: 0,
          qualitySum: 0,
          costSum: 0,
        };

        existingStrategy.count += 1;
        existingStrategy.successCount += outcome.executionSuccess ? 1 : 0;
        existingStrategy.qualitySum += outcome.executionQuality;
        existingStrategy.costSum += outcome.executionCost;
        strategyAggregates.set(strategyKey, existingStrategy);
      }

      for (const aggregate of bucketAggregates.values()) {
        const where = {
          bucket_taskType_complexity: {
            bucket: aggregate.bucket,
            taskType: aggregate.taskType,
            complexity: aggregate.complexity,
          },
        };
        const existing = await prisma.learningData.findUnique({ where });
        const averageQuality = aggregate.qualitySum / Math.max(aggregate.count, 1);
        const averageCost = aggregate.costSum / Math.max(aggregate.count, 1);
        const averageLatency = Math.round(
          aggregate.latencySum / Math.max(aggregate.count, 1)
        );

        if (!existing) {
          await prisma.learningData.create({
            data: {
              bucket: aggregate.bucket,
              taskType: aggregate.taskType,
              complexity: aggregate.complexity,
              count: aggregate.count,
              successCount: aggregate.successCount,
              avgQuality: Number(averageQuality.toFixed(4)),
              avgCost: Number(averageCost.toFixed(6)),
              avgLatency: averageLatency,
              strategyDistribution: aggregate.strategyCounts,
              topPatterns: [],
            },
          });
          continue;
        }

        const previousCount = Math.max(existing.count, 0);
        const mergedCount = previousCount + aggregate.count;
        const existingAvgQuality = this.toNumeric(existing.avgQuality);
        const existingAvgCost = this.toNumeric(existing.avgCost);
        const existingAvgLatency = this.toNumeric(existing.avgLatency);

        const mergedQuality =
          (existingAvgQuality * previousCount + averageQuality * aggregate.count) /
          Math.max(mergedCount, 1);
        const mergedCost =
          (existingAvgCost * previousCount + averageCost * aggregate.count) /
          Math.max(mergedCount, 1);
        const mergedLatency = Math.round(
          (existingAvgLatency * previousCount + averageLatency * aggregate.count) /
            Math.max(mergedCount, 1)
        );

        await prisma.learningData.update({
          where,
          data: {
            count: mergedCount,
            successCount: existing.successCount + aggregate.successCount,
            avgQuality: Number(mergedQuality.toFixed(4)),
            avgCost: Number(mergedCost.toFixed(6)),
            avgLatency: mergedLatency,
            strategyDistribution: this.mergeStrategyDistributions(
              existing.strategyDistribution,
              aggregate.strategyCounts
            ),
            updatedAt: new Date(),
          },
        });
      }

      for (const aggregate of strategyAggregates.values()) {
        const where = {
          taskType_complexity_strategy: {
            taskType: aggregate.taskType,
            complexity: aggregate.complexity,
            strategy: aggregate.strategy,
          },
        };
        const existing = await prisma.strategyWeight.findUnique({ where });

        const localSample = Math.max(aggregate.count, 1);
        const localSuccessRate = this.clampUnitInterval(
          aggregate.successCount / localSample
        );
        const localAvgQuality = this.clampUnitInterval(aggregate.qualitySum / localSample);
        const localAvgCost = this.clampNonNegative(aggregate.costSum / localSample);
        const localCostEfficiency = this.clampCostEfficiency(
          localAvgCost > 0 ? localAvgQuality / localAvgCost : 0
        );

        if (!existing) {
          const initialWeight = this.calculateAdaptiveWeight(
            localSuccessRate,
            localAvgQuality,
            localCostEfficiency
          );
          await prisma.strategyWeight.create({
            data: {
              taskType: aggregate.taskType,
              complexity: aggregate.complexity,
              strategy: aggregate.strategy,
              sampleCount: localSample,
              successRate: this.toDecimal10_6(localSuccessRate),
              avgQuality: this.toDecimal10_6(localAvgQuality),
              avgCostEfficiency: this.toDecimal10_6(localCostEfficiency),
              weight: this.toDecimal10_6(initialWeight),
            },
          });
          continue;
        }

        const existingSample = Math.max(existing.sampleCount, 0);
        const mergedSample = existingSample + localSample;
        const existingSuccessRate = this.toNumeric(existing.successRate);
        const existingAvgQuality = this.toNumeric(existing.avgQuality);
        const existingAvgCostEfficiency = this.toNumeric(existing.avgCostEfficiency);

        const mergedSuccessRate = this.clampUnitInterval(
          (existingSuccessRate * existingSample + aggregate.successCount) /
            Math.max(mergedSample, 1)
        );
        const mergedAvgQuality = this.clampUnitInterval(
          (existingAvgQuality * existingSample + localAvgQuality * localSample) /
            Math.max(mergedSample, 1)
        );
        const mergedAvgCostEfficiency = this.clampCostEfficiency(
          (existingAvgCostEfficiency * existingSample +
            localCostEfficiency * localSample) /
            Math.max(mergedSample, 1)
        );
        const mergedWeight = this.calculateAdaptiveWeight(
          mergedSuccessRate,
          mergedAvgQuality,
          mergedAvgCostEfficiency
        );

        await prisma.strategyWeight.update({
          where,
          data: {
            sampleCount: mergedSample,
            successRate: this.toDecimal10_6(mergedSuccessRate),
            avgQuality: this.toDecimal10_6(mergedAvgQuality),
            avgCostEfficiency: this.toDecimal10_6(mergedAvgCostEfficiency),
            weight: this.toDecimal10_6(mergedWeight),
            updatedAt: new Date(),
          },
        });
      }

      this.cacheValidUntil = 0;
      this.log.info(
        {
          count: outcomes.length,
          learningBuckets: bucketAggregates.size,
          strategyUpdates: strategyAggregates.size,
        },
        'Triage outcomes flushed successfully'
      );
    } catch (error) {
      this.log.error({ error }, 'Failed to flush triage outcomes');
      // Re-add to buffer on failure (with limit to prevent unbounded growth)
      if (this.outcomeBuffer.length < this.BUFFER_SIZE * 2) {
        this.outcomeBuffer.unshift(...outcomes);
      }
    }
  }

  private mergeStrategyDistributions(
    existing: unknown,
    incoming: Record<string, number>
  ): Record<string, number> {
    const current: Record<string, number> =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? Object.fromEntries(
            Object.entries(existing as Record<string, unknown>).map(([key, value]) => [
              key,
              Number(value) || 0,
            ])
          )
        : {};

    for (const [strategy, count] of Object.entries(incoming)) {
      current[strategy] = (current[strategy] || 0) + Math.max(0, count);
    }

    return current;
  }

  private toNumeric(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private clampUnitInterval(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  private clampNonNegative(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, value);
  }

  private clampCostEfficiency(value: number): number {
    const bounded = this.clampNonNegative(value);
    return Math.min(bounded, TriageLearningSystem.DECIMAL_10_6_MAX);
  }

  private toDecimal10_6(value: number): number {
    if (!Number.isFinite(value)) return 0;
    const bounded = Math.max(
      -TriageLearningSystem.DECIMAL_10_6_MAX,
      Math.min(TriageLearningSystem.DECIMAL_10_6_MAX, value)
    );
    return Number(bounded.toFixed(6));
  }

  private calculateAdaptiveWeight(
    successRate: number,
    avgQuality: number,
    avgCostEfficiency: number
  ): number {
    const boundedSuccess = Math.max(0, Math.min(1, successRate));
    const boundedQuality = Math.max(0, Math.min(1, avgQuality));
    const normalizedCostEfficiency = Math.max(0, Math.min(1, avgCostEfficiency / 500));
    const score =
      boundedSuccess * 0.55 + boundedQuality * 0.35 + normalizedCostEfficiency * 0.1;
    return Math.max(0.1, Math.min(3, score * 2));
  }

  /**
   * Get bucket key for time-based aggregation
   */
  private getBucketKey(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');
    return `${year}-${month}-${day}-${hour}`;
  }

  /**
   * Start periodic flush
   */
  private startPeriodicFlush(): void {
    setInterval(() => {
      if (this.outcomeBuffer.length > 0) {
        this.flush().catch((error) => {
          this.log.error({ error: serializeError(error) }, 'Periodic flush failed');
        });
      }
    }, this.FLUSH_INTERVAL);
  }
}

// Export singleton instance
export const triageLearningSystem = new TriageLearningSystem();
