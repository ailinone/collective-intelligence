// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderHealthRegistry — granular health tracking by
 * `(providerId, modelId, accountId, endpointId)`.
 *
 * Phase 1: in-memory only. Designed to be backed later by Redis pub/sub (L2)
 * + Postgres persistence (L3) without changing the hot-path API.
 *
 * Granularity rule (CRITICAL — fixes bug observed in production):
 *
 *   A failure on `(aihubmix, gpt-4o-mini)` MUST NOT poison
 *   `(aihubmix, claude-haiku-4-5)`. The legacy hub keyed by
 *   `(executionProvider, modelFamily)` had this bug — `model_not_found` on
 *   one model would push the entire `aihubmix:openai` route to
 *   `temporarily_unavailable`, which then masked legitimate routes.
 *
 *   The new key is `buildHealthKey({providerId, modelId, ...})` — a string
 *   composite. Lookups via `lookup({providerId, modelId})` find an exact
 *   match first; if none, fall back to the provider-level entry
 *   `lookup({providerId})`. This lets a provider-level fatal state apply
 *   to all its models, while a model-level state stays scoped.
 */

import { logger } from '@/utils/logger';
import {
  buildHealthKey,
  type HealthKey,
  type ProviderErrorClass,
  type ProviderErrorClassification,
  type ProviderHealthRecord,
  type ProviderHealthState,
} from './types';
import {
  METRIC_NAMES,
  incrementCounter,
  setGauge,
} from './metrics';
import { getHealthSyncBus, type HealthSyncMessage } from './health-sync-bus';

const log = logger.child({ component: 'provider-health-registry' });

// ─── Default TTLs by state ─────────────────────────────────────────────────

const DEFAULT_TTL_MS = 60 * 1000;
const STATE_TTL_MS: Readonly<Record<ProviderHealthState, number>> = Object.freeze({
  unknown: DEFAULT_TTL_MS,
  probing: 5_000,
  healthy: 5 * 60 * 1000,
  degraded: 60 * 1000,
  rate_limited: 60 * 1000,
  insufficient_credit: 30 * 60 * 1000,
  auth_failed: 6 * 60 * 60 * 1000,
  endpoint_not_found: 60 * 60 * 1000,
  model_not_found: 24 * 60 * 60 * 1000,
  timeout_suspected: 30 * 1000,
  temporarily_disabled: 5 * 60 * 1000,
  permanently_disabled: 24 * 60 * 60 * 1000,
});

// ─── Registry ──────────────────────────────────────────────────────────────

class ProviderHealthRegistry {
  private records = new Map<string, ProviderHealthRecord>();

  /**
   * Look up a record by composite key. Falls back from
   * `(providerId, modelId)` to provider-level `(providerId)` if no exact
   * match exists. Returns undefined when neither is registered.
   */
  lookup(key: HealthKey): ProviderHealthRecord | undefined {
    if (key.modelId || key.accountId || key.endpointId) {
      const exact = this.records.get(buildHealthKey(key));
      if (exact) return exact;
      // Fallback to provider-level
      return this.records.get(buildHealthKey({ providerId: key.providerId }));
    }
    return this.records.get(buildHealthKey(key));
  }

  /**
   * Direct exact lookup (no fallback). Used by tests and diagnostics.
   */
  lookupExact(key: HealthKey): ProviderHealthRecord | undefined {
    return this.records.get(buildHealthKey(key));
  }

  /**
   * Apply a discovery probe outcome to the registry.
   */
  recordProbe(input: {
    key: HealthKey;
    state: ProviderHealthState;
    reason?: string;
    errorClass?: ProviderErrorClass;
    latencyMs?: number;
  }): ProviderHealthRecord {
    const now = Date.now();
    const ttlMs = STATE_TTL_MS[input.state] ?? DEFAULT_TTL_MS;
    const existing = this.records.get(buildHealthKey(input.key));

    const record: ProviderHealthRecord = {
      ...input.key,
      state: input.state,
      reason: input.reason,
      errorClass: input.errorClass,
      lastProbeAt: new Date(now).toISOString(),
      lastSuccessAt: input.state === 'healthy' ? new Date(now).toISOString() : existing?.lastSuccessAt,
      lastFailureAt: input.state !== 'healthy' && input.state !== 'probing'
        ? new Date(now).toISOString()
        : existing?.lastFailureAt,
      nextProbeAfter: new Date(now + ttlMs).toISOString(),
      ttlMs,
      consecutiveFailures: input.state === 'healthy' ? 0 : (existing?.consecutiveFailures ?? 0) + (input.state === 'probing' ? 0 : 1),
      consecutiveSuccesses: input.state === 'healthy' ? (existing?.consecutiveSuccesses ?? 0) + 1 : 0,
      p50LatencyMs: input.latencyMs !== undefined ? emaUpdate(existing?.p50LatencyMs, input.latencyMs, 0.2) : existing?.p50LatencyMs,
      p95LatencyMs: existing?.p95LatencyMs,
      p99LatencyMs: existing?.p99LatencyMs,
    };

    this.records.set(buildHealthKey(input.key), record);
    this.emitGauges(record);
    // Cross-instance broadcast (no-op if bus not connected)
    getHealthSyncBus().publish({
      kind: 'probe',
      key: input.key,
      state: input.state,
      reason: input.reason,
      errorClass: input.errorClass,
      latencyMs: input.latencyMs,
    });
    return record;
  }

  /**
   * Apply an execution outcome (post-HTTP attempt). Updates
   * `consecutiveFailures`/`consecutiveSuccesses`, `p50LatencyMs`, and
   * transitions state when thresholds are crossed.
   */
  recordExecution(input: {
    key: HealthKey;
    success: boolean;
    classification?: ProviderErrorClassification;
    latencyMs?: number;
  }): ProviderHealthRecord {
    const now = Date.now();
    const existing = this.records.get(buildHealthKey(input.key));

    if (input.success) {
      const consecutiveSuccesses = (existing?.consecutiveSuccesses ?? 0) + 1;
      // Recover from non-healthy states after 3 consecutive successes.
      const recovered = existing && existing.state !== 'healthy' && consecutiveSuccesses >= 3;
      const newState: ProviderHealthState = recovered || !existing || existing.state === 'healthy'
        ? 'healthy'
        : existing.state;
      const ttlMs = STATE_TTL_MS[newState] ?? DEFAULT_TTL_MS;
      const record: ProviderHealthRecord = {
        ...input.key,
        ...existing,
        state: newState,
        reason: recovered ? 'recovered_after_3_successes' : existing?.reason,
        errorClass: recovered ? undefined : existing?.errorClass,
        lastSuccessAt: new Date(now).toISOString(),
        nextProbeAfter: new Date(now + ttlMs).toISOString(),
        ttlMs,
        consecutiveFailures: 0,
        consecutiveSuccesses,
        p50LatencyMs: input.latencyMs !== undefined
          ? emaUpdate(existing?.p50LatencyMs, input.latencyMs, 0.1)
          : existing?.p50LatencyMs,
      };
      this.records.set(buildHealthKey(input.key), record);
      this.emitGauges(record);
      getHealthSyncBus().publish({
        kind: 'execution_success',
        key: input.key,
        state: newState,
        latencyMs: input.latencyMs,
      });
      return record;
    }

    // Failure path
    const cls = input.classification;
    const newState: ProviderHealthState = cls?.healthState ?? existing?.state ?? 'degraded';
    const ttlMs = cls?.cooldownMs ?? STATE_TTL_MS[newState] ?? DEFAULT_TTL_MS;
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
    const record: ProviderHealthRecord = {
      ...input.key,
      ...existing,
      state: newState,
      reason: cls?.message ?? existing?.reason,
      errorClass: cls?.errorClass ?? existing?.errorClass,
      lastFailureAt: new Date(now).toISOString(),
      nextProbeAfter: new Date(now + ttlMs).toISOString(),
      ttlMs,
      consecutiveFailures,
      consecutiveSuccesses: 0,
      p50LatencyMs: input.latencyMs !== undefined
        ? emaUpdate(existing?.p50LatencyMs, input.latencyMs, 0.1)
        : existing?.p50LatencyMs,
    };
    this.records.set(buildHealthKey(input.key), record);
    this.emitGauges(record);

    if (cls) {
      incrementCounter(METRIC_NAMES.PROVIDER_ERROR_CLASS_TOTAL, {
        providerId: input.key.providerId,
        errorClass: cls.errorClass,
      });
    }
    getHealthSyncBus().publish({
      kind: 'execution_failure',
      key: input.key,
      state: newState,
      errorClass: cls?.errorClass,
      reason: cls?.message,
      latencyMs: input.latencyMs,
      cooldownMs: cls?.cooldownMs,
    });
    return record;
  }

  /**
   * Apply an inbound delta from another instance (no re-publish).
   * Called by `health-sync-bus` when it receives a remote message.
   */
  applyRemoteDelta(msg: HealthSyncMessage): void {
    if (msg.kind === 'probe' || msg.kind === 'state_set') {
      // Mirror the probe locally without re-publishing.
      const ttlMs = STATE_TTL_MS[msg.state ?? 'unknown'] ?? DEFAULT_TTL_MS;
      const record: ProviderHealthRecord = {
        ...msg.key,
        state: msg.state ?? 'unknown',
        reason: msg.reason,
        errorClass: msg.errorClass,
        lastProbeAt: new Date(msg.ts).toISOString(),
        nextProbeAfter: new Date(msg.ts + ttlMs).toISOString(),
        ttlMs,
        consecutiveFailures: msg.state === 'healthy' ? 0 : 1,
        consecutiveSuccesses: msg.state === 'healthy' ? 1 : 0,
      };
      this.records.set(buildHealthKey(msg.key), record);
      this.emitGauges(record);
      return;
    }

    if (msg.kind === 'execution_success') {
      // Same logic as recordExecution success path, but skip the publish.
      const existing = this.records.get(buildHealthKey(msg.key));
      const consecutiveSuccesses = (existing?.consecutiveSuccesses ?? 0) + 1;
      const recovered = existing && existing.state !== 'healthy' && consecutiveSuccesses >= 3;
      const newState: ProviderHealthState = recovered || !existing || existing.state === 'healthy'
        ? 'healthy'
        : existing.state;
      const ttlMs = STATE_TTL_MS[newState] ?? DEFAULT_TTL_MS;
      const record: ProviderHealthRecord = {
        ...msg.key,
        ...existing,
        state: newState,
        lastSuccessAt: new Date(msg.ts).toISOString(),
        nextProbeAfter: new Date(msg.ts + ttlMs).toISOString(),
        ttlMs,
        consecutiveFailures: 0,
        consecutiveSuccesses,
      };
      this.records.set(buildHealthKey(msg.key), record);
      this.emitGauges(record);
      return;
    }

    if (msg.kind === 'execution_failure') {
      const existing = this.records.get(buildHealthKey(msg.key));
      const newState: ProviderHealthState = msg.state ?? existing?.state ?? 'degraded';
      const ttlMs = msg.cooldownMs ?? STATE_TTL_MS[newState] ?? DEFAULT_TTL_MS;
      const record: ProviderHealthRecord = {
        ...msg.key,
        ...existing,
        state: newState,
        reason: msg.reason ?? existing?.reason,
        errorClass: msg.errorClass ?? existing?.errorClass,
        lastFailureAt: new Date(msg.ts).toISOString(),
        nextProbeAfter: new Date(msg.ts + ttlMs).toISOString(),
        ttlMs,
        consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
        consecutiveSuccesses: 0,
      };
      this.records.set(buildHealthKey(msg.key), record);
      this.emitGauges(record);
    }
  }

  /**
   * Force a specific state (used by discovery service when confidence is low
   * and we want to mark the record without relying on the probe→execution
   * flow). Avoid in production paths — prefer `recordProbe`/`recordExecution`.
   */
  setState(key: HealthKey, state: ProviderHealthState, reason?: string): ProviderHealthRecord {
    return this.recordProbe({ key, state, reason });
  }

  /**
   * Iterate all records (snapshot copy — safe to mutate the original after).
   */
  snapshot(): readonly ProviderHealthRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * Number of records in registry.
   */
  size(): number {
    return this.records.size;
  }

  // ─── Test helpers ────────────────────────────────────────────────────

  resetForTesting(): void {
    this.records.clear();
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private emitGauges(record: ProviderHealthRecord): void {
    if (record.modelId) {
      setGauge(
        METRIC_NAMES.PROVIDER_MODEL_HEALTH_STATE,
        STATE_NUMERIC[record.state],
        { providerId: record.providerId, modelId: record.modelId, state: record.state },
      );
    } else {
      setGauge(
        METRIC_NAMES.PROVIDER_HEALTH_STATE,
        STATE_NUMERIC[record.state],
        { providerId: record.providerId, state: record.state },
      );
    }
  }
}

// ─── EMA helper ────────────────────────────────────────────────────────────

function emaUpdate(prev: number | undefined, sample: number, alpha: number): number {
  if (prev === undefined) return sample;
  return alpha * sample + (1 - alpha) * prev;
}

// ─── State to numeric (for gauge values) ───────────────────────────────────

const STATE_NUMERIC: Readonly<Record<ProviderHealthState, number>> = Object.freeze({
  healthy: 1,
  recovering: 0.7,
  degraded: 0.5,
  probing: 0.4,
  rate_limited: 0.3,
  timeout_suspected: 0.3,
  unknown: 0.2,
  insufficient_credit: 0.1,
  auth_failed: 0.0,
  endpoint_not_found: 0.0,
  model_not_found: 0.0,
  temporarily_disabled: 0.0,
  permanently_disabled: 0.0,
} as Record<ProviderHealthState, number>);

// ─── Singleton ────────────────────────────────────────────────────────────

let instance: ProviderHealthRegistry | null = null;

export function getProviderHealthRegistry(): ProviderHealthRegistry {
  if (!instance) {
    instance = new ProviderHealthRegistry();
    log.info('ProviderHealthRegistry initialized');
  }
  return instance;
}

export function resetProviderHealthRegistryForTesting(): void {
  instance = null;
}

/**
 * Wires the health sync bus to feed inbound remote deltas into this
 * registry. Call once at application bootstrap, after Redis is ready.
 *
 * Caller provides two Redis clients: one for SUBSCRIBE, one for PUBLISH.
 * They MUST be different physical connections (Redis subscribe-mode is
 * exclusive on its connection).
 */
export async function startProviderHealthSync(input: {
  publisher: import('ioredis').default;
  subscriber: import('ioredis').default;
}): Promise<void> {
  const { getHealthSyncBus } = await import('./health-sync-bus');
  const bus = getHealthSyncBus();
  const registry = getProviderHealthRegistry();
  await bus.connect({
    publisher: input.publisher,
    subscriber: input.subscriber,
    onMessage: (msg) => registry.applyRemoteDelta(msg),
  });
  log.info('Provider health sync bus active');
}

export type { ProviderHealthRegistry };
