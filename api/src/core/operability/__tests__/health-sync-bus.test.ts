// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Health sync bus — Redis pub/sub for cross-instance health propagation.
 *
 * Uses an in-memory Redis mock since CI doesn't always have Redis.
 * Verifies wire format, no self-echo, and remote delta application.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getHealthSyncBus, resetHealthSyncBusForTesting, type HealthSyncMessage } from '../health-sync-bus';
import {
  getProviderHealthRegistry,
  resetProviderHealthRegistryForTesting,
} from '../provider-health-registry';
import { classifyProviderError } from '../error-classification';

// Minimal Redis mock that supports publish/subscribe within the same process.
class FakeRedis {
  private subscribers = new Set<(channel: string, message: string) => void>();
  private subscribedChannels = new Set<string>();

  // Map of all FakeRedis instances sharing the same channel namespace.
  private static channelBus = new Map<string, Set<FakeRedis>>();

  async subscribe(channel: string): Promise<number> {
    this.subscribedChannels.add(channel);
    let bus = FakeRedis.channelBus.get(channel);
    if (!bus) {
      bus = new Set();
      FakeRedis.channelBus.set(channel, bus);
    }
    bus.add(this);
    return 1;
  }

  async unsubscribe(channel: string): Promise<number> {
    this.subscribedChannels.delete(channel);
    FakeRedis.channelBus.get(channel)?.delete(this);
    return 0;
  }

  async publish(channel: string, payload: string): Promise<number> {
    const bus = FakeRedis.channelBus.get(channel);
    if (!bus) return 0;
    let count = 0;
    for (const sub of bus) {
      // Synchronously deliver to subscribers in next microtask
      queueMicrotask(() => {
        for (const cb of sub.subscribers) {
          cb(channel, payload);
        }
      });
      count++;
    }
    return count;
  }

  on(event: string, listener: (channel: string, message: string) => void): this {
    if (event === 'message') {
      this.subscribers.add(listener);
    }
    return this;
  }

  static reset(): void {
    FakeRedis.channelBus.clear();
  }
}

describe('HealthSyncBus', () => {
  beforeEach(() => {
    resetHealthSyncBusForTesting();
    resetProviderHealthRegistryForTesting();
    FakeRedis.reset();
  });

  it('publishes and receives messages on the channel', async () => {
    const bus = getHealthSyncBus();
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const received: HealthSyncMessage[] = [];

    await bus.connect({
      publisher: pub as never,
      subscriber: sub as never,
      onMessage: (msg) => received.push(msg),
    });

    // Publish a different-origin message manually (simulating instance B)
    await pub.publish('operability:health:v1', JSON.stringify({
      v: 1,
      origin: 'other-instance',
      ts: Date.now(),
      kind: 'probe',
      key: { providerId: 'foo' },
      state: 'auth_failed',
    }));

    // Wait for microtask
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    expect(received[0].key.providerId).toBe('foo');
  });

  it('does NOT deliver self-echo (own origin)', async () => {
    const bus = getHealthSyncBus();
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const received: HealthSyncMessage[] = [];

    await bus.connect({
      publisher: pub as never,
      subscriber: sub as never,
      onMessage: (msg) => received.push(msg),
    });

    // Trigger a publish via the bus itself (origin = this instance)
    bus.publish({ kind: 'probe', key: { providerId: 'self' }, state: 'auth_failed' });

    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });

  it('drops messages with wrong protocol version', async () => {
    const bus = getHealthSyncBus();
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const received: HealthSyncMessage[] = [];

    await bus.connect({
      publisher: pub as never,
      subscriber: sub as never,
      onMessage: (msg) => received.push(msg),
    });

    await pub.publish('operability:health:v1', JSON.stringify({
      v: 99,
      origin: 'other',
      ts: Date.now(),
      kind: 'probe',
      key: { providerId: 'foo' },
    }));

    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(0);
  });

  it('drops malformed payloads (no crash)', async () => {
    const bus = getHealthSyncBus();
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const received: HealthSyncMessage[] = [];

    await bus.connect({
      publisher: pub as never,
      subscriber: sub as never,
      onMessage: (msg) => received.push(msg),
    });

    await pub.publish('operability:health:v1', 'not json');
    await pub.publish('operability:health:v1', '{}');

    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(0);
  });
});

describe('Registry — remote delta application', () => {
  beforeEach(() => {
    resetHealthSyncBusForTesting();
    resetProviderHealthRegistryForTesting();
    FakeRedis.reset();
  });

  it('applies remote probe delta without re-publishing', async () => {
    const bus = getHealthSyncBus();
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const echoed: HealthSyncMessage[] = [];

    await bus.connect({
      publisher: pub as never,
      subscriber: sub as never,
      onMessage: (msg) => {
        getProviderHealthRegistry().applyRemoteDelta(msg);
        echoed.push(msg);
      },
    });

    // Simulate instance B publishing
    await pub.publish('operability:health:v1', JSON.stringify({
      v: 1,
      origin: 'instance-b',
      ts: Date.now(),
      kind: 'probe',
      key: { providerId: 'aihubmix' },
      state: 'auth_failed',
      reason: 'bad key',
      errorClass: 'auth_failed',
    }));

    await new Promise((r) => setTimeout(r, 10));

    // Local registry now has the record
    const record = getProviderHealthRegistry().lookup({ providerId: 'aihubmix' });
    expect(record?.state).toBe('auth_failed');
    expect(echoed).toHaveLength(1);
  });

  it('applies remote execution_failure delta', async () => {
    const bus = getHealthSyncBus();
    const pub = new FakeRedis();
    const sub = new FakeRedis();

    await bus.connect({
      publisher: pub as never,
      subscriber: sub as never,
      onMessage: (msg) => getProviderHealthRegistry().applyRemoteDelta(msg),
    });

    await pub.publish('operability:health:v1', JSON.stringify({
      v: 1,
      origin: 'instance-b',
      ts: Date.now(),
      kind: 'execution_failure',
      key: { providerId: 'openai', modelId: 'gpt-4o-mini' },
      state: 'rate_limited',
      errorClass: 'rate_limited',
      cooldownMs: 30_000,
    }));

    await new Promise((r) => setTimeout(r, 10));

    const record = getProviderHealthRegistry().lookupExact({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
    });
    expect(record?.state).toBe('rate_limited');
    expect(record?.errorClass).toBe('rate_limited');
  });

  it('local writes publish to other instances', async () => {
    const bus = getHealthSyncBus();
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const out: HealthSyncMessage[] = [];

    await bus.connect({
      publisher: pub as never,
      subscriber: sub as never,
      onMessage: () => { /* not used in this test */ },
    });

    // Hook a separate subscriber (instance B) onto the channel
    const subB = new FakeRedis();
    await subB.subscribe('operability:health:v1');
    subB.on('message', (_ch, payload) => {
      out.push(JSON.parse(payload) as HealthSyncMessage);
    });

    // Local recordExecution should publish
    getProviderHealthRegistry().recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].kind).toBe('execution_failure');
    expect(out[0].key.providerId).toBe('aihubmix');
    expect(out[0].errorClass).toBe('auth_failed');
  });
});
