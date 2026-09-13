// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tiered Capability Fingerprint sweep job — behavioral contract.
 *
 * Fully hermetic: the capability pool (Postgres), the global Redis client,
 * and the provider registry are all mocked, alongside the three probe
 * modules (Tier-1/Tier-2/Tier-3) whose OWN behavior is covered by their
 * dedicated test files. What THIS file pins is the job's own
 * responsibilities:
 *   - opt-in gate (disabled by default, real skip when off)
 *   - real, dynamic bucket-size queries feeding a MIN(realCount, ceiling)
 *     candidate limit — never a hardcoded sweep size
 *   - the shared daily Redis budget, including fail-CLOSED behavior when
 *     the counter is unavailable
 *   - per-model tier gating (Tier-1 always, Tier-2 only when
 *     function_calling isn't already declared, Tier-3 only when eligible)
 *   - bounded per-provider-lane concurrency is actually respected
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const poolQuery = vi.fn();
vi.mock('@/capability/db/capability-pool', () => ({
  getCapabilityPool: () => ({ query: poolQuery }),
}));

const redisGet = vi.fn();
const redisIncrby = vi.fn().mockResolvedValue(1);
const redisExpire = vi.fn().mockResolvedValue(1);
vi.mock('@/cache/redis-client', () => ({
  getGlobalRedisClient: () => ({ get: redisGet, incrby: redisIncrby, expire: redisExpire }),
}));

const registryGet = vi.fn();
vi.mock('@/providers/provider-registry.js', () => ({
  getProviderRegistry: () => ({ get: registryGet }),
}));

const runTier1DiagnosticProbe = vi.fn().mockResolvedValue({
  status: 'confirmed',
  capabilitiesConfirmed: [],
  capabilitiesAmbiguousUnresolved: [],
});
vi.mock('@/core/orchestration/tier1-diagnostic-probe', () => ({
  runTier1DiagnosticProbe: (...args: unknown[]) => runTier1DiagnosticProbe(...args),
}));

const getFunctionCallingVerdict = vi.fn().mockResolvedValue(null);
vi.mock('@/core/orchestration/function-calling-probe', () => ({
  getFunctionCallingVerdict: (...args: unknown[]) => getFunctionCallingVerdict(...args),
}));

const isTier3EligibleByDeclaredModality = vi.fn().mockReturnValue({ eligible: false });
const runTier3MultimodalProbe = vi.fn().mockResolvedValue({ status: 'confirmed' });
vi.mock('@/core/orchestration/tier3-multimodal-probe', () => ({
  isTier3EligibleByDeclaredModality: (...args: unknown[]) => isTier3EligibleByDeclaredModality(...args),
  runTier3MultimodalProbe: (...args: unknown[]) => runTier3MultimodalProbe(...args),
}));

const { runCapabilityFingerprintSweep } = await import('../capability-fingerprint-job');

const FUNCTION_CALLING_URI = 'http://ailin.dev/cap/v1/function_calling';

function candidateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    uid: 'uid-1',
    provider_id: 'openai',
    model_id: 'gpt-x',
    capability_uris: [],
    capability_confidence: {},
    ...overrides,
  };
}

const ORIGINAL_ENABLED = process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED = 'true';
  redisGet.mockResolvedValue(null); // no prior usage today
  redisIncrby.mockResolvedValue(1);
  redisExpire.mockResolvedValue(1);
  registryGet.mockReturnValue({ chatCompletion: vi.fn(), chatCompletionStream: vi.fn() });
  isTier3EligibleByDeclaredModality.mockReturnValue({ eligible: false });
  runTier1DiagnosticProbe.mockResolvedValue({
    status: 'confirmed',
    capabilitiesConfirmed: [],
    capabilitiesAmbiguousUnresolved: [],
  });
  getFunctionCallingVerdict.mockResolvedValue(null);
});

afterAll(() => {
  if (ORIGINAL_ENABLED === undefined) delete process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED;
  else process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED = ORIGINAL_ENABLED;
});

describe('runCapabilityFingerprintSweep — opt-in gate', () => {
  it('is skipped ("disabled") by default, making zero queries', async () => {
    delete process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED;
    const stats = await runCapabilityFingerprintSweep('curated');

    expect(stats.skipped).toBe('disabled');
    expect(poolQuery).not.toHaveBeenCalled();
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('is NOT enabled by any value other than the exact literal "true"', async () => {
    process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED = 'TRUE';
    const stats = await runCapabilityFingerprintSweep('curated');
    expect(stats.skipped).toBe('disabled');
  });
});

describe('runCapabilityFingerprintSweep — real, dynamic sizing', () => {
  it('queries the real bucket population and requests a candidate limit no larger than it', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ count: 3 }] }) // countBucket
      .mockResolvedValueOnce({ rows: [candidateRow(), candidateRow({ uid: 'uid-2' })] }); // loadCandidateRows

    const stats = await runCapabilityFingerprintSweep('curated');

    expect(stats.realPopulation).toBe(3);
    const [, countParams] = poolQuery.mock.calls[0];
    expect(countParams).toBeUndefined(); // count query has no params
    const [loadSql, loadParams] = poolQuery.mock.calls[1];
    expect(String(loadSql)).toMatch(/hubInventoryClass/);
    expect((loadParams as number[])[0]).toBeLessThanOrEqual(3);
    expect(stats.candidatesSelected).toBe(2);
  });

  it('uses the aggregated-bucket predicate (serverless_callable + aggregated_index) and per-day rotation ordering for the aggregated bucket', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ count: 100_000 }] })
      .mockResolvedValueOnce({ rows: [] });

    await runCapabilityFingerprintSweep('aggregated');

    const [countSql] = poolQuery.mock.calls[0];
    expect(String(countSql)).toMatch(/aggregated_index/);
    expect(String(countSql)).toMatch(/serverless_callable/);
    const [loadSql, loadParams] = poolQuery.mock.calls[1];
    expect(String(loadSql)).toMatch(/md5\(uid/);
    // Real population (100k) far exceeds the aggregated daily slice default
    // (2,500) — the candidate limit must be capped by the slice, not the
    // real count.
    expect((loadParams as unknown[])[1]).toBeLessThanOrEqual(2_500);
  });
});

describe('runCapabilityFingerprintSweep — daily budget (fails CLOSED)', () => {
  it('skips the run ("no-budget") when the Redis budget counter cannot be read', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ count: 10 }] });
    redisGet.mockRejectedValue(new Error('redis down'));

    const stats = await runCapabilityFingerprintSweep('curated');

    expect(stats.skipped).toBe('no-budget');
    expect(stats.realPopulation).toBe(10);
    // Never reached the candidate-loading query without budget.
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('skips the run when the daily budget is already exhausted', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ count: 10 }] });
    redisGet.mockResolvedValue(String(10_000_000)); // far above any real default budget

    const stats = await runCapabilityFingerprintSweep('curated');
    expect(stats.skipped).toBe('no-budget');
  });

  it('grants only the remaining budget, not the full requested amount', async () => {
    process.env.CAPABILITY_FINGERPRINT_DAILY_BUDGET = '5';
    try {
      poolQuery
        .mockResolvedValueOnce({ rows: [{ count: 10 }] })
        .mockResolvedValueOnce({ rows: [] });
      redisGet.mockResolvedValue('3'); // 3 already used today

      const stats = await runCapabilityFingerprintSweep('curated');
      expect(stats.budgetGranted).toBe(2); // 5 - 3
      const [, loadParams] = poolQuery.mock.calls[1];
      expect((loadParams as number[])[0]).toBe(2);
    } finally {
      delete process.env.CAPABILITY_FINGERPRINT_DAILY_BUDGET;
    }
  });
});

describe('runCapabilityFingerprintSweep — per-model tier gating', () => {
  it('always runs Tier-1, skips Tier-2 when function_calling is already declared, and skips Tier-3 when ineligible', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({
        rows: [candidateRow({ capability_uris: [FUNCTION_CALLING_URI] })],
      });
    isTier3EligibleByDeclaredModality.mockReturnValue({ eligible: false });

    const stats = await runCapabilityFingerprintSweep('curated');

    expect(runTier1DiagnosticProbe).toHaveBeenCalledTimes(1);
    expect(getFunctionCallingVerdict).not.toHaveBeenCalled();
    expect(runTier3MultimodalProbe).not.toHaveBeenCalled();
    expect(stats.tier2Invoked).toBe(0);
    expect(stats.tier3Eligible).toBe(0);
  });

  it('runs Tier-2 when function_calling is NOT already declared', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({ rows: [candidateRow({ capability_uris: [] })] });

    const stats = await runCapabilityFingerprintSweep('curated');

    expect(getFunctionCallingVerdict).toHaveBeenCalledTimes(1);
    expect(stats.tier2Invoked).toBe(1);
  });

  it('runs Tier-3 only for models the gate reports eligible, with the declared capability it returns', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({ rows: [candidateRow({ capability_uris: ['vision-uri'] })] });
    isTier3EligibleByDeclaredModality.mockReturnValue({ eligible: true, declaredCapability: 'vision' });

    const stats = await runCapabilityFingerprintSweep('curated');

    expect(runTier3MultimodalProbe).toHaveBeenCalledWith(
      expect.anything(),
      'openai',
      'gpt-x',
      'vision'
    );
    expect(stats.tier3Eligible).toBe(1);
    expect(stats.tier3Invoked).toBe(1);
  });

  it('skips a candidate with no registered adapter without error', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({ rows: [candidateRow()] });
    registryGet.mockReturnValue(undefined);

    const stats = await runCapabilityFingerprintSweep('curated');

    expect(runTier1DiagnosticProbe).not.toHaveBeenCalled();
    expect(stats.errors).toBe(0);
    expect(stats.modelsProbed).toBe(1); // still counted as processed, just a no-op
  });
});

describe('runCapabilityFingerprintSweep — bounded per-lane concurrency', () => {
  it('never runs more than the configured per-lane concurrency cap for the SAME provider at once', async () => {
    process.env.CAPABILITY_FINGERPRINT_LANE_CONCURRENCY = '2';
    try {
      const rows = Array.from({ length: 8 }, (_, i) => candidateRow({ uid: `uid-${i}` }));
      poolQuery.mockResolvedValueOnce({ rows: [{ count: rows.length }] }).mockResolvedValueOnce({ rows });

      let current = 0;
      let maxObserved = 0;
      runTier1DiagnosticProbe.mockImplementation(async () => {
        current++;
        maxObserved = Math.max(maxObserved, current);
        await new Promise((resolve) => setTimeout(resolve, 10));
        current--;
        return { status: 'confirmed', capabilitiesConfirmed: [], capabilitiesAmbiguousUnresolved: [] };
      });

      await runCapabilityFingerprintSweep('curated');
      expect(maxObserved).toBeLessThanOrEqual(2);
    } finally {
      delete process.env.CAPABILITY_FINGERPRINT_LANE_CONCURRENCY;
    }
  });
});
