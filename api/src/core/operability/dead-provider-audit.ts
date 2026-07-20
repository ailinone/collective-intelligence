// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Dead-provider HTTP attempt audit (R5 — 2026-05-09).
 *
 * Phase 1 shipped `recordDeadProviderHttpAttempt` as a counter that
 * callers MUST manually increment when they detect a bypass of the
 * near-zero skip path. That requires every adapter / fallback / retry
 * code path to know about the audit — fragile and easy to forget.
 *
 * R5 adds a **passive auditor** that watches HTTP outcomes against the
 * registry state and detects bypasses automatically. Three design
 * choices are open:
 *
 *   A) **Adapter-level wrap**: instrument fetch inside each provider
 *      adapter. Most precise (we know exactly which fetch was made and
 *      which provider it belongs to), but requires touching N adapter
 *      files and breaks adapter encapsulation.
 *
 *   B) **base-strategy.ts post-hoc check**: after every executeModel
 *      attempt, compare (providerId, modelId) against the registry's
 *      pre-attempt state. If state was fatal AND skip would have
 *      returned true, count as bypass. Single instrumentation point,
 *      but only catches bypasses going through executeModel — misses
 *      adapter calls from other code paths (e.g., embedding pipeline,
 *      readiness probe).
 *
 *   C) **Failure-time inference**: when a request FAILS with a class
 *      that should have skipped (auth_failed re-occurrence within
 *      cooldown), infer that we made a dead-provider HTTP call.
 *      Cheapest but produces false negatives for slow failures.
 *
 * This file ships the SCAFFOLDING — the entry point + the
 * `recordHttpOutcome` API. The DECISION on which strategy is
 * left to the project owner (see TODO below).
 */

import { logger } from '@/utils/logger';
import { getProviderHealthRegistry } from './provider-health-registry';
import {
  recordDeadProviderHttpAttempt,
} from './skip-near-zero';
import type { HealthKey, ProviderHealthRecord, ProviderHealthState } from './types';

const log = logger.child({ component: 'dead-provider-audit' });

// ─── States considered fatal (skip would return true) ─────────────────────

const FATAL_STATES: ReadonlySet<ProviderHealthState> = new Set([
  'auth_failed',
  'insufficient_credit',
  'endpoint_not_found',
  'model_not_found',
  'permanently_disabled',
] as ProviderHealthState[]);

const TRANSIENT_SKIP_STATES: ReadonlySet<ProviderHealthState> = new Set([
  'rate_limited',
  'timeout_suspected',
  'temporarily_disabled',
] as ProviderHealthState[]);

// ─── Public API ───────────────────────────────────────────────────────────

export interface HttpOutcome {
  key: HealthKey;
  /** When the HTTP attempt started (Date.now() at call site). */
  attemptedAt: number;
  /** Whether the attempt produced a usable response. */
  success: boolean;
  /** Optional caller hint about which code path made the call. */
  source?: 'orchestrator_primary' | 'cross_provider_retry' | 'embedding_pipeline' | 'readiness_probe' | 'unknown';
}

/**
 * Records the outcome of an HTTP attempt against a provider/model and
 * decides whether it counts as a "dead provider attempt" — i.e., a
 * bypass of the near-zero skip path that should never have happened in
 * steady state.
 *
 * Intended call sites: any code path that makes a real HTTP call to a
 * provider. The audit is non-blocking — never throws, never delays the
 * caller. Detection logic is delegated to `detectBypass()`.
 *
 * Design contract:
 *   - bypass detection runs O(1) in the registry (in-memory lookup)
 *   - the counter `dead_provider_http_attempt_total{providerId,reason}`
 *     is the single SLO signal: in steady state it must equal 0
 *   - any non-zero growth signals an architectural drift (a new code
 *     path that doesn't consult skip-near-zero)
 */
export function recordHttpOutcome(outcome: HttpOutcome): void {
  try {
    const bypass = detectBypass(outcome);
    if (bypass.detected) {
      recordDeadProviderHttpAttempt(outcome.key, bypass.reason);
      log.warn(
        {
          providerId: outcome.key.providerId,
          modelId: outcome.key.modelId,
          source: outcome.source,
          reason: bypass.reason,
          stateAtAttempt: bypass.stateAtAttempt,
        },
        'Dead-provider HTTP attempt detected — skip-near-zero bypass',
      );
    }
  } catch (err) {
    // Audit must never break the caller.
    log.debug({ err: String(err) }, 'Audit detection threw — ignored');
  }
}

// ─── Bypass detection ─────────────────────────────────────────────────────

interface BypassDetectionResult {
  detected: boolean;
  reason: string;
  stateAtAttempt?: ProviderHealthState;
}

/**
 * Determines whether an HTTP attempt was a "dead provider" bypass —
 * i.e., an HTTP call that should have been short-circuited by
 * `shouldSkipNearZero` and wasn't.
 *
 * Strategy: TIME-WINDOW (decision recorded 2026-05-09).
 *
 *   1. No prior record → not a bypass (first attempt populates state).
 *   2. State is neither fatal nor transient-skip → call was always
 *      legitimate. Not a bypass.
 *   3. State IS in a skip class AND `attemptedAt < nextProbeAfter` →
 *      the call should have been skipped. Bypass.
 *   4. State IS in a skip class AND `attemptedAt >= nextProbeAfter` →
 *      the cooldown elapsed; this was a legitimate reprobe. Not a
 *      bypass.
 *
 * Why TIME-WINDOW: the registry's `nextProbeAfter` is the same field
 * that `shouldSkipNearZero` reads, so we get exact symmetry — the
 * audit detects exactly what skip would have prevented, no more, no
 * less. False positives on legitimate post-cooldown reprobes are
 * eliminated by the timestamp comparison.
 *
 * O(1): single registry lookup + Date.parse. No async, no DB.
 */
function detectBypass(outcome: HttpOutcome): BypassDetectionResult {
  const registry = getProviderHealthRegistry();
  const record = registry.lookup(outcome.key);

  // No record means we have no evidence the call was a bypass. The
  // registry hadn't seen this (provider, model) yet — first attempt is
  // legitimate and will populate the record afterward.
  if (!record) {
    return { detected: false, reason: 'no_prior_state' };
  }

  const isFatal = FATAL_STATES.has(record.state);
  const isTransientSkip = TRANSIENT_SKIP_STATES.has(record.state);

  if (!isFatal && !isTransientSkip) {
    return {
      detected: false,
      reason: 'state_not_skippable',
      stateAtAttempt: record.state,
    };
  }

  const nextProbeMs = record.nextProbeAfter ? Date.parse(record.nextProbeAfter) : 0;
  if (outcome.attemptedAt >= nextProbeMs) {
    return {
      detected: false,
      reason: 'cooldown_elapsed',
      stateAtAttempt: record.state,
    };
  }

  return {
    detected: true,
    reason: `bypass_within_cooldown:${record.state}`,
    stateAtAttempt: record.state,
  };
}

// ─── Diagnostic helpers ───────────────────────────────────────────────────

/**
 * Test helper: exposes the FATAL_STATES set so unit tests can assert
 * which states are considered bypass-eligible without coupling to the
 * private constant.
 */
export function getFatalStatesForTesting(): ReadonlySet<ProviderHealthState> {
  return FATAL_STATES;
}

export function getTransientSkipStatesForTesting(): ReadonlySet<ProviderHealthState> {
  return TRANSIENT_SKIP_STATES;
}

/**
 * Test helper: exposes the bypass detector so unit tests can validate
 * detection logic without going through `recordHttpOutcome`'s side-
 * effecting telemetry path.
 */
export function detectBypassForTesting(outcome: HttpOutcome): BypassDetectionResult {
  return detectBypass(outcome);
}

/**
 * Diagnostic helper for the admin endpoint — returns whether a given
 * key would be considered known-bad at this exact moment. Used for
 * the "explain why this provider got skipped" feature.
 */
export function explainHealthState(key: HealthKey): {
  state: ProviderHealthState | 'unknown';
  isFatal: boolean;
  isTransientSkip: boolean;
  nextProbeAfter?: string;
  cooldownRemainingMs?: number;
} {
  const record: ProviderHealthRecord | undefined = getProviderHealthRegistry().lookup(key);
  if (!record) {
    return { state: 'unknown', isFatal: false, isTransientSkip: false };
  }
  const nextProbeMs = record.nextProbeAfter ? Date.parse(record.nextProbeAfter) : 0;
  const cooldownRemainingMs = Math.max(0, nextProbeMs - Date.now());
  return {
    state: record.state,
    isFatal: FATAL_STATES.has(record.state),
    isTransientSkip: TRANSIENT_SKIP_STATES.has(record.state),
    nextProbeAfter: record.nextProbeAfter,
    cooldownRemainingMs,
  };
}
