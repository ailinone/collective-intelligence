// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Quorum tool execution wiring — consensus executes the voters'
 * strict-majority quorumOnly tool call once, server-side, and neutralizes
 * the tool_call in the served response (previously the call passed through
 * to the client unexecuted: the chat layer's auto-execution requires
 * `safeForStrategies === true`, which quorumOnly tools deliberately fail).
 *
 * Green under any config: registers the aggregator/ensemble mocks
 * file-locally (same factories as consensus-validation.setup.ts) plus a
 * file-local mock of the tool executor — no registry, DB or network.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { executeQuorumApprovedToolForStrategyMock } = vi.hoisted(() => ({
  executeQuorumApprovedToolForStrategyMock: vi.fn(),
}));

vi.mock('@/core/aggregation/response-aggregator', async () =>
  (await import('./consensus-module-mocks')).responseAggregatorModuleMock()
);
vi.mock('@/core/coordination/ensemble-coordinator-shadow', async () =>
  (await import('./consensus-module-mocks')).ensembleShadowModuleMock()
);
vi.mock('@/core/coordination/ensemble-coordinator-client', async () =>
  (await import('./consensus-module-mocks')).ensembleClientModuleMock()
);
vi.mock('@/services/strategy-tool-executor', () => ({
  executeToolForStrategy: vi.fn(),
  executeQuorumApprovedToolForStrategy: executeQuorumApprovedToolForStrategyMock,
}));

import {
  healthyResponses,
  makeContext,
  makeMockEvaluator,
  makeRequest,
  resetAggregatorOverride,
  setAggregatorOverride,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

const QUORUM_CALL = {
  id: 'call-quorum-1',
  type: 'function' as const,
  function: { name: 'media_plan', arguments: '{"prompt":"cinematic b-roll"}' },
};

const EXECUTOR_OK = {
  tool_call_id: 'call-quorum-1',
  success: true,
  output: '{"planId":"mp-123"}',
  cost: 0.04,
  artifact: { type: 'image' as const, url: 'https://cdn.example.com/plan.png' },
};

beforeEach(() => {
  resetAggregatorOverride();
  executeQuorumApprovedToolForStrategyMock.mockReset();
  executeQuorumApprovedToolForStrategyMock.mockResolvedValue(EXECUTOR_OK);
});

function wireSynthWins(synthesisScore = 0.8) {
  const models = threeHealthyModels();
  return wireStrategy({
    responses: healthyResponses(),
    evaluator: makeMockEvaluator({
      byModelId: { 'voter-a': 0.5, 'voter-b': 0.45, 'voter-c': 0.55 },
      synthesis: synthesisScore,
    }),
    eligibleModels: models,
  });
}

describe('ConsensusStrategy — quorum tool execution', () => {
  it('executes the majority quorumOnly call once, neutralizes it, and folds cost/artifacts into the result', async () => {
    setAggregatorOverride({ toolCalls: [QUORUM_CALL] });
    const models = threeHealthyModels();
    const { strategy } = wireSynthWins();
    const r = await strategy.execute(makeRequest(), makeContext(models));

    expect(executeQuorumApprovedToolForStrategyMock).toHaveBeenCalledTimes(1);
    const [toolCall, , execCtx] = executeQuorumApprovedToolForStrategyMock.mock.calls[0];
    expect(toolCall).toEqual(QUORUM_CALL);
    expect(execCtx).toMatchObject({ organizationId: 'org-test', userId: 'user-test', timeout: 120_000 });

    // Neutralized final response — no raw tool_call can reach the client.
    const choice = r.finalResponse.choices[0];
    expect(choice.finish_reason).toBe('stop');
    expect(choice.message.tool_calls).toEqual([]);
    const content = JSON.parse(choice.message.content as string);
    expect(content.quorum_tool_executed).toBe('media_plan');
    expect(content.success).toBe(true);
    expect(content.result).toBe('{"planId":"mp-123"}');
    expect(content.artifact).toEqual(EXECUTOR_OK.artifact);

    // Cost accounting: 3 voters @0.001 + tool @0.04, invariant holds.
    const quorumExec = r.modelsUsed.find((e) => e.modelId === 'quorum-tool:media_plan');
    expect(quorumExec).toBeDefined();
    expect(quorumExec!.cost).toBe(0.04);
    expect(quorumExec!.success).toBe(true);
    expect(r.totalCost).toBeCloseTo(0.043, 5);
    expect(r.totalCost).toBeCloseTo(r.modelsUsed.reduce((s, e) => s + e.cost, 0), 5);

    // Artifact flows through mergeArtifacts → toolArtifacts, tagged with the call id.
    expect(r.toolArtifacts).toBeDefined();
    const artifact = r.toolArtifacts!.find((a) => a.sourceToolCallId === 'call-quorum-1');
    expect(artifact).toMatchObject({ type: 'image', url: 'https://cdn.example.com/plan.png' });
  });

  it('still neutralizes the response (no throw) when the tool execution fails', async () => {
    setAggregatorOverride({ toolCalls: [QUORUM_CALL] });
    executeQuorumApprovedToolForStrategyMock.mockResolvedValue({
      tool_call_id: 'call-quorum-1',
      success: false,
      error: 'media_planner_not_applicable',
    });
    const models = threeHealthyModels();
    const { strategy } = wireSynthWins();
    const r = await strategy.execute(makeRequest(), makeContext(models));

    const choice = r.finalResponse.choices[0];
    expect(choice.finish_reason).toBe('stop');
    expect(choice.message.tool_calls).toEqual([]);
    const content = JSON.parse(choice.message.content as string);
    expect(content.success).toBe(false);
    expect(content.error).toBe('media_planner_not_applicable');

    const quorumExec = r.modelsUsed.find((e) => e.modelId === 'quorum-tool:media_plan');
    expect(quorumExec!.success).toBe(false);
    expect(quorumExec!.error).toBe('media_planner_not_applicable');
    expect(quorumExec!.cost).toBe(0);
  });

  it('regression: no quorum tool_call → executor untouched, result identical to the pre-wiring path', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireSynthWins();
    const r = await strategy.execute(makeRequest(), makeContext(models));

    expect(executeQuorumApprovedToolForStrategyMock).not.toHaveBeenCalled();
    expect(r.finalResponse.choices[0].finish_reason).toBe('stop');
    expect(r.finalResponse.choices[0].message.content).toContain('Synthesis output');
    expect(r.totalCost).toBeCloseTo(0.003, 5);
    expect(r.modelsUsed.find((e) => e.modelId.startsWith('quorum-tool:'))).toBeUndefined();
  });

  it('executes the quorum call even when final selection falls back to best_individual (no leak on the served voter response)', async () => {
    setAggregatorOverride({ toolCalls: [QUORUM_CALL] });
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: healthyResponses(),
      evaluator: makeMockEvaluator({
        byModelId: { 'voter-a': 0.9, 'voter-b': 0.7, 'voter-c': 0.6 },
        synthesis: 0.4,
      }),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));

    expect(executeQuorumApprovedToolForStrategyMock).toHaveBeenCalledTimes(1);

    // Selection fell back, but the served response must still be free of the
    // unexecutable quorumOnly tool_call.
    const a = r.metadata?.consensusArtifacts as { finalSelection: { source: string } };
    expect(a.finalSelection.source).toBe('best_individual');
    expect(r.finalResponse.choices[0].message.tool_calls ?? []).toEqual([]);
  });
});
