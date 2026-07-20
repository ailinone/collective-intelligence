// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Engine wiring smoke: the factory + config plumbing through to the
 * strategy produces the expected scoringMode/validationStatus in the
 * artifact without going through OrchestrationEngine itself.
 *
 * (Full engine instantiation is heavyweight — it imports DB / metrics /
 * registries. This test exercises the same code path the engine takes
 * when registering the consensus strategy: load env → build evaluator
 * → setEvaluator → execute → inspect artifact.)
 */
import { describe, it, expect } from 'vitest';
import { ConsensusStrategy } from '../consensus-strategy';
import {
  createStrategyOutputEvaluator,
} from '../evaluation/evaluator-factory';
import {
  loadEvaluatorConfigFromEnv,
} from '../evaluation/evaluator-config';
import type { ConsensusStrategyArtifacts } from '../consensus/consensus-artifacts';
import {
  healthyResponses,
  makeContext,
  makeRequest,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

function wireFromEnv(env: Record<string, string | undefined>): ConsensusStrategy {
  const cfg = loadEvaluatorConfigFromEnv(env);
  const evaluator = createStrategyOutputEvaluator(cfg);
  const models = threeHealthyModels();
  const { strategy } = wireStrategy({
    responses: healthyResponses(),
    evaluator,
    eligibleModels: models,
  });
  return strategy;
}

describe('Consensus — evaluator wiring via factory/config', () => {
  it('empty env → strategy uses Unavailable, validationStatus=unavailable', async () => {
    const models = threeHealthyModels();
    const strat = wireFromEnv({});
    const r = await strat.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.scoringMode).toBe('unavailable');
    expect(a.validationStatus).toBe('unavailable');
  });

  it('STRATEGY_EVALUATOR_MODE=structural → scoringMode=structural', async () => {
    const models = threeHealthyModels();
    const strat = wireFromEnv({ STRATEGY_EVALUATOR_MODE: 'structural' });
    const r = await strat.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.scoringMode).toBe('structural');
    expect(a.validationStatus).toBe('structurally_validated_only');
  });

  it('STRATEGY_EVALUATOR_MODE=task_specific → scoringMode=task_specific, validationStatus depends on output', async () => {
    const models = threeHealthyModels();
    const strat = wireFromEnv({ STRATEGY_EVALUATOR_MODE: 'task_specific' });
    const r = await strat.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.scoringMode).toBe('task_specific');
    // healthyResponses() is plain text → uncertain → structurally_validated_only
    expect(a.validationStatus).toBe('structurally_validated_only');
  });

  it('STRATEGY_EVALUATOR_MODE=composite, llm disabled → no provider call, no false fully_validated', async () => {
    const models = threeHealthyModels();
    const strat = wireFromEnv({
      STRATEGY_EVALUATOR_MODE: 'composite',
      STRATEGY_EVALUATOR_TASK_SPECIFIC_ENABLED: 'true',
      STRATEGY_EVALUATOR_LLM_JUDGE_ENABLED: 'false',
    });
    const r = await strat.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.scoringMode).toBe('composite');
    expect(a.validationStatus).not.toBe('fully_validated');
  });

  it('STRATEGY_EVALUATOR_MODE=llm_judge with no client injected → unavailable at evaluate-time', async () => {
    const models = threeHealthyModels();
    const strat = wireFromEnv({
      STRATEGY_EVALUATOR_MODE: 'llm_judge',
      STRATEGY_EVALUATOR_LLM_JUDGE_ENABLED: 'true',
      STRATEGY_EVALUATOR_LLM_JUDGE_MODEL_ID: 'judge-x',
      STRATEGY_EVALUATOR_MAX_COST_USD: '0.01',
    });
    const r = await strat.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.scoringMode).toBe('llm_judge');
    expect(a.validationStatus).toBe('unavailable');
  });
});
