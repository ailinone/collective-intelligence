// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderHealthRegistry — granular health tracking by (providerId, modelId).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { classifyProviderError } from '../error-classification';
import {
  getProviderHealthRegistry,
  resetProviderHealthRegistryForTesting,
} from '../provider-health-registry';

describe('ProviderHealthRegistry', () => {
  beforeEach(() => {
    resetProviderHealthRegistryForTesting();
  });

  it('records probe outcome with TTL based on state', () => {
    const reg = getProviderHealthRegistry();
    const before = Date.now();
    const record = reg.recordProbe({
      key: { providerId: 'aihubmix' },
      state: 'auth_failed',
      reason: 'missing API key',
    });
    expect(record.state).toBe('auth_failed');
    expect(record.errorClass).toBeUndefined();
    expect(record.consecutiveFailures).toBe(1);
    expect(record.consecutiveSuccesses).toBe(0);
    expect(record.nextProbeAfter).toBeDefined();
    const next = Date.parse(record.nextProbeAfter!);
    // auth_failed has long TTL (~6h)
    expect(next - before).toBeGreaterThan(60 * 60 * 1000);
  });

  it('lookup falls back from (providerId, modelId) to (providerId)', () => {
    const reg = getProviderHealthRegistry();
    reg.recordProbe({
      key: { providerId: 'openai' },
      state: 'auth_failed',
      reason: 'bad key',
    });
    // No model-level entry exists; lookup should return the provider-level one.
    const found = reg.lookup({ providerId: 'openai', modelId: 'gpt-4o-mini' });
    expect(found?.state).toBe('auth_failed');
  });

  it('exact lookup does NOT fall back', () => {
    const reg = getProviderHealthRegistry();
    reg.recordProbe({ key: { providerId: 'openai' }, state: 'healthy' });
    const found = reg.lookupExact({ providerId: 'openai', modelId: 'gpt-4o-mini' });
    expect(found).toBeUndefined();
  });

  it('granularity: model-level failure does NOT poison other models', () => {
    const reg = getProviderHealthRegistry();
    // (aihubmix, gpt-4o-mini) → model_not_found
    reg.recordExecution({
      key: { providerId: 'aihubmix', modelId: 'gpt-4o-mini' },
      success: false,
      classification: classifyProviderError(
        new Error("Model 'gpt-4o-mini' not found"),
      ),
    });
    // (aihubmix, claude-haiku-4-5) should be unaffected
    const otherModel = reg.lookupExact({
      providerId: 'aihubmix',
      modelId: 'claude-haiku-4-5',
    });
    expect(otherModel).toBeUndefined();
    // Provider-level entry should also NOT be marked
    const providerLevel = reg.lookupExact({ providerId: 'aihubmix' });
    expect(providerLevel).toBeUndefined();
    // Only the affected tuple is poisoned
    const poisoned = reg.lookupExact({
      providerId: 'aihubmix',
      modelId: 'gpt-4o-mini',
    });
    expect(poisoned?.state).toBe('model_not_found');
  });

  it('account-scoped error (auth_failed) marks provider-level entry', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });
    const lookup = reg.lookup({ providerId: 'aihubmix', modelId: 'any-model' });
    expect(lookup?.state).toBe('auth_failed');
  });

  it('recovers state after 3 consecutive successes', () => {
    const reg = getProviderHealthRegistry();
    const key = { providerId: 'openai' };
    // Start in degraded
    reg.recordExecution({
      key,
      success: false,
      classification: classifyProviderError({ status: 503 }),
    });
    expect(reg.lookupExact(key)?.state).toBe('degraded');
    // 1st success — still degraded (consecutiveSuccesses=1)
    reg.recordExecution({ key, success: true, latencyMs: 100 });
    expect(reg.lookupExact(key)?.state).toBe('degraded');
    expect(reg.lookupExact(key)?.consecutiveSuccesses).toBe(1);
    // 2nd success — still degraded
    reg.recordExecution({ key, success: true, latencyMs: 100 });
    expect(reg.lookupExact(key)?.state).toBe('degraded');
    expect(reg.lookupExact(key)?.consecutiveSuccesses).toBe(2);
    // 3rd success — recovered
    reg.recordExecution({ key, success: true, latencyMs: 100 });
    const recovered = reg.lookupExact(key);
    expect(recovered?.state).toBe('healthy');
    expect(recovered?.consecutiveFailures).toBe(0);
  });

  it('updates p50 latency via EMA', () => {
    const reg = getProviderHealthRegistry();
    const key = { providerId: 'groq', modelId: 'llama-3.3-70b' };
    reg.recordExecution({ key, success: true, latencyMs: 200 });
    expect(reg.lookupExact(key)?.p50LatencyMs).toBe(200);
    reg.recordExecution({ key, success: true, latencyMs: 100 });
    // EMA with alpha 0.1: 0.1 * 100 + 0.9 * 200 = 190
    const p50 = reg.lookupExact(key)?.p50LatencyMs;
    expect(p50).toBeGreaterThan(180);
    expect(p50).toBeLessThan(200);
  });

  it('snapshot returns all records', () => {
    const reg = getProviderHealthRegistry();
    reg.recordProbe({ key: { providerId: 'a' }, state: 'healthy' });
    reg.recordProbe({ key: { providerId: 'b' }, state: 'auth_failed' });
    reg.recordProbe({ key: { providerId: 'c', modelId: 'x' }, state: 'model_not_found' });
    expect(reg.size()).toBe(3);
    expect(reg.snapshot()).toHaveLength(3);
  });

  it('healthy state has long TTL but failure resets cooldown', () => {
    const reg = getProviderHealthRegistry();
    const key = { providerId: 'openai' };
    reg.recordProbe({ key, state: 'healthy' });
    const healthyTtl = reg.lookupExact(key)!.ttlMs;
    expect(healthyTtl).toBeGreaterThan(60_000);
    reg.recordExecution({
      key,
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });
    const failTtl = reg.lookupExact(key)!.ttlMs;
    expect(failTtl).toBeGreaterThanOrEqual(healthyTtl);
  });
});
