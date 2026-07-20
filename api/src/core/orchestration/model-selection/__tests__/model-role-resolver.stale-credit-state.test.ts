// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Stale credit state detection.
 *
 * The resolver does NOT probe providers — it trusts the operability
 * signals embedded in `ModelCandidate`. This test pins the contract:
 * when the operability hub says "no_credits" but a live probe (not
 * exercised here) would say "has_credits", the resolver MUST treat
 * the candidate as the hub reports.
 *
 * Reconciliation is the responsibility of a separate
 * `ProviderCreditAuditService` (Part B.2). This test confirms that the
 * resolver doesn't try to be clever — it surfaces the hub's verdict
 * faithfully so the audit service can report divergence.
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '../model-role-resolver';
import { makeCandidate, makeModel } from './role-resolver.fixtures';

describe('Resolver — stale credit state', () => {
  it('honors candidate.hasCredits=false even when it would otherwise rank #1', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'fallback_single',
      candidatePool: [
        makeCandidate({
          id: 'top-quality-but-stale',
          hasCredits: false, // operability hub says no_credits
          model: makeModel({
            id: 'top-quality-but-stale',
            provider: 'p-stale',
            performance: { latencyMs: 500, throughput: 200, quality: 0.99, reliability: 0.99 },
          }),
        }),
        makeCandidate({
          id: 'mid-quality-working',
          model: makeModel({
            id: 'mid-quality-working',
            provider: 'p-ok',
            performance: { latencyMs: 1000, throughput: 100, quality: 0.7, reliability: 0.9 },
          }),
        }),
      ],
      constraints: {},
    });
    // The high-quality model would normally win ranking, but the hub
    // says no_credits, so it's rejected.
    expect(r.selected[0]?.model.id).toBe('mid-quality-working');
    expect(
      r.rejected.find((rej) => rej.modelId === 'top-quality-but-stale')?.reason,
    ).toBe('no_credits');
  });

  it('the trace reports the resolver did NOT consult a live source — pricingStatus="available", providerHealthStatus="available" (signals are pool-bundled)', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'fallback_single',
      candidatePool: [
        makeCandidate({
          id: 'a',
          model: makeModel({ id: 'a', provider: 'p' }),
        }),
      ],
      constraints: {},
    });
    expect(r.trace.providerHealthStatus).toBe('available');
    expect(r.trace.pricingStatus).toBe('available');
    expect(r.trace.semanticSearchStatus).toBe('not_applicable');
  });
});
