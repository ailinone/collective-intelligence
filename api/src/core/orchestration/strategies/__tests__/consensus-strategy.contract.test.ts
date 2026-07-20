// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test 1/9: Contract invariants for ConsensusStrategy.
 *
 * Covers spec invariants:
 *   #14 minModels=3 enforced (throws when context has <3 eligible)
 *   #1  fan-out attempted (executeModel called for each selected model)
 *   #10 effectiveStrategyId is always present in the result
 *   getMetadata() exposes the contract (minModels/maxModels/etc.)
 *   scoringMode + validationStatus are present and consistent.
 */
import { describe, it, expect } from 'vitest';
import { ConsensusStrategy } from '../consensus-strategy';
import type { ConsensusStrategyArtifacts } from '../consensus/consensus-artifacts';
import {
  healthyResponses,
  makeContext,
  makeModel,
  makeRequest,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

describe('ConsensusStrategy — contract', () => {
  it('getMetadata exposes minModels=3, maxModels=5, strategy id "consensus"', () => {
    const md = new ConsensusStrategy().getMetadata();
    expect(md.id).toBe('consensus');
    expect(md.name).toBe('consensus');
    expect(md.minModels).toBe(3);
    expect(md.maxModels).toBe(5);
    expect(md.suitableFor.length).toBeGreaterThan(0);
  });

  it('throws when fewer than 3 eligible models are available', async () => {
    const onlyTwo = [
      makeModel({ id: 'voter-a', provider: 'prov-a' }),
      makeModel({ id: 'voter-b', provider: 'prov-b' }),
    ];
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
      },
      eligibleModels: onlyTwo,
    });
    await expect(
      strategy.execute(makeRequest(), makeContext(onlyTwo)),
    ).rejects.toThrow(/at least 3/i);
  });

  it('returns a result with effectiveStrategyId + scoringMode + validationStatus on the happy path', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: healthyResponses(),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    expect(r.strategyUsed).toBe('consensus');
    expect(r.metadata?.effectiveStrategyId).toBeDefined();
    const artifacts = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(artifacts).toBeDefined();
    expect(artifacts.strategyName).toBe('consensus');
    expect(artifacts.effectiveStrategyId).toBe(r.metadata?.effectiveStrategyId);
    expect(artifacts.scoringMode).toBe('mock');
    expect(artifacts.validationStatus).toBe('fully_validated');
    expect(typeof artifacts.evaluatorId).toBe('string');
  });

  it('calls executeModel exactly once per selected model', async () => {
    const models = threeHealthyModels();
    const { strategy, executeModelSpy } = wireStrategy({
      responses: healthyResponses(),
      eligibleModels: models,
    });
    await strategy.execute(makeRequest(), makeContext(models));
    expect(executeModelSpy).toHaveBeenCalledTimes(3);
    const calledModelIds = executeModelSpy.mock.calls.map((c) => (c[1] as { id: string }).id);
    expect(new Set(calledModelIds)).toEqual(new Set(['voter-a', 'voter-b', 'voter-c']));
  });

  it('does NOT silently degrade to a single model (modelsUsed retains the fan-out shape)', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: healthyResponses(),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    expect(r.modelsUsed.length).toBe(3);
    expect(new Set(r.modelsUsed.map((e) => e.modelId))).toEqual(
      new Set(['voter-a', 'voter-b', 'voter-c']),
    );
  });
});
