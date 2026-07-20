// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-DRYRUN-EXPERIMENT-DESIGN — Matrix, strategy/baseline, budget and metric invariants.
 *
 * ABSOLUTE PROHIBITIONS: no C3 execution, no provider/model probes, no dryRun=false.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  C3_APPROVED_STRATEGIES,
  C3_EXCLUDED_STRATEGIES,
  C3_BASELINES,
  C3_TASK_IDS,
  C3_MAX_FANOUT_BY_STRATEGY,
  C3_MAX_RETRIES_PER_CELL,
  C3_NO_UNBOUNDED_FANOUT,
  C3_NO_UNBOUNDED_RETRY,
  C3_FIXED_JUDGE_FORBIDDEN,
  C3_FIXED_SYNTHESIZER_FORBIDDEN_WITHOUT_JUSTIFICATION,
  C3_PRIMARY_SUCCESS_METRIC,
} from '@/core/experiment/c3-dryrun-experiment-design-contract';

function readArtifact(name: string) {
  const p = resolve(process.cwd(), 'tmp', name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

const taskMatrix = readArtifact('01c1b-c3-dryrun-design-task-strategy-matrix.json');
const baselineMatrix = readArtifact('01c1b-c3-dryrun-design-baseline-matrix.json');

describe('01C.1B-C3-DRYRUN-EXPERIMENT-DESIGN — matrices and policies', () => {
  describe('strategy scope', () => {
    it('case 11: fast remains excluded from C3', () => {
      expect(C3_EXCLUDED_STRATEGIES).toContain('fast');
      expect(C3_APPROVED_STRATEGIES as readonly string[]).not.toContain('fast');
    });

    it('case 12: the 7 approved strategies are present', () => {
      expect(C3_APPROVED_STRATEGIES).toHaveLength(7);
      for (const s of [
        'single',
        'consensus',
        'debate',
        'expert-panel',
        'cost-cascade',
        'critique-repair',
        'quality-multipass',
      ]) {
        expect(C3_APPROVED_STRATEGIES as readonly string[]).toContain(s);
      }
    });

    it('case 13: the 3 baselines are present', () => {
      expect(C3_BASELINES).toHaveLength(3);
      expect(C3_BASELINES).toContain('single_tier1_quality_baseline');
      expect(C3_BASELINES).toContain('single_balanced_baseline');
      expect(C3_BASELINES).toContain('single_cheapest_acceptable_baseline');
    });

    it('the 8 task ids are present', () => {
      expect(C3_TASK_IDS).toHaveLength(8);
    });
  });

  describe('budget / fanout policy', () => {
    it('case 25: budget policy bounds fanout (no unbounded fanout or retry)', () => {
      expect(C3_NO_UNBOUNDED_FANOUT).toBe(true);
      expect(C3_NO_UNBOUNDED_RETRY).toBe(true);
      expect(C3_MAX_RETRIES_PER_CELL).toBe(0);
      for (const n of Object.values(C3_MAX_FANOUT_BY_STRATEGY)) {
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(4);
      }
      expect(C3_MAX_FANOUT_BY_STRATEGY.single).toBe(1);
    });
  });

  describe('judge / synthesizer policy', () => {
    it('case 26: fixed judge forbidden; fixed synthesizer forbidden without justification', () => {
      expect(C3_FIXED_JUDGE_FORBIDDEN).toBe(true);
      expect(C3_FIXED_SYNTHESIZER_FORBIDDEN_WITHOUT_JUSTIFICATION).toBe(true);
    });
  });

  describe('primary success metric (thesis)', () => {
    it('case 27: requires quality delta, cost delta, failure rate and provenance', () => {
      expect(C3_PRIMARY_SUCCESS_METRIC.requiresQualityDelta).toBe(true);
      expect(C3_PRIMARY_SUCCESS_METRIC.requiresCostDelta).toBe(true);
      expect(C3_PRIMARY_SUCCESS_METRIC.requiresFailureRate).toBe(true);
      expect(C3_PRIMARY_SUCCESS_METRIC.requiresProvenanceCompleteness).toBe(true);
    });

    it('thesis is not quality-per-dollar alone (cost must strictly decrease)', () => {
      expect(C3_PRIMARY_SUCCESS_METRIC.requiresCostDelta).toBe(true);
      expect(C3_PRIMARY_SUCCESS_METRIC.qualityTolerance).toBeLessThanOrEqual(0.05);
    });
  });

  const maybeTask = taskMatrix ? describe : describe.skip;
  maybeTask('generated task-strategy matrix (local verification)', () => {
    it('case 14: task-strategy matrix has planned cells', () => {
      expect(taskMatrix.strategyCellCount).toBeGreaterThan(0);
      expect(taskMatrix.taskStrategyCells.length).toBe(taskMatrix.strategyCellCount);
    });
    it('every strategy cell is dryRun=true / planOnly=true / no execution', () => {
      expect(
        taskMatrix.taskStrategyCells.every(
          (c: any) => c.dryRun === true && c.planOnly === true && c.c3ExecutionAuthorized === false,
        ),
      ).toBe(true);
    });
    it('no cell uses the excluded fast strategy', () => {
      expect(taskMatrix.taskStrategyCells.some((c: any) => c.strategyId === 'fast')).toBe(false);
    });
  });

  const maybeBaseline = baselineMatrix ? describe : describe.skip;
  maybeBaseline('generated baseline matrix (local verification)', () => {
    it('case 15: baseline matrix has planned cells', () => {
      expect(baselineMatrix.baselineCellCount).toBeGreaterThan(0);
      expect(baselineMatrix.baselineCells.length).toBe(baselineMatrix.baselineCellCount);
    });
    it('every baseline cell is dryRun=true / planOnly=true / no execution', () => {
      expect(
        baselineMatrix.baselineCells.every(
          (c: any) => c.dryRun === true && c.planOnly === true && c.c3ExecutionAuthorized === false,
        ),
      ).toBe(true);
    });
  });
});
