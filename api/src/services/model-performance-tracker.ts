// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Real-Time Model Performance Tracker
 *
 * Tracks and updates model performance metrics in real-time based on actual usage.
 * Replaces static performance data with dynamic, evidence-based metrics across
 * ALL  registered models from VertexAI, OpenRouter, and other providers.
 */

import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import type { TaskType } from '@/types';

const log = logger.child({ component: 'model-performance-tracker' });

export interface RealTimeMetrics {
  modelId: string;
  taskType?: TaskType;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgResponseTime: number;
  avgCost: number;
  avgQualityScore: number;
  successRate: number;
  errorRate: number;
  throughput: number; // requests per minute
  lastUsed: Date;
  lastError?: string;
  errorPatterns: Record<string, number>; // error type -> count
  // GPT-5.1 specific metrics (November 2025)
  gpt5Capabilities?: {
    advancedReasoning: boolean;
    multimodalProcessing: boolean;
    contextUnderstanding: number; // 0-1 score
    codeGenerationQuality: number; // 0-1 score
  };
}

export interface PerformanceUpdate {
  modelId: string;
  taskType?: TaskType;
  responseTime: number;
  cost: number;
  qualityScore?: number;
  success: boolean;
  errorType?: string;
  errorMessage?: string;
}

/**
 * Real-Time Model Performance Tracker
 * Tracks performance across ALL  models from all providers
 */
export class ModelPerformanceTracker {
  private readonly METRICS_TTL = 30 * 24 * 60 * 60; // 30 days
  private readonly WINDOW_SIZE = 1000; // Keep last 1000 measurements for moving averages

  // In-memory metrics store (would be Redis in production)
  // Tracks ALL  models across all task types
  private metricsStore = new Map<string, RealTimeMetrics>();

  /**
   * Track a request completion across the entire model ecosystem
   */
  async trackRequest(update: PerformanceUpdate): Promise<void> {
    const startTime = Date.now();

    try {
      // Track both task-specific and global metrics
      const keys = [
        this.getMetricsKey(update.modelId, update.taskType), // Task-specific
        this.getMetricsKey(update.modelId), // Global across all tasks
      ];

      for (const key of keys) {
        const currentMetrics = this.getMetricsSync(key);
        const newMetrics = this.calculateUpdatedMetrics(currentMetrics, update, key.includes(':'));
        this.metricsStore.set(key, newMetrics);
      }

      const duration = Date.now() - startTime;
      log.debug(
        {
          modelId: update.modelId,
          taskType: update.taskType,
          success: update.success,
          responseTime: update.responseTime,
          cost: update.cost,
          duration,
        },
        'Performance metrics updated for model in ecosystem'
      );
    } catch (error) {
      log.error(
        {
          error: getErrorMessage(error),
          modelId: update.modelId,
          taskType: update.taskType,
        },
        'Failed to track performance metrics'
      );
    }
  }

  /**
   * Get current metrics for a model/task combination
   */
  getMetricsSync(key: string): RealTimeMetrics {
    return this.metricsStore.get(key) || this.getDefaultMetrics(key);
  }

  /**
   * Get metrics for a model and task type
   */
  async getMetrics(modelId: string, taskType?: TaskType): Promise<RealTimeMetrics> {
    const key = this.getMetricsKey(modelId, taskType);
    const taskMetrics = this.metricsStore.get(key);
    if (taskMetrics && taskMetrics.totalRequests > 0) return taskMetrics;
    // Fall back to the GLOBAL (all-task) aggregate when the task-specific bucket
    // has no samples. The execution feedback bridge records without a resolved
    // taskType (writes the `:global` key), so the per-task key the scorer asks for
    // would otherwise stay empty and scoring would see sampleSize:0 forever.
    if (taskType) {
      const globalMetrics = this.metricsStore.get(this.getMetricsKey(modelId));
      if (globalMetrics && globalMetrics.totalRequests > 0) return globalMetrics;
    }
    return this.getDefaultMetrics(key);
  }

  /**
   * Get metrics for all models and task types (ALL  models)
   */
  async getAllMetrics(): Promise<Record<string, RealTimeMetrics>> {
    const metrics: Record<string, RealTimeMetrics> = {};

    for (const [key, metric] of this.metricsStore.entries()) {
      // Clean up expired metrics
      if (this.isExpired(metric)) {
        this.metricsStore.delete(key);
        continue;
      }
      metrics[key] = metric;
    }

    return metrics;
  }

  /**
   * Check if metrics are expired
   */
  private isExpired(metrics: RealTimeMetrics): boolean {
    return Date.now() - metrics.lastUsed.getTime() > this.METRICS_TTL * 1000;
  }

  /**
   * Calculate updated metrics based on new data point
   */
  private calculateUpdatedMetrics(
    current: RealTimeMetrics,
    update: PerformanceUpdate,
    isTaskSpecific: boolean = false
  ): RealTimeMetrics {
    const totalRequests = current.totalRequests + 1;
    const successfulRequests = current.successfulRequests + (update.success ? 1 : 0);
    const failedRequests = current.failedRequests + (update.success ? 0 : 1);

    // Calculate moving averages with exponential decay
    const alpha = 2 / (this.WINDOW_SIZE + 1); // Smoothing factor

    // For task-specific metrics, weight more heavily on recent performance
    const smoothingFactor = isTaskSpecific ? alpha * 1.5 : alpha;

    const avgResponseTime = this.exponentialMovingAverage(
      current.avgResponseTime,
      update.responseTime,
      smoothingFactor,
      totalRequests
    );

    const avgCost = this.exponentialMovingAverage(
      current.avgCost,
      update.cost,
      smoothingFactor,
      totalRequests
    );

    let avgQualityScore = current.avgQualityScore;
    if (update.qualityScore !== undefined) {
      avgQualityScore = this.exponentialMovingAverage(
        current.avgQualityScore,
        update.qualityScore,
        smoothingFactor,
        successfulRequests
      );
    }

    // Update error patterns
    const errorPatterns = { ...current.errorPatterns };
    if (!update.success && update.errorType) {
      errorPatterns[update.errorType] = (errorPatterns[update.errorType] || 0) + 1;
    }

    // Calculate derived metrics
    const successRate = successfulRequests / totalRequests;
    const errorRate = failedRequests / totalRequests;

    // Calculate throughput (requests per minute)
    const timeWindowMinutes = (Date.now() - current.lastUsed.getTime()) / (1000 * 60);
    const throughput = timeWindowMinutes > 0 ? totalRequests / timeWindowMinutes : 0;

    return {
      modelId: current.modelId,
      taskType: current.taskType,
      totalRequests,
      successfulRequests,
      failedRequests,
      avgResponseTime,
      avgCost,
      avgQualityScore,
      successRate,
      errorRate,
      throughput,
      lastUsed: new Date(),
      lastError: update.success ? current.lastError : update.errorMessage,
      errorPatterns,
    };
  }

  /**
   * Calculate exponential moving average
   */
  private exponentialMovingAverage(
    currentAverage: number,
    newValue: number,
    alpha: number,
    count: number
  ): number {
    if (count === 1) {
      return newValue;
    }
    return alpha * newValue + (1 - alpha) * currentAverage;
  }

  /**
   * Get key for metrics
   */
  private getMetricsKey(modelId: string, taskType?: TaskType): string {
    return taskType ? `${modelId}:${taskType}` : `${modelId}:global`;
  }

  /**
   * Get default metrics structure
   */
  private getDefaultMetrics(key: string): RealTimeMetrics {
    const [modelId, taskType] = key.split(':');

    return {
      modelId,
      taskType: taskType !== 'global' ? (taskType as TaskType) : undefined,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      avgResponseTime: 0,
      avgCost: 0,
      avgQualityScore: 0,
      successRate: 0,
      errorRate: 0,
      throughput: 0,
      lastUsed: new Date(),
      errorPatterns: {},
    };
  }

  /**
   * Get performance summary for model selection (used by DynamicModelSelector)
   */
  async getPerformanceSummary(
    modelId: string,
    taskType?: TaskType
  ): Promise<{
    successRate: number;
    avgResponseTime: number;
    avgCost: number;
    avgQualityScore: number;
    reliability: number;
    sampleSize: number;
  }> {
    const metrics = await this.getMetrics(modelId, taskType);

    return {
      successRate: metrics.successRate,
      avgResponseTime: metrics.avgResponseTime,
      avgCost: metrics.avgCost,
      avgQualityScore: metrics.avgQualityScore,
      reliability: metrics.successRate * (1 - metrics.errorRate), // Combined metric
      sampleSize: metrics.totalRequests,
    };
  }

  /**
   * Get top performing models for a task type across ALL  models
   */
  async getTopPerformingModels(
    taskType: TaskType,
    limit: number = 10,
    minSamples: number = 5
  ): Promise<Array<{ modelId: string; metrics: RealTimeMetrics; score: number }>> {
    const allMetrics = await this.getAllMetrics();
    const taskMetrics: Array<{ modelId: string; metrics: RealTimeMetrics; score: number }> = [];

    for (const [_key, metrics] of Object.entries(allMetrics)) {
      if (metrics.taskType === taskType && metrics.totalRequests >= minSamples) {
        // Calculate composite score
        const score = this.calculateCompositeScore(metrics);
        taskMetrics.push({ modelId: metrics.modelId, metrics, score });
      }
    }

    // Sort by score descending and return top performers
    return taskMetrics.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Calculate composite score for model ranking
   */
  private calculateCompositeScore(metrics: RealTimeMetrics): number {
    // Weighted combination of key metrics
    const weights = {
      successRate: 0.3,
      qualityScore: 0.25,
      costEfficiency: 0.2,
      speed: 0.15,
      reliability: 0.1,
    };

    const costEfficiency = metrics.avgCost > 0 ? 1 / metrics.avgCost : 1; // Lower cost = higher score
    const speed = metrics.avgResponseTime > 0 ? 1000 / metrics.avgResponseTime : 1; // Faster = higher score

    return (
      metrics.successRate * weights.successRate +
      metrics.avgQualityScore * weights.qualityScore +
      costEfficiency * weights.costEfficiency +
      speed * weights.speed +
      metrics.successRate * (1 - metrics.errorRate) * weights.reliability
    );
  }

  /**
   * Clean up old metrics data
   */
  async cleanupOldMetrics(olderThanDays: number = 90): Promise<void> {
    const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let cleaned = 0;

    for (const [key, metrics] of this.metricsStore.entries()) {
      if (metrics.lastUsed.getTime() < cutoffTime) {
        this.metricsStore.delete(key);
        cleaned++;
      }
    }

    log.info({ cleaned, olderThanDays }, 'Cleaned up old performance metrics across all models');
  }

  /**
   * Get performance statistics across entire model ecosystem
   */
  async getEcosystemStats(): Promise<{
    totalModels: number;
    totalRequests: number;
    avgSuccessRate: number;
    topPerformingModel: string;
    mostUsedModel: string;
    avgResponseTime: number;
  }> {
    const allMetrics = await this.getAllMetrics();
    const globalMetrics = Object.values(allMetrics).filter((m) => !m.taskType);

    if (globalMetrics.length === 0) {
      return {
        totalModels: 0,
        totalRequests: 0,
        avgSuccessRate: 0,
        topPerformingModel: '',
        mostUsedModel: '',
        avgResponseTime: 0,
      };
    }

    const totalModels = globalMetrics.length;
    const totalRequests = globalMetrics.reduce((sum, m) => sum + m.totalRequests, 0);
    const avgSuccessRate = globalMetrics.reduce((sum, m) => sum + m.successRate, 0) / totalModels;
    const avgResponseTime =
      globalMetrics.reduce((sum, m) => sum + m.avgResponseTime, 0) / totalModels;

    // Find top performing and most used models
    const sortedByPerformance = globalMetrics.sort(
      (a, b) => this.calculateCompositeScore(b) - this.calculateCompositeScore(a)
    );
    const sortedByUsage = globalMetrics.sort((a, b) => b.totalRequests - a.totalRequests);

    return {
      totalModels,
      totalRequests,
      avgSuccessRate,
      topPerformingModel: sortedByPerformance[0]?.modelId || '',
      mostUsedModel: sortedByUsage[0]?.modelId || '',
      avgResponseTime,
    };
  }
}

// Singleton instance - manages performance tracking for ALL  models
let trackerInstance: ModelPerformanceTracker | null = null;

export function getModelPerformanceTracker(): ModelPerformanceTracker {
  if (!trackerInstance) {
    trackerInstance = new ModelPerformanceTracker();
  }
  return trackerInstance;
}
