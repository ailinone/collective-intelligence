// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Bounded-concurrency helpers (Tiered Capability Fingerprint sweep, 2026-09).
 *
 * Two composable primitives used to pace the catalog-wide capability sweep
 * (`jobs/capability-fingerprint-job.ts`) across ~95 real, dynamically-queried
 * provider lanes without either (a) going fully serial — provider-balance-
 * probe-job.ts's one-adapter-at-a-time pattern, fine for ~60 cheap balance
 * checks, would take hours against 37k+ capability probes — or (b) firing
 * every candidate at once, which would burst far past any single provider's
 * rate limit (one lane alone, featherless-ai, carries ~22k of the ~37.6k
 * curated rows per the 2026-09-07 bucket-fairness audit in
 * `dynamic-model-selector.ts`).
 *
 * `runWithBoundedConcurrency` caps TOTAL in-flight work across the whole
 * sweep. `PerKeyLimiter` additionally caps in-flight work PER KEY (provider
 * lane) and can pace consecutive same-key work with a delay+jitter — the
 * same idea `provider-balance-probe-job.ts` uses between sequential probes,
 * applied per-lane instead of globally so lanes still run concurrently with
 * each other.
 *
 * Both are generic and have no capability/job-specific knowledge — this
 * module is a pure scheduling primitive, unit-tested in isolation.
 */

/**
 * A proper discriminated union (not `value`/`reason` both-optional on one
 * shape) so `result.status === 'fulfilled'` narrows `result.value` to `R`
 * without a non-null assertion at every call site.
 */
export type BoundedConcurrencyResult<T, R> =
  | { readonly item: T; readonly index: number; readonly status: 'fulfilled'; readonly value: R }
  | { readonly item: T; readonly index: number; readonly status: 'rejected'; readonly reason: unknown };

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once.
 * Never throws: a worker rejection is captured as a `'rejected'` result
 * entry (Promise.allSettled shape) so one bad item cannot abort the batch —
 * the caller decides what a rejection means (skip, log, count against a
 * budget, etc.).
 */
export async function runWithBoundedConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<Array<BoundedConcurrencyResult<T, R>>> {
  // Explicit generic on the constructor call selects the `new <T>(length):
  // T[]` overload instead of the untyped `new (length): any[]` one — the
  // latter is what `@typescript-eslint/no-unsafe-assignment` flags when the
  // result is assigned to a precisely-typed variable.
  const results = new Array<BoundedConcurrencyResult<T, R>>(items.length);
  if (items.length === 0) return results;

  const effectiveConcurrency = Math.max(1, Math.floor(concurrency) || 1);
  let nextIndex = 0;

  const runOne = async (): Promise<void> => {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      const item = items[i];
      try {
        const value = await worker(item, i);
        results[i] = { item, index: i, status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { item, index: i, status: 'rejected', reason };
      }
    }
  };

  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(effectiveConcurrency, items.length); i++) {
    runners.push(runOne());
  }
  await Promise.all(runners);
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PerKeyLimiterOptions {
  /** Max concurrent tasks allowed for the SAME key at once. */
  readonly maxPerKey: number;
  /** Delay applied after a task for a key finishes, before the NEXT queued
   *  task for that SAME key is allowed to start. 0 disables pacing. */
  readonly interTaskDelayMs?: number;
  /** Upper bound of additional random jitter added to `interTaskDelayMs`. */
  readonly interTaskJitterMs?: number;
}

/**
 * Per-key concurrency limiter: at most `maxPerKey` tasks run for a given key
 * at once, with an optional delay+jitter between successive tasks on the
 * SAME key. Different keys are fully independent — this is what lets the
 * fingerprint sweep run every provider lane concurrently while still being
 * gentle to any one provider's rate limiter.
 *
 * Implementation is a small per-key FIFO queue plus an in-flight counter;
 * no external dependency, mirroring this codebase's existing preference
 * (see `discovery-service.ts`'s `runWithConcurrency`) for a hand-rolled
 * semaphore over a pool library.
 */
export class PerKeyLimiter {
  private readonly inFlight = new Map<string, number>();
  private readonly queues = new Map<string, Array<() => void>>();

  constructor(private readonly opts: PerKeyLimiterOptions) {}

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(key);
    try {
      return await task();
    } finally {
      await this.release(key);
    }
  }

  private acquire(key: string): Promise<void> {
    const cap = Math.max(1, Math.floor(this.opts.maxPerKey) || 1);
    const current = this.inFlight.get(key) ?? 0;
    if (current < cap) {
      this.inFlight.set(key, current + 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const queue = this.queues.get(key) ?? [];
      queue.push(resolve);
      this.queues.set(key, queue);
    });
  }

  private async release(key: string): Promise<void> {
    const delay = this.opts.interTaskDelayMs ?? 0;
    const jitter = this.opts.interTaskJitterMs ?? 0;
    if (delay > 0 || jitter > 0) {
      await sleep(delay + Math.floor(Math.random() * Math.max(0, jitter)));
    }

    const queue = this.queues.get(key);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      // Slot stays "occupied" (count unchanged) — ownership transfers
      // directly to the next queued waiter.
      next();
      return;
    }

    const current = this.inFlight.get(key) ?? 1;
    if (current <= 1) {
      this.inFlight.delete(key);
    } else {
      this.inFlight.set(key, current - 1);
    }
  }

  /** Test/metrics helper: current in-flight count for a key. */
  getInFlightCount(key: string): number {
    return this.inFlight.get(key) ?? 0;
  }
}
