// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * media-planner-repository — post-hoc plan compilation (§3.3).
 *
 * "After the loop completes (success, partial success, or budget
 * exhaustion), the full PlannerState.turns transcript is compiled into a
 * persisted, structured plan record — capability calls made, candidates
 * generated, judge verdicts, constraints satisfied/unmet."
 *
 * Reuses the existing `WorkflowExecution` Prisma model
 * (`api/prisma/schema.prisma`) rather than inventing a new table or
 * hijacking `CollectiveRun`/`CollectiveSignal`
 * (`core/coordination/collective-run-repository.ts`, the pattern
 * `DebateStrategy` uses via `persistDebateRun`): `CollectiveRun`'s schema is
 * shaped around a consensus/debate PROCESS (`convergenceScore`,
 * `decisionFlipRate`, `dissent`) that has no meaningful mapping for a
 * planner's turn loop, whereas `WorkflowExecution` is already the
 * generically-named table for exactly this shape of record — a step-by-step
 * execution trace (`currentStepIdx`/`totalSteps`, `stepResults: Json[]`,
 * `status`) — no schema migration required. It is declared in the schema
 * but not yet written to anywhere else in the codebase; this is its first
 * writer.
 *
 * Persistence here is always best-effort: a DB failure NEVER fails the
 * planner's own result — the caller already has the user-facing answer by
 * the time this runs, so this function only logs and returns.
 */
import { prisma, Prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { getErrorMessage, narrowAs } from '@/utils/type-guards';
import type { PlannerState, PlannerStopReason } from './media-planner-types';

const log = logger.child({ component: 'media-planner-repository' });

export interface PersistMediaPlanRunInput {
  readonly organizationId: string;
  readonly userId?: string;
  readonly requestId: string;
  readonly state: PlannerState;
  readonly stopReason: PlannerStopReason;
  readonly totalCostUsd: number;
  readonly totalDurationMs: number;
  readonly unmetConstraints: readonly string[];
}

function statusForStopReason(stopReason: PlannerStopReason): string {
  switch (stopReason) {
    case 'final':
      return 'completed';
    case 'error':
      return 'failed';
    default:
      // turn_cap_exhausted / cost_ceiling_exhausted: the planner still
      // produced a (degraded) final response — "partial success", not a
      // hard failure — but it is not a clean completion either.
      return 'completed_degraded';
  }
}

/**
 * Persist one MediaPlannerStrategy run as a `WorkflowExecution` row.
 * Never throws — logs and swallows any DB error so a persistence hiccup
 * can never surface as a user-facing failure for an otherwise-successful
 * plan.
 */
export async function persistMediaPlanRun(input: PersistMediaPlanRunInput): Promise<void> {
  try {
    await prisma.workflowExecution.create({
      data: {
        workflowId: `media-plan:${input.requestId}`,
        organizationId: input.organizationId,
        userId: input.userId,
        status: statusForStopReason(input.stopReason),
        currentStepIdx: input.state.turns.length,
        totalSteps: input.state.budget.maxTurns,
        variables: narrowAs<Prisma.InputJsonValue>({
          originalRequest: input.state.originalRequest,
          budget: { ...input.state.budget },
          unmetConstraints: input.unmetConstraints,
          totalCostUsd: input.totalCostUsd,
          totalDurationMs: input.totalDurationMs,
          artifactCount: input.state.artifacts.length,
        }),
        stepResults: narrowAs<Prisma.InputJsonValue>(input.state.turns),
        error: input.stopReason === 'error' ? 'planner loop ended in an error turn' : null,
        completedAt: new Date(),
      },
    });
  } catch (err) {
    log.warn(
      { requestId: input.requestId, error: getErrorMessage(err) },
      'MediaPlannerStrategy: failed to persist plan audit trail (non-fatal, result already returned to caller)'
    );
  }
}
