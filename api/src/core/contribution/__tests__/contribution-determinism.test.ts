// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * contribution-determinism.test.ts — MVP 8A
 *
 * The aggregator must be deterministic: same input → byte-identical
 * output across thousands of runs. No clock, no randomness.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { scoreHistoricalContribution } from '../historical-contribution-scorer';
import { HISTORICAL_EXECUTIONS_FIXTURE } from './fixtures/historical-executions.fixture';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('contribution — determinism', () => {
  it('same input → byte-identical JSON over 1000 iterations', () => {
    const first = scoreHistoricalContribution({
      executions: HISTORICAL_EXECUTIONS_FIXTURE,
    });
    const firstJson = JSON.stringify(first);
    for (let i = 0; i < 1000; i += 1) {
      const r = scoreHistoricalContribution({
        executions: HISTORICAL_EXECUTIONS_FIXTURE,
      });
      expect(JSON.stringify(r)).toBe(firstJson);
    }
  });

  it('does not call Date.now', () => {
    const spy = vi.spyOn(Date, 'now');
    scoreHistoricalContribution({ executions: HISTORICAL_EXECUTIONS_FIXTURE });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not call Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    scoreHistoricalContribution({ executions: HISTORICAL_EXECUTIONS_FIXTURE });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not mutate input array', () => {
    const before = JSON.stringify(HISTORICAL_EXECUTIONS_FIXTURE);
    scoreHistoricalContribution({ executions: HISTORICAL_EXECUTIONS_FIXTURE });
    const after = JSON.stringify(HISTORICAL_EXECUTIONS_FIXTURE);
    expect(after).toBe(before);
  });

  it('modelProfiles are sorted by (modelId, taskType) deterministically', () => {
    const result = scoreHistoricalContribution({
      executions: HISTORICAL_EXECUTIONS_FIXTURE,
    });
    const keys = result.modelProfiles.map((p) => `${p.modelId}||${p.taskType}`);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it('pairProfiles are sorted by canonical pair key deterministically', () => {
    const result = scoreHistoricalContribution({
      executions: HISTORICAL_EXECUTIONS_FIXTURE,
    });
    const keys = result.pairProfiles.map(
      (p) => `${p.modelA}||${p.modelB}||${p.taskType}`,
    );
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});
