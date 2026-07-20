// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test: the canonical-owner mis-election guard (added for
 * resolveFrontierModels / buildC3FrontierComparison, see
 * c3-frontier-comparison.test.ts "rejects a community-fork mis-election")
 * was NOT wired into resolveTopTierModels / resolveBudgetModels — the two
 * resolvers actually used by the newer H-A-hard / code-verified /
 * canvas-physics benchmarks (and the main comparison itself). A community
 * fork on an aggregator provider (e.g. a HuggingFace-style hub listing)
 * could win a top-tier or budget slot outright, exactly like the
 * mythos-9b-unhinged case the frontier path already guards against.
 *
 * These tests pin that both resolvers now reject a non-canonical-owner
 * candidate while keeping a legitimate one.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

function row(id: string, displayName: string, provider: string, contextWindow = 128_000, inputCostPer1k = 0.005) {
  return {
    id,
    displayName,
    contextWindow,
    inputCostPer1k,
    capabilities: ['chat'],
    provider: { name: provider },
  };
}

const FORK = row('King3Djbl/mythos-9b-unhinged', 'Mythos 9B Unhinged', 'huggingface', 8_192);
const LEGIT = row('openai/gpt-5.4', 'GPT-5.4', 'openai', 400_000);

vi.mock('@/database/client', () => ({
  prisma: {
    provider: {
      findMany: vi.fn().mockResolvedValue([{ name: 'openai' }, { name: 'huggingface' }]),
    },
    model: {
      // Keyed by the resolver's `where.provider.name` — same mock shape
      // c3-frontier-comparison.test.ts uses (JS-side filtering narrows it).
      findMany: vi.fn().mockImplementation((args: { where?: { provider?: { name?: string } } }) => {
        const providerName = args?.where?.provider?.name;
        if (providerName === 'huggingface') return Promise.resolve([FORK]);
        if (providerName === 'openai') return Promise.resolve([LEGIT]);
        // resolveBudgetModels queries without a provider filter (cheapest-first, no `where.provider`).
        return Promise.resolve([FORK, LEGIT]);
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
  // clearAllMocks resets call history but also clears queued
  // mockResolvedValueOnce-style values; re-assert the base implementations
  // (awaited, so they are in place before the next test body runs).
  const { prisma } = await import('@/database/client');
  (prisma.provider.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'openai' }, { name: 'huggingface' }]);
  (prisma.model.findMany as ReturnType<typeof vi.fn>).mockImplementation((args: { where?: { provider?: { name?: string } } }) => {
    const providerName = args?.where?.provider?.name;
    if (providerName === 'huggingface') return Promise.resolve([FORK]);
    if (providerName === 'openai') return Promise.resolve([LEGIT]);
    return Promise.resolve([FORK, LEGIT]);
  });
});

describe('resolveTopTierModels / resolveBudgetModels — canonical-owner gate (2026-07-15)', () => {
  it('c3-ha-hard: rejects the community fork, keeps the legitimate model', async () => {
    const { buildC3HaHard } = await import('../c3-experiment-configs');
    const config = await buildC3HaHard();

    const singleIds = config.modes
      .filter((m) => m.mode === 'single-model')
      .map((m) => (m as { modelId?: string }).modelId);

    expect(singleIds).not.toContain('King3Djbl/mythos-9b-unhinged');
    expect(singleIds).toContain('openai/gpt-5.4');
  });

  it('c3-code-verified: same guard applies (shares resolveTopTierModels)', async () => {
    const { buildC3CodeVerified } = await import('../c3-experiment-configs');
    const config = await buildC3CodeVerified();

    const singleIds = config.modes
      .filter((m) => m.mode === 'single-model')
      .map((m) => (m as { modelId?: string }).modelId);

    expect(singleIds).not.toContain('King3Djbl/mythos-9b-unhinged');
    expect(singleIds).toContain('openai/gpt-5.4');
  });

  it('resolveBudgetModels (via own-model gate off, indirect): a non-canonical-owner cheap row never fills a budget slot', async () => {
    // resolveBudgetModels queries cheapest-first with no per-provider `where`,
    // so the mock's fallback branch [FORK, LEGIT] exercises it directly.
    process.env.OWN_MODEL_ENABLED = 'false';
    const { buildC3HbMixedMiniRun } = await import('../c3-experiment-configs');
    const config = await buildC3HbMixedMiniRun();
    const singleIds = config.modes
      .filter((m) => m.mode === 'single-model')
      .map((m) => (m as { modelId?: string }).modelId);
    expect(singleIds).not.toContain('King3Djbl/mythos-9b-unhinged');
  });
});
