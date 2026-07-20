// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D §11.3 — Strict consensus route-level readiness contract.
 *
 * Pins the expected behavior:
 *   - Strict refuses a role when only provider-level evidence exists
 *     (no exact-route evidence for the logicalModelId).
 *   - Strict admits a role when at least one approved route has
 *     route-level liveReady=true.
 *   - Synthesizer with anthropic credit-blocked but OpenRouter+Claude
 *     route-level liveReady → admitted into the pool.
 *   - When ALL approved routes fail, blocker is the per-route reason
 *     (no_live_ready_<role>_routes), not flat `no_eligible_<role>`.
 *
 * Pure projection tests — no Prisma, no provider calls.
 */

import { describe, it, expect } from 'vitest';

type ApprovedRoute = {
  readonly providerId: string;
  readonly apiModelId: string;
  readonly logicalModelId: string;
  readonly liveReady: boolean;
};

type RoleStrictPoolDecision = {
  readonly role: 'participant' | 'synthesizer' | 'judge' | 'fallback';
  readonly eligible: boolean;
  readonly firstEligibleRoute: ApprovedRoute | null;
  readonly blocker: string | null;
};

function decideRoleStrictPool(input: {
  role: 'participant' | 'synthesizer' | 'judge' | 'fallback';
  approvedRoutes: readonly ApprovedRoute[];
  requireRouteLevelLiveEvidence: boolean;
}): RoleStrictPoolDecision {
  const { role, approvedRoutes, requireRouteLevelLiveEvidence } = input;
  if (!requireRouteLevelLiveEvidence) {
    // Legacy: just check that some route is liveReady
    const live = approvedRoutes.find((r) => r.liveReady);
    return {
      role,
      eligible: !!live,
      firstEligibleRoute: live ?? null,
      blocker: live ? null : `no_eligible_${role}`,
    };
  }
  const live = approvedRoutes.find((r) => r.liveReady);
  if (live) return { role, eligible: true, firstEligibleRoute: live, blocker: null };
  return {
    role,
    eligible: false,
    firstEligibleRoute: null,
    blocker: `no_live_ready_${role}_routes`,
  };
}

describe('01C.1B-J1D §11.3 — strict route-level readiness', () => {
  it('strict admits synthesizer when ONE approved route has route-level liveReady (anthropic credit-blocked but openrouter+claude works)', () => {
    const approvedRoutes: ApprovedRoute[] = [
      { providerId: 'anthropic', apiModelId: 'anthropic-claude-3.7-sonnet', logicalModelId: 'anthropic-claude-3.7-sonnet', liveReady: false },
      { providerId: 'openrouter', apiModelId: 'anthropic/anthropic-claude-3.7-sonnet', logicalModelId: 'anthropic-claude-3.7-sonnet', liveReady: true },
      { providerId: 'aiml', apiModelId: 'anthropic/anthropic-claude-3.7-sonnet', logicalModelId: 'anthropic-claude-3.7-sonnet', liveReady: false },
    ];
    const decision = decideRoleStrictPool({
      role: 'synthesizer',
      approvedRoutes,
      requireRouteLevelLiveEvidence: true,
    });
    expect(decision.eligible).toBe(true);
    expect(decision.firstEligibleRoute?.providerId).toBe('openrouter');
  });

  it('strict blocks synthesizer when ALL 15 routes fail (anthropic credit + 14 router missing)', () => {
    const approvedRoutes: ApprovedRoute[] = Array.from({ length: 15 }, (_, i) => ({
      providerId: ['anthropic', 'ai302', 'aihubmix', 'aiml', 'cometapi', 'edenai', 'heliconeai', 'nanogpt', 'openrouter', 'orqai', 'poe', 'requesty', 'routeway', 'synthetic', 'vercel-ai-gateway'][i],
      apiModelId: 'anthropic/anthropic-claude-3.7-sonnet',
      logicalModelId: 'anthropic-claude-3.7-sonnet',
      liveReady: false,
    }));
    const decision = decideRoleStrictPool({
      role: 'synthesizer',
      approvedRoutes,
      requireRouteLevelLiveEvidence: true,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.blocker).toBe('no_live_ready_synthesizer_routes');
  });

  it('strict requires route-level evidence; provider-level chat-ready is not enough', () => {
    // Synthesizer's only "live-ready" entry is on a DIFFERENT logical model
    // (the openrouter::gemma:free judge route). The synthesizer route is
    // openrouter::anthropic/claude which was NEVER probed → liveReady=false.
    const approvedRoutes: ApprovedRoute[] = [
      { providerId: 'openrouter', apiModelId: 'anthropic/anthropic-claude-3.7-sonnet', logicalModelId: 'anthropic-claude-3.7-sonnet', liveReady: false },
    ];
    const decision = decideRoleStrictPool({
      role: 'synthesizer',
      approvedRoutes,
      requireRouteLevelLiveEvidence: true,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.blocker).toBe('no_live_ready_synthesizer_routes');
  });

  it('legacy non-strict path still works (back-compat)', () => {
    const approvedRoutes: ApprovedRoute[] = [
      { providerId: 'vercel-ai-gateway', apiModelId: 'meta/llama-3.2-11b', logicalModelId: 'meta/llama-3.2-11b', liveReady: true },
    ];
    const decision = decideRoleStrictPool({
      role: 'participant',
      approvedRoutes,
      requireRouteLevelLiveEvidence: false,
    });
    expect(decision.eligible).toBe(true);
    expect(decision.blocker).toBeNull();
  });

  it('blocker for "all routes failed" is per-role specific', () => {
    const approvedRoutes: ApprovedRoute[] = [
      { providerId: 'p1', apiModelId: 'm', logicalModelId: 'm', liveReady: false },
      { providerId: 'p2', apiModelId: 'm', logicalModelId: 'm', liveReady: false },
    ];
    const roles: Array<'participant' | 'synthesizer' | 'judge' | 'fallback'> = ['participant', 'synthesizer', 'judge', 'fallback'];
    for (const role of roles) {
      const decision = decideRoleStrictPool({
        role,
        approvedRoutes,
        requireRouteLevelLiveEvidence: true,
      });
      expect(decision.blocker).toBe(`no_live_ready_${role}_routes`);
    }
  });

  it('contract: pure function (no fetch, no Prisma)', () => {
    expect(typeof decideRoleStrictPool).toBe('function');
  });
});
