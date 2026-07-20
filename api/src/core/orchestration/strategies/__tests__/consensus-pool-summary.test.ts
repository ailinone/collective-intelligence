// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.2 Part E — dry-run pool summary on the plan.
 *
 * Confirms `summarizePool` returns the right counts so the dry-run
 * surface (`ailin_metadata.consensusPlan.poolSummary`) reflects the
 * underlying credit/operability shape.
 */
import { describe, it, expect } from 'vitest';
import { summarizePool } from '../consensus-execution-planner';
import { fullConsensusPool, makeCandidate, makeModel } from '../../model-selection/__tests__/role-resolver.fixtures';
import type { ModelCapability } from '@/types';

describe('summarizePool', () => {
  it('counts usable / no_credits / local / aggregator from candidate flags', () => {
    const pool = [
      makeCandidate({ id: 'a', model: makeModel({ id: 'a', provider: 'cloud-1' }) }),
      makeCandidate({ id: 'b', hasCredits: false, model: makeModel({ id: 'b', provider: 'cloud-2' }) }),
      makeCandidate({ id: 'c', rateLimited: true, model: makeModel({ id: 'c', provider: 'cloud-3' }) }),
      makeCandidate({ id: 'd', providerHealthy: false, model: makeModel({ id: 'd', provider: 'cloud-4' }) }),
      makeCandidate({ id: 'e', isLocal: true, model: makeModel({ id: 'e', provider: 'ollama' }) }),
      makeCandidate({ id: 'f', model: makeModel({ id: 'f', provider: 'aihubmix' }) }),
    ];
    const s = summarizePool(pool);
    expect(s.totalCandidates).toBe(6);
    expect(s.distinctProvidersConsidered).toBe(6);
    expect(s.usableProviderCount).toBeGreaterThanOrEqual(2); // at least 'a' + 'e' + 'f'
    expect(s.noCreditsProviderCount).toBe(1);
    expect(s.rateLimitedProviderCount).toBe(1);
    expect(s.authFailedProviderCount).toBe(1);
    expect(s.localProvidersConsidered).toBe(1);
    expect(s.aggregatorsConsidered).toBe(1); // aihubmix matches hint
  });

  it('on the standard fullConsensusPool, distinctProvidersConsidered = pool size', () => {
    const s = summarizePool(fullConsensusPool());
    expect(s.distinctProvidersConsidered).toBe(s.totalCandidates);
  });

  it('honors capability-bearing candidates without losing the summary shape', () => {
    const pool = [
      makeCandidate({
        id: 'json-able',
        model: makeModel({
          id: 'json-able',
          provider: 'cloud-x',
          capabilities: ['chat', 'json_mode'] as ModelCapability[],
        }),
      }),
    ];
    const s = summarizePool(pool);
    expect(s.usableProviderCount).toBe(1);
    expect(s.usableModelCount).toBe(1);
    expect(s.noCreditsProviderCount).toBe(0);
  });
});
