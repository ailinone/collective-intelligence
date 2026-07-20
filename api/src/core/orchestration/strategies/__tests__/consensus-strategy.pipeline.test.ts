// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test 2/9: Pipeline fan-out behaviour.
 *
 * Covers spec invariants:
 *   #1 fan-out: multi-model (Promise.all over selected models)
 *   #2 outputs individuais (each execution carries its own response)
 *   #3 síntese is invoked exactly once when there are valid voters
 *   #9 modelsUsed retains all attempted models (success + failure)
 *  #16 synthesis happens ONLY on non-outliers
 */
import { describe, it, expect } from 'vitest';
import type { ConsensusStrategyArtifacts } from '../consensus/consensus-artifacts';
import {
  healthyResponses,
  makeContext,
  makeRequest,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

describe('ConsensusStrategy — pipeline', () => {
  it('executes all 3 selected voters in parallel and each gets its own request', async () => {
    const models = threeHealthyModels();
    const { strategy, executeModelSpy } = wireStrategy({
      responses: healthyResponses(),
      eligibleModels: models,
    });
    await strategy.execute(makeRequest('Solve problem P.'), makeContext(models));
    expect(executeModelSpy).toHaveBeenCalledTimes(3);
    for (const call of executeModelSpy.mock.calls) {
      const req = call[2] as { messages: Array<{ role: string; content: string }> };
      expect(req.messages.length).toBeGreaterThanOrEqual(2);
      expect(req.messages[0].role).toBe('system');
      expect(req.messages.at(-1)?.content).toBe('Solve problem P.');
      const role = call[3] as string;
      expect(role).toBe('voter');
    }
  });

  it('each successful execution carries an individual ChatResponse with the voter content', async () => {
    const models = threeHealthyModels();
    const presets = healthyResponses();
    const { strategy } = wireStrategy({
      responses: presets,
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    expect(r.modelsUsed.length).toBe(3);
    for (const exec of r.modelsUsed) {
      expect(exec.success).toBe(true);
      const text = (exec.response.choices[0].message.content as string) ?? '';
      expect(text).toBe(presets[exec.modelId].content);
    }
  });

  it('modelsUsed includes failed executions too (no silent dropping)', async () => {
    const models = threeHealthyModels();
    const responses = {
      ...healthyResponses(),
      'voter-c': {
        content: '',
        success: false,
        error: 'network_unreachable',
      },
    };
    const { strategy } = wireStrategy({
      responses,
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    expect(r.modelsUsed.length).toBe(3);
    const failures = r.modelsUsed.filter((e) => !e.success);
    expect(failures.length).toBe(1);
    expect(failures[0].modelId).toBe('voter-c');
    expect(failures[0].error).toBe('network_unreachable');

    const artifacts = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    const failureArtifact = artifacts.participantOutputs.find((p) => p.modelId === 'voter-c');
    expect(failureArtifact).toBeDefined();
    expect(failureArtifact?.success).toBe(false);
    expect(failureArtifact?.individualScore).toBeUndefined();
    expect(failureArtifact?.outlier).toBe(true);
    expect(failureArtifact?.outlierReason).toBe('execution_failed');
  });

  it('synthesis runs ONLY on non-outlier successful voters', async () => {
    const models = threeHealthyModels();
    const responses = {
      'voter-a': { content: 'A'.repeat(120) },
      'voter-b': { content: 'B'.repeat(120) },
      'voter-c': { content: '' },
    };
    const { strategy } = wireStrategy({
      responses,
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const artifacts = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(artifacts.synthesis.inputParticipantCount).toBe(2);
    expect(artifacts.synthesis.outputLength).toBeGreaterThan(0);
  });

  it('aggregationMethod reflects whether synthesis or fallback was used', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: healthyResponses(),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    expect(['synthesis', 'best_individual_fallback']).toContain(
      r.metadata?.aggregationMethod,
    );
  });
});
