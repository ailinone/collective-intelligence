// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * model-harm-profile.test.ts — MVP 8A
 *
 * Direct tests for the harm-profile computer.
 */

import { describe, expect, it } from 'vitest';
import { buildModelHarmProfile } from '../model-harm-profile';
import type { HistoricalExecution } from '../historical-execution-types';

function ex(
  overrides: Partial<HistoricalExecution> & { judgeScore: number; modelId?: string },
): HistoricalExecution {
  return {
    executionId: 'x',
    experimentId: 'e',
    taskId: 't',
    taskType: 'code-generation',
    complexity: 'medium',
    strategyId: 'single',
    effectiveStrategyId: 'single',
    modelsUsed: [overrides.modelId ?? 'm'],
    judgeScore: overrides.judgeScore,
    costUsd: 0.01,
    success: overrides.success ?? true,
    degraded: overrides.degraded,
    failureMode: overrides.failureMode,
    modality: overrides.modality,
    ...overrides,
  } as HistoricalExecution;
}

describe('buildModelHarmProfile', () => {
  it('empty executions → zero harm + summary=no_samples', () => {
    const p = buildModelHarmProfile('m', 'code-generation', []);
    expect(p.sampleCount).toBe(0);
    expect(p.harmScore).toBe(0);
    expect(p.summary).toBe('no_samples');
  });

  it('all zero outputs → high zeroOutputRate and harmScore', () => {
    const execs = Array.from({ length: 5 }, () => ex({ judgeScore: 0 }));
    const p = buildModelHarmProfile('m', 'code-generation', execs);
    expect(p.zeroOutputRate).toBe(1);
    expect(p.harmScore).toBeGreaterThanOrEqual(0.4);
    expect(p.summary).toContain('zero_output');
  });

  it('all degraded → high degradedRate and harmScore', () => {
    const execs = Array.from({ length: 4 }, () =>
      ex({ judgeScore: 0.5, degraded: true }),
    );
    const p = buildModelHarmProfile('m', 'code-generation', execs);
    expect(p.degradedRate).toBe(1);
    expect(p.summary).toContain('degraded');
  });

  it('all failures → high failureRate', () => {
    const execs = Array.from({ length: 4 }, () =>
      ex({ judgeScore: 0, success: false }),
    );
    const p = buildModelHarmProfile('m', 'code-generation', execs);
    expect(p.failureRate).toBe(1);
  });

  it('modality mismatch counted when expectedModality is given', () => {
    const execs = Array.from({ length: 4 }, () =>
      ex({ judgeScore: 0.3, modality: 'audio' }),
    );
    const p = buildModelHarmProfile('m', 'code-generation', execs, 'text');
    expect(p.modalityMismatchRate).toBe(1);
    expect(p.summary).toContain('modality_mismatch');
  });

  it('mixed modality is NOT counted as mismatch', () => {
    const execs = Array.from({ length: 4 }, () =>
      ex({ judgeScore: 0.5, modality: 'mixed' }),
    );
    const p = buildModelHarmProfile('m', 'code-generation', execs, 'text');
    expect(p.modalityMismatchRate).toBe(0);
  });

  it('healthy executions → low harm, summary=no_significant_harm', () => {
    const execs = Array.from({ length: 10 }, () =>
      ex({ judgeScore: 0.7, modality: 'text' }),
    );
    const p = buildModelHarmProfile('m', 'code-generation', execs, 'text');
    expect(p.harmScore).toBeLessThan(0.2);
    expect(p.summary).toBe('no_significant_harm');
  });

  it('profile object is frozen', () => {
    const execs = [ex({ judgeScore: 0.5 })];
    const p = buildModelHarmProfile('m', 'code-generation', execs);
    expect(Object.isFrozen(p)).toBe(true);
  });
});
