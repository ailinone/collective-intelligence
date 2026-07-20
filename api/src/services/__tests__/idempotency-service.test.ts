// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the idempotency service — the core at-most-once request engine
 * behind `POST /v1/chat/completions` and `POST /v1/responses`.
 *
 * Locks in the F3/F1 §P1 contract:
 *   - replay of an identical retry returns the cached httpStatus + body;
 *   - same key + different body → key_reuse;
 *   - concurrent in-flight → in_progress;
 *   - 2xx is cached (done), non-2xx releases the lock (retry stays open);
 *   - TTL expiry frees the key for a fresh attempt;
 *   - request hashing is order-insensitive for objects, order-sensitive for
 *     arrays;
 *   - keys are tenant-scoped (no cross-org bleed).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginIdempotentRequest,
  finalizeIdempotentRequest,
  releaseIdempotentRequest,
  computeRequestHash,
  stableStringify,
  buildIdempotencyRedisKey,
  IDEMPOTENCY_TTL_SECONDS,
  IDEMPOTENCY_INFLIGHT_TTL_SECONDS,
  type IdempotencyStore,
} from '../idempotency-service';

/**
 * Map-backed fake with real SET-NX-EX + TTL-expiry semantics, mirroring the
 * `RealtimeSessionStore` FakeStore pattern used elsewhere in this codebase.
 */
class FakeStore implements IdempotencyStore {
  public data = new Map<string, { value: string; expiresAt: number }>();
  public now = Date.now();

  private isAlive(key: string): boolean {
    const entry = this.data.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= this.now) {
      this.data.delete(key);
      return false;
    }
    return true;
  }

  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.isAlive(key)) return false;
    this.data.set(key, { value, expiresAt: this.now + ttlSeconds * 1000 });
    return true;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.data.set(key, { value, expiresAt: this.now + ttlSeconds * 1000 });
  }

  async get(key: string): Promise<string | null> {
    return this.isAlive(key) ? (this.data.get(key)?.value ?? null) : null;
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  /** Advance the simulated clock to exercise TTL expiry. */
  advance(ms: number): void {
    this.now += ms;
  }
}

const ORG = 'org-1';
const KEY = 'client-key-abc';
const BODY = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };

describe('stableStringify', () => {
  it('sorts object keys so insertion order does not change the hash', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('preserves array order (order is significant)', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it('handles nested objects and null/primitive leaves', () => {
    expect(stableStringify({ x: { b: [1, { z: 1, a: 2 }], a: null } })).toBe(
      stableStringify({ x: { a: null, b: [1, { a: 2, z: 1 }] } })
    );
  });
});

describe('computeRequestHash', () => {
  it('is identical for semantically-equal bodies with reordered keys', () => {
    expect(computeRequestHash({ a: 1, b: 2 })).toBe(computeRequestHash({ b: 2, a: 1 }));
  });

  it('differs when the body content differs', () => {
    expect(computeRequestHash({ a: 1 })).not.toBe(computeRequestHash({ a: 2 }));
  });
});

describe('buildIdempotencyRedisKey', () => {
  it('scopes the key by tenant', () => {
    expect(buildIdempotencyRedisKey('org-A', 'k')).toBe('idem:org-A:k');
    expect(buildIdempotencyRedisKey('org-B', 'k')).not.toBe(
      buildIdempotencyRedisKey('org-A', 'k')
    );
  });

  it('throws when organizationId is empty (no shared bucket collapse)', () => {
    expect(() => buildIdempotencyRedisKey('', 'k')).toThrow(/organizationId/);
  });
});

describe('beginIdempotentRequest', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it('acquires the lock on first call and writes an in_flight record', async () => {
    const result = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    expect(result.outcome).toBe('acquired');
    if (result.outcome !== 'acquired') throw new Error('unreachable');
    expect(result.redisKey).toBe('idem:org-1:client-key-abc');

    const stored = JSON.parse((await store.get(result.redisKey))!);
    expect(stored.status).toBe('in_flight');
    expect(stored.requestHash).toBe(result.requestHash);
  });

  it('writes the in_flight lock with the SHORT in-flight TTL, not the 24h response TTL', async () => {
    const result = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    if (result.outcome !== 'acquired') throw new Error('unreachable');
    const entry = store.data.get(result.redisKey)!;
    // The transient lock must use IDEMPOTENCY_INFLIGHT_TTL_SECONDS so a crashed
    // request cannot strand the key for the full 24h response TTL.
    expect(entry.expiresAt - store.now).toBe(IDEMPOTENCY_INFLIGHT_TTL_SECONDS * 1000);
    expect(IDEMPOTENCY_INFLIGHT_TTL_SECONDS).toBeLessThan(IDEMPOTENCY_TTL_SECONDS);
  });

  it('reports in_progress for a concurrent identical request', async () => {
    await beginIdempotentRequest({ organizationId: ORG, key: KEY, requestBody: BODY, store });
    const second = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    expect(second.outcome).toBe('in_progress');
  });

  it('reports key_reuse when the same key carries a different body', async () => {
    await beginIdempotentRequest({ organizationId: ORG, key: KEY, requestBody: BODY, store });
    const second = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: { ...BODY, model: 'gpt-4o' },
      store,
    });
    expect(second.outcome).toBe('key_reuse');
  });

  it('does NOT cross-contaminate between tenants (same key, different org)', async () => {
    await beginIdempotentRequest({ organizationId: 'org-A', key: KEY, requestBody: BODY, store });
    const other = await beginIdempotentRequest({
      organizationId: 'org-B',
      key: KEY,
      requestBody: BODY,
      store,
    });
    // org-B gets its own lock — no in_progress/replay from org-A.
    expect(other.outcome).toBe('acquired');
  });
});

describe('finalize → replay', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it('replays the exact cached httpStatus + body on an identical retry', async () => {
    const begin = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    if (begin.outcome !== 'acquired') throw new Error('unreachable');

    const responseBody = { id: 'cmpl-1', choices: [{ text: 'hello' }] };
    await finalizeIdempotentRequest({
      redisKey: begin.redisKey,
      requestHash: begin.requestHash,
      httpStatus: 200,
      body: responseBody,
      store,
    });

    const retry = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    expect(retry.outcome).toBe('replay');
    if (retry.outcome !== 'replay') throw new Error('unreachable');
    expect(retry.record.httpStatus).toBe(200);
    expect(retry.record.body).toEqual(responseBody);
  });

  it('a different body after finalize is key_reuse, not replay', async () => {
    const begin = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    if (begin.outcome !== 'acquired') throw new Error('unreachable');
    await finalizeIdempotentRequest({
      redisKey: begin.redisKey,
      requestHash: begin.requestHash,
      httpStatus: 200,
      body: { ok: true },
      store,
    });

    const retry = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: { ...BODY, model: 'other' },
      store,
    });
    expect(retry.outcome).toBe('key_reuse');
  });
});

describe('release (non-2xx / failure → retry stays open)', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it('frees the key so a subsequent attempt re-acquires the lock', async () => {
    const begin = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    if (begin.outcome !== 'acquired') throw new Error('unreachable');

    // Simulate a 5xx — release without caching.
    await releaseIdempotentRequest({ redisKey: begin.redisKey, store });

    const retry = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    expect(retry.outcome).toBe('acquired');
  });
});

describe('TTL expiry', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it('lets the key be re-acquired after the 24h record expires', async () => {
    const begin = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    if (begin.outcome !== 'acquired') throw new Error('unreachable');
    await finalizeIdempotentRequest({
      redisKey: begin.redisKey,
      requestHash: begin.requestHash,
      httpStatus: 200,
      body: { ok: true },
      store,
    });

    // Within TTL → still replays.
    store.advance(IDEMPOTENCY_TTL_SECONDS * 1000 - 1000);
    const within = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    expect(within.outcome).toBe('replay');

    // Past TTL → record is gone, a fresh attempt acquires the lock.
    store.advance(2000);
    const after = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    expect(after.outcome).toBe('acquired');
  });

  it('caches the completed (done) response with the full 24h response TTL', async () => {
    const begin = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    if (begin.outcome !== 'acquired') throw new Error('unreachable');
    await finalizeIdempotentRequest({
      redisKey: begin.redisKey,
      requestHash: begin.requestHash,
      httpStatus: 200,
      body: { ok: true },
      store,
    });
    // finalize() must promote the record to the long response TTL — the short
    // in-flight lock TTL applies only while the request is executing.
    const entry = store.data.get(begin.redisKey)!;
    expect(entry.expiresAt - store.now).toBe(IDEMPOTENCY_TTL_SECONDS * 1000);
  });
});

describe('in-flight lock TTL (stale lock recovery after a crash)', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it('re-acquires once the short in-flight TTL lapses, not after the 24h response TTL', async () => {
    const start = store.now;
    // Owner acquires the lock, then the process is "killed" — it never calls
    // finalize()/release(), so the in_flight lock is stranded on its own TTL.
    const first = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    expect(first.outcome).toBe('acquired');

    // Just before the in-flight TTL: a genuine concurrent retry is still
    // blocked (the request could legitimately still be running).
    store.advance(IDEMPOTENCY_INFLIGHT_TTL_SECONDS * 1000 - 1000);
    const during = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    expect(during.outcome).toBe('in_progress');

    // Just past the SHORT in-flight TTL (still FAR under 24h): the stranded lock
    // has expired, so the retry re-acquires instead of getting 409 for a full
    // day — the REL-05 fix. Sanity-check we are nowhere near the response TTL.
    store.advance(2000);
    expect(store.now - start).toBeLessThan(IDEMPOTENCY_TTL_SECONDS * 1000);
    const after = await beginIdempotentRequest({
      organizationId: ORG,
      key: KEY,
      requestBody: BODY,
      store,
    });
    expect(after.outcome).toBe('acquired');
  });
});
