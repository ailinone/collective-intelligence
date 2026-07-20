// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test: `resolveTopTierModels` discovers providers via
 * `prisma.provider.findMany({ orderBy: { name: 'asc' } })`, then iterates
 * them in that alphabetical order building one arm per provider until
 * `results.length >= maxProviders * perProvider`. With the old default
 * (`maxProviders: 30`) and 77 real eligible providers in production, this
 * silently excluded every provider whose name sorted after ~'w' — not by
 * quality, purely by alphabetical position. Confirmed live: `zai` (GLM) and
 * `xai` never contributed a single-model arm to a running experiment; the
 * cutoff landed exactly at 'wandb'.
 *
 * These tests pin: (1) by default, ALL eligible providers are included, even
 * ones sorting well past 'w'; (2) an operator can still explicitly scope a
 * run down via EXPERIMENT_TOP_TIER_MAX_PROVIDERS, which now reflects a
 * deliberate choice rather than an alphabetical accident.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

function row(id: string, provider: string, contextWindow = 128_000, inputCostPer1k = 0.005) {
  return {
    id,
    displayName: id,
    contextWindow,
    inputCostPer1k,
    capabilities: ['chat'],
    provider: { name: provider },
  };
}

// 35 providers, alphabetically ordered a00..a34 — deliberately more than the
// old hard-coded default of 30, so any reintroduction of that cap would drop
// the tail (a30..a34) the same way it dropped `xai`/`zai` in production.
const PROVIDER_NAMES = Array.from({ length: 35 }, (_, i) => `a${String(i).padStart(2, '0')}-hub`);

vi.mock('@/database/client', () => ({
  prisma: {
    provider: {
      findMany: vi.fn(),
    },
    model: {
      findMany: vi.fn(),
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
  const { prisma } = await import('@/database/client');
  (prisma.provider.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    PROVIDER_NAMES.map((name) => ({ name }))
  );
  (prisma.model.findMany as ReturnType<typeof vi.fn>).mockImplementation(
    (args: { where?: { provider?: { name?: string } } }) => {
      const providerName = args?.where?.provider?.name;
      if (providerName && PROVIDER_NAMES.includes(providerName)) {
        return Promise.resolve([row(`${providerName}/flagship`, providerName)]);
      }
      // resolveBudgetModels-style query with no provider filter — irrelevant here.
      return Promise.resolve([]);
    }
  );
});

afterEach(() => {
  delete process.env.EXPERIMENT_TOP_TIER_MAX_PROVIDERS;
});

describe('resolveTopTierModels — provider cap (2026-07-20)', () => {
  it('includes every eligible provider by default, including ones sorting past the old 30-provider cutoff', async () => {
    const { buildC3HaHard } = await import('../c3-experiment-configs');
    const config = await buildC3HaHard();

    const singleIds = config.modes
      .filter((m) => m.mode === 'single-model')
      .map((m) => (m as { modelId?: string }).modelId);

    // The old cap would have stopped at the 30th provider (a00..a29),
    // dropping a30-hub..a34-hub — exactly the class of bug that hid `zai`.
    expect(singleIds).toContain('a00-hub/flagship');
    expect(singleIds).toContain('a29-hub/flagship');
    expect(singleIds).toContain('a30-hub/flagship');
    expect(singleIds).toContain('a34-hub/flagship');
    expect(singleIds?.filter((id) => id?.endsWith('/flagship'))).toHaveLength(35);
  });

  it('still honors an explicit EXPERIMENT_TOP_TIER_MAX_PROVIDERS override', async () => {
    process.env.EXPERIMENT_TOP_TIER_MAX_PROVIDERS = '3';
    const { buildC3HaHard } = await import('../c3-experiment-configs');
    const config = await buildC3HaHard();

    const singleIds = config.modes
      .filter((m) => m.mode === 'single-model')
      .map((m) => (m as { modelId?: string }).modelId)
      .filter((id) => id?.endsWith('/flagship'));

    expect(singleIds).toHaveLength(3);
    expect(singleIds).toContain('a00-hub/flagship');
    expect(singleIds).toContain('a01-hub/flagship');
    expect(singleIds).toContain('a02-hub/flagship');
    expect(singleIds).not.toContain('a34-hub/flagship');
  });
});
