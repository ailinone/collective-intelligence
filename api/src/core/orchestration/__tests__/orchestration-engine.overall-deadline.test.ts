// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Overall per-request deadline for the NON-STREAMING execute() path
 * (2026-09-16, re-applied from the 2026-08-14 design).
 *
 * A request that got stuck inside strategy.execute() + recoverEmptyFinalResponse()
 * (or the feedback loop's iterations) previously had no combined time budget —
 * the theoretical worst case ran far past any legitimate latency with zero
 * response delivered to the client. executeStream() already has its own
 * whole-request ceiling (STREAM_REQUEST_DEADLINE_MS + AbortController); these
 * tests cover the shared `withOverallDeadline` primitive and the
 * `executeOverallDeadlineMs` config accessor that execute() wraps its
 * strategy-dispatch-plus-recovery work in.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  OrchestrationEngine,
  withOverallDeadline,
  executeOverallDeadlineMs,
} from '@/core/orchestration/orchestration-engine';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { BaseStrategy } from '@/core/orchestration/base-strategy';
import type { OrchestrationResult } from '@/types';

describe('withOverallDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the promise value when it settles before the deadline', async () => {
    const result = await withOverallDeadline(
      Promise.resolve('done'),
      5_000,
      () => 'timed-out'
    );

    expect(result).toBe('done');
  });

  it('calls onTimeout and resolves with its value when the promise never settles in time', async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise<string>(() => {});

    const pending = withOverallDeadline(neverResolves, 1_000, () => 'timed-out');
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe('timed-out');
  });

  it('does not wait the full deadline once the promise settles early', async () => {
    vi.useFakeTimers();
    const fast = new Promise<string>((resolve) => setTimeout(() => resolve('fast'), 10));

    const pending = withOverallDeadline(fast, 1_000, () => 'timed-out');
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toBe('fast');
  });

  it('resolves with onTimeout immediately when timeoutMs is already exhausted (<= 0)', async () => {
    const neverResolves = new Promise<string>(() => {});

    const result = await withOverallDeadline(neverResolves, 0, () => 'timed-out');

    expect(result).toBe('timed-out');
  });

  it('never produces an unhandled rejection when the underlying promise rejects after the deadline has already won', async () => {
    vi.useFakeTimers();
    let rejectLate!: (err: Error) => void;
    const rejectsLate = new Promise<string>((_, reject) => {
      rejectLate = reject;
    });

    const pending = withOverallDeadline(rejectsLate, 50, () => 'timed-out');
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe('timed-out');

    // The underlying promise finally rejects well after the deadline fired.
    // vitest's `dangerouslyIgnoreUnhandledErrors: false` config fails the run
    // on any unhandled rejection, so this only stays green if withOverallDeadline
    // attached a handler to the original promise.
    rejectLate(new Error('late provider failure'));
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe('executeOverallDeadlineMs', () => {
  const originalEnv = process.env.EXECUTE_REQUEST_DEADLINE_MS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EXECUTE_REQUEST_DEADLINE_MS;
    } else {
      process.env.EXECUTE_REQUEST_DEADLINE_MS = originalEnv;
    }
  });

  it('defaults to 180000ms when unset, mirroring STREAM_REQUEST_DEADLINE_MS', () => {
    delete process.env.EXECUTE_REQUEST_DEADLINE_MS;
    expect(executeOverallDeadlineMs()).toBe(180_000);
  });

  it('honors EXECUTE_REQUEST_DEADLINE_MS when set', () => {
    process.env.EXECUTE_REQUEST_DEADLINE_MS = '30000';
    expect(executeOverallDeadlineMs()).toBe(30_000);
  });
});

describe('buildDeadlineExceededResult', () => {
  // Only getProviderNames() is called during construction (constructor-time
  // logging); no strategy dispatch happens in this describe block, so a
  // minimal stub is enough — no need for the full mocked ProviderRegistry
  // the rest of this test suite's fixtures set up for actual strategy runs.
  const engine = new OrchestrationEngine({
    providerRegistry: { getProviderNames: () => [] } as unknown as ProviderRegistry,
  });

  function buildDeadlineExceededResult(strategy: BaseStrategy, timeoutMs: number): OrchestrationResult {
    return (
      engine as unknown as {
        buildDeadlineExceededResult: (s: BaseStrategy, ms: number) => OrchestrationResult;
      }
    ).buildDeadlineExceededResult(strategy, timeoutMs);
  }

  it('marks the result as overall_deadline_exceeded, distinct from a genuine strategy throw', () => {
    const strategy = engine.getStrategy('single');
    expect(strategy).toBeDefined();

    const result = buildDeadlineExceededResult(strategy!, 180_000);

    expect(result.metadata?.overall_deadline_exceeded).toBe(true);
    expect(result.metadata?.strategy_execution_error).toContain('180000ms exceeded');
    expect(result.qualityScore).toBe(0);
    expect(result.strategyUsed).toBe('single');
  });
});
