// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * lookupModelCost is READ-ONLY against the shared Model catalog.
 *
 * The cost estimator used to fire-and-forget a `prisma.model.update` that wrote
 * a fuzzy cross-provider price guess back into the original model's row. That
 * mutated live pricing state (Model.inputCostPer1k/outputCostPer1k are read by
 * billing, routing and display paths) as a silent side effect of running an
 * experiment — exactly on the models experiments exercise most: obscure ones
 * with no pricing yet. These tests pin the fix: the cross-provider estimate is
 * still used for the run (via the in-memory cache), but the catalog row is
 * never written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findFirst, update } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/database/client', () => ({
  prisma: { model: { findFirst, update } },
}));

import { lookupModelCost } from '../experiment-runner';

// Fixture rows (fictitious test models — not real catalog entries).
const zeroPricedRow = (name: string) => ({ inputCostPer1k: 0, outputCostPer1k: 0, name });
const crossProviderRow = { inputCostPer1k: 0.001, outputCostPer1k: 0.002, id: 'other-provider/test-model' };

beforeEach(() => {
  findFirst.mockReset();
  update.mockReset();
});

describe('lookupModelCost — read-only cross-provider estimation', () => {
  it('uses the cross-provider estimate WITHOUT writing it back to the catalog', async () => {
    // NOTE: unique model id per test — the module-level pricing cache persists
    // across tests in this file, which test 2 exploits deliberately.
    const modelId = 'obscure-provider/test-model-a';
    findFirst.mockImplementation(async (args: { where?: { id?: string; name?: unknown } }) => {
      if (args?.where?.id) return zeroPricedRow('test-model-a');
      if (args?.where?.name) return crossProviderRow;
      return null;
    });

    const cost = await lookupModelCost(modelId, 10_000, 2_000);

    // (10000/1000)*0.001 + (2000/1000)*0.002
    expect(cost).toBeCloseTo(0.014, 10);
    // Exactly 2 reads: direct lookup + cross-provider match. The removed write
    // path issued a THIRD findFirst (uid lookup) before the update — both gone.
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
  });

  it('serves repeat lookups from the in-memory cache — still no catalog write', async () => {
    const modelId = 'obscure-provider/test-model-a'; // same id as test 1 → cached
    const cost = await lookupModelCost(modelId, 1_000, 1_000);

    expect(cost).toBeCloseTo(0.003, 10); // (1)*0.001 + (1)*0.002
    expect(findFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('uses the model\'s own pricing when present — no cross-provider query, no write', async () => {
    findFirst.mockResolvedValueOnce({ inputCostPer1k: 0.005, outputCostPer1k: 0.01, name: 'test-model-b' });

    const cost = await lookupModelCost('some-provider/test-model-b', 2_000, 1_000);

    expect(cost).toBeCloseTo(0.02, 10); // (2)*0.005 + (1)*0.01
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('falls back to the blended rate when no cross-provider match exists — no write', async () => {
    findFirst.mockImplementation(async (args: { where?: { id?: string } }) =>
      args?.where?.id ? zeroPricedRow('test-model-c') : null);

    const cost = await lookupModelCost('some-provider/test-model-c', 5_000, 5_000);

    // Default EXPERIMENT_COST_FALLBACK_RATE_PER_1K = 0.009 across total tokens.
    expect(cost).toBeCloseTo((10_000 / 1000) * 0.009, 10);
    expect(update).not.toHaveBeenCalled();
  });
});
