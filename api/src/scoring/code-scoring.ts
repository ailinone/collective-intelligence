// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { CapabilityId } from '@/tests/types';

export const CODE_CAPABILITIES: CapabilityId[] = [
  'code_generation',

  'debugging',

  'code_review',

  'refactoring',

  'documentation',

  'testing',

  'code_interpreter',
];

const CODE_CAPABILITY_WEIGHTS: Partial<Record<CapabilityId, number>> = {
  code_generation: 0.25,

  debugging: 0.2,

  code_review: 0.15,

  refactoring: 0.15,

  documentation: 0.1,

  testing: 0.1,

  code_interpreter: 0.05,
};

export type CodeModelTier = 'gold' | 'silver' | 'bronze' | 'experimental';

export interface CodeModelScore {
  modelId: string;

  score: number; // 0–1

  capabilityBreakdown: {
    capability: CapabilityId;

    score: number; // média dos testes daquela capability

    weight: number;
  }[];

  tier: CodeModelTier;
}

export function calculateCodeModelScore(
  modelId: string,

  results: Array<{ capability: string; score: number }>
): CodeModelScore | null {
  const codeResults = results.filter((r) => (CODE_CAPABILITIES as string[]).includes(r.capability));

  if (codeResults.length === 0) {
    return null; // modelo não é "code model"
  }

  // agrupa por capability

  const byCap = new Map<CapabilityId, { totalScore: number; count: number }>();

  for (const r of codeResults) {
    const cap = r.capability as CapabilityId;

    if (!byCap.has(cap)) {
      byCap.set(cap, { totalScore: 0, count: 0 });
    }

    const agg = byCap.get(cap)!;

    agg.totalScore += r.score;

    agg.count += 1;
  }

  const breakdown: CodeModelScore['capabilityBreakdown'] = [];

  let weightedSum = 0;

  let totalWeight = 0;

  for (const [cap, agg] of byCap) {
    const avgScore = agg.totalScore / agg.count;

    const weight = CODE_CAPABILITY_WEIGHTS[cap] ?? 0.0;

    breakdown.push({
      capability: cap,

      score: avgScore,

      weight,
    });

    weightedSum += avgScore * weight;

    totalWeight += weight;
  }

  const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  const tier = getCodeModelTier(finalScore);

  return {
    modelId,

    score: finalScore,

    capabilityBreakdown: breakdown,

    tier,
  };
}

export function getCodeModelTier(score: number): CodeModelTier {
  if (score >= 0.85) return 'gold';

  if (score >= 0.7) return 'silver';

  if (score >= 0.5) return 'bronze';

  return 'experimental';
}
