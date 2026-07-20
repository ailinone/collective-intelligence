// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-results-normalizer.test.ts — MVP 8B.6
 */

import { describe, expect, it } from 'vitest';
import {
  normaliseRow,
  normaliseRows,
} from '../harvest/historical-results-normalizer';

describe('normaliseRow — judge scale detection', () => {
  it('detects 0..1 scale', () => {
    const r = normaliseRow({
      executionId: 'e1',
      experimentId: 'exp1',
      taskType: 'code',
      modelsUsed: ['m'],
      judgeScore: 0.85,
    });
    expect(r).toBeDefined();
    expect(r!.judgeScaleDetected).toBe('0_1');
    expect(r!.judgeScoreNormalized).toBe(0.85);
    expect(r!.judgeNormalizationApplied).toBe(false);
    expect(r!.judgeComparable).toBe(true);
  });

  it('detects 0..100 scale and normalises to 0..1', () => {
    const r = normaliseRow({
      executionId: 'e1',
      experimentId: 'exp1',
      taskType: 'code',
      modelsUsed: ['m'],
      judgeScore: 85,
    });
    expect(r).toBeDefined();
    expect(r!.judgeScaleDetected).toBe('0_100');
    expect(r!.judgeScoreNormalized).toBeCloseTo(0.85, 3);
    expect(r!.judgeNormalizationApplied).toBe(true);
    expect(r!.judgeComparable).toBe(true);
  });

  it('detects 1..5 scale and normalises (1→0, 5→1)', () => {
    const r = normaliseRow({
      executionId: 'e1',
      experimentId: 'exp1',
      taskType: 'code',
      modelsUsed: ['m'],
      judgeScore: 4,
    });
    expect(r).toBeDefined();
    expect(r!.judgeScaleDetected).toBe('1_5');
    expect(r!.judgeScoreNormalized).toBeCloseTo(0.75, 3);
  });

  it('returns unknown when score is null or invalid', () => {
    const r = normaliseRow({
      executionId: 'e1',
      experimentId: 'exp1',
      taskType: 'code',
      modelsUsed: ['m'],
    });
    expect(r).toBeDefined();
    expect(r!.judgeScaleDetected).toBe('unknown');
    expect(r!.judgeScoreNormalized).toBeNull();
    expect(r!.judgeComparable).toBe(false);
  });

  it('drops rows missing executionId OR experimentId', () => {
    expect(normaliseRow({ experimentId: 'exp1' })).toBeNull();
    expect(normaliseRow({ executionId: 'e1' })).toBeNull();
  });
});

describe('normaliseRow — defensive parsing', () => {
  it('parses Postgres array literal modelsUsed', () => {
    const r = normaliseRow({
      executionId: 'e1',
      experimentId: 'exp1',
      taskType: 'code',
      modelsUsed: '{model-a,model-b}',
      judgeScore: 0.5,
    });
    expect(r).toBeDefined();
    expect(r!.modelsUsed).toEqual(['model-a', 'model-b']);
  });

  it('parses numeric strings for cost / latency', () => {
    const r = normaliseRow({
      executionId: 'e1',
      experimentId: 'exp1',
      taskType: 'code',
      modelsUsed: ['m'],
      judgeScore: 0.5,
      costUsd: '0.0234',
      latencyMs: '1500',
    });
    expect(r).toBeDefined();
    expect(r!.costUsd).toBeCloseTo(0.0234, 4);
    expect(r!.latencyMs).toBe(1500);
  });
});

describe('normaliseRows', () => {
  it('skips rows that fail to normalise', () => {
    const out = normaliseRows([
      { executionId: 'e1', experimentId: 'exp1', taskType: 'code', modelsUsed: ['m'], judgeScore: 0.5 },
      { foo: 'bar' },
    ]);
    expect(out.normalised.length).toBe(1);
    expect(out.skipped.length).toBe(1);
  });
});
