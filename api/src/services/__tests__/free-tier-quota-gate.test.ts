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
  chatFreeTierApiKeyId,
  checkAndConsumeFreeTierAutoQuota,
  checkChatFreeTierApiKeyConfig,
  freeTierQuotaExceededBody,
  isFreeTierAutoQuotaEnabled,
  isFreeTierAutoRawModel,
  isInChatFreeTierScope,
} from '@/services/free-tier-quota-gate';

const ENV_LIMIT = 'FREE_TIER_AUTO_DAILY_LIMIT';
const ENV_ENABLED = 'FREE_TIER_AUTO_QUOTA_ENABLED';
const ENV_KEY_ID = 'CHAT_FREE_TIER_API_KEY_ID';
const KEY_ID = 'key_test_1';
const OTHER_KEY_ID = 'key_other';
const USER_ID = 'user_test_1';

beforeEach(() => {
  store.clear();
  shouldThrow = false;
  delete process.env[ENV_LIMIT];
  delete process.env[ENV_ENABLED];
  delete process.env[ENV_KEY_ID];
});

afterEach(() => {
  delete process.env[ENV_LIMIT];
  delete process.env[ENV_ENABLED];
  delete process.env[ENV_KEY_ID];
});

describe('chatFreeTierApiKeyId', () => {
  it('is undefined when unset (safe default — gate never fires)', () => {
    expect(chatFreeTierApiKeyId()).toBeUndefined();
  });

  it('trims and returns the configured id', () => {
    process.env[ENV_KEY_ID] = `  ${KEY_ID}  `;
    expect(chatFreeTierApiKeyId()).toBe(KEY_ID);
  });
});

describe('isFreeTierAutoQuotaEnabled', () => {
  it('is OFF by default', () => {
    expect(isFreeTierAutoQuotaEnabled()).toBe(false);
  });

  it('requires BOTH the flag AND a configured key id — the key id is the actual safety boundary now', () => {
    process.env[ENV_ENABLED] = 'true';
    expect(isFreeTierAutoQuotaEnabled()).toBe(false); // flag alone is not enough

    delete process.env[ENV_ENABLED];
    process.env[ENV_KEY_ID] = KEY_ID;
    expect(isFreeTierAutoQuotaEnabled()).toBe(false); // key alone is not enough

    process.env[ENV_ENABLED] = 'true';
    expect(isFreeTierAutoQuotaEnabled()).toBe(true);
  });

  it('is on only when the flag is explicitly the literal string "true"', () => {
    process.env[ENV_KEY_ID] = KEY_ID;
    process.env[ENV_ENABLED] = 'yes';
    expect(isFreeTierAutoQuotaEnabled()).toBe(false);
  });
});

describe('isFreeTierAutoRawModel', () => {
  it('is true only for the literal raw "ailin-auto" string', () => {
    expect(isFreeTierAutoRawModel('ailin-auto')).toBe(true);
    for (const other of ['ailin-economy', 'ailin-best', 'single:base', undefined]) {
      expect(isFreeTierAutoRawModel(other)).toBe(false);
    }
  });

  it('deliberately does NOT match bare "auto" or an empty string (see file header — bringing bare auto into scope would cap the platform-wide zero-preference default, not just the ailin-auto preset)', () => {
    expect(isFreeTierAutoRawModel('auto')).toBe(false);
    expect(isFreeTierAutoRawModel('')).toBe(false);
    expect(isFreeTierAutoRawModel(undefined)).toBe(false);
  });
});

describe('isInChatFreeTierScope', () => {
  beforeEach(() => {
    process.env[ENV_KEY_ID] = KEY_ID;
  });

  it('is true only when the key id matches, the raw model is ailin-auto, and a userId is present', () => {
    expect(
      isInChatFreeTierScope({ apiKeyId: KEY_ID, rawModel: 'ailin-auto', userId: USER_ID })
    ).toBe(true);
  });

  it('is false for any other API key id — this is the structural safety boundary (financial/guide/id traffic can never match)', () => {
    expect(
      isInChatFreeTierScope({ apiKeyId: OTHER_KEY_ID, rawModel: 'ailin-auto', userId: USER_ID })
    ).toBe(false);
    expect(
      isInChatFreeTierScope({ apiKeyId: undefined, rawModel: 'ailin-auto', userId: USER_ID })
    ).toBe(false);
  });

  it('is false when the key id is unconfigured, even if a request happens to present a matching value', () => {
    delete process.env[ENV_KEY_ID];
    expect(
      isInChatFreeTierScope({ apiKeyId: KEY_ID, rawModel: 'ailin-auto', userId: USER_ID })
    ).toBe(false);
  });

  it('is false for any model other than the literal "ailin-auto"', () => {
    for (const other of ['auto', 'ailin-economy', '', undefined]) {
      expect(isInChatFreeTierScope({ apiKeyId: KEY_ID, rawModel: other, userId: USER_ID })).toBe(
        false
      );
    }
  });

  it('is false without a userId', () => {
    expect(
      isInChatFreeTierScope({ apiKeyId: KEY_ID, rawModel: 'ailin-auto', userId: undefined })
    ).toBe(false);
    expect(isInChatFreeTierScope({ apiKeyId: KEY_ID, rawModel: 'ailin-auto', userId: '' })).toBe(
      false
    );
  });
});

describe('checkAndConsumeFreeTierAutoQuota', () => {
  it('allows the first 5 requests (default limit) and rejects the 6th', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await checkAndConsumeFreeTierAutoQuota(KEY_ID, USER_ID));
    }
    expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(results.slice(0, 5).map((r) => r.remaining)).toEqual([4, 3, 2, 1, 0]);
    expect(results[5].allowed).toBe(false);
    expect(results[5].remaining).toBe(0);
  });

  it('tracks each (apiKeyId, userId) pair independently — two users through the same dedicated key each get their own allowance', async () => {
    for (let i = 0; i < 5; i++) await checkAndConsumeFreeTierAutoQuota(KEY_ID, 'user_a');
    const blockedA = await checkAndConsumeFreeTierAutoQuota(KEY_ID, 'user_a');
    expect(blockedA.allowed).toBe(false);

    const freshB = await checkAndConsumeFreeTierAutoQuota(KEY_ID, 'user_b');
    expect(freshB.allowed).toBe(true);
    expect(freshB.remaining).toBe(4);
  });

  it('respects FREE_TIER_AUTO_DAILY_LIMIT override', async () => {
    process.env[ENV_LIMIT] = '1';
    const first = await checkAndConsumeFreeTierAutoQuota(KEY_ID, USER_ID);
    expect(first.allowed).toBe(true);
    const second = await checkAndConsumeFreeTierAutoQuota(KEY_ID, USER_ID);
    expect(second.allowed).toBe(false);
  });

  it('fails OPEN (allows) when Redis errors — never bills, never blocks in-quota users', async () => {
    shouldThrow = true;
    const result = await checkAndConsumeFreeTierAutoQuota(KEY_ID, USER_ID);
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

describe('checkChatFreeTierApiKeyConfig', () => {
  it('is "unset" when the env var is unset — not a misconfiguration', async () => {
    const result = await checkChatFreeTierApiKeyConfig(async () => null);
    expect(result.status).toBe('unset');
  });

  it('is "ok" when the configured id resolves to an active row', async () => {
    process.env[ENV_KEY_ID] = KEY_ID;
    const result = await checkChatFreeTierApiKeyConfig(async (id) =>
      id === KEY_ID ? { id, status: 'active' } : null
    );
    expect(result.status).toBe('ok');
  });

  it('is "not_found" when no row matches — catches pasting the key name/secret instead of its id', async () => {
    process.env[ENV_KEY_ID] = KEY_ID;
    const result = await checkChatFreeTierApiKeyConfig(async () => null);
    expect(result.status).toBe('not_found');
  });

  it('is "inactive" when the row exists but is not active', async () => {
    process.env[ENV_KEY_ID] = KEY_ID;
    const result = await checkChatFreeTierApiKeyConfig(async (id) => ({ id, status: 'revoked' }));
    expect(result.status).toBe('inactive');
  });

  it('is "check_failed" (not "ok") when the lookup itself throws', async () => {
    process.env[ENV_KEY_ID] = KEY_ID;
    const result = await checkChatFreeTierApiKeyConfig(async () => {
      throw new Error('db unreachable');
    });
    expect(result.status).toBe('check_failed');
  });
});
