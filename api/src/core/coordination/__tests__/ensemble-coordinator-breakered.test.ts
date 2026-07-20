// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for callEnsembleCoordinatorBreakered.
 *
 * Validates the breaker contract:
 *   - Successful calls don't trip the breaker
 *   - 5 consecutive failures (timeouts/errors) open the breaker
 *   - When OPEN, subsequent calls return synthetic
 *     `{kind:'error', message:'circuit-open:...'}` without hitting fetch
 *   - 30s after open, breaker enters HALF_OPEN; 2 successes close
 *   - The discriminated union contract is preserved at every state
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callEnsembleCoordinatorBreakered,
  loadEnsembleClientConfig,
} from '../ensemble-coordinator-client';
import type {
  AggregatedEnsembleDecision,
  EnsembleClientConfig,
  EnsembleDecisionRequest,
} from '../ensemble-coordinator-types';

const FAKE_DECISION: AggregatedEnsembleDecision = {
  role: 'moderator',
  reason: 'task-type-match',
  scheduler: 'mock-cascade-24-tiered',
  confidence: 0.92,
  aggregationMethod: 'weighted_bayesian_majority',
  tierResults: [],
  voteDistribution: { moderator: 4 },
  totalVotes: 4,
  dissentCount: 0,
  tiersActivated: [1],
  finalTier: 1,
  shortCircuited: true,
};

const FAKE_REQUEST: EnsembleDecisionRequest = {
  strategy: 'debate',
  decisionType: 'moderator-selection',
  context: {},
};

const ENABLED_CONFIG: EnsembleClientConfig = {
  enabled: true,
  endpoint: 'http://test/v1/ensemble/decide',
  timeoutMs: 1000,
  shadowMode: true,
  fallbackOnError: true,
};

function mockSuccess(): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        decision: FAKE_DECISION,
        latencyBreakdown: { totalMs: 1, tierLatencies: [] },
        requestId: 't',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

function mockServerError(): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('upstream down', { status: 503 }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('callEnsembleCoordinatorBreakered', () => {
  it('returns disabled when config.enabled is false (no fetch, no breaker)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await callEnsembleCoordinatorBreakered(FAKE_REQUEST, {
      ...ENABLED_CONFIG,
      enabled: false,
    });

    expect(result.kind).toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns success when upstream returns 200', async () => {
    mockSuccess();
    const result = await callEnsembleCoordinatorBreakered(FAKE_REQUEST, ENABLED_CONFIG);

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.decision.role).toBe('moderator');
    }
  });

  it('returns error result on upstream 5xx (preserving discriminated union)', async () => {
    mockServerError();
    const result = await callEnsembleCoordinatorBreakered(FAKE_REQUEST, ENABLED_CONFIG);

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('HTTP 503');
      // Latency is preserved from the underlying call
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('opens after 5 consecutive failures and short-circuits subsequent calls', async () => {
    mockServerError();

    // Trip the breaker — 5 failures. (NOTE: this test assumes a fresh
    // breaker state. The breaker is module-scoped, so prior tests in
    // the same file that DON'T fail leave it CLOSED. The
    // 5-failure threshold is a hard contract from the breaker config.)
    for (let i = 0; i < 5; i++) {
      const r = await callEnsembleCoordinatorBreakered(FAKE_REQUEST, ENABLED_CONFIG);
      expect(r.kind).toBe('error');
    }

    // 6th call: breaker should be OPEN — fast-fail without hitting fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockClear();
    const result = await callEnsembleCoordinatorBreakered(FAKE_REQUEST, ENABLED_CONFIG);

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toMatch(/^circuit-open:/);
      // No fetch call for the OPEN state — fast fail
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

});

/**
 * Direct CircuitBreaker class tests — fresh instance per test means no
 * singleton/module-state interaction. This is the right scope for the
 * recovery path because we want to validate the state-machine math
 * (OPEN → HALF_OPEN → CLOSED on successThreshold), not the wrapper.
 */
describe('CircuitBreaker recovery state machine', () => {
  /**
   * Without this test, a bug that prevents the breaker from ever
   * closing (successes not counted in HALF_OPEN, lastStateChange not
   * updated, etc.) leaves the wrapped shadow path permanently fast-
   * failing even after coord-serving recovers. The "ratchet" failure
   * mode is insidious because the config still says "enabled" — every
   * call is a synthetic circuit-open error and operators only notice
   * via metrics weeks later.
   */
  it('OPEN → HALF_OPEN → CLOSED after cooldown + successThreshold successes', async () => {
    const { CircuitBreaker, CircuitBreakerOpenError } = await import('@/utils/circuit-breaker');

    const breaker = new CircuitBreaker({
      name: 'test-recovery',
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 100, // 100ms cooldown — keep test fast
      rollingWindowMs: 10_000,
    });

    // 1. Trip the breaker via 3 failures
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow(
        'boom',
      );
    }

    // 2. Confirm OPEN — next call rejects with CircuitBreakerOpenError
    //    BEFORE invoking fn (we use a sentinel to detect invocation)
    let invoked = false;
    await expect(
      breaker.execute(() => {
        invoked = true;
        return Promise.resolve('should-not-run');
      }),
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(invoked).toBe(false);

    // 3. Wait for the OPEN cooldown to elapse (real timer, 100ms)
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 4. First success: breaker transitions OPEN → HALF_OPEN, fn is
    //    invoked, success returned. Breaker stays HALF_OPEN until
    //    successThreshold reached.
    const r1 = await breaker.execute(() => Promise.resolve('ok-1'));
    expect(r1).toBe('ok-1');

    // 5. Second success: meets successThreshold, breaker → CLOSED.
    const r2 = await breaker.execute(() => Promise.resolve('ok-2'));
    expect(r2).toBe('ok-2');

    // 6. Confirm CLOSED — a single failure now is recorded but the
    //    breaker stays CLOSED (failureThreshold = 3 not yet met since
    //    older failures are outside the rolling window). The fn IS
    //    invoked (no longer fast-fail).
    let postRecoveryInvoked = false;
    await expect(
      breaker.execute(() => {
        postRecoveryInvoked = true;
        return Promise.reject(new Error('post-recovery'));
      }),
    ).rejects.toThrow('post-recovery');
    expect(postRecoveryInvoked).toBe(true);
  });

  it('HALF_OPEN failure re-opens the breaker immediately', async () => {
    const { CircuitBreaker, CircuitBreakerOpenError } = await import('@/utils/circuit-breaker');

    const breaker = new CircuitBreaker({
      name: 'test-half-open-fail',
      failureThreshold: 2,
      successThreshold: 2,
      timeout: 50,
      rollingWindowMs: 10_000,
    });

    // Trip
    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error('x')))).rejects.toThrow();
    }
    // Wait for OPEN cooldown
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Failure in HALF_OPEN → re-OPEN immediately
    await expect(breaker.execute(() => Promise.reject(new Error('half-open-fail')))).rejects.toThrow(
      'half-open-fail',
    );

    // Next call is OPEN-fast-failed even though we're still within the
    // first cooldown window of the original OPEN — because the
    // HALF_OPEN failure RESET the cooldown.
    await expect(breaker.execute(() => Promise.resolve('x'))).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    );
  });
});
