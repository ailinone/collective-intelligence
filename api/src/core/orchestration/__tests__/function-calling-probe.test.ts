// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Behavioral contract — lazy function-calling probe.
 *
 * The probe turns ABSENT function_calling metadata from a hard selection
 * barrier into an on-demand, cached verification. These tests lock:
 *   - success (provider accepts tools-shaped request) → true, cached
 *   - explicit tools-not-supported error → false, cached
 *   - billing/auth/timeout errors → null (NOT an FC verdict, not cached)
 *   - cache hit avoids a second provider call
 *   - probe budget guard returns inconclusive without calling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

// HERMETICITY: the probe's L2 cache is the GLOBAL Redis client (db 1) with a
// 7-day TTL, and it writes real verdicts for the fake provider/model ids used
// below. If any Redis happens to answer on REDIS_HOST:REDIS_PORT (a developer
// box with an unrelated redis on 6379 is enough), the FIRST run seeds
// `fc-probe:probe-test:*` and every later run reads the cached verdict, never
// calls the adapter, and fails `expect(a.calls).toBe(1)` — a failure that has
// nothing to do with the probe logic under test. Stub the client module so
// the L2 cache is always an empty, write-only sink; the memory cache, budget
// guard and in-flight dedup (what these cases actually pin) are untouched.
vi.mock('@/cache/redis-client', () => ({
  getGlobalRedisClient: () => ({
    get: async () => null,
    set: async () => 'OK',
  }),
  disconnectRedis: async () => {},
}));

const {
  getFunctionCallingVerdict,
  resetFunctionCallingProbeForTesting,
  getProbeStats,
} = await import('../function-calling-probe');

function fakeAdapter(
  behavior: 'success' | 'tools-unsupported' | 'billing' | 'throw'
): ProviderAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    getName: () => 'probe-test',
    async chatCompletion() {
      adapter.calls++;
      if (behavior === 'success') {
        return {
          id: 'x',
          object: 'chat.completion',
          created: 1,
          model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      }
      if (behavior === 'tools-unsupported') {
        throw new Error('Tools are not supported for this model');
      }
      if (behavior === 'billing') {
        throw new Error('HTTP 402 insufficient credits');
      }
      throw new Error('unexpected');
    },
  };
  return adapter as unknown as ProviderAdapter & { calls: number };
}

describe('function-calling probe', () => {
  beforeEach(() => {
    resetFunctionCallingProbeForTesting();
  });

  it('provider accepting the tools-shaped request → true, and cached', async () => {
    const a = fakeAdapter('success');
    expect(await getFunctionCallingVerdict(a, 'probe-test', 'model-a')).toBe(true);
    expect(a.calls).toBe(1);
    // second call — memory cache hit, no provider call
    expect(await getFunctionCallingVerdict(a, 'probe-test', 'model-a')).toBe(true);
    expect(a.calls).toBe(1);
    expect(getProbeStats().hits).toBe(1);
    expect(getProbeStats().misses).toBe(1);
  });

  it('explicit tools-not-supported error → false, cached', async () => {
    const a = fakeAdapter('tools-unsupported');
    expect(await getFunctionCallingVerdict(a, 'probe-test', 'model-b')).toBe(false);
    expect(await getFunctionCallingVerdict(a, 'probe-test', 'model-b')).toBe(false);
    expect(a.calls).toBe(1);
  });

  it('billing/auth errors → provider-dead (not an FC verdict, short negative cache)', async () => {
    const a = fakeAdapter('billing');
    expect(await getFunctionCallingVerdict(a, 'probe-test', 'model-c')).toBe('provider-dead');
    // non-FC verdicts get a SHORT memory-only negative cache: the burst of
    // selections within one request (and near-in-time requests) must not
    // re-probe the same dead route repeatedly
    expect(await getFunctionCallingVerdict(a, 'probe-test', 'model-c')).toBe('provider-dead');
    expect(a.calls).toBe(1);
  });

  it('negative cache expires after the short TTL → dead route is re-probed', async () => {
    const a = fakeAdapter('billing');
    expect(await getFunctionCallingVerdict(a, 'probe-test', 'model-dead')).toBe('provider-dead');
    expect(a.calls).toBe(1);
    vi.useFakeTimers({ now: Date.now() });
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000); // past the 10min default
      expect(await getFunctionCallingVerdict(a, 'probe-test', 'model-dead')).toBe('provider-dead');
      expect(a.calls).toBe(2); // TTL expired — re-probed
    } finally {
      vi.useRealTimers();
    }
  });

  it('ambiguous (null) verdicts also get the short negative cache', async () => {
    const a = fakeAdapter('throw');
    expect(await getFunctionCallingVerdict(a, 'probe-test', 'model-null')).toBe(null);
    expect(await getFunctionCallingVerdict(a, 'probe-test', 'model-null')).toBe(null);
    expect(a.calls).toBe(1);
  });

  it('different providers/models probe independently (key includes both)', async () => {
    const a = fakeAdapter('success');
    const b = fakeAdapter('tools-unsupported');
    expect(await getFunctionCallingVerdict(a, 'probe-test', 'same-model')).toBe(true);
    expect(await getFunctionCallingVerdict(b, 'other-provider', 'same-model')).toBe(false);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
  });
});
