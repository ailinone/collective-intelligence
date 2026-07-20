// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Reward Hacking Detector — Class 3 Validation Infrastructure
 *
 * Monitors divergence between heuristic scorer and LLM-Judge to detect
 * reward hacking (A.3). If the heuristic rewards formatting/length while
 * the judge rewards substance, the divergence will grow over time.
 *
 * Also detects:
 * - Padding inflation (token count rises without quality improvement)
 * - Formatting inflation (headings/code blocks rise without quality)
 * - Verbosity gaming (longer responses score higher without being better)
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'reward-hacking-detector' });

// ─── Types ──────────────────────────────────────────────────────────────────

interface ScoringPair {
  heuristicScore: number;
  judgeScore: number;
  tokenCount: number;
  headingsCount: number;
  codeBlocksCount: number;
  contentLength: number;
  timestamp: number;
}

export interface RewardHackingReport {
  /** Pearson correlation between heuristic and judge scores */
  correlation: number;
  /** Whether correlation is below alarm threshold */
  correlationAlarm: boolean;
  /** Mean absolute divergence */
  meanDivergence: number;
  /** Whether mean divergence exceeds threshold */
  divergenceAlarm: boolean;
  /** Token inflation: avg tokens trending up without quality increase */
  tokenInflation: boolean;
  /** Formatting inflation: headings/code blocks increasing without quality */
  formattingInflation: boolean;
  /** Sample count in the current window */
  sampleCount: number;
  /** Timestamp of the report */
  timestamp: Date;
}

// ─── Reward Hacking Detector ────────────────────────────────────────────────

export class RewardHackingDetector {
  /** Sliding window of scoring pairs */
  private window: ScoringPair[] = [];
  private maxWindowSize: number;
  private correlationAlarmThreshold: number;
  private divergenceAlarmThreshold: number;

  constructor(options?: {
    windowSize?: number;
    correlationAlarmThreshold?: number;
    divergenceAlarmThreshold?: number;
  }) {
    this.maxWindowSize = options?.windowSize ?? 200;
    this.correlationAlarmThreshold = options?.correlationAlarmThreshold ?? 0.5;
    this.divergenceAlarmThreshold = options?.divergenceAlarmThreshold ?? 0.25;
  }

  /**
   * Record a scoring pair (heuristic + judge for the same response)
   */
  record(pair: {
    heuristicScore: number;
    judgeScore: number;
    tokenCount: number;
    headingsCount: number;
    codeBlocksCount: number;
    contentLength: number;
  }): void {
    this.window.push({
      ...pair,
      timestamp: Date.now(),
    });

    // Trim window
    if (this.window.length > this.maxWindowSize) {
      this.window = this.window.slice(-this.maxWindowSize);
    }
  }

  /**
   * Generate a reward hacking report from the current window
   */
  getReport(): RewardHackingReport {
    if (this.window.length < 10) {
      return {
        correlation: 1.0,
        correlationAlarm: false,
        meanDivergence: 0,
        divergenceAlarm: false,
        tokenInflation: false,
        formattingInflation: false,
        sampleCount: this.window.length,
        timestamp: new Date(),
      };
    }

    const heuristic = this.window.map(p => p.heuristicScore);
    const judge = this.window.map(p => p.judgeScore);

    const correlation = this.pearsonCorrelation(heuristic, judge);
    const meanDivergence = this.window.reduce(
      (sum, p) => sum + Math.abs(p.heuristicScore - p.judgeScore), 0
    ) / this.window.length;

    // Detect token inflation
    const tokenInflation = this.detectInflation(
      this.window.map(p => p.tokenCount),
      judge,
      0.2, // 20% increase threshold
    );

    // Detect formatting inflation
    const formattingScores = this.window.map(p => p.headingsCount + p.codeBlocksCount);
    const formattingInflation = this.detectInflation(formattingScores, judge, 0.2);

    const report: RewardHackingReport = {
      correlation,
      correlationAlarm: correlation < this.correlationAlarmThreshold,
      meanDivergence,
      divergenceAlarm: meanDivergence > this.divergenceAlarmThreshold,
      tokenInflation,
      formattingInflation,
      sampleCount: this.window.length,
      timestamp: new Date(),
    };

    if (report.correlationAlarm || report.divergenceAlarm) {
      log.warn(report, 'Reward hacking alarm triggered');
    }

    return report;
  }

  /**
   * Check if there's any active alarm
   */
  hasAlarm(): boolean {
    const report = this.getReport();
    return report.correlationAlarm || report.divergenceAlarm
      || report.tokenInflation || report.formattingInflation;
  }

  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    if (n < 2) return 1.0;

    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let num = 0, denomX = 0, denomY = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      num += dx * dy;
      denomX += dx * dx;
      denomY += dy * dy;
    }

    const denom = Math.sqrt(denomX * denomY);
    return denom === 0 ? 0 : num / denom;
  }

  /**
   * Detect inflation: metric rising while quality (judge) stays flat or drops.
   * Compares first half vs second half of the window.
   */
  private detectInflation(
    metric: number[],
    quality: number[],
    threshold: number
  ): boolean {
    const half = Math.floor(metric.length / 2);
    if (half < 5) return false;

    const firstMetric = metric.slice(0, half);
    const secondMetric = metric.slice(half);
    const firstQuality = quality.slice(0, half);
    const secondQuality = quality.slice(half);

    const avgMetricFirst = firstMetric.reduce((a, b) => a + b, 0) / firstMetric.length;
    const avgMetricSecond = secondMetric.reduce((a, b) => a + b, 0) / secondMetric.length;
    const avgQualityFirst = firstQuality.reduce((a, b) => a + b, 0) / firstQuality.length;
    const avgQualitySecond = secondQuality.reduce((a, b) => a + b, 0) / secondQuality.length;

    // Inflation = metric rises significantly while quality doesn't
    const metricRise = avgMetricFirst > 0
      ? (avgMetricSecond - avgMetricFirst) / avgMetricFirst
      : 0;
    const qualityChange = avgQualityFirst > 0
      ? (avgQualitySecond - avgQualityFirst) / avgQualityFirst
      : 0;

    return metricRise > threshold && qualityChange < threshold / 2;
  }
}

/** Singleton */
let detectorInstance: RewardHackingDetector | null = null;
export function getRewardHackingDetector(): RewardHackingDetector {
  if (!detectorInstance) {
    detectorInstance = new RewardHackingDetector();
  }
  return detectorInstance;
}
