// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-F — planner-side live-operability filter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LiveChatOperabilityStore } from '../live-chat-operability-state';
import {
  filterCandidatesByLiveOperability,
  DEFAULT_LIVE_OPERABILITY_POLICY,
} from '../live-chat-operability-planner-filter';
import { classifyProviderError } from '../../orchestration/failures/provider-error-classifier';
import type { ModelCandidate } from '../../orchestration/model-selection/model-role-types';

function fakeCandidate(providerId: string, modelId: string): ModelCandidate {
  return {
    model: {
      id: modelId,
      provider: providerId,
      providerId,
      name: modelId,
      capabilities: ['chat'] as never[],
      contextWindow: 8000,
      maxOutputTokens: 4096,
      inputCostPer1k: 0.001,
      outputCostPer1k: 0.002,
      performance: { latencyMs: 500, throughput: 100, quality: 0.85, reliability: 0.95 },
      status: 'active' as never,
      balanceStatus: 'has-credits' as never,
    } as ModelCandidate['model'],
    providerId,
    providerHealthy: true,
    hasCredits: true,
    rateLimited: false,
    isLocal: false,
    estimatedCostPerCallUsd: 0.001,
  };
}

describe('filterCandidatesByLiveOperability', () => {
  let store: LiveChatOperabilityStore;
  beforeEach(() => {
    store = new LiveChatOperabilityStore();
  });

  it('passes everything through when policy disabled (default)', () => {
    const candidates = [fakeCandidate('aiml', 'glm-4.5-air'), fakeCandidate('deepinfra', 'Qwen')];
    const r = filterCandidatesByLiveOperability(candidates, DEFAULT_LIVE_OPERABILITY_POLICY);
    expect(r.allowed).toHaveLength(2);
    expect(r.rejected).toHaveLength(0);
  });

  it('blocks aiml/glm-4.5-air after insufficient_credits recorded', () => {
    const cls = classifyProviderError({ status: 403, body: 'insufficient_credits' });
    store.record({
      providerId: 'aiml',
      routeId: 'aiml',
      modelId: 'glm-4.5-air',
      ok: false,
      errorClassification: cls,
      source: 'direct_chat_probe',
    });
    const candidates = [
      fakeCandidate('aiml', 'glm-4.5-air'),
      fakeCandidate('deepinfra', 'Qwen3-235B'),
    ];
    const r = filterCandidatesByLiveOperability(candidates, {
      requireLiveChatOperability: true,
      allowUnknownLiveOperability: true,
      preferRecentChatSuccess: false,
      liveChatSuccessMaxAgeMs: 24 * 60 * 60 * 1000,
      storeOverride: store,
    });
    expect(r.allowed).toHaveLength(1);
    expect(r.allowed[0].providerId).toBe('deepinfra');
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toBe('cooldown_active');
    expect(r.rejected[0].providerId).toBe('aiml');
    expect(r.rejected[0].lastErrorKind).toBe('insufficient_credits');
  });

  it('blocks gemini after consumer_suspended', () => {
    const cls = classifyProviderError({ status: 403, body: 'Consumer has been suspended.' });
    store.record({
      providerId: 'gemini',
      routeId: 'gemini',
      modelId: 'gemini-3.1-pro-preview',
      ok: false,
      errorClassification: cls,
      source: 'direct_chat_probe',
    });
    const r = filterCandidatesByLiveOperability(
      [fakeCandidate('gemini', 'gemini-3.1-pro-preview')],
      {
        requireLiveChatOperability: true,
        allowUnknownLiveOperability: true,
        preferRecentChatSuccess: false,
        liveChatSuccessMaxAgeMs: 24 * 60 * 60 * 1000,
        storeOverride: store,
      },
    );
    expect(r.allowed).toHaveLength(0);
    expect(r.rejected[0].reason).toBe('cooldown_active');
    expect(r.rejected[0].lastErrorKind).toBe('consumer_suspended');
  });

  it('allows unknown live state when allowUnknownLiveOperability=true', () => {
    const r = filterCandidatesByLiveOperability(
      [fakeCandidate('never-probed', 'm1')],
      {
        requireLiveChatOperability: true,
        allowUnknownLiveOperability: true,
        preferRecentChatSuccess: false,
        liveChatSuccessMaxAgeMs: 24 * 60 * 60 * 1000,
        storeOverride: store,
      },
    );
    expect(r.allowed).toHaveLength(1);
    expect(r.rejected).toHaveLength(0);
  });

  it('rejects unknown live state when allowUnknownLiveOperability=false', () => {
    const r = filterCandidatesByLiveOperability(
      [fakeCandidate('never-probed', 'm1')],
      {
        requireLiveChatOperability: true,
        allowUnknownLiveOperability: false,
        preferRecentChatSuccess: false,
        liveChatSuccessMaxAgeMs: 24 * 60 * 60 * 1000,
        storeOverride: store,
      },
    );
    expect(r.allowed).toHaveLength(0);
    expect(r.rejected[0].reason).toBe('live_chat_state_unknown');
  });

  it('preferRecentChatSuccess ranks recent-success ahead of less-recent', async () => {
    store.record({
      providerId: 'p-old',
      routeId: 'p-old',
      modelId: 'm',
      ok: true,
      source: 'direct_chat_probe',
      observedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    store.record({
      providerId: 'p-new',
      routeId: 'p-new',
      modelId: 'm',
      ok: true,
      source: 'direct_chat_probe',
      observedAt: new Date().toISOString(),
    });
    const r = filterCandidatesByLiveOperability(
      [fakeCandidate('p-old', 'm'), fakeCandidate('p-new', 'm')],
      {
        requireLiveChatOperability: true,
        allowUnknownLiveOperability: false,
        preferRecentChatSuccess: true,
        liveChatSuccessMaxAgeMs: 24 * 60 * 60 * 1000,
        storeOverride: store,
      },
    );
    expect(r.allowed.map((c) => c.providerId)).toEqual(['p-new', 'p-old']);
  });
});
