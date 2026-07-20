// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LLMJudgeEvaluator types — kept in their own file so consumers (tests,
 * factory, future real client) can import the contracts without pulling
 * in the implementation.
 */

export interface LLMJudgeEvaluatorConfig {
  /** Master switch. When false, the evaluator returns `unavailable`
   *  WITHOUT calling any provider — even with a mock client. */
  readonly enabled: boolean;
  /** Concrete model id used as the judge. When absent, evaluator skips. */
  readonly judgeModelId?: string;
  /** Hard budget gate. When 0 (default), no real provider call. */
  readonly maxCostUsd: number;
  /** Wall-clock timeout for the judge call. */
  readonly timeoutMs: number;
  /** Identifies the rubric version embedded in the result. */
  readonly rubricVersion: string;
}

export interface LLMJudgeRawResult {
  /** Quality score in [0, 1]. NaN / out-of-range → treated as malformed. */
  readonly score: number;
  readonly verdict: 'pass' | 'fail' | 'uncertain';
  readonly confidence?: number;
  readonly shortRationale?: string;
  /**
   * Billable cost (USD) of the judge LLM call. Cost-accounting integrity
   * (TIER 0): the judge is a real paid sub-call; its cost was previously
   * discarded in `coerceRawResult`. Populated by the provider client from the
   * response usage; 0 / undefined when usage is unavailable.
   */
  readonly costUsd?: number;
  /** Per-axis sub-scores when the judge surfaces them. All optional. */
  readonly subScores?: {
    readonly correctness?: number;
    readonly completeness?: number;
    readonly instructionAdherence?: number;
    readonly formatAdherence?: number;
    readonly grounding?: number;
    readonly safety?: number;
    readonly reasoningQuality?: number;
  };
}

export interface LLMJudgeInput {
  readonly judgeModelId: string;
  readonly rubricVersion: string;
  readonly task: {
    readonly taskType?: string;
    readonly userMessageExcerpt?: string;
    readonly expectedFormat?: 'json' | 'code' | 'reasoning' | 'free_text';
  };
  readonly output: string;
  readonly role?: 'voter' | 'synthesis';
  readonly maxCostUsd: number;
  readonly timeoutMs: number;
}

/**
 * Pluggable judge client. The default implementation is `undefined` —
 * tests inject a mock; production wiring must inject a concrete client
 * that respects `maxCostUsd` + `timeoutMs` and NEVER falls back to
 * unbounded calls.
 */
export interface LLMJudgeClient {
  judge(input: LLMJudgeInput): Promise<LLMJudgeRawResult>;
}
