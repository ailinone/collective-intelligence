// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { ValidationResult } from '@/services/model-validation-service';

import type { CapabilityId } from '@/tests/types';

import type { CodeRole } from '@/types/code-profile';

export interface RoleScore {
  modelId: string;

  role: CodeRole;

  score: number;

  breakdown: {
    capability: CapabilityId;

    score: number;

    weight: number;
  }[];
}

// Capabilities que queremos considerar por role:

export const BACKEND_CAPS: CapabilityId[] = [
  'code_generation',

  'debugging',

  'code_review',

  'refactoring',

  'testing',

  // e a pseudo-capacidade que vamos mapear para backendRestHandlerTest:

  'backend_suite' as CapabilityId,
];

export const FRONTEND_CAPS: CapabilityId[] = [
  'code_generation',

  'debugging',

  'code_review',

  'refactoring',

  'frontend_suite' as CapabilityId,
];

export const DATA_SCIENCE_CAPS: CapabilityId[] = [
  'code_generation',

  'debugging',

  'code_review',

  'code_interpreter',

  'mathematical_problem_solving',

  'data_extraction',

  'analysis',

  'data_science_suite' as CapabilityId,
];

// Pesos por role

const BACKEND_WEIGHTS: Partial<Record<CapabilityId, number>> = {
  code_generation: 0.25,

  debugging: 0.2,

  code_review: 0.15,

  refactoring: 0.15,

  testing: 0.1,

  backend_suite: 0.15,
};

const FRONTEND_WEIGHTS: Partial<Record<CapabilityId, number>> = {
  code_generation: 0.25,

  debugging: 0.15,

  code_review: 0.15,

  refactoring: 0.15,

  frontend_suite: 0.3,
};

const DATA_SCIENCE_WEIGHTS: Partial<Record<CapabilityId, number>> = {
  code_generation: 0.15,

  debugging: 0.1,

  code_review: 0.1,

  code_interpreter: 0.25,

  mathematical_problem_solving: 0.15,

  data_extraction: 0.1,

  analysis: 0.05,

  data_science_suite: 0.1,
};

// Função genérica para calcular Role Score

function aggregateRoleScore(
  modelId: string,

  results: ValidationResult[],

  capabilities: CapabilityId[],

  weights: Partial<Record<CapabilityId, number>>,

  role: CodeRole
): RoleScore | null {
  const filtered = results.filter((r) =>
    (capabilities as string[]).includes(r.capability)
  ) as ValidationResult[];

  if (filtered.length === 0) return null;

  // agrupa por capability

  const byCap = new Map<CapabilityId, { totalScore: number; count: number }>();

  for (const r of filtered) {
    const cap = r.capability as CapabilityId;

    if (!byCap.has(cap)) {
      byCap.set(cap, { totalScore: 0, count: 0 });
    }

    const agg = byCap.get(cap)!;

    agg.totalScore += r.score;

    agg.count += 1;
  }

  const breakdown: RoleScore['breakdown'] = [];

  let weightedSum = 0;

  let totalWeight = 0;

  for (const [cap, agg] of byCap) {
    const avgScore = agg.totalScore / agg.count;

    const weight = weights[cap] ?? 0;

    breakdown.push({ capability: cap, score: avgScore, weight });

    weightedSum += avgScore * weight;

    totalWeight += weight;
  }

  const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  return {
    modelId,

    role,

    score: finalScore,

    breakdown,
  };
}

export function calculateBackendScore(
  modelId: string,
  results: ValidationResult[]
): RoleScore | null {
  return aggregateRoleScore(modelId, results, BACKEND_CAPS, BACKEND_WEIGHTS, 'backend');
}

export function calculateFrontendScore(
  modelId: string,
  results: ValidationResult[]
): RoleScore | null {
  return aggregateRoleScore(modelId, results, FRONTEND_CAPS, FRONTEND_WEIGHTS, 'frontend');
}

export function calculateDataScienceScore(
  modelId: string,
  results: ValidationResult[]
): RoleScore | null {
  return aggregateRoleScore(
    modelId,
    results,
    DATA_SCIENCE_CAPS,
    DATA_SCIENCE_WEIGHTS,
    'data_science'
  );
}
