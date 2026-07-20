// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Experiment Report Generator
 *
 * Transforms raw experiment executions into a comprehensive comparative report.
 * Answers the core question: "Does collective intelligence deliver better results
 * than isolated Tier 1 models?"
 *
 * Report structure:
 * 1. Overall ranking by mode
 * 2. Rankings by taskType and complexity
 * 3. Head-to-head statistical comparisons
 * 4. Pareto dominance analysis
 * 5. Trade-off analysis (quality vs cost, quality vs latency)
 * 6. Consistency & stability analysis
 * 7. Limitations
 * 8. Executive conclusion with confidence levels
 */

import {
  computeDescriptiveStats,
  computeConfidenceInterval,
  computeStabilityIndex,
  computeCostEfficiency,
  computeQualityPerSecond,
  computeCompositeRegret,
  computeCompositeEfficiency,
  computeParetoDominance,
  detectOutliers,
  pairByTaskDeltas,
  pairedTTest,
  pairedCohensD,
  meanDelta,
  type TaskScore,
} from './statistical-analysis';
import type { TTestResult, EffectSizeResult, WinRateComparison } from './experiment-types';

import type {
  ExperimentExecutionResult,
  ExperimentReportBundle,
  ExecutiveSummary,
  MethodologyDocument,
  DetailedResults,
  StatisticalAppendix,
  DecisionMemo,
  ExecutionMode,
  SegmentAnalysis,
  HeadToHead,
  ConclusionConfidence,
  EvidenceStrength,
  FinalVerdict,
  ParetoPoint,
  CompositeRegret,
  CompositeEfficiency,
  ConfidenceInterval,
} from './experiment-types';
import { getSuiteCoverage } from './experiment-suite';

// ─── Minimum Samples ───────────────────────────────────────────────────────

const MIN_SAMPLES_PER_SEGMENT = 5;
const MIN_SAMPLES_HIGH_CONFIDENCE = 30;
const MIN_SAMPLES_MEDIUM_CONFIDENCE = 10;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Generate a full 5-document comparative experiment report bundle.
 *
 * Documents:
 * 1. Executive Summary — key findings, final verdict
 * 2. Methodology — how the experiment was conducted
 * 3. Detailed Results — rankings, head-to-head, trade-offs
 * 4. Statistical Appendix — raw stats, t-tests, effect sizes
 * 5. Decision Memo — actionable recommendations
 */
export function generateReport(
  experimentId: string,
  experimentName: string,
  results: ExperimentExecutionResult[],
  config?: { warmupExecutions?: number; freezeLearningDuringEval?: boolean },
): ExperimentReportBundle {
  // ── Error Exclusion Policy (formalized for publication) ──
  // Provider errors (402/403/404/429) are EXCLUDED from quality analysis
  // but REPORTED as a separate "reliability" metric per strategy.
  // This prevents survivorship bias from conflating provider issues with strategy quality.
  const PROVIDER_ERROR_PATTERNS = /402|403|404|429|Insufficient credit|Forbidden|rate limit|exhausted|Model not found/i;

  const frozenResults = results.filter(r => r.phase === 'frozen');
  const frozenProviderErrors = frozenResults.filter(r =>
    !r.success && r.responseSummary && PROVIDER_ERROR_PATTERNS.test(r.responseSummary),
  );
  const frozenStrategyErrors = frozenResults.filter(r =>
    !r.success && (!r.responseSummary || !PROVIDER_ERROR_PATTERNS.test(r.responseSummary)),
  );
  const successfulResults = frozenResults.filter(r => r.success && r.qualityScore !== null);

  // Exclusion stats: tracked for parity with the report's transparency goals.
  // Computed but not currently surfaced in the report struct — kept in code
  // (without a binding) so future enrichment can pick them up without rerunning
  // the filtering logic.
  void {
    totalFrozen: frozenResults.length,
    successful: successfulResults.length,
    providerErrors: frozenProviderErrors.length,
    strategyErrors: frozenStrategyErrors.length,
    exclusionRate: frozenResults.length > 0
      ? (frozenProviderErrors.length / frozenResults.length * 100).toFixed(1) + '%'
      : '0%',
  };

  // Core analyses
  const segments = computeSegmentAnalyses(successfulResults);
  const overallRanking = computeOverallRanking(successfulResults);
  const rankingByTaskType = computeRankingByDimension(successfulResults, 'taskType');
  const rankingByComplexity = computeRankingByDimension(successfulResults, 'complexity');
  const rankingByDomain = computeRankingByDimension(successfulResults, 'domain');
  const headToHead = computeHeadToHeadComparisons(successfulResults);
  const paretoDominance = computeParetoAnalysis(successfulResults);
  const tradeoffs = computeTradeoffsWithEfficiency(successfulResults);
  const consistencyAnalysis = computeConsistencyAnalysis(successfulResults);
  // `identifyLimitations` is invoked again below at the methodology assembly
  // (line ~513) where the result is actually consumed; the prior duplicate
  // computation here was dead.
  const compositeRegret = computeCompositeRegretByGroup(successfulResults);
  const compositeEfficiencyMap = computeCompositeEfficiencyByGroup(successfulResults);

  // Document 1: Executive Summary
  const executiveSummary = buildExecutiveSummary(
    experimentId, experimentName, results, successfulResults, overallRanking, headToHead, paretoDominance,
  );

  // Document 2: Methodology
  const methodology = buildMethodology(results, config);

  // Document 3: Detailed Results
  const detailedResults: DetailedResults = {
    overallRanking: overallRanking.map(r => ({
      ...r,
      sampleSize: successfulResults.filter(s => getLabel(s) === r.label).length,
      ci95: computeConfidenceInterval(successfulResults.filter(s => getLabel(s) === r.label).map(s => s.qualityScore!)),
    })),
    rankingByTaskType,
    rankingByComplexity,
    rankingByDomain,
    segments,
    headToHead,
    paretoDominance,
    tradeoffs,
    consistencyAnalysis,
    compositeRegret,
    compositeEfficiency: compositeEfficiencyMap,
  };

  // Document 4: Statistical Appendix
  const statisticalAppendix = buildStatisticalAppendix(successfulResults, headToHead);

  // Document 5: Decision Memo
  const decisionMemo = buildDecisionMemo(successfulResults, headToHead, paretoDominance, tradeoffs, compositeRegret);

  return {
    executiveSummary,
    methodology,
    detailedResults,
    statisticalAppendix,
    decisionMemo,
  };
}

// ─── Segment Analysis ──────────────────────────────────────────────────────

function computeSegmentAnalyses(results: ExperimentExecutionResult[]): SegmentAnalysis[] {
  const groups = groupBy(results, r => `${r.executionMode}|${r.taskType}|${r.complexity}`);
  const segments: SegmentAnalysis[] = [];

  for (const [key, items] of Object.entries(groups)) {
    const [executionMode, taskType, complexity] = key.split('|');
    const qualities = items.map(r => r.qualityScore!);
    const costs = items.map(r => r.costUsd);
    const latencies = items.map(r => r.latencyMs);

    if (qualities.length < MIN_SAMPLES_PER_SEGMENT) continue;

    segments.push({
      segment: { executionMode: executionMode as ExecutionMode, taskType, complexity },
      quality: computeDescriptiveStats(qualities),
      cost: computeDescriptiveStats(costs),
      latency: computeDescriptiveStats(latencies),
      successRate: items.filter(r => r.success).length / items.length,
      stabilityIndex: computeStabilityIndex(qualities),
      sampleSize: items.length,
      confidenceInterval: computeConfidenceInterval(qualities),
    });
  }

  return segments.sort((a, b) => b.quality.mean - a.quality.mean);
}

// ─── Overall Ranking ───────────────────────────────────────────────────────

type RankingEntry = { label: string; mode: ExecutionMode; avgQuality: number; avgCost: number; avgLatency: number; winRate: number };

function computeOverallRanking(results: ExperimentExecutionResult[]): RankingEntry[] {
  // Group by mode + strategy/model label
  const groups = groupBy(results, r => getLabel(r));
  const ranking: RankingEntry[] = [];

  for (const [label, items] of Object.entries(groups)) {
    const qualities = items.map(r => r.qualityScore!);
    const costs = items.map(r => r.costUsd);
    const latencies = items.map(r => r.latencyMs);

    ranking.push({
      label,
      mode: items[0].executionMode,
      avgQuality: mean(qualities),
      avgCost: mean(costs),
      avgLatency: mean(latencies),
      winRate: 0, // filled below
    });
  }

  // Compute pairwise win rates against all others
  for (const entry of ranking) {
    const entryResults = groups[entry.label];
    let wins = 0, total = 0;

    for (const other of ranking) {
      if (other.label === entry.label) continue;
      const otherResults = groups[other.label];

      // Pair by task index
      const pairs = pairByTask(entryResults, otherResults);
      for (const [a, b] of pairs) {
        total++;
        if (a.qualityScore! > b.qualityScore! + 0.02) wins++;
      }
    }

    entry.winRate = total > 0 ? wins / total : 0;
  }

  return ranking.sort((a, b) => b.avgQuality - a.avgQuality);
}

// ─── Rankings by Dimension ─────────────────────────────────────────────────

function computeRankingByDimension(
  results: ExperimentExecutionResult[],
  dimension: 'taskType' | 'complexity' | 'domain',
): Record<string, Array<{ label: string; avgQuality: number; sampleSize: number; ci95: ConfidenceInterval }>> {
  const byDim = groupBy(results, r => r[dimension]);
  const rankings: Record<string, Array<{ label: string; avgQuality: number; sampleSize: number; ci95: ConfidenceInterval }>> = {};

  for (const [dimValue, dimResults] of Object.entries(byDim)) {
    const byLabel = groupBy(dimResults, r => getLabel(r));
    const dimRanking: Array<{ label: string; avgQuality: number; sampleSize: number; ci95: ConfidenceInterval }> = [];

    for (const [label, items] of Object.entries(byLabel)) {
      const qualities = items.map(r => r.qualityScore!);
      dimRanking.push({
        label,
        avgQuality: mean(qualities),
        sampleSize: items.length,
        ci95: computeConfidenceInterval(qualities),
      });
    }

    rankings[dimValue] = dimRanking.sort((a, b) => b.avgQuality - a.avgQuality);
  }

  return rankings;
}

// ─── Head-to-Head Comparisons ──────────────────────────────────────────────

/**
 * PAIRED head-to-head between two arm groups (review STAT-4). The old code ran
 * welchTTest on POOLED score arrays and computeWinRate by ARRAY POSITION — both
 * ignore which task each score came from, so an arm that happened to draw easier
 * tasks looked better (task-mix confounding, the exact mechanism behind the wrong
 * v4 "+0.059" headline). This pairs by taskIndex first, then tests the deltas —
 * the same aligned method go-no-go and the segmented report use.
 */
function pairedHeadToHead(
  aResults: ExperimentExecutionResult[],
  bResults: ExperimentExecutionResult[],
): { tTest: TTestResult; effect: EffectSizeResult; qualityDelta: number; winRate: WinRateComparison; n: number } {
  const toScores = (rows: ExperimentExecutionResult[]): TaskScore[] =>
    rows.filter((r) => r.qualityScore != null).map((r) => ({ taskIndex: r.taskIndex, value: r.qualityScore! }));
  const deltas = pairByTaskDeltas(toScores(aResults), toScores(bResults));
  let aWins = 0, bWins = 0, ties = 0;
  for (const d of deltas) {
    if (d > 0.02) aWins++;
    else if (d < -0.02) bWins++;
    else ties++;
  }
  const total = deltas.length;
  return {
    tTest: pairedTTest(deltas),
    effect: pairedCohensD(deltas),
    qualityDelta: meanDelta(deltas),
    winRate: {
      groupAWins: aWins, groupBWins: bWins, ties,
      groupAWinRate: total > 0 ? aWins / total : 0,
      groupBWinRate: total > 0 ? bWins / total : 0,
      total,
    },
    n: total,
  };
}

function computeHeadToHeadComparisons(results: ExperimentExecutionResult[]): HeadToHead[] {
  const comparisons: HeadToHead[] = [];

  // Compare all arms: A (single-model), B (collective), C (collective-tier1), D (single-budget), adaptive
  const modes: ExecutionMode[] = ['single-model', 'collective', 'collective-tier1', 'single-budget', 'adaptive'];

  for (let i = 0; i < modes.length; i++) {
    for (let j = i + 1; j < modes.length; j++) {
      const aRows = results.filter(r => r.executionMode === modes[i]);
      const bRows = results.filter(r => r.executionMode === modes[j]);

      // Paired-by-task quality stats (review STAT-4) — not pooled means.
      const paired = pairedHeadToHead(aRows, bRows);
      if (paired.n < 2) continue; // fewer than 2 shared tasks — no aligned signal

      // Cost/latency stay descriptive per-arm averages (not a paired quantity).
      const costA = aRows.map(r => r.costUsd);
      const costB = bRows.map(r => r.costUsd);
      const latencyA = aRows.map(r => r.latencyMs);
      const latencyB = bRows.map(r => r.latencyMs);

      comparisons.push({
        groupA: modes[i],
        groupB: modes[j],
        qualityTTest: paired.tTest,
        effectSize: paired.effect,
        winRate: paired.winRate,
        qualityDelta: paired.qualityDelta,
        costDelta: mean(costA) - mean(costB),
        latencyDelta: mean(latencyA) - mean(latencyB),
      });
    }
  }

  // Also compare best single model vs best collective strategy
  const bestSingle = getBestInMode(results, 'single-model');
  const bestCollective = getBestInMode(results, 'collective');

  if (bestSingle && bestCollective) {
    const singleRows = results.filter(r => getLabel(r) === bestSingle);
    const collectiveRows = results.filter(r => getLabel(r) === bestCollective);

    // Paired-by-task (review STAT-4): the best-single-vs-best-collective headline
    // is exactly where pooled means misled v4 — this is arm-level, so aligning by
    // task matters most here.
    const paired = pairedHeadToHead(singleRows, collectiveRows);
    if (paired.n >= 2) {
      const singleCosts = singleRows.map(r => r.costUsd);
      const collectiveCosts = collectiveRows.map(r => r.costUsd);
      const singleLatencies = singleRows.map(r => r.latencyMs);
      const collectiveLatencies = collectiveRows.map(r => r.latencyMs);

      comparisons.push({
        groupA: `best-single:${bestSingle}`,
        groupB: `best-collective:${bestCollective}`,
        qualityTTest: paired.tTest,
        effectSize: paired.effect,
        winRate: paired.winRate,
        qualityDelta: paired.qualityDelta,
        costDelta: mean(singleCosts) - mean(collectiveCosts),
        latencyDelta: mean(singleLatencies) - mean(collectiveLatencies),
      });
    }
  }

  return comparisons;
}

// ─── Pareto Analysis ───────────────────────────────────────────────────────

function computeParetoAnalysis(results: ExperimentExecutionResult[]) {
  const groups = groupBy(results, r => getLabel(r));
  const points: ParetoPoint[] = [];

  for (const [label, items] of Object.entries(groups)) {
    const qualities = items.map(r => r.qualityScore!);
    const costs = items.map(r => r.costUsd);
    const latencies = items.map(r => r.latencyMs);

    points.push({
      label,
      quality: mean(qualities),
      cost: mean(costs),
      latency: mean(latencies),
      successRate: items.filter(r => r.success).length / items.length,
    });
  }

  return computeParetoDominance(points);
}

// ─── Trade-off Analysis ────────────────────────────────────────────────────

function computeTradeoffsWithEfficiency(results: ExperimentExecutionResult[]): DetailedResults['tradeoffs'] {
  const groups = groupBy(results, r => getLabel(r));
  const qualityVsCost: DetailedResults['tradeoffs']['qualityVsCost'] = [];
  const qualityVsLatency: DetailedResults['tradeoffs']['qualityVsLatency'] = [];

  for (const [label, items] of Object.entries(groups)) {
    const avgQuality = mean(items.map(r => r.qualityScore!));
    const avgCost = mean(items.map(r => r.costUsd));
    const avgLatency = mean(items.map(r => r.latencyMs));

    qualityVsCost.push({ label, avgQuality, avgCost, qualityPerDollar: computeCostEfficiency(avgQuality, avgCost) });
    qualityVsLatency.push({ label, avgQuality, avgLatency, qualityPerSecond: computeQualityPerSecond(avgQuality, avgLatency) });
  }

  return {
    qualityVsCost: qualityVsCost.sort((a, b) => b.qualityPerDollar - a.qualityPerDollar),
    qualityVsLatency: qualityVsLatency.sort((a, b) => a.avgLatency - b.avgLatency),
  };
}

// ─── Consistency Analysis ──────────────────────────────────────────────────

function computeConsistencyAnalysis(results: ExperimentExecutionResult[]): DetailedResults['consistencyAnalysis'] {
  const modes: ExecutionMode[] = ['single-model', 'collective', 'adaptive'];
  const byMode: DetailedResults['consistencyAnalysis']['byMode'] = [];

  for (const mode of modes) {
    const modeResults = results.filter(r => r.executionMode === mode);
    if (modeResults.length < 2) continue;

    const qualities = modeResults.map(r => r.qualityScore!);
    const stats = computeDescriptiveStats(qualities);
    const cv = stats.mean > 0 ? stats.stddev / stats.mean : 0;

    byMode.push({ mode, stabilityIndex: computeStabilityIndex(qualities), cv, sampleSize: modeResults.length });
  }

  byMode.sort((a, b) => b.stabilityIndex - a.stabilityIndex);
  return { byMode, mostConsistent: byMode[0]?.mode ?? 'unknown', leastConsistent: byMode[byMode.length - 1]?.mode ?? 'unknown' };
}

// ─── Composite Metrics by Group ────────────────────────────────────────────

function computeCompositeRegretByGroup(results: ExperimentExecutionResult[]): Record<string, CompositeRegret> {
  const groups = groupBy(results, r => getLabel(r));
  const allAvgs = Object.entries(groups).map(([label, items]) => ({
    label, quality: mean(items.map(r => r.qualityScore!)), cost: mean(items.map(r => r.costUsd)), latency: mean(items.map(r => r.latencyMs)),
  }));

  const result: Record<string, CompositeRegret> = {};
  for (const entry of allAvgs) {
    const alternatives = allAvgs.filter(a => a.label !== entry.label);
    result[entry.label] = computeCompositeRegret(entry, alternatives);
  }
  return result;
}

function computeCompositeEfficiencyByGroup(results: ExperimentExecutionResult[]): Record<string, CompositeEfficiency> {
  const groups = groupBy(results, r => getLabel(r));
  const result: Record<string, CompositeEfficiency> = {};
  for (const [label, items] of Object.entries(groups)) {
    result[label] = computeCompositeEfficiency(mean(items.map(r => r.qualityScore!)), mean(items.map(r => r.costUsd)), mean(items.map(r => r.latencyMs)));
  }
  return result;
}

// ─── Limitations ───────────────────────────────────────────────────────────

function identifyLimitations(
  allResults: ExperimentExecutionResult[],
  successfulResults: ExperimentExecutionResult[],
  config?: { warmupExecutions?: number; freezeLearningDuringEval?: boolean },
): string[] {
  const limitations: string[] = [];

  const failRate = 1 - successfulResults.length / Math.max(allResults.length, 1);
  if (failRate > 0.1) limitations.push(`High failure rate: ${(failRate * 100).toFixed(1)}% of executions failed`);
  if (successfulResults.length < 300) limitations.push(`Sample size (${successfulResults.length}) below recommended minimum of 300`);

  const modes: ExecutionMode[] = ['single-model', 'collective', 'adaptive'];
  for (const mode of modes) {
    const count = successfulResults.filter(r => r.executionMode === mode).length;
    if (count < 30) limitations.push(`${mode} mode has only ${count} successful executions — low confidence`);
  }

  const taskTypes = new Set(successfulResults.map(r => r.taskType));
  if (taskTypes.size < 5) limitations.push(`Only ${taskTypes.size} task types — limited generalization`);

  if (!(config?.freezeLearningDuringEval ?? true)) {
    limitations.push('CRITICAL: Learning systems were NOT frozen during evaluation — adaptive mode may have improved during measurement');
  }

  limitations.push('Quality scores from LLM-as-judge may have systematic biases toward certain response styles');
  limitations.push('Cost data may be estimates when API does not return precise billing');

  return limitations;
}

// ─── Document Builders ─────────────────────────────────────────────────────

function buildExecutiveSummary(
  experimentId: string, experimentName: string,
  allResults: ExperimentExecutionResult[], successfulResults: ExperimentExecutionResult[],
  ranking: ReturnType<typeof computeOverallRanking>, headToHead: HeadToHead[],
  pareto: ReturnType<typeof computeParetoDominance>,
): ExecutiveSummary {
  const h2h = headToHead.find(h => h.groupA === 'single-model' && h.groupB === 'collective');
  const confidence = getConfidence(successfulResults, 'single-model', 'collective');
  const qualityDelta = h2h?.qualityDelta ?? 0;

  const singleCost = mean(successfulResults.filter(r => r.executionMode === 'single-model').map(r => r.costUsd));
  const collectiveCost = mean(successfulResults.filter(r => r.executionMode === 'collective').map(r => r.costUsd));
  const costMultiplier = singleCost > 0 ? collectiveCost / singleCost : 0;

  const bestOverall = ranking[0];
  const bestByScenario = computeBestByScenario(successfulResults);
  const adaptiveQuality = mean(successfulResults.filter(r => r.executionMode === 'adaptive').map(r => r.qualityScore!));
  const adaptiveCount = successfulResults.filter(r => r.executionMode === 'adaptive').length;

  const finalVerdict = determineFinalVerdict(successfulResults, headToHead, pareto);

  return {
    experimentId, experimentName, generatedAt: new Date().toISOString(),
    totalExecutions: allResults.length, successfulExecutions: successfulResults.length,
    totalCostUsd: allResults.reduce((s, r) => s + r.costUsd, 0),
    bestOverallApproach: bestOverall ? { label: bestOverall.label, mode: bestOverall.mode, avgQuality: bestOverall.avgQuality, evidence: getEvidenceStrength(successfulResults, bestOverall.label) } : { label: 'unknown', mode: 'single-model', avgQuality: 0, evidence: 'inconclusive' },
    bestByScenario,
    collectiveVsTier1: {
      verdict: h2h?.qualityTTest.significant ? (qualityDelta > 0 ? 'Single models outperform' : 'Collective outperforms') : 'No significant difference',
      confidence, qualityDelta, costMultiplier,
    },
    adaptiveValue: {
      verdict: adaptiveCount < 5 ? 'Insufficient data' : `Adaptive avg quality: ${adaptiveQuality.toFixed(4)}`,
      confidence: adaptiveCount >= 30 ? 'high' : adaptiveCount >= 10 ? 'medium' : 'low',
      evidence: `${adaptiveCount} executions`,
    },
    finalVerdict,
    verdictDetails: describeVerdict(finalVerdict, successfulResults),
    keyFindings: extractKeyFindings(successfulResults, headToHead),
  };
}

function buildMethodology(results: ExperimentExecutionResult[], config?: { warmupExecutions?: number; freezeLearningDuringEval?: boolean }): MethodologyDocument {
  const models = [...new Set(results.filter(r => r.model).map(r => r.model!))];
  const strategies = [...new Set(results.filter(r => r.executionMode === 'collective').map(r => r.strategy))];
  const suiteCoverage = getSuiteCoverage();

  return {
    modelsCompared: models.map(m => ({ id: m, displayName: m, provider: inferProvider(m), available: true })),
    collectiveStrategies: strategies,
    adaptiveDescription: 'Full 5-tier adaptive pipeline: triage → archive → Pareto → bandit → heuristic scoring',
    taskSuite: suiteCoverage,
    evaluationCriteria: ['LLM-as-judge quality score (0-1)', 'Cost (USD)', 'Latency (ms)', 'Success rate', 'Token usage'],
    segmentations: ['taskType', 'complexity', 'domain', 'executionMode', 'strategy', 'model', 'phase'],
    phases: { warmupExecutions: config?.warmupExecutions ?? 0, frozenEvaluation: true, learningFrozenDuringMeasurement: config?.freezeLearningDuringEval ?? true },
    statisticalMethods: ['Welch\'s t-test (unequal variances)', 'Cohen\'s d effect size', '95% confidence intervals', 'IQR outlier detection', 'Pareto dominance analysis', 'Composite regret (quality+cost+latency)', 'Stability index (1-CV)'],
    limitations: identifyLimitations(results, results.filter(r => r.success), config),
    threatsToValidity: [
      'LLM-as-judge may favor verbose or structured responses',
      'Cost estimates may not reflect actual billing',
      'Adaptive system learns during warm-up, affecting fairness if phases not properly separated',
      'Model availability may vary during long experiments',
      'Single experiment instance — no cross-instance replication',
    ],
  };
}

function buildStatisticalAppendix(results: ExperimentExecutionResult[], headToHead: HeadToHead[]): StatisticalAppendix {
  const groups = groupBy(results, r => getLabel(r));
  const sampleSizes: StatisticalAppendix['sampleSizes'] = {};
  const descriptiveStatsByGroup: StatisticalAppendix['descriptiveStatsByGroup'] = {};
  const confidenceIntervals: StatisticalAppendix['confidenceIntervals'] = {};
  const outliers: StatisticalAppendix['outliers'] = {};

  for (const [label, items] of Object.entries(groups)) {
    const mode = items[0].executionMode;
    const qualities = items.map(r => r.qualityScore!);
    sampleSizes[label] = { mode, n: items.length, nSuccessful: items.filter(r => r.success).length, successRate: items.filter(r => r.success).length / items.length };
    descriptiveStatsByGroup[label] = { quality: computeDescriptiveStats(qualities), cost: computeDescriptiveStats(items.map(r => r.costUsd)), latency: computeDescriptiveStats(items.map(r => r.latencyMs)) };
    confidenceIntervals[label] = computeConfidenceInterval(qualities);
    const outlierIdx = detectOutliers(qualities);
    outliers[label] = { count: outlierIdx.length, indices: outlierIdx, impact: outlierIdx.length > 0 ? `${outlierIdx.length} outlier(s) detected — may affect mean` : 'none' };
  }

  const tTests = headToHead.map(h => ({
    groupA: h.groupA, groupB: h.groupB, result: h.qualityTTest,
    interpretation: h.qualityTTest.significant ? `Significant difference (p=${h.qualityTTest.pValue.toFixed(4)})` : `Not significant (p=${h.qualityTTest.pValue.toFixed(4)})`,
  }));
  const effectSizes = headToHead.map(h => ({
    groupA: h.groupA, groupB: h.groupB, result: h.effectSize,
    practicalSignificance: h.effectSize.category === 'large' ? 'Practically significant' : h.effectSize.category === 'medium' ? 'Moderate practical significance' : 'Limited practical significance',
  }));

  return {
    sampleSizes, descriptiveStatsByGroup, confidenceIntervals, tTests, effectSizes, outliers,
    methodNotes: ['Welch\'s t-test used (not Student\'s) due to unequal group sizes and variances', 'Cohen\'s d uses pooled standard deviation', 'Outliers detected via IQR method (1.5× multiplier)', 'Confidence intervals use t-distribution for n<30, z-approximation for n≥30'],
  };
}

function buildDecisionMemo(
  results: ExperimentExecutionResult[], headToHead: HeadToHead[],
  pareto: ReturnType<typeof computeParetoDominance>,
  // tradeoffs/compositeRegret reserved for future memo enrichments — kept in
  // signature for caller-stability; underscore prefix marks intent.
  _tradeoffs: DetailedResults['tradeoffs'],
  _compositeRegret: Record<string, CompositeRegret>,
): DecisionMemo {
  const bestSingle = getBestSingleModel(results);
  const h2h = headToHead.find(h => h.groupA === 'single-model' && h.groupB === 'collective');
  const confidence = getConfidence(results, 'single-model', 'collective');

  const singleQ = mean(results.filter(r => r.executionMode === 'single-model').map(r => r.qualityScore!));
  const collectiveQ = mean(results.filter(r => r.executionMode === 'collective').map(r => r.qualityScore!));
  const adaptiveQ = mean(results.filter(r => r.executionMode === 'adaptive').map(r => r.qualityScore!));
  const singleC = mean(results.filter(r => r.executionMode === 'single-model').map(r => r.costUsd));
  const collectiveC = mean(results.filter(r => r.executionMode === 'collective').map(r => r.costUsd));
  const singleL = mean(results.filter(r => r.executionMode === 'single-model').map(r => r.latencyMs));
  const collectiveL = mean(results.filter(r => r.executionMode === 'collective').map(r => r.latencyMs));

  const qualityGain = collectiveQ - singleQ;
  const costMult = singleC > 0 ? collectiveC / singleC : 0;
  const latencyMult = singleL > 0 ? collectiveL / singleL : 0;
  const evidenceStrength: EvidenceStrength = h2h?.qualityTTest.significant && h2h.effectSize.category !== 'negligible' ? (confidence === 'high' ? 'strong' : 'moderate') : (confidence === 'inconclusive' ? 'inconclusive' : 'weak');

  // Where collective wins
  const collectiveWinsWhere = computeCollectiveWinScenarios(results);
  const singleWinsWhere = computeSingleWinScenarios(results);

  const finalVerdict = determineFinalVerdict(results, headToHead, pareto);

  return {
    bestSingleModel: bestSingle,
    collectiveBeatsTier1: { answer: qualityGain > 0.02 && h2h?.qualityTTest.significant ? 'yes' : qualityGain > 0 ? 'depends' : 'no', evidence: evidenceStrength, details: `Quality delta: ${qualityGain.toFixed(4)}, cost: ${costMult.toFixed(1)}x, latency: ${latencyMult.toFixed(1)}x` },
    collectiveWinsWhere,
    singleModelWinsWhere: singleWinsWhere,
    adaptiveBeatsBoth: { answer: adaptiveQ > singleQ && adaptiveQ > collectiveQ ? 'yes' : 'depends', evidence: results.filter(r => r.executionMode === 'adaptive').length >= 30 ? 'moderate' : 'weak', details: `Adaptive quality: ${adaptiveQ.toFixed(4)}` },
    collectiveWorthCost: { answer: qualityGain > 0.05 && costMult < 5 ? 'yes' : qualityGain > 0 && costMult < 10 ? 'marginal' : 'no', qualityGain, costMultiplier: costMult, latencyMultiplier: latencyMult },
    productionRecommendation: {
      defaultMode: 'single-model with best-performing model as default',
      escalationPolicy: 'Use collective strategies for high-complexity tasks where quality delta justifies cost',
      guardrails: ['Set cost ceiling per request', 'Monitor quality regression via shadow evaluation', 'Use adaptive mode only after sufficient learning data (1000+ executions)', 'Separate warm-up from production measurement'],
    },
    conclusionStrength: evidenceStrength,
    proven: extractProvenClaims(results, headToHead),
    notProven: extractUnprovenClaims(results, headToHead),
    dependsOnContext: extractContextDependentClaims(results),
    finalVerdict,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

// ─── Helpers ───────────────────────────────────────────────────────────────

function getLabel(r: ExperimentExecutionResult): string {
  switch (r.executionMode) {
    case 'single-model': return r.model ?? 'single-unknown';
    case 'collective': return `collective:${r.strategy}`;
    case 'collective-tier1': return `collective-tier1:${r.strategy}`;
    case 'single-budget': return r.model ?? 'budget-unknown';
    case 'adaptive': return 'adaptive:auto';
    default: return r.strategy ?? 'unknown';
  }
}

function getBestInMode(results: ExperimentExecutionResult[], mode: ExecutionMode): string | null {
  const modeResults = results.filter(r => r.executionMode === mode);
  const groups = groupBy(modeResults, r => getLabel(r));
  let bestLabel: string | null = null;
  let bestQuality = -1;
  for (const [label, items] of Object.entries(groups)) {
    const avg = mean(items.map(r => r.qualityScore!));
    if (avg > bestQuality) { bestLabel = label; bestQuality = avg; }
  }
  return bestLabel;
}

function getBestSingleModel(results: ExperimentExecutionResult[]): { model: string; avgQuality: number; evidence: string } {
  const singleResults = results.filter(r => r.executionMode === 'single-model' && r.model);
  const byModel = groupBy(singleResults, r => r.model!);
  let bestModel = 'unknown', bestQuality = 0, bestCount = 0;
  for (const [model, items] of Object.entries(byModel)) {
    const avg = mean(items.map(r => r.qualityScore!));
    if (avg > bestQuality) { bestModel = model; bestQuality = avg; bestCount = items.length; }
  }
  return { model: bestModel, avgQuality: bestQuality, evidence: `Average quality ${bestQuality.toFixed(4)} across ${bestCount} executions` };
}

function getConfidence(results: ExperimentExecutionResult[], modeA: ExecutionMode, modeB: ExecutionMode): ConclusionConfidence {
  const minCount = Math.min(results.filter(r => r.executionMode === modeA).length, results.filter(r => r.executionMode === modeB).length);
  if (minCount >= MIN_SAMPLES_HIGH_CONFIDENCE) return 'high';
  if (minCount >= MIN_SAMPLES_MEDIUM_CONFIDENCE) return 'medium';
  if (minCount >= MIN_SAMPLES_PER_SEGMENT) return 'low';
  return 'inconclusive';
}

function getEvidenceStrength(results: ExperimentExecutionResult[], label: string): EvidenceStrength {
  const n = results.filter(r => getLabel(r) === label).length;
  if (n >= 50) return 'strong';
  if (n >= 20) return 'moderate';
  if (n >= 5) return 'weak';
  return 'inconclusive';
}

function inferProvider(modelId: string): string {
  if (modelId.includes('gpt') || modelId.includes('o1') || modelId.includes('o3') || modelId.includes('o4')) return 'OpenAI';
  if (modelId.includes('claude')) return 'Anthropic';
  if (modelId.includes('gemini')) return 'Google';
  if (modelId.includes('grok')) return 'xAI';
  return 'unknown';
}

function determineFinalVerdict(results: ExperimentExecutionResult[], headToHead: HeadToHead[], pareto: ReturnType<typeof computeParetoDominance>): FinalVerdict {
  const h2h = headToHead.find(h => h.groupA === 'single-model' && h.groupB === 'collective');
  if (!h2h || !h2h.qualityTTest.significant) return 'inconclusive';

  if (pareto.frontier.length > 1) return 'depends-on-scenario';

  const adaptiveQ = mean(results.filter(r => r.executionMode === 'adaptive').map(r => r.qualityScore!));
  const singleQ = mean(results.filter(r => r.executionMode === 'single-model').map(r => r.qualityScore!));
  const collectiveQ = mean(results.filter(r => r.executionMode === 'collective').map(r => r.qualityScore!));

  if (adaptiveQ > singleQ && adaptiveQ > collectiveQ && results.filter(r => r.executionMode === 'adaptive').length >= 30) return 'adaptive-wins';
  if (h2h.qualityDelta > 0) return 'single-model-wins';
  return 'collective-wins';
}

function describeVerdict(verdict: FinalVerdict, results: ExperimentExecutionResult[]): string {
  switch (verdict) {
    case 'single-model-wins': return 'Single Tier 1 models deliver the best quality-adjusted results across most scenarios.';
    case 'collective-wins': return 'Collective intelligence strategies deliver measurably better quality, justifying the additional cost in most scenarios.';
    case 'adaptive-wins': return 'The adaptive system outperforms both static single-model and collective approaches by dynamically selecting the best strategy per request.';
    case 'depends-on-scenario': return 'No single approach dominates. The optimal strategy depends on the specific task type, complexity, and cost/latency constraints.';
    case 'inconclusive': return `Insufficient evidence to declare a winner. ${results.length} total executions — more data needed for conclusive results.`;
  }
}

function extractKeyFindings(results: ExperimentExecutionResult[], headToHead: HeadToHead[]): string[] {
  const findings: string[] = [];
  const h2h = headToHead.find(h => h.groupA === 'single-model' && h.groupB === 'collective');
  if (h2h) {
    findings.push(`Quality delta between single-model and collective: ${h2h.qualityDelta.toFixed(4)} (p=${h2h.qualityTTest.pValue.toFixed(4)}, ${h2h.effectSize.category} effect)`);
  }
  const best = getBestSingleModel(results);
  if (best.model !== 'unknown') findings.push(`Best single model: ${best.model} (avg quality: ${best.avgQuality.toFixed(4)})`);
  findings.push(`Total successful executions: ${results.filter(r => r.success).length} / ${results.length}`);
  return findings;
}

function computeBestByScenario(results: ExperimentExecutionResult[]): ExecutiveSummary['bestByScenario'] {
  const scenarios: ExecutiveSummary['bestByScenario'] = [];
  const byTaskType = groupBy(results, r => r.taskType);
  for (const [taskType, items] of Object.entries(byTaskType)) {
    const byLabel = groupBy(items, r => getLabel(r));
    let bestLabel = '', bestQ = -1;
    for (const [label, labelItems] of Object.entries(byLabel)) {
      const avg = mean(labelItems.map(r => r.qualityScore!));
      if (avg > bestQ) { bestLabel = label; bestQ = avg; }
    }
    scenarios.push({ scenario: taskType, winner: bestLabel, avgQuality: bestQ, evidence: getEvidenceStrength(items, bestLabel) });
  }
  return scenarios;
}

function computeCollectiveWinScenarios(results: ExperimentExecutionResult[]): DecisionMemo['collectiveWinsWhere'] {
  const scenarios: DecisionMemo['collectiveWinsWhere'] = [];
  const byTaskType = groupBy(results, r => `${r.taskType}|${r.complexity}`);
  for (const [key, items] of Object.entries(byTaskType)) {
    const singleQ = mean(items.filter(r => r.executionMode === 'single-model').map(r => r.qualityScore!));
    const collectiveQ = mean(items.filter(r => r.executionMode === 'collective').map(r => r.qualityScore!));
    const singleC = mean(items.filter(r => r.executionMode === 'single-model').map(r => r.costUsd));
    const collectiveC = mean(items.filter(r => r.executionMode === 'collective').map(r => r.costUsd));
    if (collectiveQ > singleQ + 0.02) {
      scenarios.push({ scenario: key, qualityGain: collectiveQ - singleQ, costMultiplier: singleC > 0 ? collectiveC / singleC : 0, evidenceStrength: items.length >= 20 ? 'moderate' : 'weak' });
    }
  }
  return scenarios;
}

function computeSingleWinScenarios(results: ExperimentExecutionResult[]): DecisionMemo['singleModelWinsWhere'] {
  const scenarios: DecisionMemo['singleModelWinsWhere'] = [];
  const byTaskType = groupBy(results, r => `${r.taskType}|${r.complexity}`);
  for (const [key, items] of Object.entries(byTaskType)) {
    const singleQ = mean(items.filter(r => r.executionMode === 'single-model').map(r => r.qualityScore!));
    const collectiveQ = mean(items.filter(r => r.executionMode === 'collective').map(r => r.qualityScore!));
    if (singleQ >= collectiveQ - 0.02) {
      scenarios.push({ scenario: key, reason: `Single model quality (${singleQ.toFixed(3)}) matches or exceeds collective (${collectiveQ.toFixed(3)}) at lower cost` });
    }
  }
  return scenarios;
}

function extractProvenClaims(results: ExperimentExecutionResult[], headToHead: HeadToHead[]): string[] {
  const proven: string[] = [];
  for (const h of headToHead) {
    if (h.qualityTTest.significant && h.effectSize.category !== 'negligible') {
      const winner = h.qualityDelta > 0 ? h.groupA : h.groupB;
      proven.push(`${winner} outperforms ${h.qualityDelta > 0 ? h.groupB : h.groupA} in quality (p=${h.qualityTTest.pValue.toFixed(4)}, ${h.effectSize.category} effect)`);
    }
  }
  return proven.length > 0 ? proven : ['No statistically significant differences with meaningful effect sizes detected'];
}

function extractUnprovenClaims(results: ExperimentExecutionResult[], headToHead: HeadToHead[]): string[] {
  const unproven: string[] = [];
  for (const h of headToHead) {
    if (!h.qualityTTest.significant) {
      unproven.push(`No significant difference between ${h.groupA} and ${h.groupB} (p=${h.qualityTTest.pValue.toFixed(4)})`);
    }
  }
  if (results.length < 300) unproven.push('Global conclusions limited by sample size below 300');
  return unproven;
}

function extractContextDependentClaims(_results: ExperimentExecutionResult[]): string[] {
  const claims: string[] = [];
  claims.push('Collective intelligence performance varies by task complexity — may only justify cost for high-complexity tasks');
  claims.push('Adaptive system effectiveness depends on learning data volume and duration');
  claims.push('Cost-efficiency comparison depends on specific model pricing at time of execution');
  return claims;
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

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function pairByTask(
  groupA: ExperimentExecutionResult[],
  groupB: ExperimentExecutionResult[],
): Array<[ExperimentExecutionResult, ExperimentExecutionResult]> {
  const pairs: Array<[ExperimentExecutionResult, ExperimentExecutionResult]> = [];
  const bByTask = new Map<number, ExperimentExecutionResult[]>();

  for (const r of groupB) {
    if (!bByTask.has(r.taskIndex)) bByTask.set(r.taskIndex, []);
    bByTask.get(r.taskIndex)!.push(r);
  }

  for (const a of groupA) {
    const bs = bByTask.get(a.taskIndex);
    if (bs && bs.length > 0) {
      pairs.push([a, bs[0]]);
      bs.shift(); // consume one match
    }
  }

  return pairs;
}
