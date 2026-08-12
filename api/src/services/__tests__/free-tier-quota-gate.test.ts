// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic unit tests for free-tier-quota-gate.ts.
 *
 * No real Redis: getGlobalRedisClient() is mocked to a small in-memory
 * counter fake (incr/expire), matching the house pattern used by
 * distributed-bulkhead.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let shouldThrow = false;
const store = new Map<string, number>();

const fakeRedis = {
  async incr(key: string): Promise<number> {
    if (shouldThrow) throw new Error('simulated Redis outage');
    const next = (store.get(key) ?? 0) + 1;
    store.set(key, next);
    return next;
  },
  async expire(): Promise<number> {
    if (shouldThrow) throw new Error('simulated Redis outage');
    return 1;
  },
};

vi.mock('@/cache/redis-client', () => ({
  getGlobalRedisClient: () => fakeRedis,
}));

import {
  checkAndConsumeFreeTierAutoQuota,
  freeTierQuotaExceededBody,
  isFreeTierAutoRawModel,
  isFreeTierAutoQuotaEnabled,
} from '@/services/free-tier-quota-gate';

const ENV_LIMIT = 'FREE_TIER_AUTO_DAILY_LIMIT';
const ENV_ENABLED = 'FREE_TIER_AUTO_QUOTA_ENABLED';
const ORG_ID = 'org_test_1';

beforeEach(() => {
  store.clear();
  shouldThrow = false;
  delete process.env[ENV_LIMIT];
  delete process.env[ENV_ENABLED];
});

afterEach(() => {
  delete process.env[ENV_LIMIT];
  delete process.env[ENV_ENABLED];
});

describe('isFreeTierAutoQuotaEnabled', () => {
  it('is OFF by default — deploying this code changes nothing platform-wide until explicitly enabled', () => {
    expect(isFreeTierAutoQuotaEnabled()).toBe(false);
  });

  it('is on only when explicitly set to the literal string "true"', () => {
    process.env[ENV_ENABLED] = 'yes';
    expect(isFreeTierAutoQuotaEnabled()).toBe(false);
    process.env[ENV_ENABLED] = 'true';
    expect(isFreeTierAutoQuotaEnabled()).toBe(true);
  });
});

describe('isFreeTierAutoRawModel', () => {
  it('is true only for the literal raw "ailin-auto" string', () => {
    expect(isFreeTierAutoRawModel('ailin-auto')).toBe(true);
    for (const other of ['ailin-economy', 'ailin-best', 'single:base', undefined]) {
      expect(isFreeTierAutoRawModel(other)).toBe(false);
    }
  });

  it('deliberately does NOT match bare "auto" or an empty string (F1: see file header — bringing bare auto into scope would cap the platform-wide zero-preference default, not just the ailin-auto preset)', () => {
    expect(isFreeTierAutoRawModel('auto')).toBe(false);
    expect(isFreeTierAutoRawModel('')).toBe(false);
    expect(isFreeTierAutoRawModel(undefined)).toBe(false);
  });
});

describe('checkAndConsumeFreeTierAutoQuota', () => {
  it('allows the first 5 requests (default limit) and rejects the 6th', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await checkAndConsumeFreeTierAutoQuota(ORG_ID));
    }
    expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(results.slice(0, 5).map((r) => r.remaining)).toEqual([4, 3, 2, 1, 0]);
    expect(results[5].allowed).toBe(false);
    expect(results[5].remaining).toBe(0);
  });

  it('tracks each organization independently', async () => {
    for (let i = 0; i < 5; i++) await checkAndConsumeFreeTierAutoQuota('org_a');
    const blockedA = await checkAndConsumeFreeTierAutoQuota('org_a');
    expect(blockedA.allowed).toBe(false);

    const freshB = await checkAndConsumeFreeTierAutoQuota('org_b');
    expect(freshB.allowed).toBe(true);
    expect(freshB.remaining).toBe(4);
  });

  it('respects FREE_TIER_AUTO_DAILY_LIMIT override', async () => {
    process.env[ENV_LIMIT] = '1';
    const first = await checkAndConsumeFreeTierAutoQuota(ORG_ID);
    expect(first.allowed).toBe(true);
    const second = await checkAndConsumeFreeTierAutoQuota(ORG_ID);
    expect(second.allowed).toBe(false);
  });

  it('fails OPEN (allows) when Redis errors — never bills, never blocks in-quota users', async () => {
    shouldThrow = true;
    const result = await checkAndConsumeFreeTierAutoQuota(ORG_ID);
    expect(result.allowed).toBe(true);
  });
});

describe('freeTierQuotaExceededBody', () => {
  it('matches the documented API contract shape', () => {
    const body = freeTierQuotaExceededBody('2026-08-03T00:00:00.000Z');
    expect(body.error.code).toBe('free_quota_exceeded');
    expect(body.error.reset_at).toBe('2026-08-03T00:00:00.000Z');
    expect(body.error.message).toContain('paid model');
  });
});
