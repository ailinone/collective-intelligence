// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * MediaJudgeEvaluator types — kept in their own file, same layout as
 * `llm-judge-evaluator.types.ts`, so consumers (tests, factory, future real
 * client) can import the contracts without pulling in the implementation.
 */
import type { MessageContent } from '@/types';
import type { LLMJudgeRawResult } from './llm-judge-evaluator.types';

/**
 * Role-differentiated, asymmetric-visibility critics (per the published
 * architecture: "spec-compliance, artifact/quality, tone ... evaluate
 * independently and are reconciled after the fact"). Each role selects a
 * distinct rubric in the concrete client — the critics never see each
 * other's verdicts, only the same candidate.
 */
export type MediaCriticRole = 'spec_compliance' | 'artifact_quality' | 'tone';

export const MEDIA_CRITIC_ROLES: readonly MediaCriticRole[] = [
  'spec_compliance',
  'artifact_quality',
  'tone',
];

export interface MediaJudgeEvaluatorConfig {
  /** Master switch. When false, the evaluator returns `unavailable`
   *  WITHOUT calling any provider — even with a mock client. */
  readonly enabled: boolean;
  /** Concrete model id used as the judge. Must be vision-capable when
   *  judging video/image candidates. When absent, evaluator skips. */
  readonly judgeModelId?: string;
  /** Hard budget gate. When 0 (default), no real provider call. */
  readonly maxCostUsd: number;
  /** Wall-clock timeout for the judge call. */
  readonly timeoutMs: number;
  /** Identifies the rubric version embedded in the result. */
  readonly rubricVersion: string;
  /** Which critic rubric this evaluator instance embodies. Defaults to
   *  `'artifact_quality'` when omitted — a plain single-critic setup. */
  readonly criticRole?: MediaCriticRole;
}

export interface MediaJudgeInput {
  readonly judgeModelId: string;
  readonly rubricVersion: string;
  readonly criticRole: MediaCriticRole;
  readonly task: {
    readonly taskType?: string;
    readonly userMessageExcerpt?: string;
    readonly expectedFormat?: 'json' | 'code' | 'reasoning' | 'free_text';
  };
  /**
   * The multi-part judge prompt content (rubric text + sampled frames /
   * transcript). May contain the additive `video_frame` / `audio_transcript`
   * part types — the concrete client is responsible for normalizing those to
   * plain `text`/`image_url` parts before it builds a provider `ChatRequest`,
   * so every existing adapter (which only recognises `text`/`image_url`)
   * keeps working unmodified.
   */
  readonly content: readonly MessageContent[];
  readonly role?: 'voter' | 'synthesis';
  readonly maxCostUsd: number;
  readonly timeoutMs: number;
}

/**
 * Pluggable media judge client. The default implementation is `undefined` —
 * tests inject a mock; production wiring must inject a concrete client
 * (`ProviderMediaJudgeClient`) that respects `maxCostUsd` + `timeoutMs` and
 * NEVER falls back to unbounded calls.
 */
export interface MediaJudgeClient {
  judgeMedia(input: MediaJudgeInput): Promise<LLMJudgeRawResult>;
}
