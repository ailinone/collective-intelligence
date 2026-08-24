// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { applyFreeTierStrategyCap } from '../triage-service';
import type { TriageDecision } from '@/types';

function decision(recommendedStrategy: TriageDecision['recommendedStrategy']): TriageDecision {
  return {
    intent: 'general',
    complexity: 'high',
    recommendedStrategy,
    confidence: 0.9,
  };
}

describe('applyFreeTierStrategyCap', () => {
  it('passes undefined through untouched', () => {
    expect(applyFreeTierStrategyCap(undefined, true)).toBeUndefined();
  });

  it('is a no-op when not in free-tier scope, regardless of strategy', () => {
    const d = decision('debate');
    expect(applyFreeTierStrategyCap(d, false)).toBe(d);
  });

  it('leaves allowlisted strategies (single, cost-cascade) unchanged in free-tier scope', () => {
    for (const strategy of ['single', 'cost-cascade'] as const) {
      const d = decision(strategy);
      expect(applyFreeTierStrategyCap(d, true)).toEqual(d);
    }
  });

  it('leaves a decision with no recommendedStrategy unchanged', () => {
    const d = decision(undefined);
    expect(applyFreeTierStrategyCap(d, true)).toEqual(d);
  });

  it('downgrades every non-allowlisted strategy to cost-cascade in free-tier scope — allowlist, not a denylist, so unlisted/new strategies default to capped', () => {
    const expensive = [
      'debate',
      'consensus',
      'quality-multipass',
      'devil-advocate-consensus',
      'blind-debate',
      'war-room',
      'safety-quorum',
      'diversity-ensemble',
      'stigmergic-refinement',
      'swarm-explore',
      'research-synthesize',
      'critique-repair',
      'double-diamond',
      'multi-hop-qa',
      'persona-exploration',
      'parallel',
      'sequential',
      'collaborative',
      'hybrid',
      'competitive',
      'expert-panel',
      'massive-parallel',
      'adaptive',
      'contextual',
      'hierarchical',
      'reinforcement',
      'clarification-first',
    ] as const;

    for (const strategy of expensive) {
      const d = decision(strategy);
      const capped = applyFreeTierStrategyCap(d, true);
      expect(capped?.recommendedStrategy).toBe('cost-cascade');
    }
  });

  it('preserves every other field on the decision, and records why in `reason`', () => {
    const d: TriageDecision = {
      intent: 'coding',
      complexity: 'high',
      recommendedStrategy: 'debate',
      confidence: 0.87,
      reason: 'Complex multi-step debugging task',
      estimatedTokens: 500,
    };
    const capped = applyFreeTierStrategyCap(d, true);
    expect(capped).toMatchObject({
      intent: 'coding',
      complexity: 'high',
      recommendedStrategy: 'cost-cascade',
      confidence: 0.87,
      estimatedTokens: 500,
    });
    expect(capped?.reason).toContain('Complex multi-step debugging task');
    expect(capped?.reason).toContain('debate');
    expect(capped?.reason).toContain('free-tier cost cap');
  });

  it('does not mutate the input decision object', () => {
    const d = decision('consensus');
    const original = { ...d };
    applyFreeTierStrategyCap(d, true);
    expect(d).toEqual(original);
  });
});
