// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.3 — resolver behavior under reconciled state.
 *
 * `applySnapshotToCandidate` mutates the pool before the resolver
 * sees it, so the resolver's existing rejection rules now reflect
 * LIVE state. These tests verify that the priority `live > cache`
 * is preserved end-to-end through the resolver.
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '../model-role-resolver';
import { makeCandidate, makeModel } from './role-resolver.fixtures';
import {
  applySnapshotToCandidate,
  type ReconciledOperabilitySnapshot,
} from '@/core/operability/reconciled-operability-snapshot';

function snapshotWith(states: Record<string, { auth: string; credit: string; rate: string }>): ReconciledOperabilitySnapshot {
  return {
    observedAt: '2026-05-13T00:00:00.000Z',
    source: 'non_billable_probe',
    criticalStaleOperabilityStateCount: 0,
    safeNonBillableProbeAvailable: true,
    providerStates: Object.fromEntries(
      Object.entries(states).map(([id, s]) => [
        id,
        {
          providerId: id,
          authState: s.auth as 'auth_ok',
          creditState: s.credit as 'has_credits',
          rateState: s.rate as 'ok',
          source: 'non_billable_probe',
        },
      ]),
    ),
  };
}

describe('Resolver — reconciled live state overrides cache', () => {
  it('cache=no_credits + live=has_credits → resolver SELECTS the provider', async () => {
    const resolver = new ModelRoleResolver();
    const cached = makeCandidate({
      id: 'stale-no-credits',
      hasCredits: false, // cached
      model: makeModel({ id: 'stale-no-credits', provider: 'p-stale' }),
    });
    const snap = snapshotWith({
      'p-stale': { auth: 'auth_ok', credit: 'has_credits', rate: 'ok' },
    });
    const reconciled = applySnapshotToCandidate(cached, snap);
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'fallback_single',
      candidatePool: [reconciled],
      constraints: {},
    });
    expect(r.selected.length).toBe(1);
    expect(r.selected[0].model.id).toBe('stale-no-credits');
  });

  it('cache=has_credits + live=no_credits → resolver REJECTS the provider', async () => {
    const resolver = new ModelRoleResolver();
    const cached = makeCandidate({
      id: 'looks-good-but-empty',
      hasCredits: true, // cached
      model: makeModel({ id: 'looks-good-but-empty', provider: 'p-x' }),
    });
    const snap = snapshotWith({
      'p-x': { auth: 'auth_ok', credit: 'no_credits', rate: 'ok' },
    });
    const reconciled = applySnapshotToCandidate(cached, snap);
    const fallback = makeCandidate({
      id: 'fallback',
      model: makeModel({ id: 'fallback', provider: 'p-fallback' }),
    });
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'fallback_single',
      candidatePool: [reconciled, fallback],
      constraints: {},
    });
    expect(r.selected[0]?.model.id).toBe('fallback');
    expect(r.rejected.some((rej) => rej.modelId === 'looks-good-but-empty' && rej.reason === 'no_credits')).toBe(true);
  });

  it('live auth_failed → resolver rejects with provider_unhealthy reason', async () => {
    const resolver = new ModelRoleResolver();
    const cached = makeCandidate({
      id: 'auth-bad',
      model: makeModel({ id: 'auth-bad', provider: 'p-auth' }),
    });
    const snap = snapshotWith({
      'p-auth': { auth: 'auth_failed', credit: 'unknown', rate: 'unknown' },
    });
    const reconciled = applySnapshotToCandidate(cached, snap);
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'fallback_single',
      candidatePool: [reconciled],
      constraints: {},
    });
    expect(r.selected.length).toBe(0);
    expect(r.rejected[0].reason).toBe('provider_unhealthy');
  });

  it('live rate_limited → resolver rejects with rate_limited reason', async () => {
    const resolver = new ModelRoleResolver();
    const cached = makeCandidate({
      id: 'limited',
      model: makeModel({ id: 'limited', provider: 'p-rate' }),
    });
    const snap = snapshotWith({
      'p-rate': { auth: 'auth_ok', credit: 'has_credits', rate: 'rate_limited' },
    });
    const reconciled = applySnapshotToCandidate(cached, snap);
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'fallback_single',
      candidatePool: [reconciled],
      constraints: {},
    });
    expect(r.selected.length).toBe(0);
    expect(r.rejected[0].reason).toBe('rate_limited');
  });

  it('provider not in snapshot → candidate flags unchanged (resolver behaves on cached state)', async () => {
    const resolver = new ModelRoleResolver();
    const cached = makeCandidate({
      id: 'no-snapshot-data',
      model: makeModel({ id: 'no-snapshot-data', provider: 'p-unknown' }),
    });
    const snap = snapshotWith({
      'other-provider': { auth: 'auth_ok', credit: 'has_credits', rate: 'ok' },
    });
    const reconciled = applySnapshotToCandidate(cached, snap);
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'fallback_single',
      candidatePool: [reconciled],
      constraints: {},
    });
    expect(r.selected.length).toBe(1);
  });
});
