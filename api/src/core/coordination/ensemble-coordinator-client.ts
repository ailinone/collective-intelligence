// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ensemble Coordinator HTTP Client.
 *
 * Thin client for the model-stack `serving/aggregation/` endpoint.
 * Contract is owned by:
 *   - This file: TypeScript types in `ensemble-coordinator-types.ts`
 *   - Python:    `model-stack/serving/aggregation/tiered_voter.py`
 *   - Yaml:      `model-stack/registry/models/coordinator-stable.yaml`
 *
 * Strategy integration pattern:
 *   - The strategy attempts an ensemble decision via this client.
 *   - On success, the strategy lifts the AggregatedEnsembleDecision
 *     into its existing RoleDecision shape, and persists the rest in
 *     `collective_signals.decision_value` JSONB so F3.3 export carries
 *     the full vote distribution downstream.
 *   - On failure (timeout, 5xx, ensemble disabled), falls back to the
 *     existing heuristic decideRoleForTurn / assignModeratorRole /
 *     selectPanel. The fallback is documented per call site.
 *
 * Type-safety: zero `as unknown as` / `as any`. Boundary uses
 * `narrowAs<T>` after a type-guard validates the JSON shape.
 */

import { logger } from '@/utils/logger';
import { narrowAs, serializeError } from '@/utils/type-guards';
import { CircuitBreaker, CircuitBreakerOpenError } from '@/utils/circuit-breaker';
import {
  isAggregatedEnsembleDecision,
  type AggregatedEnsembleDecision,
  type EnsembleClientConfig,
  type EnsembleDecisionRequest,
  type EnsembleDecisionResponse,
} from './ensemble-coordinator-types';

const log = logger.child({ component: 'ensemble-coordinator-client' });

/**
 * Read configuration from environment variables.
 *
 * The ensemble is OFF by default in production until the 24-stable
 * has been trained and shadow-validated. Operators flip
 * CI_ENSEMBLE_COORDINATOR_ENABLED=true to activate.
 */
export function loadEnsembleClientConfig(env: NodeJS.ProcessEnv = process.env): EnsembleClientConfig {
  return {
    enabled: env.CI_ENSEMBLE_COORDINATOR_ENABLED === 'true',
    endpoint: env.CI_ENSEMBLE_COORDINATOR_URL ?? 'http://model-stack-aggregation:8090/v1/ensemble/decide',
    authToken: env.CI_ENSEMBLE_COORDINATOR_TOKEN,
    timeoutMs: Number(env.CI_ENSEMBLE_COORDINATOR_TIMEOUT_MS ?? 5000),
    shadowMode: env.CI_ENSEMBLE_COORDINATOR_SHADOW_MODE === 'true',
    fallbackOnError: env.CI_ENSEMBLE_COORDINATOR_FALLBACK_ON_ERROR !== 'false',
  };
}

/**
 * Result discriminated union — strategies branch on the `kind` field
 * to decide whether to use the ensemble decision or the fallback.
 */
export type EnsembleDecisionResult =
  | { kind: 'success'; decision: AggregatedEnsembleDecision; latencyMs: number }
  | { kind: 'disabled' }
  | { kind: 'timeout'; latencyMs: number }
  | { kind: 'error'; message: string; latencyMs: number };

/**
 * Call the ensemble endpoint. Never throws — returns a discriminated
 * union the caller must handle.
 *
 * Why not throw: strategies must remain available even when the
 * ensemble is down. The fallback to heuristics is the safety net,
 * and forcing the caller to handle the discriminated union makes
 * that fallback explicit at the call site.
 */
export async function callEnsembleCoordinator(
  request: EnsembleDecisionRequest,
  config: EnsembleClientConfig = loadEnsembleClientConfig(),
): Promise<EnsembleDecisionResult> {
  if (!config.enabled) {
    return { kind: 'disabled' };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (config.authToken) {
      headers['authorization'] = `Bearer ${config.authToken}`;
    }

    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<no body>');
      const latencyMs = Date.now() - start;
      log.warn(
        {
          status: response.status,
          endpoint: config.endpoint,
          latencyMs,
          bodyPreview: text.slice(0, 300),
        },
        'Ensemble coordinator returned non-2xx',
      );
      return {
        kind: 'error',
        message: `HTTP ${response.status}: ${text.slice(0, 200)}`,
        latencyMs,
      };
    }

    const raw: unknown = await response.json();
    const latencyMs = Date.now() - start;

    if (!raw || typeof raw !== 'object' || !('decision' in raw)) {
      log.warn({ latencyMs }, 'Ensemble coordinator response missing decision field');
      return { kind: 'error', message: 'malformed response: missing decision', latencyMs };
    }

    const candidate = (raw as Record<string, unknown>).decision;
    if (!isAggregatedEnsembleDecision(candidate)) {
      log.warn({ latencyMs }, 'Ensemble coordinator decision failed type-guard');
      return { kind: 'error', message: 'malformed decision shape', latencyMs };
    }

    // Type-narrowed; safe to use as AggregatedEnsembleDecision.
    return { kind: 'success', decision: candidate, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isAbort =
      err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));

    if (isAbort) {
      log.warn({ latencyMs, timeoutMs: config.timeoutMs }, 'Ensemble coordinator timed out');
      return { kind: 'timeout', latencyMs };
    }

    log.warn(
      { error: serializeError(err), latencyMs, endpoint: config.endpoint },
      'Ensemble coordinator call failed',
    );
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
      latencyMs,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker — protects the request path from coord-serving outages.
// ---------------------------------------------------------------------------
//
// Without a breaker, every shadow call during a coord-serving outage burns
// the full timeoutMs (default 5s) per request. At even modest QPS this turns
// into a measurable user-facing latency tax via I/O contention and event-loop
// pressure. The breaker stops the bleeding after `failureThreshold` failures
// in a rolling window: fast-fails subsequent requests with a synthetic
// `kind: 'error', message: 'circuit-open:...'` result until the cooldown
// elapses, at which point a single trial request gates the recovery.
//
// We share ONE breaker instance across all shadow strategies because they
// share the SAME upstream (coord-serving). Per-strategy breakers would
// fragment the failure signal and slow tripping.

class EnsembleCallFailure extends Error {
  constructor(public readonly result: EnsembleDecisionResult) {
    super(
      result.kind === 'success' || result.kind === 'disabled'
        ? 'unexpected — successful results should not be wrapped'
        : result.kind === 'timeout'
          ? `ensemble timeout after ${result.latencyMs}ms`
          : result.message,
    );
    this.name = 'EnsembleCallFailure';
  }
}

const ensembleCircuitBreaker = new CircuitBreaker({
  name: 'ensemble-coordinator-shadow',
  // 5 failures in 60s → open. Tuned for the shadow path: a brief
  // coord-serving blip shouldn't trip; a sustained outage should fast-fail
  // before request-path latency degrades.
  failureThreshold: 5,
  // 2 successes in HALF_OPEN → closed. Conservative — one success could be
  // a coincidental recovery; two confirms.
  successThreshold: 2,
  // 30s in OPEN before HALF_OPEN. Long enough that a bouncing coord-serving
  // doesn't immediately re-trip; short enough to recover within an SLA.
  timeout: 30_000,
  // 60s rolling window — failures older than this don't count toward the
  // threshold. Prevents a stale failure burst from holding the breaker open
  // forever after the service recovered.
  rollingWindowMs: 60_000,
});

/**
 * Variant of callEnsembleCoordinator with circuit-breaker protection.
 *
 * Same return contract — never throws, returns the discriminated union.
 * On circuit-open: short-circuits with `{ kind: 'error', message:
 * 'circuit-open:...' }` so downstream metrics + traces still see the
 * outage as an error category (distinguishable from other errors via
 * the `circuit-open:` prefix).
 *
 * Use this from runEnsembleInShadow; the un-breakered
 * `callEnsembleCoordinator` is preserved for tests and any caller that
 * deliberately wants a fresh attempt without breaker gating.
 */
export async function callEnsembleCoordinatorBreakered(
  request: EnsembleDecisionRequest,
  config: EnsembleClientConfig = loadEnsembleClientConfig(),
): Promise<EnsembleDecisionResult> {
  if (!config.enabled) {
    return { kind: 'disabled' };
  }

  try {
    return await ensembleCircuitBreaker.execute(async () => {
      const result = await callEnsembleCoordinator(request, config);
      // Convert non-success results to a thrown error so the breaker
      // counts them as failures. Disabled results are NOT seen here
      // because we early-returned above.
      if (result.kind !== 'success') {
        throw new EnsembleCallFailure(result);
      }
      return result;
    });
  } catch (err) {
    // Unwrap our wrapper — the original discriminated-union result
    // is what callers expect.
    if (err instanceof EnsembleCallFailure) {
      return err.result;
    }
    if (err instanceof CircuitBreakerOpenError) {
      return {
        kind: 'error',
        message: `circuit-open:${err.message}`,
        latencyMs: 0,
      };
    }
    // Defense-in-depth: any other thrown error becomes an error result.
    // Shouldn't happen — callEnsembleCoordinator never throws by contract.
    log.warn(
      { error: serializeError(err), strategy: request.strategy },
      'unexpected throw in breakered ensemble call',
    );
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
      latencyMs: 0,
    };
  }
}

/**
 * Helper: construct the strategy-side audit shape from an ensemble
 * decision. Lifts the four required fields (role, scheduler, reason,
 * confidence) into the existing RoleDecision-style return shape, and
 * keeps the full ensemble metadata for persistence.
 *
 * The full `AggregatedEnsembleDecision` is preserved verbatim in the
 * `ensembleMetadata` field so the F4.1 substrate's JSONB column
 * captures vote distribution + tier results without remap.
 */
export function liftEnsembleDecisionToAuditShape(
  decision: AggregatedEnsembleDecision,
): {
  role: string;
  scheduler: string;
  reason: string;
  confidence: number;
  ensembleMetadata: AggregatedEnsembleDecision;
} {
  return {
    role: decision.role,
    scheduler: decision.scheduler,
    reason: decision.reason,
    confidence: decision.confidence,
    // Carry the full ensemble decision for downstream persistence.
    // narrowAs is unnecessary here — `decision` is already typed.
    ensembleMetadata: decision,
  };
}

/**
 * Build the EnsembleDecisionRequest payload from a strategy context.
 *
 * Each strategy that wants ensemble coordination calls this with its
 * own context shape (turn number, transcript so far, participants,
 * etc.) and gets back the canonical request payload.
 */
export function buildEnsembleRequest<T extends Record<string, unknown>>(
  strategy: EnsembleDecisionRequest['strategy'],
  decisionType: EnsembleDecisionRequest['decisionType'],
  context: T,
  overrides?: EnsembleDecisionRequest['overrides'],
): EnsembleDecisionRequest {
  return {
    strategy,
    decisionType,
    context: narrowAs<Record<string, unknown>>(context),
    ...(overrides ? { overrides } : {}),
  };
}

// Re-export the response type so callers don't need two imports.
export type { EnsembleDecisionResponse };
