// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for the frontier-inclusion fix (2026-07-16).
 *
 * Gap found post-merge: buildC3HaHard/buildC3CodeVerified/buildC3CanvasPhysics
 * sourced their single-model arms from resolveTopTierModels() alone — one
 * model PER PROVIDER, ranked by contextWindow desc + cost asc. That ranking
 * has no notion of "flagship" or "generation": a cheap, huge-context model can
 * win the per-provider slot over the actual newest frontier release (exactly
 * the gap resolveFrontierModels was built to close for the OLDER
 * buildC3FrontierComparison config — see c3-frontier-comparison.test.ts).
 *
 * resolveBenchmarkSingles() now unions resolveTopTierModels() (breadth) with
 * resolveFrontierModels() (flagship election), deduped by id. These tests pin
 * that a genuine flagship (e.g. gpt-5.6, grok-4.5) is included EVEN WHEN a
 * cheaper/bigger-context sibling model from the same provider would otherwise
 * have won the per-provider slot and crowded it out — "frontier alongside all
 * the others", not instead of them.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

function row(id: string, displayName: string, provider: string, contextWindow: number, inputCostPer1k: number) {
  return { id, displayName, contextWindow, inputCostPer1k, capabilities: ['chat'], provider: { name: provider } };
}

// openai: a cheap, huge-context sibling would win resolveTopTierModels' own
// per-provider ranking (contextWindow desc, cost asc) over the ACTUAL flagship.
const OPENAI_CHEAP_BIG = row('openai/gpt-4o-mini', 'GPT-4o mini', 'openai', 1_000_000, 0.0001);
const OPENAI_FLAGSHIP = row('openai/gpt-5.6', 'GPT-5.6', 'openai', 400_000, 0.01);
// xai: same shape — an older/cheaper grok wins the per-provider slot; grok-4.5
// (the flagship the operator explicitly asked about) would be crowded out.
const XAI_OLDER = row('xai/grok-2', 'Grok 2', 'xai', 2_000_000, 0.0002);
const XAI_FLAGSHIP = row('xai/grok-4.5', 'Grok 4.5', 'xai', 256_000, 0.02);

const CATALOG = [OPENAI_CHEAP_BIG, OPENAI_FLAGSHIP, XAI_OLDER, XAI_FLAGSHIP];

vi.mock('@/database/client', () => ({
  prisma: {
    provider: {
      findMany: vi.fn().mockResolvedValue([{ name: 'openai' }, { name: 'xai' }]),
    },
    model: {
      // Per-provider query (resolveTopTierModels/resolveBudgetModels) filters
      // by where.provider.name; the bulk id.contains query (resolveFrontierModels'
      // default path) has no provider filter — return the full catalog and let
      // the resolver's own JS-side matching narrow it (same pattern as
      // c3-frontier-comparison.test.ts's mock).
      findMany: vi.fn().mockImplementation((args: { where?: { provider?: { name?: string } } }) => {
        const providerName = args?.where?.provider?.name;
        if (providerName) return Promise.resolve(CATALOG.filter((r) => r.provider.name === providerName));
        return Promise.resolve(CATALOG);
      }),
    },
  },
}));

vi.mock('@/services/credit-monitor-service', () => ({
  getCreditMonitorService: () => ({ hasCredits: () => true }),
}));

vi.mock('@/core/provider-operability-hub', () => ({
  getProviderOperabilityHub: () => ({ isProviderUsable: () => true }),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.EXPERIMENT_FRONTIER_MODEL_IDS;
  // clearAllMocks in this project's vitest setup also clears the factory-level
  // mockImplementation, so re-assert it (awaited) before each test body runs —
  // same fix needed in c3-resolver-owner-guard.test.ts.
  const { prisma } = await import('@/database/client');
  (prisma.provider.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'openai' }, { name: 'xai' }]);
  (prisma.model.findMany as ReturnType<typeof vi.fn>).mockImplementation((args: { where?: { provider?: { name?: string } } }) => {
    const providerName = args?.where?.provider?.name;
    if (providerName) return Promise.resolve(CATALOG.filter((r) => r.provider.name === providerName));
    return Promise.resolve(CATALOG);
  });
});

describe('resolveBenchmarkSingles — frontier flagships alongside full breadth (2026-07-16)', () => {
  it('c3-ha-hard: gpt-5.6 and grok-4.5 are BOTH present, even though a cheaper sibling wins the per-provider slot', async () => {
    const { buildC3HaHard } = await import('../c3-experiment-configs');
    const config = await buildC3HaHard();

    const singleIds = config.modes
      .filter((m) => m.mode === 'single-model')
      .map((m) => (m as { modelId?: string }).modelId);

    // The flagships the operator explicitly asked about — must NOT be crowded
    // out by a cheaper/bigger-context sibling from the same provider.
    expect(singleIds).toContain('openai/gpt-5.6');
    expect(singleIds).toContain('xai/grok-4.5');
    // Breadth is preserved too — "alongside all the others", not instead.
    expect(singleIds).toContain('openai/gpt-4o-mini');
    expect(singleIds).toContain('xai/grok-2');
    // No duplicate ids from the union.
    expect(new Set(singleIds).size).toBe(singleIds.length);
  });

  it('c3-code-verified: same union behavior', async () => {
    const { buildC3CodeVerified } = await import('../c3-experiment-configs');
    const config = await buildC3CodeVerified();
    const singleIds = config.modes
      .filter((m) => m.mode === 'single-model')
      .map((m) => (m as { modelId?: string }).modelId);
    expect(singleIds).toContain('openai/gpt-5.6');
    expect(singleIds).toContain('xai/grok-4.5');
  });

  it('c3-canvas-physics: same union behavior', async () => {
    const { buildC3CanvasPhysics } = await import('../c3-experiment-configs');
    const config = await buildC3CanvasPhysics();
    const singleIds = config.modes
      .filter((m) => m.mode === 'single-model')
      .map((m) => (m as { modelId?: string }).modelId);
    expect(singleIds).toContain('openai/gpt-5.6');
    expect(singleIds).toContain('xai/grok-4.5');
  });
});
