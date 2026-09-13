// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Usage Count Tracker (2026-09-07, bucket-fair selection fix, design §2b)
 *
 * Closes a real gap found while auditing catalog-visibility: `models.usage_count`
 * — the column `dynamic-model-selector.ts` sorts every candidate-retrieval query
 * by — is written NOWHERE in this codebase (confirmed by grep across `api/src`).
 * Every one of the catalog's 111k+ rows ties at 0, which is the root enabler of
 * the "physical/ctid order decides selection" failure mode this fix line closes.
 *
 * Hook point: `recordModelUsage(model.id, model.providerId)` is called from
 * `base-strategy.ts` right next to the existing
 * `getProviderOperabilityHub().recordRouteExecution(adapter.getName(), model.id, true)`
 * call — the one place a model execution is already confirmed to have
 * genuinely SUCCEEDED (not merely been selected). The equivalent FAILURE path
 * (`recordRouteExecution(..., false, ...)`) deliberately does NOT call this —
 * usage_count should track real successful usage, not selection attempts.
 *
 * Why NOT a synchronous per-request `UPDATE models SET usage_count =
 * usage_count + 1`: the public `Model` type this hook sees never carries the
 * row's `uid` PK through to strategies (only `id` + `providerId` — the
 * `@@unique([id, providerId])` compound), so any single-row update must key
 * off that compound. A synchronous per-request UPDATE on that compound key
 * would hot-row-contend on popular models under real concurrency (every
 * concurrent successful call to the same model fighting over the same row's
 * MVCC version) — exactly the class of problem this codebase's other
 * high-frequency trackers in this directory (ModelPerformanceTracker,
 * TtftTracker) already avoid via the same shape used here: sync in-memory
 * accumulation (zero I/O on the hot path) + a periodic batched flush.
 *
 * Each API replica keeps its own buffer and flushes independently; final
 * usage_count is the correct eventually-consistent SUM across replicas, on a
 * horizon consistent with every other freshness knob already in the selector
 * (60s/30min TTLs).
 */

import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';

const log = logger.child({ component: 'usage-count-tracker' });

const FLUSH_INTERVAL_MS = 60_000; // Same horizon as ModelPerformanceTracker's flush.
// Hard cap on the re-merge-after-failed-flush buffer so a sustained DB outage
// cannot grow this map unboundedly. Distinct (id, providerId) pairs in the
// catalog number in the low hundreds-of-thousands at most; this is generous
// headroom while still being a real bound.
const MAX_BUFFERED_KEYS = 20_000;
// One VALUES-list UPDATE per chunk, chunked to keep any single statement's
// parameter count bounded regardless of how many distinct models accumulate
// deltas between flushes (mirrors the `.slice(0, 20)` statement-size bound
// auto-learning-system.ts already applies to its own VALUES-list writer).
const FLUSH_CHUNK_SIZE = 500;

interface UsageDelta {
  id: string;
  providerId: string;
  count: number;
}

function keyFor(id: string, providerId: string): string {
  return `${providerId}:${id}`;
}

export class UsageCountTracker {
  private readonly deltas = new Map<string, UsageDelta>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(autoStart = true) {
    if (autoStart) this.startFlushTimer();
  }

  /**
   * Record one genuine successful execution of (id, providerId). Sync,
   * in-memory, zero I/O — safe to call from the hot execution path.
   */
  record(id: string, providerId: string): void {
    if (!id || !providerId) return;
    const key = keyFor(id, providerId);
    const existing = this.deltas.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    if (this.deltas.size >= MAX_BUFFERED_KEYS) {
      // Buffer is saturated (pathological: tens of thousands of distinct
      // models executed inside one flush interval, or flushing has been
      // failing for a long time). Drop rather than grow unbounded — a missed
      // usage-count increment is harmless (best-effort ranking signal), an
      // unbounded map is not.
      return;
    }
    this.deltas.set(key, { id, providerId, count: 1 });
  }

  private startFlushTimer(): void {
    if (typeof setInterval === 'undefined') return; // Not in a timer-capable environment
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        log.warn({ error: getErrorMessage(err) }, 'UsageCountTracker flush failed');
      });
    }, FLUSH_INTERVAL_MS);
    // Don't block process exit on this timer.
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Flush the current buffer as one (or a few, chunked) batched UPDATE(s).
   * Exposed (not private) so tests can drive a flush deterministically instead
   * of waiting on the timer.
   */
  async flush(): Promise<void> {
    if (this.deltas.size === 0) return;
    const batch = [...this.deltas.values()];
    this.deltas.clear();

    const chunks: UsageDelta[][] = [];
    for (let i = 0; i < batch.length; i += FLUSH_CHUNK_SIZE) {
      chunks.push(batch.slice(i, i + FLUSH_CHUNK_SIZE));
    }

    const failedChunks: UsageDelta[][] = [];
    for (const chunk of chunks) {
      try {
        const rows = chunk.map((d) => Prisma.sql`(${d.id}, ${d.providerId}, ${d.count})`);
        await prisma.$executeRaw(Prisma.sql`
          UPDATE models m
          SET usage_count = usage_count + v.delta::int
          FROM (VALUES ${Prisma.join(rows)}) AS v(id, provider_id, delta)
          WHERE m.id = v.id AND m.provider_id = v.provider_id;
        `);
      } catch (err) {
        log.warn(
          { error: getErrorMessage(err), chunkSize: chunk.length },
          'UsageCountTracker chunk flush failed — re-merging deltas for retry'
        );
        failedChunks.push(chunk);
      }
    }

    if (failedChunks.length > 0) {
      // Merge failed deltas back into the buffer (bounded) rather than drop
      // them — a transient DB blip should not lose real usage signal.
      for (const chunk of failedChunks) {
        for (const d of chunk) {
          const key = keyFor(d.id, d.providerId);
          const existing = this.deltas.get(key);
          if (existing) {
            existing.count += d.count;
          } else if (this.deltas.size < MAX_BUFFERED_KEYS) {
            this.deltas.set(key, d);
          }
        }
      }
      throw new Error(`UsageCountTracker: ${failedChunks.length}/${chunks.length} flush chunk(s) failed`);
    }

    log.debug({ flushed: batch.length }, 'UsageCountTracker flushed to DB');
  }

  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Test-only: current in-memory delta for one key, without a DB round-trip. */
  __getBufferedCountForTests(id: string, providerId: string): number {
    return this.deltas.get(keyFor(id, providerId))?.count ?? 0;
  }

  __clearForTests(): void {
    this.deltas.clear();
  }
}

let singleton: UsageCountTracker | null = null;

/** Process-wide singleton, matching the getter convention used across
 *  `core/selection/*` and `core/operability/*` trackers/hubs in this repo. */
export function getUsageCountTracker(): UsageCountTracker {
  if (!singleton) singleton = new UsageCountTracker();
  return singleton;
}

/**
 * Record one genuine successful execution of a model. Call this — and ONLY
 * this — from a confirmed-success path (see module docblock for the exact
 * hook point). Sync, non-throwing, safe on the hot path.
 */
export function recordModelUsage(id: string, providerId: string): void {
  getUsageCountTracker().record(id, providerId);
}

/** Test-only: replace the singleton with a fresh, non-auto-starting instance
 *  so tests can call `.flush()` deterministically without a live timer. */
export function __resetUsageCountTrackerForTests(): UsageCountTracker {
  if (singleton) singleton.dispose();
  singleton = new UsageCountTracker(false);
  return singleton;
}
