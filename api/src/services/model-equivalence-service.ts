// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model Equivalence Service
 *
 * Part of Full SOTA Provider Resolution (L2: cross-provider model identity).
 *
 * Groups the active catalog by model identity: "claude-sonnet-4-6" on
 * anthropic, "anthropic/claude-sonnet-4.6" on openrouter and
 * "deepinfra/anthropic/claude-sonnet-4-6" are one group, which is what the
 * cross-provider fallbacks need. A group holds exactly the rows whose
 * equivalence key (model-equivalence-clustering.ts) equals its key: the same
 * model in any spelling (vendor or route prefix, the date stamp of its only
 * snapshot, -latest, case, separators), never another version, size, variant,
 * snapshot, repository owner or another vendor's product of the same name.
 *
 * The only consumer is model-catalog-service.getAllEntriesForModel(), called
 * by provider-registry.findModel(), the base-strategy cross-provider retry and
 * the single-model balance-error retry. They look up any model id (selected or
 * pinned), so the index covers every active model. It is per-process state.
 *
 * Lookup contract (getEquivalentModels): the group of the requested id's key,
 * or null. An id the index does not know (another version, a typo, a repo of
 * another owner) gets null; there is no nearest-match fallback.
 *
 * Rebuild lifecycle (2026-09-24 fix): the index is rebuilt in the BACKGROUND
 * via requestRebuild() / scheduleModelEquivalenceIndexRebuild(), never inside
 * a discovery round or a scheduled job. One build per process at a time
 * (single-flight; a request during a build queues exactly one follow-up), a
 * wall-clock budget (MODEL_EQUIVALENCE_BUILD_BUDGET_MS, default 10 min), and an
 * abort on graceful shutdown. A build publishes its result atomically at the
 * end (groups and key context in one reference), so lookups never see a
 * half-built index; a stopped or failed build keeps the previous index.
 * Triggers: the end of a discovery round in this process, and a lookup that
 * finds the index missing or older than MODEL_EQUIVALENCE_MAX_AGE_MS (default
 * 1 h), after a boot grace period (MODEL_EQUIVALENCE_LAZY_REBUILD_GRACE_MS,
 * default 10 min; lookup triggers off with MODEL_EQUIVALENCE_LAZY_REBUILD=false).
 * Until the first build a lookup returns null and getAllEntriesForModel() uses
 * its exact-spelling fallback.
 */

import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { SourceType } from '@/types/model-metadata.schema';
import { serializeError } from '@/utils/type-guards';
import {
  EquivalenceBuildStoppedError,
  buildEquivalenceIndex,
  equivalenceKey,
  resolveEquivalenceKey,
  type EquivalenceGroup,
  type EquivalenceIndex,
  type EquivalenceKeyContext,
  type EquivalenceSourceRow,
} from '@/services/model-equivalence-clustering';

export type {
  EquivalenceGroup,
  EquivalenceKeyContext,
} from '@/services/model-equivalence-clustering';
export { EquivalenceBuildStoppedError } from '@/services/model-equivalence-clustering';

const log = logger.child({ component: 'model-equivalence' });

// ─── Configuration ─────────────────────────────────────────────────────────

const DEFAULT_BUILD_BUDGET_MS = 10 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;
// Long enough for a boot discovery round (2-5 min in production) to request
// the first build itself, and to stay out of the rollout connection storm.
const DEFAULT_LAZY_REBUILD_GRACE_MS = 10 * 60 * 1000;
const MAX_BUILD_SLICE_MS = 50;
// The grace counts from module load (process boot in production: index.ts
// loads the discovery runner, which imports this module, at startup).
// Monotonic clock, so it is immune to wall-clock changes.
const MODULE_LOADED_AT = performance.now();

const defaultNow = (): number => performance.now();

function readPositiveMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeMs(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Wall-clock budget of one build (DB read + grouping). */
export function resolveEquivalenceBuildBudgetMs(): number {
  return readPositiveMs('MODEL_EQUIVALENCE_BUILD_BUDGET_MS', DEFAULT_BUILD_BUDGET_MS);
}

/**
 * Age after which a lookup triggers a background rebuild. Also the minimum
 * spacing between lookup-triggered attempts, so a failing build is retried at
 * most once per window.
 */
export function resolveEquivalenceMaxAgeMs(): number {
  return readPositiveMs('MODEL_EQUIVALENCE_MAX_AGE_MS', DEFAULT_MAX_AGE_MS);
}

/**
 * Time after which a background build yields to the event loop at its next
 * checkpoint (every 1,024 items), in ms: MODEL_EQUIVALENCE_BUILD_SLICE_MS, 0 to
 * MAX_BUILD_SLICE_MS (0 yields at every checkpoint). Unset or out of range:
 * the grouping default (8 ms). Capped because the abort signal is only seen at
 * a yield: a slice longer than the build would turn it into one blocking run.
 */
export function resolveEquivalenceBuildSliceMs(): number | undefined {
  const sliceMs = readNonNegativeMs('MODEL_EQUIVALENCE_BUILD_SLICE_MS');
  return sliceMs !== undefined && sliceMs <= MAX_BUILD_SLICE_MS ? sliceMs : undefined;
}

/** No lookup-triggered build during the first minutes after boot (rollout storm). */
function resolveLazyRebuildGraceMs(): number {
  return (
    readNonNegativeMs('MODEL_EQUIVALENCE_LAZY_REBUILD_GRACE_MS') ?? DEFAULT_LAZY_REBUILD_GRACE_MS
  );
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface BuildIndexOptions {
  /** Stops the build (DB read or grouping) promptly. */
  signal?: AbortSignal;
  /** Wall-clock budget for this build; no budget when omitted. */
  budgetMs?: number;
  /** Time after which the grouping yields at its next checkpoint (see the clustering module). */
  sliceMs?: number;
  /** Monotonic clock in ms for the budget; performance.now() when omitted (tests). */
  now?: () => number;
}

export interface BuildIndexResult {
  groups: number;
  models: number;
  durationMs: number;
}

interface SourceRowRecord {
  uid: string;
  modelId: string;
  providerId: string;
  providerName: string | null;
  sourceType: string | null;
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let instance: ModelEquivalenceService | null = null;
let shutdownRequested = false;

export function getModelEquivalenceService(): ModelEquivalenceService {
  if (!instance) {
    instance = new ModelEquivalenceService();
  }
  return instance;
}

/**
 * Fire-and-forget rebuild of this process's index (see the lifecycle notes at
 * the top). Returns immediately; never throws.
 */
export function scheduleModelEquivalenceIndexRebuild(reason: string): void {
  try {
    getModelEquivalenceService().requestRebuild(reason);
  } catch (err) {
    log.warn(
      { reason, err: serializeError(err) },
      'Could not schedule the model equivalence rebuild'
    );
  }
}

/**
 * Graceful shutdown: aborts an in-progress build (it stops at its next yield,
 * within a few ms) and refuses new ones for the rest of the process.
 */
export function shutdownModelEquivalenceIndex(): void {
  shutdownRequested = true;
  instance?.abortRebuild('shutdown');
}

/** Test hook: forget the singleton and the shutdown latch. */
export function resetModelEquivalenceServiceForTests(): void {
  instance?.abortRebuild('reset');
  instance = null;
  shutdownRequested = false;
}

function abortReason(signal: AbortSignal): EquivalenceBuildStoppedError {
  const reason: unknown = signal.reason;
  return reason instanceof EquivalenceBuildStoppedError
    ? reason
    : new EquivalenceBuildStoppedError('aborted');
}

/** Resolves/rejects with `promise`, or rejects as soon as the build must stop. */
function untilStopped<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
  now: () => number
): Promise<T> {
  if (!signal && deadlineAt === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer =
      deadlineAt !== undefined
        ? setTimeout(
            () => {
              cleanup();
              reject(new EquivalenceBuildStoppedError('deadline'));
            },
            Math.max(0, deadlineAt - now())
          )
        : undefined;
    timer?.unref?.();
    const onAbort = (): void => {
      cleanup();
      reject(signal ? abortReason(signal) : new EquivalenceBuildStoppedError('aborted'));
    };
    function cleanup(): void {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err: unknown) => {
        cleanup();
        reject(err);
      }
    );
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── Service ───────────────────────────────────────────────────────────────

export class ModelEquivalenceService {
  /** The published index: groups and the key context of ONE build, swapped as a unit. */
  private index: EquivalenceIndex | null = null;
  private lastBuildAt: Date | null = null;

  private rebuildInFlight: Promise<void> | null = null;
  private rebuildController: AbortController | null = null;
  private queuedRebuildReason: string | null = null;
  private lastRebuildRequestedAt: number | null = null;

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Build the full equivalence index from all active models in DB and publish
   * it atomically. Awaitable for callers that want the result (tests, admin);
   * production paths use requestRebuild(), which never blocks its caller.
   * Rejects with EquivalenceBuildStoppedError when aborted or over budget, in
   * which case the previous index stays in place.
   */
  async buildIndex(options: BuildIndexOptions = {}): Promise<BuildIndexResult> {
    const start = Date.now();
    const now = options.now ?? defaultNow;
    const deadlineAt = options.budgetMs !== undefined ? now() + options.budgetMs : undefined;
    if (options.signal?.aborted) throw abortReason(options.signal);

    const rows = await untilStopped(this.loadSourceRows(), options.signal, deadlineAt, now);
    const index = await buildEquivalenceIndex(rows, {
      signal: options.signal,
      deadlineAt,
      sliceMs: options.sliceMs,
      now,
    });

    // Atomic publish: one reference, so a lookup always sees the groups and
    // the key context (provider ids, publishers) of the same build.
    this.index = index;
    this.lastBuildAt = new Date();
    const durationMs = Date.now() - start;

    log.info(
      {
        groups: index.groups.size,
        models: index.models,
        durationMs,
        distinctIds: index.stats.distinctIds,
        providers: index.stats.providers,
        publishers: index.stats.publishers,
        multiSnapshotNames: index.stats.multiSnapshotNames,
        yields: index.stats.yields,
      },
      'Model equivalence index built'
    );

    return { groups: index.groups.size, models: index.models, durationMs };
  }

  /**
   * Start a background rebuild unless one is running (then queue exactly one
   * follow-up, because the running build may have read the catalog before the
   * change that triggered this request). Returns immediately; never throws.
   */
  requestRebuild(reason: string): void {
    if (shutdownRequested) return;
    this.lastRebuildRequestedAt = Date.now();
    if (this.rebuildInFlight) {
      this.queuedRebuildReason = reason;
      return;
    }
    this.startRebuild(reason);
  }

  /** Abort the in-progress build (if any) and drop a queued follow-up. */
  abortRebuild(reason: string): void {
    this.queuedRebuildReason = null;
    this.rebuildController?.abort(new EquivalenceBuildStoppedError('aborted'));
    if (this.rebuildInFlight) log.info({ reason }, 'Model equivalence rebuild abort requested');
  }

  /** Resolves when no background build is running (used by tests). */
  async whenIdle(): Promise<void> {
    while (this.rebuildInFlight) {
      await this.rebuildInFlight;
    }
  }

  isRebuilding(): boolean {
    return this.rebuildInFlight !== null;
  }

  /**
   * The group of `modelId`'s equivalence key: the requested model on every
   * provider that lists it, native_api first, then cloud_hub, router,
   * aggregator. Null when no index is published yet or the index has no row
   * with that key (see the lookup contract at the top).
   */
  getEquivalentModels(modelId: string): EquivalenceGroup | null {
    this.maybeRebuildOnLookup();
    const index = this.index;
    if (!index) return null;
    const key = resolveEquivalenceKey(index, modelId);
    const group = key === null ? undefined : index.groups.get(key);
    if (!group) return null;
    // Members are sorted once at build time; hand out a copy.
    return {
      groupId: group.groupId,
      canonicalName: group.canonicalName,
      members: [...group.members],
    };
  }

  /** The equivalence key of `modelId` under the published index, or null before the first build. */
  equivalenceKeyOf(modelId: string): string | null {
    const index = this.index;
    if (!index) return null;
    return index.modelToKey.get(modelId) ?? equivalenceKey(modelId, index.context);
  }

  /** The key context of the published index, or null before the first build. */
  getKeyContext(): EquivalenceKeyContext | null {
    return this.index?.context ?? null;
  }

  /**
   * Identity guard (defense in depth) for the callers of getEquivalentModels(),
   * which all use a group as "this same model on other providers": the members
   * whose key equals the requested id's key. By construction that is every
   * member of the group getEquivalentModels() returned.
   */
  sameModelMembers(modelId: string, group: EquivalenceGroup): EquivalenceGroup['members'] {
    const key = this.equivalenceKeyOf(modelId);
    if (key === null) return [];
    return group.members.filter((member) => this.equivalenceKeyOf(member.modelId) === key);
  }

  /**
   * Get index statistics for monitoring.
   */
  getStats(): { groups: number; models: number; lastBuildAt: Date | null; rebuilding: boolean } {
    return {
      groups: this.index?.groups.size ?? 0,
      models: this.index?.models ?? 0,
      lastBuildAt: this.lastBuildAt,
      rebuilding: this.rebuildInFlight !== null,
    };
  }

  // ─── Private Helpers ───────────────────────────────────────────────────

  private startRebuild(reason: string): void {
    const controller = new AbortController();
    const budgetMs = resolveEquivalenceBuildBudgetMs();
    const sliceMs = resolveEquivalenceBuildSliceMs();
    this.rebuildController = controller;
    this.rebuildInFlight = (async () => {
      try {
        const result = await this.buildIndex({ signal: controller.signal, budgetMs, sliceMs });
        log.info({ reason, ...result }, 'Model equivalence index rebuilt in the background');
      } catch (err) {
        if (err instanceof EquivalenceBuildStoppedError) {
          log.warn(
            { reason, stop: err.reason, budgetMs, keptPreviousIndex: this.lastBuildAt !== null },
            'Model equivalence rebuild stopped before finishing; previous index kept'
          );
        } else {
          log.warn(
            { reason, err: serializeError(err) },
            'Model equivalence rebuild failed (non-critical); previous index kept'
          );
        }
      } finally {
        this.rebuildInFlight = null;
        this.rebuildController = null;
        const queued = this.queuedRebuildReason;
        this.queuedRebuildReason = null;
        if (queued && !shutdownRequested) this.startRebuild(queued);
      }
    })();
  }

  /**
   * Lookup-triggered rebuild: keeps the index present and fresh in processes
   * that consume it but do not run discovery rounds themselves.
   */
  private maybeRebuildOnLookup(): void {
    if (shutdownRequested || this.rebuildInFlight) return;
    if (process.env.MODEL_EQUIVALENCE_LAZY_REBUILD === 'false') return;
    if (performance.now() - MODULE_LOADED_AT < resolveLazyRebuildGraceMs()) return;
    const now = Date.now();
    const maxAgeMs = resolveEquivalenceMaxAgeMs();
    if (this.lastBuildAt && now - this.lastBuildAt.getTime() < maxAgeMs) return;
    if (this.lastRebuildRequestedAt !== null && now - this.lastRebuildRequestedAt < maxAgeMs) {
      return;
    }
    this.requestRebuild(this.lastBuildAt ? 'lookup-stale-index' : 'lookup-no-index');
  }

  /**
   * One narrow read of the active catalog: only the columns the index uses.
   * The previous findMany selected the whole `metadata` JSON of every row
   * (~112 MB stored for 118k rows in production) and zod-parsed it in the
   * event loop just to read `sourceType`.
   */
  private async loadSourceRows(): Promise<EquivalenceSourceRow[]> {
    const records = await prisma.$queryRaw<SourceRowRecord[]>`
      SELECT m.uid,
             m.id AS "modelId",
             m.provider_id AS "providerId",
             p.name AS "providerName",
             m.metadata->>'sourceType' AS "sourceType"
        FROM models m
        LEFT JOIN providers p ON p.id = m.provider_id
       WHERE m.status = 'active'`;
    return records.map((r) => {
      const sourceType = SourceType.safeParse(r.sourceType);
      return {
        uid: r.uid,
        modelId: r.modelId,
        providerId: r.providerId,
        provider: r.providerName ?? r.providerId,
        sourceType: sourceType.success ? sourceType.data : 'unknown',
      };
    });
  }
}
