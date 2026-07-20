// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pair-contribution-profile.test.ts — MVP 8A
 *
 * Direct tests for the pair-profile computer.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPairContributionProfile,
  pairKey,
} from '../pair-contribution-profile';
import type { HistoricalExecution } from '../historical-execution-types';

function pairExec(judge: number, cost: number): HistoricalExecution {
  return {
    executionId: 'x',
    experimentId: 'e',
    taskId: 't',
    taskType: 'code-generation',
    complexity: 'medium',
    strategyId: 'parallel',
    effectiveStrategyId: 'parallel',
    modelsUsed: ['A', 'B'],
    judgeScore: judge,
    costUsd: cost,
    success: true,
  } as HistoricalExecution;
}

describe('buildPairContributionProfile', () => {
  it('empty execs → zero everything', () => {
    const p = buildPairContributionProfile(
      'A',
      'B',
      'code-generation',
      [],
      { singleJudgeMean: 0.5, singleCostMean: 0.02 },
      {},
    );
    expect(p.sampleCount).toBe(0);
    expect(p.judgeMean).toBe(0);
    expect(p.paretoWinRate).toBe(0);
  });

  it('canonicalises pair ordering (alphabetical)', () => {
    const a = buildPairContributionProfile(
      'B',
      'A',
      'code-generation',
      [pairExec(0.5, 0.01)],
      { singleJudgeMean: 0.4, singleCostMean: 0.02 },
      {},
    );
    expect(a.modelA).toBe('A');
    expect(a.modelB).toBe('B');
  });

  it('beatsSingleBaselineRate = 1 when every exec beats baseline judge', () => {
    const execs = Array.from({ length: 5 }, () => pairExec(0.9, 0.02));
    const p = buildPairContributionProfile(
      'A',
      'B',
      'code-generation',
      execs,
      { singleJudgeMean: 0.5, singleCostMean: 0.025 },
      { A: { judgeMean: 0.5, harmScore: 0 }, B: { judgeMean: 0.45, harmScore: 0 } },
    );
    expect(p.beatsSingleBaselineRate).toBe(1);
    expect(p.paretoWinRate).toBeGreaterThan(0); // judge>= AND cost<=
  });

  it('complementarityScore is positive when pair beats avg single', () => {
    const execs = Array.from({ length: 5 }, () => pairExec(0.9, 0.02));
    const p = buildPairContributionProfile(
      'A',
      'B',
      'code-generation',
      execs,
      { singleJudgeMean: 0.5, singleCostMean: 0.025 },
      { A: { judgeMean: 0.5, harmScore: 0 }, B: { judgeMean: 0.45, harmScore: 0 } },
    );
    expect(p.complementarityScore).toBeGreaterThan(0);
  });

  it('redundancyPenalty grows when pair barely improves over best single', () => {
    const execs = Array.from({ length: 5 }, () => pairExec(0.51, 0.02));
    const p = buildPairContributionProfile(
      'A',
      'B',
      'code-generation',
      execs,
      { singleJudgeMean: 0.5, singleCostMean: 0.025 },
      { A: { judgeMean: 0.5, harmScore: 0 }, B: { judgeMean: 0.5, harmScore: 0 } },
    );
    expect(p.redundancyPenalty).toBeGreaterThan(0);
  });

  it('qualityPerDollar is finite and positive', () => {
    const execs = [pairExec(0.8, 0.01)];
    const p = buildPairContributionProfile(
      'A',
      'B',
      'code-generation',
      execs,
      { singleJudgeMean: 0.5, singleCostMean: 0.025 },
      {},
    );
    expect(p.qualityPerDollar).toBeGreaterThan(0);
    expect(Number.isFinite(p.qualityPerDollar)).toBe(true);
  });

  it('profile is frozen', () => {
    const p = buildPairContributionProfile(
      'A',
      'B',
      'code-generation',
      [pairExec(0.5, 0.02)],
      { singleJudgeMean: 0.5, singleCostMean: 0.025 },
      {},
    );
    expect(Object.isFrozen(p)).toBe(true);
  });
});

describe('pairKey', () => {
  it('is order-independent', () => {
    expect(pairKey('A', 'B')).toBe(pairKey('B', 'A'));
  });

  it('uses alphabetical join', () => {
    expect(pairKey('B', 'A')).toBe('A||B');
  });
});
