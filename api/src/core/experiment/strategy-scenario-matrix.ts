// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy × Scenario matrix — per-strategy WIN/TIE/LOSS against the BEST
 * frontier single, per test scenario.
 *
 * The segmented benchmark report answers the PRE-REGISTERED question ("does the
 * verifier-armed consensus beat the best single in each registered regime?").
 * This module answers the wider DESCRIPTIVE question the benchmark also owes
 * its readers: with ~31 collective strategies in the matrix, each individual
 * strategy can win, tie, or lose on the same terrain — and that per-strategy
 * scoreboard is part of the result, not noise. A reader should be able to see
 * "stigmergic-refinement wins on hard-verifiable but loses on creative" with
 * the same paired-by-task rigor as the headline verdict.
 *
 * Statistical honesty for a matrix this wide is non-negotiable:
 *   - Every cell is PAIRED BY TASK against the BEST single MODEL's mean
 *     performance per task (review fix: NOT the raw max over every single-model
 *     ROW, which mixes models AND repetitions and is a biased order statistic —
 *     see bestSingleModelMeanPerTask below).
 *   - Rows use the same eligibility filter as go-no-go (frozen + success +
 *     non-null score), so cells reconcile with the headline verdicts; each cell
 *     also reports its own successRate against ALL attempted executions, so an
 *     unreliable strategy cannot look good purely by having its failures dropped.
 *   - WIN/LOSS labels require a paired-delta confidence interval that clears
 *     ±TIE_MARGIN AND survives Benjamini-Hochberg FDR correction across the
 *     whole matrix: ~465 raw p<0.05 tests would manufacture ~23 fake wins by
 *     chance; q-values keep the discovery set honest. TIE requires the WHOLE CI
 *     to sit inside ±TIE_MARGIN (not just the point estimate) — a 2-task sample
 *     with a wide, barely-centered CI is UNDECIDED, not a proven draw.
 *   - Cells remain DESCRIPTIVE/secondary: a WIN here is a leaderboard entry
 *     and a hypothesis candidate — confirmatory evidence is still exclusively
 *     the pre-registered regimes in segmented-benchmark-report.ts.
 */
import type { ExperimentExecutionResult, GoNoGoThresholds } from './experiment-types';
import { DEFAULT_THRESHOLDS } from './experiment-types';
import {
  pairByTaskDeltas,
  pairedTTest,
  meanDelta,
  sharedTaskIndices,
  benjaminiHochbergQValues,
  computeConfidenceInterval,
  type TaskScore,
} from './statistical-analysis';
import { isMeasuredRow, CONFIRMATORY_REGISTRY } from './segmented-benchmark-report';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Cell verdict. WIN/LOSS require an FDR-corrected significant delta whose
 * confidence interval clears ±TIE_MARGIN; TIE means the delta's WHOLE CI sits
 * inside the tie margin (a proven draw, not just a point estimate near zero);
 * UNDECIDED means the delta points somewhere but the evidence does not clear
 * either bar — calling that a win, a loss, or a tie would be exactly the kind
 * of overconfident read this module exists to avoid.
 */
export type MatrixVerdict = 'WIN' | 'TIE' | 'LOSS' | 'UNDECIDED' | 'INSUFFICIENT_DATA';

export interface StrategyScenarioCell {
  /** Arm label: the collective strategy ('consensus'), tier1 variant
   *  ('consensus (tier1)'), or 'adaptive'. */
  readonly strategy: string;
  /** Scenario key: a confirmatory regime key ('ha-hard') or an exploratory
   *  `${taskType}/${complexity}` slice. */
  readonly scenario: string;
  /** Whether this scenario is one of the pre-registered regimes. Even then, a
   *  WIN cell for a non-armed strategy is descriptive, not confirmatory. */
  readonly scenarioKind: 'confirmatory-regime' | 'exploratory';
  readonly verdict: MatrixVerdict;
  /** Mean per-task delta: strategy score − best single-MODEL mean score
   *  (shared tasks; see bestSingleModelMeanPerTask). */
  readonly pairedDeltaMean: number;
  readonly pValue: number | null;
  /** Benjamini-Hochberg q-value across the WHOLE matrix (null when no test ran). */
  readonly qValue: number | null;
  readonly sharedTaskCount: number;
  readonly sharedTaskIndices: number[];
  /** Successful (measured) executions ÷ ALL attempted executions for this
   *  strategy in this scenario — independent of the quality delta, since
   *  isMeasuredRow drops failures and a strategy that times out 40% of the
   *  time must not look flawless just because its failures were excluded. */
  readonly successRate: number;
  readonly attemptedExecutions: number;
  /** Descriptive cost context (NOT part of the verdict): mean cost per
   *  execution for this strategy's rows vs the BEST single-model baseline's
   *  own rows in the scenario (the same rows the quality delta is measured
   *  against — not the mean of every single, which would compare the
   *  strategy's cost to arms that never set the quality bar). */
  readonly strategyAvgCostUsd: number;
  readonly bestSingleAvgCostUsd: number;
}

export interface StrategyScoreboardRow {
  readonly strategy: string;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  readonly undecided: number;
  readonly insufficientData: number;
  /** Paired delta vs the best single-model baseline across ALL tasks the
   *  strategy shares with singles (scenario-agnostic overall line). */
  readonly overallPairedDeltaMean: number;
  readonly overallSharedTaskCount: number;
  /** Successful ÷ attempted executions across every scenario this strategy
   *  appears in. */
  readonly overallSuccessRate: number;
  readonly overallAttemptedExecutions: number;
}

export interface StrategyScenarioMatrix {
  readonly experimentId: string;
  readonly cells: StrategyScenarioCell[];
  /** One row per strategy, sorted by (wins desc, losses asc, overall delta
   *  desc, strategy name asc — a deterministic final tiebreak). */
  readonly scoreboard: StrategyScoreboardRow[];
  readonly scenarios: string[];
  readonly strategies: string[];
  readonly methodologyNote: string;
}

// ─── Internals ───────────────────────────────────────────────────────────────

const METHODOLOGY_NOTE =
  'Per-strategy scoreboard vs the BEST single MODEL\'s mean performance per task ' +
  '(repetitions averaged per model BEFORE picking the best model — never the ' +
  'raw max across every single-model execution, which mixes models and ' +
  'repetitions and is a biased "luckiest draw" baseline that can fabricate ' +
  'LOSS labels against a strategy that beats every single model on average). ' +
  'Paired by task index within each scenario, same eligibility filter as the ' +
  'confirmatory verdicts. WIN and LOSS labels require BOTH a paired-delta ' +
  'confidence interval clearing ±tie-margin AND significance after ' +
  'Benjamini-Hochberg FDR correction across every cell of this matrix — with ' +
  'hundreds of simultaneous comparisons, raw p<0.05 would manufacture dozens of ' +
  'fake wins by chance. TIE requires the WHOLE confidence interval (not just the ' +
  'point estimate) to sit inside ±tie-margin — a 2-task sample with a wide, ' +
  'barely-centered interval is UNDECIDED, not a proven draw. Every cell also ' +
  'reports successRate against ALL attempted executions (not just the measured ' +
  'ones the quality delta uses), so an unreliable strategy cannot top the ' +
  'leaderboard purely because its failures were excluded from scoring. This ' +
  'matrix is DESCRIPTIVE (a leaderboard and a hypothesis generator): ' +
  'confirmatory evidence for the thesis remains exclusively the pre-registered ' +
  'regimes in the segmented benchmark report. Every cell lists its shared task ' +
  'indices so any entry can be audited or re-run.';

/** Tie margin below which a paired delta is a draw — mirrors the go-no-go /
 *  segmented-report convention (0.02 quality points). */
const TIE_MARGIN = 0.02;

/** FDR level for WIN/LOSS labels. */
const FDR_ALPHA = 0.05;

/** Arm label for a collective-family row; null for rows that are not a
 *  collective-family arm (singles form the baseline, not matrix rows). */
function strategyLabel(r: ExperimentExecutionResult): string | null {
  switch (r.executionMode) {
    case 'collective':
      return r.strategy;
    case 'collective-tier1':
      return `${r.strategy} (tier1)`;
    case 'adaptive':
      return 'adaptive';
    default:
      return null;
  }
}

function scenarioOf(r: ExperimentExecutionResult): { key: string; kind: StrategyScenarioCell['scenarioKind'] } {
  const regime = CONFIRMATORY_REGISTRY.find((g) => g.taskType === r.taskType);
  if (regime) return { key: regime.key, kind: 'confirmatory-regime' };
  return { key: `${r.taskType}/${r.complexity}`, kind: 'exploratory' };
}

/** Finite-only TaskScore projection — a defensive guard, not expected to fire
 *  in practice (the runner's scoring paths do not produce NaN), but a NaN
 *  quality score would otherwise pass isMeasuredRow's `!= null` check and
 *  desync sharedTaskIndices (which does not itself filter finiteness) from
 *  the deltas actually used by the paired test. Filtering here, at the single
 *  source both consumers read from, keeps the two always in agreement. */
function toTaskScores(rows: ExperimentExecutionResult[]): TaskScore[] {
  return rows
    .filter((r) => Number.isFinite(r.qualityScore))
    .map((r) => ({ taskIndex: r.taskIndex, value: r.qualityScore! }));
}

interface SingleModelTaskBaseline {
  readonly taskIndex: number;
  readonly value: number;
  readonly costUsd: number;
}

/**
 * The BEST single MODEL's mean performance per task — repetitions of the SAME
 * model are averaged first, then the max is taken across DISTINCT models.
 *
 * This replaces a raw per-row max (bestSinglePerTask in
 * segmented-benchmark-report.ts), which is safe for that module's WIN-only
 * verdict (a generous single-side baseline only makes a win HARDER to confirm)
 * but is unsound as a baseline for this module's LOSS labels: taking the max
 * over every row averages in the noise of repeated draws, so even a strategy
 * whose TRUE mean equals or beats every single model accrues systematically
 * negative per-task deltas against that inflated "luckiest draw" ceiling — a
 * bias FDR correction cannot fix, because FDR controls false positives under a
 * valid null, not a shifted test statistic. Rep-averaging per model before
 * taking the max removes exactly that order-statistic inflation, so the
 * baseline represents "the best model's expected performance", the fair
 * comparator for a WIN or a LOSS claim alike.
 */
function bestSingleModelMeanPerTask(rows: ExperimentExecutionResult[]): SingleModelTaskBaseline[] {
  interface Group { taskIndex: number; qualities: number[]; costs: number[] }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    if (!Number.isFinite(r.qualityScore)) continue;
    const model = r.model ?? 'unknown';
    const key = `${r.taskIndex}|${model}`;
    let g = groups.get(key);
    if (!g) {
      g = { taskIndex: r.taskIndex, qualities: [], costs: [] };
      groups.set(key, g);
    }
    g.qualities.push(r.qualityScore!);
    if (!r.costMissing) g.costs.push(r.costUsd);
  }

  const byTask = new Map<number, { value: number; costUsd: number }>();
  for (const g of groups.values()) {
    const meanQuality = g.qualities.reduce((s, v) => s + v, 0) / g.qualities.length;
    const meanCost = g.costs.length > 0 ? g.costs.reduce((s, v) => s + v, 0) / g.costs.length : 0;
    const cur = byTask.get(g.taskIndex);
    if (cur === undefined || meanQuality > cur.value) {
      byTask.set(g.taskIndex, { value: meanQuality, costUsd: meanCost });
    }
  }
  return [...byTask.entries()].map(([taskIndex, v]) => ({ taskIndex, value: v.value, costUsd: v.costUsd }));
}

function avgCost(rows: ExperimentExecutionResult[]): number {
  // Exclude rows whose cost could not be attributed — a $0 missing cost on a
  // success biases the mean down (same rule as the go-no-go cost metrics).
  const priced = rows.filter((r) => !r.costMissing);
  if (priced.length === 0) return 0;
  return priced.reduce((s, r) => s + r.costUsd, 0) / priced.length;
}

/** Classify a cell from its paired deltas + FDR q-value. Requires the WHOLE
 *  confidence interval inside ±TIE_MARGIN for a TIE (not just the point
 *  estimate) — a 2-task sample whose CI spans ±3 is not a proven draw just
 *  because its mean happens to land near zero. */
function classifyCell(deltas: number[], qValue: number | null): MatrixVerdict {
  if (deltas.length < 2) return 'INSUFFICIENT_DATA';
  const ci = computeConfidenceInterval(deltas);
  const tieProven = ci.lower >= -TIE_MARGIN && ci.upper <= TIE_MARGIN;
  if (tieProven) return 'TIE';
  const mean = meanDelta(deltas);
  if (qValue != null && qValue < FDR_ALPHA) return mean > 0 ? 'WIN' : 'LOSS';
  return 'UNDECIDED';
}

// ─── Generator ───────────────────────────────────────────────────────────────

export function generateStrategyScenarioMatrix(
  experimentId: string,
  results: ExperimentExecutionResult[],
  _thresholds: GoNoGoThresholds = DEFAULT_THRESHOLDS,
): StrategyScenarioMatrix {
  // Attempted-execution tally (successRate denominator) — computed from EVERY
  // row regardless of success/phase, so a strategy cannot look flawless purely
  // because isMeasuredRow dropped its failures.
  const attemptedByCell = new Map<string, number>();
  for (const r of results) {
    const label = strategyLabel(r);
    if (label === null) continue;
    const { key: scenario } = scenarioOf(r);
    const k = `${label}|${scenario}`;
    attemptedByCell.set(k, (attemptedByCell.get(k) ?? 0) + 1);
  }
  const attemptedByStrategy = new Map<string, number>();
  for (const r of results) {
    const label = strategyLabel(r);
    if (label === null) continue;
    attemptedByStrategy.set(label, (attemptedByStrategy.get(label) ?? 0) + 1);
  }

  const measured = results.filter(isMeasuredRow);

  // Group measured rows by scenario, and inside each scenario split into the
  // single-model baseline pool and per-strategy pools.
  interface ScenarioBucket {
    kind: StrategyScenarioCell['scenarioKind'];
    singles: ExperimentExecutionResult[];
    byStrategy: Map<string, ExperimentExecutionResult[]>;
  }
  const scenarios = new Map<string, ScenarioBucket>();
  const allStrategies = new Set<string>();

  for (const r of measured) {
    const { key, kind } = scenarioOf(r);
    let bucket = scenarios.get(key);
    if (!bucket) {
      bucket = { kind, singles: [], byStrategy: new Map() };
      scenarios.set(key, bucket);
    }
    if (r.executionMode === 'single-model') {
      bucket.singles.push(r);
      continue;
    }
    const label = strategyLabel(r);
    if (label === null) continue; // single-budget etc. — neither baseline nor row
    allStrategies.add(label);
    const rows = bucket.byStrategy.get(label) ?? [];
    rows.push(r);
    bucket.byStrategy.set(label, rows);
  }

  // First pass: compute every cell's paired stats (verdicts need the FDR pass,
  // which needs the whole family of p-values first).
  interface PendingCell {
    strategy: string;
    scenario: string;
    scenarioKind: StrategyScenarioCell['scenarioKind'];
    deltas: number[];
    pValue: number | null;
    shared: number[];
    strategyAvgCostUsd: number;
    bestSingleAvgCostUsd: number;
    successRate: number;
    attemptedExecutions: number;
  }
  const pending: PendingCell[] = [];

  for (const [scenarioKey, bucket] of scenarios) {
    const baseline = bestSingleModelMeanPerTask(bucket.singles);
    const baselineScores: TaskScore[] = baseline.map((b) => ({ taskIndex: b.taskIndex, value: b.value }));
    const baselineCostByTask = new Map(baseline.map((b) => [b.taskIndex, b.costUsd]));

    for (const [strategy, rows] of bucket.byStrategy) {
      const strategyScores = toTaskScores(rows);
      const deltas = pairByTaskDeltas(strategyScores, baselineScores);
      const shared = sharedTaskIndices(strategyScores, baselineScores);
      const pValue = deltas.length >= 2 ? pairedTTest(deltas).pValue : null;
      const attemptedExecutions = attemptedByCell.get(`${strategy}|${scenarioKey}`) ?? rows.length;
      const sharedCosts = shared.map((ti) => baselineCostByTask.get(ti)).filter((c): c is number => c != null);
      pending.push({
        strategy,
        scenario: scenarioKey,
        scenarioKind: bucket.kind,
        deltas,
        pValue,
        shared,
        strategyAvgCostUsd: avgCost(rows),
        bestSingleAvgCostUsd: sharedCosts.length > 0 ? sharedCosts.reduce((s, v) => s + v, 0) / sharedCosts.length : 0,
        successRate: attemptedExecutions > 0 ? rows.length / attemptedExecutions : 0,
        attemptedExecutions,
      });
    }
  }

  // FDR pass across the whole matrix, then final verdicts.
  const qValues = benjaminiHochbergQValues(pending.map((c) => c.pValue));
  const cells: StrategyScenarioCell[] = pending.map((c, i) => {
    const qValue = qValues[i];
    const verdict = classifyCell(c.deltas, qValue);
    return {
      strategy: c.strategy,
      scenario: c.scenario,
      scenarioKind: c.scenarioKind,
      verdict,
      pairedDeltaMean: meanDelta(c.deltas),
      pValue: c.pValue,
      qValue,
      sharedTaskCount: c.shared.length,
      sharedTaskIndices: c.shared,
      successRate: c.successRate,
      attemptedExecutions: c.attemptedExecutions,
      strategyAvgCostUsd: c.strategyAvgCostUsd,
      bestSingleAvgCostUsd: c.bestSingleAvgCostUsd,
    };
  });

  // Scoreboard: verdict tallies per strategy + a scenario-agnostic overall
  // paired delta (all shared tasks, pooled across scenarios but still paired
  // by task against the global best-single-model baseline) + overall
  // reliability. Sort winners-first, with a deterministic final tiebreak by
  // strategy name so equal-record rows do not depend on input row order.
  const globalBaseline = bestSingleModelMeanPerTask(measured.filter((r) => r.executionMode === 'single-model'));
  const globalBaselineScores: TaskScore[] = globalBaseline.map((b) => ({ taskIndex: b.taskIndex, value: b.value }));
  const scoreboard: StrategyScoreboardRow[] = [...allStrategies].map((strategy) => {
    const own = cells.filter((c) => c.strategy === strategy);
    const tally = (v: MatrixVerdict) => own.filter((c) => c.verdict === v).length;
    const strategyRows = measured.filter((r) => strategyLabel(r) === strategy);
    const overallDeltas = pairByTaskDeltas(toTaskScores(strategyRows), globalBaselineScores);
    const overallAttempted = attemptedByStrategy.get(strategy) ?? strategyRows.length;
    return {
      strategy,
      wins: tally('WIN'),
      ties: tally('TIE'),
      losses: tally('LOSS'),
      undecided: tally('UNDECIDED'),
      insufficientData: tally('INSUFFICIENT_DATA'),
      overallPairedDeltaMean: meanDelta(overallDeltas),
      overallSharedTaskCount: overallDeltas.length,
      overallSuccessRate: overallAttempted > 0 ? strategyRows.length / overallAttempted : 0,
      overallAttemptedExecutions: overallAttempted,
    };
  }).sort((a, b) =>
    b.wins - a.wins ||
    a.losses - b.losses ||
    b.overallPairedDeltaMean - a.overallPairedDeltaMean ||
    a.strategy.localeCompare(b.strategy),
  );

  return {
    experimentId,
    cells,
    scoreboard,
    scenarios: [...scenarios.keys()].sort(),
    strategies: [...allStrategies].sort(),
    methodologyNote: METHODOLOGY_NOTE,
  };
}
