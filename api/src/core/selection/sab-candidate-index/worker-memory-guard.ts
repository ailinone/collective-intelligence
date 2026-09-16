// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Rebuild-time RSS instrumentation and fail-closed abort guard (ADR-028,
 * Layer 3 — operational safety net for the 2026-09-16 Canary 3 OOM).
 *
 * Deliberately a standalone, dependency-free module (no `node:worker_threads`
 * import, no `process.memoryUsage()` call baked into the checked function
 * itself) so it can be unit-tested with a SIMULATED RSS value without
 * spawning a real `worker_threads` Worker — `worker.ts` cannot be imported
 * directly in a normal test process (it dereferences `workerData` at module
 * load, which is `null` outside a real worker thread), so every other
 * worker.ts behavior this codebase unit-tests without a real worker (see
 * `postgres-paged-fetch.ts`, `worker-database-url.ts`) follows the same
 * "extract the pure logic" pattern.
 *
 * Philosophy: same fail-closed posture `SabEncodeCapacityError` already
 * uses (`encode.ts`) — abort the IN-PROGRESS rebuild loudly, never let it
 * complete and publish a generation the process might not have the memory
 * to keep serving, and let `worker.ts`'s existing `runRebuild()` catch
 * block route this into `rebuild-failed{reason="memory"}`, keeping the
 * last-good generation active exactly like every other rebuild failure
 * this module already handles (capacity, fetch).
 */

/** Thrown when the worker's own RSS crosses `resolveMemoryAbortThresholdBytes()`
 *  at one of `runRebuild()`'s checkpoints. Caught by `worker.ts`'s
 *  `runRebuild()` catch block exactly like `SabEncodeCapacityError` — never
 *  allowed to reach `parentPort` as an uncaught exception, never allowed to
 *  crash the worker thread itself (a real crash would at least respawn
 *  cleanly per the existing `worker.on('error'/'exit')` handling in
 *  manager.ts, but a graceful abort is strictly better: no lost in-flight
 *  work, no respawn delay, just "try again next cycle"). */
export class SabWorkerMemoryAbortError extends Error {}

/**
 * A container's cgroup memory limit is the thing that actually matters (the
 * kernel OOM-killer acts on it), not any Node/V8 heap flag — RSS is the
 * metric that tracks the cgroup limit most directly (`process.memoryUsage().rss`,
 * not `heapUsed`, which only covers the V8 heap and misses the
 * SharedArrayBuffer pages, native Buffer allocations from the pg driver, and
 * every other off-heap allocation this worker makes). Default 3200 MB: a
 * real production `ci_api` container's hard limit is 4096 MB
 * (`docker/docker-compose.production.yml`); 3200 leaves ~800 MB (~19.5%) of
 * margin for the main thread's own usage and whatever the worker's last
 * measurement missed between checkpoints, matching the same
 * generous-but-not-reckless spirit as `resolveWorkerResourceLimits()`'s own
 * 1536 MB `maxOldGenerationSizeMb` choice in manager.ts (deliberately well
 * under the container ceiling so a runaway worker fails FAST via this guard
 * rather than slowly starving the main thread of the container's shared
 * budget first).
 */
export function resolveMemoryAbortThresholdBytes(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.SAB_WORKER_MEMORY_ABORT_THRESHOLD_MB;
  const parsed = raw ? Number(raw) : NaN;
  const mb = Number.isFinite(parsed) && parsed > 0 ? parsed : 3200;
  return mb * 1024 * 1024;
}

/** Mutable accumulator threaded through every checkpoint in one rebuild
 *  attempt so the worker can report the real peak RSS observed (not just
 *  the value at the moment of failure) — see `runRebuild()`'s
 *  `{ type: 'rebuilt' | 'rebuild-failed', peakRssBytes }` field. */
export interface RssPeakTracker {
  peakBytes: number;
}

export function newRssPeakTracker(initialRssBytes: number): RssPeakTracker {
  return { peakBytes: initialRssBytes };
}

/**
 * Records `currentRssBytes` into `tracker` and throws
 * `SabWorkerMemoryAbortError` if it has crossed `thresholdBytes`. Pure and
 * synchronous — `currentRssBytes` is passed in (normally
 * `process.memoryUsage().rss` at the call site in worker.ts) rather than
 * read internally, specifically so this function is testable with a
 * simulated value.
 */
export function checkMemoryThreshold(
  checkpoint: string,
  currentRssBytes: number,
  thresholdBytes: number,
  tracker: RssPeakTracker
): void {
  if (currentRssBytes > tracker.peakBytes) tracker.peakBytes = currentRssBytes;
  if (currentRssBytes > thresholdBytes) {
    const mb = (n: number): string => (n / (1024 * 1024)).toFixed(0);
    throw new SabWorkerMemoryAbortError(
      `worker RSS ${mb(currentRssBytes)}MB exceeded the abort threshold ${mb(thresholdBytes)}MB ` +
        `at checkpoint "${checkpoint}" (SAB_WORKER_MEMORY_ABORT_THRESHOLD_MB) — aborting this rebuild ` +
        `before publishing, keeping the last-good generation`
    );
  }
}
