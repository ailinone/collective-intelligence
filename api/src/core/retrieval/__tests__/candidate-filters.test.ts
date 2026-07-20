// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * candidate-filters.test.ts — MVP 5A
 *
 * Each filter is tested independently with hand-crafted FilterCandidate
 * inputs. The candidate-retriever-structural test covers the composed
 * pipeline; this file covers the individual contracts.
 */

import { describe, expect, it } from 'vitest';
import {
  filterByCapability,
  filterByContextWindow,
  filterByExplicitPin,
  filterByLifecycle,
  filterByPrivacy,
  filterByReadiness,
  type FilterCandidate,
} from '../candidate-filters';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import { LEGACY_MODELS_FIXTURE } from '../../registry/__tests__/fixtures/legacy-models.fixture';
import type { ProviderModelRoute } from '../../registry/model-route';
import type { CanonicalModel } from '../../registry/canonical-model';

function buildCandidate(
  providerId: string,
  modelId: string,
  overrides: {
    route?: Partial<ProviderModelRoute>;
    canonical?: Partial<CanonicalModel>;
  } = {},
): FilterCandidate {
  const registry = buildFixtureRegistry();
  const snap = LEGACY_MODELS_FIXTURE.find(
    (m) => m.providerId === providerId && m.id === modelId,
  );
  const oid = snap?.uid ?? `${providerId}:${modelId}`;
  const offering = registry.lookupOffering(oid)!;
  const canonical = registry.lookupCanonicalModel(offering.canonicalModelId)!;
  const route = registry.routesForOffering(oid)[0];
  return {
    canonical: { ...canonical, ...overrides.canonical } as CanonicalModel,
    offering,
    route: { ...route, ...overrides.route } as ProviderModelRoute,
  };
}

describe('filterByExplicitPin', () => {
  it('passes when no pin is provided', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7');
    expect(filterByExplicitPin(c, null).pass).toBe(true);
    expect(filterByExplicitPin(c, undefined).pass).toBe(true);
  });

  it('passes when routeId matches', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7');
    const verdict = filterByExplicitPin(c, {
      source: 'request_modelPin',
      routeId: c.route.routeId,
      allowSubstitution: false,
    });
    expect(verdict.pass).toBe(true);
  });

  it('fails when routeId does not match (reason=pin_route_mismatch)', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7');
    const verdict = filterByExplicitPin(c, {
      source: 'request_modelPin',
      routeId: 'wrong-id',
      allowSubstitution: false,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe('pin_route_mismatch');
  });

  it('passes when offeringId matches and no routeId', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7');
    const verdict = filterByExplicitPin(c, {
      source: 'experiment_pin',
      offeringId: c.offering.offeringId,
      allowSubstitution: false,
    });
    expect(verdict.pass).toBe(true);
  });

  it('passes when canonicalModelId matches only', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7');
    const verdict = filterByExplicitPin(c, {
      source: 'internal_pin',
      canonicalModelId: c.canonical.canonicalModelId,
      allowSubstitution: false,
    });
    expect(verdict.pass).toBe(true);
  });
});

describe('filterByPrivacy', () => {
  it('passes external route when privacy is standard', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7');
    expect(filterByPrivacy(c, 'standard').pass).toBe(true);
  });

  it('passes external route when privacy is local_preferred', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7');
    expect(filterByPrivacy(c, 'local_preferred').pass).toBe(true);
  });

  it('REJECTS external route when privacy is local_required', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7');
    const verdict = filterByPrivacy(c, 'local_required');
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('privacy_local_required_but_route_is_external');
  });

  it('passes local route when privacy is local_required', () => {
    const c = buildCandidate('ollama', 'llama-3.3-70b');
    expect(filterByPrivacy(c, 'local_required').pass).toBe(true);
  });

  it('passes self_hosted route when privacy is local_required', () => {
    const c = buildCandidate('vllm', 'qwen-3-72b');
    expect(filterByPrivacy(c, 'local_required').pass).toBe(true);
  });
});

describe('filterByCapability', () => {
  it('passes when no caps required', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7');
    expect(filterByCapability(c, undefined).pass).toBe(true);
    expect(filterByCapability(c, []).pass).toBe(true);
  });

  it('passes when route supports all required caps', () => {
    const c = buildCandidate('openai', 'gpt-5.5-pro');
    expect(filterByCapability(c, ['chat', 'tools', 'json_mode', 'vision']).pass).toBe(true);
  });

  it('rejects when a required cap is missing', () => {
    const c = buildCandidate('mistral', 'mistral-large-2'); // no vision
    const verdict = filterByCapability(c, ['vision']);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('missing_capability:vision');
  });

  it('uses ontology to resolve aliases (function_calling → tools)', () => {
    const c = buildCandidate('openai', 'gpt-5.5-pro');
    expect(filterByCapability(c, ['function_calling']).pass).toBe(true);
  });
});

describe('filterByContextWindow', () => {
  it('passes when no minimum specified', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7');
    expect(filterByContextWindow(c, undefined).pass).toBe(true);
    expect(filterByContextWindow(c, 0).pass).toBe(true);
  });

  it('passes when route contextWindow >= min', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7'); // 200k
    expect(filterByContextWindow(c, 100_000).pass).toBe(true);
  });

  it('rejects when route contextWindow < min', () => {
    const c = buildCandidate('ollama', 'mistral-small-3'); // 32k
    const verdict = filterByContextWindow(c, 200_000);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('context_below_min');
  });
});

describe('filterByReadiness', () => {
  it('passes a healthy route', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7', {
      route: {
        healthState: 'healthy',
        creditStatus: 'has_credits',
        minimalChatStatus: 'verified',
      },
    });
    expect(filterByReadiness(c).pass).toBe(true);
  });

  it('rejects when healthState=auth_failed', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7', {
      route: { healthState: 'auth_failed' },
    });
    expect(filterByReadiness(c).reason).toBe('route_auth_failed');
  });

  it('rejects when creditStatus=no_credits', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7', {
      route: { creditStatus: 'no_credits' },
    });
    expect(filterByReadiness(c).reason).toBe('route_no_credits');
  });

  it('rejects when healthState=rate_limited', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7', {
      route: { healthState: 'rate_limited' },
    });
    expect(filterByReadiness(c).reason).toBe('route_rate_limited');
  });

  it('rejects when minimalChatStatus=failed', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7', {
      route: { minimalChatStatus: 'failed' },
    });
    expect(filterByReadiness(c).reason).toBe('route_minimal_chat_failed');
  });
});

describe('filterByLifecycle', () => {
  it('passes current lifecycle without policy', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7', {
      canonical: { lifecycle: 'current' },
    });
    expect(filterByLifecycle(c).pass).toBe(true);
  });

  it('rejects deprecated without allowDeprecated', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7', {
      canonical: { lifecycle: 'deprecated' },
    });
    expect(filterByLifecycle(c).pass).toBe(false);
  });

  it('passes deprecated when allowDeprecated=true', () => {
    const c = buildCandidate('anthropic', 'claude-opus-4-7', {
      canonical: { lifecycle: 'deprecated' },
    });
    expect(filterByLifecycle(c, { allowDeprecated: true }).pass).toBe(true);
  });

  it('rejects preview without allowPreview', () => {
    const c = buildCandidate('openai', 'o3-mini-preview', {
      canonical: { lifecycle: 'preview' },
    });
    expect(filterByLifecycle(c).pass).toBe(false);
  });

  it('passes preview when allowPreview=true', () => {
    const c = buildCandidate('openai', 'o3-mini-preview', {
      canonical: { lifecycle: 'preview' },
    });
    expect(filterByLifecycle(c, { allowPreview: true }).pass).toBe(true);
  });
});
