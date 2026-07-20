// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider health sync bus — L2 Redis pub/sub for cross-instance
 * synchronization of `ProviderHealthRegistry` state.
 *
 * Phase 2 goals:
 *   - When instance A records a failure on (provider, model), instance B's
 *     registry sees the update within 100ms.
 *   - Same for successes / state recovery.
 *   - No feedback loop: an instance must NOT re-publish a delta it just
 *     applied (tracked via origin instanceId).
 *
 * Wire format: JSON line on Redis channel `operability:health:v1`.
 * Each message carries a `HealthSyncMessage` with the registry delta.
 *
 * Failure mode: Redis unavailable → bus is no-op (logs warn). Local
 * registry continues to work; cross-instance sync is degraded but the
 * core hot path (shouldSkipNearZero) is unaffected.
 *
 * NOT in this phase:
 *   - Postgres L3 persistence (needs Prisma migration; deferred to a
 *     follow-up that coordinates schema changes).
 *   - Backfill on boot (cold registry on restart). Until L3 lands, restart
 *     means losing the in-memory registry — which is acceptable because
 *     within ~30s of normal traffic the registry rebuilds via runtime
 *     observations.
 */

import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { logger } from '@/utils/logger';
import type {
  HealthKey,
  ProviderErrorClass,
  ProviderHealthState,
} from './types';

const log = logger.child({ component: 'health-sync-bus' });

// ─── Wire format ──────────────────────────────────────────────────────────

const CHANNEL = 'operability:health:v1';
const PROTOCOL_VERSION = 1;

export type HealthSyncEventKind = 'probe' | 'execution_success' | 'execution_failure' | 'state_set';

export interface HealthSyncMessage {
  v: number;
  kind: HealthSyncEventKind;
  /** ID of the publishing instance (so subscribers ignore their own messages). */
  origin: string;
  ts: number;
  key: HealthKey;
  state?: ProviderHealthState;
  reason?: string;
  errorClass?: ProviderErrorClass;
  latencyMs?: number;
  cooldownMs?: number;
}

// ─── Bus ──────────────────────────────────────────────────────────────────

class HealthSyncBus {
  private readonly instanceId = randomUUID();
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private inbound: ((msg: HealthSyncMessage) => void) | null = null;
  private connected = false;

  /**
   * Wire the bus to a Redis client pair.
   *
   * Two clients are needed: one for SUBSCRIBE (which puts the connection
   * into subscribe-mode and can't be used for other commands) and one
   * for PUBLISH (which uses the normal command surface).
   *
   * The caller passes both. They MUST be different physical connections.
   */
  async connect(input: { publisher: Redis; subscriber: Redis; onMessage: (msg: HealthSyncMessage) => void }): Promise<void> {
    if (this.connected) return;
    this.publisher = input.publisher;
    this.subscriber = input.subscriber;
    this.inbound = input.onMessage;

    await this.subscriber.subscribe(CHANNEL);
    this.subscriber.on('message', (channel, payload) => {
      if (channel !== CHANNEL) return;
      try {
        const parsed = JSON.parse(payload) as Partial<HealthSyncMessage>;
        if (parsed.v !== PROTOCOL_VERSION) return; // protocol mismatch
        if (parsed.origin === this.instanceId) return; // self echo
        if (!parsed.kind || !parsed.key || typeof parsed.key.providerId !== 'string') return;
        this.inbound?.(parsed as HealthSyncMessage);
      } catch (err) {
        log.warn({ err: String(err) }, 'health-sync: failed to parse message');
      }
    });

    this.connected = true;
    log.info({ instanceId: this.instanceId }, 'Health sync bus connected');
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.subscriber?.unsubscribe(CHANNEL);
    } catch { /* swallow */ }
    this.publisher = null;
    this.subscriber = null;
    this.inbound = null;
    this.connected = false;
  }

  /**
   * Publish a health delta. No-op if not connected.
   * Always non-blocking — failures are logged but don't bubble.
   */
  publish(message: Omit<HealthSyncMessage, 'v' | 'origin' | 'ts'>): void {
    if (!this.connected || !this.publisher) return;
    const full: HealthSyncMessage = {
      v: PROTOCOL_VERSION,
      origin: this.instanceId,
      ts: Date.now(),
      ...message,
    };
    const payload = JSON.stringify(full);
    this.publisher.publish(CHANNEL, payload).catch((err) => {
      log.debug({ err: String(err) }, 'health-sync: publish failed');
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  getInstanceId(): string {
    return this.instanceId;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let instance: HealthSyncBus | null = null;

export function getHealthSyncBus(): HealthSyncBus {
  if (!instance) {
    instance = new HealthSyncBus();
  }
  return instance;
}

export function resetHealthSyncBusForTesting(): void {
  instance = null;
}

export type { HealthSyncBus };
