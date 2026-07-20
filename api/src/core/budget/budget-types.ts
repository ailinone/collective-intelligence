// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Budget & Credit Types
 *
 * Shared type definitions for the CreditGovernor and experiment budget tracking.
 */

// ─── Credit Check ───────────────────────────────────────────────────────

export interface CreditCheckResult {
  canProceed: boolean;
  reason: CreditCheckReason;
  detail?: string;
  /** Route key that was checked (e.g., "aihubmix:openai") */
  routeKey: string;
  /** Remaining budget for this route (if known) */
  remainingBudgetUsd?: number;
  /** Estimated cost of the planned execution */
  estimatedCostUsd?: number;
}

export type CreditCheckReason =
  | 'approved'
  | 'route_exhausted'            // This specific route has no credits
  | 'route_rate_limited'         // Route is rate limited
  | 'route_auth_failed'          // Route has auth failure
  | 'route_unavailable'          // Route is temporarily unavailable
  | 'experiment_budget_exceeded' // Global experiment budget exceeded
  | 'arm_budget_exceeded'        // Per-arm budget exceeded
  | 'structural_failure';        // ALL external routes exhausted

// ─── Budget Allocation ──────────────────────────────────────────────────

export interface BudgetAllocation {
  /** Global experiment budget in USD */
  experimentBudgetUsd: number;
  /** Per-arm budget (if set) */
  armBudgets?: Record<string, number>;
  /** Minimum remaining buffer before warning */
  minBufferUsd: number;
}

// ─── Spend Tracking ─────────────────────────────────────────────────────

export interface SpendRecord {
  routeKey: string;
  costUsd: number;
  timestamp: number;
  requestId?: string;
}

// ─── Route Exhaustion ───────────────────────────────────────────────────

export interface RouteExhaustionRecord {
  routeKey: string;
  reason: string;
  exhaustedAt: number;
  /** Auto-recovery: try again after this timestamp */
  retryAfter?: number;
}
