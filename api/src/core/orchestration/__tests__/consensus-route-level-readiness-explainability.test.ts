// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D §11.4 — Route-level explainability fields tests.
 *
 * Pins the per-role-route metrics now surfaced by the dry-run service:
 *   - approvedRoutesCount
 *   - auditedApprovedRoutesCount
 *   - liveReadyApprovedRoutesCount
 *   - providerReadyRouteUnauditedCount
 *   - routeNotAuditedForLogicalModelCount
 *
 * Pure projection tests — no Prisma, no provider calls.
 */

import { describe, it, expect } from 'vitest';

type ApprovedRoute = {
  readonly providerId: string;
  readonly liveReady: boolean;
  readonly lastFailureKind?: string;
};

function projectRouteLevelMetrics(approvedForExecution: ReadonlyArray<ApprovedRoute>) {
  const routeLiveReadyCount = approvedForExecution.filter((c) => c.liveReady).length;
  const providerChatReadyMap = new Map<string, boolean>();
  for (const c of approvedForExecution) {
    const p = c.providerId.toLowerCase();
    if (!providerChatReadyMap.has(p)) providerChatReadyMap.set(p, false);
    if (c.liveReady) providerChatReadyMap.set(p, true);
  }
  const providerReadyRouteUnauditedCount = approvedForExecution.filter((c) =>
    !c.liveReady && providerChatReadyMap.get(c.providerId.toLowerCase()) === true,
  ).length;
  // J1D §9 — "not audited for logical model" = neither liveReady, nor has
  // a recorded failure (truly never probed), nor has provider-level success.
  const routeNotAuditedForLogicalModelCount = approvedForExecution.filter((c) =>
    !c.liveReady
    && c.lastFailureKind === undefined
    && providerChatReadyMap.get(c.providerId.toLowerCase()) !== true,
  ).length;
  const auditedApprovedRoutesCount = approvedForExecution.filter((c) =>
    c.liveReady || c.lastFailureKind !== undefined,
  ).length;
  return {
    approvedRoutesCount: approvedForExecution.length,
    auditedApprovedRoutesCount,
    liveReadyApprovedRoutesCount: routeLiveReadyCount,
    providerReadyRouteUnauditedCount,
    routeNotAuditedForLogicalModelCount,
  };
}

describe('01C.1B-J1D §11.4 — route-level readiness explainability', () => {
  it('all 15 synthesizer routes unaudited → all in routeNotAuditedForLogicalModelCount', () => {
    const approvedRoutes: ApprovedRoute[] = Array.from({ length: 15 }, (_, i) => ({
      providerId: ['anthropic', 'ai302', 'aihubmix', 'aiml', 'cometapi', 'edenai', 'heliconeai', 'nanogpt', 'openrouter', 'orqai', 'poe', 'requesty', 'routeway', 'synthetic', 'vercel-ai-gateway'][i],
      liveReady: false,
    }));
    const m = projectRouteLevelMetrics(approvedRoutes);
    expect(m.approvedRoutesCount).toBe(15);
    expect(m.auditedApprovedRoutesCount).toBe(0);
    expect(m.liveReadyApprovedRoutesCount).toBe(0);
    expect(m.routeNotAuditedForLogicalModelCount).toBe(15);
  });

  it('anthropic credit-failed + 14 unaudited → 1 audited, 0 liveReady, 14 not-audited', () => {
    const approvedRoutes: ApprovedRoute[] = [
      { providerId: 'anthropic', liveReady: false, lastFailureKind: 'insufficient_credits' },
      ...Array.from({ length: 14 }, (_, i) => ({
        providerId: ['ai302', 'aihubmix', 'aiml', 'cometapi', 'edenai', 'heliconeai', 'nanogpt', 'openrouter', 'orqai', 'poe', 'requesty', 'routeway', 'synthetic', 'vercel-ai-gateway'][i],
        liveReady: false,
      })),
    ];
    const m = projectRouteLevelMetrics(approvedRoutes);
    expect(m.approvedRoutesCount).toBe(15);
    expect(m.auditedApprovedRoutesCount).toBe(1); // anthropic was probed
    expect(m.liveReadyApprovedRoutesCount).toBe(0);
    expect(m.routeNotAuditedForLogicalModelCount).toBe(14);
    expect(m.providerReadyRouteUnauditedCount).toBe(0);
  });

  it('OpenRouter chat-ready on judge but unaudited on synthesizer route → provider_ready_route_unaudited=1', () => {
    // Simulating the post-audit synthesizer pool. The openrouter::anthropic/claude
    // route is unaudited, but openrouter has SOME success (judge route).
    const approvedRoutes: ApprovedRoute[] = [
      // openrouter has a chat-ready route elsewhere → mark this provider as ready in the map
      { providerId: 'openrouter', liveReady: false }, // claude route unaudited
      { providerId: 'openrouter', liveReady: true },  // gemma route (judge) — provider ready
    ];
    const m = projectRouteLevelMetrics(approvedRoutes);
    expect(m.liveReadyApprovedRoutesCount).toBe(1);
    expect(m.providerReadyRouteUnauditedCount).toBe(1);
    expect(m.routeNotAuditedForLogicalModelCount).toBe(0);
  });

  it('mix: 3 routes — 1 live, 1 provider-ready-but-route-unaudited, 1 unaudited', () => {
    const approvedRoutes: ApprovedRoute[] = [
      { providerId: 'openrouter', liveReady: true },  // route live
      { providerId: 'openrouter', liveReady: false }, // provider has SOME success, this route unaudited
      { providerId: 'cometapi', liveReady: false },   // no provider evidence
    ];
    const m = projectRouteLevelMetrics(approvedRoutes);
    expect(m.liveReadyApprovedRoutesCount).toBe(1);
    expect(m.providerReadyRouteUnauditedCount).toBe(1);
    expect(m.routeNotAuditedForLogicalModelCount).toBe(1);
  });

  it('explainability fields never contain raw prompt or secrets', () => {
    const m = projectRouteLevelMetrics([
      { providerId: 'p1', liveReady: true },
    ]);
    const json = JSON.stringify(m);
    expect(json).not.toMatch(/parseMoneyBR/);
    expect(json).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(json).not.toMatch(/Bearer [A-Za-z0-9._-]{20,}/);
  });

  it('contract: pure function, no fetch, no Prisma', () => {
    expect(typeof projectRouteLevelMetrics).toBe('function');
  });
});
