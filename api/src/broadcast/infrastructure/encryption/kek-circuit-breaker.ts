// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Circuit-breaker-wrapped KEK provider.
 *
 * Why (Fase 3.2):
 *   On a KMS outage, every destination config decrypt hits the remote KEK and
 *   pays the full timeout before failing. Hundreds of deliveries per minute
 *   turn into hundreds of 5-30s timeouts, blocking poller workers and filling
 *   the DLQ with transient-but-retryable failures. The breaker:
 *     1. Counts consecutive unwrap failures inside a rolling window.
 *     2. After `failureThreshold` failures, OPENS → subsequent unwrap calls
 *        fail FAST with `KekUnwrapBreakerOpenError` (no KMS round-trip).
 *     3. After `cooldownMs`, moves to HALF_OPEN → one probe is allowed.
 *        Success → CLOSED. Failure → OPEN again with exponential backoff.
 *
 * Callers:
 *   The delivery executor catches the breaker-open error separately from the
 *   generic decrypt failure and classifies it as `retryable` with errorClass
 *   `kek_unavailable`. The envelope stays in the outbox and is redelivered
 *   once the breaker recovers — no DLQ pollution from transient KMS blips.
 *
 * Metric coverage (cardinality-bounded):
 *   ailin_broadcast_kek_unwraps_total{result="ok|failed|fast_failed"}
 *   ailin_broadcast_kek_unwrap_latency_seconds  (histogram, un-labelled)
 *   ailin_broadcast_kek_circuit_state           (gauge: 0=closed, 1=half-open, 2=open)
 *
 * The wrapper forwards `wrap()` unchanged — wrap failures are rare (only on
 * encryption, i.e. at destination create/update) and we want those to surface
 * loudly to the operator, not be masked by a breaker.
 */

import { logger } from '@/utils/logger';

import type { KekProvider } from './kek-provider';
import { broadcastMetrics } from '@/broadcast/infrastructure/metrics/broadcast-metrics';

const log = logger.child({ component: 'broadcast-kek-breaker' });

export class KekUnwrapBreakerOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`KEK breaker OPEN — fast-failing unwrap (retry after ${retryAfterMs}ms)`);
    this.name = 'KekUnwrapBreakerOpenError';
  }
}

type BreakerState = 'closed' | 'half_open' | 'open';

export interface KekBreakerOptions {
  /** Consecutive failures in the rolling window that trip the breaker. Default 5. */
  failureThreshold?: number;
  /** Window in which failures are counted. Default 60_000ms. */
  rollingWindowMs?: number;
  /** Initial cooldown after open → half_open probe. Default 10_000ms. */
  baseCooldownMs?: number;
  /** Max cooldown under repeated probe failures. Default 120_000ms. */
  maxCooldownMs?: number;
  /** Successful probes needed to close the breaker. Default 2. */
  probeSuccessThreshold?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Wraps a `KekProvider` with a circuit breaker on `unwrap`. `wrap` is passed
 * through unchanged.
 */
export class CircuitBreakerKekProvider implements KekProvider {
  private state: BreakerState = 'closed';
  private failureTimestamps: number[] = [];
  private consecutiveProbeSuccesses = 0;
  private openUntilTimestamp = 0;
  private cooldownExponent = 0;

  private readonly failureThreshold: number;
  private readonly rollingWindowMs: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly probeSuccessThreshold: number;
  private readonly now: () => number;

  constructor(
    private readonly inner: KekProvider,
    opts: KekBreakerOptions = {},
  ) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.rollingWindowMs = opts.rollingWindowMs ?? 60_000;
    this.baseCooldownMs = opts.baseCooldownMs ?? 10_000;
    this.maxCooldownMs = opts.maxCooldownMs ?? 120_000;
    this.probeSuccessThreshold = opts.probeSuccessThreshold ?? 2;
    this.now = opts.now ?? (() => Date.now());
    this.publishState();
  }

  get resource(): string {
    return this.inner.resource;
  }

  /** wrap is not gated by the breaker — see file header. */
  async wrap(dek: Buffer): Promise<Buffer> {
    return this.inner.wrap(dek);
  }

  async unwrap(wrappedDek: Buffer): Promise<Buffer> {
    if (this.state === 'open') {
      const remaining = this.openUntilTimestamp - this.now();
      if (remaining > 0) {
        broadcastMetrics.kekUnwraps.inc({ result: 'fast_failed' });
        throw new KekUnwrapBreakerOpenError(remaining);
      }
      // Cooldown elapsed — move to half-open and allow this call to probe.
      this.transition('half_open');
    }

    const start = this.now();
    try {
      const out = await this.inner.unwrap(wrappedDek);
      broadcastMetrics.kekUnwraps.inc({ result: 'ok' });
      broadcastMetrics.kekUnwrapLatency.observe((this.now() - start) / 1000);
      this.recordSuccess();
      return out;
    } catch (e) {
      broadcastMetrics.kekUnwraps.inc({ result: 'failed' });
      broadcastMetrics.kekUnwrapLatency.observe((this.now() - start) / 1000);
      this.recordFailure();
      throw e;
    }
  }

  /** For testing / debug. */
  getState(): BreakerState {
    return this.state;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private recordSuccess(): void {
    if (this.state === 'half_open') {
      this.consecutiveProbeSuccesses += 1;
      if (this.consecutiveProbeSuccesses >= this.probeSuccessThreshold) {
        this.cooldownExponent = 0; // reset backoff
        this.failureTimestamps = [];
        this.transition('closed');
      }
      return;
    }
    // In closed state, a success clears the failure window.
    this.failureTimestamps = [];
  }

  private recordFailure(): void {
    const ts = this.now();
    this.failureTimestamps.push(ts);
    this.pruneFailureWindow(ts);

    if (this.state === 'half_open') {
      // Probe failed → re-open with backoff.
      this.cooldownExponent = Math.min(this.cooldownExponent + 1, 4);
      this.openBreaker();
      return;
    }

    if (this.failureTimestamps.length >= this.failureThreshold) {
      this.openBreaker();
    }
  }

  private pruneFailureWindow(nowTs: number): void {
    const cutoff = nowTs - this.rollingWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);
  }

  private openBreaker(): void {
    const cooldown = Math.min(
      this.baseCooldownMs * 2 ** this.cooldownExponent,
      this.maxCooldownMs,
    );
    this.openUntilTimestamp = this.now() + cooldown;
    this.consecutiveProbeSuccesses = 0;
    this.transition('open', { cooldownMs: cooldown });
  }

  private transition(
    next: BreakerState,
    extra: Record<string, unknown> = {},
  ): void {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    if (next === 'closed') {
      this.consecutiveProbeSuccesses = 0;
    }
    this.publishState();
    log.warn(
      { kekResource: this.inner.resource, prev, next, ...extra },
      'KEK circuit breaker state change',
    );
  }

  private publishState(): void {
    const n = this.state === 'closed' ? 0 : this.state === 'half_open' ? 1 : 2;
    broadcastMetrics.kekCircuitState.set(n);
  }
}
