// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-results-harvester.test.ts — MVP 8B.6
 *
 * Smoke test for the full pipeline.
 */

import { describe, expect, it } from 'vitest';
import { harvestHistoricalResults } from '../harvest/historical-results-harvester';
import type { HistoricalRawRow } from '../harvest/historical-results-schema';

function rawRow(
  overrides: Partial<HistoricalRawRow> & { id: string; experiment_id: string },
): HistoricalRawRow {
  return {
    id: overrides.id,
    experiment_id: overrides.experiment_id,
    task_index: 0,
    repetition: 0,
    strategy: 'single',
    task_type: 'code-generation',
    models_used: ['m1'],
    judge_score: 0.7,
    cost_usd: 0.02,
    success: true,
    created_at: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

describe('harvestHistoricalResults', () => {
  it('runs the full pipeline on a clean dataset', () => {
    const raw: HistoricalRawRow[] = [
      rawRow({ id: 'e1', experiment_id: 'exp1' }),
      rawRow({ id: 'e2', experiment_id: 'exp1' }),
      rawRow({ id: 'e3', experiment_id: 'exp2' }),
    ];
    const r = harvestHistoricalResults(raw);
    expect(r.counts.rawRows).toBe(3);
    expect(r.counts.usableForTraining).toBe(3);
    expect(r.trainingAndHoldoutCandidates.length).toBe(3);
  });

  it('drops rows missing required fields', () => {
    const raw: HistoricalRawRow[] = [
      rawRow({ id: 'e1', experiment_id: 'exp1' }),
      { foo: 'bar' },
      rawRow({ id: 'e2', experiment_id: 'exp1', models_used: [] }),
    ];
    const r = harvestHistoricalResults(raw);
    expect(r.counts.rawRows).toBe(3);
    // foo:bar fails normalisation, models_used=[] is excluded
    expect(r.counts.usableForTraining).toBe(1);
    expect(r.counts.excluded).toBe(1);
  });

  it('deduplicates rows with the same executionId', () => {
    const raw: HistoricalRawRow[] = [
      rawRow({ id: 'e1', experiment_id: 'exp1' }),
      rawRow({ id: 'e1', experiment_id: 'exp1' }),
      rawRow({ id: 'e2', experiment_id: 'exp1' }),
    ];
    const r = harvestHistoricalResults(raw);
    expect(r.counts.usableForTraining).toBe(2);
  });

  it('produces a sanitisation report listing removed and kept fields', () => {
    const r = harvestHistoricalResults([rawRow({ id: 'e1', experiment_id: 'exp1' })]);
    expect(r.sanitisation.removedFields.length).toBeGreaterThan(0);
    expect(r.sanitisation.keptFields.length).toBeGreaterThan(0);
    expect(r.sanitisation.removedFields).toContain('prompt');
    expect(r.sanitisation.keptFields).toContain('executionId');
  });

  it('classifies rows with missing judge but present cost as usable_for_cost_only', () => {
    const r = harvestHistoricalResults([
      rawRow({ id: 'e1', experiment_id: 'exp1', judge_score: null as unknown as number }),
    ]);
    expect(r.counts.usableForCostOnly).toBe(1);
  });

  it('output is frozen', () => {
    const r = harvestHistoricalResults([rawRow({ id: 'e1', experiment_id: 'exp1' })]);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.trainingAndHoldoutCandidates)).toBe(true);
  });
});
