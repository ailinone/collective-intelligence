// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GAP-A13 — the runtime capability probe writes into the shared evidence log.
 *
 * Pins the contract that makes the two-parallel-systems problem go away:
 * a definitive probe verdict becomes a `runtime-probe` assertion keyed to the
 * model's REAL uid, so the materialiser can promote it into
 * `models.capability_uris` — the column the selector's fail-closed hard filter
 * reads — without the catalog's unreliable `tools` flag being involved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  recordProbeAssertion,
  recordProbeAssertions,
  isProbeAssertionsEnabled,
} from '../probe-emitter';
import { SOURCE_WEIGHT } from '../materialiser';
import { SOURCE_PRIORITY, STRONG_SOURCES } from '@/services/model-capability-merger';

const originalFlag = process.env.HCRA_PROBE_ASSERTIONS_DISABLED;

function runnerWithModel(uid: string | null) {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue(uid ? [{ uid }] : []),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  };
}

afterEach(() => {
  if (originalFlag === undefined) delete process.env.HCRA_PROBE_ASSERTIONS_DISABLED;
  else process.env.HCRA_PROBE_ASSERTIONS_DISABLED = originalFlag;
});

beforeEach(() => {
  delete process.env.HCRA_PROBE_ASSERTIONS_DISABLED;
});

describe('runtime-probe as an evidence source', () => {
  it('outranks every declarative source but not a human override', () => {
    // An accepted request is an observation; a capability list is a claim.
    expect(SOURCE_WEIGHT['runtime-probe']).toBeGreaterThan(SOURCE_WEIGHT['provider-declared']);
    expect(SOURCE_WEIGHT['runtime-probe']).toBeLessThan(SOURCE_WEIGHT['operator-override']);
  });

  it('clears the materialiser inclusion threshold on its own', () => {
    // This is the promotion GAP-A13 is about: one confirmed probe must be
    // enough to put the capability into `capability_uris`, with no help from
    // the catalog declaration.
    const fused = 1 - (1 - SOURCE_WEIGHT['runtime-probe'] * 1.0);
    expect(fused).toBeGreaterThan(0.9);
  });

  it('is registered as a strong source with the top merge priority', () => {
    expect(STRONG_SOURCES.has('runtime-probe')).toBe(true);
    expect(SOURCE_PRIORITY['runtime-probe']).toBeLessThan(SOURCE_PRIORITY['provider-declared']);
  });
});

describe('recordProbeAssertion', () => {
  const input = {
    providerId: 'openai',
    modelId: 'gpt-4o',
    capability: 'function_calling',
    supported: true,
  };

  it('is enabled by default and respects its own kill switch', async () => {
    expect(isProbeAssertionsEnabled()).toBe(true);
    process.env.HCRA_PROBE_ASSERTIONS_DISABLED = 'true';
    expect(isProbeAssertionsEnabled()).toBe(false);

    const runner = runnerWithModel('uid-1');
    expect(await recordProbeAssertion({ ...input, runner: runner as never })).toBe('disabled');
    expect(runner.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('writes a runtime-probe assertion against the resolved model uid', async () => {
    const runner = runnerWithModel('resolved-uid');
    expect(await recordProbeAssertion({ ...input, runner: runner as never })).toBe('written');

    // supersede + insert
    expect(runner.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    const [supersedeSql, uids, origin] = runner.$executeRawUnsafe.mock.calls[0] ?? [];
    expect(String(supersedeSql)).toContain('model_capability_assertions');
    expect(uids).toEqual(['resolved-uid']);
    // Per-capability origin, so probing a DIFFERENT capability later does not
    // supersede this verdict.
    expect(origin).toBe('runtime-probe@v1:function_calling');

    const insertArgs = runner.$executeRawUnsafe.mock.calls[1] ?? [];
    expect(insertArgs[3]).toEqual(['runtime-probe']); // source column array
    expect(insertArgs[7]).toBe(true); // asserted_value
  });

  it('records a NEGATIVE verdict as asserted_value=false rather than discarding it', async () => {
    const runner = runnerWithModel('resolved-uid');
    expect(
      await recordProbeAssertion({ ...input, supported: false, runner: runner as never })
    ).toBe('written');

    const insertArgs = runner.$executeRawUnsafe.mock.calls[1] ?? [];
    expect(insertArgs[7]).toBe(false);
  });

  it('LOOKS UP the uid instead of hashing (provider,model) — the probe uses execution names', async () => {
    const runner = runnerWithModel('resolved-uid');
    await recordProbeAssertion({ ...input, runner: runner as never });

    const [sql, providerId, modelId] = runner.$queryRawUnsafe.mock.calls[0] ?? [];
    expect(String(sql)).toContain('FROM models');
    expect(providerId).toBe('openai');
    expect(modelId).toBe('gpt-4o');
  });

  it('reports model-not-found (not a failure) when discovery has no row for the model', async () => {
    const runner = runnerWithModel(null);
    expect(await recordProbeAssertion({ ...input, runner: runner as never })).toBe(
      'model-not-found'
    );
    expect(runner.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('refuses a capability with no ontology URI instead of violating the FK', async () => {
    const runner = runnerWithModel('resolved-uid');
    expect(
      await recordProbeAssertion({
        ...input,
        capability: 'not_a_real_capability_slug',
        runner: runner as never,
      })
    ).toBe('unmapped-capability');
    expect(runner.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('never throws — a failed write must not affect the probe verdict', async () => {
    const runner = {
      $queryRawUnsafe: vi.fn().mockRejectedValue(new Error('connection terminated')),
      $executeRawUnsafe: vi.fn(),
    };
    await expect(
      recordProbeAssertion({ ...input, runner: runner as never })
    ).resolves.toBe('failed');
  });
});

describe('recordProbeAssertions (multi-capability, Tiered Capability Fingerprint)', () => {
  const multiInput = {
    providerId: 'openai',
    modelId: 'gpt-4o',
    origin: 'tier1-diagnostic-probe@v1',
    signals: [{ capability: 'chat' }, { capability: 'reasoning' }],
  };

  it('is enabled by default and respects its own kill switch', async () => {
    process.env.HCRA_PROBE_ASSERTIONS_DISABLED = 'true';
    const runner = runnerWithModel('uid-1');
    expect(await recordProbeAssertions({ ...multiInput, runner: runner as never })).toBe('disabled');
    expect(runner.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('resolves the model uid ONCE and writes every signal in one batch', async () => {
    const runner = runnerWithModel('resolved-uid');
    expect(await recordProbeAssertions({ ...multiInput, runner: runner as never })).toBe('written');

    expect(runner.$queryRawUnsafe).toHaveBeenCalledTimes(1); // one uid lookup, not one per capability
    expect(runner.$executeRawUnsafe).toHaveBeenCalledTimes(2); // supersede + insert

    const [, , origin] = runner.$executeRawUnsafe.mock.calls[0] ?? [];
    // Same origin for the WHOLE batch — a fresh Tier-1 pass supersedes ALL
    // of its own prior capabilities for this model in one shot.
    expect(origin).toBe('tier1-diagnostic-probe@v1');

    const insertArgs = runner.$executeRawUnsafe.mock.calls[1] ?? [];
    expect(insertArgs[3]).toEqual(['runtime-probe', 'runtime-probe']); // source column, one per signal
    expect(insertArgs[7]).toBe(true); // asserted_value — only positive signals are ever written
  });

  it('is a safe no-op for an empty signal list', async () => {
    const runner = runnerWithModel('resolved-uid');
    expect(
      await recordProbeAssertions({ ...multiInput, signals: [], runner: runner as never })
    ).toBe('written');
    expect(runner.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('reports model-not-found when discovery has no row for the model', async () => {
    const runner = runnerWithModel(null);
    expect(await recordProbeAssertions({ ...multiInput, runner: runner as never })).toBe(
      'model-not-found'
    );
  });

  it('drops unmapped capabilities but still writes the mappable ones in the batch', async () => {
    const runner = runnerWithModel('resolved-uid');
    const outcome = await recordProbeAssertions({
      ...multiInput,
      signals: [{ capability: 'chat' }, { capability: 'not_a_real_capability_slug' }],
      runner: runner as never,
    });
    expect(outcome).toBe('written');
    const insertArgs = runner.$executeRawUnsafe.mock.calls[1] ?? [];
    expect(insertArgs[3]).toEqual(['runtime-probe']); // only the mappable one
  });

  it('reports unmapped-capability when NONE of the signals map to an ontology URI', async () => {
    const runner = runnerWithModel('resolved-uid');
    const outcome = await recordProbeAssertions({
      ...multiInput,
      signals: [{ capability: 'not_a_real_capability_slug' }],
      runner: runner as never,
    });
    expect(outcome).toBe('unmapped-capability');
    expect(runner.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('never throws — a failed write must not affect the probe verdicts', async () => {
    const runner = {
      $queryRawUnsafe: vi.fn().mockRejectedValue(new Error('connection terminated')),
      $executeRawUnsafe: vi.fn(),
    };
    await expect(
      recordProbeAssertions({ ...multiInput, runner: runner as never })
    ).resolves.toBe('failed');
  });
});
