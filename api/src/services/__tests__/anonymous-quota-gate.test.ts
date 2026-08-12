// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic unit tests for anonymous-quota-gate.ts.
 *
 * No real Redis: getGlobalRedisClient() is mocked to a small in-memory
 * counter fake (incr/expire), matching the house pattern used by
 * distributed-bulkhead.test.ts. Fail-open behavior is verified by making
 * the fake throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let shouldThrow = false;
const store = new Map<string, number>();
const expirations = new Map<string, number>();

const fakeRedis = {
  async incr(key: string): Promise<number> {
    if (shouldThrow) throw new Error('simulated Redis outage');
    const next = (store.get(key) ?? 0) + 1;
    store.set(key, next);
    return next;
  },
  async expire(key: string, ttlSeconds: number): Promise<number> {
    if (shouldThrow) throw new Error('simulated Redis outage');
    expirations.set(key, ttlSeconds);
    return 1;
  },
};

vi.mock('@/cache/redis-client', () => ({
  getGlobalRedisClient: () => fakeRedis,
}));

import {
  anonymousGuestApiKeyId,
  anonymousQuotaExceededBody,
  checkAndConsumeAnonymousQuota,
  checkAnonymousGuestApiKeyConfig,
  inAnonymousQuotaScope,
} from '@/services/anonymous-quota-gate';

const ENV_KEY = 'ANONYMOUS_GUEST_API_KEY_ID';
const ENV_LIMIT = 'ANONYMOUS_QUOTA_DAILY_LIMIT';
const GUEST_KEY_ID = 'apikey_guest_123';

beforeEach(() => {
  store.clear();
  expirations.clear();
  shouldThrow = false;
  process.env[ENV_KEY] = GUEST_KEY_ID;
  delete process.env[ENV_LIMIT];
});

afterEach(() => {
  delete process.env[ENV_KEY];
  delete process.env[ENV_LIMIT];
});

describe('anonymousGuestApiKeyId', () => {
  it('is undefined when unset (safe default — gate never fires)', () => {
    delete process.env[ENV_KEY];
    expect(anonymousGuestApiKeyId()).toBeUndefined();
  });

  it('reads the configured key id', () => {
    expect(anonymousGuestApiKeyId()).toBe(GUEST_KEY_ID);
  });
});

describe('inAnonymousQuotaScope', () => {
  it('is out of scope when the env var is unset, regardless of the request', () => {
    delete process.env[ENV_KEY];
    const scope = inAnonymousQuotaScope({
      apiKeyId: GUEST_KEY_ID,
      rawModel: 'ailin-economy',
      visitorIdHeader: 'visitor-1',
    });
    expect(scope.inScope).toBe(false);
  });

  it('is out of scope for any other API key', () => {
    const scope = inAnonymousQuotaScope({
      apiKeyId: 'some-other-key',
      rawModel: 'ailin-economy',
      visitorIdHeader: 'visitor-1',
    });
    expect(scope.inScope).toBe(false);
  });

  it('is out of scope for any model other than the literal "ailin-economy" string', () => {
    for (const model of ['auto', 'ailin-auto', 'gpt-4o', 'single:base', undefined]) {
      const scope = inAnonymousQuotaScope({
        apiKeyId: GUEST_KEY_ID,
        rawModel: model,
        visitorIdHeader: 'visitor-1',
      });
      expect(scope.inScope).toBe(false);
    }
  });

  it('is out of scope when the visitor header is missing or blank', () => {
    for (const header of [undefined, '', '   ']) {
      const scope = inAnonymousQuotaScope({
        apiKeyId: GUEST_KEY_ID,
        rawModel: 'ailin-economy',
        visitorIdHeader: header,
      });
      expect(scope.inScope).toBe(false);
    }
  });

  it('is in scope for the designated key + ailin-economy + a visitor header, and hashes the visitor id', () => {
    const scope = inAnonymousQuotaScope({
      apiKeyId: GUEST_KEY_ID,
      rawModel: 'ailin-economy',
      visitorIdHeader: 'visitor-1',
    });
    expect(scope.inScope).toBe(true);
    expect(scope.visitorIdHash).toBeDefined();
    // Never store the raw header value itself.
    expect(scope.visitorIdHash).not.toBe('visitor-1');
    expect(scope.visitorIdHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('hashes deterministically (same visitor -> same hash)', () => {
    const a = inAnonymousQuotaScope({
      apiKeyId: GUEST_KEY_ID,
      rawModel: 'ailin-economy',
      visitorIdHeader: 'visitor-1',
    });
    const b = inAnonymousQuotaScope({
      apiKeyId: GUEST_KEY_ID,
      rawModel: 'ailin-economy',
      visitorIdHeader: 'visitor-1',
    });
    expect(a.visitorIdHash).toBe(b.visitorIdHash);
  });
});

describe('checkAndConsumeAnonymousQuota', () => {
  it('allows the first N requests (default limit 2) and rejects the (N+1)th', async () => {
    const r1 = await checkAndConsumeAnonymousQuota(GUEST_KEY_ID, 'visitor-hash-a');
    expect(r1).toMatchObject({ allowed: true, remaining: 1, limit: 2 });

    const r2 = await checkAndConsumeAnonymousQuota(GUEST_KEY_ID, 'visitor-hash-a');
    expect(r2).toMatchObject({ allowed: true, remaining: 0, limit: 2 });

    const r3 = await checkAndConsumeAnonymousQuota(GUEST_KEY_ID, 'visitor-hash-a');
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
    expect(typeof r3.resetAt).toBe('string');
  });

  it('tracks each visitor independently', async () => {
    await checkAndConsumeAnonymousQuota(GUEST_KEY_ID, 'visitor-a');
    await checkAndConsumeAnonymousQuota(GUEST_KEY_ID, 'visitor-a');
    const blockedA = await checkAndConsumeAnonymousQuota(GUEST_KEY_ID, 'visitor-a');
    expect(blockedA.allowed).toBe(false);

    // A different visitor hash has its own, untouched allowance.
    const freshB = await checkAndConsumeAnonymousQuota(GUEST_KEY_ID, 'visitor-b');
    expect(freshB.allowed).toBe(true);
    expect(freshB.remaining).toBe(1);
  });

  it('respects ANONYMOUS_QUOTA_DAILY_LIMIT override', async () => {
    process.env[ENV_LIMIT] = '5';
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await checkAndConsumeAnonymousQuota(GUEST_KEY_ID, 'visitor-c'));
    }
    expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(results[5].allowed).toBe(false);
  });

  it('sets a TTL on every increment (self-healing against a crash before EXPIRE)', async () => {
    await checkAndConsumeAnonymousQuota(GUEST_KEY_ID, 'visitor-ttl');
    const key = [...expirations.keys()][0];
    expect(key).toContain(GUEST_KEY_ID);
    expect(expirations.get(key)).toBeGreaterThan(0);
  });

  it('fails OPEN (allows) when Redis errors — never touches billing either way', async () => {
    shouldThrow = true;
    const result = await checkAndConsumeAnonymousQuota(GUEST_KEY_ID, 'visitor-down');
    expect(result.allowed).toBe(true);
  });
});

describe('anonymousQuotaExceededBody', () => {
  it('matches the documented API contract shape', () => {
    const body = anonymousQuotaExceededBody('2026-08-03T00:00:00.000Z');
    expect(body.error.code).toBe('anonymous_quota_exceeded');
    expect(body.error.reset_at).toBe('2026-08-03T00:00:00.000Z');
    expect(typeof body.error.message).toBe('string');
  });
});

// F4: a wrong-but-set ANONYMOUS_GUEST_API_KEY_ID silently leaves the real
// guest key ungoverned (doesn't count, doesn't 403, doesn't log) — this is
// the boot-time check that turns that into a loud, actionable signal.
describe('checkAnonymousGuestApiKeyConfig', () => {
  it('is "unset" when the env var is unset — a safe, intentional, non-misconfiguration state', async () => {
    delete process.env[ENV_KEY];
    const lookup = vi.fn();
    const result = await checkAnonymousGuestApiKeyConfig(lookup);
    expect(result.status).toBe('unset');
    expect(lookup).not.toHaveBeenCalled(); // no DB round-trip needed when unset
  });

  it('is "ok" when the configured id resolves to an active row', async () => {
    const lookup = vi.fn().mockResolvedValue({ id: GUEST_KEY_ID, status: 'active' });
    const result = await checkAnonymousGuestApiKeyConfig(lookup);
    expect(result).toEqual({ status: 'ok', configuredId: GUEST_KEY_ID });
    expect(lookup).toHaveBeenCalledWith(GUEST_KEY_ID);
  });

  it('is "not_found" when the configured id matches no row (e.g. the operator pasted the name or the plaintext secret instead of the DB id)', async () => {
    const lookup = vi.fn().mockResolvedValue(null);
    const result = await checkAnonymousGuestApiKeyConfig(lookup);
    expect(result.status).toBe('not_found');
    expect(result.configuredId).toBe(GUEST_KEY_ID);
    expect(result.detail).toBeDefined();
  });

  it('is "inactive" when the configured id matches a row that is not status=active', async () => {
    const lookup = vi.fn().mockResolvedValue({ id: GUEST_KEY_ID, status: 'revoked' });
    const result = await checkAnonymousGuestApiKeyConfig(lookup);
    expect(result.status).toBe('inactive');
    expect(result.detail).toContain('revoked');
  });

  it('is "check_failed" (never "ok") when the lookup itself throws (e.g. DB unreachable at boot)', async () => {
    const lookup = vi.fn().mockRejectedValue(new Error('connection refused'));
    const result = await checkAnonymousGuestApiKeyConfig(lookup);
    expect(result.status).toBe('check_failed');
    expect(result.status).not.toBe('ok');
  });
});
