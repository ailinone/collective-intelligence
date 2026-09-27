// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DocumentJudgeEvaluator types — kept in their own file, same layout as
 * `media-judge-evaluator.types.ts` / `llm-judge-evaluator.types.ts`, so
 * consumers (tests, factory, future real client) can import the contracts
 * without pulling in the implementation.
 *
 * Document critics are TEXT-ONLY: they judge the PDF text `pdf-service.ts`
 * already extracts (with `[page N]` markers — see `PDFService.assembleText`),
 * never frames/images, so — unlike `MediaJudgeEvaluator` — there is no
 * vision dispatch here. Structurally this is closer to `LLMJudgeEvaluator`
 * (plain text judging) widened with one additive concept text/media judging
 * don't have: a per-critic list of page-anchored `issues` (see
 * `strategy-output-evaluator.ts`'s `DocumentCriticIssue`), since a document
 * critic is expected to point at WHERE in the document a problem lives, not
 * just emit an overall score.
 */
import type { LLMJudgeRawResult } from './llm-judge-evaluator.types';
import type { DocumentCriticIssue } from './strategy-output-evaluator';

/**
 * Role-differentiated document critics. Mirrors `MediaCriticRole`'s
 * asymmetric-visibility pattern (each critic gets its own rubric and never
 * sees the other critics' verdicts) for the document/PDF domain.
 */
export type DocumentCriticRole = 'factual_accuracy' | 'required_clause_presence' | 'tone';

export const DOCUMENT_CRITIC_ROLES: readonly DocumentCriticRole[] = [
  'factual_accuracy',
  'required_clause_presence',
  'tone',
];

export interface DocumentJudgeEvaluatorConfig {
  /** Master switch. When false, the evaluator returns `unavailable`
   *  WITHOUT calling any provider — even with a mock client. */
  readonly enabled: boolean;
  /** Concrete model id used as the judge. Text-only — no vision requirement. */
  readonly judgeModelId?: string;
  /** Hard budget gate. When 0 (default), no real provider call. */
  readonly maxCostUsd: number;
  /** Wall-clock timeout for the judge call. */
  readonly timeoutMs: number;
  /** Identifies the rubric version embedded in the result. */
  readonly rubricVersion: string;
  /** Which critic rubric this evaluator instance embodies. */
  readonly criticRole: DocumentCriticRole;
}

export interface DocumentJudgeInput {
  readonly judgeModelId: string;
  readonly rubricVersion: string;
  readonly criticRole: DocumentCriticRole;
  readonly task: {
    readonly taskType?: string;
    readonly userMessageExcerpt?: string;
    readonly expectedFormat?: 'json' | 'code' | 'reasoning' | 'free_text';
  };
  /** The assembled document text, WITH `[page N]` markers — the critic is
   *  instructed to cite the nearest marker as `location` on every issue. */
  readonly documentText: string;
  readonly role?: 'voter' | 'synthesis';
  readonly maxCostUsd: number;
  readonly timeoutMs: number;
}

/**
 * Same base fields as `LLMJudgeRawResult` (score/verdict/confidence/
 * shortRationale/costUsd/subScores) plus the one additive concept document
 * critics need: a list of page-anchored issues.
 */
export interface DocumentJudgeRawResult extends LLMJudgeRawResult {
  readonly issues: readonly DocumentCriticIssue[];
}

/**
 * Pluggable document judge client. The default implementation is
 * `undefined` — tests inject a mock; production wiring must inject a
 * concrete client (`ProviderDocumentJudgeClient`) that respects
 * `maxCostUsd` + `timeoutMs` and NEVER falls back to unbounded calls.
 */
export interface DocumentJudgeClient {
  judgeDocument(input: DocumentJudgeInput): Promise<DocumentJudgeRawResult>;
}
