// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Enterprise Performance Monitor for Model Selection
 *
 * Monitors and optimizes model selection performance with detailed metrics,
 * alerting, and automatic optimization recommendations.
 */

import { logger } from '@/utils/logger';
import { getModelSelectionCache } from './model-selection-cache';

const log = logger.child({ component: 'performance-monitor' });

/**
 * Performance metrics for model selection
 */
import type { SelectionCriteria } from './dynamic-model-selector';

interface SelectionMetrics {
  requestId: string;
  timestamp: number;
  duration: number;
  criteria: SelectionCriteria;
  modelsFound: number;
  modelsSelected: number;
  cacheHits: number;
  cacheMisses: number;
  databaseQueries: number;
  validationErrors: number;
  strategy: string;
  result: 'success' | 'error' | 'timeout';
  error?: string;
}

/**
 * Performance thresholds and alerts
 */
interface PerformanceThresholds {
  maxSelectionTime: number; // Max time for model selection (ms)
  maxDatabaseQueries: number; // Max database queries per selection
  minCacheHitRate: number; // Minimum cache hit rate
  maxValidationErrors: number; // Max validation errors per minute
  alertCooldown: number; // Cooldown between alerts (ms)
}

/**
 * Performance statistics
 */
interface PerformanceStats {
  totalSelections: number;
  averageSelectionTime: number;
  cacheHitRate: number;
  errorRate: number;
  peakLoadTime: number;
  databaseLoad: number;
  alertsTriggered: number;
  uptime: number;
}

/**
 * Enterprise performance monitor
 */
export class ModelSelectionPerformanceMonitor {
  private metrics: SelectionMetrics[] = [];
  private readonly maxMetricsHistory = 10000; // Keep last 10k metrics
  private thresholds: PerformanceThresholds;
  private stats: PerformanceStats;
  private lastAlertTime = 0;
  private readonly cache = getModelSelectionCache();

  constructor(thresholds?: Partial<PerformanceThresholds>) {
    this.thresholds = {
      maxSelectionTime: thresholds?.maxSelectionTime || 5000, // 5 seconds
      maxDatabaseQueries: thresholds?.maxDatabaseQueries || 5,
      minCacheHitRate: thresholds?.minCacheHitRate || 0.7, // 70%
      maxValidationErrors: thresholds?.maxValidationErrors || 10,
      alertCooldown: thresholds?.alertCooldown || 300000, // 5 minutes
    };

    this.stats = {
      totalSelections: 0,
      averageSelectionTime: 0,
      cacheHitRate: 0,
      errorRate: 0,
      peakLoadTime: 0,
      databaseLoad: 0,
      alertsTriggered: 0,
      uptime: Date.now(),
    };

    log.info({ thresholds: this.thresholds }, 'Performance monitor initialized');
  }

  /**
   * Record model selection performance metrics
   */
  recordSelection(metrics: Omit<SelectionMetrics, 'timestamp'>): void {
    const fullMetrics: SelectionMetrics = {
      ...metrics,
      timestamp: Date.now(),
    };

    this.metrics.push(fullMetrics);

    // Maintain history limit
    if (this.metrics.length > this.maxMetricsHistory) {
      this.metrics = this.metrics.slice(-this.maxMetricsHistory);
    }

    // Update statistics
    this.updateStats();

    // Check thresholds and alert if needed
    this.checkThresholds(fullMetrics);

    log.debug(
      {
        requestId: metrics.requestId,
        duration: metrics.duration,
        modelsSelected: metrics.modelsSelected,
        result: metrics.result,
      },
      'Selection performance recorded'
    );
  }

  /**
   * Get current performance statistics
   */
  getStats(): PerformanceStats {
    const cacheStats = this.cache.getStats();
    const recentMetrics = this.getRecentMetrics(100); // Last 100 selections

    const _totalTime = recentMetrics.reduce((sum, m) => sum + m.duration, 0);
    const errorCount = recentMetrics.filter((m) => m.result === 'error').length;

    return {
      ...this.stats,
      cacheHitRate: cacheStats.hitRate,
      errorRate: recentMetrics.length > 0 ? errorCount / recentMetrics.length : 0,
      databaseLoad:
        recentMetrics.reduce((sum, m) => sum + m.databaseQueries, 0) /
        Math.max(recentMetrics.length, 1),
    };
  }

  /**
   * Get performance recommendations
   */
  getRecommendations(): string[] {
    const recommendations: string[] = [];
    const stats = this.getStats();
    const cacheStats = this.cache.getStats();

    // Cache recommendations
    if (cacheStats.hitRate < this.thresholds.minCacheHitRate) {
      recommendations.push(
        `Cache hit rate (${(cacheStats.hitRate * 100).toFixed(1)}%) is below threshold. Consider increasing cache TTL or size.`
      );
    }

    // Performance recommendations
    if (stats.averageSelectionTime > this.thresholds.maxSelectionTime) {
      recommendations.push(
        `Average selection time (${stats.averageSelectionTime.toFixed(0)}ms) exceeds threshold. Consider optimizing database queries.`
      );
    }

    // Database load recommendations
    if (stats.databaseLoad > this.thresholds.maxDatabaseQueries) {
      recommendations.push(
        `Database load (${stats.databaseLoad.toFixed(1)} queries/selection) is high. Consider implementing more aggressive caching.`
      );
    }

    // Error rate recommendations
    if (stats.errorRate > 0.05) {
      // 5% error rate
      recommendations.push(
        `Error rate (${(stats.errorRate * 100).toFixed(1)}%) is high. Check validation logic and error handling.`
      );
    }

    return recommendations;
  }

  /**
   * Get recent metrics
   */
  private getRecentMetrics(count: number): SelectionMetrics[] {
    return this.metrics.slice(-count);
  }

  /**
   * Update rolling statistics
   */
  private updateStats(): void {
    const recentMetrics = this.getRecentMetrics(1000); // Last 1000 selections

    if (recentMetrics.length === 0) return;

    const totalTime = recentMetrics.reduce((sum, m) => sum + m.duration, 0);
    this.stats.averageSelectionTime = totalTime / recentMetrics.length;
    this.stats.totalSelections = this.metrics.length;

    // Track peak load time
    const maxTime = Math.max(...recentMetrics.map((m) => m.duration));
    this.stats.peakLoadTime = Math.max(this.stats.peakLoadTime, maxTime);
  }

  /**
   * Check performance thresholds and trigger alerts
   */
  private checkThresholds(metrics: SelectionMetrics): void {
    const now = Date.now();
    const alerts: string[] = [];

    // Check selection time
    if (metrics.duration > this.thresholds.maxSelectionTime) {
      alerts.push(
        `Selection time (${metrics.duration}ms) exceeded threshold (${this.thresholds.maxSelectionTime}ms)`
      );
    }

    // Check database queries
    if (metrics.databaseQueries > this.thresholds.maxDatabaseQueries) {
      alerts.push(
        `Database queries (${metrics.databaseQueries}) exceeded threshold (${this.thresholds.maxDatabaseQueries})`
      );
    }

    // Check validation errors
    if (metrics.validationErrors > this.thresholds.maxValidationErrors) {
      alerts.push(
        `Validation errors (${metrics.validationErrors}) exceeded threshold (${this.thresholds.maxValidationErrors})`
      );
    }

    // Trigger alerts if any thresholds exceeded and cooldown passed
    if (alerts.length > 0 && now - this.lastAlertTime > this.thresholds.alertCooldown) {
      this.lastAlertTime = now;
      this.stats.alertsTriggered++;

      const alertPayload = {
        requestId: metrics.requestId,
        alerts,
        metrics,
        stats: this.getStats(),
      };
      if (process.env.NODE_ENV === 'production') {
        log.warn(alertPayload, 'PERFORMANCE ALERT: Model selection thresholds exceeded');
      } else {
        log.info(alertPayload, 'Performance thresholds exceeded in development');
      }

      // In production, this could trigger:
      // - Email alerts to DevOps
      // - Slack notifications
      // - Auto-scaling triggers
      // - Circuit breaker activation
    }
  }

  /**
   * Reset statistics (for testing)
   */
  reset(): void {
    this.metrics = [];
    this.stats = {
      totalSelections: 0,
      averageSelectionTime: 0,
      cacheHitRate: 0,
      errorRate: 0,
      peakLoadTime: 0,
      databaseLoad: 0,
      alertsTriggered: 0,
      uptime: Date.now(),
    };
    this.lastAlertTime = 0;
    log.info('Performance monitor reset');
  }

  /**
   * Export metrics for analysis
   */
  exportMetrics(): SelectionMetrics[] {
    return [...this.metrics];
  }
}

/**
 * Global performance monitor instance
 */
let globalMonitor: ModelSelectionPerformanceMonitor | null = null;

/**
 * Get or create global performance monitor
 */
export function getPerformanceMonitor(): ModelSelectionPerformanceMonitor {
  if (!globalMonitor) {
    globalMonitor = new ModelSelectionPerformanceMonitor({
      maxSelectionTime: parseInt(process.env.PERFORMANCE_MAX_SELECTION_TIME || '5000'),
      maxDatabaseQueries: parseInt(process.env.PERFORMANCE_MAX_DB_QUERIES || '5'),
      minCacheHitRate: parseFloat(process.env.PERFORMANCE_MIN_CACHE_HIT_RATE || '0.7'),
      maxValidationErrors: parseInt(process.env.PERFORMANCE_MAX_VALIDATION_ERRORS || '10'),
      alertCooldown: parseInt(process.env.PERFORMANCE_ALERT_COOLDOWN || '300000'),
    });
  }
  return globalMonitor;
}

/**
 * Reset global performance monitor
 */
export function resetPerformanceMonitor(): void {
  if (globalMonitor) {
    globalMonitor.reset();
  }
}
