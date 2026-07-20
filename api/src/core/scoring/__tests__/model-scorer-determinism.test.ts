// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * model-scorer-determinism.test.ts — MVP 4
 *
 * Proves:
 *   - Same input ⇒ same output across 1000 iterations.
 *   - No Math.random / Date.now dependency.
 *   - Input object is not mutated.
 *   - Multiple candidates evaluated in different orders produce the
 *     same per-candidate scores (no cross-candidate state).
 */

import { describe, expect, it, vi } from 'vitest';
import { scoreModelCandidate } from '../model-scorer';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';
import { LEGACY_MODELS_FIXTURE } from '../../registry/__tests__/fixtures/legacy-models.fixture';
import type { ModelScoringCandidate } from '../model-scorer';
import type { ProviderModelRoute } from '../../registry/model-route';
import type { CanonicalModel } from '../../registry/canonical-model';

function findCandidate(
  registry: ReturnType<typeof buildFixtureRegistry>,
  providerId: string,
  modelId: string,
): ModelScoringCandidate {
  const snap = LEGACY_MODELS_FIXTURE.find(
    (m) => m.providerId === providerId && m.id === modelId,
  );
  const oid = snap?.uid ?? `${providerId}:${modelId}`;
  const offering = registry.lookupOffering(oid);
  if (!offering) throw new Error('offering missing');
  const canonical = registry.lookupCanonicalModel(offering.canonicalModelId);
  if (!canonical) throw new Error('canonical missing');
  const routes = registry.routesForOffering(oid);
  return { canonicalModel: canonical, offering, route: routes[0] };
}

const HEALTHY_OVERRIDES = {
  healthState: 'healthy' as const,
  creditStatus: 'has_credits' as const,
  minimalChatStatus: 'verified' as const,
  successRateWindow: 0.9,
  latencyP95Ms: 500,
};

function withHealthy(candidate: ModelScoringCandidate): ModelScoringCandidate {
  return {
    ...candidate,
    canonicalModel: { ...candidate.canonicalModel, lifecycle: 'current' } as CanonicalModel,
    route: { ...candidate.route, ...HEALTHY_OVERRIDES } as ProviderModelRoute,
  };
}

describe('model-scorer determinism — same input ⇒ same output', () => {
  it('produces identical totalScore + breakdown on 1000 iterations', () => {
    const registry = buildFixtureRegistry();
    const candidate = withHealthy(
      findCandidate(registry, 'anthropic', 'claude-opus-4-7'),
    );
    const context = { requiredCapabilities: ['chat', 'vision'] };

    const first = scoreModelCandidate(candidate, context);
    const firstJSON = JSON.stringify(first);
    for (let i = 0; i < 1000; i += 1) {
      const next = scoreModelCandidate(candidate, context);
      if (JSON.stringify(next) !== firstJSON) {
        // Fast-fail with a useful message.
        throw new Error(
          `non-deterministic output at iteration ${i}: expected ${firstJSON}, got ${JSON.stringify(next)}`,
        );
      }
    }
    expect(first.totalScore).toBeGreaterThan(0);
  });

  it('different candidates produce different scores deterministically', () => {
    const registry = buildFixtureRegistry();
    const c1 = withHealthy(findCandidate(registry, 'anthropic', 'claude-opus-4-7'));
    const c2 = withHealthy(findCandidate(registry, 'mistral', 'mistral-large-2'));
    const ctx = { requiredCapabilities: ['chat'] };
    const r1a = scoreModelCandidate(c1, ctx);
    const r1b = scoreModelCandidate(c1, ctx);
    const r2a = scoreModelCandidate(c2, ctx);
    const r2b = scoreModelCandidate(c2, ctx);
    expect(r1a).toEqual(r1b);
    expect(r2a).toEqual(r2b);
    // c1 has vision + json; c2 has neither — but both satisfy chat-only
    // so totals can differ on freshness/cost. We don't constrain the
    // direction, only that the values are stable.
  });
});

describe('model-scorer determinism — no clock/random dependency', () => {
  it('output is identical when Date.now is stubbed to two different values', () => {
    const registry = buildFixtureRegistry();
    const candidate = withHealthy(
      findCandidate(registry, 'openai', 'gpt-5.5-pro'),
    );
    const ctx = { requiredCapabilities: ['chat'] };

    const realDateNow = Date.now;
    try {
      Date.now = () => 1_000_000_000;
      const a = scoreModelCandidate(candidate, ctx);
      Date.now = () => 9_999_999_999;
      const b = scoreModelCandidate(candidate, ctx);
      expect(a).toEqual(b);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('output is identical with Math.random stubbed to two different values', () => {
    const registry = buildFixtureRegistry();
    const candidate = withHealthy(
      findCandidate(registry, 'openai', 'gpt-5.5-pro'),
    );
    const ctx = { requiredCapabilities: ['chat'] };

    const spy1 = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const a = scoreModelCandidate(candidate, ctx);
    spy1.mockRestore();

    const spy2 = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const b = scoreModelCandidate(candidate, ctx);
    spy2.mockRestore();

    expect(a).toEqual(b);
  });
});

describe('model-scorer determinism — input is not mutated', () => {
  it('candidate input object remains structurally identical after scoring', () => {
    const registry = buildFixtureRegistry();
    const candidate = withHealthy(findCandidate(registry, 'cohere', 'command-a'));
    const before = JSON.parse(
      JSON.stringify({
        canonicalModel: candidate.canonicalModel,
        offering: candidate.offering,
        route: candidate.route,
      }),
    );
    scoreModelCandidate(candidate, { requiredCapabilities: ['chat'] });
    const after = JSON.parse(
      JSON.stringify({
        canonicalModel: candidate.canonicalModel,
        offering: candidate.offering,
        route: candidate.route,
      }),
    );
    expect(after).toEqual(before);
  });

  it('context input object is not mutated', () => {
    const registry = buildFixtureRegistry();
    const candidate = withHealthy(findCandidate(registry, 'cohere', 'command-a'));
    const context = {
      requiredCapabilities: ['chat'] as const,
      costSensitivity: 'high' as const,
      latencySensitivity: 'high' as const,
    };
    const ctxBefore = JSON.parse(JSON.stringify(context));
    scoreModelCandidate(candidate, context);
    const ctxAfter = JSON.parse(JSON.stringify(context));
    expect(ctxAfter).toEqual(ctxBefore);
  });
});

describe('model-scorer determinism — order independence', () => {
  it('scoring c1 then c2 yields same per-candidate scores as c2 then c1', () => {
    const registry = buildFixtureRegistry();
    const c1 = withHealthy(findCandidate(registry, 'anthropic', 'claude-opus-4-7'));
    const c2 = withHealthy(findCandidate(registry, 'openai', 'gpt-5.5-pro'));
    const ctx = { requiredCapabilities: ['chat'] };

    const order1 = [scoreModelCandidate(c1, ctx), scoreModelCandidate(c2, ctx)];
    const order2 = [scoreModelCandidate(c2, ctx), scoreModelCandidate(c1, ctx)];

    expect(order1[0]).toEqual(order2[1]); // c1 stayed identical
    expect(order1[1]).toEqual(order2[0]); // c2 stayed identical
  });
});
