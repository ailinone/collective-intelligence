// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * dry-run-execution-guard.ts — SM-R2-CORRECTIVE §7
 *
 * Global dry-run guardrail for the orchestration engine.
 *
 * Problem addressed:
 *   Before this module, `dryRun` was only honored for `strategy='consensus'`
 *   via ConsensusPlanDryRunService in chat-request-processor.ts (line 1358).
 *   Any auto-routed request that resolved to a non-consensus strategy (e.g.
 *   `single`, `cost-cascade`, `debate`) would make REAL provider calls even
 *   when the caller signalled `dryRun=true`.
 *
 * This module provides:
 *   1. `isDryRunRequested(request)` — canonical dry-run detection for any
 *      strategy, checking all known signal locations in the request.
 *   2. `DryRunGuardResult` — the typed shape returned to the engine so it can
 *      short-circuit execution and call StrategyPlanOnlyAdapter instead.
 *
 * Injection point:
 *   orchestration-engine.ts — AFTER `this.injectProviderRegistry(strategy)`,
 *   BEFORE `this.feedbackLoop.executeWithFeedback(...)`.
 *
 * Immutable rules:
 *   - Never makes provider calls.
 *   - Returns `providerCallExecuted: false` always.
 *   - `costUsd` is always 0.
 */

import type { ChatRequest } from '@/types';

/**
 * Detection result from the dry-run guard.
 */
export interface DryRunGuardResult {
  /** True when the guard detects a dry-run signal and has intercepted. */
  readonly intercepted: true;
  /** The resolved strategy name used for routing (no execution happened). */
  readonly strategyName: string;
  /** Selection source that produced the strategy (e.g. 'cold-start-policy', 'heuristic'). */
  readonly selectionSource: string;
  /** Always false — guaranteed no provider call was made. */
  readonly providerCallExecuted: false;
  /** Always 0 — no billable cost. */
  readonly costUsd: 0;
  /** Reason the dry-run signal was detected (for audit / trace). */
  readonly detectionPath: DryRunDetectionPath;
}

/** Where the dry-run signal was found in the request. */
export type DryRunDetectionPath =
  | 'request.dryRun'            // top-level { dryRun: true }
  | 'ailin_metadata.dryRun'     // { ailin_metadata: { dryRun: true } }
  | 'eval.dryRun'               // { eval: { dryRun: true } } (consensus legacy path)
  | 'eval.planOnly';            // { eval: { planOnly: true } }

/**
 * Canonical dry-run detection.
 *
 * Checks all known signal locations in order of precedence:
 *   1. Top-level `dryRun` field (new universal path — SM-R2-CORRECTIVE)
 *   2. `ailin_metadata.dryRun` (runtime metadata bag)
 *   3. `eval.dryRun` (legacy consensus-only path — still supported)
 *   4. `eval.planOnly` (alias for dryRun in eval bag)
 *
 * @returns `{ detected: false }` when no dry-run signal is present.
 * @returns `{ detected: true, path }` with the first matching path.
 */
export function detectDryRun(
  request: ChatRequest & {
    dryRun?: boolean;
    ailin_metadata?: Record<string, unknown>;
    eval?: { dryRun?: boolean; planOnly?: boolean };
  },
): { detected: false } | { detected: true; path: DryRunDetectionPath } {
  // 1. Top-level dryRun (universal, any strategy)
  if (request.dryRun === true) {
    return { detected: true, path: 'request.dryRun' };
  }

  // 2. ailin_metadata bag
  if ((request.ailin_metadata as { dryRun?: unknown } | undefined)?.dryRun === true) {
    return { detected: true, path: 'ailin_metadata.dryRun' };
  }

  // 3. eval.dryRun (legacy consensus path)
  if (request.eval?.dryRun === true) {
    return { detected: true, path: 'eval.dryRun' };
  }

  // 4. eval.planOnly (alias)
  if (request.eval?.planOnly === true) {
    return { detected: true, path: 'eval.planOnly' };
  }

  return { detected: false };
}

/**
 * Convenience boolean wrapper over `detectDryRun`.
 * Use when you only need the boolean, not the detection path.
 */
export function isDryRunRequested(
  request: ChatRequest & {
    dryRun?: boolean;
    ailin_metadata?: Record<string, unknown>;
    eval?: { dryRun?: boolean; planOnly?: boolean };
  },
): boolean {
  return detectDryRun(request).detected;
}

/**
 * Build the DryRunGuardResult for a successfully intercepted request.
 *
 * @param strategyName  — The strategy that WOULD have been executed.
 * @param selectionSource — The selection source (e.g. 'cold-start-policy').
 * @param detectionPath — Path from `detectDryRun`.
 */
export function buildDryRunIntercepted(
  strategyName: string,
  selectionSource: string,
  detectionPath: DryRunDetectionPath,
): DryRunGuardResult {
  return {
    intercepted: true,
    strategyName,
    selectionSource,
    providerCallExecuted: false,
    costUsd: 0,
    detectionPath,
  };
}
