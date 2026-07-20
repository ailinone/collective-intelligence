// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for ShadowEnsembleSnapshot lifting + onShadowResult hook.
 *
 * Locks the contract that strategies depend on:
 *   - liftToSnapshot maps every EnsembleDecisionResult kind correctly
 *   - onShadowResult fires exactly once per runEnsembleInShadow call
 *   - Hook errors are caught (don't bubble back to strategies)
 *   - Disabled config ⇒ hook does NOT fire (returns null result)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  liftToSnapshot,
  runEnsembleInShadow,
  type ShadowEnsembleSnapshot,
} from '../ensemble-coordinator-shadow';
import type { EnsembleDecisionResult } from '../ensemble-coordinator-client';
import type {
  AggregatedEnsembleDecision,
  EnsembleDecisionRequest,
} from '../ensemble-coordinator-types';

// Reset fetch mock between tests so coverage stays clean.
beforeEach(() => {
  vi.restoreAllMocks();
});

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
  context: { requestId: 'test-rq' },
};

const FAKE_HEURISTIC = {
  role: 'moderator',
  scheduler: 'fixed-state-machine',
  reason: 'heuristic-default',
};

describe('liftToSnapshot', () => {
  it('lifts a success result into a complete snapshot', () => {
    const result: EnsembleDecisionResult = {
      kind: 'success',
      decision: FAKE_DECISION,
      latencyMs: 42,
    };

    const snapshot = liftToSnapshot(result, FAKE_HEURISTIC);

    expect(snapshot.kind).toBe('success');
    expect(snapshot.role).toBe('moderator');
    expect(snapshot.scheduler).toBe('mock-cascade-24-tiered');
    expect(snapshot.confidence).toBe(0.92);
    expect(snapshot.totalVotes).toBe(4);
    expect(snapshot.tiersActivated).toEqual([1]);
    expect(snapshot.shortCircuited).toBe(true);
    expect(snapshot.latencyMs).toBe(42);
    // Divergence is computed when heuristic is provided
    expect(snapshot.divergence).not.toBeNull();
    expect(snapshot.divergence?.sameRole).toBe(true);
  });

  it('lifts a disabled result with null divergence and zero latency', () => {
    const snapshot = liftToSnapshot({ kind: 'disabled' }, FAKE_HEURISTIC);

    expect(snapshot.kind).toBe('disabled');
    expect(snapshot.divergence).toBeNull();
    expect(snapshot.latencyMs).toBe(0);
    expect(snapshot.role).toBeUndefined();
  });

  it('lifts a timeout result preserving latency', () => {
    const snapshot = liftToSnapshot({ kind: 'timeout', latencyMs: 5000 }, FAKE_HEURISTIC);

    expect(snapshot.kind).toBe('timeout');
    expect(snapshot.latencyMs).toBe(5000);
    expect(snapshot.divergence).toBeNull();
  });

  it('lifts an error result with the message', () => {
    const snapshot = liftToSnapshot(
      { kind: 'error', message: 'connection refused', latencyMs: 12 },
      FAKE_HEURISTIC,
    );

    expect(snapshot.kind).toBe('error');
    expect(snapshot.errorMessage).toBe('connection refused');
    expect(snapshot.latencyMs).toBe(12);
  });

  it('returns null divergence when no heuristic is provided', () => {
    const result: EnsembleDecisionResult = {
      kind: 'success',
      decision: FAKE_DECISION,
      latencyMs: 1,
    };
    const snapshot = liftToSnapshot(result, undefined);
    expect(snapshot.divergence).toBeNull();
  });
});

describe('runEnsembleInShadow.onShadowResult', () => {
  it('does NOT invoke the hook when ensemble is disabled', async () => {
    const hook = vi.fn<(s: ShadowEnsembleSnapshot) => void>();

    const result = await runEnsembleInShadow(FAKE_REQUEST, {
      config: {
        enabled: false,
        endpoint: 'http://unused',
        timeoutMs: 1000,
        shadowMode: true,
        fallbackOnError: true,
      },
      onShadowResult: hook,
    });

    expect(result).toBeNull();
    expect(hook).not.toHaveBeenCalled();
  });

  it('invokes the hook with a success snapshot when fetch returns 200', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          decision: FAKE_DECISION,
          latencyBreakdown: { totalMs: 1, tierLatencies: [] },
          requestId: 'test-rq',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const hook = vi.fn<(s: ShadowEnsembleSnapshot) => void>();

    await runEnsembleInShadow(FAKE_REQUEST, {
      config: {
        enabled: true,
        endpoint: 'http://test/v1/ensemble/decide',
        timeoutMs: 1000,
        shadowMode: true,
        fallbackOnError: true,
      },
      heuristicDecisionForComparison: FAKE_HEURISTIC,
      onShadowResult: hook,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledOnce();
    const snapshot = hook.mock.calls[0][0];
    expect(snapshot.kind).toBe('success');
    expect(snapshot.role).toBe('moderator');
    expect(snapshot.divergence?.sameRole).toBe(true);
  });

  it('invokes the hook with a timeout snapshot on AbortError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    const hook = vi.fn<(s: ShadowEnsembleSnapshot) => void>();

    await runEnsembleInShadow(FAKE_REQUEST, {
      config: {
        enabled: true,
        endpoint: 'http://test/v1/ensemble/decide',
        timeoutMs: 50,
        shadowMode: true,
        fallbackOnError: true,
      },
      onShadowResult: hook,
    });

    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0][0].kind).toBe('timeout');
  });

  it('catches hook exceptions so strategies never see them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          decision: FAKE_DECISION,
          latencyBreakdown: { totalMs: 1, tierLatencies: [] },
          requestId: 'test-rq',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const hook = vi.fn<(s: ShadowEnsembleSnapshot) => void>().mockImplementation(() => {
      throw new Error('strategy bug');
    });

    // Must NOT throw — runEnsembleInShadow is part of the request path.
    await expect(
      runEnsembleInShadow(FAKE_REQUEST, {
        config: {
          enabled: true,
          endpoint: 'http://test/v1/ensemble/decide',
          timeoutMs: 1000,
          shadowMode: true,
          fallbackOnError: true,
        },
        onShadowResult: hook,
      }),
    ).resolves.not.toThrow();

    expect(hook).toHaveBeenCalledOnce();
  });
});
