// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Decision Audit
 *
 * Records routing decisions to the `decision_audit` table for traceability,
 * debugging, and governance. Allows answering "why was strategy X chosen for
 * request Y?" without reading logs.
 *
 * Write is async and non-blocking — a failure here never blocks execution.
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import type { ExecutionStrategyName } from '@/types';

const log = logger.child({ component: 'decision-audit' });

export interface DecisionAuditRecord {
  requestId: string;
  organizationId: string;
  taskType: string;
  complexity: string;
  requestedStrategy: string | null;
  triageIntent: string | null;
  triageComplexity: string | null;
  triageConfidence: number | null;
  triageRecommendedStrategy: string | null;
  strategyScores: Record<string, number>;
  selectedStrategy: ExecutionStrategyName;
  selectionReason: string; // explicit, triage, archive, pareto, bandit, scored, fallback
  modelsConsidered: string[];
  modelsSelected: string[];
  // Closed-loop fields
  decisionSource?: string;
  decisionConfidence?: number;
  expectedQuality?: number;
  candidateDetails?: Array<{ strategy: string; source: string; score: number }>;
  inputHash?: string;
}

/**
 * Write a decision audit record asynchronously.
 * Never throws — failures are logged at warn level.
 */
export function writeDecisionAudit(record: DecisionAuditRecord): void {
  // Fire-and-forget; orchestration must not wait on this
  setImmediate(() => {
    _writeAudit(record).catch((err) => {
      log.warn({ error: String(err), requestId: record.requestId }, 'Decision audit write failed');
    });
  });
}

async function _writeAudit(record: DecisionAuditRecord): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO decision_audit (
      request_id,
      organization_id,
      task_type,
      complexity,
      requested_strategy,
      triage_intent,
      triage_complexity,
      triage_confidence,
      triage_recommended_strategy,
      strategy_scores,
      selected_strategy,
      selection_reason,
      models_considered,
      models_selected,
      decision_source,
      decision_confidence,
      expected_quality,
      candidate_details,
      input_hash,
      created_at
    ) VALUES (
      ${record.requestId},
      ${record.organizationId},
      ${record.taskType},
      ${record.complexity},
      ${record.requestedStrategy},
      ${record.triageIntent},
      ${record.triageComplexity},
      ${record.triageConfidence},
      ${record.triageRecommendedStrategy},
      ${JSON.stringify(record.strategyScores)}::jsonb,
      ${record.selectedStrategy},
      ${record.selectionReason},
      ${record.modelsConsidered}::text[],
      ${record.modelsSelected}::text[],
      ${record.decisionSource ?? null},
      ${record.decisionConfidence ?? null},
      ${record.expectedQuality ?? null},
      ${record.candidateDetails ? JSON.stringify(record.candidateDetails) : null}::jsonb,
      ${record.inputHash ?? null},
      NOW()
    )
    ON CONFLICT (request_id) DO NOTHING
  `;
}
