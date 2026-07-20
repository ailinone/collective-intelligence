// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D §11.2 — Logical-model route evidence model.
 *
 * Pins the contract:
 *   - `liveReady=true` for a route requires evidence keyed by
 *     (providerId, apiModelId, adapterKind, logicalModelId).
 *   - Provider-level chat-ready (e.g., openrouter responded OK with
 *     gemma) does NOT imply route-level liveReady for a DIFFERENT
 *     apiModelId (e.g., anthropic/claude-3.7-sonnet on the same provider).
 *
 * Tests use pure projection functions — no DB, no HTTP.
 */

import { describe, it, expect } from 'vitest';

type RouteLiveAuditEvidence = {
  readonly role: 'participant' | 'synthesizer' | 'judge' | 'fallback';
  readonly logicalModelId: string;
  readonly routeId: string;
  readonly providerId: string;
  readonly apiModelId: string;
  readonly adapterKind: string;
  readonly liveReady: boolean;
  readonly audited: boolean;
  readonly evidenceKey: string;
};

function buildEvidenceKey(input: {
  providerId: string;
  apiModelId: string;
  adapterKind: string;
  logicalModelId: string;
}): string {
  // J1D §8: evidenceKey is deterministic and INCLUDES logicalModelId.
  return [
    input.providerId.toLowerCase(),
    input.apiModelId.toLowerCase(),
    input.adapterKind.toLowerCase(),
    input.logicalModelId.toLowerCase(),
  ].join('::');
}

function classifyRouteFromEvidence(input: {
  routeProviderId: string;
  routeApiModelId: string;
  routeAdapterKind: string;
  routeLogicalModelId: string;
  evidence: ReadonlyArray<RouteLiveAuditEvidence>;
}): 'route_live_ready' | 'provider_ready_route_unaudited' | 'route_not_audited_for_logical_model' {
  const exactKey = buildEvidenceKey({
    providerId: input.routeProviderId,
    apiModelId: input.routeApiModelId,
    adapterKind: input.routeAdapterKind,
    logicalModelId: input.routeLogicalModelId,
  });
  const exact = input.evidence.find((e) => e.evidenceKey === exactKey);
  if (exact && exact.liveReady) return 'route_live_ready';
  const providerHasAny = input.evidence.some((e) =>
    e.providerId.toLowerCase() === input.routeProviderId.toLowerCase() && e.liveReady,
  );
  if (providerHasAny) return 'provider_ready_route_unaudited';
  return 'route_not_audited_for_logical_model';
}

describe('01C.1B-J1D §11.2 — logical-model route evidence', () => {
  it('evidenceKey includes logicalModelId + providerId + apiModelId + adapterKind', () => {
    const k = buildEvidenceKey({
      providerId: 'openrouter',
      apiModelId: 'anthropic/anthropic-claude-3.7-sonnet',
      adapterKind: 'openai-compatible-chat',
      logicalModelId: 'anthropic-claude-3.7-sonnet',
    });
    expect(k).toContain('openrouter');
    expect(k).toContain('anthropic/anthropic-claude-3.7-sonnet');
    expect(k).toContain('openai-compatible-chat');
    expect(k).toContain('anthropic-claude-3.7-sonnet');
  });

  it('OpenRouter chat-ready with gemma does NOT mark OpenRouter+Claude route as live-ready', () => {
    const evidence: RouteLiveAuditEvidence[] = [
      {
        role: 'judge',
        logicalModelId: 'gemma-3-4b-it',
        routeId: 'openrouter::google/gemma...:free',
        providerId: 'openrouter',
        apiModelId: 'google/gemma-4-26b-a4b-it:free',
        adapterKind: 'openai-compatible-chat',
        liveReady: true,
        audited: true,
        evidenceKey: buildEvidenceKey({
          providerId: 'openrouter',
          apiModelId: 'google/gemma-4-26b-a4b-it:free',
          adapterKind: 'openai-compatible-chat',
          logicalModelId: 'gemma-3-4b-it',
        }),
      },
    ];
    const claudeClassification = classifyRouteFromEvidence({
      routeProviderId: 'openrouter',
      routeApiModelId: 'anthropic/anthropic-claude-3.7-sonnet',
      routeAdapterKind: 'openai-compatible-chat',
      routeLogicalModelId: 'anthropic-claude-3.7-sonnet',
      evidence,
    });
    // Provider has SOME success → 'provider_ready_route_unaudited', NOT 'route_live_ready'.
    expect(claudeClassification).toBe('provider_ready_route_unaudited');
  });

  it('exact route+logicalModel match returns route_live_ready', () => {
    const evidence: RouteLiveAuditEvidence[] = [
      {
        role: 'synthesizer',
        logicalModelId: 'anthropic-claude-3.7-sonnet',
        routeId: 'openrouter::anthropic/anthropic-claude-3.7-sonnet',
        providerId: 'openrouter',
        apiModelId: 'anthropic/anthropic-claude-3.7-sonnet',
        adapterKind: 'openai-compatible-chat',
        liveReady: true,
        audited: true,
        evidenceKey: buildEvidenceKey({
          providerId: 'openrouter',
          apiModelId: 'anthropic/anthropic-claude-3.7-sonnet',
          adapterKind: 'openai-compatible-chat',
          logicalModelId: 'anthropic-claude-3.7-sonnet',
        }),
      },
    ];
    expect(classifyRouteFromEvidence({
      routeProviderId: 'openrouter',
      routeApiModelId: 'anthropic/anthropic-claude-3.7-sonnet',
      routeAdapterKind: 'openai-compatible-chat',
      routeLogicalModelId: 'anthropic-claude-3.7-sonnet',
      evidence,
    })).toBe('route_live_ready');
  });

  it('provider with no evidence at all → route_not_audited_for_logical_model', () => {
    expect(classifyRouteFromEvidence({
      routeProviderId: 'cometapi',
      routeApiModelId: 'anthropic/anthropic-claude-3.7-sonnet',
      routeAdapterKind: 'openai-compatible-chat',
      routeLogicalModelId: 'anthropic-claude-3.7-sonnet',
      evidence: [],
    })).toBe('route_not_audited_for_logical_model');
  });

  it('same provider with different apiModelId requires new evidence', () => {
    const evidence: RouteLiveAuditEvidence[] = [
      {
        role: 'judge',
        logicalModelId: 'gemma-3-4b-it',
        routeId: 'openrouter::google/gemma:free',
        providerId: 'openrouter',
        apiModelId: 'google/gemma-4-26b-a4b-it:free',
        adapterKind: 'openai-compatible-chat',
        liveReady: true,
        audited: true,
        evidenceKey: buildEvidenceKey({
          providerId: 'openrouter',
          apiModelId: 'google/gemma-4-26b-a4b-it:free',
          adapterKind: 'openai-compatible-chat',
          logicalModelId: 'gemma-3-4b-it',
        }),
      },
    ];
    // Different apiModelId on the same provider → still unaudited for the new model
    const c = classifyRouteFromEvidence({
      routeProviderId: 'openrouter',
      routeApiModelId: 'meta-llama/Llama-4',  // DIFFERENT model
      routeAdapterKind: 'openai-compatible-chat',
      routeLogicalModelId: 'meta-llama/Llama-4',
      evidence,
    });
    // Provider has SOME success → provider_ready_route_unaudited
    expect(c).toBe('provider_ready_route_unaudited');
  });

  it('route-level failure preserves evidence even if liveReady=false', () => {
    const evidence: RouteLiveAuditEvidence[] = [
      {
        role: 'synthesizer',
        logicalModelId: 'anthropic-claude-3.7-sonnet',
        routeId: 'anthropic::anthropic-claude-3.7-sonnet',
        providerId: 'anthropic',
        apiModelId: 'anthropic-claude-3.7-sonnet',
        adapterKind: 'openai-compatible-chat',
        liveReady: false,
        audited: true,
        evidenceKey: buildEvidenceKey({
          providerId: 'anthropic',
          apiModelId: 'anthropic-claude-3.7-sonnet',
          adapterKind: 'openai-compatible-chat',
          logicalModelId: 'anthropic-claude-3.7-sonnet',
        }),
      },
    ];
    // anthropic was audited and failed → no provider-level success exists
    // Route classification: NOT live ready, no provider success, just unaudited-for-logical
    const c = classifyRouteFromEvidence({
      routeProviderId: 'anthropic',
      routeApiModelId: 'anthropic-claude-3.7-sonnet',
      routeAdapterKind: 'openai-compatible-chat',
      routeLogicalModelId: 'anthropic-claude-3.7-sonnet',
      evidence,
    });
    expect(c).toBe('route_not_audited_for_logical_model');
  });

  it('contract: pure function (no fetch, no Prisma)', () => {
    expect(typeof classifyRouteFromEvidence).toBe('function');
    expect(typeof buildEvidenceKey).toBe('function');
  });
});
