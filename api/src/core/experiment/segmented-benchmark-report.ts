// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Segmented Benchmark Report — CONFIRMATORY vs EXPLORATORY findings.
 *
 * A domain/task-specific benchmark claim ("the collective wins on executed
 * code") is standard, legitimate practice — exactly what MMLU/HumanEval/
 * SWE-bench-style leaderboards do: different benchmarks for different slices.
 * That is NOT what this module guards against.
 *
 * The one distinction that matters: a slice defined BEFORE seeing results, by
 * an independent mechanistic reason ("best-of-N + an objective verifier should
 * recover the answer when the best single slips") is a testable claim — you
 * could rerun it and it either replicates or doesn't. A slice defined AFTER
 * seeing results, using the outcome itself as the selection criterion ("show
 * me every scenario where collective > single"), is circular — "the thesis
 * holds where it's true" is a tautology, not evidence, and is the exact
 * mechanism that can produce a misleading headline (task-mix
 * confounding discovered post-hoc).
 *
 * This module keeps both, clearly labeled and separately audited:
 *   - CONFIRMATORY: the pre-registered regimes (CONFIRMATORY_REGISTRY below),
 *     each with its mechanistic hypothesis recorded BEFORE this code ever saw
 *     a result. A win here is real confirmatory evidence for that regime.
 *   - EXPLORATORY: everything else, sliced by (taskType/complexity) exactly
 *     like go-no-go's q3/q4 (same paired-by-task fix, same ≥2-shared-task
 *     floor) — useful for generating the NEXT hypothesis, but explicitly
 *     flagged as needing a fresh/held-out run before being cited as validation.
 *
 * Every finding carries its audit trail (shared task indices, N, paired delta,
 * significance) so a reader can verify or rerun the exact comparison.
 */
import type { ExperimentExecutionResult, GoNoGoThresholds } from './experiment-types';
import { DEFAULT_THRESHOLDS } from './experiment-types';
import {
  pairByTaskDeltas,
  pairedTTest,
  pairedCohensD,
  meanDelta,
  sharedTaskIndices,
  type TaskScore,
} from './statistical-analysis';
import {
  CANVAS_PHYSICS_TASK_TYPE,
  HARD_VERIFIABLE_TASK_TYPE,
  CODE_VERIFIED_TASK_TYPE,
} from './experiment-suite';

// ─── Confirmatory regime registry ───────────────────────────────────────────

export interface ConfirmatoryRegime {
  readonly key: string;
  readonly label: string;
  readonly taskType: string;
  /** The mechanistic reason this regime was built — recorded BEFORE any run
   *  of it, not fitted to a result. This is what makes a win here confirmatory
   *  rather than a post-hoc pattern. */
  readonly hypothesis: string;
  /** The c3 config that exercises this regime, for traceability/rerun. */
  readonly configKey: string;
  /** The VERIFIER-ARMED collective strategy this regime's hypothesis is about
   *  (best-of-N over the objective check). The confirmatory verdict compares
   *  THIS strategy against the BEST single per task — NOT the mean of every
   *  collective strategy (which dilutes the armed arm with blind-debate, the
   *  control) against the mean of every single (which dilutes the best single
   *  with the weak per-provider ones). (review STAT-1) */
  readonly armedStrategy: string;
}

/**
 * Pre-registered regimes (2026-07-11/12), each built for a specific
 * mechanistic reason the collective could beat a single — NOT discovered by
 * looking at results. Add a new entry here BEFORE running a new regime, not
 * after seeing whether it happens to win (that would just move the goalpost
 * this module exists to guard).
 */
export const CONFIRMATORY_REGISTRY: readonly ConfirmatoryRegime[] = [
  {
    key: 'ha-hard',
    label: 'Hard verifiable reasoning',
    taskType: HARD_VERIFIABLE_TASK_TYPE,
    hypothesis:
      'Multi-step computations calibrated so frontier singles slip INDEPENDENTLY ' +
      '(different models err at different steps); a diverse voter pool + the ' +
      'objective answer_check verifier (best-of-N) should recover the correct ' +
      'answer when the best single does not. If the collective does not win ' +
      'here, the objective-verification mechanism does not hold anywhere.',
    configKey: 'c3-ha-hard',
    armedStrategy: 'consensus',
  },
  {
    key: 'code-verified',
    label: 'Executed code (sandbox pass-rate)',
    taskType: CODE_VERIFIED_TASK_TYPE,
    // HONEST SCOPE (review V1): the code sandbox is NOT a serializable answer_check,
    // so it does NOT run inside the orchestration engine — the collective cannot
    // do runtime best-of-N over pass-rate on these tasks (it synthesizes without
    // the verifier). The sandbox grades each arm's FINAL output POST-HOC (score =
    // passedCases/totalCases, no LLM judge). So this regime measures "does
    // collective SYNTHESIS yield more passing code than the best single?", NOT
    // "best-of-N rejects the broken candidate". A win is real (synthesis value)
    // but must be attributed to synthesis, not to verifier-armed selection —
    // canvas-physics is the regime that actually arms a runtime check.
    hypothesis:
      'Code is EXECUTED against hidden tests POST-HOC (score = passedCases/' +
      'totalCases, no LLM judge, no runtime verifier inside the collective). ' +
      'Tests whether collective SYNTHESIS produces more passing code than the ' +
      'best single — attributable to synthesis, not to best-of-N selection.',
    configKey: 'c3-code-verified',
    armedStrategy: 'consensus',
  },
  {
    key: 'canvas-physics',
    label: 'Canvas physics scenes (structural verifier)',
    taskType: CANVAS_PHYSICS_TASK_TYPE,
    hypothesis:
      'A structural full-text check (has <canvas>/getContext/requestAnimationFrame) ' +
      'arms best-of-N to reject a non-functional candidate and keep/synthesize ' +
      'from ones that actually run — mirrors the public "a broken output costs ' +
      'you reruns" canvas-physics contests this suite was built to replicate.',
    configKey: 'c3-canvas-physics',
    armedStrategy: 'consensus',
  },
];

// ─── Report types ────────────────────────────────────────────────────────────

export type PairedVerdict = 'COLLECTIVE_WINS' | 'NO_ADVANTAGE' | 'INSUFFICIENT_DATA';

export interface ConfirmatoryFinding {
  readonly kind: 'CONFIRMATORY';
  readonly regime: string;
  readonly label: string;
  readonly hypothesis: string;
  readonly configKey: string;
  readonly verdict: PairedVerdict;
  readonly pairedDeltaMean: number;
  readonly pValue: number | null;
  readonly effectSizeCategory: string | null;
  readonly sharedTaskCount: number;
  readonly sharedTaskIndices: number[];
}

export interface ExploratoryFinding {
  readonly kind: 'EXPLORATORY';
  readonly scenario: string; // "${taskType}/${complexity}"
  readonly verdict: 'COLLECTIVE_WINS' | 'COLLECTIVE_NOT_WORTH';
  readonly pairedDeltaMean: number;
  readonly sharedTaskCount: number;
  readonly sharedTaskIndices: number[];
  /** Fixed caveat, always present — this is NOT confirmatory evidence. */
  readonly caveat: string;
}

export interface SegmentedBenchmarkReport {
  readonly experimentId: string;
  readonly confirmatory: ConfirmatoryFinding[];
  readonly exploratory: ExploratoryFinding[];
  readonly methodologyNote: string;
}

const EXPLORATORY_CAVEAT =
  'EXPLORATORY finding: this scenario was not a pre-registered regime — it was ' +
  'discovered by scanning results after the fact. It is a candidate for the NEXT ' +
  'hypothesis, not confirmatory evidence. To cite it as a validated claim, define ' +
  'it as its own regime (mechanistic reason, own config) and test it on a FRESH ' +
  'run — not by re-reporting the data that discovered it.';

const METHODOLOGY_NOTE =
  'Segmentation into task-specific benchmarks is legitimate (e.g. "wins on ' +
  'executed code") as long as the slice is defined by an independent criterion, ' +
  'not by the outcome it is meant to demonstrate. CONFIRMATORY findings below ' +
  'are regimes registered in CONFIRMATORY_REGISTRY before being run, each with a ' +
  'recorded mechanistic hypothesis — a win there is real evidence, replicable by ' +
  'rerunning the same config. EXPLORATORY findings are post-hoc scenario slices ' +
  '(same paired-by-task method as CONFIRMATORY, ≥2 shared tasks required) that ' +
  'show where an effect appeared in THIS run — useful for generating the next ' +
  'hypothesis, not for validating this one. Every finding lists its exact shared ' +
  'task indices so the comparison can be audited or rerun.';

// ─── Report generator ────────────────────────────────────────────────────────

/**
 * Rows eligible to be scored: the SAME canonical filter go-no-go's primary
 * analysis uses — frozen (measurement) phase, success, non-null qualityScore.
 * Without this, warmup/sanity rows and FAILED rows (qualityScore 0 from a
 * degraded/void result) contaminated the confirmatory verdict. (review STAT-2)
 * Exported for the strategy×scenario matrix, which must use the identical
 * eligibility rule so its cells reconcile with the confirmatory verdicts.
 */
export function isMeasuredRow(r: ExperimentExecutionResult): boolean {
  return r.phase === 'frozen' && r.success === true && r.qualityScore != null;
}

function taskScoresFor(
  results: ExperimentExecutionResult[],
  mode: 'single-model' | 'collective',
  strategy?: string,
): TaskScore[] {
  return results
    .filter((r) => r.executionMode === mode && isMeasuredRow(r))
    .filter((r) => (strategy ? r.strategy === strategy : true))
    .map((r) => ({ taskIndex: r.taskIndex, value: r.qualityScore! }));
}

/**
 * BEST single per task (max qualityScore across single-model arms for each
 * taskIndex) — the correct baseline for the pre-registered hypothesis
 * "verifier-armed consensus beats the BEST single". Using the mean of ALL
 * singles (the old behavior via taskScoresFor) diluted the strong frontier
 * single with the weak per-provider ones, inflating the collective's apparent
 * edge. (review STAT-1)
 */
export function bestSinglePerTask(results: ExperimentExecutionResult[]): TaskScore[] {
  const best = new Map<number, number>();
  for (const r of results) {
    if (r.executionMode !== 'single-model' || !isMeasuredRow(r)) continue;
    const cur = best.get(r.taskIndex);
    if (cur === undefined || r.qualityScore! > cur) best.set(r.taskIndex, r.qualityScore!);
  }
  return [...best.entries()].map(([taskIndex, value]) => ({ taskIndex, value }));
}

function classifyPaired(
  deltas: number[],
): { verdict: PairedVerdict; gain: number; pValue: number | null; effect: string | null } {
  if (deltas.length < 2) return { verdict: 'INSUFFICIENT_DATA', gain: meanDelta(deltas), pValue: null, effect: null };
  const test = pairedTTest(deltas);
  const es = pairedCohensD(deltas);
  const gain = meanDelta(deltas);
  const verdict: PairedVerdict = test.significant && gain > 0 ? 'COLLECTIVE_WINS' : 'NO_ADVANTAGE';
  return { verdict, gain, pValue: test.pValue, effect: es.category };
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

/**
 * Build the segmented benchmark report from raw experiment executions.
 * Confirmatory regimes are matched by taskType (CONFIRMATORY_REGISTRY);
 * everything else is treated as the exploratory pool, sliced by
 * taskType/complexity — same method, same audit trail, different label.
 */
export function generateSegmentedBenchmarkReport(
  experimentId: string,
  results: ExperimentExecutionResult[],
  thresholds: GoNoGoThresholds = DEFAULT_THRESHOLDS,
): SegmentedBenchmarkReport {
  const confirmatoryTaskTypes = new Set(CONFIRMATORY_REGISTRY.map((r) => r.taskType));

  const confirmatory: ConfirmatoryFinding[] = CONFIRMATORY_REGISTRY.map((regime) => {
    const regimeResults = results.filter((r) => r.taskType === regime.taskType);
    // STAT-1: the pre-registered comparison is verifier-ARMED consensus vs the
    // BEST single per task — not mean-of-all-collectives vs mean-of-all-singles.
    const singleTS = bestSinglePerTask(regimeResults);
    const collectiveTS = taskScoresFor(regimeResults, 'collective', regime.armedStrategy);
    const deltas = pairByTaskDeltas(collectiveTS, singleTS);
    const { verdict, gain, pValue, effect } = classifyPaired(deltas);
    const indices = sharedTaskIndices(collectiveTS, singleTS);
    return {
      kind: 'CONFIRMATORY',
      regime: regime.key,
      label: regime.label,
      hypothesis: regime.hypothesis,
      configKey: regime.configKey,
      verdict,
      pairedDeltaMean: gain,
      pValue,
      effectSizeCategory: effect,
      sharedTaskCount: indices.length,
      sharedTaskIndices: indices,
    };
  });

  // Tie margin below which a scenario is "not worth it" rather than merely
  // "not a win" — mirrors go-no-go-engine's own q3/q4 convention (not part of
  // GoNoGoThresholds; that engine hardcodes the same 0.02 for the same reason).
  const NOT_WORTH_MARGIN = 0.02;

  const exploratoryPool = results.filter((r) => !confirmatoryTaskTypes.has(r.taskType));
  const byScenario = groupBy(exploratoryPool, (r) => `${r.taskType}/${r.complexity}`);
  const exploratory: ExploratoryFinding[] = [];
  for (const [scenario, items] of Object.entries(byScenario)) {
    const singleTS = taskScoresFor(items, 'single-model');
    const collectiveTS = taskScoresFor(items, 'collective');
    const deltas = pairByTaskDeltas(collectiveTS, singleTS);
    if (deltas.length < 2) continue; // no meaningful paired signal — omit, don't guess
    const gain = meanDelta(deltas);
    const indices = sharedTaskIndices(collectiveTS, singleTS);
    if (gain > thresholds.minQualityGainForCollective) {
      exploratory.push({
        kind: 'EXPLORATORY', scenario, verdict: 'COLLECTIVE_WINS',
        pairedDeltaMean: gain, sharedTaskCount: indices.length, sharedTaskIndices: indices,
        caveat: EXPLORATORY_CAVEAT,
      });
    } else if (gain <= NOT_WORTH_MARGIN) {
      exploratory.push({
        kind: 'EXPLORATORY', scenario, verdict: 'COLLECTIVE_NOT_WORTH',
        pairedDeltaMean: gain, sharedTaskCount: indices.length, sharedTaskIndices: indices,
        caveat: EXPLORATORY_CAVEAT,
      });
    }
  }

  return {
    experimentId,
    confirmatory,
    exploratory,
    methodologyNote: METHODOLOGY_NOTE,
  };
}
