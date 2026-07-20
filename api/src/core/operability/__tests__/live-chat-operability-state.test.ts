// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-F — LiveChatOperabilityStore unit coverage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  LiveChatOperabilityStore,
  buildLiveStateKey,
} from '../live-chat-operability-state';
import { classifyProviderError } from '../../orchestration/failures/provider-error-classifier';

describe('LiveChatOperabilityStore', () => {
  let store: LiveChatOperabilityStore;

  beforeEach(() => {
    store = new LiveChatOperabilityStore();
  });

  it('record(ok=true) marks chatReady and eligibleForCriticalRole', () => {
    const s = store.record({
      providerId: 'deepinfra',
      routeId: 'deepinfra',
      modelId: 'Qwen/Qwen3-235B',
      ok: true,
      httpStatus: 200,
      latencyMs: 870,
      source: 'direct_chat_probe',
    });
    expect(s.chatReady).toBe(true);
    expect(s.eligibleForCriticalRole).toBe(true);
    expect(s.cooldownUntil).toBeUndefined();
    expect(s.lastErrorKind).toBeUndefined();
    expect(s.lastChatSuccessAt).toBeDefined();
    expect(s.source).toBe('direct_chat_probe');
  });

  it('record insufficient_credits → chatReady=false, providerHealthy reflected, cooldown set', () => {
    const cls = classifyProviderError({
      status: 403,
      body: '{"title":"Forbidden","status":403,"message":"You\'ve run out of credits"}',
    });
    const s = store.record({
      providerId: 'aiml',
      routeId: 'aiml',
      modelId: 'glm-4.5-air',
      ok: false,
      httpStatus: 403,
      errorClassification: cls,
      source: 'direct_chat_probe',
    });
    expect(s.chatReady).toBe(false);
    expect(s.eligibleForCriticalRole).toBe(false);
    expect(s.lastErrorKind).toBe('insufficient_credits');
    expect(s.cooldownUntil).toBeDefined();
    expect(new Date(s.cooldownUntil!).getTime()).toBeGreaterThan(Date.now());
  });

  it('record consumer_suspended → 24h cooldown', () => {
    const cls = classifyProviderError({
      status: 403,
      body: 'Consumer has been suspended. PERMISSION_DENIED CONSUMER_SUSPENDED',
    });
    const s = store.record({
      providerId: 'gemini',
      routeId: 'gemini',
      modelId: 'gemini-3.1-pro-preview',
      ok: false,
      httpStatus: 403,
      errorClassification: cls,
      source: 'direct_chat_probe',
    });
    expect(s.chatReady).toBe(false);
    expect(s.lastErrorKind).toBe('consumer_suspended');
    const cooldownAt = new Date(s.cooldownUntil!).getTime();
    const expected24h = Date.now() + 24 * 60 * 60 * 1000;
    // within 1 minute of expected (test timing tolerance)
    expect(Math.abs(cooldownAt - expected24h)).toBeLessThan(60_000);
  });

  it('record model_not_supported → modelRouteCompatible=false reflected via lastErrorKind', () => {
    const cls = classifyProviderError({
      status: 400,
      body: '{"error":{"message":"model_not_supported","code":"model_not_supported"}}',
    });
    const s = store.record({
      providerId: 'huggingface',
      routeId: 'huggingface',
      modelId: 'meta-llama/Llama-3.2-11B-Vision-Instruct',
      ok: false,
      httpStatus: 400,
      errorClassification: cls,
      source: 'direct_chat_probe',
    });
    expect(s.chatReady).toBe(false);
    expect(s.lastErrorKind).toBe('model_not_supported');
  });

  it('successful re-probe clears cooldown', () => {
    const failCls = classifyProviderError({ status: 403, body: 'insufficient_credits' });
    store.record({
      providerId: 'p',
      routeId: 'p',
      modelId: 'm',
      ok: false,
      errorClassification: failCls,
      source: 'direct_chat_probe',
    });
    const s2 = store.record({
      providerId: 'p',
      routeId: 'p',
      modelId: 'm',
      ok: true,
      httpStatus: 200,
      source: 'direct_chat_probe',
    });
    expect(s2.chatReady).toBe(true);
    expect(s2.cooldownUntil).toBeUndefined();
    expect(s2.lastErrorKind).toBeUndefined();
  });

  it('isEligibleForCriticalRole returns false when route absent', () => {
    expect(
      store.isEligibleForCriticalRole({ providerId: 'x', routeId: 'x', modelId: 'm' }),
    ).toBe(false);
  });

  it('isEligibleForCriticalRole returns true after successful record', () => {
    store.record({
      providerId: 'deepinfra',
      routeId: 'deepinfra',
      modelId: 'Qwen',
      ok: true,
      source: 'direct_chat_probe',
    });
    expect(
      store.isEligibleForCriticalRole({
        providerId: 'deepinfra',
        routeId: 'deepinfra',
        modelId: 'Qwen',
      }),
    ).toBe(true);
  });

  it('buildLiveStateKey is case-insensitive on provider/route', () => {
    const a = buildLiveStateKey({ providerId: 'DeepInfra', routeId: 'DEEPINFRA', modelId: 'm' });
    const b = buildLiveStateKey({ providerId: 'deepinfra', routeId: 'deepinfra', modelId: 'm' });
    expect(a).toBe(b);
  });

  it('snapshot returns all known states', () => {
    store.record({ providerId: 'p1', routeId: 'r1', modelId: 'm1', ok: true, source: 'direct_chat_probe' });
    store.record({ providerId: 'p2', routeId: 'r2', modelId: 'm2', ok: true, source: 'execution_feedback' });
    expect(store.snapshot()).toHaveLength(2);
  });
});
