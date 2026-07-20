// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shadow integration helper for the coordinator-stable ensemble.
 *
 * Strategies use this to call the ensemble *without* blocking the
 * heuristic decision path. The heuristic always drives execution;
 * the ensemble call runs in the background, its result is logged
 * for offline comparison, and any failure is suppressed.
 *
 * This is the safety net for Phase 2c: the ensemble can be live in
 * the audit trail (via F3.3 export) for shadow-evaluation while the
 * heuristic remains the source of truth for actual orchestration.
 *
 * When operators are ready to flip from shadow → live, they swap
 * `runEnsembleInShadow` for a direct `await callEnsembleCoordinator`
 * at the strategy call site. The contract is identical.
 */

import { logger } from '@/utils/logger';
import { serializeError } from '@/utils/type-guards';
import {
  callEnsembleCoordinatorBreakered,
  loadEnsembleClientConfig,
  type EnsembleDecisionResult,
} from './ensemble-coordinator-client';
import type {
  AggregatedEnsembleDecision,
  EnsembleClientConfig,
  EnsembleDecisionRequest,
} from './ensemble-coordinator-types';
import { recordShadowMetrics } from './ensemble-shadow-metrics';

const log = logger.child({ component: 'ensemble-coordinator-shadow' });

/**
 * Run an ensemble call in shadow mode. Never throws, never blocks.
 *
 * Returns a promise that resolves once the shadow call completes (so
 * tests can await it deterministically), but production callers should
 * usually fire-and-forget — the heuristic decision is already returned
 * by the time this resolves.
 *
 * The shadow result is:
 *   - logged at info level on success (with comparison vs heuristic)
 *   - logged at warn level on failure (never propagated)
 *   - persisted by the strategy in `decisionValue.shadowEnsemble`
 *     when the strategy supplies an `onShadowResult` hook
 */
export async function runEnsembleInShadow(
  request: EnsembleDecisionRequest,
  options: ShadowRunOptions = {},
): Promise<EnsembleDecisionResult | null> {
  const config = options.config ?? loadEnsembleClientConfig();

  // Fast path: ensemble disabled — return null so the strategy knows
  // there's no shadow result to record.
  if (!config.enabled) {
    return null;
  }

  if (!config.shadowMode) {
    // The caller invoked shadow path even though shadow mode is off.
    // We still run the call, but log a warning so misconfiguration
    // surfaces in observability.
    log.warn(
      { strategy: request.strategy, decisionType: request.decisionType },
      'runEnsembleInShadow called with shadowMode=false; results will be discarded',
    );
  }

  const start = Date.now();
  try {
    const result = await callEnsembleCoordinatorBreakered(request, config);
    const elapsedMs = Date.now() - start;

    if (result.kind === 'success') {
      log.info(
        {
          strategy: request.strategy,
          decisionType: request.decisionType,
          shadowDecision: {
            role: result.decision.role,
            scheduler: result.decision.scheduler,
            reason: result.decision.reason,
            confidence: result.decision.confidence,
            tiersActivated: result.decision.tiersActivated,
            shortCircuited: result.decision.shortCircuited,
          },
          heuristicDecision: options.heuristicDecisionForComparison,
          divergence: detectDivergence(result.decision, options.heuristicDecisionForComparison),
          elapsedMs,
        },
        'Ensemble shadow decision recorded',
      );
    } else if (result.kind === 'disabled') {
      // Shouldn't happen given the early return above, but be defensive.
      log.debug({ strategy: request.strategy, elapsedMs }, 'Shadow call hit disabled state');
    } else if (result.kind === 'timeout') {
      log.warn(
        { strategy: request.strategy, elapsedMs },
        'Ensemble shadow call timed out',
      );
    } else {
      log.warn(
        { strategy: request.strategy, message: result.message, elapsedMs },
        'Ensemble shadow call errored',
      );
    }

    const snapshot = liftToSnapshot(result, options.heuristicDecisionForComparison);

    // Always record metrics — even when no hook is supplied. Operations
    // dashboards must see shadow activity regardless of whether the
    // calling strategy persisted the snapshot.
    try {
      recordShadowMetrics(request.strategy, request.decisionType, snapshot);
    } catch (metricsErr) {
      log.warn(
        { strategy: request.strategy, error: serializeError(metricsErr) },
        'recordShadowMetrics threw — ignoring',
      );
    }

    if (options.onShadowResult) {
      try {
        options.onShadowResult(snapshot);
      } catch (hookErr) {
        // A buggy hook must not poison the request path.
        log.warn(
          { strategy: request.strategy, error: serializeError(hookErr) },
          'onShadowResult hook threw — ignoring',
        );
      }
    }

    return result;
  } catch (err) {
    // The client never throws by contract — but we wrap defensively
    // because shadow errors must NEVER reach the strategy.
    const elapsedMs = Date.now() - start;
    log.warn(
      { strategy: request.strategy, error: serializeError(err), elapsedMs },
      'Shadow runner caught unexpected error',
    );
    return null;
  }
}

/**
 * Options for `runEnsembleInShadow`. All optional.
 */
export interface ShadowRunOptions {
  /**
   * Override the loaded config — typically only used in tests.
   */
  config?: EnsembleClientConfig;
  /**
   * The decision the heuristic just made, included in shadow logs so
   * we can compute divergence offline. Strategies that already have
   * a RoleDecision-shaped value can pass it directly.
   */
  heuristicDecisionForComparison?: {
    role: string;
    scheduler: string;
    reason: string;
  };
  /**
   * Callback invoked AFTER the shadow result is logged. Strategies use
   * this to capture the result in a closure variable so it can be
   * persisted to `collective_signals.decision_value.shadowEnsemble`
   * when the run is finalized.
   *
   * Why a callback instead of awaiting the returned promise: the
   * strategy must NOT block on shadow latency. The hook runs on the
   * same task queue as the heuristic but on a different microtask,
   * so the strategy's `await ...` chain is unaffected.
   *
   * Errors thrown from the callback are caught + logged at warn level
   * — the shadow result is informational and a buggy hook can't be
   * allowed to break request handling.
   */
  onShadowResult?: (snapshot: ShadowEnsembleSnapshot) => void;
}

/**
 * Lifted shadow result + divergence report shaped for persistence.
 *
 * Lands in `collective_signals.decision_value.shadowEnsemble` JSONB.
 * F3.3 export pipeline reads this exact shape so trained students
 * have ground-truth (heuristic decision) + ensemble vote + divergence
 * label per record.
 */
export interface ShadowEnsembleSnapshot {
  /** Discriminator — strategies can branch on this without re-checking shape. */
  kind: 'success' | 'disabled' | 'timeout' | 'error';
  /** The ensemble's chosen role (only meaningful when kind === 'success'). */
  role?: string;
  /** Scheduler tag the ensemble emitted (e.g. "mock-cascade-24-tiered"). */
  scheduler?: string;
  /** Reason token from the stable vocabulary. */
  reason?: string;
  /** 0.0..1.0 winner-share confidence (winner_score / total_weight). */
  confidence?: number;
  /** "weighted_bayesian_majority" | "mock_deterministic" | etc. */
  aggregationMethod?: string;
  /** Total votes counted across all activated tiers. */
  totalVotes?: number;
  /** Tiers that ran (1..6) — `[1]` means short-circuit, `[1..6]` means fallthrough. */
  tiersActivated?: ReadonlyArray<number>;
  /** True when cascade exited before Tier 6 due to high-confidence agreement. */
  shortCircuited?: boolean;
  /** Comparison vs heuristic — null if no heuristicDecisionForComparison passed. */
  divergence: DivergenceReport | null;
  /** End-to-end shadow latency in ms (success/timeout/error all carry this). */
  latencyMs: number;
  /** Error message when kind === 'error'; absent otherwise. */
  errorMessage?: string;
}

/**
 * Convert the discriminated `EnsembleDecisionResult` plus the heuristic
 * comparison into the persistence-ready `ShadowEnsembleSnapshot` shape.
 *
 * Centralized so all 5 strategies can drop in `onShadowResult` with a
 * one-liner and the JSONB shape stays consistent.
 */
export function liftToSnapshot(
  result: EnsembleDecisionResult,
  heuristic: { role: string; scheduler: string; reason: string } | undefined,
): ShadowEnsembleSnapshot {
  if (result.kind === 'success') {
    return {
      kind: 'success',
      role: result.decision.role,
      scheduler: result.decision.scheduler,
      reason: result.decision.reason,
      confidence: result.decision.confidence,
      aggregationMethod: result.decision.aggregationMethod,
      totalVotes: result.decision.totalVotes,
      tiersActivated: result.decision.tiersActivated,
      shortCircuited: result.decision.shortCircuited,
      divergence: detectDivergence(result.decision, heuristic),
      latencyMs: result.latencyMs,
    };
  }
  if (result.kind === 'disabled') {
    return { kind: 'disabled', divergence: null, latencyMs: 0 };
  }
  if (result.kind === 'timeout') {
    return { kind: 'timeout', divergence: null, latencyMs: result.latencyMs };
  }
  return {
    kind: 'error',
    divergence: null,
    latencyMs: result.latencyMs,
    errorMessage: result.message,
  };
}

/**
 * Compute a structured comparison between the ensemble's decision and
 * the heuristic's. Used for the shadow log entry — when the team flips
 * shadow → live, this same function feeds the offline divergence
 * report.
 *
 * Returns null when there's no heuristic decision to compare against.
 */
export function detectDivergence(
  shadow: AggregatedEnsembleDecision,
  heuristic: { role: string; scheduler: string; reason: string } | undefined,
): DivergenceReport | null {
  if (!heuristic) return null;
  return {
    sameRole: shadow.role === heuristic.role,
    sameReason: shadow.reason === heuristic.reason,
    bothAgreeOnSchedulerFamily:
      schedulerFamily(shadow.scheduler) === schedulerFamily(heuristic.scheduler),
    shadowConfidence: shadow.confidence,
  };
}

export interface DivergenceReport {
  sameRole: boolean;
  sameReason: boolean;
  bothAgreeOnSchedulerFamily: boolean;
  shadowConfidence: number;
}

/**
 * Extract the "family" of a scheduler tag for cross-implementation
 * comparison: "fixed-state-machine" → "fixed", "ensemble-24-..." →
 * "ensemble", "teacher-triage-proxy" → "teacher", etc.
 */
function schedulerFamily(scheduler: string): string {
  const dashIdx = scheduler.indexOf('-');
  if (dashIdx <= 0) return scheduler;
  return scheduler.slice(0, dashIdx);
}
