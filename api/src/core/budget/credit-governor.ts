// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Credit-Aware Execution Governor
 *
 * Ensures that credit exhaustion on one route/hub/account does NOT block
 * the entire experiment when other eligible routes still exist.
 *
 * Key guarantees:
 * 1. A failure on "aihubmix:openai" only exhausts that specific route
 * 2. The experiment continues with "cometapi:openai", native "openai", etc.
 * 3. Structural failure is declared ONLY when ALL external routes are exhausted
 * 4. Self-hosted fallback is controlled separately (see last-resort-policy.ts)
 *
 * This module reads from ProviderOperabilityHub (snapshot) and maintains its own
 * spend tracking + route exhaustion state. It does NOT replace the hub — it
 * adds budget-awareness on top.
 */

import { logger } from '@/utils/logger';
import { getProviderOperabilityHub } from '../provider-operability-hub';
import { buildRouteKey, extractModelFamily, isRouteUsable, isExternalRoute } from '../operability/operability-snapshot';
import type { CreditCheckResult, CreditCheckReason, BudgetAllocation, SpendRecord, RouteExhaustionRecord } from './budget-types';

const log = logger.child({ component: 'credit-governor' });

// ─── Configuration ──────────────────────────────────────────────────────

const ROUTE_RECOVERY_MS = 5 * 60 * 1000; // 5 min: retry exhausted route
const MAX_SPEND_RECORDS = 10_000;

// ─── Governor ───────────────────────────────────────────────────────────

export class CreditGovernor {
  private readonly spendRecords: SpendRecord[] = [];
  private readonly exhaustedRoutes = new Map<string, RouteExhaustionRecord>();
  private totalSpendUsd = 0;
  private readonly armSpend = new Map<string, number>();

  constructor(private readonly budget: BudgetAllocation) {}

  // ── Pre-flight Check ──────────────────────────────────────────────

  /**
   * Check if an execution can proceed on a given route.
   *
   * Called BEFORE every API call. Returns immediately (no I/O).
   */
  canExecute(
    executionProvider: string,
    modelId: string,
    estimatedCostUsd: number,
    armKey?: string,
  ): CreditCheckResult {
    const modelFamily = extractModelFamily(modelId);
    const routeKey = buildRouteKey(executionProvider, modelFamily);

    // 1. Check route exhaustion (with auto-recovery)
    const exhaustion = this.exhaustedRoutes.get(routeKey);
    if (exhaustion) {
      if (exhaustion.retryAfter && Date.now() > exhaustion.retryAfter) {
        // Recovery window elapsed — allow retry
        this.exhaustedRoutes.delete(routeKey);
        log.info({ routeKey }, 'Route exhaustion expired, allowing retry');
      } else {
        return {
          canProceed: false,
          reason: 'route_exhausted',
          detail: exhaustion.reason,
          routeKey,
          estimatedCostUsd,
        };
      }
    }

    // 2. Check operability hub state for this route
    const hub = getProviderOperabilityHub();
    const routeState = hub.getRouteState(executionProvider, modelId);
    const stateReason = this.checkRouteState(routeState, routeKey);
    if (stateReason) {
      return {
        canProceed: false,
        reason: stateReason,
        detail: routeState.operabilityReasonCode,
        routeKey,
        estimatedCostUsd,
      };
    }

    // 3. Check global experiment budget
    if (this.totalSpendUsd + estimatedCostUsd > this.budget.experimentBudgetUsd) {
      return {
        canProceed: false,
        reason: 'experiment_budget_exceeded',
        detail: `spent=$${this.totalSpendUsd.toFixed(4)}, estimated=$${estimatedCostUsd.toFixed(4)}, budget=$${this.budget.experimentBudgetUsd}`,
        routeKey,
        remainingBudgetUsd: this.budget.experimentBudgetUsd - this.totalSpendUsd,
        estimatedCostUsd,
      };
    }

    // 4. Check per-arm budget
    if (armKey && this.budget.armBudgets) {
      const armBudget = this.budget.armBudgets[armKey];
      if (armBudget !== undefined) {
        const armSpent = this.armSpend.get(armKey) ?? 0;
        if (armSpent + estimatedCostUsd > armBudget) {
          return {
            canProceed: false,
            reason: 'arm_budget_exceeded',
            detail: `arm=${armKey}, spent=$${armSpent.toFixed(4)}, budget=$${armBudget}`,
            routeKey,
            remainingBudgetUsd: armBudget - armSpent,
            estimatedCostUsd,
          };
        }
      }
    }

    // 5. Check structural failure (ALL external routes exhausted)
    if (this.isStructuralFailure()) {
      return {
        canProceed: false,
        reason: 'structural_failure',
        detail: 'All external routes exhausted — no external providers available',
        routeKey,
        estimatedCostUsd,
      };
    }

    return {
      canProceed: true,
      reason: 'approved',
      routeKey,
      remainingBudgetUsd: this.budget.experimentBudgetUsd - this.totalSpendUsd,
      estimatedCostUsd,
    };
  }

  // ── Post-execution Recording ──────────────────────────────────────

  /**
   * Record actual spend after a successful execution.
   */
  recordSpend(executionProvider: string, modelId: string, costUsd: number, armKey?: string, requestId?: string): void {
    const modelFamily = extractModelFamily(modelId);
    const routeKey = buildRouteKey(executionProvider, modelFamily);

    this.totalSpendUsd += costUsd;

    if (armKey) {
      this.armSpend.set(armKey, (this.armSpend.get(armKey) ?? 0) + costUsd);
    }

    this.spendRecords.push({
      routeKey,
      costUsd,
      timestamp: Date.now(),
      requestId,
    });

    // Prevent memory growth
    if (this.spendRecords.length > MAX_SPEND_RECORDS) {
      this.spendRecords.splice(0, this.spendRecords.length - MAX_SPEND_RECORDS);
    }
  }

  /**
   * Mark a specific route as exhausted (credit/quota/auth failure).
   * The route will auto-recover after ROUTE_RECOVERY_MS.
   */
  markRouteExhausted(executionProvider: string, modelId: string, reason: string): void {
    const modelFamily = extractModelFamily(modelId);
    const routeKey = buildRouteKey(executionProvider, modelFamily);

    this.exhaustedRoutes.set(routeKey, {
      routeKey,
      reason,
      exhaustedAt: Date.now(),
      retryAfter: Date.now() + ROUTE_RECOVERY_MS,
    });

    log.warn({ routeKey, reason, retryAfterMs: ROUTE_RECOVERY_MS }, 'Route marked as exhausted');
  }

  /**
   * Mark a route as recovered (e.g., after a successful execution on that route).
   */
  markRouteRecovered(executionProvider: string, modelId: string): void {
    const modelFamily = extractModelFamily(modelId);
    const routeKey = buildRouteKey(executionProvider, modelFamily);
    if (this.exhaustedRoutes.delete(routeKey)) {
      log.info({ routeKey }, 'Route recovered from exhaustion');
    }
  }

  // ── Structural Failure Detection ──────────────────────────────────

  /**
   * Returns true ONLY when ALL external routes are exhausted.
   * This is the signal that self-hosted fallback should be considered.
   *
   * Empty-hub semantics: when the operability hub has zero routes
   * recorded (typical at boot, before any execution event), we treat
   * that as "no evidence of exhaustion" rather than "all exhausted" —
   * the orchestrator should be allowed to attempt routes optimistically.
   * Without this, the credit-governor blocks every execution at boot
   * because `runtimeEvents` is empty and the hub reports zero usable
   * routes, even though every provider may be perfectly healthy.
   */
  isStructuralFailure(): boolean {
    const snapshot = getProviderOperabilityHub().getSnapshot();
    const allRoutes = Object.values(snapshot.routes);

    // Empty hub: optimistic — no execution events yet, so we cannot
    // claim all routes are exhausted. The orchestrator's per-request
    // routing handles real failures via cross-provider fallback.
    if (allRoutes.length === 0) {
      return false;
    }

    // Check if there's any usable external route NOT in our exhaustion list
    for (const record of allRoutes) {
      if (!isExternalRoute(record)) continue;
      if (!isRouteUsable(record)) continue;
      if (this.exhaustedRoutes.has(record.routeKey)) continue;
      return false; // at least one usable external route
    }
    return true; // No usable external routes
  }

  // ── Query ─────────────────────────────────────────────────────────

  /**
   * Get all eligible (non-exhausted, usable) external routes.
   */
  getEligibleRoutes(): string[] {
    const snapshot = getProviderOperabilityHub().getSnapshot();
    const result: string[] = [];
    for (const [key, record] of Object.entries(snapshot.routes)) {
      if (!isExternalRoute(record)) continue;
      if (!isRouteUsable(record)) continue;
      if (this.exhaustedRoutes.has(key)) continue;
      result.push(key);
    }
    return result;
  }

  /**
   * Get the set of exhausted route keys.
   */
  getExhaustedRoutes(): ReadonlyMap<string, RouteExhaustionRecord> {
    return this.exhaustedRoutes;
  }

  /** Total spend so far. */
  getTotalSpendUsd(): number {
    return this.totalSpendUsd;
  }

  /** Spend for a specific arm. */
  getArmSpendUsd(armKey: string): number {
    return this.armSpend.get(armKey) ?? 0;
  }

  /** Remaining budget. */
  getRemainingBudgetUsd(): number {
    return Math.max(0, this.budget.experimentBudgetUsd - this.totalSpendUsd);
  }

  // ── Private ───────────────────────────────────────────────────────

  private checkRouteState(record: { operabilityState: string; operabilityReasonCode: string }, _routeKey: string): CreditCheckReason | null {
    switch (record.operabilityState) {
      case 'no_credits':
        return 'route_exhausted';
      case 'rate_limited':
        return 'route_rate_limited';
      case 'auth_failed':
        return 'route_auth_failed';
      case 'temporarily_unavailable':
        return 'route_unavailable';
      default:
        return null;
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: CreditGovernor | null = null;

/**
 * Get or create the CreditGovernor singleton.
 * Must be initialized with budget allocation before first use.
 */
export function getCreditGovernor(): CreditGovernor {
  if (!instance) {
    // Default budget — will be overridden by experiment runner
    instance = new CreditGovernor({
      experimentBudgetUsd: 100,
      minBufferUsd: 1,
    });
  }
  return instance;
}

/**
 * Initialize the CreditGovernor with a specific budget.
 * Call this at experiment start.
 */
export function initCreditGovernor(budget: BudgetAllocation): CreditGovernor {
  instance = new CreditGovernor(budget);
  log.info({ budget: budget.experimentBudgetUsd, buffer: budget.minBufferUsd }, 'CreditGovernor initialized');
  return instance;
}
