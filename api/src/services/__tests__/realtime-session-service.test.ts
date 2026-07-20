// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the realtime session service — the ephemeral, single-use
 * token issuance/consumption that keeps long-lived credentials out of
 * WebSocket URLs. Locks in: hash-at-rest, single-use semantics, expiry
 * enforcement, and the "mismatch must not delete" anti-DoS rule.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createRealtimeSession,
  consumeRealtimeSession,
  REALTIME_SESSION_TOKEN_PREFIX,
  REALTIME_SESSION_TTL_SECONDS,
  type RealtimeSessionIdentity,
  type RealtimeSessionStore,
} from '../realtime-session-service';

class FakeStore implements RealtimeSessionStore {
  public data = new Map<string, string>();

  async set(key: string, value: string, _ttlSeconds: number): Promise<void> {
    this.data.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }
}

const identity: RealtimeSessionIdentity = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'user@example.com',
  name: 'User One',
  roles: ['member'],
  tier: 'pro',
};

describe('createRealtimeSession', () => {
  let store: FakeStore;

  beforeEach(() => {
    store = new FakeStore();
  });

  it('issues rs_/rst_ prefixed identifiers and a 5-minute expiry', async () => {
    const before = Date.now();
    const session = await createRealtimeSession(identity, store);

    expect(session.sessionId).toMatch(/^rs_/);
    expect(session.sessionToken.startsWith(REALTIME_SESSION_TOKEN_PREFIX)).toBe(true);
    expect(session.expiresAt).toBeGreaterThanOrEqual(before + REALTIME_SESSION_TTL_SECONDS * 1000);
  });

  it('stores only a hash of the token, never the raw token', async () => {
    const session = await createRealtimeSession(identity, store);
    const stored = [...store.data.values()].join('');
    expect(stored).not.toContain(session.sessionToken);
    expect(JSON.parse([...store.data.values()][0]).tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('issues a unique token per session', async () => {
    const a = await createRealtimeSession(identity, store);
    const b = await createRealtimeSession(identity, store);
    expect(a.sessionToken).not.toBe(b.sessionToken);
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe('consumeRealtimeSession', () => {
  let store: FakeStore;

  beforeEach(() => {
    store = new FakeStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the identity snapshot for a valid token', async () => {
    const session = await createRealtimeSession(identity, store);
    const result = await consumeRealtimeSession(session.sessionId, session.sessionToken, store);
    expect(result).toEqual(identity);
  });

  it('is single-use: the second consume fails', async () => {
    const session = await createRealtimeSession(identity, store);
    expect(await consumeRealtimeSession(session.sessionId, session.sessionToken, store)).toEqual(identity);
    expect(await consumeRealtimeSession(session.sessionId, session.sessionToken, store)).toBeNull();
  });

  it('rejects a wrong token WITHOUT deleting the session (anti-DoS)', async () => {
    const session = await createRealtimeSession(identity, store);
    const wrongToken = `${REALTIME_SESSION_TOKEN_PREFIX}${'x'.repeat(48)}`;

    expect(await consumeRealtimeSession(session.sessionId, wrongToken, store)).toBeNull();
    // The legitimate client must still be able to connect.
    expect(await consumeRealtimeSession(session.sessionId, session.sessionToken, store)).toEqual(identity);
  });

  it('rejects an unknown sessionId', async () => {
    const session = await createRealtimeSession(identity, store);
    expect(await consumeRealtimeSession('rs_does-not-exist', session.sessionToken, store)).toBeNull();
  });

  it('rejects malformed sessionId/token prefixes without touching the store', async () => {
    const session = await createRealtimeSession(identity, store);
    expect(await consumeRealtimeSession('bogus', session.sessionToken, store)).toBeNull();
    expect(await consumeRealtimeSession(session.sessionId, 'ak_live_not-a-session-token', store)).toBeNull();
    expect(store.data.size).toBe(1);
  });

  it('enforces expiresAt server-side even if the store TTL did not fire', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T10:00:00Z'));
    const session = await createRealtimeSession(identity, store);

    vi.setSystemTime(new Date('2026-06-12T10:05:01Z')); // past the 5-min TTL
    expect(await consumeRealtimeSession(session.sessionId, session.sessionToken, store)).toBeNull();
    // Expired record is cleaned up.
    expect(store.data.size).toBe(0);
  });

  it('discards a corrupted record', async () => {
    const session = await createRealtimeSession(identity, store);
    const key = [...store.data.keys()][0];
    store.data.set(key, 'not-json{');
    expect(await consumeRealtimeSession(session.sessionId, session.sessionToken, store)).toBeNull();
    expect(store.data.size).toBe(0);
  });
});
