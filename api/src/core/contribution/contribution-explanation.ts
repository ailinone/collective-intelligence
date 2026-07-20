// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * contribution-explanation.ts — MVP 8A
 *
 * Pure helper that turns a candidate's score breakdown + rejection
 * reasons into a deterministic, human-readable single-line explanation.
 *
 * Used by the optimizer's plan output. Never embeds raw prompts or PII.
 */

import type { ModelRole } from './model-task-performance-profile';

export interface CandidateExplanationInput {
  readonly modelId: string;
  readonly recommendedRole: ModelRole;
  readonly contributionScore: number;
  readonly harmScore: number;
  readonly modalityFit: number;
  readonly costPenalty: number;
  readonly confidence: number;
  readonly rejected: boolean;
  readonly rejectionReasons: readonly string[];
}

export function buildCandidateExplanation(
  input: CandidateExplanationInput,
): string {
  if (input.rejected) {
    const reasons = input.rejectionReasons.length
      ? input.rejectionReasons.join(',')
      : 'unspecified';
    return `rejected:role=${input.recommendedRole};reasons=${reasons}`;
  }
  const parts: string[] = [
    `accepted`,
    `role=${input.recommendedRole}`,
    `contribution=${fmt(input.contributionScore)}`,
    `harm=${fmt(input.harmScore)}`,
    `modalityFit=${fmt(input.modalityFit)}`,
    `costPenalty=${fmt(input.costPenalty)}`,
    `confidence=${fmt(input.confidence)}`,
  ];
  return parts.join(';');
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0.0000';
  return n.toFixed(4);
}
