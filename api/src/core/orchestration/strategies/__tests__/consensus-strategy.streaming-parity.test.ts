// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Streaming parity / block.
 *
 * Spec §10 demands NO runtime path through consensus that bypasses
 * evaluator/outlier/fallback. We picked Option B (block streaming
 * entirely) for this cycle. This test pins:
 *   - supportsStreaming() === false
 *   - executeStream() throws synchronously (via async-iter rejection)
 *   - execute() remains the only path that runs the evaluator
 */
import { describe, it, expect } from 'vitest';
import { ConsensusStrategy } from '../consensus-strategy';
import {
  healthyResponses,
  makeContext,
  makeRequest,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

describe('ConsensusStrategy — streaming is blocked', () => {
  it('supportsStreaming() returns false', () => {
    expect(new ConsensusStrategy().supportsStreaming()).toBe(false);
  });

  it('executeStream() throws explicitly with a guidance message', async () => {
    const strat = new ConsensusStrategy();
    const gen = strat.executeStream(makeRequest(), makeContext(threeHealthyModels()));
    await expect(gen.next()).rejects.toThrow(/disabled.*evaluator/i);
  });

  it('execute() continues to work and runs the evaluator', async () => {
    // Sanity: blocking stream did not break the non-streaming path.
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: healthyResponses(),
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    expect(r.strategyUsed).toBe('consensus');
    expect(r.metadata?.consensusArtifacts).toBeDefined();
  });
});
