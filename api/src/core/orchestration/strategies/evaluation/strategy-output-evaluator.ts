// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * StrategyOutputEvaluator — the contract for evaluating a strategy's
 * outputs (participant or synthesis) along multiple quality axes.
 *
 * Design notes
 * ─────────────
 * 1. This interface is **strategy-agnostic**. ConsensusStrategy is the
 *    first consumer; debate / parallel-race / critique-repair can adopt
 *    the same shape later without changes here.
 *
 * 2. Quality scoring is **NOT a free function**. An evaluator must
 *    declare its `mode`, which is recorded in the strategy artifact so
 *    operators can tell whether a decision was made with a real judge,
 *    a structural check, an explicit test mock, or no evaluator at all.
 *
 * 3. There is no silent length-based default. The production fallback
 *    is the `UnavailableStrategyOutputEvaluator`, which returns no
 *    score and forces `validationStatus = 'unavailable'` on the
 *    artifact. The strategy must still produce a result, but its
 *    fallback-vs-synthesis decision becomes explicitly non-comparable.
 */

/**
 * What kind of evaluator produced this result?
 *
 * - `mock`              — deterministic injection for unit tests
 * - `structural`        — cheap objective checks (empty / invalid JSON /
 *                         missing code block / explicit exec error). NEVER
 *                         emits a quality score; only a pass/fail verdict.
 * - `task_specific`     — code: compile/test/lint, json: parse+schema,
 *                         math: numeric verify, doc: grounding/coverage
 * - `llm_judge`         — rubric-based LLM judge with optional pairwise
 *                         preference signal
 * - `composite`         — weighted combination of structural +
 *                         task-specific + judge signals
 * - `heuristic_test_only` — length/format heuristic. EXPLICITLY test-only.
 *                           Never use as production default. Marked
 *                           structurally_validated_only in artifacts.
 * - `unavailable`       — no real evaluator configured. Returns no score;
 *                         the strategy artifact records validationStatus
 *                         = 'unavailable' so consumers know consensus
 *                         decisions made under this mode are not
 *                         quantitatively backed.
 */
export type ScoringMode =
  | 'mock'
  | 'structural'
  | 'task_specific'
  | 'llm_judge'
  | 'composite'
  | 'heuristic_test_only'
  | 'unavailable';

/**
 * What the strategy artifact should record about validation strength.
 *
 * - `fully_validated`              — a quality-emitting evaluator was used
 *                                    (mock, task_specific, llm_judge,
 *                                    composite). Synthesis-vs-best
 *                                    comparison is meaningful.
 * - `structurally_validated_only`  — only structural verdicts available;
 *                                    quality comparison is NOT meaningful.
 *                                    Includes `heuristic_test_only` and
 *                                    `structural` modes.
 * - `unavailable`                  — no evaluator. Consensus produced a
 *                                    response but its fallback path is
 *                                    not quantitatively justified.
 */
export type ValidationStatus =
  | 'fully_validated'
  | 'structurally_validated_only'
  | 'unavailable';

export function validationStatusForMode(mode: ScoringMode): ValidationStatus {
  switch (mode) {
    case 'mock':
    case 'task_specific':
    case 'llm_judge':
    case 'composite':
      return 'fully_validated';
    case 'structural':
    case 'heuristic_test_only':
      return 'structurally_validated_only';
    case 'unavailable':
      return 'unavailable';
  }
}

/**
 * Verdict semantics:
 *  - `pass`      — the evaluator has objective basis to accept the output
 *  - `fail`      — the evaluator has objective basis to reject the output
 *  - `uncertain` — the evaluator ran but lacks objective evidence to commit
 *                  to pass/fail (e.g., code structurally present but no
 *                  compile/test/lint signal available). Outlier-detector
 *                  treats `uncertain` as soft-pass (NOT auto-outlier).
 */
export type EvaluationVerdict = 'pass' | 'fail' | 'uncertain';

/**
 * Structural facts an evaluator can populate. All optional — an
 * evaluator that doesn't have the info should leave the field
 * `undefined`, not guess.
 */
export interface StructuralChecks {
  readonly nonEmpty: boolean;
  readonly meetsMinLength: boolean;
  readonly executionError: boolean;
  readonly jsonValid?: boolean;
  readonly codeBlockPresent?: boolean;
  readonly schemaValid?: boolean;
}

/**
 * Sub-score breakdown (optional). Allows a CompositeEvaluator to
 * surface what each axis contributed to the final score.
 */
export interface SubScores {
  readonly structuralValidity?: number;
  readonly taskCorrectness?: number;
  readonly rubricJudge?: number;
  readonly pairwisePreference?: number;
  readonly safetyFormat?: number;
}

export interface EvaluationResult {
  readonly scoringMode: ScoringMode;
  readonly evaluatorId: string;
  /**
   * Overall quality score in [0, 1]. `undefined` when the evaluator
   * does not assign a quality score (structural / unavailable / etc.).
   *
   * IMPORTANT: a numeric score implies the evaluator is willing to
   * be the basis for a synthesis-vs-best comparison. Callers MUST treat
   * `undefined` as "not comparable" — not as zero.
   */
  readonly score: number | undefined;
  readonly verdict: EvaluationVerdict;
  readonly structural: StructuralChecks;
  readonly subScores?: SubScores;
  readonly notes?: string;
  /**
   * Per-result override of validation status. When set, takes precedence
   * over `validationStatusForMode(scoringMode)`. Necessary for evaluators
   * that degrade dynamically (e.g., Composite falling back to structural
   * when the LLM judge times out).
   */
  readonly validationStatus?: ValidationStatus;
  /**
   * Optional: sub-evaluator results when this evaluator is a composite.
   * Lets observers see what each axis contributed without duplicating
   * evaluation runs.
   */
  readonly subResults?: ReadonlyArray<{
    readonly name: string;
    readonly result: EvaluationResult;
  }>;
  /**
   * Which axis the composite picked as the source of the final score.
   * Only meaningful for composite; ignored otherwise.
   */
  readonly selectedScoreSource?: string;
  /** Confidence in the verdict, 0..1. Optional; semantics evaluator-specific. */
  readonly confidence?: number;
  /**
   * Billable cost (USD) of an LLM-judge sub-call, when this evaluation ran a
   * real paid judge. Cost-accounting integrity (TIER 0): lets consumers fold
   * the judge cost into the request total instead of dropping it. Undefined /
   * 0 for non-LLM evaluators or when the judge did not run.
   */
  readonly judgeCostUsd?: number;
}

export interface StrategyEvaluationTask {
  readonly taskType?: string;
  readonly userMessageExcerpt?: string;
  readonly expectedFormat?: 'json' | 'code' | 'reasoning' | 'free_text';
  readonly minLength?: number;
  /** Future hook for TaskSpecificEvaluator (JSON schema validation, etc.) */
  readonly jsonSchema?: unknown;
  readonly codeLanguage?: string;
}

export interface EvaluatorInput {
  readonly task: StrategyEvaluationTask;
  readonly output: string;
  readonly modelId?: string;
  readonly executionFailed?: boolean;
  readonly executionError?: string;
  readonly strategyName: string;
  /** Role of this output — voter or synthesis. Lets evaluators apply
   *  different rubrics to synthesis (which combines voters) vs voters. */
  readonly role?: 'voter' | 'synthesis';
  /**
   * Strategy 01C.0.1 — per-call override for the judge model id used by
   * LLM-judge evaluators. When the caller (typically ConsensusStrategy
   * consuming a `ConsensusExecutionPlan`) wants the judge picked
   * dynamically by `ModelRoleResolver` instead of the static env config,
   * it passes the planned model id here. Non-LLMJudge evaluators MUST
   * ignore this field.
   */
  readonly judgeModelOverride?: string;
}

export interface StrategyOutputEvaluator {
  /** Identifies the kind of evaluator — recorded in artifacts. */
  readonly mode: ScoringMode;
  /** Stable identifier of the implementation (incl. version if applicable). */
  readonly id: string;
  evaluate(input: EvaluatorInput): Promise<EvaluationResult>;
}
