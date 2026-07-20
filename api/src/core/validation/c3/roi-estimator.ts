// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ROI Estimator — Class 3 Validation Infrastructure
 *
 * Estimates the cost-benefit of CI vs single-model per domain (P1.6, G.1-G.3).
 * The system must stop treating CI as universally desirable.
 *
 * From the audit:
 * - CI costs ~4x more for +2.0pp (not significant)
 * - Documentation: CI is significantly worse (-12.6pp, p=0.030)
 * - Creative: CI is equivalent (+0.6pp, negligible)
 * - Coding: weak positive trend (+3.7pp, not significant)
 */

import { logger } from '@/utils/logger';

const _log = logger.child({ component: 'roi-estimator' });

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DomainROI {
  domain: string;
  /** Average quality for CI in this domain */
  avgQualityCI: number;
  /** Average quality for single-model in this domain */
  avgQualitySingle: number;
  /** Quality delta (CI - single) */
  qualityDelta: number;
  /** Average cost ratio (CI / single) */
  costRatio: number;
  /** Average latency ratio (CI / single) */
  latencyRatio: number;
  /** Quality per dollar for CI */
  qualityPerDollarCI: number;
  /** Quality per dollar for single */
  qualityPerDollarSingle: number;
  /** ROI: quality gain per additional dollar spent */
  roi: number;
  /** Break-even quality delta needed to justify CI cost */
  breakEvenDelta: number;
  /** Recommendation */
  recommendation: 'ci' | 'single' | 'conditional';
  /** Confidence in this recommendation */
  confidence: 'high' | 'medium' | 'low';
  /** Sample sizes */
  sampleSizeCI: number;
  sampleSizeSingle: number;
  /** P-value of quality delta (if available) */
  pValue: number | null;
  /** Cohen's d effect size (if available) */
  effectSize: number | null;
}

export interface ROIReport {
  /** Per-domain ROI analysis */
  domains: DomainROI[];
  /** Overall recommendation map: domain → routing decision */
  routingPolicy: Record<string, 'ci' | 'single' | 'conditional'>;
  /** Summary statistics */
  summary: {
    domainsWhereCI: string[];
    domainsWhereSingle: string[];
    domainsConditional: string[];
    overallROI: number;
  };
  timestamp: Date;
}

export interface ExecutionDataPoint {
  domain: string;
  taskType: string;
  complexity: string;
  mode: 'ci' | 'single';
  qualityScore: number;
  costUsd: number;
  latencyMs: number;
}

// ─── ROI Estimator ──────────────────────────────────────────────────────────

export class ROIEstimator {
  private dataPoints: ExecutionDataPoint[] = [];
  /** Per-domain recommendation cache for the routing hot path (P1-1). */
  private recommendationCache = new Map<string, { rec: DomainROI | null; at: number }>();
  private static readonly REC_CACHE_TTL_MS = 60_000;
  /**
   * Bound the in-memory window: the estimator is fed on every production
   * request (orchestration-engine learning path), so an unbounded array is a
   * slow leak in a long-running process. 50k points ≈ days of evidence at
   * production rates and keeps domain scans cheap.
   */
  private static readonly MAX_POINTS = 50_000;

  /**
   * Ingest an execution data point for ROI analysis
   */
  addDataPoint(point: ExecutionDataPoint): void {
    this.dataPoints.push(point);
    if (this.dataPoints.length > ROIEstimator.MAX_POINTS) {
      // Drop the oldest 10% in one splice (amortized O(1) per insert).
      this.dataPoints.splice(0, Math.floor(ROIEstimator.MAX_POINTS * 0.1));
    }
  }

  /**
   * Lightweight per-domain read API for the routing hot path (P1-1).
   * Computes the domain ROI on demand and caches it for 60s so the
   * orchestration engine can consult routing recommendations per request
   * without paying a full-report scan.
   */
  getDomainRecommendation(domain: string): DomainROI | null {
    const cached = this.recommendationCache.get(domain);
    if (cached && Date.now() - cached.at < ROIEstimator.REC_CACHE_TTL_MS) {
      return cached.rec;
    }
    const points = this.dataPoints.filter(p => p.domain === domain);
    const rec = this.computeDomainROI(domain, points);
    this.recommendationCache.set(domain, { rec, at: Date.now() });
    return rec;
  }

  /**
   * Ingest multiple data points
   */
  addDataPoints(points: ExecutionDataPoint[]): void {
    this.dataPoints.push(...points);
  }

  /**
   * Generate a comprehensive ROI report across all domains
   */
  generateReport(): ROIReport {
    // Group by domain
    const domains = new Map<string, ExecutionDataPoint[]>();
    for (const point of this.dataPoints) {
      const existing = domains.get(point.domain) ?? [];
      existing.push(point);
      domains.set(point.domain, existing);
    }

    const domainROIs: DomainROI[] = [];
    for (const [domain, points] of domains) {
      const roi = this.computeDomainROI(domain, points);
      if (roi) domainROIs.push(roi);
    }

    // Build routing policy
    const routingPolicy: Record<string, 'ci' | 'single' | 'conditional'> = {};
    for (const roi of domainROIs) {
      routingPolicy[roi.domain] = roi.recommendation;
    }

    // Summary
    const domainsWhereCI = domainROIs.filter(r => r.recommendation === 'ci').map(r => r.domain);
    const domainsWhereSingle = domainROIs.filter(r => r.recommendation === 'single').map(r => r.domain);
    const domainsConditional = domainROIs.filter(r => r.recommendation === 'conditional').map(r => r.domain);
    const overallROI = domainROIs.length > 0
      ? domainROIs.reduce((s, r) => s + r.roi, 0) / domainROIs.length
      : 0;

    return {
      domains: domainROIs,
      routingPolicy,
      summary: {
        domainsWhereCI,
        domainsWhereSingle,
        domainsConditional,
        overallROI,
      },
      timestamp: new Date(),
    };
  }

  private computeDomainROI(domain: string, points: ExecutionDataPoint[]): DomainROI | null {
    const ciPoints = points.filter(p => p.mode === 'ci');
    const singlePoints = points.filter(p => p.mode === 'single');

    if (ciPoints.length < 3 || singlePoints.length < 3) return null;

    const avgQualityCI = ciPoints.reduce((s, p) => s + p.qualityScore, 0) / ciPoints.length;
    const avgQualitySingle = singlePoints.reduce((s, p) => s + p.qualityScore, 0) / singlePoints.length;
    const avgCostCI = ciPoints.reduce((s, p) => s + p.costUsd, 0) / ciPoints.length;
    const avgCostSingle = singlePoints.reduce((s, p) => s + p.costUsd, 0) / singlePoints.length;
    const avgLatencyCI = ciPoints.reduce((s, p) => s + p.latencyMs, 0) / ciPoints.length;
    const avgLatencySingle = singlePoints.reduce((s, p) => s + p.latencyMs, 0) / singlePoints.length;

    const qualityDelta = avgQualityCI - avgQualitySingle;
    const costRatio = avgCostSingle > 0 ? avgCostCI / avgCostSingle : 1;
    const latencyRatio = avgLatencySingle > 0 ? avgLatencyCI / avgLatencySingle : 1;
    const qualityPerDollarCI = avgCostCI > 0 ? avgQualityCI / avgCostCI : 0;
    const qualityPerDollarSingle = avgCostSingle > 0 ? avgQualitySingle / avgCostSingle : 0;

    // ROI: quality gain per additional dollar
    const additionalCost = avgCostCI - avgCostSingle;
    const roi = additionalCost > 0 ? qualityDelta / additionalCost : 0;

    // Break-even: what quality delta would justify the cost?
    const breakEvenDelta = costRatio > 1 ? avgQualitySingle * (costRatio - 1) / costRatio : 0;

    // Statistical significance (basic Welch's t-test)
    const { pValue, effectSize } = this.basicSignificanceTest(
      ciPoints.map(p => p.qualityScore),
      singlePoints.map(p => p.qualityScore)
    );

    // Recommendation logic
    let recommendation: 'ci' | 'single' | 'conditional';
    let confidence: 'high' | 'medium' | 'low';

    if (pValue !== null && pValue < 0.05) {
      // Statistically significant
      if (qualityDelta > breakEvenDelta) {
        recommendation = 'ci';
        confidence = 'high';
      } else if (qualityDelta < -0.02) {
        recommendation = 'single';
        confidence = 'high';
      } else {
        recommendation = 'single'; // CI better but not enough to justify cost
        confidence = 'medium';
      }
    } else {
      // Not statistically significant
      if (qualityDelta > 0.05) {
        recommendation = 'conditional';
        confidence = 'low';
      } else if (qualityDelta < -0.02) {
        recommendation = 'single';
        confidence = 'medium';
      } else {
        recommendation = 'single'; // No evidence CI helps, and it costs more
        confidence = 'low';
      }
    }

    return {
      domain,
      avgQualityCI,
      avgQualitySingle,
      qualityDelta,
      costRatio,
      latencyRatio,
      qualityPerDollarCI,
      qualityPerDollarSingle,
      roi,
      breakEvenDelta,
      recommendation,
      confidence,
      sampleSizeCI: ciPoints.length,
      sampleSizeSingle: singlePoints.length,
      pValue,
      effectSize,
    };
  }

  private basicSignificanceTest(
    groupA: number[],
    groupB: number[]
  ): { pValue: number | null; effectSize: number | null } {
    if (groupA.length < 5 || groupB.length < 5) {
      return { pValue: null, effectSize: null };
    }

    const meanA = groupA.reduce((a, b) => a + b, 0) / groupA.length;
    const meanB = groupB.reduce((a, b) => a + b, 0) / groupB.length;
    const varA = groupA.reduce((s, x) => s + (x - meanA) ** 2, 0) / (groupA.length - 1);
    const varB = groupB.reduce((s, x) => s + (x - meanB) ** 2, 0) / (groupB.length - 1);

    // Welch's t-test
    const se = Math.sqrt(varA / groupA.length + varB / groupB.length);
    if (se === 0) return { pValue: null, effectSize: null };
    const t = (meanA - meanB) / se;

    // Approximate p-value using normal distribution for large samples
    const pValue = 2 * (1 - this.normalCDF(Math.abs(t)));

    // Cohen's d
    const pooledSD = Math.sqrt(((groupA.length - 1) * varA + (groupB.length - 1) * varB) / (groupA.length + groupB.length - 2));
    const effectSize = pooledSD > 0 ? (meanA - meanB) / pooledSD : 0;

    return { pValue, effectSize };
  }

  private normalCDF(x: number): number {
    // Approximation of the standard normal CDF
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
  }
}

/** Singleton */
let estimatorInstance: ROIEstimator | null = null;
export function getROIEstimator(): ROIEstimator {
  if (!estimatorInstance) {
    estimatorInstance = new ROIEstimator();
  }
  return estimatorInstance;
}
