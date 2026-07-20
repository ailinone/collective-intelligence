// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins: no evaluator can produce a `fully_validated` artifact without
 * objective evidence. This is the strongest test in the suite — it's
 * what stops the heuristic anti-pattern from coming back.
 */
import { describe, it, expect } from 'vitest';
import type { ConsensusStrategyArtifacts } from '../consensus/consensus-artifacts';
import { StructuralOutputEvaluator } from '../evaluation/structural-evaluator';
import { HeuristicTestOnlyEvaluator } from '../evaluation/heuristic-test-only-evaluator';
import { TaskSpecificEvaluator } from '../evaluation/task-specific-evaluator';
import { LLMJudgeEvaluator } from '../evaluation/llm-judge-evaluator';
import { CompositeEvaluator } from '../evaluation/composite-evaluator';
import {
  makeContext,
  makeRequest,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

describe('Consensus — no false fully_validated', () => {
  it('Unavailable (default) NEVER produces fully_validated', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: null,
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.validationStatus).not.toBe('fully_validated');
  });

  it('Structural NEVER produces fully_validated', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: new StructuralOutputEvaluator(),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.validationStatus).not.toBe('fully_validated');
  });

  it('HeuristicTestOnly NEVER produces fully_validated and carries a warning note', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: new HeuristicTestOnlyEvaluator(),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.validationStatus).toBe('structurally_validated_only');
    expect(a.scoringMode).toBe('heuristic_test_only');
  });

  it('TaskSpecific (no runner, code task) → uncertain + structural-only', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: '```js\nfunction f() { return 1; }\n```' },
        'voter-b': { content: '```js\nfunction g() { return 2; }\n```' },
        'voter-c': { content: '```js\nfunction h() { return 3; }\n```' },
      },
      evaluator: new TaskSpecificEvaluator(), // no codeRunner
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models, { taskType: 'code-generation' as never }));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.validationStatus).toBe('structurally_validated_only');
    expect(a.scoringMode).toBe('task_specific');
  });

  it('LLMJudge disabled → unavailable, never fully_validated', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: new LLMJudgeEvaluator({
        enabled: false,
        maxCostUsd: 0,
        timeoutMs: 1000,
        rubricVersion: 'v1',
      }),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.validationStatus).toBe('unavailable');
    expect(a.scoringMode).toBe('llm_judge');
  });

  it('Composite (structural only, no task, no judge) → structurally_validated_only', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      evaluator: new CompositeEvaluator({ structural: new StructuralOutputEvaluator() }),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.validationStatus).not.toBe('fully_validated');
  });
});
