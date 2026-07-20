// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-results-deduper.test.ts — MVP 8B.6
 */

import { describe, expect, it } from 'vitest';
import { dedupeRows } from '../harvest/historical-results-deduper';
import type { NormalisedRow } from '../harvest/historical-results-schema';

function row(executionId: string, taskType = 'code'): NormalisedRow {
  return Object.freeze({
    executionId,
    experimentId: 'exp',
    taskId: executionId,
    modelsUsed: ['m'],
    providerRoutes: [],
    judgeScoreRaw: 0.5,
    judgeScoreNormalized: 0.5,
    judgeScaleDetected: '0_1',
    judgeNormalizationApplied: false,
    judgeComparable: true,
    judgeUsed: true,
    qualityScore: null,
    heuristicScoreRaw: null,
    costUsd: 0.02,
    latencyMs: null,
    totalTokens: null,
    success: true,
    taskType,
    strategy: 'single',
  });
}

describe('dedupeRows', () => {
  it('keeps first occurrence of each executionId', () => {
    const r = dedupeRows([row('a'), row('b'), row('a'), row('c')]);
    expect(r.unique.length).toBe(3);
    expect(r.unique.map((x) => x.executionId)).toEqual(['a', 'b', 'c']);
    expect(r.duplicates.length).toBe(1);
    expect(r.duplicates[0].executionId).toBe('a');
  });

  it('handles all-unique input', () => {
    const r = dedupeRows([row('a'), row('b'), row('c')]);
    expect(r.unique.length).toBe(3);
    expect(r.duplicates.length).toBe(0);
  });

  it('handles empty input', () => {
    const r = dedupeRows([]);
    expect(r.unique.length).toBe(0);
    expect(r.duplicates.length).toBe(0);
  });

  it('output is frozen', () => {
    const r = dedupeRows([row('a')]);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.unique)).toBe(true);
  });
});
