// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Triage Calibrator (OI-07)
 *
 * Self-improving triage system that learns from execution outcomes to detect
 * and correct systematic misclassifications.
 *
 * Rationale:
 * - Triage classifies requests into (taskType, complexity) before execution
 * - If the classification is wrong, the wrong strategy runs → wasted cost/quality
 * - Agents can game their own evaluators — triage can be systematically biased
 * - Variable compute allocation matters — complexity misclassification
 *   means too much or too little compute is allocated
 *
 * How it works:
 * 1. OBSERVE: Record (triage prediction, execution outcome) pairs
 * 2. DETECT: Find systematic patterns where predictions diverge from outcomes
 *    - Complexity underestimation: triage says "low" but quality < 0.5 (needed more compute)
 *    - Complexity overestimation: triage says "high" but single strategy achieves > 0.9
 *    - TaskType mismatch: triage says "code-generation" but "debugging" strategy wins
 * 3. CORRECT: Generate lightweight correction rules that override triage in known-bad cases
 * 4. MEASURE: Track triage accuracy over time via calibration score
 *
 * Storage: In-memory observation buffer + correction rules
 * Calibration runs: After each benchmark run or every 500 production observations
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'triage-calibrator' });

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A single triage observation — what triage predicted vs what actually happened.
 */
export interface TriageObservation {
  // Prediction
  predictedTaskType: string;
  predictedComplexity: string;
  predictedStrategy?: string;
  triageConfidence: number;

  // Actual outcome
  actualQualityScore: number;
  actualCostUsd: number;
  actualLatencyMs: number;
  actualSuccess: boolean;
  executedStrategy: string;

  // Context (for pattern matching)
  promptLength: number;
  hasTools: boolean;
  messageCount: number;

  timestamp: number;
}

/**
 * A correction rule — overrides triage in specific conditions.
 * Lightweight: evaluated as simple conditionals, no LLM needed.
 */
export interface CorrectionRule {
  id: string;
  condition: CorrectionCondition;
  correction: {
    field: 'complexity' | 'taskType';
    from: string;
    to: string;
  };
  confidence: number;       // 0-1, how confident we are this rule is correct
  evidenceCount: number;    // How many observations support this rule
  accuracy: number;         // Measured accuracy when applied (0-1)
  createdAt: number;
  lastApplied: number;
  appliedCount: number;
}

export interface CorrectionCondition {
  // All conditions are AND-ed. Absent fields are ignored.
  predictedTaskType?: string;
  predictedComplexity?: string;
  promptLengthGte?: number;
  promptLengthLte?: number;
  hasTools?: boolean;
  messageCountGte?: number;
}

/**
 * Calibration score — how well triage predictions align with outcomes.
 */
export interface CalibrationScore {
  overall: number;                    // 0-1, higher = better calibration
  complexityAccuracy: number;         // How often complexity prediction aligns with outcome
  taskTypeStability: number;          // How often taskType doesn't need correction
  overestimationRate: number;         // Rate of predicting higher complexity than needed
  underestimationRate: number;        // Rate of predicting lower complexity than needed
  sampleCount: number;
  timestamp: number;
}

/**
 * Misclassification pattern detected during calibration.
 */
export interface MisclassificationPattern {
  type: 'complexity-underestimate' | 'complexity-overestimate' | 'tasktype-mismatch';
  predictedValue: string;
  suggestedValue: string;
  evidenceCount: number;
  avgQualityImpact: number;           // How much quality was lost due to this misclassification
  examplePromptLengths: number[];     // For pattern detection
  confidence: number;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  // Observation window
  maxObservations: 2000,
  calibrationThreshold: 500,          // Run calibration every N observations
  minObservationsForRule: 10,         // Need at least this many examples before creating a rule

  // Quality thresholds for misclassification detection
  lowQualityThreshold: 0.5,           // Below this = likely under-resourced
  highQualityWithSimple: 0.85,        // Above this with "single" = likely over-resourced

  // Rule management
  maxRules: 30,                       // Cap number of active rules
  ruleMinConfidence: 0.65,            // Minimum confidence to activate a rule
  ruleDecayAfterDays: 30,             // Rules older than this start decaying
  ruleMinAccuracy: 0.55,              // Rules below this accuracy are pruned
};

// ─── Implementation ─────────────────────────────────────────────────────────

class TriageCalibrator {
  private observations: TriageObservation[] = [];
  private rules: CorrectionRule[] = [];
  private calibrationHistory: CalibrationScore[] = [];
  private observationsSinceLastCalibration = 0;

  /**
   * Record a triage observation (prediction + outcome).
   * Called after every execution completes.
   */
  recordObservation(obs: Omit<TriageObservation, 'timestamp'>): void {
    this.observations.push({ ...obs, timestamp: Date.now() });

    // Cap buffer
    if (this.observations.length > CONFIG.maxObservations) {
      this.observations = this.observations.slice(-CONFIG.maxObservations);
    }

    this.observationsSinceLastCalibration++;

    // Auto-calibrate after threshold observations
    if (this.observationsSinceLastCalibration >= CONFIG.calibrationThreshold) {
      this.calibrate();
      this.observationsSinceLastCalibration = 0;
    }
  }

  /**
   * Apply correction rules to a triage result.
   * Returns the corrected values, or null if no rules matched.
   */
  applyCorrections(params: {
    predictedTaskType: string;
    predictedComplexity: string;
    promptLength: number;
    hasTools: boolean;
    messageCount: number;
  }): {
    correctedTaskType: string;
    correctedComplexity: string;
    rulesApplied: string[];
  } | null {
    let taskType = params.predictedTaskType;
    let complexity = params.predictedComplexity;
    const appliedRules: string[] = [];

    for (const rule of this.rules) {
      if (rule.confidence < CONFIG.ruleMinConfidence) continue;
      if (rule.accuracy < CONFIG.ruleMinAccuracy) continue;

      if (this.matchesCondition(rule.condition, params)) {
        if (rule.correction.field === 'complexity' && complexity === rule.correction.from) {
          complexity = rule.correction.to;
          appliedRules.push(rule.id);
          rule.lastApplied = Date.now();
          rule.appliedCount++;
        } else if (rule.correction.field === 'taskType' && taskType === rule.correction.from) {
          taskType = rule.correction.to;
          appliedRules.push(rule.id);
          rule.lastApplied = Date.now();
          rule.appliedCount++;
        }
      }
    }

    if (appliedRules.length === 0) return null;

    log.debug({
      original: { taskType: params.predictedTaskType, complexity: params.predictedComplexity },
      corrected: { taskType, complexity },
      rulesApplied: appliedRules,
    }, 'Triage corrections applied');

    return {
      correctedTaskType: taskType,
      correctedComplexity: complexity,
      rulesApplied: appliedRules,
    };
  }

  /**
   * Run calibration analysis — detect patterns and generate/update rules.
   * Can be triggered manually (from benchmark) or auto (every N observations).
   */
  calibrate(): CalibrationScore {
    if (this.observations.length < CONFIG.minObservationsForRule) {
      return this.emptyCalibrationScore();
    }

    log.info({ observationCount: this.observations.length }, 'Running triage calibration');

    // 1. Detect misclassification patterns
    const patterns = this.detectMisclassifications();

    // 2. Generate or update correction rules from patterns
    for (const pattern of patterns) {
      this.generateOrUpdateRule(pattern);
    }

    // 3. Prune low-accuracy rules
    this.pruneRules();

    // 4. Calculate calibration score
    const score = this.calculateCalibrationScore();

    // 5. Store in history
    this.calibrationHistory.push(score);
    if (this.calibrationHistory.length > 50) {
      this.calibrationHistory.shift();
    }

    log.info({
      calibration: score.overall.toFixed(3),
      complexityAccuracy: score.complexityAccuracy.toFixed(3),
      patterns: patterns.length,
      activeRules: this.rules.filter(r => r.confidence >= CONFIG.ruleMinConfidence).length,
      underestimationRate: score.underestimationRate.toFixed(3),
      overestimationRate: score.overestimationRate.toFixed(3),
    }, 'Triage calibration completed');

    return score;
  }

  /**
   * Ingest benchmark results to run a precise calibration pass.
   * Benchmark tasks have known difficulty, making calibration more accurate.
   */
  ingestBenchmarkCalibration(results: Array<{
    taskType: string;
    expectedComplexity: string;
    predictedComplexity: string;
    strategy: string;
    qualityScore: number;
    costUsd: number;
    latencyMs: number;
    success: boolean;
    promptLength: number;
  }>): CalibrationScore {
    // Convert benchmark results to observations
    for (const r of results) {
      this.recordObservation({
        predictedTaskType: r.taskType,
        predictedComplexity: r.predictedComplexity,
        predictedStrategy: r.strategy,
        triageConfidence: 0.9, // Benchmark tasks have known difficulty
        actualQualityScore: r.qualityScore,
        actualCostUsd: r.costUsd,
        actualLatencyMs: r.latencyMs,
        actualSuccess: r.success,
        executedStrategy: r.strategy,
        promptLength: r.promptLength,
        hasTools: false,
        messageCount: 1,
      });
    }

    return this.calibrate();
  }

  // ─── Pattern Detection ──────────────────────────────────────────────────

  private detectMisclassifications(): MisclassificationPattern[] {
    const patterns: MisclassificationPattern[] = [];
    const recentObs = this.observations.slice(-1000); // Analyze last 1000

    // Group by predicted complexity
    const byComplexity = new Map<string, TriageObservation[]>();
    for (const obs of recentObs) {
      const key = obs.predictedComplexity;
      const arr = byComplexity.get(key) ?? [];
      arr.push(obs);
      byComplexity.set(key, arr);
    }

    // Detect complexity underestimation
    // If predicted "low" but quality is consistently poor → should have been "medium" or "high"
    for (const [complexity, obs] of byComplexity) {
      if (complexity === 'high') continue; // Can't underestimate if already high

      const lowQualityObs = obs.filter(o => o.actualSuccess && o.actualQualityScore < CONFIG.lowQualityThreshold);
      if (lowQualityObs.length >= CONFIG.minObservationsForRule) {
        const fraction = lowQualityObs.length / obs.length;
        if (fraction > 0.3) {
          const avgImpact = lowQualityObs.reduce((s, o) =>
            s + (CONFIG.lowQualityThreshold - o.actualQualityScore), 0) / lowQualityObs.length;

          patterns.push({
            type: 'complexity-underestimate',
            predictedValue: complexity,
            suggestedValue: complexity === 'low' ? 'medium' : 'high',
            evidenceCount: lowQualityObs.length,
            avgQualityImpact: avgImpact,
            examplePromptLengths: lowQualityObs.slice(0, 10).map(o => o.promptLength),
            confidence: Math.min(fraction * 1.5, 0.95),
          });
        }
      }
    }

    // Detect complexity overestimation
    // If predicted "high" but simple "single" strategy achieves > 0.85 quality → waste
    for (const [complexity, obs] of byComplexity) {
      if (complexity === 'low') continue; // Can't overestimate if already low

      const overResourced = obs.filter(o =>
        o.actualSuccess &&
        o.actualQualityScore > CONFIG.highQualityWithSimple &&
        o.executedStrategy === 'single'
      );

      if (overResourced.length >= CONFIG.minObservationsForRule) {
        const fraction = overResourced.length / obs.length;
        if (fraction > 0.4) {
          patterns.push({
            type: 'complexity-overestimate',
            predictedValue: complexity,
            suggestedValue: complexity === 'high' ? 'medium' : 'low',
            evidenceCount: overResourced.length,
            avgQualityImpact: 0, // No quality loss — cost/latency savings
            examplePromptLengths: overResourced.slice(0, 10).map(o => o.promptLength),
            confidence: Math.min(fraction * 1.3, 0.90),
          });
        }
      }
    }

    // Detect task type mismatches
    // Group by (predictedTaskType, executedStrategy) and find systematic mismatches
    const byTaskType = new Map<string, TriageObservation[]>();
    for (const obs of recentObs) {
      const key = obs.predictedTaskType;
      const arr = byTaskType.get(key) ?? [];
      arr.push(obs);
      byTaskType.set(key, arr);
    }

    for (const [taskType, obs] of byTaskType) {
      if (obs.length < CONFIG.minObservationsForRule * 2) continue;

      // Check if a different task type's typical strategy consistently outperforms
      const lowQuality = obs.filter(o => o.actualSuccess && o.actualQualityScore < 0.5);
      if (lowQuality.length > obs.length * 0.4) {
        // Find what strategies work well for tasks that were classified as this type
        const highQuality = obs.filter(o => o.actualQualityScore >= 0.7);
        if (highQuality.length > 0) {
          // Look at common strategy patterns in high-quality results
          const strategyCountHigh = new Map<string, number>();
          for (const o of highQuality) {
            strategyCountHigh.set(o.executedStrategy, (strategyCountHigh.get(o.executedStrategy) ?? 0) + 1);
          }
          const strategyCountLow = new Map<string, number>();
          for (const o of lowQuality) {
            strategyCountLow.set(o.executedStrategy, (strategyCountLow.get(o.executedStrategy) ?? 0) + 1);
          }

          // If the dominant strategy differs significantly between high and low quality results,
          // it suggests the task type classification is leading to wrong strategy selection
          const topHighStrat = [...strategyCountHigh.entries()].sort((a, b) => b[1] - a[1])[0];
          const topLowStrat = [...strategyCountLow.entries()].sort((a, b) => b[1] - a[1])[0];

          if (topHighStrat && topLowStrat && topHighStrat[0] !== topLowStrat[0]) {
            // Strategy mismatch detected — log it but don't auto-correct taskType
            // (taskType correction requires more evidence than complexity correction)
            log.info({
              taskType,
              highQualityStrategy: topHighStrat[0],
              lowQualityStrategy: topLowStrat[0],
              sampleSize: obs.length,
            }, 'Task type may benefit from different default strategy');
          }
        }
      }
    }

    return patterns;
  }

  // ─── Rule Management ──────────────────────────────────────────────────────

  private generateOrUpdateRule(pattern: MisclassificationPattern): void {
    // Only generate complexity correction rules for now
    // TaskType corrections are too risky to auto-generate
    if (pattern.type === 'tasktype-mismatch') return;

    const field = 'complexity';
    const from = pattern.predictedValue;
    const to = pattern.suggestedValue;

    // Build condition based on pattern evidence
    const condition: CorrectionCondition = {
      predictedComplexity: from,
    };

    // If evidence shows a prompt length pattern, use it
    if (pattern.examplePromptLengths.length >= 5) {
      const medianLength = pattern.examplePromptLengths
        .sort((a, b) => a - b)[Math.floor(pattern.examplePromptLengths.length / 2)];

      if (pattern.type === 'complexity-underestimate') {
        // Long prompts classified as "low" → likely medium
        condition.promptLengthGte = Math.floor(medianLength * 0.5);
      } else {
        // Short prompts classified as "high" → likely medium
        condition.promptLengthLte = Math.ceil(medianLength * 1.5);
      }
    }

    // Check for existing rule with same correction
    const existingIdx = this.rules.findIndex(r =>
      r.correction.field === field &&
      r.correction.from === from &&
      r.correction.to === to
    );

    if (existingIdx >= 0) {
      // Update existing rule
      const existing = this.rules[existingIdx];
      existing.confidence = Math.max(existing.confidence, pattern.confidence);
      existing.evidenceCount += pattern.evidenceCount;
      existing.condition = condition; // Update condition with latest evidence
    } else {
      // Create new rule
      if (this.rules.length >= CONFIG.maxRules) {
        // Remove lowest confidence rule to make room
        this.rules.sort((a, b) => a.confidence - b.confidence);
        this.rules.shift();
      }

      const ruleId = `cr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      this.rules.push({
        id: ruleId,
        condition,
        correction: { field, from, to },
        confidence: pattern.confidence,
        evidenceCount: pattern.evidenceCount,
        accuracy: pattern.confidence, // Initial estimate
        createdAt: Date.now(),
        lastApplied: 0,
        appliedCount: 0,
      });

      log.info({
        ruleId,
        correction: `${field}: ${from} → ${to}`,
        confidence: pattern.confidence.toFixed(3),
        evidence: pattern.evidenceCount,
      }, 'New triage correction rule generated');
    }
  }

  private pruneRules(): void {
    const now = Date.now();
    const decayThreshold = now - CONFIG.ruleDecayAfterDays * 86_400_000;

    this.rules = this.rules.filter(rule => {
      // Remove rules with low accuracy
      if (rule.appliedCount > 10 && rule.accuracy < CONFIG.ruleMinAccuracy) {
        log.debug({ ruleId: rule.id, accuracy: rule.accuracy }, 'Pruning low-accuracy rule');
        return false;
      }

      // Decay old rules
      if (rule.createdAt < decayThreshold && rule.appliedCount === 0) {
        log.debug({ ruleId: rule.id }, 'Pruning unused stale rule');
        return false;
      }

      return true;
    });
  }

  // ─── Calibration Score ────────────────────────────────────────────────────

  private calculateCalibrationScore(): CalibrationScore {
    const recentObs = this.observations.slice(-500);
    if (recentObs.length === 0) return this.emptyCalibrationScore();

    let correctComplexity = 0;
    let underestimated = 0;
    let overestimated = 0;
    let taskTypeStable = 0;

    for (const obs of recentObs) {
      // Complexity calibration
      const effectiveComplexity = this.inferActualComplexity(obs);

      if (effectiveComplexity === obs.predictedComplexity) {
        correctComplexity++;
      } else if (
        (obs.predictedComplexity === 'low' && effectiveComplexity !== 'low') ||
        (obs.predictedComplexity === 'medium' && effectiveComplexity === 'high')
      ) {
        underestimated++;
      } else {
        overestimated++;
      }

      // Task type stability — was the prediction useful?
      // If quality > 0.6, the triage likely picked a reasonable task type
      if (obs.actualQualityScore > 0.6) {
        taskTypeStable++;
      }
    }

    const n = recentObs.length;
    const complexityAccuracy = correctComplexity / n;
    const taskTypeStability = taskTypeStable / n;
    const underestimationRate = underestimated / n;
    const overestimationRate = overestimated / n;

    // Overall = weighted combination
    const overall = complexityAccuracy * 0.5 + taskTypeStability * 0.35 + (1 - underestimationRate) * 0.15;

    return {
      overall,
      complexityAccuracy,
      taskTypeStability,
      underestimationRate,
      overestimationRate,
      sampleCount: n,
      timestamp: Date.now(),
    };
  }

  /**
   * Infer what the "actual" complexity should have been based on outcome.
   * This is a heuristic — not ground truth, but useful for calibration.
   */
  private inferActualComplexity(obs: TriageObservation): string {
    // High quality with simple strategy → was actually low/medium complexity
    if (obs.actualQualityScore > 0.85 && obs.executedStrategy === 'single') {
      return obs.actualLatencyMs < 3000 ? 'low' : 'medium';
    }

    // Low quality despite complex strategy → was actually harder than expected
    if (obs.actualQualityScore < 0.4 && obs.executedStrategy !== 'single') {
      return 'high';
    }

    // Failed execution suggests harder than estimated
    if (!obs.actualSuccess) {
      return obs.predictedComplexity === 'low' ? 'medium' : 'high';
    }

    // Default: trust the prediction
    return obs.predictedComplexity;
  }

  private matchesCondition(condition: CorrectionCondition, params: {
    predictedTaskType: string;
    predictedComplexity: string;
    promptLength: number;
    hasTools: boolean;
    messageCount: number;
  }): boolean {
    if (condition.predictedTaskType && condition.predictedTaskType !== params.predictedTaskType) return false;
    if (condition.predictedComplexity && condition.predictedComplexity !== params.predictedComplexity) return false;
    if (condition.promptLengthGte !== undefined && params.promptLength < condition.promptLengthGte) return false;
    if (condition.promptLengthLte !== undefined && params.promptLength > condition.promptLengthLte) return false;
    if (condition.hasTools !== undefined && condition.hasTools !== params.hasTools) return false;
    if (condition.messageCountGte !== undefined && params.messageCount < condition.messageCountGte) return false;
    return true;
  }

  private emptyCalibrationScore(): CalibrationScore {
    return {
      overall: 1.0,
      complexityAccuracy: 1.0,
      taskTypeStability: 1.0,
      overestimationRate: 0,
      underestimationRate: 0,
      sampleCount: 0,
      timestamp: Date.now(),
    };
  }

  // ─── Admin API ────────────────────────────────────────────────────────────

  /**
   * Get current state for admin inspection.
   */
  getState(): {
    observationCount: number;
    activeRules: CorrectionRule[];
    latestCalibration: CalibrationScore | null;
    calibrationHistory: CalibrationScore[];
    ruleApplicationStats: {
      totalApplications: number;
      topRules: Array<{ ruleId: string; appliedCount: number; accuracy: number }>;
    };
  } {
    const activeRules = this.rules.filter(r => r.confidence >= CONFIG.ruleMinConfidence);
    const latestCalibration = this.calibrationHistory.length > 0
      ? this.calibrationHistory[this.calibrationHistory.length - 1]
      : null;

    return {
      observationCount: this.observations.length,
      activeRules,
      latestCalibration,
      calibrationHistory: this.calibrationHistory.slice(-20),
      ruleApplicationStats: {
        totalApplications: this.rules.reduce((s, r) => s + r.appliedCount, 0),
        topRules: this.rules
          .filter(r => r.appliedCount > 0)
          .sort((a, b) => b.appliedCount - a.appliedCount)
          .slice(0, 10)
          .map(r => ({
            ruleId: r.id,
            appliedCount: r.appliedCount,
            accuracy: r.accuracy,
          })),
      },
    };
  }

  /**
   * Force a calibration pass (from admin route or benchmark run).
   */
  forceCalibration(): CalibrationScore {
    return this.calibrate();
  }

  /**
   * Reset all rules (emergency valve).
   */
  resetRules(): void {
    const count = this.rules.length;
    this.rules = [];
    log.info({ prunedCount: count }, 'All triage correction rules reset by admin');
  }
}

// ─── Singleton Export ───────────────────────────────────────────────────────

export const triageCalibrator = new TriageCalibrator();

export default triageCalibrator;
