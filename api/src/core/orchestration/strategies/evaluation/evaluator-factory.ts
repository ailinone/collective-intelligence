// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Factory: turn an `EvaluatorConfig` into a concrete `StrategyOutputEvaluator`.
 *
 * Defaults are deliberately conservative. Without explicit env opt-in:
 *   - mode='unavailable'  → UnavailableEvaluator
 *   - maxCostUsd=0        → LLM judge cannot be wired even if mode requests it
 *
 * The factory NEVER constructs a real provider client. Callers wiring a
 * real LLM judge must inject the client explicitly via the `deps`
 * argument; without it, mode='llm_judge' / mode='composite' degrade to
 * unavailable / structural-only.
 */
import type { StrategyOutputEvaluator } from './strategy-output-evaluator';
import type { LLMJudgeClient } from './llm-judge-evaluator.types';
import { UnavailableStrategyOutputEvaluator } from './unavailable-evaluator';
import { StructuralOutputEvaluator } from './structural-evaluator';
import { TaskSpecificEvaluator, type CodeRunner } from './task-specific-evaluator';
import { LLMJudgeEvaluator } from './llm-judge-evaluator';
import { CompositeEvaluator } from './composite-evaluator';
import type { EvaluatorConfig } from './evaluator-config';

export interface EvaluatorFactoryDeps {
  readonly llmClient?: LLMJudgeClient;
  readonly codeRunner?: CodeRunner;
}

export function createStrategyOutputEvaluator(
  config: EvaluatorConfig,
  deps: EvaluatorFactoryDeps = {},
): StrategyOutputEvaluator {
  switch (config.mode) {
    case 'unavailable':
      return new UnavailableStrategyOutputEvaluator();

    case 'structural':
      return new StructuralOutputEvaluator();

    case 'task_specific':
      return new TaskSpecificEvaluator({ codeRunner: deps.codeRunner });

    case 'llm_judge':
      return new LLMJudgeEvaluator(
        {
          enabled: config.llmJudgeEnabled,
          judgeModelId: config.llmJudgeModelId,
          maxCostUsd: config.maxCostUsd,
          timeoutMs: config.timeoutMs,
          rubricVersion: config.rubricVersion,
        },
        deps.llmClient,
      );

    case 'composite':
      return new CompositeEvaluator({
        structural: new StructuralOutputEvaluator(),
        taskSpecific: config.taskSpecificEnabled
          ? new TaskSpecificEvaluator({ codeRunner: deps.codeRunner })
          : undefined,
        llmJudge: config.llmJudgeEnabled
          ? new LLMJudgeEvaluator(
              {
                enabled: config.llmJudgeEnabled,
                judgeModelId: config.llmJudgeModelId,
                maxCostUsd: config.maxCostUsd,
                timeoutMs: config.timeoutMs,
                rubricVersion: config.rubricVersion,
              },
              deps.llmClient,
            )
          : undefined,
      });
  }
}
