// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy evaluator configuration loaded from environment variables.
 *
 * All flags default to the **safest** value:
 *   - mode = unavailable    (no quality scoring)
 *   - taskSpecific disabled
 *   - llmJudge disabled
 *   - maxCostUsd = 0        (hard provider-call block)
 */

export type EvaluatorConfigMode =
  | 'unavailable'
  | 'structural'
  | 'task_specific'
  | 'llm_judge'
  | 'composite';

export interface EvaluatorConfig {
  readonly mode: EvaluatorConfigMode;
  readonly taskSpecificEnabled: boolean;
  readonly llmJudgeEnabled: boolean;
  readonly llmJudgeModelId?: string;
  readonly maxCostUsd: number;
  readonly timeoutMs: number;
  readonly rubricVersion: string;
}

const VALID_MODES: ReadonlySet<EvaluatorConfigMode> = new Set([
  'unavailable',
  'structural',
  'task_specific',
  'llm_judge',
  'composite',
]);

export function loadEvaluatorConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EvaluatorConfig {
  const rawMode = (env.STRATEGY_EVALUATOR_MODE ?? '').trim();
  const mode: EvaluatorConfigMode = VALID_MODES.has(rawMode as EvaluatorConfigMode)
    ? (rawMode as EvaluatorConfigMode)
    : 'unavailable';

  const taskSpecificEnabled = env.STRATEGY_EVALUATOR_TASK_SPECIFIC_ENABLED === 'true';
  const llmJudgeEnabled = env.STRATEGY_EVALUATOR_LLM_JUDGE_ENABLED === 'true';
  const llmJudgeModelId = (env.STRATEGY_EVALUATOR_LLM_JUDGE_MODEL_ID ?? '').trim() || undefined;

  const maxCostUsdRaw = Number(env.STRATEGY_EVALUATOR_MAX_COST_USD ?? 0);
  const maxCostUsd = Number.isFinite(maxCostUsdRaw) && maxCostUsdRaw >= 0 ? maxCostUsdRaw : 0;

  const timeoutMsRaw = Number(env.STRATEGY_EVALUATOR_TIMEOUT_MS ?? 3000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 3000;

  const rubricVersion = (env.STRATEGY_EVALUATOR_RUBRIC_VERSION ?? 'strategy-output-v1').trim();

  return {
    mode,
    taskSpecificEnabled,
    llmJudgeEnabled,
    llmJudgeModelId,
    maxCostUsd,
    timeoutMs,
    rubricVersion: rubricVersion.length > 0 ? rubricVersion : 'strategy-output-v1',
  };
}
