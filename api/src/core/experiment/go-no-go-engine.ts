// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GO/NO-GO Decision Engine
 *
 * Produces automated deployment decisions based on experiment results.
 * Decisions are per (approach × usage profile), using configurable thresholds.
 *
 * Usage profiles:
 * - max-quality: best quality regardless of cost
 * - low-cost: best quality per dollar
 * - low-latency: fastest with minimum quality
 * - high-robustness: most consistent, lowest variance
 * - generalist: balanced across all dimensions
 *
 * Verdicts: GO | CONDITIONAL-GO | NO-GO | INCONCLUSIVE
 */

import {
  computeStabilityIndex,
  computeCostEfficiency,
  pairByTaskDeltas,
  pairedTTest,
  pairedCohensD,
  meanDelta,
  type TaskScore,
} from './statistical-analysis';

import type {
  ExperimentExecutionResult,
  ExecutionMode,
  GoNoGoThresholds,
  GoNoGoDecision,
  GoNoGoReport,
  GoNoGoVerdict,
  UsageProfile,
  DecisionMatrixRow,
  HeatmapCell,
  EvidenceStrength,
} from './experiment-types';
import { DEFAULT_THRESHOLDS } from './experiment-types';

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Generate a complete GO/NO-GO report from experiment results.
 * Only uses frozen-phase results for primary decisions.
 * Confirmation-phase results reinforce or weaken disputed conclusions.
 */
export function generateGoNoGoReport(
  experimentId: string,
  results: ExperimentExecutionResult[],
  thresholds: GoNoGoThresholds = DEFAULT_THRESHOLDS,
): GoNoGoReport {
  const frozenResults = results.filter(r => r.phase === 'frozen' && r.success && r.qualityScore !== null);
  const confirmationResults = results.filter(r => r.phase === 'confirmation' && r.success && r.qualityScore !== null);
  const allMeasuredResults = [...frozenResults, ...confirmationResults];

  // Phase summary
  const phaseSummary = {
    sanityCheck: { executed: results.filter(r => r.phase === 'sanity-check').length, passed: results.filter(r => r.phase === 'sanity-check' && r.success).length > 0 },
    warmup: { executed: results.filter(r => r.phase === 'warmup').length },
    frozen: { executed: frozenResults.length },
    confirmation: { executed: confirmationResults.length, disputedScenarios: 0 },
  };

  // Generate decisions for all approaches × all profiles
  const approaches = getApproaches(allMeasuredResults);
  const profiles: UsageProfile[] = ['max-quality', 'low-cost', 'low-latency', 'high-robustness', 'generalist'];

  const decisions: GoNoGoDecision[] = [];
  for (const approach of approaches) {
    for (const profile of profiles) {
      const decision = evaluateApproach(approach, profile, allMeasuredResults, thresholds);
      decisions.push(decision);
    }
  }

  // Decision matrix
  const decisionMatrix = buildDecisionMatrix(allMeasuredResults, thresholds);

  // Heatmap
  const heatmap = buildHeatmap(allMeasuredResults);

  // Confidence map
  const confidenceMap = buildConfidenceMap(allMeasuredResults, thresholds);

  // Trade-off curves
  const tradeoffCurves = buildTradeoffCurves(allMeasuredResults);

  // Final verdict
  const finalVerdict = determineFinalVerdict(decisions, allMeasuredResults, thresholds);

  // Mandatory questions
  const mandatoryQuestions = answerMandatoryQuestions(decisions, allMeasuredResults, thresholds);

  return {
    generatedAt: new Date().toISOString(),
    experimentId,
    totalExecutions: results.length,
    phaseSummary,
    thresholdsUsed: thresholds,
    decisions,
    decisionMatrix,
    heatmap,
    confidenceMap,
    tradeoffCurves,
    finalVerdict,
    mandatoryQuestions,
  };
}

// ─── Core Decision Logic ───────────────────────────────────────────────────

function evaluateApproach(
  approach: { label: string; mode: ExecutionMode },
  profile: UsageProfile,
  results: ExperimentExecutionResult[],
  thresholds: GoNoGoThresholds,
): GoNoGoDecision {
  const approachResults = results.filter(r => getLabel(r) === approach.label);
  if (approachResults.length === 0) {
    return emptyDecision(approach, profile);
  }

  const qualities = approachResults.map(r => r.qualityScore!);
  // P1-7: exclude rows whose cost could not be attributed (costMissing) — a $0
  // missing-cost on a successful row biases the mean cost down. Fall back to all
  // rows only if EVERY row is flagged (so avgCost is never NaN).
  const costRows = approachResults.filter(r => !r.costMissing);
  const costs = (costRows.length > 0 ? costRows : approachResults).map(r => r.costUsd);
  const latencies = approachResults.map(r => r.latencyMs);
  const avgQuality = mean(qualities);
  const avgCost = mean(costs);
  const avgLatency = mean(latencies);
  const successRate = approachResults.filter(r => r.success).length / approachResults.length;
  const consistencyIndex = computeStabilityIndex(qualities);
  const sampleSize = approachResults.length;

  const metrics = { avgQuality, avgCost, avgLatency, successRate, consistencyIndex, sampleSize };
  const evidence = getEvidence(sampleSize, thresholds);

  const thresholdsMet: string[] = [];
  const thresholdsFailed: string[] = [];

  // Check universal thresholds
  if (avgQuality >= thresholds.qualityFloor) thresholdsMet.push('quality_floor');
  else thresholdsFailed.push(`quality_floor (${avgQuality.toFixed(3)} < ${thresholds.qualityFloor})`);

  if (successRate >= thresholds.successRateFloor) thresholdsMet.push('success_rate');
  else thresholdsFailed.push(`success_rate (${(successRate * 100).toFixed(1)}% < ${(thresholds.successRateFloor * 100).toFixed(0)}%)`);

  if (consistencyIndex >= thresholds.consistencyFloor) thresholdsMet.push('consistency');
  else thresholdsFailed.push(`consistency (${consistencyIndex.toFixed(3)} < ${thresholds.consistencyFloor})`);

  // Profile-specific evaluation
  let verdict: GoNoGoVerdict;
  let reason: string;

  switch (profile) {
    case 'max-quality':
      ({ verdict, reason } = evaluateMaxQuality(approach, avgQuality, results, thresholds, thresholdsMet, thresholdsFailed));
      break;
    case 'low-cost':
      ({ verdict, reason } = evaluateLowCost(approach, avgQuality, avgCost, results, thresholds, thresholdsMet, thresholdsFailed));
      break;
    case 'low-latency':
      ({ verdict, reason } = evaluateLowLatency(approach, avgQuality, avgLatency, results, thresholds, thresholdsMet, thresholdsFailed));
      break;
    case 'high-robustness':
      ({ verdict, reason } = evaluateHighRobustness(consistencyIndex, thresholdsFailed));
      break;
    case 'generalist':
      ({ verdict, reason } = evaluateGeneralist(approach, avgQuality, avgCost, avgLatency, consistencyIndex, results, thresholds, thresholdsMet, thresholdsFailed));
      break;
  }

  // Override to INCONCLUSIVE if insufficient samples
  if (evidence === 'inconclusive') {
    verdict = 'INCONCLUSIVE';
    reason = `Insufficient sample size (${sampleSize}) for reliable conclusion`;
  }

  return { approach: approach.label, mode: approach.mode, profile, verdict, reason, metrics, evidence, thresholdsMet, thresholdsFailed };
}

function evaluateMaxQuality(
  approach: { label: string; mode: ExecutionMode },
  avgQuality: number,
  results: ExperimentExecutionResult[],
  thresholds: GoNoGoThresholds,
  thresholdsMet: string[],
  thresholdsFailed: string[],
): { verdict: GoNoGoVerdict; reason: string } {
  // Is this the best quality approach?
  const allLabels = [...new Set(results.map(r => getLabel(r)))];
  const labelQualities = allLabels.map(l => ({
    label: l,
    avgQ: mean(results.filter(r => getLabel(r) === l).map(r => r.qualityScore!)),
  })).sort((a, b) => b.avgQ - a.avgQ);

  const rank = labelQualities.findIndex(lq => lq.label === approach.label) + 1;
  const best = labelQualities[0];

  if (thresholdsFailed.length > 0) {
    return { verdict: 'NO-GO', reason: `Fails thresholds: ${thresholdsFailed.join(', ')}` };
  }

  if (rank === 1) {
    return { verdict: 'GO', reason: `Highest quality (${avgQuality.toFixed(3)}) — rank #1 of ${allLabels.length}` };
  }

  const delta = best.avgQ - avgQuality;
  if (delta < 0.02) {
    return { verdict: 'CONDITIONAL-GO', reason: `Within 2pp of best (${best.label}: ${best.avgQ.toFixed(3)})` };
  }

  return { verdict: 'NO-GO', reason: `Rank #${rank}, ${(delta * 100).toFixed(1)}pp below best (${best.label})` };
}

function evaluateLowCost(
  approach: { label: string; mode: ExecutionMode },
  avgQuality: number,
  avgCost: number,
  results: ExperimentExecutionResult[],
  thresholds: GoNoGoThresholds,
  thresholdsMet: string[],
  thresholdsFailed: string[],
): { verdict: GoNoGoVerdict; reason: string } {
  if (thresholdsFailed.length > 0) {
    return { verdict: 'NO-GO', reason: `Fails thresholds: ${thresholdsFailed.join(', ')}` };
  }

  const efficiency = computeCostEfficiency(avgQuality, avgCost);
  const allEfficiencies = [...new Set(results.map(r => getLabel(r)))].map(l => {
    const items = results.filter(r => getLabel(r) === l);
    return { label: l, eff: computeCostEfficiency(mean(items.map(r => r.qualityScore!)), mean(items.map(r => r.costUsd))) };
  }).sort((a, b) => b.eff - a.eff);

  const rank = allEfficiencies.findIndex(e => e.label === approach.label) + 1;

  if (rank <= 2) {
    return { verdict: 'GO', reason: `Top-2 cost efficiency (${efficiency.toFixed(1)} quality/$ — rank #${rank})` };
  }

  // Cost-vs-quality framing (2026-06-30): a collective is justified when its cost
  // is ≤ a single model, OR its cost is higher but the QUALITY GAIN over the BEST
  // individual (any top-tier model) is large enough to justify it. Compare against
  // the best single model, not the average — the thesis is "beats any top-tier".
  if (approach.mode === 'collective') {
    const singles = results.filter(r => r.executionMode === 'single-model');
    const singleCostRows = singles.filter(r => !r.costMissing);
    const singleAvgCost = singleCostRows.length ? mean(singleCostRows.map(r => r.costUsd)) : (singles.length ? mean(singles.map(r => r.costUsd)) : avgCost);
    const costMult = singleAvgCost > 0 ? avgCost / singleAvgCost : 1;
    // PAIRED quality gain vs the BEST individual ON EACH SHARED TASK — removes
    // the task-mix confounding that inflated the v4 pooled gain. For each task:
    // this collective's mean − the best single model's score on that same task.
    const bestSingleByTask = new Map<number, number>();
    for (const r of singles) {
      if (r.qualityScore == null) continue;
      const cur = bestSingleByTask.get(r.taskIndex);
      if (cur === undefined || r.qualityScore > cur) bestSingleByTask.set(r.taskIndex, r.qualityScore);
    }
    const collectiveByTask = new Map<number, { sum: number; n: number }>();
    for (const r of results) {
      if (getLabel(r) !== approach.label || r.qualityScore == null) continue;
      const cur = collectiveByTask.get(r.taskIndex) ?? { sum: 0, n: 0 };
      cur.sum += r.qualityScore; cur.n += 1;
      collectiveByTask.set(r.taskIndex, cur);
    }
    const pairedGains: number[] = [];
    for (const [ti, agg] of collectiveByTask) {
      const bs = bestSingleByTask.get(ti);
      if (bs !== undefined) pairedGains.push(agg.sum / agg.n - bs);
    }
    // Fall back to pooled only when there is no shared task (degenerate run).
    const bestSingleQuality = singles.length ? Math.max(...singles.map(r => r.qualityScore!)) : avgQuality;
    const qualityGain = pairedGains.length ? meanDelta(pairedGains) : (avgQuality - bestSingleQuality);

    if (avgCost <= singleAvgCost) {
      return { verdict: 'GO', reason: `Cost ≤ single-model (${costMult.toFixed(2)}x) at quality ${avgQuality.toFixed(3)}` };
    }
    if (costMult > thresholds.maxCostMultiplierForCollective) {
      if (qualityGain >= thresholds.minQualityGainForCollective) {
        return { verdict: 'CONDITIONAL-GO', reason: `Cost ${costMult.toFixed(1)}x single but quality +${(qualityGain * 100).toFixed(1)}pp over the BEST individual justifies it` };
      }
      return { verdict: 'NO-GO', reason: `Cost ${costMult.toFixed(1)}x single-model, quality only +${(qualityGain * 100).toFixed(1)}pp vs best individual (need +${(thresholds.minQualityGainForCollective * 100).toFixed(0)}pp)` };
    }
    // Cost is higher but within the acceptable multiplier.
    return { verdict: qualityGain >= 0 ? 'GO' : 'CONDITIONAL-GO', reason: `Cost ${costMult.toFixed(1)}x single (≤${thresholds.maxCostMultiplierForCollective}x), quality ${qualityGain >= 0 ? '+' : ''}${(qualityGain * 100).toFixed(1)}pp vs best individual` };
  }

  return { verdict: 'CONDITIONAL-GO', reason: `Moderate cost efficiency (rank #${rank}), acceptable if quality justifies` };
}

function evaluateLowLatency(
  approach: { label: string; mode: ExecutionMode },
  avgQuality: number,
  avgLatency: number,
  results: ExperimentExecutionResult[],
  thresholds: GoNoGoThresholds,
  thresholdsMet: string[],
  thresholdsFailed: string[],
): { verdict: GoNoGoVerdict; reason: string } {
  if (thresholdsFailed.length > 0) {
    return { verdict: 'NO-GO', reason: `Fails thresholds: ${thresholdsFailed.join(', ')}` };
  }

  const singleLatency = mean(results.filter(r => r.executionMode === 'single-model').map(r => r.latencyMs));
  const latencyMultiplier = singleLatency > 0 ? avgLatency / singleLatency : 1;

  if (approach.mode === 'collective' && latencyMultiplier > thresholds.maxLatencyMultiplierForCollective) {
    return { verdict: 'NO-GO', reason: `Latency ${(avgLatency / 1000).toFixed(1)}s is ${latencyMultiplier.toFixed(1)}x single-model — exceeds ${thresholds.maxLatencyMultiplierForCollective}x limit` };
  }

  const allLatencies = [...new Set(results.map(r => getLabel(r)))].map(l => ({
    label: l, lat: mean(results.filter(r => getLabel(r) === l).map(r => r.latencyMs)),
  })).sort((a, b) => a.lat - b.lat);

  const rank = allLatencies.findIndex(e => e.label === approach.label) + 1;

  if (rank <= 3) {
    return { verdict: 'GO', reason: `Low latency: ${(avgLatency / 1000).toFixed(1)}s (rank #${rank})` };
  }

  return { verdict: 'CONDITIONAL-GO', reason: `Moderate latency: ${(avgLatency / 1000).toFixed(1)}s (rank #${rank})` };
}

function evaluateHighRobustness(
  consistencyIndex: number,
  thresholdsFailed: string[],
): { verdict: GoNoGoVerdict; reason: string } {
  if (thresholdsFailed.length > 0) {
    return { verdict: 'NO-GO', reason: `Fails thresholds: ${thresholdsFailed.join(', ')}` };
  }

  if (consistencyIndex >= 0.85) {
    return { verdict: 'GO', reason: `High consistency (${consistencyIndex.toFixed(3)})` };
  }
  if (consistencyIndex >= 0.70) {
    return { verdict: 'CONDITIONAL-GO', reason: `Moderate consistency (${consistencyIndex.toFixed(3)})` };
  }

  return { verdict: 'NO-GO', reason: `Low consistency (${consistencyIndex.toFixed(3)})` };
}

function evaluateGeneralist(
  approach: { label: string; mode: ExecutionMode },
  avgQuality: number, avgCost: number, avgLatency: number, consistencyIndex: number,
  results: ExperimentExecutionResult[],
  thresholds: GoNoGoThresholds,
  thresholdsMet: string[],
  thresholdsFailed: string[],
): { verdict: GoNoGoVerdict; reason: string } {
  if (thresholdsFailed.length > 0) {
    return { verdict: 'NO-GO', reason: `Fails thresholds: ${thresholdsFailed.join(', ')}` };
  }

  // Composite score: quality * consistency / (cost_normalized * latency_normalized)
  const allQualities = results.map(r => r.qualityScore!);
  const maxQuality = Math.max(...allQualities);
  const maxCost = Math.max(...results.map(r => r.costUsd));
  const maxLatency = Math.max(...results.map(r => r.latencyMs));

  const normalizedQuality = maxQuality > 0 ? avgQuality / maxQuality : 0;
  const normalizedCost = maxCost > 0 ? avgCost / maxCost : 0;
  const normalizedLatency = maxLatency > 0 ? avgLatency / maxLatency : 0;

  const compositeScore = normalizedQuality * consistencyIndex / (Math.max(normalizedCost, 0.01) * Math.max(normalizedLatency, 0.01));

  // Rank among all approaches
  const allScores = [...new Set(results.map(r => getLabel(r)))].map(l => {
    const items = results.filter(r => getLabel(r) === l);
    const q = mean(items.map(r => r.qualityScore!));
    const c = mean(items.map(r => r.costUsd));
    const lat = mean(items.map(r => r.latencyMs));
    const ci = computeStabilityIndex(items.map(r => r.qualityScore!));
    const nq = maxQuality > 0 ? q / maxQuality : 0;
    const nc = maxCost > 0 ? c / maxCost : 0;
    const nl = maxLatency > 0 ? lat / maxLatency : 0;
    return { label: l, score: nq * ci / (Math.max(nc, 0.01) * Math.max(nl, 0.01)) };
  }).sort((a, b) => b.score - a.score);

  const rank = allScores.findIndex(s => s.label === approach.label) + 1;

  if (rank === 1) {
    return { verdict: 'GO', reason: `Best generalist score (rank #1, composite: ${compositeScore.toFixed(2)})` };
  }
  if (rank <= 3) {
    return { verdict: 'CONDITIONAL-GO', reason: `Strong generalist (rank #${rank}, composite: ${compositeScore.toFixed(2)})` };
  }

  return { verdict: 'NO-GO', reason: `Weak generalist (rank #${rank}/${allScores.length})` };
}

// ─── Decision Matrix ───────────────────────────────────────────────────────

function buildDecisionMatrix(results: ExperimentExecutionResult[], thresholds: GoNoGoThresholds): DecisionMatrixRow[] {
  const matrix: DecisionMatrixRow[] = [];
  const scenarios = [...new Set(results.map(r => `${r.taskType}|${r.complexity}`))];
  const approaches = [...new Set(results.map(r => getLabel(r)))];

  for (const scenario of scenarios) {
    const [taskType, complexity] = scenario.split('|');
    const scenarioResults = results.filter(r => r.taskType === taskType && r.complexity === complexity);

    for (const approach of approaches) {
      const approachResults = scenarioResults.filter(r => getLabel(r) === approach);
      if (approachResults.length === 0) continue;

      const avgQuality = mean(approachResults.map(r => r.qualityScore!));
      const avgCost = mean(approachResults.map(r => r.costUsd));
      const avgLatencyMs = mean(approachResults.map(r => r.latencyMs));
      const confidence = getEvidence(approachResults.length, thresholds);

      // Quick verdict for this scenario
      let verdict: GoNoGoVerdict = 'INCONCLUSIVE';
      if (confidence !== 'inconclusive') {
        if (avgQuality >= thresholds.qualityFloor) verdict = 'GO';
        else verdict = 'NO-GO';
      }

      matrix.push({ scenario: `${taskType}/${complexity}`, approach, avgQuality, avgCost, avgLatencyMs, confidence, verdict });
    }
  }

  return matrix;
}

// ─── Heatmap ───────────────────────────────────────────────────────────────

function buildHeatmap(results: ExperimentExecutionResult[]): HeatmapCell[] {
  const cells: HeatmapCell[] = [];
  const rows = [...new Set(results.map(r => `${r.taskType}/${r.complexity}`))];
  const columns = [...new Set(results.map(r => getLabel(r)))];

  for (const row of rows) {
    const [taskType, complexity] = row.split('/');
    for (const column of columns) {
      const cellResults = results.filter(r => r.taskType === taskType && r.complexity === complexity && getLabel(r) === column);
      if (cellResults.length === 0) continue;
      cells.push({ row, column, value: mean(cellResults.map(r => r.qualityScore!)), sampleSize: cellResults.length });
    }
  }

  return cells;
}

// ─── Confidence Map ────────────────────────────────────────────────────────

function buildConfidenceMap(results: ExperimentExecutionResult[], thresholds: GoNoGoThresholds): Array<{ segment: string; confidence: EvidenceStrength }> {
  const segments = [...new Set(results.map(r => `${r.taskType}/${r.complexity}/${r.executionMode}`))];
  return segments.map(segment => {
    const count = results.filter(r => `${r.taskType}/${r.complexity}/${r.executionMode}` === segment).length;
    return { segment, confidence: getEvidence(count, thresholds) };
  });
}

// ─── Trade-off Curves ──────────────────────────────────────────────────────

function buildTradeoffCurves(results: ExperimentExecutionResult[]) {
  const labels = [...new Set(results.map(r => getLabel(r)))];
  const qualityVsCost = labels.map(l => {
    const items = results.filter(r => getLabel(r) === l);
    return { label: l, quality: mean(items.map(r => r.qualityScore!)), cost: mean(items.map(r => r.costUsd)) };
  });
  const qualityVsLatency = labels.map(l => {
    const items = results.filter(r => getLabel(r) === l);
    return { label: l, quality: mean(items.map(r => r.qualityScore!)), latency: mean(items.map(r => r.latencyMs)) };
  });

  return { qualityVsCost, qualityVsLatency };
}

// ─── Final Verdict ─────────────────────────────────────────────────────────

function determineFinalVerdict(
  decisions: GoNoGoDecision[],
  // results/thresholds reserved for future verdict-enrichment paths (e.g.
  // sample-size adjusted INCONCLUSIVE upgrade); kept in signature for parity
  // with the caller, prefixed `_` to mark intent.
  _results: ExperimentExecutionResult[],
  _thresholds: GoNoGoThresholds,
): GoNoGoReport['finalVerdict'] {
  const generalistDecisions = decisions.filter(d => d.profile === 'generalist');
  if (generalistDecisions.length === 0) {
    return { class: 'INCONCLUSIVE — Mais dados necessários', summary: 'No execution data available', productionDefault: 'unknown', premiumEscalation: 'unknown', blocked: [] };
  }
  const goDecisions = generalistDecisions.filter(d => d.verdict === 'GO');
  const noGoDecisions = generalistDecisions.filter(d => d.verdict === 'NO-GO');
  const inconclusiveDecisions = generalistDecisions.filter(d => d.verdict === 'INCONCLUSIVE');

  // Determine production default
  const bestGeneralist = generalistDecisions.sort((a, b) => b.metrics.avgQuality - a.metrics.avgQuality).find(d => d.verdict === 'GO' || d.verdict === 'CONDITIONAL-GO');
  const productionDefault = bestGeneralist?.approach ?? 'single-model (best available)';

  // Premium escalation
  const maxQualityGo = decisions.filter(d => d.profile === 'max-quality' && (d.verdict === 'GO' || d.verdict === 'CONDITIONAL-GO')).sort((a, b) => b.metrics.avgQuality - a.metrics.avgQuality)[0];
  const premiumEscalation = maxQualityGo?.approach ?? productionDefault;

  // Blocked approaches
  const blocked = [...new Set(noGoDecisions.map(d => d.approach))].filter(a =>
    generalistDecisions.filter(d => d.approach === a && d.verdict === 'NO-GO').length > 0,
  );

  // Determine verdict class
  let verdictClass: string;
  let summary: string;

  if (inconclusiveDecisions.length > generalistDecisions.length / 2) {
    verdictClass = 'INCONCLUSIVE — Mais dados necessários';
    summary = `${inconclusiveDecisions.length} of ${generalistDecisions.length} approaches have insufficient data`;
  } else if (goDecisions.length === 0) {
    verdictClass = 'NO-GO — Evidência insuficiente';
    summary = 'No approach meets all thresholds for unconditional deployment';
  } else {
    const goModes = new Set(goDecisions.map(d => d.mode));
    const hasSingleGo = goDecisions.some(d => d.mode === 'single-model');
    const hasCollectiveGo = goDecisions.some(d => d.mode === 'collective');
    const hasAdaptiveGo = goDecisions.some(d => d.mode === 'adaptive');

    if (hasAdaptiveGo && goModes.size > 1) {
      verdictClass = 'GO — Sistema adaptativo como roteador principal';
      summary = 'Adaptive system delivers best generalist performance; single-model as fallback';
    } else if (hasSingleGo && hasCollectiveGo) {
      verdictClass = 'CONDITIONAL GO — Depende do cenário';
      summary = 'Single-model for default, collective for high-complexity/premium scenarios';
    } else if (hasSingleGo) {
      verdictClass = 'GO — Single-model default';
      summary = 'Single-model approaches meet all thresholds; collective does not justify cost';
    } else if (hasCollectiveGo) {
      verdictClass = 'GO — Inteligência coletiva em cenários específicos';
      summary = 'Collective strategies show advantage in specific scenarios';
    } else {
      verdictClass = 'CONDITIONAL GO — Depende do cenário';
      summary = 'Mixed results across approaches';
    }
  }

  return { class: verdictClass, summary, productionDefault, premiumEscalation, blocked };
}

// ─── Mandatory Questions ───────────────────────────────────────────────────

function answerMandatoryQuestions(
  decisions: GoNoGoDecision[],
  results: ExperimentExecutionResult[],
  thresholds: GoNoGoThresholds,
): GoNoGoReport['mandatoryQuestions'] {
  const singleResults = results.filter(r => r.executionMode === 'single-model' && r.model);
  const byModel = groupBy(singleResults, r => r.model!);
  let bestModel = 'unknown', bestQ = 0;
  for (const [model, items] of Object.entries(byModel)) {
    const q = mean(items.map(r => r.qualityScore!));
    if (q > bestQ) { bestModel = model; bestQ = q; }
  }

  const singleQ = mean(results.filter(r => r.executionMode === 'single-model').map(r => r.qualityScore!));
  const collectiveQ = mean(results.filter(r => r.executionMode === 'collective').map(r => r.qualityScore!));
  const collectiveTier1Q = mean(results.filter(r => r.executionMode === 'collective-tier1').map(r => r.qualityScore!));
  const budgetQ = mean(results.filter(r => r.executionMode === 'single-budget').map(r => r.qualityScore!));
  const adaptiveQ = mean(results.filter(r => r.executionMode === 'adaptive').map(r => r.qualityScore!));

  // PAIRED-BY-TASK comparison (the fix for the v4 confounding): compare arms on
  // the COMMON task set, not pooled means. An arm that ran an easier task subset
  // can no longer win on task-mix alone. The pooled means are still computed for
  // transparency (and to expose any pooled-vs-paired gap — the exact ERRATA
  // lesson), but the DECISION (q2/q6) uses the paired delta.
  const taskScores = (mode: string): TaskScore[] =>
    results.filter(r => r.executionMode === mode && r.qualityScore != null)
      .map(r => ({ taskIndex: r.taskIndex, value: r.qualityScore! }));
  const singleTS = taskScores('single-model');
  const collectiveTS = taskScores('collective');
  const collectiveTier1TS = taskScores('collective-tier1');

  const collectiveDeltas = pairByTaskDeltas(collectiveTS, singleTS);
  const collectiveTier1Deltas = pairByTaskDeltas(collectiveTier1TS, singleTS);
  const pairedTest = collectiveDeltas.length >= 2 ? pairedTTest(collectiveDeltas) : null;
  const pairedES = collectiveDeltas.length >= 2 ? pairedCohensD(collectiveDeltas) : null;
  const pairedTier1Test = collectiveTier1Deltas.length >= 2 ? pairedTTest(collectiveTier1Deltas) : null;
  const pairedGain = meanDelta(collectiveDeltas); // mean per-task (collective − single) on shared tasks

  // Pooled (confounded) means — kept ONLY for transparency/comparison display.
  const pooledDelta = collectiveQ - singleQ;
  const orchestrationGain = collectiveQ - budgetQ; // positive = orchestration adds value beyond just using budget models

  // PAIRED per-scenario slice (2026-07-16 fix): q3/q4 answer "where does the
  // collective win/lose" — the exact question an operator asks when trying to
  // segregate wins from losses. This was still comparing POOLED means within
  // each (taskType/complexity) bucket, the SAME task-mix confounding q2/q6 was
  // fixed for at the top level (an arm that ran an easier subset of tasks
  // WITHIN a scenario bucket could win the bucket on mix alone, not capability).
  // Pair by taskIndex within each scenario instead; require ≥2 shared tasks
  // (pairedTTest's own floor) so a single lucky/unlucky task can't swing a
  // scenario's classification. NOTE for interpretation: even paired, a single
  // scenario slice is a much SMALLER sample than the overall q2 test — treat
  // per-scenario wins as descriptive/exploratory ("here is where it wins"),
  // not as independent confirmatory evidence of the thesis (see PR description).
  const collectiveWins: string[] = [];
  const collectiveNotWorth: string[] = [];
  const byScenario = groupBy(results, r => `${r.taskType}/${r.complexity}`);
  for (const [scenario, items] of Object.entries(byScenario)) {
    const sTS: TaskScore[] = items
      .filter(r => r.executionMode === 'single-model' && r.qualityScore != null)
      .map(r => ({ taskIndex: r.taskIndex, value: r.qualityScore! }));
    const cTS: TaskScore[] = items
      .filter(r => r.executionMode === 'collective' && r.qualityScore != null)
      .map(r => ({ taskIndex: r.taskIndex, value: r.qualityScore! }));
    const scenarioDeltas = pairByTaskDeltas(cTS, sTS);
    if (scenarioDeltas.length < 2) continue; // no meaningful paired signal in this scenario — omit rather than guess
    const scenarioGain = meanDelta(scenarioDeltas);
    if (scenarioGain > thresholds.minQualityGainForCollective) collectiveWins.push(scenario);
    else if (scenarioGain <= 0.02) collectiveNotWorth.push(scenario);
  }

  const goApproaches = [...new Set(decisions.filter(d => d.verdict === 'GO' && d.profile === 'generalist').map(d => d.approach))];
  const noGoApproaches = [...new Set(decisions.filter(d => d.verdict === 'NO-GO' && d.profile === 'generalist').map(d => d.approach))];
  const inconclusiveApproaches = [...new Set(decisions.filter(d => d.verdict === 'INCONCLUSIVE' && d.profile === 'generalist').map(d => d.approach))];

  return {
    q1_bestTier1Baseline: `${bestModel} (avg quality: ${bestQ.toFixed(4)})`,
    q2_collectiveBeatsTier1: pairedTest?.significant && pairedGain > 0
      ? `Yes — CI real beats Tier 1 on the SAME tasks (paired p=${pairedTest.pValue.toFixed(4)}, ${pairedES?.category} effect, paired Δ=${pairedGain.toFixed(4)} over ${collectiveDeltas.length} shared tasks; pooled Δ=${pooledDelta.toFixed(4)})`
      : `No significant paired advantage for CI real (paired Δ=${pairedGain.toFixed(4)} over ${collectiveDeltas.length} shared tasks; pooled Δ=${pooledDelta.toFixed(4)}${pooledDelta > 0 && pairedGain <= 0 ? ' — pooled gain is a task-mix artefact' : ''})${pairedTier1Test?.significant && meanDelta(collectiveTier1Deltas) > 0 ? ` | BUT CI Tier 1 forced DOES beat single paired (p=${pairedTier1Test.pValue.toFixed(4)})` : ''}`,
    q3_collectiveWinsWhere: collectiveWins.length > 0 ? collectiveWins : ['No scenarios identified'],
    q4_collectiveNotWorth: collectiveNotWorth.length > 0 ? collectiveNotWorth : ['All scenarios show collective advantage'],
    q5_adaptiveSuperior: adaptiveQ > singleQ && adaptiveQ > collectiveQ ? `Yes (quality: ${adaptiveQ.toFixed(4)})` : `No (quality: ${adaptiveQ.toFixed(4)})`,
    q6_collectiveJustifiesCost: pairedGain > thresholds.minQualityGainForCollective ? 'Quality gain (paired, per-task) exceeds threshold' : 'Quality gain (paired, per-task) does not justify additional cost',
    q7_productionDefault: goApproaches.length > 0 ? goApproaches[0] : bestModel,
    q8_premiumOnly: `CI Tier 1 forced: ${isNaN(collectiveTier1Q) ? 'no data' : collectiveTier1Q.toFixed(4)} | CI real: ${isNaN(collectiveQ) ? 'no data' : collectiveQ.toFixed(4)} | Budget singles: ${isNaN(budgetQ) ? 'no data' : budgetQ.toFixed(4)} | Orchestration gain: ${isNaN(orchestrationGain) ? 'N/A' : orchestrationGain.toFixed(4)}`,
    q9_go: goApproaches,
    q10_noGo: noGoApproaches,
    q11_inconclusive: inconclusiveApproaches,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getApproaches(results: ExperimentExecutionResult[]): Array<{ label: string; mode: ExecutionMode }> {
  const seen = new Map<string, ExecutionMode>();
  for (const r of results) {
    const label = getLabel(r);
    if (!seen.has(label)) seen.set(label, r.executionMode);
  }
  return [...seen.entries()].map(([label, mode]) => ({ label, mode }));
}

function getLabel(r: ExperimentExecutionResult): string {
  switch (r.executionMode) {
    case 'single-model': return r.model ?? 'single-unknown';
    case 'collective': return `collective:${r.strategy}`;
    case 'collective-tier1': return `collective-tier1:${r.strategy}`;
    case 'single-budget': return r.model ?? 'budget-unknown';
    case 'adaptive': return 'adaptive:auto';
    case 'ablation': return `ablation:${r.strategy}:${r.ablationCondition ?? ''}`;
    default: return r.executionMode;
  }
}

function getEvidence(sampleSize: number, thresholds: GoNoGoThresholds): EvidenceStrength {
  if (sampleSize >= thresholds.minSamplesHighConfidence) return 'strong';
  if (sampleSize >= thresholds.minSamplesModerateConfidence) return 'moderate';
  if (sampleSize >= 5) return 'weak';
  return 'inconclusive';
}

function emptyDecision(approach: { label: string; mode: ExecutionMode }, profile: UsageProfile): GoNoGoDecision {
  return {
    approach: approach.label, mode: approach.mode, profile, verdict: 'INCONCLUSIVE',
    reason: 'No execution data available',
    metrics: { avgQuality: 0, avgCost: 0, avgLatency: 0, successRate: 0, consistencyIndex: 0, sampleSize: 0 },
    evidence: 'inconclusive', thresholdsMet: [], thresholdsFailed: [],
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}
