// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Workstream F (2026-08-17) — quarantine end-to-end at the hub + pool level.
 *
 * The production gap: a Google 401 `ACCESS_TOKEN_TYPE_UNSUPPORTED` message
 * (SDK shape "[401] ...", no "HTTP 401" text) matched none of the hub's
 * legacy patterns → errorType 'unknown' → the hub never quarantined google
 * and every request re-paid the 401 rung. These tests pin:
 *   1. the bracketed-status message classifies as auth → auth_failed
 *   2. auth_failed/no_credits providers are excluded by the pool builder
 *   3. getQuarantinedProviders() surfaces them
 *   4. recordRevalidationSuccess() restores them
 *
 * The hub is a process singleton — each test uses a unique provider key.
 */
import { describe, expect, it } from 'vitest';
import { getProviderOperabilityHub } from '../provider-operability-hub';
import { buildChatExecutionPool } from '../pool/pool-builder';
import type { Model } from '@/types';

const chatModel = (id: string, provider: string): Model =>
  ({
    id,
    provider,
    name: id,
    status: 'active',
    capabilities: ['chat'],
    performance: { quality: 0.9 },
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
  }) as unknown as Model;

describe('hub quarantine (Workstream F)', () => {
  it('google "[401] Access token type unsupported" message classifies as auth → auth_failed', () => {
    const hub = getProviderOperabilityHub();
    const key = 'wf-google-401';
    // Exactly the shape the @google/generative-ai SDK throws — no "HTTP 401".
    hub.recordExecution(
      key,
      false,
      undefined,
      'Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent: [401] ACCESS_TOKEN_TYPE_UNSUPPORTED'
    );
    expect(hub.getProviderState(key).operabilityState).toBe('auth_failed');
    expect(hub.isProviderUsable(key)).toBe(false);
  });

  it('phala-style bare 401 and helicone 429-insufficient-credits quarantine correctly', () => {
    const hub = getProviderOperabilityHub();
    hub.recordExecution('wf-phala-401', false, 401, 'unauthorized');
    expect(hub.getProviderState('wf-phala-401').operabilityState).toBe('auth_failed');
    hub.recordExecution('wf-helicone-429', false, 429, '429 insufficient credits');
    expect(hub.getProviderState('wf-helicone-429').operabilityState).toBe('no_credits');
  });

  it('buildChatExecutionPool excludes quarantined providers from the eligible pool', () => {
    const hub = getProviderOperabilityHub();
    hub.recordExecution('wf-dead-aggregator', false, 401, '[401] unauthorized');
    expect(hub.isProviderUsable('wf-dead-aggregator')).toBe(false);

    const pool = buildChatExecutionPool(
      [
        chatModel('m1', 'wf-dead-aggregator'),
        chatModel('m2', 'wf-alive-provider'),
      ],
      0.5
    );
    expect(pool.models.map((m) => m.provider)).toEqual(['wf-alive-provider']);
    const stage = pool.stages.find((s) => s.name === 'operability_filter');
    expect(stage).toBeDefined();
    expect(stage!.outputCount).toBe(1);
  });

  it('getQuarantinedProviders lists auth_failed/no_credits providers', () => {
    const hub = getProviderOperabilityHub();
    hub.recordExecution('wf-quar-list-a', false, 401, 'invalid api key');
    hub.recordExecution('wf-quar-list-b', false, 402);
    hub.recordExecution('wf-quar-list-c', true);
    const quarantined = new Set(hub.getQuarantinedProviders());
    expect(quarantined.has('wf-quar-list-a')).toBe(true);
    expect(quarantined.has('wf-quar-list-b')).toBe(true);
    expect(quarantined.has('wf-quar-list-c')).toBe(false);
  });

  it('recordRevalidationSuccess restores a quarantined provider (and clears the overlay)', () => {
    const hub = getProviderOperabilityHub();
    const key = 'wf-restore-me';
    hub.recordExecution(key, false, 401, 'invalid api key');
    expect(hub.getProviderState(key).operabilityState).toBe('auth_failed');

    hub.recordRevalidationSuccess(key);
    expect(hub.isProviderUsable(key)).toBe(true);
    expect(hub.getQuarantinedProviders()).not.toContain(key);
  });

  it('timeout failures do NOT quarantine (transient stays eligible)', () => {
    const hub = getProviderOperabilityHub();
    const key = 'wf-transient-timeout';
    hub.recordExecution(key, false, undefined, 'request timed out');
    expect(hub.getProviderState(key).operabilityState).not.toBe('auth_failed');
    expect(hub.isProviderUsable(key)).toBe(true);
  });
});
