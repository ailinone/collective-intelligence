// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Delisted-model auto-disable sweep (2026-09 follow-up to the staleness
 * quarantine): a model unconfirmed by ANY discovery source for
 * MODEL_AUTO_DISABLE_THRESHOLD_MS (default 14 days) is a real,
 * catalog-membership change — `status: 'active' → 'disabled'` — not just a
 * metadata tag. This closes the gap where `metadata.pricingSource =
 * 'stale-unverified'` (the 72h flag) never actually removed a genuinely
 * delisted model from the selectable catalog.
 *
 * These tests exercise autoDisableDelistedModels() directly against a
 * mocked Prisma client (hermetic — no real Postgres), proving:
 *  (b) a model unconfirmed past the threshold gets disabled, with an
 *      auditable metadata tag and a real status UPDATE;
 *  - the kill-switch (MODEL_AUTO_DISABLE_DISABLED) fully skips the sweep;
 *  - a clean sweep (nothing past the threshold) makes no UPDATE calls;
 *  - the SELECT→UPDATE race against a concurrent discovery reconfirm (the
 *    "model-discovery-hourly" job runs on the SAME `0 * * * *` tick this
 *    sweep's 05:00 UTC run lands on) does NOT disable a row that was just
 *    reconfirmed — the per-row write is a conditional `updateMany` that
 *    re-asserts staleness at write time, not just at scan time.
 *  - the 2026-09-08 incident fix: a provider whose discovery is CURRENTLY
 *    fully broken (getProvidersWithoutHealthyDiscovery() circuit breaker)
 *    is exempted from this sweep row-by-row, while an unrelated provider in
 *    the SAME batch whose discovery is healthy is still disabled normally —
 *    and a failure computing the exemption itself fails OPEN (preserves the
 *    pre-existing disable behavior) rather than silently disabling nothing.
 *
 * The matching re-enable half of the round trip (a disabled model
 * reappearing in a fresh discovery batch) is covered in
 * services/__tests__/central-model-discovery-auto-reenable.test.ts — the
 * two together prove the full disable→reappear→re-enable cycle described in
 * this feature's design.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryRawMock = vi.fn();
const queryRawUnsafeMock = vi.fn();
const modelUpdateManyMock = vi.fn().mockResolvedValue({ count: 1 });

vi.mock('@/database/client', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
    $queryRawUnsafe: (...args: unknown[]) => queryRawUnsafeMock(...args),
    model: { updateMany: (...args: unknown[]) => modelUpdateManyMock(...args) },
  },
}));

// Circuit-breaker dependency (2026-09-08 incident fix). Defaults to "every
// provider has healthy discovery" (empty set) so the pre-existing tests
// below are unaffected unless a test explicitly configures otherwise.
const getProvidersWithoutHealthyDiscoveryMock = vi.fn(() => new Set<string>());
const getCentralModelDiscoveryServiceMock = vi.fn(async () => ({
  getProvidersWithoutHealthyDiscovery: getProvidersWithoutHealthyDiscoveryMock,
}));

vi.mock('@/services/central-model-discovery-service', () => ({
  getCentralModelDiscoveryService: (...args: unknown[]) =>
    getCentralModelDiscoveryServiceMock(...args),
}));

const ORIGINAL_DISABLED = process.env.MODEL_AUTO_DISABLE_DISABLED;
const ORIGINAL_THRESHOLD_MS = process.env.MODEL_AUTO_DISABLE_THRESHOLD_MS;
const ORIGINAL_GRACE_MS = process.env.MODEL_MANUAL_REENABLE_GRACE_MS;

async function loadModule() {
  return import('@/jobs/pricing-integrity-job');
}

beforeEach(() => {
  vi.resetModules();
  queryRawMock.mockReset();
  queryRawUnsafeMock.mockReset();
  modelUpdateManyMock.mockReset().mockResolvedValue({ count: 1 });
  getProvidersWithoutHealthyDiscoveryMock.mockReset().mockReturnValue(new Set());
  getCentralModelDiscoveryServiceMock.mockReset().mockImplementation(async () => ({
    getProvidersWithoutHealthyDiscovery: getProvidersWithoutHealthyDiscoveryMock,
  }));
  delete process.env.MODEL_AUTO_DISABLE_DISABLED;
  delete process.env.MODEL_AUTO_DISABLE_THRESHOLD_MS;
  delete process.env.MODEL_MANUAL_REENABLE_GRACE_MS;
});

afterEach(() => {
  if (ORIGINAL_DISABLED === undefined) delete process.env.MODEL_AUTO_DISABLE_DISABLED;
  else process.env.MODEL_AUTO_DISABLE_DISABLED = ORIGINAL_DISABLED;
  if (ORIGINAL_THRESHOLD_MS === undefined) delete process.env.MODEL_AUTO_DISABLE_THRESHOLD_MS;
  else process.env.MODEL_AUTO_DISABLE_THRESHOLD_MS = ORIGINAL_THRESHOLD_MS;
  if (ORIGINAL_GRACE_MS === undefined) delete process.env.MODEL_MANUAL_REENABLE_GRACE_MS;
  else process.env.MODEL_MANUAL_REENABLE_GRACE_MS = ORIGINAL_GRACE_MS;
});

describe('autoDisableDelistedModels', () => {
  it('disables a model unconfirmed past the threshold, tagging metadata for audit', async () => {
    queryRawMock.mockResolvedValueOnce([{ count: 1n }]);
    queryRawUnsafeMock.mockResolvedValueOnce([
      {
        uid: 'uid-1',
        id: 'delisted-model',
        provider_id: 'some-provider',
        metadata: { pricingSource: 'stale-unverified' },
        last_synced_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const { autoDisableDelistedModels } = await loadModule();
    const result = await autoDisableDelistedModels();

    expect(result).toEqual({
      found: 1,
      disabled: 1,
      skippedUnhealthySource: 0,
      skippedManualReenableGrace: 0,
    });
    expect(modelUpdateManyMock).toHaveBeenCalledTimes(1);
    const call = modelUpdateManyMock.mock.calls[0][0] as {
      where: { uid: string; status: string };
      data: { status: string; metadata: Record<string, unknown> };
    };
    expect(call.where).toMatchObject({ uid: 'uid-1', status: 'active' });
    expect(call.data.status).toBe('disabled');
    expect(call.data.metadata).toMatchObject({
      autoDisabledReason: 'delisted-unconfirmed',
      autoDisabledLastSyncedAt: '2026-01-01T00:00:00.000Z',
      // Prior metadata is preserved, not clobbered.
      pricingSource: 'stale-unverified',
    });
    expect(call.data.metadata.autoDisabledAt).toEqual(expect.any(String));
  });

  it('is a full no-op skip when MODEL_AUTO_DISABLE_DISABLED=true (kill-switch) — no DB reads or writes at all', async () => {
    process.env.MODEL_AUTO_DISABLE_DISABLED = 'true';

    const { autoDisableDelistedModels } = await loadModule();
    const result = await autoDisableDelistedModels();

    expect(result).toEqual({
      found: 0,
      disabled: 0,
      skippedUnhealthySource: 0,
      skippedManualReenableGrace: 0,
    });
    expect(queryRawMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(modelUpdateManyMock).not.toHaveBeenCalled();
  });

  it('runs (does not skip) for any MODEL_AUTO_DISABLE_DISABLED value other than the literal string "true"', async () => {
    process.env.MODEL_AUTO_DISABLE_DISABLED = 'false';
    queryRawMock.mockResolvedValueOnce([{ count: 0n }]);

    const { autoDisableDelistedModels } = await loadModule();
    const result = await autoDisableDelistedModels();

    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      found: 0,
      disabled: 0,
      skippedUnhealthySource: 0,
      skippedManualReenableGrace: 0,
    });
  });

  it('makes no UPDATE calls when nothing is past the threshold', async () => {
    queryRawMock.mockResolvedValueOnce([{ count: 0n }]);

    const { autoDisableDelistedModels } = await loadModule();
    const result = await autoDisableDelistedModels();

    expect(result).toEqual({
      found: 0,
      disabled: 0,
      skippedUnhealthySource: 0,
      skippedManualReenableGrace: 0,
    });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(modelUpdateManyMock).not.toHaveBeenCalled();
  });

  it('disables every row across a batch, and one failed row does not stop the rest', async () => {
    queryRawMock.mockResolvedValueOnce([{ count: 2n }]);
    queryRawUnsafeMock.mockResolvedValueOnce([
      {
        uid: 'uid-fail',
        id: 'model-a',
        provider_id: 'provider-a',
        metadata: {},
        last_synced_at: null,
      },
      {
        uid: 'uid-ok',
        id: 'model-b',
        provider_id: 'provider-b',
        metadata: {},
        last_synced_at: null,
      },
    ]);
    modelUpdateManyMock
      .mockRejectedValueOnce(new Error('row locked'))
      .mockResolvedValueOnce({ count: 1 });

    const { autoDisableDelistedModels } = await loadModule();
    const result = await autoDisableDelistedModels();

    expect(result).toEqual({
      found: 2,
      disabled: 1,
      skippedUnhealthySource: 0,
      skippedManualReenableGrace: 0,
    });
    expect(modelUpdateManyMock).toHaveBeenCalledTimes(2);
  });

  it('race guard: does NOT count a row as disabled when a concurrent discovery reconfirm wins the write (conditional updateMany matches 0 rows)', async () => {
    // Simulates: this sweep's SELECT saw the row as stale, but before its
    // UPDATE ran, the SAME-tick "model-discovery-hourly" job reconfirmed it
    // (bumped last_synced_at / re-set status='active'). The conditional
    // updateMany's WHERE re-checks staleness at write time, so it matches
    // zero rows instead of clobbering the fresh reconfirmation.
    queryRawMock.mockResolvedValueOnce([{ count: 1n }]);
    queryRawUnsafeMock.mockResolvedValueOnce([
      {
        uid: 'uid-raced',
        id: 'reconfirmed-model',
        provider_id: 'some-provider',
        metadata: {},
        last_synced_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    modelUpdateManyMock.mockResolvedValueOnce({ count: 0 });

    const { autoDisableDelistedModels } = await loadModule();
    const result = await autoDisableDelistedModels();

    // `found` still reflects the SELECT-time count; `disabled` must NOT
    // count a row whose conditional write didn't actually apply.
    expect(result).toEqual({
      found: 1,
      disabled: 0,
      skippedUnhealthySource: 0,
      skippedManualReenableGrace: 0,
    });
    expect(modelUpdateManyMock).toHaveBeenCalledTimes(1);
    const call = modelUpdateManyMock.mock.calls[0][0] as {
      where: { uid: string; status: string; OR: unknown[] };
    };
    // The guard re-asserts BOTH status='active' and the staleness window at
    // write time — not just a bare `where: { uid }`.
    expect(call.where).toMatchObject({ uid: 'uid-raced', status: 'active' });
    expect(Array.isArray(call.where.OR)).toBe(true);
  });
});

describe('autoDisableDelistedModels — unhealthy-discovery-source circuit breaker (2026-09-08 incident)', () => {
  /**
   * Reproduces the real bug: openai-native, anthropic-native, aws-bedrock-hub,
   * orqai-hub, edenai-hub, ai302-hub and routeway-hub all had zero working
   * credentials in the process that ran this sweep (workers/queue-runner.ts
   * never called loadSecretsIntoEnv()), so `last_synced_at` staleness looked
   * identical to genuine delisting for every model under those providers —
   * 19,875 models (17% of the catalog) got disabled in one run. Without this
   * circuit breaker, a provider whose discovery is currently blind has no
   * defense against its ENTIRE stale-candidate catalog being disabled in a
   * single tick.
   */
  it('skips disabling a row whose provider has no currently-healthy discovery source', async () => {
    getProvidersWithoutHealthyDiscoveryMock.mockReturnValue(new Set(['aws-bedrock']));
    queryRawMock.mockResolvedValueOnce([{ count: 1n }]);
    queryRawUnsafeMock.mockResolvedValueOnce([
      {
        uid: 'uid-bedrock-1',
        id: 'anthropic.claude-3-opus',
        provider_id: 'aws-bedrock',
        metadata: {},
        last_synced_at: null,
      },
    ]);

    const { autoDisableDelistedModels } = await loadModule();
    const result = await autoDisableDelistedModels();

    expect(result).toEqual({
      found: 1,
      disabled: 0,
      skippedUnhealthySource: 1,
      skippedManualReenableGrace: 0,
    });
    expect(modelUpdateManyMock).not.toHaveBeenCalled();
  });

  it('is per-row precise: a healthy-provider row in the SAME batch as an unhealthy-provider row is still disabled', async () => {
    getProvidersWithoutHealthyDiscoveryMock.mockReturnValue(new Set(['aws-bedrock']));
    queryRawMock.mockResolvedValueOnce([{ count: 2n }]);
    queryRawUnsafeMock.mockResolvedValueOnce([
      {
        uid: 'uid-bedrock-1',
        id: 'anthropic.claude-3-opus',
        provider_id: 'aws-bedrock',
        metadata: {},
        last_synced_at: null,
      },
      {
        uid: 'uid-other-1',
        id: 'genuinely-delisted-model',
        provider_id: 'some-other-provider',
        metadata: {},
        last_synced_at: null,
      },
    ]);

    const { autoDisableDelistedModels } = await loadModule();
    const result = await autoDisableDelistedModels();

    expect(result).toEqual({
      found: 2,
      disabled: 1,
      skippedUnhealthySource: 1,
      skippedManualReenableGrace: 0,
    });
    expect(modelUpdateManyMock).toHaveBeenCalledTimes(1);
    const call = modelUpdateManyMock.mock.calls[0][0] as { where: { uid: string } };
    expect(call.where.uid).toBe('uid-other-1');
  });

  it('fails OPEN when computing the exemption itself throws — proceeds with the pre-existing disable behavior instead of silently disabling nothing', async () => {
    getCentralModelDiscoveryServiceMock.mockRejectedValueOnce(new Error('discovery service init failed'));
    queryRawMock.mockResolvedValueOnce([{ count: 1n }]);
    queryRawUnsafeMock.mockResolvedValueOnce([
      {
        uid: 'uid-1',
        id: 'some-model',
        provider_id: 'some-provider',
        metadata: {},
        last_synced_at: null,
      },
    ]);

    const { autoDisableDelistedModels } = await loadModule();
    const result = await autoDisableDelistedModels();

    expect(result).toEqual({
      found: 1,
      disabled: 1,
      skippedUnhealthySource: 0,
      skippedManualReenableGrace: 0,
    });
    expect(modelUpdateManyMock).toHaveBeenCalledTimes(1);
  });
});

describe('autoDisableDelistedModels — manual-reenable grace period (2026-09-13 incident)', () => {
  /**
   * Reproduces the real bug: a bulk data-correction UPDATE flipped `status`
   * back to 'active' on ~18,470 rows without setting `last_synced_at`, so
   * this sweep's `last_synced_at IS NULL` branch (no threshold applies to
   * NULL) re-disabled 13,569 of them — 13,179 `huggingface` — the very next
   * time its cursor reached them, two days later, even though HF discovery
   * itself was healthy the whole time. A row-level grace period keyed off
   * `metadata.manualReEnabledAt` closes this without touching the
   * provider-level circuit breaker above, which cannot see this failure mode
   * (the provider is healthy; these specific rows were just never
   * individually reconfirmed).
   */
  it('skips a row manually reactivated recently, even with last_synced_at null', async () => {
    queryRawMock.mockResolvedValueOnce([{ count: 1n }]);
    queryRawUnsafeMock.mockResolvedValueOnce([
      {
        uid: 'uid-hf-1',
        id: 'org/model',
        provider_id: 'huggingface',
        metadata: { manualReEnabledAt: new Date(Date.now() - 60_000).toISOString() },
        last_synced_at: null,
      },
    ]);

    const { autoDisableDelistedModels } = await loadModule();
    const result = await autoDisableDelistedModels();

    expect(result).toEqual({
      found: 1,
      disabled: 0,
      skippedUnhealthySource: 0,
      skippedManualReenableGrace: 1,
    });
    expect(modelUpdateManyMock).not.toHaveBeenCalled();
  });

  it('still disables a row whose manual reactivation is older than the grace period', async () => {
    process.env.MODEL_MANUAL_REENABLE_GRACE_MS = String(24 * 60 * 60 * 1000); // 1 day
    queryRawMock.mockResolvedValueOnce([{ count: 1n }]);
    queryRawUnsafeMock.mockResolvedValueOnce([
      {
        uid: 'uid-hf-2',
        id: 'org/old-model',
        provider_id: 'huggingface',
        metadata: {
          manualReEnabledAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
        last_synced_at: null,
      },
    ]);

    const { autoDisableDelistedModels } = await loadModule();
    const result = await autoDisableDelistedModels();

    expect(result).toEqual({
      found: 1,
      disabled: 1,
      skippedUnhealthySource: 0,
      skippedManualReenableGrace: 0,
    });
    expect(modelUpdateManyMock).toHaveBeenCalledTimes(1);
  });

  it('is per-row precise: a row in the SAME batch without manualReEnabledAt is still disabled normally', async () => {
    queryRawMock.mockResolvedValueOnce([{ count: 2n }]);
    queryRawUnsafeMock.mockResolvedValueOnce([
      {
        uid: 'uid-grace',
        id: 'org/protected-model',
        provider_id: 'huggingface',
        metadata: { manualReEnabledAt: new Date().toISOString() },
        last_synced_at: null,
      },
      {
        uid: 'uid-genuine',
        id: 'org/genuinely-stale-model',
        provider_id: 'huggingface',
        metadata: {},
        last_synced_at: null,
      },
    ]);

    const { autoDisableDelistedModels } = await loadModule();
    const result = await autoDisableDelistedModels();

    expect(result).toEqual({
      found: 2,
      disabled: 1,
      skippedUnhealthySource: 0,
      skippedManualReenableGrace: 1,
    });
    expect(modelUpdateManyMock).toHaveBeenCalledTimes(1);
    const call = modelUpdateManyMock.mock.calls[0][0] as { where: { uid: string } };
    expect(call.where.uid).toBe('uid-genuine');
  });

  it('ignores a malformed manualReEnabledAt (non-string / unparseable date) rather than throwing', async () => {
    queryRawMock.mockResolvedValueOnce([{ count: 1n }]);
    queryRawUnsafeMock.mockResolvedValueOnce([
      {
        uid: 'uid-bad-date',
        id: 'org/model',
        provider_id: 'huggingface',
        metadata: { manualReEnabledAt: 'not-a-real-date' },
        last_synced_at: null,
      },
    ]);

    const { autoDisableDelistedModels } = await loadModule();
    const result = await autoDisableDelistedModels();

    expect(result).toEqual({
      found: 1,
      disabled: 1,
      skippedUnhealthySource: 0,
      skippedManualReenableGrace: 0,
    });
  });
});

describe('MODEL_MANUAL_REENABLE_GRACE_MS', () => {
  it('defaults to 14 days', async () => {
    const { MODEL_MANUAL_REENABLE_GRACE_MS } = await loadModule();
    expect(MODEL_MANUAL_REENABLE_GRACE_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('is overridable via MODEL_MANUAL_REENABLE_GRACE_MS (ms)', async () => {
    process.env.MODEL_MANUAL_REENABLE_GRACE_MS = String(3 * 24 * 60 * 60 * 1000); // 3 days
    const { MODEL_MANUAL_REENABLE_GRACE_MS } = await loadModule();
    expect(MODEL_MANUAL_REENABLE_GRACE_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it('falls back to the 14-day default for an invalid or non-positive override', async () => {
    process.env.MODEL_MANUAL_REENABLE_GRACE_MS = '-5';
    const mod1 = await loadModule();
    expect(mod1.MODEL_MANUAL_REENABLE_GRACE_MS).toBe(14 * 24 * 60 * 60 * 1000);

    vi.resetModules();
    process.env.MODEL_MANUAL_REENABLE_GRACE_MS = 'not-a-number';
    const mod2 = await loadModule();
    expect(mod2.MODEL_MANUAL_REENABLE_GRACE_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

describe('MODEL_AUTO_DISABLE_THRESHOLD_MS', () => {
  it('is a conservative multi-day threshold, meaningfully longer than the 72h staleness-flag threshold', async () => {
    const { MODEL_AUTO_DISABLE_THRESHOLD_MS, PRICING_STALENESS_THRESHOLD_MS } = await loadModule();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    // Bounded: long enough to comfortably absorb multiple missed daily
    // discovery cycles from transient outages (not just one or two, which
    // the 72h flag already tolerates), short enough that a genuinely
    // delisted model doesn't stay in the catalog indefinitely.
    expect(MODEL_AUTO_DISABLE_THRESHOLD_MS).toBeGreaterThanOrEqual(ONE_DAY_MS * 7);
    expect(MODEL_AUTO_DISABLE_THRESHOLD_MS).toBeLessThanOrEqual(ONE_DAY_MS * 30);
    // Must be meaningfully longer than the additive staleness-flag threshold
    // it follows — this is the whole conservatism argument for this sweep.
    expect(MODEL_AUTO_DISABLE_THRESHOLD_MS).toBeGreaterThan(PRICING_STALENESS_THRESHOLD_MS * 3);
  });

  it('is overridable via MODEL_AUTO_DISABLE_THRESHOLD_MS (ms)', async () => {
    process.env.MODEL_AUTO_DISABLE_THRESHOLD_MS = String(21 * 24 * 60 * 60 * 1000); // 21 days
    const { MODEL_AUTO_DISABLE_THRESHOLD_MS } = await loadModule();
    expect(MODEL_AUTO_DISABLE_THRESHOLD_MS).toBe(21 * 24 * 60 * 60 * 1000);
  });

  it('falls back to the 14-day default for an invalid or non-positive override', async () => {
    process.env.MODEL_AUTO_DISABLE_THRESHOLD_MS = '-5';
    const mod1 = await loadModule();
    expect(mod1.MODEL_AUTO_DISABLE_THRESHOLD_MS).toBe(14 * 24 * 60 * 60 * 1000);

    vi.resetModules();
    process.env.MODEL_AUTO_DISABLE_THRESHOLD_MS = 'not-a-number';
    const mod2 = await loadModule();
    expect(mod2.MODEL_AUTO_DISABLE_THRESHOLD_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

describe('isModelAutoDisableEnabled', () => {
  it('returns true by default (env var unset)', async () => {
    const { isModelAutoDisableEnabled } = await loadModule();
    expect(isModelAutoDisableEnabled()).toBe(true);
  });

  it('returns false only when explicitly set to "true"', async () => {
    process.env.MODEL_AUTO_DISABLE_DISABLED = 'true';
    const { isModelAutoDisableEnabled } = await loadModule();
    expect(isModelAutoDisableEnabled()).toBe(false);
  });
});
