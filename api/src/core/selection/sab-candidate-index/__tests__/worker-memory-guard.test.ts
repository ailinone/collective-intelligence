// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for the ADR-028 (Layer 3) rebuild-time RSS guard. Pure/hermetic
 * — `checkMemoryThreshold` takes the "current RSS" as a plain number
 * parameter rather than calling `process.memoryUsage()` itself, specifically
 * so it can be exercised with a SIMULATED value without needing a real
 * worker_threads Worker (worker.ts itself cannot be imported directly in a
 * normal test process — see that file's own module doc and
 * `worker-memory-guard.ts`'s doc for why this logic was extracted).
 */
import { describe, expect, it } from 'vitest';
import {
  checkMemoryThreshold,
  newRssPeakTracker,
  resolveMemoryAbortThresholdBytes,
  SabWorkerMemoryAbortError,
} from '../worker-memory-guard';

const MB = 1024 * 1024;

describe('resolveMemoryAbortThresholdBytes', () => {
  it('defaults to 3200 MB when unset', () => {
    expect(resolveMemoryAbortThresholdBytes({})).toBe(3200 * MB);
  });

  it('honors SAB_WORKER_MEMORY_ABORT_THRESHOLD_MB', () => {
    expect(resolveMemoryAbortThresholdBytes({ SAB_WORKER_MEMORY_ABORT_THRESHOLD_MB: '2000' })).toBe(2000 * MB);
  });

  it('falls back to the default for a non-numeric or non-positive override', () => {
    expect(resolveMemoryAbortThresholdBytes({ SAB_WORKER_MEMORY_ABORT_THRESHOLD_MB: 'nope' })).toBe(3200 * MB);
    expect(resolveMemoryAbortThresholdBytes({ SAB_WORKER_MEMORY_ABORT_THRESHOLD_MB: '-5' })).toBe(3200 * MB);
    expect(resolveMemoryAbortThresholdBytes({ SAB_WORKER_MEMORY_ABORT_THRESHOLD_MB: '0' })).toBe(3200 * MB);
  });
});

describe('checkMemoryThreshold', () => {
  it('does not throw and records the peak when RSS stays under the threshold', () => {
    const tracker = newRssPeakTracker(100 * MB);
    const thresholdBytes = 3200 * MB;
    expect(() => checkMemoryThreshold('pre-fetch', 100 * MB, thresholdBytes, tracker)).not.toThrow();
    expect(() => checkMemoryThreshold('post-fetch', 500 * MB, thresholdBytes, tracker)).not.toThrow();
    expect(tracker.peakBytes).toBe(500 * MB);
    // A later, lower reading must not lower the recorded peak.
    expect(() => checkMemoryThreshold('post-encode', 200 * MB, thresholdBytes, tracker)).not.toThrow();
    expect(tracker.peakBytes).toBe(500 * MB);
  });

  it('throws SabWorkerMemoryAbortError with checkpoint + threshold context once RSS crosses the threshold — simulating the abort, never a real OOM', () => {
    const tracker = newRssPeakTracker(100 * MB);
    const thresholdBytes = 3200 * MB;

    expect(() => checkMemoryThreshold('pre-fetch', 100 * MB, thresholdBytes, tracker)).not.toThrow();

    let thrown: unknown;
    try {
      // Simulated RSS spike (e.g. a growing catalog's paged Postgres fetch) —
      // no real memory is ever allocated by this test.
      checkMemoryThreshold('post-fetch', 3300 * MB, thresholdBytes, tracker);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SabWorkerMemoryAbortError);
    const message = (thrown as Error).message;
    expect(message).toContain('3300MB');
    expect(message).toContain('3200MB');
    expect(message).toContain('post-fetch');
    expect(message).toContain('SAB_WORKER_MEMORY_ABORT_THRESHOLD_MB');
    // The peak is still recorded even though this checkpoint aborted —
    // callers (worker.ts) report it on the rebuild-failed message regardless
    // of outcome.
    expect(tracker.peakBytes).toBe(3300 * MB);
  });

  it('aborting at any checkpoint stops the sequence — a caller must not proceed past a thrown checkpoint', () => {
    // Mirrors runRebuild()'s real usage: each checkpoint is called in a `try`
    // block and a throw exits before the NEXT checkpoint would ever run —
    // this test documents that `checkMemoryThreshold` itself has no
    // knowledge of "the rest of the rebuild" and relies entirely on the
    // caller's control flow (a plain `throw`) to stop early.
    const tracker = newRssPeakTracker(0);
    const thresholdBytes = 100 * MB;
    let secondCheckpointRan = false;
    expect(() => {
      checkMemoryThreshold('post-encode', 150 * MB, thresholdBytes, tracker);
      secondCheckpointRan = true;
    }).toThrow(SabWorkerMemoryAbortError);
    expect(secondCheckpointRan).toBe(false);
  });
});
