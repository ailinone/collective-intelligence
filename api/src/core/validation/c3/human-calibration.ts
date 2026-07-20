// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Human Calibration Framework — Class 3 Validation Infrastructure
 *
 * Provides infrastructure for calibrating automated scorers against
 * human evaluations (P0.3, A.2).
 *
 * Protocol:
 * - 100 samples minimum (stratified by task type)
 * - 3 human annotators per sample
 * - Guideline-based scoring (same 5 dimensions)
 * - Metrics: Pearson r, Krippendorff's alpha, Bland-Altman
 *
 * Criteria:
 * - r(scorer, human) < 0.6 → scorer invalid for learning
 * - Krippendorff α < 0.7 → guideline needs refinement
 * - Target: r >= 0.75
 *
 * STATUS (2026-06-11): STAGED, not wired into the live request path — by
 * design. This calibrates the LLM judge against human labels; it activates
 * when the gated C3 experiment is run with a human-annotation dataset (which
 * does not exist yet). It is NOT dead code: it is the validation mechanism
 * for the production judge (pinned via PRODUCTION_JUDGE_MODEL). Guarded by
 * c3-smoke-test.test.ts. Wire it into the experiment-runner only once a real
 * annotation source exists — forcing it onto the live path now would have no
 * data to calibrate against.
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'human-calibration' });

// ─── Types ──────────────────────────────────────────────────────────────────

/** A sample prepared for human annotation */
export interface CalibrationSample {
  id: string;
  /** The original user prompt */
  prompt: string;
  /** The AI response to evaluate */
  response: string;
  /** Task type for stratification */
  taskType: string;
  /** Complexity level */
  complexity: string;
  /** Heuristic scorer result */
  heuristicScore: number;
  /** LLM-Judge result */
  judgeScore: number | null;
  /** Per-dimension heuristic scores */
  heuristicDimensions: Record<string, number>;
  /** Per-dimension judge scores (if available) */
  judgeDimensions: Record<string, number> | null;
}

/** A single human annotation */
export interface HumanAnnotation {
  sampleId: string;
  annotatorId: string;
  /** Overall quality score (0-1) */
  overallScore: number;
  /** Per-dimension scores */
  dimensions: {
    correctness: number;
    completeness: number;
    clarity: number;
    relevance: number;
  };
  /** Free-text reasoning */
  reasoning: string;
  /** Time spent annotating (seconds) */
  annotationTimeSeconds: number;
  timestamp: Date;
}

/** Calibration result for a scorer */
export interface CalibrationResult {
  /** Scorer being calibrated */
  scorerName: string;
  /** Pearson correlation with human scores */
  pearsonR: number;
  /** Spearman rank correlation */
  spearmanRho: number;
  /** Mean absolute error */
  mae: number;
  /** Root mean squared error */
  rmse: number;
  /** Bias: average (scorer - human) */
  bias: number;
  /** Per-dimension correlations */
  dimensionCorrelations: Record<string, number>;
  /** Sample count used */
  sampleCount: number;
  /** Is this scorer valid for learning? (r >= 0.6) */
  validForLearning: boolean;
  /** Confidence level */
  confidence: 'high' | 'medium' | 'low';
}

/** Inter-rater reliability metrics */
export interface InterRaterReliability {
  /** Krippendorff's alpha */
  krippendorffsAlpha: number;
  /** Average pairwise Pearson r between annotators */
  avgPairwisePearsonR: number;
  /** Whether guideline is adequate (α >= 0.7) */
  guidelineAdequate: boolean;
  /** Number of annotators */
  annotatorCount: number;
  /** Number of samples */
  sampleCount: number;
}

/** Full calibration report */
export interface CalibrationReport {
  /** Heuristic scorer calibration */
  heuristicCalibration: CalibrationResult;
  /** LLM-Judge calibration */
  judgeCalibration: CalibrationResult | null;
  /** Inter-rater reliability */
  interRaterReliability: InterRaterReliability;
  /** Recommendations */
  recommendations: string[];
  /** Overall verdict */
  verdict: 'valid' | 'needs-improvement' | 'invalid';
  timestamp: Date;
}

// ─── Calibration Service ────────────────────────────────────────────────────

export class HumanCalibrationService {
  private samples: CalibrationSample[] = [];
  private annotations: HumanAnnotation[] = [];

  /**
   * Add a sample for human annotation
   */
  addSample(sample: CalibrationSample): void {
    this.samples.push(sample);
  }

  /**
   * Record a human annotation
   */
  recordAnnotation(annotation: HumanAnnotation): void {
    this.annotations.push(annotation);
  }

  /**
   * Get samples needing annotation (not yet annotated by 3 people)
   */
  getSamplesNeedingAnnotation(minAnnotators = 3): CalibrationSample[] {
    const annotationCounts = new Map<string, number>();
    for (const a of this.annotations) {
      annotationCounts.set(a.sampleId, (annotationCounts.get(a.sampleId) ?? 0) + 1);
    }
    return this.samples.filter(s => (annotationCounts.get(s.id) ?? 0) < minAnnotators);
  }

  /**
   * Generate the full calibration report
   */
  generateReport(): CalibrationReport | null {
    // Need at least 20 samples with 3 annotations each
    const fullyAnnotated = this.getFullyAnnotatedSamples();
    if (fullyAnnotated.length < 20) {
      log.warn({ fullyAnnotated: fullyAnnotated.length }, 'Insufficient annotations for calibration');
      return null;
    }

    // Compute human consensus scores (average of annotators)
    const humanScores = fullyAnnotated.map(s => this.computeConsensusScore(s.id));

    // Calibrate heuristic scorer
    const heuristicScores = fullyAnnotated.map(s => s.heuristicScore);
    const humanOverall = humanScores.map(h => h.overall);
    const heuristicCalibration = this.computeCalibration('heuristic', heuristicScores, humanOverall, fullyAnnotated, humanScores);

    // Calibrate LLM-Judge (if available)
    const samplesWithJudge = fullyAnnotated.filter(s => s.judgeScore !== null);
    let judgeCalibration: CalibrationResult | null = null;
    if (samplesWithJudge.length >= 20) {
      const judgeScores = samplesWithJudge.map(s => s.judgeScore!);
      const judgeHumanScores = samplesWithJudge.map(s => this.computeConsensusScore(s.id).overall);
      judgeCalibration = this.computeCalibration('llm-judge', judgeScores, judgeHumanScores, samplesWithJudge, humanScores);
    }

    // Compute inter-rater reliability
    const interRaterReliability = this.computeInterRaterReliability(fullyAnnotated);

    // Generate recommendations
    const recommendations: string[] = [];
    if (heuristicCalibration.pearsonR < 0.6) {
      recommendations.push('CRITICAL: Heuristic scorer has r < 0.6 with humans — INVALID for learning');
    }
    if (judgeCalibration && judgeCalibration.pearsonR < 0.6) {
      recommendations.push('CRITICAL: LLM-Judge has r < 0.6 with humans — INVALID for learning');
    }
    if (!interRaterReliability.guidelineAdequate) {
      recommendations.push('WARNING: Krippendorff α < 0.7 — annotation guideline needs refinement');
    }
    if (Math.abs(heuristicCalibration.bias) > 0.1) {
      recommendations.push(`Heuristic scorer has systematic bias of ${heuristicCalibration.bias > 0 ? '+' : ''}${heuristicCalibration.bias.toFixed(3)}`);
    }
    if (judgeCalibration && judgeCalibration.pearsonR > heuristicCalibration.pearsonR + 0.1) {
      recommendations.push('LLM-Judge is significantly more aligned with humans than heuristic — prioritize judge for learning');
    }

    // Overall verdict
    const bestR = judgeCalibration
      ? Math.max(heuristicCalibration.pearsonR, judgeCalibration.pearsonR)
      : heuristicCalibration.pearsonR;
    const verdict: CalibrationReport['verdict'] = bestR >= 0.75
      ? 'valid'
      : bestR >= 0.6
        ? 'needs-improvement'
        : 'invalid';

    return {
      heuristicCalibration,
      judgeCalibration,
      interRaterReliability,
      recommendations,
      verdict,
      timestamp: new Date(),
    };
  }

  private getFullyAnnotatedSamples(minAnnotators = 3): CalibrationSample[] {
    const annotationCounts = new Map<string, number>();
    for (const a of this.annotations) {
      annotationCounts.set(a.sampleId, (annotationCounts.get(a.sampleId) ?? 0) + 1);
    }
    return this.samples.filter(s => (annotationCounts.get(s.id) ?? 0) >= minAnnotators);
  }

  private computeConsensusScore(sampleId: string): { overall: number; dimensions: Record<string, number> } {
    const sampleAnnotations = this.annotations.filter(a => a.sampleId === sampleId);
    if (sampleAnnotations.length === 0) {
      return { overall: 0, dimensions: {} };
    }

    const overall = sampleAnnotations.reduce((s, a) => s + a.overallScore, 0) / sampleAnnotations.length;
    const dimensions: Record<string, number> = {};
    for (const dim of ['correctness', 'completeness', 'clarity', 'relevance'] as const) {
      dimensions[dim] = sampleAnnotations.reduce((s, a) => s + a.dimensions[dim], 0) / sampleAnnotations.length;
    }

    return { overall, dimensions };
  }

  private computeCalibration(
    scorerName: string,
    scorerScores: number[],
    humanScores: number[],
    samples: CalibrationSample[],
    humanConsensus: Array<{ overall: number; dimensions: Record<string, number> }>
  ): CalibrationResult {
    const pearsonR = this.pearson(scorerScores, humanScores);
    const spearmanRho = this.spearman(scorerScores, humanScores);

    // MAE and RMSE
    let maeSum = 0, rmseSum = 0, biasSum = 0;
    for (let i = 0; i < scorerScores.length; i++) {
      const diff = scorerScores[i] - humanScores[i];
      maeSum += Math.abs(diff);
      rmseSum += diff * diff;
      biasSum += diff;
    }
    const mae = maeSum / scorerScores.length;
    const rmse = Math.sqrt(rmseSum / scorerScores.length);
    const bias = biasSum / scorerScores.length;

    // Per-dimension correlations
    const dimensionCorrelations: Record<string, number> = {};
    for (const dim of ['correctness', 'completeness', 'clarity', 'relevance']) {
      const scorerDim = samples.map(s => {
        if (scorerName === 'heuristic') return s.heuristicDimensions[dim] ?? 0;
        return s.judgeDimensions?.[dim] ?? 0;
      });
      const humanDim = humanConsensus.map(h => h.dimensions[dim] ?? 0);
      dimensionCorrelations[dim] = this.pearson(scorerDim, humanDim);
    }

    const validForLearning = pearsonR >= 0.6;
    const confidence: 'high' | 'medium' | 'low' = scorerScores.length >= 100
      ? 'high'
      : scorerScores.length >= 50
        ? 'medium'
        : 'low';

    return {
      scorerName,
      pearsonR,
      spearmanRho,
      mae,
      rmse,
      bias,
      dimensionCorrelations,
      sampleCount: scorerScores.length,
      validForLearning,
      confidence,
    };
  }

  private computeInterRaterReliability(samples: CalibrationSample[]): InterRaterReliability {
    // Get all annotator IDs
    const annotatorIds = [...new Set(this.annotations.map(a => a.annotatorId))];
    const annotatorCount = annotatorIds.length;

    // Compute average pairwise Pearson r
    const pairwiseCorrelations: number[] = [];
    for (let i = 0; i < annotatorIds.length; i++) {
      for (let j = i + 1; j < annotatorIds.length; j++) {
        const aScores: number[] = [];
        const bScores: number[] = [];
        for (const sample of samples) {
          const aAnnotation = this.annotations.find(a => a.sampleId === sample.id && a.annotatorId === annotatorIds[i]);
          const bAnnotation = this.annotations.find(a => a.sampleId === sample.id && a.annotatorId === annotatorIds[j]);
          if (aAnnotation && bAnnotation) {
            aScores.push(aAnnotation.overallScore);
            bScores.push(bAnnotation.overallScore);
          }
        }
        if (aScores.length >= 10) {
          pairwiseCorrelations.push(this.pearson(aScores, bScores));
        }
      }
    }

    const avgPairwisePearsonR = pairwiseCorrelations.length > 0
      ? pairwiseCorrelations.reduce((a, b) => a + b, 0) / pairwiseCorrelations.length
      : 0;

    // Simplified Krippendorff's alpha (using interval metric)
    const krippendorffsAlpha = this.computeKrippendorffsAlpha(samples);

    return {
      krippendorffsAlpha,
      avgPairwisePearsonR,
      guidelineAdequate: krippendorffsAlpha >= 0.7,
      annotatorCount,
      sampleCount: samples.length,
    };
  }

  private computeKrippendorffsAlpha(samples: CalibrationSample[]): number {
    // Simplified computation for interval data
    // α = 1 - (observed disagreement / expected disagreement)
    const allScores: number[] = [];
    let observedDisagreement = 0;
    let pairCount = 0;

    for (const sample of samples) {
      const sampleAnnotations = this.annotations.filter(a => a.sampleId === sample.id);
      if (sampleAnnotations.length < 2) continue;

      for (let i = 0; i < sampleAnnotations.length; i++) {
        allScores.push(sampleAnnotations[i].overallScore);
        for (let j = i + 1; j < sampleAnnotations.length; j++) {
          observedDisagreement += (sampleAnnotations[i].overallScore - sampleAnnotations[j].overallScore) ** 2;
          pairCount++;
        }
      }
    }

    if (pairCount === 0 || allScores.length < 2) return 0;

    observedDisagreement /= pairCount;

    // Expected disagreement (variance of all scores)
    const mean = allScores.reduce((a, b) => a + b, 0) / allScores.length;
    const expectedDisagreement = allScores.reduce((s, x) => s + (x - mean) ** 2, 0) / (allScores.length - 1);

    if (expectedDisagreement === 0) return 1;

    return 1 - observedDisagreement / expectedDisagreement;
  }

  private pearson(x: number[], y: number[]): number {
    const n = x.length;
    if (n < 2) return 0;
    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - mx, dy = y[i] - my;
      num += dx * dy;
      dx2 += dx * dx;
      dy2 += dy * dy;
    }
    const denom = Math.sqrt(dx2 * dy2);
    return denom === 0 ? 0 : num / denom;
  }

  private spearman(x: number[], y: number[]): number {
    const rank = (arr: number[]): number[] => {
      const sorted = [...arr].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
      const ranks = new Array<number>(arr.length);
      for (let i = 0; i < sorted.length; i++) {
        ranks[sorted[i].i] = i + 1;
      }
      return ranks;
    };
    return this.pearson(rank(x), rank(y));
  }
}

/** Singleton */
let calibrationInstance: HumanCalibrationService | null = null;
export function getHumanCalibrationService(): HumanCalibrationService {
  if (!calibrationInstance) {
    calibrationInstance = new HumanCalibrationService();
  }
  return calibrationInstance;
}
