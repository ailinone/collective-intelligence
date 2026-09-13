// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Auto-re-enable fix (2026-09, pairs with pricing-integrity-job.ts's
 * auto-disable sweep — see jobs/__tests__/pricing-integrity-auto-disable.test.ts
 * for the disable half of this round trip).
 *
 * bulkUpsertModels' raw-SQL ON CONFLICT SET (the primary write path for the
 * ~95 provider fetchers) already stamped `status = EXCLUDED.status`
 * ('active') UNCONDITIONALLY on every successful upsert, before this fix —
 * so a disabled model rediscovered through that path already self-healed.
 * updateExistingModel() (the fallback path used when that batch SQL fails,
 * and reused by createNewModel's own race-condition guard) did NOT: it
 * updated price/capabilities/metadata/lastSyncedAt but never touched
 * `status`, so a model disabled via either the auto-disable sweep or
 * removeDisabledCatalogEntries's provider-level disable could stay disabled
 * forever through this path even after a live discovery source reconfirmed
 * it.
 *
 * These tests pin the fix directly against updateExistingModel() (accessed
 * via bracket-cast, same technique as
 * central-model-discovery-provider-metrics.test.ts, since it is private):
 *  (c) a disabled model that reappears in a fresh discovery batch gets
 *      re-enabled automatically, with an auditable metadata trail and a
 *      structured log line;
 *  - an already-active model is left alone (no spurious "re-enable" noise);
 *  - a model disabled for an unrelated reason (no autoDisabledReason tag —
 *    e.g. removeDisabledCatalogEntries) is ALSO re-enabled, matching the
 *    primary path's existing unconditional policy rather than diverging
 *    from it.
 *
 * Hermetic: @/database/client is mocked — no real Postgres I/O.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const modelUpdateMock = vi.fn().mockResolvedValue({});

vi.mock('@/database/client', () => ({
  prisma: {
    model: { update: (...args: unknown[]) => modelUpdateMock(...args) },
  },
}));

import {
  CentralModelDiscoveryService,
  type DiscoveredModel,
  type DiscoverySource,
} from '@/services/central-model-discovery-service';
import type { Model as PrismaModel } from '@/generated/prisma/index.js';

type UpdateExistingModelFn = (
  existing: PrismaModel,
  model: DiscoveredModel,
  provider: string,
  sourceName: string,
  source: DiscoverySource
) => Promise<boolean>;

function getUpdateExistingModel(): UpdateExistingModelFn {
  const service = new CentralModelDiscoveryService();
  return (
    service as unknown as { updateExistingModel: UpdateExistingModelFn }
  ).updateExistingModel.bind(service);
}

function fakeExisting(overrides: Partial<PrismaModel> = {}): PrismaModel {
  return {
    uid: 'uid-1',
    id: 'reappeared-model',
    providerId: 'some-provider',
    name: 'reappeared-model',
    displayName: 'Reappeared Model',
    contextWindow: 8192,
    maxOutputTokens: 1024,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: ['chat'],
    metadata: {},
    performance: {},
    status: 'active',
    usageCount: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as unknown as PrismaModel;
}

function fakeDiscovered(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'reappeared-model',
    name: 'reappeared-model',
    contextWindow: 8192,
    capabilities: ['chat'],
    pricing: { inputCostPer1M: 1, outputCostPer1M: 2, currency: 'USD' },
    metadata: {},
    ...overrides,
  };
}

function fakeSource(): DiscoverySource {
  return {
    name: 'test-source',
    type: 'native_api',
    priority: 1,
    providers: ['some-provider'],
    fetcher: async () => [],
  };
}

describe('central-model-discovery-service: updateExistingModel auto-re-enable', () => {
  beforeEach(() => {
    modelUpdateMock.mockReset().mockResolvedValue({});
  });

  it('flips a disabled model back to active when it reappears in a fresh discovery batch', async () => {
    const existing = fakeExisting({
      status: 'disabled',
      metadata: { autoDisabledReason: 'delisted-unconfirmed', autoDisabledAt: '2026-01-01T00:00:00.000Z' },
    });
    const discovered = fakeDiscovered();

    const changed = await getUpdateExistingModel()(
      existing,
      discovered,
      'some-provider',
      'test-source',
      fakeSource()
    );

    expect(changed).toBe(true);
    expect(modelUpdateMock).toHaveBeenCalledTimes(1);
    const call = modelUpdateMock.mock.calls[0][0] as {
      where: { uid: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ uid: 'uid-1' });
    expect(call.data.status).toBe('active');
    // The prior auto-disable reason is preserved for audit, but cleared as
    // the CURRENT reason so metadata stops claiming an active model is
    // delisted.
    const metadata = call.data.metadata as Record<string, unknown>;
    expect(metadata.autoDisabledReason).toBeNull();
    expect(metadata.priorAutoDisabledReason).toBe('delisted-unconfirmed');
    expect(metadata.autoReenabledAt).toEqual(expect.any(String));
  });

  it('re-enables a model disabled for an UNRELATED reason too (matches the primary path bulkUpsertModels\' unconditional policy)', async () => {
    // No autoDisabledReason tag at all — e.g. disabled via
    // removeDisabledCatalogEntries's provider-level disable, not this
    // feature's sweep.
    const existing = fakeExisting({ status: 'disabled', metadata: {} });
    const discovered = fakeDiscovered();

    const changed = await getUpdateExistingModel()(
      existing,
      discovered,
      'some-provider',
      'test-source',
      fakeSource()
    );

    expect(changed).toBe(true);
    const call = modelUpdateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.status).toBe('active');
  });

  it('does not include `status` in the update payload for an already-active model (no spurious re-enable)', async () => {
    const existing = fakeExisting({ status: 'active' });
    const discovered = fakeDiscovered({
      contextWindow: existing.contextWindow,
      capabilities: existing.capabilities as string[],
      pricing: { inputCostPer1M: 1, outputCostPer1M: 2, currency: 'USD' },
      metadata: {},
    });

    await getUpdateExistingModel()(
      existing,
      discovered,
      existing.providerId,
      'test-source',
      fakeSource()
    );

    // `metadata.lastUpdated` is stamped fresh on every call, so `changed`
    // legitimately trips true regardless of status — that field-drift
    // detection is pre-existing behavior, not what this fix touches. What
    // this fix must NOT do is add `status` to the payload when the model was
    // already active.
    expect(modelUpdateMock).toHaveBeenCalledTimes(1);
    const call = modelUpdateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.status).toBeUndefined();
  });

  it('logs a structured re-enable event only when the model was actually disabled', async () => {
    const service = new CentralModelDiscoveryService();
    // Spy on the real child logger's `.info` rather than replacing the whole
    // object — the constructor kicks off an unawaited initializeSources()
    // whose .catch() handler calls this.log.error(...) on failure in this
    // hermetic test env, so `error`/`warn` must stay real, functioning
    // methods.
    const logSpy = vi.spyOn(
      (service as unknown as { log: { info: (...args: unknown[]) => void } }).log,
      'info'
    );
    const updateExistingModel = (
      service as unknown as { updateExistingModel: UpdateExistingModelFn }
    ).updateExistingModel.bind(service);

    await updateExistingModel(
      fakeExisting({ status: 'disabled' }),
      fakeDiscovered(),
      'some-provider',
      'test-source',
      fakeSource()
    );

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ previousStatus: 'disabled' }),
      expect.stringContaining('re-enable')
    );
  });
});
